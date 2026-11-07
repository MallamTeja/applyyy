/* One application card in the pipeline drawer. Split out of PipelineDrawer.tsx (2026-10-06)
   so it renders with no Supabase client: the drawer imports the client singleton, and this
   card's one decision ("does this row offer View resume?") needs a test that can reach it.

   2026-10-08: also carries "Send through pipeline" for the passed_filters lane. The real deps
   live in rowPipelineDeps.ts and arrive as a prop, so this file still imports no client.
   Later the same day SendThroughPipeline was exported for DiscoveredJobsPage's cards, with the
   lane's step list as a prop (Teja's ruling, 2026-10-08 16:08). */

/* Type only: the element type the component returns. */
import type { ReactElement } from 'react';
/* Per-card run state for "Send through pipeline"; nothing else in the card is stateful. */
import { useState } from 'react';
/* The app's own router link, so /approvals opens inside the SPA like every other in-app link. */
import { Link } from 'react-router-dom';

/* Type only: the snapshot a row carries when it was tailored. */
import type { ResolvedResume } from '../../data/contract';
/* Same badge the drawer rendered inline before the split. With its extension, because
   node --test resolves imports itself and cannot find an extensionless .tsx path. */
import { SourceBadge } from '../../app/SourceBadge.tsx';
/* The approval queue's own fit chip (2026-11-05), so one number keeps one wording and one range check.
   From the pure view module, not the page, which imports supabase. With its extension, like above. */
import { fitChip } from '../approval/queueView.ts';
/* The pure per-row engine (another worker's file; imported, never edited). The browser only
   INVOKES agents through its deps; every status change is the deployed agent's own write.
   With its extension, like SourceBadge above: other tests' load hooks only try .tsx. */
import { MATCHER_ADVANCE_FLOOR, PASSED_FILTERS_STEPS, STEP_INPUT_STATUS, runRowPipeline } from './rowPipeline.ts';
/* Types only: the engine's contract, so a new outcome kind or stop reason fails to compile here. */
import type { MatcherDropCause, PipelineStep, RowPipelineDeps, RowPipelineOutcome, StepEvent, StopReason } from './rowPipeline.ts';

/* One row as the drawer maps it from the query. Moved here with the card so the type and
   its only renderer live together. */
export interface DrawerAppItem {
  /* The application id: React key, the short identifier shown, and the preview's id. */
  readonly id: string;
  /* Job title, joined from jobs; the card's heading. */
  readonly role: string;
  /* Employer, joined from jobs; shown under the title. */
  readonly company: string;
  /* When the row was created, shown as a local date. */
  readonly createdAt: string;
  /* Discovery sources for the badge; null when the job carries none. */
  readonly discoveredVia?: readonly string[] | null;
  /* Matcher score, null before scoring, so the card can omit it rather than print 0. */
  readonly score?: number | null;
  /* Null unless tailored_profile passed readResumeSnapshot; null renders no resume action at all. */
  readonly resume: ResolvedResume | null;
  /* jobs.disappeared_at, raw (2026-11-07): the matcher selects 0 rows for a gone posting, so Send
     could only end in a bare "stopped". Optional so every caller without the column renders as before;
     postingGoneNote checks its shape before the card believes it. */
  readonly disappearedAt?: unknown;
}

/* An ISO-8601 timestamp as PostgREST returns timestamptz ("2026-11-05T15:38:12.123456+00:00"). The
   shape is checked first because Date.parse is lenient ("-5" is year -5; repo CLAUDE.md §6). */
const ISO_TIMESTAMP_RE = /^(\d{4}-\d{2}-\d{2})T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/;

/* "Posting gone (since <date>)" for a job whose posting disappeared, or null when it has not (or the
   value is not a real timestamp, which claims nothing). Exported so the Discovered page can reuse it. */
export function postingGoneNote(disappearedAt: unknown): string | null {
  /* Only a string can be a timestamp; null/undefined is a live posting. */
  if (typeof disappearedAt !== 'string') return null;
  /* The positive shape, so a lenient parse never turns junk into a date. */
  const match = ISO_TIMESTAMP_RE.exec(disappearedAt);
  /* Not the shape: no claim either way. */
  if (match === null) return null;
  /* Date-shaped but impossible (month 13): Date gives NaN, and NaN is not a date. */
  if (!Number.isFinite(Date.parse(disappearedAt))) return null;
  /* The calendar day as stored (UTC), so the note is the same on every machine. */
  return `Posting gone (since ${match[1]})`;
}

/* ---- Send through pipeline (2026-10-08) ---- */

/* What the drawer hands the card for this feature, as ONE prop so the drawer edit is one line.
   Omitted (undefined) and the card shows no button, so every existing caller and test renders
   exactly as before. */
export interface SendThroughPipelineProp {
  /* The drawer's lane. The card, not the drawer, decides visibility, so one test covers it. */
  readonly status: string;
  /* The real deps (liveRowPipelineDeps), or null on an unconfigured machine: button disabled. */
  readonly deps: RowPipelineDeps | null;
  /* OPTIONAL (2026-10-09): forwarded to SendThroughPipeline, so the drawer can reload its list once a
     run settles. A caller that passes it owns showing the outcome (the card stops rendering it). */
  readonly onSettled?: (result: SendResult | null) => void;
}

/* The only lane the button belongs to: PASSED_FILTERS_STEPS are exactly the three agents that
   move a passed_filters row to awaiting_approval. Any other lane would run the wrong agents. */
export const SEND_LANE = 'passed_filters';

/* ---- The per-row in-flight lock ----
   Module-level, not component state: a re-render, a remount, or a second card for the same row
   (the drawer reloading its list) each get a fresh component that would start its own run.
   Gemini is spent per invocation and nothing server-side stops a double run, so the lock must
   outlive any one component instance.
   ponytail: per-tab only; two browser tabs can still double-run. A server-side claim is the
   upgrade if that ever happens in practice. */
const inFlightRows = new Set<string>();

/* Claims the row. False means a run for this id is already going: the caller must not start. */
export function tryStartRow(applicationId: string): boolean {
  /* The whole point of the lock: a second start for the same id is refused. */
  if (inFlightRows.has(applicationId)) return false;
  /* Claimed synchronously, before any await, so two clicks in one tick cannot both pass. */
  inFlightRows.add(applicationId);
  /* The caller now owns the run and must call finishRow in a finally. */
  return true;
}

/* Releases the row once its run has ended, however it ended. */
export function finishRow(applicationId: string): void {
  /* Deleting an id that is not held is harmless, so a double release cannot throw. */
  inFlightRows.delete(applicationId);
}

/* Read at render, so a remounted card shows its button disabled while an earlier run goes on. */
export function isRowInFlight(applicationId: string): boolean {
  /* Pure lookup; claims nothing. */
  return inFlightRows.has(applicationId);
}

/* Human names for the steps, closed over PipelineStep so a new step fails to compile. */
const STEP_LABEL: Record<PipelineStep, string> = {
  /* Dedupes the row against your other jobs; shown only in the Discovered lane. */
  normalizer: 'Normalizer',
  /* Screens deduped rows to passed_filters or dropped_filter; shown only in the Discovered lane. */
  screener: 'Screener',
  /* Scores the row (Gemini). */
  matcher: 'Matcher',
  /* Writes the tailored resume (Gemini). */
  tailor: 'Tailor',
  /* Deterministic fabrication check; no Gemini call. */
  auditor: 'Auditor',
};

/* Per-step display state: "waiting" until the engine reports on the step, then the engine's own
   phase verbatim, so the UI cannot claim a state the engine did not report. */
export type StepDisplay = 'waiting' | StepEvent['phase'];

/* One honest sentence per stop reason, closed so a new StopReason fails to compile. The HTTP
   status is passed in because the outcome does not carry it; the card records it per invoke. */
/* The code and the function's own words, once each. describeInvokeError already prefixes "HTTP <n>"
   for most statuses, so a render check showed "(HTTP 409): HTTP 409: no_master_profile"; the code is
   added only when the words do not already carry it. */
function callFailure(http: number | null, errorText: string | null): string {
  // The transport-level fact.
  const code = http === null ? 'no HTTP response' : `HTTP ${http}`;
  // No words: the code alone.
  if (errorText === null) return code;
  // Words that already name the code are complete as they are.
  return errorText.includes(code) ? errorText : `${code}: ${errorText}`;
}

/* The longest engine text the card shows: the body is untrusted network data (an HTML error page
   can land in `error`), and a reason only needs its first line or so to be diagnosable. */
const MAX_REASON_CHARS = 300;

/* The engine's own words for one response, from the fields the agents actually use (2026-11-07):
   `error` (success:false and every non-2xx), `failures[].error` (a 200 that failed this row, e.g.
   Netomi's gemini rate-limit), `reason` and `detail`. Strings only, never a stringified number, and
   null when there are none, so an absent reason is said as "no reason given", never invented. */
export function engineReasonText(body: unknown): string | null {
  /* A non-object body carries no fields. */
  if (typeof body !== 'object' || body === null) return null;
  /* Loose view: the body came off the wire, so nothing in it is typed yet. */
  const b = body as { error?: unknown; failures?: unknown; reason?: unknown; detail?: unknown };
  /* A targeted run lists at most this row; the first entry with string words is the one. */
  const failure = Array.isArray(b.failures)
    ? (b.failures as unknown[]).find((f): f is { error: string } => typeof f === 'object' && f !== null && typeof (f as { error?: unknown }).error === 'string')
    : undefined;
  /* Non-empty strings only, in the order a reader needs them: what, then why. */
  const parts = [b.error, failure?.error, b.reason, b.detail].filter((v): v is string => typeof v === 'string' && v.trim() !== '');
  /* Nothing said. */
  if (parts.length === 0) return null;
  /* Each phrase once, in case two fields carry the same words. */
  const text = [...new Set(parts)].join('; ');
  /* Capped with a visible ellipsis, so a cut is never mistaken for the whole message. */
  return text.length > MAX_REASON_CHARS ? `${text.slice(0, MAX_REASON_CHARS)}…` : text;
}

/* The short "why" for a stop: shared by the outcome sentence and the step line, so the two can never
   disagree. A rate-limit is named in plain words (Teja, 2026-11-07: ~20 rows in 5 minutes exhausted
   Gemini's per-minute quota), with the raw words kept so the next report stays diagnosable. */
function stopDetail(reason: StopReason, http: number | null, errorText: string | null): string {
  /* The agents' own code is rate_limited (gemini client); matched as that code, not as prose. */
  if (errorText !== null && errorText.includes('rate_limited')) return `Gemini is rate-limited; try again in a minute: ${errorText}`;
  /* A failed call: its code and words, as before (no response, 401, 503...). */
  if (reason === 'invoke_error') return callFailure(http, errorText);
  /* Every other stop came from a 2xx answer: its words, or the plain fact that it gave none. */
  return errorText ?? 'no reason given';
}

const STOP_MESSAGE: Record<StopReason, (step: string, finalStatus: string | null, detail: string) => string> = {
  /* The call failed; the status code tells "signed out" (401) from "agent crashed" (500), and the
     function's own words (describeInvokeError, e.g. no_master_profile) say what to do about it. */
  invoke_error: (step, _finalStatus, detail) =>
    /* The final status is ignored: after a failed call the useful facts are the code and the reason. */
    `Stopped at the ${step}: the call failed (${detail}).`,
  /* The kill switch answers 200 with a skip, so without this it would read as "did not move". */
  /* Names the real setting, not a metaphor: the gate halts unless system_settings.system_enabled is
     exactly true (gates.ts readKillSwitch), and "kill switch is off" would say the opposite. */
  halted: (step) => `Paused at the ${step}: the pipeline is switched off (system_settings.system_enabled is not true).`,
  /* A 200 whose body lists per-row failures is not a success. */
  body_failure: (step, finalStatus, detail) =>
    /* Names where the row sits now; it may have moved partway before the failure. The agent's words
       are the point (2026-11-07: this sentence used to drop them, so Netomi's rate-limit was invisible). */
    `Stopped at the ${step}: it answered but reported a failure for this row (now at ${finalStatus ?? 'unknown'}): ${detail}.`,
  /* Also the engine's after-loop fallback, where the row DID move to an intermediate status, so
     this says where the run ended, never that nothing moved. */
  no_progress: (step, finalStatus, detail) => `Stopped at the ${step}: the run ended with the row at ${finalStatus ?? 'an unknown status'}, short of approval (the agent said: ${detail}).`,
  /* The re-read failed, so where the row is now is genuinely unknown. */
  status_unreadable: (step, _finalStatus, detail) => `Stopped after the ${step}: the row's status could not be read back (the agent said: ${detail}).`,
};

/* The matcher's drop sentence, one per cause. The pre-gate wording covers BOTH ways the gate drops
   (supabase/functions/_shared/screen/tech-gate.ts screenTechRole): an excluded keyword in the title or
   the head of the description, or, once titles/keywords are configured, a match against none of them. */
function describeMatcherDrop(cause: MatcherDropCause | undefined): string {
  /* match_score NULL: the gate cleared it and dropped the row before the scorer ran. Optional
     chaining, because an absent cause (deps without the score read) must fall to "unknown". */
  if (cause?.kind === 'pre_gate') {
    /* "No Gemini call" is the gate's design: the scorer is wrapped and never reached for a dropped row. */
    return "Dropped by the matcher's pre-gate: the posting matched one of your excluded keywords, or none of your target titles and keywords. No Gemini call was made.";
  }
  /* A real score below the floor; the floor is a code constant, not a user setting. */
  if (cause?.kind === 'low_score') return `Dropped by the matcher: it scored ${cause.score}, below the matcher's advance floor of ${MATCHER_ADVANCE_FLOOR}.`;
  /* Unknown: neither cause is claimed. */
  return 'Dropped by the matcher.';
}

/* One honest sentence per outcome kind. A mapped type over the union, so each entry receives its
   own narrowed outcome and a new kind in rowPipeline.ts fails to compile until it has a sentence. */
export const OUTCOME_MESSAGE: {
  readonly [K in RowPipelineOutcome['kind']]: (
    outcome: Extract<RowPipelineOutcome, { kind: K }>,
    httpStatus: number | null,
    errorText: string | null,
    /* The lane's step list: only not_startable reads it, to name the status the lane starts from. */
    steps: readonly PipelineStep[],
  ) => string;
} = {
  /* The engine refused before any call; nothing was spent. */
  invalid_id: () => "Nothing was run: this row's id is not a valid application id.",
  /* The first read failed; nothing was invoked, so nothing was spent. */
  status_unreadable: () => "Nothing was run: this row's status could not be read.",
  /* The row moved lanes since the list loaded. The expected status comes from the lane's first step
     (discovered for the Discovered page, passed_filters for the drawer), so it is true for both. */
  not_startable: (o, _http, _err, steps) =>
    /* An empty list has no start status; "this lane's start" is then the only true wording. */
    `Nothing was run: the row is now at ${o.finalStatus}, not ${steps[0] === undefined ? "this lane's start" : STEP_INPUT_STATUS[steps[0]].join(' or ')}.`,
  /* OutcomeNote renders the queue link beside this sentence. */
  /* Flagged audits reach awaiting_approval too, so the sentence points at the findings. */
  ready_for_approval: () => 'Ready for your approval: check any audit findings in the queue',
  /* Always opens "Dropped by the <agent>" (orchestrator ruling, 2026-10-08 17:31): on the Discovered
     page's Filtered Out tab the drop must read as the deployed agent's verdict, never as this page's
     local filter preview being wrong. No body text is quoted because the outcome carries none. The
     matcher has TWO drop causes (2026-10-09); the engine reads match_score to tell them apart, and
     only the cause it read is claimed (describeMatcherDrop). */
  dropped: (o) =>
    /* Branch on the step, never on the status text alone, so the sentence names who dropped it. */
    o.atStep === 'matcher'
      ? /* The cause the engine read, or none. */
        describeMatcherDrop(o.matcherDrop)
      : /* dropped_duplicate IS the reason: a fingerprint match against another of your jobs rows. */
        o.atStep === 'normalizer' && o.finalStatus === 'dropped_duplicate'
        ? 'Dropped by the normalizer: a duplicate of another job already in your list (dropped_duplicate)'
        : /* The screener, or any other agent: the agent and the exact status, with no guessed cause. */
          `Dropped by the ${STEP_LABEL[o.atStep].toLowerCase()} (${o.finalStatus}).`,
  /* The tailor marks failed for TWO causes (validator refusal, or an unusable posting it never sent
     to the model: tailor/index.ts tailor_input_unusable); the sentence must be true for both. */
  failed: (o) =>
    /* Named for the tailor because both of its causes are known; other steps stay generic. */
    o.atStep === 'tailor'
      ? /* Both causes, since this card cannot tell them apart without another query. */
        'The tailor marked this row failed: its output failed validation, or the posting was unusable'
      : /* No guessed cause: the step and the fact, nothing more. */
        `The ${STEP_LABEL[o.atStep].toLowerCase()} marked this row failed.`,
  /* Delegated to the per-reason table so each reason has its own sentence. */
  stopped: (o, http, errorText) => STOP_MESSAGE[o.reason](STEP_LABEL[o.atStep].toLowerCase(), o.finalStatus, stopDetail(o.reason, http, errorText)),
};

/* One step-list line, e.g. "Matcher: running". A STOPPED line carries the same why as the outcome
   sentence (2026-11-07: "Matcher: stopped" alone sent Teja looking for events that were never
   written). Only once the result is in, and only for the step the outcome stopped at. Pure, so tested. */
export function stepLine(step: PipelineStep, display: StepDisplay, result: SendResult | null): string {
  /* The bare line, as it has always read. */
  const line = `${STEP_LABEL[step]}: ${display}`;
  /* No why to add: not stopped, no result yet, or the outcome is not a stop at this step (a terminal
     override such as "dropped" already has its own sentence below the list). */
  if (display !== 'stopped' || result === null || result.outcome.kind !== 'stopped' || result.outcome.atStep !== step) return line;
  /* The same detail the sentence uses. */
  return `${line} (${stopDetail(result.outcome.reason, result.httpStatus, result.errorText)})`;
}

/* The gap between two paced sends. ponytail: a fixed 5 s per tab, sized for Gemini's per-minute
   quota (each send makes 1-3 Gemini calls); a server-side rate limiter is the upgrade if sends ever
   come from more than one tab at once. */
export const SEND_GAP_MS = 5000;

/* The tail of the send queue: the next send waits on it. Module-level, like the row lock, so every
   card on every page shares one queue. */
let sendQueue: Promise<void> = Promise.resolve();

/* Runs sends one at a time, with a gap after each (2026-11-07: Teja sent ~20 rows in 5 minutes and
   exhausted Gemini's per-minute quota). Resolves or rejects with fn's own result; a failed send never
   jams the queue. sleep is injectable so a test can see the gap without waiting for it. */
export function paceSend<T>(
  // The send to run once the queue reaches it.
  fn: () => Promise<T>,
  // How long the next send waits after this one ends.
  gapMs: number = SEND_GAP_MS,
  // Real timer by default.
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<T> {
  /* Starts only after every earlier send and its gap. */
  const run = sendQueue.then(fn);
  /* The gap follows success and failure alike, so one throw cannot let the next send go early. */
  sendQueue = run.then(() => sleep(gapMs), () => sleep(gapMs));
  /* The caller gets fn's own outcome. */
  return run;
}

/* The one place the mapped table is called. The cast is sound: outcome.kind selects the entry whose
   parameter is exactly Extract<..., {kind: outcome.kind}>, a correlation TypeScript cannot see. */
export function describeOutcome(
  // What the engine returned.
  outcome: RowPipelineOutcome,
  // The last invoke's HTTP status, for the invoke_error sentence.
  httpStatus: number | null,
  // The function's own error words (deps body.error); optional so plain outcomes need not pass it.
  errorText: string | null = null,
  // The lane's steps; defaults to the drawer's lane so existing callers keep their sentences.
  steps: readonly PipelineStep[] = PASSED_FILTERS_STEPS,
): string {
  /* Widened view of the entry for this kind. */
  const sentence = OUTCOME_MESSAGE[outcome.kind] as (o: RowPipelineOutcome, http: number | null, err: string | null, s: readonly PipelineStep[]) => string;
  /* Text only; callers render it as a text node. */
  return sentence(outcome, httpStatus, errorText, steps);
}

/* D8 (review, 2026-10-08): the lock discipline in ONE tested place. Claims the row synchronously
   (before any await, so a double click cannot slip between), runs fn, and releases in finally
   whether fn resolves or throws. Returns started:false, running nothing, when the row is held. */
export async function withRowLock<T>(
  // The row the lock is keyed on.
  applicationId: string,
  // The run; only called when the lock was claimed.
  fn: () => Promise<T>,
): Promise<{ readonly started: false } | { readonly started: true; readonly value: T }> {
  // Held by another click, remount or card: nothing runs, and nothing is spent.
  if (!tryStartRow(applicationId)) return { started: false };
  // finally, so a throw from fn can never strand the row as "in flight" forever.
  try {
    // The caller's run, under the lock.
    return { started: true, value: await fn() };
  } finally {
    // Released on every path.
    finishRow(applicationId);
  }
}

/* Review fix (2026-10-08): the "settle AFTER release" ordering in ONE tested place, beside the lock it
   orders against. A caller's settle usually reloads its list; called while the row is still held, the
   reloaded card would render its button disabled with nothing left to re-enable it. Runs settle exactly
   once on every path (ran, refused, or threw), and only after withRowLock's finally released the row. */
export async function withRowLockThenSettle<T>(
  // The row the lock is keyed on.
  applicationId: string,
  // The run; only called when the lock was claimed.
  fn: () => Promise<T>,
  // The caller's after-hook; it reads whatever the run recorded, so it takes no arguments here.
  settle: () => void,
): Promise<{ readonly started: false } | { readonly started: true; readonly value: T }> {
  // finally OUTSIDE the awaited lock, so the release has already happened when settle runs.
  try {
    // The lock helper owns claim and release; this function only adds the after-hook.
    return await withRowLock(applicationId, fn);
  } finally {
    // Once, on every path.
    settle();
  }
}

/* The step list once the engine has answered. The engine emits "done" whenever a step MOVED the row,
   but the after-loop verdict can still be "stopped" there: the auditor moves tailored -> audit_flagged
   and its second hop to awaiting_approval fails. The list then said "Auditor: done" beside "Stopped at
   the auditor". The outcome is the final word, so its step is shown stopped. Pure, so it is tested. */
export function settleProgress(
  // The per-step states the events produced.
  progress: Readonly<Partial<Record<PipelineStep, StepDisplay>>>,
  // The engine's verdict.
  outcome: RowPipelineOutcome,
): Readonly<Partial<Record<PipelineStep, StepDisplay>>> {
  // Only a stop names a step that may disagree; every other verdict leaves the list as reported.
  return outcome.kind === 'stopped' ? { ...progress, [outcome.atStep]: 'stopped' } : progress;
}

/* The drawer's heading. The drawer loads one page of a lane that can hold thousands (6661
   passed_filters rows on 2026-10-09), so a bare count would imply every row is listed. */
export function drawerHeading({
  // The board's count for the lane, from a different query than the drawer's own.
  count,
  // How many rows the drawer actually listed.
  shown,
  // isConclusive(state): without a conclusive read the drawer has no standing to print a number.
  conclusive,
}: {
  // See above.
  readonly count: number;
  // See above.
  readonly shown: number;
  // See above.
  readonly conclusive: boolean;
}): string {
  // No number at all rather than a wrong one.
  if (!conclusive) return 'Applications';
  // The list is the floor: an older board count may lag behind what was just listed.
  const total = Math.max(count, shown);
  // A partial list says so.
  if (shown < total) return `Showing ${shown} of ${total} applications`;
  // Everything is listed, so the count is the list.
  return `${total} Application${total === 1 ? '' : 's'}`;
}

/* Shown when a click lands on a row the lock already holds, so the refusal is not silent. */
export const ALREADY_RUNNING_MESSAGE = 'This row is already being sent through the pipeline.';

/* The outcome sentence, plus the queue link when, and only when, the row reached
   awaiting_approval. Exported so a test can render the link without running anything. */
export function OutcomeNote({
  /* Destructured: the component reads exactly these two. */
  outcome,
  /* Only used by the invoke_error sentence. */
  httpStatus,
  /* The function's own error words, also only for invoke_error. */
  errorText = null,
  /* The lane's steps, for the not_startable sentence; the drawer's lane when omitted. */
  steps = PASSED_FILTERS_STEPS,
}: {
  /* What the engine returned. */
  readonly outcome: RowPipelineOutcome;
  /* The last invoke's HTTP status, for the invoke_error sentence. */
  readonly httpStatus: number | null;
  /* The function's own error words, when a call failed. */
  readonly errorText?: string | null;
  /* Optional so existing callers render exactly as before. */
  readonly steps?: readonly PipelineStep[];
}): ReactElement {
  /* One paragraph, so the sentence and its link are announced together by the live region. */
  return (
    <p className="drawer__send-outcome">
      {/* Text node only; the sentence never goes through innerHTML. */}
      {describeOutcome(outcome, httpStatus, errorText, steps)}
      {/* The link is the action this whole run exists to reach. */}
      {outcome.kind === 'ready_for_approval' && (
        <>
          {/* A real space, so the sentence and the link text do not run together. */}
          {' '}
          {/* Router Link, as DiscoveredJobsPage does: stays in the SPA, keeps the session warm. */}
          <Link to="/approvals" className="drawer__send-link">
            {/* Names the destination, so the link's accessible name says where it goes. */}
            Open the approval queue
          </Link>
        </>
      )}
    </p>
  );
}

/* One finished run's answer: the outcome plus the facts its sentence may need. Exported so a page
   that unmounts the card on refresh (DiscoveredJobsPage) can keep showing the result itself. */
export interface SendResult {
  /* What the engine returned. */
  readonly outcome: RowPipelineOutcome;
  /* The last invoke's HTTP status, for the invoke_error sentence. */
  readonly httpStatus: number | null;
  /* The function's own error words, when a call failed. */
  readonly errorText: string | null;
}

/* The button, the step list and the result for one row. The drawer card renders it only in
   SEND_LANE with PASSED_FILTERS_STEPS; DiscoveredJobsPage renders it with DISCOVERED_STEPS.
   Exported (2026-10-08) so both lanes share one lock, one progress list and one set of sentences. */
export function SendThroughPipeline({
  /* Lock key and the id every invoke carries. */
  applicationId,
  /* Injected, so this component never touches the client itself. */
  deps,
  /* The lane's agents, in order: the only thing that differs between the two lanes. */
  steps,
  /* The caller's refresh hook; the drawer passes none. */
  onSettled,
  /* Names the job in the button's accessible name; the drawer passes none. */
  label,
}: {
  /* The row to send; also the lock key. */
  readonly applicationId: string;
  /* Null disables the button with a visible reason. */
  readonly deps: RowPipelineDeps | null;
  /* Required, so no caller silently gets the wrong lane's agents by default. */
  readonly steps: readonly PipelineStep[];
  /* Called once a click has been handled and the lock is released: with the result, or null when
     there is none (a refused click or an unexpected throw). The row has usually left its lane by
     then, so a list page reloads here, and that reload may unmount this card. */
  /* `| undefined` (2026-10-09) so the drawer card can forward its own optional prop as-is under
     exactOptionalPropertyTypes; undefined behaves exactly like omitting it. */
  readonly onSettled?: ((result: SendResult | null) => void) | undefined;
  /* e.g. "Acme — Engineer". On a page of many cards, identical button names leave a screen-reader
     user unable to tell which job a button sends; omitted, the visible text stays the name. */
  readonly label?: string;
}): ReactElement {
  /* True while THIS card's run is going; the module lock covers other instances. */
  const [running, setRunning] = useState(false);
  /* Null until the first run, so an idle card shows no step list at all. Named progress, not
     steps, so it cannot be confused with the steps prop (the list of agents to run). */
  const [progress, setProgress] = useState<Readonly<Partial<Record<PipelineStep, StepDisplay>>> | null>(null);
  /* The engine's answer plus the HTTP status its sentence may need; null before and during a run. */
  const [result, setResult] = useState<SendResult | null>(null);
  /* Client-side notes the engine never produces (lock refusal, unexpected throw). */
  const [note, setNote] = useState<string | null>(null);

  /* Starts one run. Every state write after the lock check belongs to the run that holds the lock. */
  async function start(): Promise<void> {
    /* The button is disabled in this case; this guards a programmatic click too. */
    if (deps === null) return;
    /* What onSettled receives; stays null unless the engine answered. */
    let settled: SendResult | null = null;
    /* The mandatory lock plus the settle ordering, through the one tested helper: a second click, a
       remount, or another card for this id gets started:false and nothing runs; onSettled fires once,
       after the release, on every path. */
    const run = await withRowLockThenSettle(
      // The row this card sends.
      applicationId,
      // The run itself, under the lock.
      async () => {
        /* Disables this card's button for the run. */
        setRunning(true);
        /* Cleared so a previous outcome is not read as this run's. */
        setResult(null);
        /* Cleared for the same reason. */
        setNote(null);
        /* Every step of THIS lane shown as waiting until the engine reports on it. */
        setProgress(Object.fromEntries(steps.map((step) => [step, 'waiting'])));
        /* The outcome does not carry an HTTP status, so the last invoke's is remembered here. */
        let lastHttpStatus: number | null = null;
        /* Nor the function's own error words (describeInvokeError's text, carried in body.error). */
        let lastErrorText: string | null = null;
        /* Captured once, so the optional method's presence is checked and used on the same value. */
        const readScore = deps.readMatchScore;
        /* Pass-through deps that only observe; the engine sees exactly what the real deps return. */
        const observed: RowPipelineDeps = {
          /* Records the status and error text, then hands back the untouched result. */
          invoke: async (step, id) => {
            /* The real call, through the injected deps. */
            const res = await deps.invoke(step, id);
            /* Kept for the invoke_error sentence. */
            lastHttpStatus = res.httpStatus;
            /* The engine's words from EVERY answer, 2xx included (2026-11-07: a 200 whose body failed the
               row was dropped here, so Netomi's rate-limit read as a bare "stopped"). Reset on every call,
               so a later step never carries an earlier step's words; only a stop's sentence reads them. */
            lastErrorText = engineReasonText(res.body);
            /* Unchanged, so the engine decides as it would without the wrapper. */
            return res;
          },
          /* Reads go straight through. */
          readStatus: (id) => deps.readStatus(id),
          /* Passed through only when the real deps have it, so the engine sees the same optional
             contract; dropping it here would silently make every matcher drop "unknown". */
          ...(readScore === undefined ? {} : { readMatchScore: (id: string) => readScore.call(deps, id) }),
        };
        /* Re-enabled in finally however the run ends; the lock itself is released by withRowLock. */
        try {
          /* The engine runs this lane's agents in order and re-reads the row after each. Paced: one row
             at a time across every card, so a burst of clicks queues instead of exhausting Gemini's
             per-minute quota. The row lock is held while queued, so the steps read "waiting". */
          const outcome = await paceSend(() =>
            /* Unchanged engine call, only deferred until the queue reaches it. */
            runRowPipeline(observed, applicationId, steps, (event) =>
              /* Functional update: events arrive between awaits and must not overwrite each other. */
              setProgress((prev) => ({ ...(prev ?? {}), [event.step]: event.phase })),
            ),
          );
          /* The list must say what the note says: a run that ended short at a "done" step shows it stopped. */
          setProgress((prev) => (prev === null ? prev : settleProgress(prev, outcome)));
          /* Kept for onSettled as well as for this card's own note. */
          settled = { outcome, httpStatus: lastHttpStatus, errorText: lastErrorText };
          /* The honest sentence comes from the outcome, with the call's own words when it failed. */
          setResult(settled);
        } catch (err) {
          /* The engine and deps are written never to throw; if one does, say so plainly. */
          setNote(`The run ended with an unexpected error: ${err instanceof Error ? err.message : String(err)}`);
        } finally {
          /* Re-enables this card's button. */
          setRunning(false);
          /* A click refused DURING this run left "already being sent"; it is stale once the run ends.
             Only that note is cleared, so an unexpected-error note from the catch above survives. */
          setNote((current) => (current === ALREADY_RUNNING_MESSAGE ? null : current));
        }
      },
      // Read at settle time, so it carries this run's result (or null when there was none).
      () => onSettled?.(settled),
    );
    /* The row was held elsewhere: say why nothing happened, instead of a silent no-op. */
    if (!run.started) setNote(ALREADY_RUNNING_MESSAGE);
  }

  /* Disabled while this card runs, while another instance holds the lock, or with no client. */
  const disabled = running || isRowInFlight(applicationId) || deps === null;
  /* One source for the button text, so the aria-label can begin with exactly what is shown. */
  const visibleText = running ? 'Sending through pipeline…' : 'Send through pipeline';
  /* Note: isRowInFlight is read at render, so another card's run shows here on its next render. */
  /* One block under the meta row, so the run reads as its own section of the card. */
  return (
    <div className="drawer__send">
      <button
        /* Not a submit: the drawer has no form, and a default submit would be a surprise later. */
        type="button"
        /* Shared button classes for the look; drawer__send-button is the hook tests key on. */
        className="button button--primary button--small drawer__send-button"
        /* A real disabled attribute, so the browser itself refuses the second click. */
        disabled={disabled}
        /* Tells assistive tech the control is working, not just greyed out. */
        aria-busy={running}
        /* void: the promise is handled inside start(); nothing here awaits it. */
        onClick={() => void start()}
        /* Names the agents one click runs (each one may spend Gemini quota), before anyone clicks. */
        title={`Runs the deployed ${steps.map((step) => STEP_LABEL[step]).join(' → ')} for this row`}
        /* Only with a label: undefined renders no attribute, so the drawer's name is its visible text.
           Starts WITH the visible text (WCAG 2.5.3 label-in-name), so a voice user saying "click Send
           through pipeline" still hits it; the job after the colon makes each card's name unique. */
        aria-label={label === undefined ? undefined : `${visibleText}: ${label}`}
      >
        {/* The idle label is unique to this feature: the live-deploy sentinel. */}
        {visibleText}
      </button>
      {/* The reason a disabled button would otherwise leave unexplained. */}
      {deps === null && <span className="drawer__send-reason">Supabase is not configured, so the agents cannot be called.</span>}
      {/* Polite: progress is announced without interrupting the operator. Always live, so the lock
          refusal and the unexpected-throw notes below are announced on every page too (review fix,
          2026-10-09: with the region dropped, those two reached no live region on the Discovered page). */}
      <div className="drawer__send-progress" aria-live="polite">
        {/* Absent until the first run, so an idle card stays compact. */}
        {progress !== null && (
          <ol className="drawer__send-steps">
            {/* The same list the engine was given, so the UI shows exactly the agents it runs. */}
            {steps.map((step) => (
              /* data-state drives the colour; the text says the same thing for screen readers. */
              <li key={step} className="drawer__send-step" data-state={progress[step] ?? 'waiting'}>
                {/* "Matcher: running", or "Matcher: stopped (why)": one text node, so the engine's
                    untrusted words are escaped by React and never parsed as markup. */}
                {stepLine(step, progress[step] ?? 'waiting', result)}
              </li>
            ))}
          </ol>
        )}
        {/* The outcome sentence and, on success, the queue link. Not here when the caller takes
            onSettled: that caller (DiscoveredJobsPage) shows and announces the outcome in its own live
            strip, which outlives this card, and two live regions would read the same sentence twice. */}
        {result !== null && onSettled === undefined && <OutcomeNote outcome={result.outcome} httpStatus={result.httpStatus} errorText={result.errorText} steps={steps} />}
        {/* Lock refusal or an unexpected throw. */}
        {note !== null && <p className="drawer__send-outcome">{note}</p>}
      </div>
    </div>
  );
}

/* ---- The card ---- */

export function DrawerAppCard({
  /* The row this card draws. */
  app,
  /* Opens the tailored resume overlay the drawer owns. */
  onViewResume,
  /* Undefined outside the drawer's wiring: no button. */
  sendThroughPipeline,
}: {
  /* One mapped row from the drawer's query. */
  readonly app: DrawerAppItem;
  /* Receives the row whose snapshot to open; the drawer owns the overlay. */
  readonly onViewResume: (app: DrawerAppItem) => void;
  /* Optional so every existing caller renders unchanged; see SendThroughPipelineProp. */
  readonly sendThroughPipeline?: SendThroughPipelineProp;
}): ReactElement {
  /* Read once: the gone-posting note, or null for a live posting (or an unreadable date). */
  const goneNote = postingGoneNote(app.disappearedAt);
  /* An article per row: each card is a self-contained item in the drawer's list. */
  return (
    <article className="drawer__app-card">
      {/* Title block on the left, source badge on the right. */}
      <div className="drawer__app-top">
        {/* Groups role and company so they stack together beside the badge. */}
        <div>
          {/* The role is what the operator scans for first. */}
          <h3 className="drawer__app-role">{app.role}</h3>
          {/* Employer under the role, secondary. */}
          <span className="drawer__app-company">{app.company}</span>
        </div>
        {/* No badge for a job with no sources, rather than an empty pill. */}
        {app.discoveredVia && app.discoveredVia.length > 0 && (
          <SourceBadge discoveredVia={app.discoveredVia as any} />
        )}
      </div>
      {/* Identifier, date, score and the resume action on one line. */}
      <div className="drawer__app-meta">
        {/* Eight characters are enough to match a row against logs by eye. */}
        <span className="identifier">{app.id.slice(0, 8)}</span>
        {/* Local date: the operator thinks in their own timezone. */}
        <span>{new Date(app.createdAt).toLocaleDateString()}</span>
        {/* Omitted before scoring, so an unscored row never reads as 0. The approval queue's own fit
            chip (queueView fitChip): match_score is the master-vs-JD FIT, and "Match" names the
            tailored resume's ATS coverage, so one number keeps one name. */}
        {app.score !== null && app.score !== undefined && <span>{fitChip(app.score)}</span>}
        {/* ABSENT, NOT DISABLED, when there is no snapshot: a disabled "View resume"
            invites the question "why not?" and the next fix is a fallback to the master,
            which would show a resume this row was never tailored with. In ANY status,
            because the point is reopening the tailored resume long after approval. */}
        {app.resume !== null && (
          <button
            /* Not a submit; the drawer has no form. */
            type="button"
            /* Secondary: viewing is lower-stakes than sending, and must look it. */
            className="button button--secondary button--small drawer__view-resume"
            /* Hands the whole row up; the drawer owns the overlay. */
            onClick={() => onViewResume(app)}
          >
            {/* The button's accessible name. */}
            View resume
          </button>
        )}
      </div>
      {/* Only the passed_filters lane: other lanes are either not on this three-agent path or
          already past it, and running matcher/tailor/auditor there would be wrong. */}
      {/* A gone posting: the matcher would select 0 rows and the run could only stop, so the card says
          why instead of offering the button (2026-11-07, Rubrik). The drawer has no Reject; that lives
          on the Discovered page. */}
      {sendThroughPipeline !== undefined && sendThroughPipeline.status === SEND_LANE && goneNote !== null && (
        <p className="drawer__send-reason">{goneNote}</p>
      )}
      {sendThroughPipeline !== undefined && sendThroughPipeline.status === SEND_LANE && goneNote === null && (
        <SendThroughPipeline
          /* The row this card draws. */
          applicationId={app.id}
          /* Injected; null disables the button with a reason. */
          deps={sendThroughPipeline.deps}
          /* The three post-screening agents, the only ones this lane may run. */
          steps={PASSED_FILTERS_STEPS}
          /* Undefined keeps the old behaviour: the card shows its own outcome. */
          onSettled={sendThroughPipeline.onSettled}
          /* Unique per card, so a screen reader can tell the drawer's buttons apart. */
          label={`${app.company} — ${app.role}`}
        />
      )}
    </article>
  );
}
