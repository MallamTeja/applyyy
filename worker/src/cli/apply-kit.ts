// CLI: build manual apply kits (worker/src/apply-kit.ts).
//
//   node src/cli/apply-kit.ts --id <application-uuid>   ONE application (or APPLY_KIT_ID=<uuid>)
//   node src/cli/apply-kit.ts                            SWEEP: every row waiting on Teja whose
//                                                        kit is missing or older than its last
//                                                        status change (worker/src/apply-kit-sweep.ts)
//
// The sweep is how kits are made normally: .github/workflows/apply-kit.yml runs it after
// every applier run and daily, so nobody dispatches a kit by hand (Teja, 2026-10-24).
//
// Opens the application's live form, plans every field from our data, renders a fresh
// resume with the latest master's identity, and appends ONE application_events note.
// It never claims, moves, fills or submits: Greenhouse's captcha refuses CI SUBMITS, but
// loading a form is fine, which is all this does.
import { chromium } from 'playwright';
// The robots gate under the applier's token: the kit loads the same page the applier would.
import { createRobotsCheck } from '../apply-one.ts';
// The kit itself, and its gateway over the supabase client.
import { buildApplyKit, createKitGateway, type ApplyKitDetail } from '../apply-kit.ts';
// The sweep: which rows are due, and the loop that builds them one by one.
import { createSweepReader, parseKitTarget, runKitSweep } from '../apply-kit-sweep.ts';
// The production page adapter; the kit receives only its read-only operations.
import { createPlaywrightPage } from '../playwright-page.ts';
// The renderer apply-one uses, so the kit's PDF is the bot's PDF.
import { createResumeRenderer } from '../resume-renderer.ts';
// The client shape the gateway accepts.
import type { SupabaseLike } from '../supabase-gateway.ts';
// The agent-key header: the note insert is admitted for agent 'applier' only with it.
import { AGENT_KEY_ENV_VAR, agentKeyHeaders } from '../../../supabase/functions/_shared/db/agent-key.ts';

/** A required environment variable, or a loud failure naming where it comes from. */
function required(name: string): string {
  // Read once.
  const value = process.env[name];
  // Missing or blank is a configuration error, never a default.
  if (!value) throw new Error(`${name} is not set. See .github/workflows/apply-kit.yml; secrets are never committed (constraint #11).`);
  return value;
}

/** The application id from `--id <uuid>` or APPLY_KIT_ID, validated by shape; undefined means sweep. */
function readApplicationId(argv: readonly string[]): string | undefined {
  // The flag wins over the variable, so a local run can override an exported one.
  const flagIndex = argv.indexOf('--id');
  // The value after the flag, or the environment's (the workflow passes '' when no id is given).
  const raw = flagIndex >= 0 ? argv[flagIndex + 1] : process.env['APPLY_KIT_ID'];
  // Blank selects the sweep, junk is refused (tested in apply-kit-sweep.test.ts).
  return parseKitTarget(raw);
}

/** The sweep's per-run cap from APPLY_KIT_SWEEP_CAP, default 5; anything but a positive integer is refused. */
function readSweepCap(): number {
  // Unset means the default: five page loads and renders fit well inside the job timeout.
  const raw = process.env['APPLY_KIT_SWEEP_CAP'];
  if (raw === undefined || raw === '') return 5;
  // Digits only, so "5abc" or "-1" cannot become a number by a lenient parse (§6).
  if (!/^[1-9]\d*$/.test(raw)) throw new Error(`APPLY_KIT_SWEEP_CAP must be a positive integer; got ${JSON.stringify(raw)}`);
  return Number(raw);
}

/** Logs one built kit WITHOUT its values (see the comment at the call site). */
function logKit(applicationId: string, kit: ApplyKitDetail, perField: boolean): void {
  // The one-line summary: counts only.
  console.log(`[apply-kit] ${applicationId}: ${kit.fields.length} fields, resume ${kit.resume === null ? 'none' : 'rendered'}; full kit in the application's apply_kit note`);
  // Every field by its question, for a single-row run where someone is reading the log.
  if (perField) {
    for (const field of kit.fields) {
      // The form's own label and our source only; never the value.
      console.log(`[apply-kit]   ${field.required ? '*' : ' '} ${field.label}: ${field.value === null ? '(you answer)' : 'filled'} [${field.source}]`);
    }
  }
  // Every warning; identity-drift warnings name the fact, not its values.
  for (const warning of kit.warnings) {
    // "identity.email: the row's ... has "<old>", the latest master has "<new>"" becomes its key alone.
    const safe = warning.startsWith('identity.') ? `${warning.split(':')[0]}: differs between the row's tailored_profile and the latest master (values in the note)` : warning;
    // Refusal warnings carry only the form's question text, which is safe to print.
    console.warn(`[apply-kit] WARNING ${applicationId}: ${safe}`);
  }
}

/** Sign in as the app user, build one kit (or sweep), print counts only, and close the browser either way. */
async function main(): Promise<void> {
  // Validated before any sign-in, so a typo costs nothing; undefined selects the sweep.
  const applicationId = readApplicationId(process.argv.slice(2));
  // Read up front too, so a bad cap fails before a browser starts.
  const sweepCap = applicationId === undefined ? readSweepCap() : 0;
  // Required up front: without it the note insert fails closed with 42501.
  required(AGENT_KEY_ENV_VAR);
  // Connection and the ordinary app-user account, exactly as the applier signs in (RLS applies).
  const supabaseUrl = required('SUPABASE_URL');
  // Public by design; authority comes from the signed-in user's JWT.
  const anonKey = required('SUPABASE_ANON_KEY');
  // The ordinary app user, never a service-role key, so RLS bounds every read and write.
  const email = required('APPLYY_APP_USER_EMAIL');
  // Same account as the email.
  const password = required('APPLYY_APP_USER_PASSWORD');

  // Indirected like apply.ts, so the worker's type check does not need the SDK's types.
  const specifier = '@supabase/supabase-js';
  // Loaded at run time; typed only as the minimal client the gateway accepts.
  const sdk = (await import(specifier)) as { createClient: (url: string, key: string, options?: unknown) => SupabaseLike };
  // The agent-key header on every request; no stored session.
  const client = sdk.createClient(supabaseUrl, anonKey, {
    // The key that admits the note insert as agent 'applier'.
    global: { headers: agentKeyHeaders(process.env[AGENT_KEY_ENV_VAR]) },
    // A one-shot CLI: nothing to persist, nothing to refresh.
    auth: { persistSession: false, autoRefreshToken: false },
  });
  // One sign-in: a kit takes seconds, well inside one token.
  const auth = await client.auth.signInWithPassword({ email, password });
  // supabase-js returns errors; it does not throw them.
  if (auth.error || !auth.data.session) throw new Error(`worker sign-in failed: ${auth.error?.message ?? 'no session returned'}`);
  // The signed-in user's id: storage paths and the note's user_id are scoped by it.
  const userId = (auth.data.session as { user?: { id?: string } }).user?.id ?? '';

  // Headless unless HEADED=1, as the applier.
  const browser = await chromium.launch({ headless: process.env['HEADED'] !== '1' });
  // The renderer owns its own page, never the form's.
  const renderer = createResumeRenderer(browser);
  // Closed in `finally`, whatever the kit does.
  // One gateway for every kit in this run: reads and the two allowed writes, no status method.
  const gateway = createKitGateway(client, { userId });
  // Builds ONE kit on its own fresh page, which is closed afterwards so a sweep does not pile pages up.
  const buildOne = async (id: string): Promise<ApplyKitDetail> => {
    // A fresh tab per row: one form's state never leaks into the next.
    const tab = await browser.newPage();
    try {
      // The kit: reads, one resume upload, one note.
      return await buildApplyKit({
        // The one row; buildApplyKit re-checks its status before touching anything.
        applicationId: id,
        gateway,
        // Narrowed by the kit's type to goto, extractFields and detectBlocker.
        page: createPlaywrightPage(tab),
        // The applier's renderer, so the PDF matches a bot run's.
        renderResume: renderer.render,
        // The applier's robots token, so the kit loads only what the applier may.
        checkRobots: createRobotsCheck(),
        // The Actions run id when run there, so the note links back to its log.
        runId: process.env['GITHUB_RUN_ID'] ?? null,
        // The real clock for generated_at.
        now: () => new Date(),
      });
    } finally {
      // Closed whatever happened, so a failed row does not hold a tab open.
      await tab.close();
    }
  };
  // NO VALUES IN THE LOG, in either mode. Field values are Teja's contact details and answers,
  // and an Actions log is kept for 90 days and readable by every collaborator. The full kit,
  // values included, is the RLS-protected application_events note; the log says only what
  // was planned, so a run can be checked without exposing any of it.
  try {
    if (applicationId !== undefined) {
      // ONE row: a failure throws to the catch below and the run goes red.
      logKit(applicationId, await buildOne(applicationId), true);
    } else {
      // THE SWEEP: every due row, capped, one failure never stopping the rest.
      const summary = await runKitSweep({
        // The two reads, over the same signed-in client (RLS applies).
        ...createSweepReader(client),
        // Each kit's counts reach the log; its values never do.
        buildOne: async (id) => logKit(id, await buildOne(id), false),
        cap: sweepCap,
        log: (line) => console.log(line),
      });
      // The totals as one line, so the run page shows the outcome at a glance.
      console.log(`[apply-kit sweep] done: eligible ${summary.eligible}, attempted ${summary.attempted}, built ${summary.built}, failed ${summary.failed.length}`);
      // A failed row turns the run red so it is seen, after every other row has had its turn.
      if (summary.failed.length > 0) process.exitCode = 1;
    }
  } finally {
    // Both closed, so a failed kit does not keep Chromium (and the Actions job) alive.
    await renderer.close();
    await browser.close();
  }
}

main().catch((error: unknown) => {
  // Logged with the reason, and non-zero so the dispatch shows red.
  console.error('[apply-kit] failed:', error);
  process.exitCode = 1;
});
