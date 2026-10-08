/* One application card in the pipeline drawer. Split out of PipelineDrawer.tsx (2026-10-06)
   so it renders with no Supabase client: the drawer imports the client singleton, and this
   card's one decision ("does this row offer View resume?") needs a test that can reach it.

   2026-10-08: also carries "Send through pipeline" for the passed_filters lane. The real deps
   live in rowPipelineDeps.ts and arrive as a prop, so this file still imports no client. */

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
/* The pure per-row engine (another worker's file; imported, never edited). The browser only
   INVOKES agents through its deps; every status change is the deployed agent's own write.
   With its extension, like SourceBadge above: other tests' load hooks only try .tsx. */
import { PASSED_FILTERS_STEPS, runRowPipeline } from './rowPipeline.ts';
/* Types only: the engine's contract, so a new outcome kind or stop reason fails to compile here. */
import type { PipelineStep, RowPipelineDeps, RowPipelineOutcome, StepEvent, StopReason } from './rowPipeline.ts';

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
  /* Not shown in this lane, but the record must be total. */
  normalizer: 'Normalizer',
  /* Not shown in this lane either. */
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

const STOP_MESSAGE: Record<StopReason, (step: string, finalStatus: string | null, httpStatus: number | null, errorText: string | null) => string> = {
  /* The call failed; the status code tells "signed out" (401) from "agent crashed" (500), and the
     function's own words (describeInvokeError, e.g. no_master_profile) say what to do about it. */
  invoke_error: (step, _finalStatus, http, errorText) =>
    /* The final status is ignored: after a failed call the useful facts are the code and the reason. */
    `Stopped at the ${step}: the call failed (${callFailure(http, errorText)}).`,
  /* The kill switch answers 200 with a skip, so without this it would read as "did not move". */
  /* Names the real setting, not a metaphor: the gate halts unless system_settings.system_enabled is
     exactly true (gates.ts readKillSwitch), and "kill switch is off" would say the opposite. */
  halted: (step) => `Paused at the ${step}: the pipeline is switched off (system_settings.system_enabled is not true).`,
  /* A 200 whose body lists per-row failures is not a success. */
  body_failure: (step, finalStatus) =>
    /* Names where the row sits now; it may have moved partway before the failure. */
    `Stopped at the ${step}: it answered but reported a failure for this row (now at ${finalStatus ?? 'unknown'}).`,
  /* Also the engine's after-loop fallback, where the row DID move to an intermediate status, so
     this says where the run ended, never that nothing moved. */
  no_progress: (step, finalStatus) => `Stopped at the ${step}: the run ended with the row at ${finalStatus ?? 'an unknown status'}, short of approval.`,
  /* The re-read failed, so where the row is now is genuinely unknown. */
  status_unreadable: (step) => `Stopped after the ${step}: the row's status could not be read back.`,
};

/* One honest sentence per outcome kind. A mapped type over the union, so each entry receives its
   own narrowed outcome and a new kind in rowPipeline.ts fails to compile until it has a sentence. */
export const OUTCOME_MESSAGE: {
  readonly [K in RowPipelineOutcome['kind']]: (outcome: Extract<RowPipelineOutcome, { kind: K }>, httpStatus: number | null, errorText: string | null) => string;
} = {
  /* The engine refused before any call; nothing was spent. */
  invalid_id: () => "Nothing was run: this row's id is not a valid application id.",
  /* The first read failed; nothing was invoked, so nothing was spent. */
  status_unreadable: () => "Nothing was run: this row's status could not be read.",
  /* The row moved lanes since the drawer loaded; these three agents would be the wrong ones. */
  not_startable: (o) => `Nothing was run: the row is now at ${o.finalStatus}, not passed_filters.`,
  /* OutcomeNote renders the queue link beside this sentence. */
  /* Flagged audits reach awaiting_approval too, so the sentence points at the findings. */
  ready_for_approval: () => 'Ready for your approval: check any audit findings in the queue',
  /* The matcher is the only agent in this lane that drops; any other dropper is named. */
  dropped: (o) =>
    /* Branch on the step, never on the status text, so the sentence names who dropped it. */
    o.atStep === 'matcher'
      ? /* The matcher's floor is a code constant (_shared/match/score-threshold.ts), not a user setting. */
        "The matcher dropped this job (it scored below the matcher's advance floor)"
      : /* Unexpected in this lane, so it names the step and the exact status. */
        `The ${STEP_LABEL[o.atStep].toLowerCase()} dropped this job (${o.finalStatus}).`,
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
  stopped: (o, http, errorText) => STOP_MESSAGE[o.reason](STEP_LABEL[o.atStep].toLowerCase(), o.finalStatus, http, errorText),
};

/* The one place the mapped table is called. The cast is sound: outcome.kind selects the entry whose
   parameter is exactly Extract<..., {kind: outcome.kind}>, a correlation TypeScript cannot see. */
export function describeOutcome(
  // What the engine returned.
  outcome: RowPipelineOutcome,
  // The last invoke's HTTP status, for the invoke_error sentence.
  httpStatus: number | null,
  // The function's own error words (deps body.error); optional so plain outcomes need not pass it.
  errorText: string | null = null,
): string {
  /* Widened view of the entry for this kind. */
  const sentence = OUTCOME_MESSAGE[outcome.kind] as (o: RowPipelineOutcome, http: number | null, err: string | null) => string;
  /* Text only; callers render it as a text node. */
  return sentence(outcome, httpStatus, errorText);
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
}: {
  /* What the engine returned. */
  readonly outcome: RowPipelineOutcome;
  /* The last invoke's HTTP status, for the invoke_error sentence. */
  readonly httpStatus: number | null;
  /* The function's own error words, when a call failed. */
  readonly errorText?: string | null;
}): ReactElement {
  /* One paragraph, so the sentence and its link are announced together by the live region. */
  return (
    <p className="drawer__send-outcome">
      {/* Text node only; the sentence never goes through innerHTML. */}
      {describeOutcome(outcome, httpStatus, errorText)}
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

/* The button, the step list and the result for one row. The card renders it only in SEND_LANE. */
function SendThroughPipeline({
  /* Lock key and the id every invoke carries. */
  applicationId,
  /* Injected, so this component never touches the client itself. */
  deps,
}: {
  /* The row to send; also the lock key. */
  readonly applicationId: string;
  /* Null disables the button with a visible reason. */
  readonly deps: RowPipelineDeps | null;
}): ReactElement {
  /* True while THIS card's run is going; the module lock covers other instances. */
  const [running, setRunning] = useState(false);
  /* Null until the first run, so an idle card shows no step list at all. */
  const [steps, setSteps] = useState<Readonly<Partial<Record<PipelineStep, StepDisplay>>> | null>(null);
  /* The engine's answer plus the HTTP status its sentence may need; null before and during a run. */
  const [result, setResult] = useState<{ readonly outcome: RowPipelineOutcome; readonly httpStatus: number | null; readonly errorText: string | null } | null>(null);
  /* Client-side notes the engine never produces (lock refusal, unexpected throw). */
  const [note, setNote] = useState<string | null>(null);

  /* Starts one run. Every state write after the lock check belongs to the run that holds the lock. */
  async function start(): Promise<void> {
    /* The button is disabled in this case; this guards a programmatic click too. */
    if (deps === null) return;
    /* The mandatory lock, through the one tested helper: a second click, a remount, or another card
       for this id gets started:false and nothing runs. */
    const run = await withRowLock(applicationId, async () => {
      /* Disables this card's button for the run. */
      setRunning(true);
      /* Cleared so a previous outcome is not read as this run's. */
      setResult(null);
      /* Cleared for the same reason. */
      setNote(null);
      /* Every step shown as waiting until the engine reports on it. */
      setSteps({ matcher: 'waiting', tailor: 'waiting', auditor: 'waiting' });
      /* The outcome does not carry an HTTP status, so the last invoke's is remembered here. */
      let lastHttpStatus: number | null = null;
      /* Nor the function's own error words (describeInvokeError's text, carried in body.error). */
      let lastErrorText: string | null = null;
      /* Pass-through deps that only observe; the engine sees exactly what the real deps return. */
      const observed: RowPipelineDeps = {
        /* Records the status and error text, then hands back the untouched result. */
        invoke: async (step, id) => {
          /* The real call, through the injected deps. */
          const res = await deps.invoke(step, id);
          /* Kept for the invoke_error sentence. */
          lastHttpStatus = res.httpStatus;
          /* A string error only: the body is data from the network, so its shape is checked. */
          const error = typeof res.body === 'object' && res.body !== null ? (res.body as { error?: unknown }).error : undefined;
          /* Reset on every call, so a later success never carries an earlier failure's words. */
          lastErrorText = res.ok || typeof error !== 'string' ? null : error;
          /* Unchanged, so the engine decides as it would without the wrapper. */
          return res;
        },
        /* Reads go straight through. */
        readStatus: (id) => deps.readStatus(id),
      };
      /* Re-enabled in finally however the run ends; the lock itself is released by withRowLock. */
      try {
        /* The engine runs the three agents in order and re-reads the row after each. */
        const outcome = await runRowPipeline(observed, applicationId, PASSED_FILTERS_STEPS, (event) =>
          /* Functional update: events arrive between awaits and must not overwrite each other. */
          setSteps((prev) => ({ ...(prev ?? {}), [event.step]: event.phase })),
        );
        /* The honest sentence comes from the outcome, with the call's own words when it failed. */
        setResult({ outcome, httpStatus: lastHttpStatus, errorText: lastErrorText });
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
    });
    /* The row was held elsewhere: say why nothing happened, instead of a silent no-op. */
    if (!run.started) setNote(ALREADY_RUNNING_MESSAGE);
  }

  /* Disabled while this card runs, while another instance holds the lock, or with no client. */
  const disabled = running || isRowInFlight(applicationId) || deps === null;
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
      >
        {/* The idle label is unique to this feature: the live-deploy sentinel. */}
        {running ? 'Sending through pipeline…' : 'Send through pipeline'}
      </button>
      {/* The reason a disabled button would otherwise leave unexplained. */}
      {deps === null && <span className="drawer__send-reason">Supabase is not configured, so the agents cannot be called.</span>}
      {/* Polite: progress is announced without interrupting the operator. */}
      <div className="drawer__send-progress" aria-live="polite">
        {/* Absent until the first run, so an idle card stays compact. */}
        {steps !== null && (
          <ol className="drawer__send-steps">
            {/* The engine's own step list, so the UI shows exactly the agents it runs. */}
            {PASSED_FILTERS_STEPS.map((step) => (
              /* data-state drives the colour; the text says the same thing for screen readers. */
              <li key={step} className="drawer__send-step" data-state={steps[step] ?? 'waiting'}>
                {/* "Matcher: running" — a text node, never markup from the engine. */}
                {STEP_LABEL[step]}: {steps[step] ?? 'waiting'}
              </li>
            ))}
          </ol>
        )}
        {/* The outcome sentence and, on success, the queue link. */}
        {result !== null && <OutcomeNote outcome={result.outcome} httpStatus={result.httpStatus} errorText={result.errorText} />}
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
        {/* Omitted before scoring, so an unscored row never reads as 0%. */}
        {app.score !== null && app.score !== undefined && <span>Match: {app.score}%</span>}
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
      {sendThroughPipeline !== undefined && sendThroughPipeline.status === SEND_LANE && (
        <SendThroughPipeline applicationId={app.id} deps={sendThroughPipeline.deps} />
      )}
    </article>
  );
}
