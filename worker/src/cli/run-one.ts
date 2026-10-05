// Entry point for `pnpm --filter @applyy/worker run run-one -- --id <application uuid>`.
//
// Pushes ONE application through matcher -> tailor -> auditor by calling the deployed edge
// functions with ?application_id=, stopping at the first step that fails or does not move
// the row. Like assist.ts this is a composition root: env, sign-in and fetch live in main();
// the decisions are in runPipeline(), which takes every effect as a parameter so tests need
// no network.
import { pathToFileURL } from 'node:url';

// Fixed order = the status graph's order; each agent's only legal source is the previous output.
export const STEPS = ['matcher', 'tailor', 'auditor'] as const;

// The status each step's queue selects (matcher/index.ts, tailor/index.ts, auditor/index.ts).
// A closed map keyed by the STEPS union, so adding a step without its input status fails to
// compile instead of silently being skipped or always run.
export const STEP_INPUT_STATUS: Readonly<Record<(typeof STEPS)[number], readonly string[]>> = {
  // passed_filters -> scored | dropped_filter (matcher/index.ts:268)
  matcher: ['passed_filters'],
  // scored -> tailored (tailor/index.ts:194)
  tailor: ['scored'],
  // tailored -> audit_clean | audit_flagged -> awaiting_approval; it also picks up rows a
  // previous auditor run left at audit_clean/audit_flagged (auditor/index.ts:224)
  auditor: ['tailored', 'audit_clean', 'audit_flagged'],
};

// Shape check, not a lenient parse: the same regex the edge functions enforce server-side.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** One function call's outcome, reduced to what the decision needs. */
export interface StepResponse {
  // HTTP success; a 4xx/5xx body is data to print, never something to retry.
  ok: boolean;
  // Parsed JSON body, or raw text if it was not JSON.
  body: unknown;
}

/** Everything impure, injected. */
export interface PipelineDeps {
  // POSTs one edge function for the targeted id.
  callFunction: (step: string) => Promise<StepResponse>;
  // Reads the row's current status (null = row invisible or missing).
  readStatus: () => Promise<string | null>;
  // Output sink.
  log: (line: string) => void;
}

/** `--id <uuid>`, validated by shape; throws before any network call. */
export function parseId(argv: readonly string[]): string {
  // -1 means the flag is absent.
  const index = argv.indexOf('--id');
  // The token after the flag, if any.
  const value = index === -1 ? undefined : argv[index + 1];
  // A typo must not reach the server, and there is no "run everything" mode.
  if (!value || !UUID_RE.test(value)) throw new Error('usage: run-one --id <application uuid>');
  // Validated above.
  return value;
}

/** True when a 200 body still reports per-row failures or success:false. */
function bodyReportsFailure(body: unknown): boolean {
  // Non-object bodies cannot carry the fields; the status-advance check still guards them.
  if (typeof body !== 'object' || body === null) return false;
  // Loose view of the documented response fields.
  const b = body as { success?: unknown; failures?: unknown };
  // The functions answer 200 with per-row failures listed, so HTTP ok is not enough.
  return b.success === false || (Array.isArray(b.failures) && b.failures.length > 0);
}

/** Runs the steps in order; returns the final status and whether every step advanced. */
export async function runPipeline(deps: PipelineDeps): Promise<{ completed: boolean; finalStatus: string | null }> {
  // Baseline, so "did not advance" is a comparison and not a guess.
  let current = await deps.readStatus();
  // Shown so a wrong starting status is obvious.
  deps.log(`start: status=${current}`);
  for (const step of STEPS) {
    // Resume support: a row that already passed this step (e.g. sits at 'scored' after a
    // tailor failure) must skip the matcher, whose queue is passed_filters only. Without
    // this, a resumed run stops at the matcher with "did not move" and never reaches the
    // step that actually failed.
    if (current === null || !STEP_INPUT_STATUS[step].includes(current)) {
      // Logged so a skip is visible, never silent.
      deps.log(`${step}: skipped (row at ${current}, step reads ${STEP_INPUT_STATUS[step].join('|')})`);
      // Nothing was called, so the baseline is unchanged.
      continue;
    }
    // One attempt only: automatic retries would re-spend Gemini quota on a row that failed.
    const res = await deps.callFunction(step);
    // Re-read rather than trust the response; the database is the source of truth.
    const next = await deps.readStatus();
    deps.log(`${step}: http_ok=${res.ok} status=${next}`);
    // Stop on HTTP error, reported failures, or a row that did not move.
    if (!res.ok || bodyReportsFailure(res.body) || next === current) {
      // The body explains why (e.g. targeted found:0 means wrong input status).
      deps.log(`stopped at ${step}; response body:\n${JSON.stringify(res.body, null, 2)}`);
      return { completed: false, finalStatus: next };
    }
    // Advance the baseline for the next step's comparison.
    current = next;
  }
  // The only place the human-review hint is earned.
  if (current === 'awaiting_approval' || current === 'audit_flagged') deps.log('open /approvals to review');
  // Every step moved the row.
  return { completed: true, finalStatus: current };
}

// Reads a required env var, failing loudly at startup.
function required(name: string): string {
  // Read at call time so the error names the variable.
  const value = process.env[name];
  // Blank and absent are the same mistake.
  if (!value) throw new Error(`${name} is not set.`);
  // Non-empty by the check above.
  return value;
}

// Minimal view of the SDK calls used here, typed locally like assist.ts does.
interface ClientLike {
  auth: {
    signInWithPassword: (c: { email: string; password: string }) => Promise<{
      error: { message: string } | null;
      data: { session: { access_token: string } | null };
    }>;
  };
  from: (t: string) => {
    select: (c: string) => {
      eq: (c: string, v: string) => {
        maybeSingle: () => Promise<{ data: { status: string } | null; error: { message: string } | null }>;
      };
    };
  };
}

// Impure wiring, same sign-in pattern as assist.ts.
async function main(): Promise<void> {
  // First, so a usage error costs nothing.
  const id = parseId(process.argv.slice(2));
  // Project endpoint.
  const url = required('SUPABASE_URL');
  // Public key; authority comes from the user JWT below.
  const anonKey = required('SUPABASE_ANON_KEY');
  // The ordinary Auth user the functions authorize.
  const email = required('APPLYY_APP_USER_EMAIL');
  // Never logged.
  const password = required('APPLYY_APP_USER_PASSWORD');
  // Dynamic import through a variable, as assist.ts does, to avoid unifying SDK types with ours.
  const specifier = '@supabase/supabase-js';
  // Narrowed to the few calls used here.
  const sdk = (await import(specifier)) as { createClient: (u: string, k: string, o?: unknown) => ClientLike };
  // ANON key + user JWT; RLS applies, no service role.
  const client = sdk.createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
  // Yields a normal authenticated JWT.
  const auth = await client.auth.signInWithPassword({ email, password });
  // Never continue unauthenticated.
  if (auth.error || !auth.data.session) throw new Error(`sign-in failed: ${auth.error?.message ?? 'no session returned'}`);
  // Sent as Bearer: the functions check the caller is the app user.
  const token = auth.data.session.access_token;
  // Run the pure flow with real effects.
  const result = await runPipeline({
    callFunction: async (step) => {
      // The functions authorize the APP USER's JWT, so it goes in Authorization.
      const res = await fetch(`${url}/functions/v1/${step}?application_id=${id}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, apikey: anonKey },
      });
      // Text first: an error page must not crash the JSON parse and hide the body.
      const text = await res.text();
      // Raw text is the fallback body.
      let body: unknown = text;
      try {
        // Normal case: a JSON object.
        body = JSON.parse(text);
      } catch {
        // Keep the raw text; printing it is the point.
      }
      // Reduced to what the decision needs.
      return { ok: res.ok, body };
    },
    readStatus: async () => {
      // RLS scopes this to the signed-in user.
      const { data, error } = await client.from('applications').select('status').eq('id', id).maybeSingle();
      // A failed read must stop the run rather than look like "unchanged".
      if (error) throw new Error(`status read failed: ${error.message}`);
      // Null when the row is missing or invisible.
      return data?.status ?? null;
    },
    log: (line) => console.log(`[run-one] ${line}`),
  });
  // Last line, easy to grep.
  console.log(`[run-one] final status: ${result.finalStatus}`);
  // Non-zero so a wrapper can tell the pipeline stopped early.
  if (!result.completed) process.exitCode = 1;
}

// Only when run directly, so tests can import the pure parts without side effects.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    // Printed in full: developer-facing tool.
    console.error('[run-one] failed:', error);
    // Non-zero exit; no status was written by this process.
    process.exitCode = 1;
  });
}
