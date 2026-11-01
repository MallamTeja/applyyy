// keepalive: the Postgres ping must leave an agent_runs row, so the Health page can see it ran.
//
// WHY THIS FILE EXISTS (2026-11-01). The keepalive skipped its agent_runs row, citing an
// `agent_name` enum with no `keepalive` value. Migration 20260910185900 added that value long ago,
// so the reason was stale and the Health page said "keepalive has never run" while it ran.
import { describe, expect, it } from 'vitest';
import { pingAndRecordRun } from '../src/cli/keepalive.ts';
import type { SupabaseLike } from '../src/supabase-gateway.ts';

/** A client that records every agent_runs write and answers the settings read as scripted. */
function fakeClient(settingsError: { message: string } | null = null) {
  // Every insert, with its table, so the test can name the agent the row was opened for.
  const inserts: Array<{ table: string; payload: Record<string, unknown> }> = [];
  // Every update, with the row id it was filtered on, so open and close can be tied together.
  const updates: Array<{ table: string; payload: Record<string, unknown>; id: unknown }> = [];
  // Only the pieces keepalive touches; the rest of SupabaseLike is never reached here.
  const client = {
    // Not called by the keepalive; present so the type is satisfied without a cast per method.
    rpc: async () => ({ data: null, error: null }),
    from: (table: string) => ({
      // The keepalive's real query: system_settings, one row.
      select: () => ({
        // Mirrors supabase-js: a database error is a VALUE, never a throw.
        limit: async () => (settingsError ? { data: null, error: settingsError } : { data: [{ system_enabled: true }], error: null }),
      }),
      // openRun's chain: insert(...).select().single() returns the new row.
      insert: (payload: Record<string, unknown>) => {
        // Recorded at call time, so a missing open is visible even if nothing awaits it.
        inserts.push({ table, payload });
        // The id closeRun must then filter on.
        return { select: () => ({ single: async () => ({ data: { id: 'run-k' }, error: null }) }) };
      },
      // closeRun's chain: update(...).eq('id', runId).
      update: (payload: Record<string, unknown>) => ({
        eq: async (_column: string, id: unknown) => {
          // Kept with its id, so "closed the row it opened" is an assertion.
          updates.push({ table, payload, id });
          // A successful write.
          return { data: null, error: null };
        },
      }),
    }),
    // Unused by keepalive; typed stubs only.
    storage: { from: () => ({ upload: async () => ({ data: null, error: null }) }) },
    // Unused: pingAndRecordRun receives an already signed-in client.
    auth: {
      signInWithPassword: async () => ({ data: { session: null }, error: null }),
      getSession: async () => ({ data: { session: null }, error: null }),
    },
  } as SupabaseLike;
  // The client plus both write logs.
  return { client, inserts, updates };
}

describe('keepalive agent_runs row', () => {
  it('records a keepalive agent_runs row: opened running, closed succeeded', async () => {
    // The healthy run: settings read works, so the row must open under `keepalive` and close succeeded.
    const { client, inserts, updates } = fakeClient();

    // Returns how many settings rows the ping read, for the log line.
    await expect(pingAndRecordRun(client, 'u1')).resolves.toBe(1);

    // Its OWN identity, never a borrowed one: that is the whole reason the enum value exists.
    expect(inserts).toEqual([{ table: 'agent_runs', payload: { agent: 'keepalive' } }]);
    // Exactly one close, on the row just opened, as a success.
    expect(updates).toHaveLength(1);
    expect(updates[0]?.table).toBe('agent_runs');
    expect(updates[0]?.id).toBe('run-k');
    expect(updates[0]?.payload).toMatchObject({ status: 'succeeded', error_count: 0 });
    // A real timestamp: the Health page computes the age from it.
    expect(Number.isNaN(Date.parse(String(updates[0]?.payload['finished_at'])))).toBe(false);
  });

  it('a failed keepalive query closes the row failed and still throws', async () => {
    // A failed ping must show as "runs, fails" with its reason, not as a success and not as silence.
    const { client, updates } = fakeClient({ message: 'relation "system_settings" does not exist' });

    // Still rejects, so the CLI exits non-zero and the Actions run goes red.
    await expect(pingAndRecordRun(client, 'u1')).rejects.toThrow(/keepalive query failed/);
    // One close, failed, carrying the database's own words.
    expect(updates).toHaveLength(1);
    expect(updates[0]?.payload).toMatchObject({ status: 'failed', error_count: 1 });
    expect(String(updates[0]?.payload['error_detail'])).toMatch(/system_settings/);
  });
});
