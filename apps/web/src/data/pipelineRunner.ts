/* Pipeline Runner — invokes deployed Supabase Edge Functions in sequence
 * from the operator console: normalizer -> screener -> matcher -> tailor -> auditor.
 *
 * WHY THIS FILE CLASSIFIES INSTEAD OF TRUSTING HTTP 200. Every agent answers 200 for
 * outcomes that are not success: the Screener's kill-switch halt
 * (`{status:'halted_by_kill_switch'}`), the Normalizer's `skipped_disabled`, and a
 * Matcher/Tailor/Auditor run whose `failures[]` covers every row. The previous version
 * marked all of those "succeeded" and then returned `ok: true` unconditionally, so a run
 * where nothing moved told the operator to go check the Approval Queue. Each response is
 * now read against the shape that agent actually returns (see each
 * `supabase/functions/<agent>/index.ts` final `jsonResponse(200, …)`), and an
 * unrecognised shape is a failure, not a success — the reader's permissiveness is the
 * fail-open (CLAUDE.md §5).
 */

// Extension included so `node --test` (type stripping, strict ESM resolution) can load
// this module for the classification tests; Vite accepts it either way.
import { supabase } from './supabase.ts';

// The five agents in run order, as a closed union so a typo cannot name a sixth.
export type PipelineAgentId = 'normalizer' | 'screener' | 'matcher' | 'tailor' | 'auditor';

// The honest outcomes of one step. `halted` is distinct from `failed` because the kill
// switch is an operator decision, not a fault; `not_run` records steps a stop skipped.
export type PipelineStepStatus = 'succeeded' | 'partial' | 'halted' | 'failed' | 'not_run';

export interface PipelineStepProgress {
  // Which agent this row describes, so the modal can label it.
  readonly agent: PipelineAgentId;
  // The classified outcome — never inferred from HTTP status alone.
  readonly status: PipelineStepStatus;
  // Rows this step moved to a new status; 0 for halted/failed/not_run.
  readonly moved: number;
  // Human-readable reason or counts, shown verbatim in the modal.
  readonly message?: string;
}

export interface PipelineRunResult {
  // True only when no step failed or halted — gates the modal's success framing.
  readonly ok: boolean;
  // States what actually moved, including "0 rows advanced", never a canned success line.
  readonly summary: string;
  // One entry per agent, in run order, including those a stop prevented.
  readonly steps: readonly PipelineStepProgress[];
}

// The one slice of the Supabase client this module touches. Narrowed so tests can hand
// in a stub without constructing a real client (which needs env and a network).
export interface FunctionsInvoker {
  readonly functions: {
    // Mirrors supabase-js: errors come back in `error`, not as a throw.
    invoke(name: string, options?: Record<string, unknown>): Promise<{ data: unknown; error: unknown }>;
  };
}

// Batch size per agent. Kept small so one click costs at most ~10 Gemini calls per LLM agent.
const BATCH_LIMIT = 10;

// Which response fields count as "rows moved" and which as "row errors", per agent.
// Read from each function's final 200 body; a field missing here is a field we never trust.
const RESPONSE_SHAPES: Readonly<Record<PipelineAgentId, { readonly moved: readonly string[]; readonly errors: string }>> = {
  // deduped and dropped_duplicate are both status transitions out of `discovered`.
  normalizer: { moved: ['deduped', 'dropped_duplicate'], errors: 'errors' },
  // passed and dropped are both transitions out of `deduped`; `failed` counts rows it had to fail.
  screener: { moved: ['passed', 'dropped'], errors: 'failed' },
  // only `scored` is a transition; failures[] rows stay at passed_filters.
  matcher: { moved: ['scored'], errors: 'failures' },
  // `refused` is an honest validator verdict, not a move and not an error, so it is neither.
  tailor: { moved: ['tailored'], errors: 'failures' },
  // `audited` counts rows that reached awaiting_approval; clean/flagged are a breakdown of it.
  auditor: { moved: ['audited'], errors: 'failures' },
};

// Display names and progress copy, in run order — the array order IS the pipeline order.
const AGENTS: ReadonlyArray<{ readonly id: PipelineAgentId; readonly name: string; readonly desc: string }> = [
  // First: collapses duplicate postings so later agents do not pay for the same job twice.
  { id: 'normalizer', name: 'Normalizer', desc: 'Deduplicating discovered jobs & canonical fingerprinting' },
  // Second: deterministic and free, so it runs before any Gemini spend.
  { id: 'screener', name: 'Screener', desc: 'Applying deterministic tech gate & rule cascade' },
  // Third: the first paid step, scoring only what survived screening.
  { id: 'matcher', name: 'Matcher', desc: 'Scoring match fitness against Master Profile with Gemini' },
  // Fourth: builds resumes only for scored rows.
  { id: 'tailor', name: 'Tailor', desc: 'Assembling truthful tailored resumes with node references' },
  // Last: the only route from `tailored` to the Approval Queue.
  { id: 'auditor', name: 'Auditor', desc: 'Auditing anti-fabrication and advancing to Approval Queue' },
];

// Counts a field that is either a number (`errors: 3`) or a list (`failures: [...]`).
function countField(value: unknown): number {
  // A finite number is the count itself; NaN or a string must not sneak in as one.
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  // An array's length is the count of per-row entries.
  if (Array.isArray(value)) return value.length;
  // Anything else contributes nothing — it is not evidence of rows.
  return 0;
}

// Classifies one agent's 2xx body. Exported for the tests, which pin each branch.
export function classifyResponse(agent: PipelineAgentId, data: unknown): Omit<PipelineStepProgress, 'agent'> {
  // A non-object 200 (text, empty body) is not a shape any agent returns, so fail closed.
  if (data === null || typeof data !== 'object') {
    // Saying "unrecognised" rather than "succeeded" is the whole point of this function.
    return { status: 'failed', moved: 0, message: 'Unrecognised response (not a JSON object).' };
  }
  // Index the body by name; it came off the wire so nothing about it is typed yet.
  const body = data as Record<string, unknown>;
  // Both kill-switch spellings: screener says halted_by_kill_switch, normalizer skipped_disabled.
  if (body['status'] === 'halted_by_kill_switch' || body['status'] === 'skipped_disabled') {
    // Halted is reported separately so the runner can stop the steps after it.
    return { status: 'halted', moved: 0, message: 'Kill switch is on (system_settings.system_enabled = false).' };
  }
  // An explicit success:false in a 200 is still a failure, whatever the HTTP code said.
  if (body['success'] === false) {
    // Surface the function's own error code rather than a generic phrase.
    return { status: 'failed', moved: 0, message: String(body['error'] ?? 'Function reported success: false.') };
  }
  // Look up which fields this agent uses to report work done.
  const shape = RESPONSE_SHAPES[agent];
  // Require at least one moved-field to be a real number: a body with none is not this agent's shape.
  if (!shape.moved.some((field) => typeof body[field] === 'number')) {
    // Fail closed — a renamed field must not silently read as "0 moved, all good".
    return { status: 'failed', moved: 0, message: `Unrecognised response shape: ${JSON.stringify(body)}` };
  }
  // Sum every transition the agent reports.
  const moved = shape.moved.reduce((sum, field) => sum + countField(body[field]), 0);
  // Per-row errors, whether reported as a count or a list.
  const errors = countField(body[shape.errors]);
  // The message names both numbers so the operator sees exactly what happened.
  const message = `${moved} row(s) advanced, ${errors} row error(s).`;
  // Every attempted row errored and nothing moved: the step did no useful work.
  if (errors > 0 && moved === 0) return { status: 'failed', moved, message };
  // Some rows moved, some errored: real work happened but not cleanly.
  if (errors > 0) return { status: 'partial', moved, message };
  // No errors — including the legitimate "queue was empty, 0 moved" case.
  return { status: 'succeeded', moved, message };
}

// Turns an invoke error into an operator-readable reason, and says whether to stop.
// For FunctionsHttpError/RelayError, supabase-js puts the raw Response in `error.context`
// (functions-js types.js: `this.context = context`; FunctionsClient.js throws
// `new FunctionsHttpError(response)`), so the function's own `{error}` body is readable.
export async function describeInvokeError(error: unknown): Promise<{ readonly message: string; readonly stop: boolean }> {
  // Pull `context` without trusting the error's class — duck-typing survives bundler duplication.
  const context = (error as { context?: unknown } | null)?.context;
  // Fallback text is supabase-js's own message, used when there is no response to read.
  const fallback = error instanceof Error ? error.message : String(error);
  // Only a Response carries a status and body; FunctionsFetchError's context is the network error.
  if (!(context instanceof Response)) return { message: fallback, stop: false };
  // The function's own error code and detail, if it sent JSON.
  let code = '';
  // Longer explanation some functions add (`detail`) beside the code.
  let detail = '';
  try {
    // Read the body the function wrote; it is the only place the real reason lives.
    const body = (await context.json()) as Record<string, unknown>;
    // `error` is the code every agent's failRun/jsonResponse uses.
    code = typeof body['error'] === 'string' ? body['error'] : '';
    // `detail` or `message`, whichever the function chose to send.
    detail = typeof body['detail'] === 'string' ? body['detail'] : typeof body['message'] === 'string' ? body['message'] : '';
  } catch {
    // A non-JSON error body (gateway HTML) leaves code/detail empty; the status still tells us something.
  }
  // Suffix carrying the function's own words, so the operator is not left with "non-2xx".
  const reason = [code, detail].filter(Boolean).join(' — ');
  // 401: no or invalid token. Every later step sends the same token, so stop now.
  if (context.status === 401) {
    // Actionable wording — the fix is signing in, not retrying.
    return { message: `Not signed in or session expired (401). Sign in again, then retry.${reason ? ` (${reason})` : ''}`, stop: true };
  }
  // 403: signed in, but not the app user the functions accept. Also identical for every step.
  if (context.status === 403) {
    // Names the cause so nobody chases a function bug.
    return { message: `Signed-in user is not permitted to run the pipeline (403).${reason ? ` (${reason})` : ''}`, stop: true };
  }
  // Anything else is specific to this agent; later agents work other queues and may still succeed.
  return { message: `HTTP ${context.status}${reason ? `: ${reason}` : ''}`, stop: false };
}

// The runner with its client injected, so tests can drive it with a stub.
export async function runPipeline(
  client: FunctionsInvoker | null,
  onProgress?: (currentAgent: string, stepInfo: string) => void,
): Promise<PipelineRunResult> {
  // No client means no env configured; say so instead of pretending to run.
  if (client === null) {
    // ok:false so the modal shows the error state, not the success one.
    return { ok: false, summary: 'Supabase client is not configured.', steps: [] };
  }
  // Collected in run order so the modal can render them as a list.
  const steps: PipelineStepProgress[] = [];
  // Set when a halt or auth failure makes every later step pointless or wrong.
  let stopReason: string | null = null;

  for (const agent of AGENTS) {
    // After a stop, record the step as not run rather than silently omitting it.
    if (stopReason !== null) {
      // The modal shows why this step never executed.
      steps.push({ agent: agent.id, status: 'not_run', moved: 0, message: `Not run: ${stopReason}` });
      continue;
    }
    // Live progress line while this agent works.
    onProgress?.(agent.name, `Running ${agent.name}: ${agent.desc}...`);
    // Classified outcome for this agent, filled by exactly one branch below.
    let outcome: Omit<PipelineStepProgress, 'agent'>;
    try {
      // `limit` goes in the query string: every function reads searchParams.get("limit"),
      // never the body. functions-js builds `${url}/${functionName}`, so a query suffix survives.
      const { data, error } = await client.functions.invoke(`${agent.id}?limit=${BATCH_LIMIT}`);
      if (error) {
        // Read the function's own reason out of the Response instead of "non-2xx".
        const described = await describeInvokeError(error);
        // A transport/HTTP error moved nothing.
        outcome = { status: 'failed', moved: 0, message: described.message };
        // Auth errors repeat identically for every agent, so stop rather than spam four more.
        if (described.stop) stopReason = `${agent.name} was refused — ${described.message}`;
      } else {
        // A 2xx is only a candidate success until its body is checked.
        outcome = classifyResponse(agent.id, data);
      }
    } catch (err) {
      // invoke() should not throw, but a stub or a future SDK might; treat it as a failure.
      outcome = { status: 'failed', moved: 0, message: err instanceof Error ? err.message : String(err) };
    }
    // A kill-switch halt must stop everything after it — running the Matcher after the
    // operator switched the system off is exactly what the switch exists to prevent.
    if (outcome.status === 'halted') stopReason = `${agent.name} halted (kill switch is on).`;
    // Record the step with its agent attached.
    steps.push({ agent: agent.id, ...outcome });
    // Progress line reflects the classified outcome, not "Completed successfully."
    onProgress?.(agent.name, `${outcome.status}: ${outcome.message ?? ''}`);
  }

  // Total rows that changed status across the whole run — the number the operator cares about.
  const totalMoved = steps.reduce((sum, s) => sum + s.moved, 0);
  // ok means nothing failed and nothing halted; partial still counts as ok but is named below.
  const ok = steps.every((s) => s.status === 'succeeded' || s.status === 'partial');
  // Steps worth naming in the summary, with their status.
  const problems = steps
    // Only the non-clean ones; listing successes would bury the signal.
    .filter((s) => s.status !== 'succeeded')
    // Short form: "matcher failed".
    .map((s) => `${s.agent} ${s.status.replace('_', ' ')}`);
  // Rows the Auditor advanced are the only ones that reach the Approval Queue.
  const queued = steps.find((s) => s.agent === 'auditor')?.moved ?? 0;
  // Lead with what moved, so "0 rows advanced" is the first thing a failed run says.
  const head = `${totalMoved} row(s) advanced; ${queued} reached the Approval Queue.`;
  // Summary says what happened, then what went wrong, with no canned success line.
  const summary = problems.length === 0 ? `Pipeline run complete. ${head}` : `${ok ? 'Pipeline run finished with row errors.' : 'Pipeline run did not complete.'} ${head} ${problems.join(', ')}.`;
  // Hand the honest result to the modal.
  return { ok, summary, steps };
}

// The app's entry point: the runner bound to the browser's singleton client.
export function runFullPipeline(onProgress?: (currentAgent: string, stepInfo: string) => void): Promise<PipelineRunResult> {
  // The real client's invoke has a wider signature than FunctionsInvoker, so it is assignable.
  return runPipeline(supabase, onProgress);
}
