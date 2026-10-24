// CLI: build the manual apply kit for ONE application (worker/src/apply-kit.ts).
//
//   node src/cli/apply-kit.ts --id <application-uuid>
//   (or APPLY_KIT_ID=<uuid>, which .github/workflows/apply-kit.yml sets)
//
// Opens the application's live form, plans every field from our data, renders a fresh
// resume with the latest master's identity, and appends ONE application_events note.
// It never claims, moves, fills or submits: Greenhouse's captcha refuses CI SUBMITS, but
// loading a form is fine, which is all this does.
import { chromium } from 'playwright';
// The UUID shape check the applier uses for APPLY_ONLY_ID, so both refuse the same junk.
import { parseOnlyApplicationId } from '../claim-loop.ts';
// The robots gate under the applier's token: the kit loads the same page the applier would.
import { createRobotsCheck } from '../apply-one.ts';
// The kit itself, and its gateway over the supabase client.
import { buildApplyKit, createKitGateway } from '../apply-kit.ts';
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

/** The application id from `--id <uuid>` or APPLY_KIT_ID, validated by shape. */
function readApplicationId(argv: readonly string[]): string {
  // The flag wins over the variable, so a local run can override an exported one.
  const flagIndex = argv.indexOf('--id');
  // The value after the flag, or the environment's.
  const raw = flagIndex >= 0 ? argv[flagIndex + 1] : process.env['APPLY_KIT_ID'];
  // Shape-checked like APPLY_ONLY_ID; absent is an error here, since a kit is always for one row.
  let id: string | undefined;
  try {
    // The applier's parser, so both refuse the same junk.
    id = parseOnlyApplicationId(raw);
  } catch {
    // Re-thrown under this CLI's own names: the parser's message names APPLY_ONLY_ID.
    throw new Error(`--id / APPLY_KIT_ID must be an application UUID; got ${JSON.stringify(raw)}`);
  }
  // parseOnlyApplicationId returns undefined only for an absent value.
  if (id === undefined) throw new Error('usage: apply-kit --id <application-uuid> (or APPLY_KIT_ID)');
  // Lower-cased by the parser, so it matches the stored uuid exactly.
  return id;
}

/** Sign in as the app user, build one kit, print it, and close the browser either way. */
async function main(): Promise<void> {
  // Validated before any sign-in, so a typo costs nothing.
  const applicationId = readApplicationId(process.argv.slice(2));
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
  try {
    // A fresh page for the form, wrapped in the production adapter.
    const page = createPlaywrightPage(await browser.newPage());
    // The kit: reads, one resume upload, one note.
    const kit = await buildApplyKit({
      // The one row, already shape-checked.
      applicationId,
      // Reads and the two allowed writes; no status method exists on it.
      gateway: createKitGateway(client, { userId }),
      // Narrowed by the kit's type to goto, extractFields and detectBlocker.
      page,
      // The applier's renderer, so the PDF matches a bot run's.
      renderResume: renderer.render,
      // The applier's robots token, so the kit loads only what the applier may.
      checkRobots: createRobotsCheck(),
      // The Actions run id when dispatched there, so the note links back to its log.
      runId: process.env['GITHUB_RUN_ID'] ?? null,
      // The real clock for generated_at.
      now: () => new Date(),
    });
    // NO VALUES IN THE LOG. Field values are Teja's contact details and answers, and an
    // Actions log is kept for 90 days and readable by every collaborator. The full kit,
    // values included, is the RLS-protected application_events note; the log says only
    // what was planned, so a run can be checked without exposing any of it.
    console.log(`[apply-kit] ${applicationId}: ${kit.fields.length} fields, resume ${kit.resume === null ? 'none' : 'rendered'}; full kit in the application's apply_kit note`);
    // Every field by its question: `*` marks required, "(you answer)" what the system refused to guess.
    for (const field of kit.fields) {
      // The form's own label and our source only; never the value.
      console.log(`[apply-kit]   ${field.required ? '*' : ' '} ${field.label}: ${field.value === null ? '(you answer)' : 'filled'} [${field.source}]`);
    }
    // Every warning, last, where the eye lands; identity-drift warnings name the fact, not its values.
    for (const warning of kit.warnings) {
      // "identity.email: the row's ... has "<old>", the latest master has "<new>"" becomes its key alone.
      const safe = warning.startsWith('identity.') ? `${warning.split(':')[0]}: differs between the row's tailored_profile and the latest master (values in the note)` : warning;
      // Refusal warnings carry only the form's question text, which is safe to print.
      console.warn(`[apply-kit] WARNING: ${safe}`);
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
