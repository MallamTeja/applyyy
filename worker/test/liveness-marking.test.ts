// The scheduled (worker) scout marks disappeared postings too (2026-11-05).
//
// WHY: only the edge scout-ats marked jobs.disappeared_at, and it runs only on a Scan-button pass.
// The scout on cron is this worker (scout.yml -> cli/scout.ts), which re-sighted rows but never
// marked the absent ones, so 7,592 stale rows piled up (GitLab 267, Databricks 364) and closed
// postings reached Teja's approval queue (GitLab 267dcfcd, approved, closed since September).
// The worker now calls the SAME planner as scout-ats (_shared/scout/liveness.ts) and writes the
// same way. These tests use GitLab's live shape (SELECTed 2026-11-05 13:3x IST).
import { describe, expect, it } from 'vitest';
// Type only; the fake below stands in for it.
import type { SupabaseClient } from '@supabase/supabase-js';
// The module under test.
import { applyBoardLiveness, readLivenessSnapshot } from '../src/scout/liveness-marking.ts';

// The previous poll, as company_watchlist recorded it.
const PREV_AT = '2026-11-05T06:56:24.653Z';
// This poll's clock.
const NOW = new Date('2026-11-05T18:56:24.653Z');
// A September sighting: past the 14-day stale bar.
const SEPTEMBER = '2026-09-12T14:36:59.282Z';
// Eleven days before the previous poll: absent, but too recent to mark from outside the basis.
const OCT_25 = '2026-10-25T06:56:24.653Z';

// One stored row as the snapshot select returns it.
function row(id: string, lastSeenAt: string, disappearedAt: string | null = null, repostCount = 0) {
  // The five columns readLivenessSnapshot selects.
  return { id, fingerprint: `fp-${id}`, last_seen_at: lastSeenAt, disappeared_at: disappearedAt, repost_count: repostCount };
}

// GitLab today: 238 seen at the previous poll, 182 last seen in September, 85 seen 11 days ago.
const GITLAB = [
  // The live board.
  ...Array.from({ length: 238 }, (_, i) => row(`live-${i}`, PREV_AT)),
  // The dead backlog.
  ...Array.from({ length: 182 }, (_, i) => row(`sept-${i}`, SEPTEMBER)),
  // Recently missing: left alone this poll.
  ...Array.from({ length: 85 }, (_, i) => row(`oct-${i}`, OCT_25)),
];

/** A supabase-js-shaped fake: every builder method chains and records; awaiting resolves `result`. */
function fakeDb(selectRows: object[] | null, selectError: string | null = null) {
  // Every terminal operation, with the method calls that built it.
  const ops: Array<{ kind: 'select' | 'update'; values?: unknown; calls: Array<[string, unknown[]]> }> = [];
  // One chain per from(): records calls; `then` makes it awaitable like a PostgREST builder.
  function chain(op: (typeof ops)[number], result: unknown): unknown {
    // A proxy, so any filter method (eq, in, is, contains) chains without listing them all.
    return new Proxy({}, {
      get(_target, name) {
        // Awaiting the builder resolves the canned result.
        if (name === 'then') return (resolve: (v: unknown) => unknown) => resolve(result);
        // Any other method: record it and keep chaining.
        return (...args: unknown[]) => {
          // The call, in order.
          op.calls.push([String(name), args]);
          // Same builder.
          return chain(op, result);
        };
      },
    });
  }
  // The client: from(table).select(...) or from(table).update(values).
  const db = {
    from: (table: string) => ({
      // The snapshot read.
      select: (columns: string) => {
        // Recorded with its columns.
        const op = { kind: 'select' as const, calls: [['from', [table]], ['select', [columns]]] as Array<[string, unknown[]]> };
        // Stored for assertions.
        ops.push(op);
        // The canned rows or error.
        return chain(op, selectError === null ? { data: selectRows, error: null } : { data: null, error: { message: selectError } });
      },
      // A mark or a reappearance clear.
      update: (values: unknown) => {
        // Recorded with its payload.
        const op = { kind: 'update' as const, values, calls: [['from', [table]]] as Array<[string, unknown[]]> };
        // Stored for assertions.
        ops.push(op);
        // Writes succeed.
        return chain(op, { data: null, error: null });
      },
    }),
  } as unknown as SupabaseClient;
  // Both, for the test.
  return { db, ops };
}

// The board as the CLI holds it in memory (its PREVIOUS poll's time and count).
const BOARD = { ats_provider: 'greenhouse', company_slug: 'gitlab', last_polled_at: PREV_AT, last_poll_job_count: 242 } as const;

describe('readLivenessSnapshot', () => {
  it('reads this board only (owner, provider, slug, this adapter) and splits live from disappeared', async () => {
    // One live, one disappeared.
    const { db, ops } = fakeDb([row('a', PREV_AT), row('b', SEPTEMBER, '2026-10-01T00:00:00Z', 2)]);
    // The read.
    const snap = await readLivenessSnapshot(db, 'user-1', BOARD, 'greenhouse');
    // Scoped exactly like scout-ats's snapshot.
    expect(ops[0]!.calls.slice(2)).toEqual([['eq', ['user_id', 'user-1']], ['eq', ['ats_provider', 'greenhouse']], ['eq', ['company_slug', 'gitlab']], ['contains', ['discovered_via', ['greenhouse']]]]);
    // Split, with lastSeenAt carried for the recent basis.
    expect(snap).toEqual({ ok: true, storedLive: [{ id: 'a', fingerprint: 'fp-a', lastSeenAt: PREV_AT }], storedDisappeared: [{ id: 'b', fingerprint: 'fp-b', repost_count: 2 }] });
  });

  it('an unreadable snapshot is reported, never read as an empty board', async () => {
    // The read fails.
    const { db } = fakeDb(null, 'timeout');
    // Not ok, with the reason.
    expect(await readLivenessSnapshot(db, 'user-1', BOARD, 'greenhouse')).toEqual({ ok: false, message: 'timeout' });
  });
});

describe('applyBoardLiveness', () => {
  it('GitLab, healthy poll: marks the 182 September rows, not the 85 recent misses nor any live row', async () => {
    // The snapshot as read.
    const { db: readDb } = fakeDb(GITLAB);
    // Read through the real function.
    const snap = await readLivenessSnapshot(readDb, 'user-1', BOARD, 'greenhouse');
    // Narrowed for the call.
    if (!snap.ok) throw new Error('snapshot');
    // A separate fake records the writes.
    const { db, ops } = fakeDb([]);
    // The poll lists the 238 live postings.
    const result = await applyBoardLiveness(db, 'user-1', snap, GITLAB.slice(0, 238).map((r) => r.fingerprint), BOARD, NOW);
    // 182 marked, none refused.
    expect(result).toEqual({ marked: 182, reappeared: 0, refused: null });
    // One write, the scout-ats shape: this poll's time, owner-scoped, only still-live rows.
    expect(ops).toHaveLength(1);
    // The payload.
    expect(ops[0]!.values).toEqual({ disappeared_at: NOW.toISOString() });
    // The filters, ids included.
    expect(ops[0]!.calls.slice(1)).toEqual([['eq', ['user_id', 'user-1']], ['in', ['id', GITLAB.slice(238, 420).map((r) => r.id)]], ['is', ['disappeared_at', null]]]);
  });

  it('a truncated poll writes nothing and says why', async () => {
    // The live board's snapshot.
    const { db: readDb } = fakeDb(GITLAB);
    // Read.
    const snap = await readLivenessSnapshot(readDb, 'user-1', BOARD, 'greenhouse');
    // Narrowed.
    if (!snap.ok) throw new Error('snapshot');
    // The write recorder.
    const { db, ops } = fakeDb([]);
    // Only 50 of the 238 listed.
    const result = await applyBoardLiveness(db, 'user-1', snap, GITLAB.slice(0, 50).map((r) => r.fingerprint), BOARD, NOW);
    // Refused by the planner.
    expect(result.refused).toBe('identity_drift');
    // No mark written.
    expect(ops.filter((op) => (op.values as { disappeared_at?: unknown } | undefined)?.disappeared_at !== undefined && (op.values as { disappeared_at: unknown }).disappeared_at !== null)).toEqual([]);
  });

  it('a disappeared posting listed again is cleared and its repost counted', async () => {
    // Live rows plus one marked earlier.
    const rows = [...GITLAB.slice(0, 238), row('back', SEPTEMBER, '2026-10-01T00:00:00Z', 1)];
    // Read.
    const { db: readDb } = fakeDb(rows);
    // Through the real reader.
    const snap = await readLivenessSnapshot(readDb, 'user-1', BOARD, 'greenhouse');
    // Narrowed.
    if (!snap.ok) throw new Error('snapshot');
    // The write recorder.
    const { db, ops } = fakeDb([]);
    // The poll lists the 238 plus the returning one.
    const result = await applyBoardLiveness(db, 'user-1', snap, [...GITLAB.slice(0, 238).map((r) => r.fingerprint), 'fp-back'], BOARD, NOW);
    // One reappearance.
    expect(result.reappeared).toBe(1);
    // Cleared and counted, owner- and id-scoped, as scout-ats writes it.
    expect(ops.at(-1)).toMatchObject({ values: { disappeared_at: null, repost_count: 2 }, calls: [['from', ['jobs']], ['eq', ['user_id', 'user-1']], ['eq', ['id', 'back']]] });
  });
});
