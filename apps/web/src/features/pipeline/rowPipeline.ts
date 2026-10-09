// Pure per-row pipeline engine behind "Send through pipeline" (the Pipeline drawer's
// passed_filters cards and, since 2026-10-08, every Discovered job card).
//
// WHY this file exists: the button runs the REAL deployed agents for ONE application, in order,
// by invoking each edge function with ?application_id=. The functions advance the status
// themselves; the browser only invokes and re-reads. It never writes a status (commit 75a75a0
// deleted a button that forged six transitions) and never holds the agent key.
//
// It MIRRORS worker/src/cli/run-one.ts rather than importing it, because run-one imports
// node:url and reads process.argv at module scope, neither of which exists in the browser.
// apps/web/test/rowPipelineParity.test.ts pins the two copies together so they cannot drift.
//
// Every effect is injected through RowPipelineDeps, so this module has no I/O, no timers and
// no retries of its own, and the tests need no network.

// Closed union, so a step without an input status (below) fails to compile instead of being
// silently skipped or always run.
export type PipelineStep = 'normalizer' | 'screener' | 'matcher' | 'tailor' | 'auditor';

// The status each step's queue selects. Keyed by the full union so the Record forces an entry
// for every step; the arrays are the statuses the deployed function will act on.
export const STEP_INPUT_STATUS: Readonly<Record<PipelineStep, readonly string[]>> = {
  // discovered -> deduped | dropped_duplicate. Targetable with ?application_id= since 1821881:
  // the row is deduped against every OTHER jobs row of the same user, not only itself.
  normalizer: ['discovered'],
  // deduped -> passed_filters | dropped_filter | failed (missing_job_record); targetable since 1821881.
  screener: ['deduped'],
  // passed_filters -> scored | dropped_filter (same as run-one.ts:18).
  matcher: ['passed_filters'],
  // scored -> tailored | failed, or the row stays at scored (run-one.ts:20).
  tailor: ['scored'],
  // tailored -> audit_clean | audit_flagged -> awaiting_approval; also resumes rows a previous
  // auditor run left at audit_clean/audit_flagged (run-one.ts:23).
  auditor: ['tailored', 'audit_clean', 'audit_flagged'],
};

// What the drawer's passed_filters button runs: the three agents after screening. Equal to
// run-one's STEPS, which the parity test asserts.
export const PASSED_FILTERS_STEPS: readonly PipelineStep[] = ['matcher', 'tailor', 'auditor'];

// The full chain for a Discovered row, run by the per-card button on DiscoveredJobsPage (Teja's
// ruling, 2026-10-08 16:08). Possible because normalizer and screener accept ?application_id=
// since commit 1821881 (malformed id -> 400; unknown uuid -> 200 found:0, read as no_progress).
export const DISCOVERED_STEPS: readonly PipelineStep[] = ['normalizer', 'screener', 'matcher', 'tailor', 'auditor'];

// Same regex as run-one.ts:27, which is the shape the edge functions enforce server-side.
// A shape check, not a lenient parse: a typo must never reach a function.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** True only for a string shaped like an application UUID. */
export function isApplicationId(value: unknown): value is string {
  // typeof first so a number or null never reaches .test(), which would stringify it.
  return typeof value === 'string' && UUID_RE.test(value);
}

/** True when a 2xx body still reports success:false or per-row failures (run-one.ts:60-67). */
export function bodyReportsFailure(body: unknown): boolean {
  // Non-object bodies cannot carry the fields; the status re-read still guards them.
  if (typeof body !== 'object' || body === null) return false;
  // Loose view of the documented response fields; nothing else is trusted.
  const b = body as { success?: unknown; failures?: unknown };
  // The functions answer 200 with per-row failures listed, so HTTP ok is not enough.
  return b.success === false || (Array.isArray(b.failures) && b.failures.length > 0);
}

/** One function call's outcome, reduced to what the decision needs. */
export interface InvokeResult {
  // False for non-2xx or a transport failure; a failed call is never retried.
  readonly ok: boolean;
  // Null when no HTTP response arrived at all, so the UI can tell "offline" from "403".
  readonly httpStatus: number | null;
  // Parsed body, kept so the UI can show the function's own explanation.
  readonly body: unknown;
}

/** Everything impure, injected by the caller. */
export interface RowPipelineDeps {
  // Invokes one edge function for the targeted id. Never throws: the caller wraps transport
  // errors into ok=false, so the engine has exactly one failure channel to handle.
  invoke(step: PipelineStep, applicationId: string): Promise<InvokeResult>;
  // Reads the row's current status; null means it could not be read (missing, RLS, error).
  readStatus(applicationId: string): Promise<string | null>;
}

// Progress events, one stream per run, so the drawer can render each step's state live.
export type StepEvent =
  // The row's status is not this step's input; nothing was invoked.
  | { readonly step: PipelineStep; readonly phase: 'skipped' }
  // Emitted before the invoke, so a slow agent shows as in progress.
  | { readonly step: PipelineStep; readonly phase: 'running' }
  // The function answered cleanly and the row moved to statusAfter.
  | { readonly step: PipelineStep; readonly phase: 'done'; readonly statusAfter: string }
  // The run stops here; statusAfter is the best-effort re-read (null when unreadable).
  | { readonly step: PipelineStep; readonly phase: 'stopped'; readonly statusAfter: string | null };

// Why a run stopped short of a terminal status. A closed union so the UI must word each one.
export type StopReason = 'invoke_error' | 'halted' | 'body_failure' | 'no_progress' | 'status_unreadable';

// The run's verdict, classified by the row's FINAL status, never by "did every step run".
export type RowPipelineOutcome =
  // The id failed the shape check; nothing was read or invoked.
  | { readonly kind: 'invalid_id' }
  // The very first read failed; nothing invoked.
  | { readonly kind: 'status_unreadable' }
  // No step's input matched the starting status; nothing invoked.
  | { readonly kind: 'not_startable'; readonly finalStatus: string }
  // The only outcome that sends the operator to the approval queue.
  | { readonly kind: 'ready_for_approval'; readonly finalStatus: 'awaiting_approval' }
  // An agent legitimately filtered the row out; atStep is the agent that did it.
  | { readonly kind: 'dropped'; readonly finalStatus: 'dropped_filter' | 'dropped_duplicate'; readonly atStep: PipelineStep }
  // An agent moved the row to failed; atStep is the agent that did it.
  | { readonly kind: 'failed'; readonly finalStatus: 'failed'; readonly atStep: PipelineStep }
  // The run stopped at a non-terminal status; reason says why.
  | { readonly kind: 'stopped'; readonly atStep: PipelineStep; readonly reason: StopReason; readonly finalStatus: string | null };

// Maps a terminal status to its outcome, or null when the status is not terminal.
// One function so the in-loop override and the after-loop classification cannot disagree.
function classifyTerminal(status: string | null, atStep: PipelineStep): RowPipelineOutcome | null {
  // The human gate: the only status that means "go review it".
  if (status === 'awaiting_approval') return { kind: 'ready_for_approval', finalStatus: status };
  // Both drop statuses are a filter's verdict, not an error.
  if (status === 'dropped_filter' || status === 'dropped_duplicate') return { kind: 'dropped', finalStatus: status, atStep };
  // An agent recorded a failure on the row itself.
  if (status === 'failed') return { kind: 'failed', finalStatus: status, atStep };
  // Anything else is not an end state, so the caller decides how to report it.
  return null;
}

/** Runs the steps in order for one application; see RowPipelineOutcome for the verdicts. */
export async function runRowPipeline(
  deps: RowPipelineDeps,
  applicationId: string,
  steps: readonly PipelineStep[],
  onEvent?: (event: StepEvent) => void,
): Promise<RowPipelineOutcome> {
  // Shape check before any deps call, so a malformed id costs nothing and reaches no function.
  if (!isApplicationId(applicationId)) return { kind: 'invalid_id' };
  // Optional sink, so callers without a UI need no no-op callback.
  const emit = (event: StepEvent): void => onEvent?.(event);
  // Baseline, so "did not advance" is a comparison and not a guess.
  let current = await deps.readStatus(applicationId);
  // Without a baseline no skip decision is possible; run-one would skip everything instead.
  if (current === null) return { kind: 'status_unreadable' };
  // The last step actually invoked; null means the run never invoked anything.
  let lastInvoked: PipelineStep | null = null;
  // Steps are data, so the same loop serves the passed_filters and discovered chains.
  for (const step of steps) {
    // Resume support: a row already past this step (e.g. at 'scored' after a tailor failure)
    // skips it instead of stopping with "did not move" before the step that actually failed.
    if (!STEP_INPUT_STATUS[step].includes(current)) {
      // Visible, never silent, so the operator sees why an agent did not run.
      emit({ step, phase: 'skipped' });
      // Nothing was called, so the baseline is unchanged.
      continue;
    }
    // Before the invoke, so the UI shows progress while the agent works.
    emit({ step, phase: 'running' });
    // Recorded before the await so every later outcome can name this step.
    lastInvoked = step;
    // One attempt only: a retry would re-spend Gemini quota on a row that already failed.
    const res = await deps.invoke(step, applicationId);
    // The three response-level stops, checked in run-one's order of severity; null = carry on.
    const reason: StopReason | null = !res.ok
      ? 'invoke_error'
      : // The kill switch answers 200; without this it would read as "did not move".
        isSkippedDisabled(res.body)
        ? 'halted'
        : // A 200 that still lists per-row failures is not a success.
          bodyReportsFailure(res.body)
          ? 'body_failure'
          : null;
    // Re-read rather than trust the response: the database is the source of truth.
    const next = await deps.readStatus(applicationId);
    // A response-level stop ends the run here.
    if (reason !== null) {
      // Reported with the best-effort re-read, so the UI shows where the row actually is.
      emit({ step, phase: 'stopped', statusAfter: next });
      // TERMINAL OVERRIDES STOP: if the row reached an end state, that is the truth, even when
      // the body also listed failures (e.g. a tailor that refused a row and marked it failed).
      return classifyTerminal(next, step) ?? { kind: 'stopped', atStep: step, reason, finalStatus: next };
    }
    // A clean 200 whose re-read failed: we cannot tell whether the row moved, so stop.
    if (next === null) {
      // Null statusAfter tells the UI the position is unknown, not unchanged.
      emit({ step, phase: 'stopped', statusAfter: null });
      // Distinct reason so the operator retries the read, not the agent.
      return { kind: 'stopped', atStep: step, reason: 'status_unreadable', finalStatus: null };
    }
    // A clean 200 that did not move the row: found:0 or a left-in-place outcome
    // (liveness_unknown / posting_disappeared). Running on would only skip everything after.
    if (next === current) {
      // statusAfter equals the start, which is exactly what the UI should show.
      emit({ step, phase: 'stopped', statusAfter: next });
      // no_progress, at this step, with the unchanged status.
      return { kind: 'stopped', atStep: step, reason: 'no_progress', finalStatus: next };
    }
    // The row advanced; reported before the baseline moves so statusAfter is this step's.
    emit({ step, phase: 'done', statusAfter: next });
    // Advance the baseline for the next step's skip decision and comparison.
    current = next;
  }
  // Nothing ran: the starting status matched no step, so the button had nothing to do.
  // Checked before classification, because a terminal outcome needs the step that produced it.
  if (lastInvoked === null) return { kind: 'not_startable', finalStatus: current };
  // Classify by FINAL status. current only changes on 'done', so lastInvoked produced it.
  // A run that reached an intermediate status (e.g. audit_flagged without awaiting_approval)
  // falls through to no_progress at the last step that ran.
  return classifyTerminal(current, lastInvoked) ?? { kind: 'stopped', atStep: lastInvoked, reason: 'no_progress', finalStatus: current };
}

// True when the function answered 200 with its kill switch off. Two spellings exist: most agents
// say status:"skipped_disabled", but the SCREENER says status:"halted_by_kill_switch"
// (screener/index.ts:131). Missing the second made a halted screener read as no_progress.
// data/pipelineRunner.ts:107 accepts the same two spellings for the batch runner.
function isSkippedDisabled(body: unknown): boolean {
  // Same loose object view as bodyReportsFailure; a non-object body cannot carry the field.
  const status = typeof body === 'object' && body !== null ? (body as { status?: unknown }).status : undefined;
  // Exact matches only: any other status text is not a halt and falls to the later checks.
  return status === 'skipped_disabled' || status === 'halted_by_kill_switch';
}
