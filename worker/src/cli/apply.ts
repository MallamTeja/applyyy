// Entry point for `pnpm --filter '@applyy/worker' run apply`, invoked by
// .github/workflows/apply.yml.
//
// This is the COMPOSITION ROOT: the only place that reads environment
// variables, constructs real clients and launches a real browser. Everything it
// wires together is pure and injected, which is why the whole loop is testable
// without a network, a database or Chromium.
import { chromium } from 'playwright';
// The APPLY_ONLY_ID parser lives beside the loop that consumes it, so it is testable
// without importing this file (which runs main() on import).
// parseMaxSubmits too, so the cap is announced (and a bad one refused) before sign-in.
import { parseMaxSubmits, parseOnlyApplicationId, runApplierBatch } from '../claim-loop.ts';
import { createSupabaseGateway, type SupabaseLike } from '../supabase-gateway.ts';
// The production robots.txt check (master-robots under the applier's own token).
import { createRobotsCheck } from '../apply-one.ts';
// The constant is read at startup so an operator opt-in this build cannot honour
// is announced, not discovered row by row.
import { createPlaywrightPage, SUBMISSION_IMPLEMENTED } from '../playwright-page.ts';
// The resume renderer, which owns a page of its own — see resume-renderer.ts for
// why it must never be handed one of the form pages.
import { createResumeRenderer } from '../resume-renderer.ts';
import { resolveSubmissionMode } from '../submission-mode.ts';
// The machine-agent proof header, the same builder the edge functions use (relative path,
// as this worker already imports other _shared modules, so no install or lockfile write).
import { AGENT_KEY_ENV_VAR, agentKeyHeaders } from '../../../supabase/functions/_shared/db/agent-key.ts';

/** Read a required environment variable or fail loudly at startup. */
function required(name: string): string {
  const value = process.env[name];
  // Fail at the top of the run rather than half way through. An empty secret is
  // the realistic case — `${{ secrets.MISSING }}` expands to an empty string
  // rather than erroring — so absence and emptiness are treated identically.
  if (!value) {
    throw new Error(
      `${name} is not set. The applier needs it; see .github/workflows/apply.yml. ` +
        'Secrets are configured in the repository settings, never committed (constraint #11).',
    );
  }
  return value;
}

async function main(): Promise<void> {
  // ANNOUNCED FIRST, BEFORE ANY WORK. §14's subject is failures that do not
  // announce themselves, and "was this run dry?" is the single most important
  // fact about an applier run. Printing it up front means the answer is in the
  // log even if the run dies later.
  const mode = resolveSubmissionMode(process.env);
  console.log(`[applyy] submission mode: ${mode.submits ? 'LIVE' : 'DRY RUN'} — ${mode.reason}`);
  // DRY_RUN=false on a build that cannot submit: say so up front. applyToOne
  // degrades every row to the dry-run exit, and without this line the log
  // would read "LIVE" while nothing could possibly be sent.
  if (mode.submits && !SUBMISSION_IMPLEMENTED) {
    console.warn(
      '[applyy] DRY_RUN=false was requested, but this worker has no submit implementation. ' +
        'Every application will be filled, screenshotted and released at `approved`; nothing will be sent.',
    );
  }

  // Parsed BEFORE sign-in, so a malformed id stops the run before it can claim anything.
  const onlyApplicationId = parseOnlyApplicationId(process.env['APPLY_ONLY_ID']);
  // Announced next to the mode, because "which rows can this run touch" is the
  // second most important fact about it.
  console.log(`[applyy] scope: ${onlyApplicationId === undefined ? 'whole approved queue' : `ONLY application ${onlyApplicationId}`}`);
  // The third fact about a run: how many real attempts it may make. Parsed here as well as in
  // the loop so a bad value stops the run before sign-in, with the reason in the first lines.
  console.log(`[applyy] submit cap: ${parseMaxSubmits(process.env['APPLY_MAX_SUBMITS'])} attempts per run (APPLY_MAX_SUBMITS)`);

  // HEADED=1 shows the browser window. Exact string, like DRY_RUN, so no
  // truthiness rule widens it. For runs on Teja's machine, where a visible
  // browser lets him watch the submit; CI never sets it.
  const headed = process.env['HEADED'] === '1';

  // THE AGENT KEY, required since applyy_internal.agent_key was seeded
  // (2026-10-09). Without it every applier call (claim, advance, release) is
  // refused with 42501, so the run could do nothing but fail on its first claim.
  // Checked here, before sign-in, so the log says WHICH secret is missing
  // instead of surfacing a database refusal from deep inside the loop. Nothing
  // has been claimed yet, so no row can be stranded by this stop.
  required(AGENT_KEY_ENV_VAR);
  const supabaseUrl = required('SUPABASE_URL');
  const anonKey = required('SUPABASE_ANON_KEY');
  const email = required('APPLYY_APP_USER_EMAIL');
  const password = required('APPLYY_APP_USER_PASSWORD');

  // THE ONLY LOAD OF THE SUPABASE SDK IN THE APPLIER, still a dynamic import
  // through a variable specifier. The original reason (the package was declared
  // but not installed) no longer holds — worker/package.json declares
  // @supabase/supabase-js and scout.ts imports it statically. It stays dynamic
  // because a static import does NOT typecheck against SupabaseLike: the SDK's
  // `rpc()` returns a PostgrestFilterBuilder, a thenable rather than a Promise
  // (tsc TS2322, checked 2026-10-04). Converting means a double cast or
  // widening SupabaseLike to PromiseLike — a decision for whoever owns the port.
  const specifier = '@supabase/supabase-js';
  const sdk = (await import(specifier)) as {
    createClient: (url: string, key: string, options?: unknown) => SupabaseLike;
  };

  // The ANON key, never a service-role key. The anon key carries no privilege
  // on its own; all authority comes from the signed-in user's JWT below, so
  // every query runs under exactly the same RLS policies as the dashboard.
  const client = sdk.createClient(supabaseUrl, anonKey, {
    // The applier advances status as 'applier', which the database refuses without the agent
    // key once its hash is seeded (20261008160000). From the APPLYY_AGENT_KEY Actions secret;
    // unset means no header, which is today's behaviour.
    global: { headers: agentKeyHeaders(process.env[AGENT_KEY_ENV_VAR]) },
    auth: {
      // A CI runner has no browser storage and the process is thrown away after
      // the run, so persisting a session would write a credential to disk for
      // no benefit — constraint #11 territory.
      persistSession: false,
      autoRefreshToken: false,
    },
  });

  // Sign in as an ordinary Auth user. `signInWithPassword` yields a normal
  // `authenticated` JWT, so `auth.uid()` resolves and the claim RPCs work
  // unmodified.
  const authResult = await client.auth.signInWithPassword({ email, password });
  if (authResult.error || !authResult.data.session) {
    // Deliberately does not echo the error verbatim into a public log beyond
    // its message; and deliberately fatal, because continuing unauthenticated
    // is the one outcome that must never happen.
    throw new Error(`worker sign-in failed: ${authResult.error?.message ?? 'no session returned'}`);
  }

  // The user id scopes storage paths and the settings read. Taken from the
  // session rather than configured, so it cannot disagree with the JWT.
  const session = authResult.data.session as { expires_at?: number; user?: { id?: string } };
  const userId = session.user?.id ?? '';

  const gateway = createSupabaseGateway(client, { userId, email, password });
  // Prime the cached expiry before the first run-window check, so the very
  // first application is gated on a real number rather than on zero.
  await gateway.refreshSession();

  // One browser for the whole batch. Launching per application would add ~475ms
  // each and, far worse, tempt someone to split the loop into parallel jobs.
  // Headless unless HEADED=1 asked otherwise (see above).
  const browser = await chromium.launch({ headless: !headed });

  // Built from the browser rather than from a page, so the resume render can
  // never land on the page holding an employer's half-filled form. Lazy inside:
  // a run that renders nothing opens no page at all.
  const resumeRenderer = createResumeRenderer(browser);

  try {
    const summary = await runApplierBatch({
      gateway,
      openPage: async () => createPlaywrightPage(await browser.newPage()),
      // The wiring this whole change exists to add. Passing the bound method
      // rather than the object keeps the loop's dependency a single function,
      // so it cannot reach the renderer's page lifecycle.
      renderResume: resumeRenderer.render,
      // The robots gate's ONLY production wiring: one check (and one cache) per run, so a
      // batch on one board fetches its robots.txt once.
      checkRobots: createRobotsCheck(),
      env: process.env,
      clock: () => Math.floor(Date.now() / 1000),
      // The validated filter, or undefined for the whole queue.
      onlyApplicationId,
    });

    // One structured line, because the health page reads the database but a
    // human reading the Actions log needs the same facts without a query.
    console.log(
      `[applyy] run ${summary.runId}: claimed=${summary.claimed} submitted=${summary.submitted} ` +
        `blocked=${summary.blocked} dryRun=${summary.dryRun} unknown=${summary.outcomeUnknown} ` +
        `errors=${summary.errors} — ${summary.stoppedReason}`,
    );

    // A row whose outcome we could not determine is the one case that needs a
    // human, so it is called out separately rather than buried in the tally.
    if (summary.outcomeUnknown > 0) {
      console.warn(
        `[applyy] ${summary.outcomeUnknown} application(s) have an UNKNOWN submit outcome. ` +
          'They are left at `applying` for the sweeper to route to `needs_verification`. ' +
          'Check manually whether they went out — never resubmit blind (constraint #7).',
      );
    }
  } finally {
    // Closed before the browser, so the page is released by its owner rather
    // than being torn down underneath it. Both are unconditional: a leaked
    // browser keeps the Actions job alive and billing until its timeout,
    // against a budget billed in whole minutes.
    await resumeRenderer.close();
    await browser.close();
  }
}

// Top-level failure must set a non-zero exit code, or a broken run shows as a
// green tick in the Actions UI — a silent death of exactly the kind §14 is about.
main().catch((error: unknown) => {
  console.error('[applyy] applier run failed:', error);
  process.exitCode = 1;
});
