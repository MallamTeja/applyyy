// Scout-Remote CLI Runner — `pnpm --filter '@applyy/worker' run scout:remote [-- --dry-run]`
//
// Discovers remote jobs from open web feeds (RemoteOK, Jobicy, Arbeitnow) and queues
// them through the same safety and screening path as the ATS scout. Runs daily on
// .github/workflows/scout-remote.yml.
//
// This file is only the shell: env, sign-in, the real HTTP fetch and the exit code. The
// run itself is worker/src/scout/remote-run.ts and the feed parsing is
// worker/src/scout/remote-feeds.ts, both tested; this file runs main() on import and
// therefore cannot be.

// The client the run writes through, signed in as the app user so RLS applies.
import { createClient } from '@supabase/supabase-js';
// The testable run.
import { runRemoteScout } from '../scout/remote-run.ts';
// The agent-key header the database checks (T12, 2026-11-10): the duplicate sweep advances rows as scout_aggregator.
import { AGENT_KEY_ENV_VAR, agentKeyHeaders } from '../../../supabase/functions/_shared/db/agent-key.ts';

// A required env var, or a clear error naming it.
function required(name: string): string {
  // Read once.
  const value = process.env[name];
  // An empty secret is an unset secret in Actions.
  if (!value) throw new Error(`${name} is not set. Required for Scout-Remote runner.`);
  // Present.
  return value;
}

// GETs one feed's JSON. THROWS on a non-2xx, so the run names the feed as failed instead of
// parsing an error page as "no jobs" (§6: a soft failure must not become an answer).
async function fetchJson(url: string): Promise<unknown> {
  // An identifying User-Agent, as before; RemoteOK's robots.txt allows / with a 1 s crawl
  // delay, and this run makes one request per feed per day.
  const res = await fetch(url, { headers: { 'User-Agent': 'applyy-remote-scout/1.0' }, signal: AbortSignal.timeout(60_000) });
  // A non-2xx is a failed feed, by status.
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  // Unparseable JSON throws too, which is the same "failed feed".
  return res.json();
}

// The run: env, sign-in, then the shared run function.
async function main(): Promise<void> {
  // The rehearsal flag: --dry-run on the command line or SCOUT_DRY_RUN=true from the workflow.
  const dryRun = process.argv.includes('--dry-run') || process.env.SCOUT_DRY_RUN === 'true';
  // The kill-switch override, read the same two ways as scout.ts.
  const force = process.argv.includes('--force') || process.env.SCOUT_FORCE === 'true';
  // The project and the app user's credentials.
  const client = createClient(required('SUPABASE_URL'), required('SUPABASE_ANON_KEY'), {
    // The duplicate sweep (T12, 2026-11-10) advances aggregator copies as scout_aggregator, which the database refuses
    // without the agent key (fail-closed since 20261102210000). From the APPLYY_AGENT_KEY Actions secret, the same form as
    // cli/apply.ts; unset means no header, so the forward inserts still work and only the sweep is refused (and reported).
    global: { headers: agentKeyHeaders(process.env[AGENT_KEY_ENV_VAR]) },
    // A runner has no browser storage and is thrown away after the run: never persist or refresh a session.
    auth: { persistSession: false, autoRefreshToken: false },
  });
  // Sign in, so every read and write is the app user's under RLS.
  const auth = await client.auth.signInWithPassword({ email: required('APPLYY_APP_USER_EMAIL'), password: required('APPLYY_APP_USER_PASSWORD') });
  // No session: nothing can be read or written honestly.
  if (auth.error || !auth.data.user) throw new Error(`sign-in failed: ${auth.error?.message ?? 'no user'}`);
  // Said up front, so a log reader knows which kind of run this was.
  console.log(`[applyy-scout-remote] ${dryRun ? 'DRY RUN (no writes)' : 'live run'}${force ? ', kill switch overridden' : ''}`);
  // The run itself.
  const result = await runRemoteScout({ client, fetchJson, now: new Date(), dryRun, force, log: (line) => console.log(`[applyy-scout-remote] ${line}`) });
  // A failed run turns the Actions tick red; the run row alone is only seen by someone already looking.
  if (result.status === 'failed') process.exitCode = 1;
}

// A crash leaves the agent_runs row 'running', the documented signature of a death
// (20260909234800_supporting_tables.sql), and exits non-zero.
main().catch((err) => {
  // The reason, for the Actions log.
  console.error('[applyy-scout-remote] fatal error:', err);
  // Red tick.
  process.exitCode = 1;
});
