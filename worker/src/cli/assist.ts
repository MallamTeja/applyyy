// Entry point for `pnpm --filter @applyy/worker run assist -- --id <application uuid>`.
//
// ASSISTED SUBMIT: opens ONE approved application's real form in a VISIBLE Chromium
// window, fills it, and stops. The human reviews, clicks Submit himself, and answers a
// y/n prompt so the status is recorded honestly. This process never submits.
//
// Like apply.ts this is a COMPOSITION ROOT: env vars, real clients, real browser and
// stdin live here and nowhere else; the decisions are in ../assist/assisted-submit.ts.
// Node's own readline, because one y/n question needs no prompt library.
import { createInterface } from 'node:readline';
// The only place a browser is launched; the core never sees Playwright.
import { chromium } from 'playwright';
// Adapts a Playwright Page to the worker's page port.
import { createPlaywrightPage } from '../playwright-page.ts';
// Owns the separate page that renders the resume PDF.
import { createResumeRenderer } from '../resume-renderer.ts';
// Type only: the SDK itself is loaded dynamically below.
import type { SupabaseLike } from '../supabase-gateway.ts';
// The pure flow; this file is just the wiring around it.
import { runAssisted } from '../assist/assisted-submit.ts';
// The real database port for the flow.
import { createSupabaseAssistGateway } from '../assist/supabase-assist-gateway.ts';
// The machine-agent proof header, the same builder the edge functions use.
import { AGENT_KEY_ENV_VAR, agentKeyHeaders } from '../../../supabase/functions/_shared/db/agent-key.ts';

/** Read a required environment variable or fail loudly at startup. */
// Plain function: several call sites share it and nothing else needs the logic.
function required(name: string): string {
  // Read at call time so a missing variable names itself in the error.
  const value = process.env[name];
  // Empty and absent are the same failure; a blank secret is the realistic mistake.
  // Same message shape as cli/apply.ts, so both entry points read alike in a terminal.
  if (!value) {
    // Names the variable first, then where it belongs and the rule that keeps it out of git.
    throw new Error(
      `${name} is not set. The assist CLI needs it; set it in your local shell before running assist. ` +
        'Secrets are configured in the repository settings, never committed (constraint #11).',
    );
  }
  // Non-empty by the check above, so callers need no further guarding.
  return value;
}

/** `--id <uuid>`, validated by SHAPE. There is deliberately no "pick any" mode. */
// Takes argv as a parameter rather than reading process.argv, to stay testable.
function parseId(argv: readonly string[]): string {
  // Position of the flag; -1 means it was not passed at all.
  const index = argv.indexOf('--id');
  // The token after the flag, if the flag exists and has one.
  const value = index === -1 ? undefined : argv[index + 1];
  // A UUID shape check: a typo must not reach the database as a query.
  if (!value || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    // Thrown so main() fails before any network call or browser launch.
    throw new Error('usage: assist --id <application uuid>  (the id is required)');
  }
  // Validated by the regex above, so safe to hand to the database.
  return value;
}

/** One line from stdin, or null on EOF / Ctrl-C. Null never counts as an answer. */
// Returns null for 'no answer' so the core cannot confuse EOF with an empty line.
function askStdin(question: string): Promise<string | null> {
  // A hand-built promise, because readline has no single event covering line AND EOF.
  return new Promise((resolve) => {
    // Created per question so a closed stdin cannot poison a later one.
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    // Each end-of-input route resolves null so the flow leaves the row blocked.
    rl.once('close', () => resolve(null));
    // Ctrl-C closes the interface, which resolves null through the close event.
    rl.once('SIGINT', () => rl.close());
    // The prompt text the human actually sees.
    rl.question(question, (line) => {
      // Resolved before close(), so a real answer wins the race with the close event.
      resolve(line);
      // Closed so the process is not held open by stdin.
      rl.close();
    });
  });
}

// Everything impure happens in here, once, in a fixed order.
async function main(): Promise<void> {
  // First, so a usage error costs no network call and no browser.
  const applicationId = parseId(process.argv.slice(2));
  // THE AGENT KEY, required since applyy_internal.agent_key was seeded (2026-10-09), exactly
  // as cli/apply.ts requires it. Without it the database refuses every 'applier' call
  // (claim, advance, release) with 42501. Checked here, before sign-in and before a browser
  // opens, so the error names the missing variable instead of a refusal from deep inside the
  // flow. Nothing has been claimed yet, so this stop cannot strand a row.
  required(AGENT_KEY_ENV_VAR);
  // The project endpoint.
  const supabaseUrl = required('SUPABASE_URL');
  // Public key; real authority comes from the user's JWT below.
  const anonKey = required('SUPABASE_ANON_KEY');
  // The ordinary Auth user the worker signs in as.
  const email = required('APPLYY_APP_USER_EMAIL');
  // Never logged or echoed.
  const password = required('APPLYY_APP_USER_PASSWORD');

  // Dynamic import through a variable, exactly as apply.ts does and for the same
  // documented typing reason (the SDK's rpc() is a thenable, not a Promise).
  // A variable so TypeScript does not try to unify the SDK's types with ours.
  const specifier = '@supabase/supabase-js';
  // Cast to the one function this file calls, typed against the worker's own port.
  const sdk = (await import(specifier)) as {
    // The SDK's constructor, narrowed to the shape SupabaseLike expects back.
    createClient: (url: string, key: string, options?: unknown) => SupabaseLike;
  };
  // ANON key + the signed-in user's JWT, never a service-role key: RLS applies as usual.
  const client = sdk.createClient(supabaseUrl, anonKey, {
    // Assist parks the row as 'applier' (approved -> applying -> blocked_needs_human), which
    // needs the agent key once its hash is seeded (20261008160000). Read from the local
    // APPLYY_AGENT_KEY env, which main() has already required above, so the header is present.
    global: { headers: agentKeyHeaders(process.env[AGENT_KEY_ENV_VAR]) },
    // No session file on disk: this is a credential, and the process is short-lived.
    auth: { persistSession: false, autoRefreshToken: false },
  });
  // Yields a normal `authenticated` JWT, so RLS and auth.uid() work unmodified.
  const auth = await client.auth.signInWithPassword({ email, password });
  // Continuing unauthenticated is the one outcome that must never happen.
  if (auth.error || !auth.data.session) {
    // Thrown rather than logged: nothing below may run unauthenticated.
    throw new Error(`sign-in failed: ${auth.error?.message ?? 'no session returned'}`);
  }
  // Taken from the session so it cannot disagree with the JWT.
  const userId = (auth.data.session as { user?: { id?: string } }).user?.id ?? '';
  // Built after sign-in so every call runs as the user.
  const gateway = createSupabaseAssistGateway(client, { userId, email, password });
  // Primes the cached expiry the gateway consults.
  await gateway.refreshSession();

  // Same kill switch the scheduled applier honours; "off" means off for humans too.
  // Fail closed: a missing or false setting reads as off.
  if (!(await gateway.isSystemEnabled())) {
    // Stops before a browser opens, so a disabled system costs nothing.
    throw new Error('system_enabled is false for this user; refusing to run.');
  }

  // VISIBLE window: the human has to see and operate the form.
  // headless:false is the whole point; do not change it.
  const browser = await chromium.launch({ headless: false });
  // Render page is separate from the form page so the resume render can never land on
  // the employer's half-filled form.
  // Lazy: opens its page only when a resume is actually rendered.
  const renderer = createResumeRenderer(browser);
  // try/finally so the browser closes on every path, but only after runAssisted returns.
  try {
    // A fresh window for the employer's form.
    const page = createPlaywrightPage(await browser.newPage());
    // Resolves only after the human has answered (or stdin closed).
    const outcome = await runAssisted({
      // The row chosen on the command line.
      applicationId,
      // The database port.
      gateway,
      // The visible-browser page.
      page,
      // The bound method only, so the flow cannot reach the renderer's page.
      renderResume: renderer.render,
      // The real stdin prompt.
      askHuman: askStdin,
      // Plain console output, since the human is at this terminal.
      log: (line) => console.log(line),
    });
    // Machine-readable last line, useful when the output is pasted into a log.
    console.log(`[assist] result: ${JSON.stringify(outcome)}`);
    // Anything but a recorded answer or a deliberate "unsure" is a failure exit.
    if (outcome.kind !== 'recorded' && outcome.kind !== 'left_blocked') process.exitCode = 1;
  } finally {
    // The two closes below run on every path, including a thrown error.
    // Closed only after runAssisted returns, i.e. after the human has answered.
    // Closes the render page before the browser that owns it.
    await renderer.close();
    // Last, so the window stays up for as long as the human needs it.
    await browser.close();
  }
}

// A crash must exit non-zero, and must write no status: the row stays where it was.
main().catch((error: unknown) => {
  // Printed in full: this is a developer-facing tool, not a CI log.
  console.error('[assist] failed:', error);
  // Non-zero so a wrapper script can tell the run did not complete.
  process.exitCode = 1;
});
