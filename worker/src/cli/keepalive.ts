// Entry point for `pnpm --filter '@applyy/worker' run keepalive`, invoked by
// .github/workflows/keepalive.yml.
//
// THE TWO SILENT DEATHS (PROJECT_PLAN.md §14). Neither produces an error;
// both just stop, and the system looks healthy while nothing goes out:
//
//   1. Supabase pauses a free project after ONE WEEK idle. A real query against
//      a real table counts as activity.
//   2. GitHub disables scheduled workflows after 60 DAYS of repository
//      inactivity. That one needs repo activity, not a database query, so it is
//      handled by the workflow's final step — which pushes a commit and is
//      therefore GATED ON TEJA'S EXPLICIT APPROVAL, not on this script.
//
// This script owns death 1 only. It deliberately does NOT touch git: a worker
// process that could commit would be a standing violation of Teja's never-push
// rule waiting for an accident.
//
// WHY A QUERY AND NOT A PING: a request that merely reaches Supabase's API
// gateway does not count as database activity. The pause timer watches
// Postgres, so the keepalive must actually reach Postgres — which is exactly
// the kind of distinction that produces a keepalive that runs happily every day
// while the project pauses anyway.
import type { SupabaseLike } from '../supabase-gateway.js';

/** Read a required environment variable or fail loudly at startup. */
function required(name: string): string {
  const value = process.env[name];
  // An unset secret expands to an empty string in Actions rather than erroring,
  // so emptiness and absence are treated identically.
  if (!value) {
    throw new Error(`${name} is not set; see .github/workflows/keepalive.yml.`);
  }
  return value;
}

async function main(): Promise<void> {
  const supabaseUrl = required('SUPABASE_URL');
  const anonKey = required('SUPABASE_ANON_KEY');
  const email = required('APPLYY_WORKER_EMAIL');
  const password = required('APPLYY_WORKER_PASSWORD');

  // Same late-binding composition-root import as the applier; see the comment
  // in cli/apply.ts for why the specifier is indirected.
  const specifier = '@supabase/supabase-js';
  const sdk = (await import(specifier)) as {
    createClient: (url: string, key: string, options?: unknown) => SupabaseLike;
  };

  const client = sdk.createClient(supabaseUrl, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // Signing in is itself a database round trip, but it is not enough on its
  // own: auth lives in its own schema and we want the pause timer to see the
  // application tables being read.
  const authResult = await client.auth.signInWithPassword({ email, password });
  if (authResult.error || !authResult.data.session) {
    throw new Error(`keepalive sign-in failed: ${authResult.error?.message ?? 'no session'}`);
  }

  // THE ACTUAL KEEPALIVE. `system_settings` is the right table to touch: it has
  // exactly one row per user, so the query is trivially cheap, and it is the
  // table every agent reads first — if RLS or the schema ever broke such that
  // this read fails, the whole system is already dead and the keepalive should
  // be the thing that says so.
  const result = await client.from('system_settings').select('system_enabled').limit(1);
  if (result.error) {
    throw new Error(`keepalive query failed: ${result.error.message}`);
  }

  // Reported so a human reading the Actions log sees a positive statement
  // rather than an empty successful run — "it printed nothing" and "it did
  // nothing" look identical otherwise, which is the §14 failure shape again.
  console.log(
    `[applyy] keepalive: Postgres reached, ${
      Array.isArray(result.data) ? result.data.length : 0
    } settings row(s) read at ${new Date().toISOString()}. ` +
      'Supabase idle-pause timer reset (death 1 of 2).',
  );

  // NOT WRITTEN, AND DELIBERATELY SO: an `agent_runs` row for this keepalive.
  // The `agent_name` enum has no `keepalive` member — its values are the nine
  // pipeline agents plus `sweeper` and `human` — so recording one would mean
  // borrowing another agent's identity, which would corrupt the very health
  // page this is supposed to feed ("the applier ran today" when it did not).
  // Adding the enum value belongs to the schema stream; raised rather than
  // worked around, because a wrong row is worse than a missing one here.
  console.log(
    '[applyy] keepalive: no agent_runs row written — `agent_name` has no `keepalive` ' +
      'value yet. Health-page visibility for this job is pending that enum addition.',
  );
}

// Non-zero exit on failure, or a dead keepalive shows as a green tick — which
// would make the monitor for the silent deaths itself die silently.
main().catch((error: unknown) => {
  console.error('[applyy] keepalive failed:', error);
  process.exitCode = 1;
});
