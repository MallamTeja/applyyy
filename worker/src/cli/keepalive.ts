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
//      handled by the workflow's final step, which pushes a timestamp commit to a
//      dedicated branch. Teja approved that push on 2026-11-01 17:24 IST.
//
// This script owns death 1 only. It deliberately does NOT touch git: the push
// lives in its own workflow step with the contents:write token, and this step
// holds the app-user password. Keeping them apart means neither credential ever
// sits in the same process as the other.
//
// WHY A QUERY AND NOT A PING: a request that merely reaches Supabase's API
// gateway does not count as database activity. The pause timer watches
// Postgres, so the keepalive must actually reach Postgres — which is exactly
// the kind of distinction that produces a keepalive that runs happily every day
// while the project pauses anyway.
// The same "is this file the entry point" check run-one.ts uses, so a test can import
// pingAndRecordRun without main() reading env and setting a failing exit code.
import { pathToFileURL } from 'node:url';
// The applier's own openRun/closeRun, reused rather than a second agent_runs writer.
import { createSupabaseGateway, type SupabaseLike } from '../supabase-gateway.ts';

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
  const email = required('APPLYY_APP_USER_EMAIL');
  const password = required('APPLYY_APP_USER_PASSWORD');

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

  // Taken from the session, as cli/apply.ts does, so it cannot disagree with the JWT.
  // The run row itself takes user_id from the column default auth.uid().
  const session = authResult.data.session as { user?: { id?: string } };
  // The ping plus its agent_runs row; throws on failure so the exit code below goes red.
  const rows = await pingAndRecordRun(client, session.user?.id ?? '');

  // Reported so a human reading the Actions log sees a positive statement
  // rather than an empty successful run — "it printed nothing" and "it did
  // nothing" look identical otherwise, which is the §14 failure shape again.
  console.log(
    `[applyy] keepalive: Postgres reached, ${rows} settings row(s) read at ${new Date().toISOString()}. ` +
      'Supabase idle-pause timer reset (death 1 of 2); agent_runs row recorded as keepalive.',
  );
}

/**
 * The ping, recorded as a `keepalive` agent_runs row. Exported for the test.
 *
 * THE ROW IS WHAT THE HEALTH PAGE READS (2026-11-01). It used to be skipped,
 * citing an `agent_name` enum with no `keepalive` value; migration 20260910185900
 * added that value, so the skip only made the page say "has never run" about a
 * job that ran. Opened BEFORE the query and closed after it, through the same
 * openRun/closeRun as the applier: a crash leaves a visible `running` row.
 * Returns how many settings rows were read, for the log line.
 */
export async function pingAndRecordRun(client: SupabaseLike, userId: string): Promise<number> {
  // The applier's gateway, used only for its run methods; no new agent_runs writer.
  const gateway = createSupabaseGateway(client, { userId });
  // Its OWN identity. Borrowing another agent's would make the page say that agent ran.
  const run = await gateway.openRun('keepalive');
  try {
    // THE ACTUAL KEEPALIVE. `system_settings` is the right table to touch: it has
    // exactly one row per user, so the query is trivially cheap, and it is the
    // table every agent reads first — if RLS or the schema ever broke such that
    // this read fails, the whole system is already dead and the keepalive should
    // be the thing that says so.
    const result = await client.from('system_settings').select('system_enabled').limit(1);
    // supabase-js returns errors as values; an unchecked one would close the row succeeded.
    if (result.error) {
      throw new Error(`keepalive query failed: ${result.error.message}`);
    }
    // A count for the log; a non-array answer counts 0 rather than throwing.
    const rows = Array.isArray(result.data) ? result.data.length : 0;
    // A success: the heartbeat and the success clock on the Health page both advance.
    await gateway.closeRun(run.id, {
      // The ping reached Postgres.
      status: 'succeeded',
      // The age the page computes.
      finished_at: new Date().toISOString(),
      // Rows read, so a zero-row read (missing settings row) is visible on the row.
      rows_in: rows,
      // Stated, not defaulted, so the row reads the same as the applier's.
      error_count: 0,
    });
    // Handed back for the log line.
    return rows;
  } catch (error) {
    // A FAILED row with the reason, so the page reads "runs, fails" instead of "never ran".
    await gateway.closeRun(run.id, {
      // The outcome the success clock ignores.
      status: 'failed',
      // The scheduler still fired, so the heartbeat still advances.
      finished_at: new Date().toISOString(),
      // One failure: the ping.
      error_count: 1,
      // The thrown message, e.g. "keepalive query failed: ...".
      error_detail: error instanceof Error ? error.message : String(error),
    });
    // Rethrown, so the CLI exits non-zero.
    throw error;
  }
}

// Only when run directly (`node src/cli/keepalive.ts`), so a test import has no side
// effects. If this guard ever failed to match in CI, main() would not run and the
// keepalive row would stop appearing: the Health page's keepalive cadence flags exactly that.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // Non-zero exit on failure, or a dead keepalive shows as a green tick — which
  // would make the monitor for the silent deaths itself die silently.
  main().catch((error: unknown) => {
    // Printed in full so the Actions log carries the cause.
    console.error('[applyy] keepalive failed:', error);
    // Fails the step.
    process.exitCode = 1;
  });
}
