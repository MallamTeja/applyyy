// Tests for the scout's job persistence: the "cannot affect row a second time" fix.
import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { dedupeByFingerprint, persistJobBatch, watchlistPollUpdate, type PreparedJob } from '../src/scout/persist-jobs.ts';

// Builds a posting; only the fields the module reads are real.
function job(fingerprint: string, atsJobId: string, postedAt = '2026-10-01T00:00:00Z'): PreparedJob {
  // Cast: the full JobInsert has many columns irrelevant here.
  const row = { fingerprint, ats_job_id: atsJobId, posted_at: postedAt, first_seen_at: 'NOW' } as never;
  // Rebuild mimics toJobInsert, which always emits first_seen_at.
  return { row, rebuild: async (d: Date) => ({ ...(row as object), first_seen_at: d.toISOString() }) as never };
}

// A recording fake: stored rows in, upsert payloads out, optional forced failure.
function fakeDb(stored: object[], failUpsert = false) {
  const upserts: { rows: Record<string, unknown>[]; opts: { ignoreDuplicates: boolean } }[] = [];
  const db = {
    from: () => ({
      // Lookup path: .select().in() resolves to the stored rows.
      select: () => ({ in: async () => ({ data: stored, error: null }) }),
      // Write path: awaitable AND chainable with .select().
      upsert: (rows: Record<string, unknown>[], opts: { ignoreDuplicates: boolean }) => {
        upserts.push({ rows, opts });
        const result = failUpsert
          ? { data: null, error: { message: 'boom' } }
          : { data: rows.map((r, i) => ({ id: `id-${i}`, fingerprint: r.fingerprint })), error: null };
        return { select: async () => result, then: (f: (v: unknown) => unknown) => f(result) };
      },
    }),
  } as unknown as SupabaseClient;
  return { db, upserts };
}

describe('dedupeByFingerprint', () => {
  it('keeps one posting per fingerprint, latest posted_at then lowest id, and counts collisions', () => {
    // Three postings, one fingerprint; the middle one is newest.
    const { kept, collisions } = dedupeByFingerprint([
      job('f1', 'b', '2026-10-01T00:00:00Z'),
      job('f1', 'c', '2026-10-02T00:00:00Z'),
      job('f1', 'a', '2026-10-02T00:00:00Z'),
    ]);
    // Newest date ties between c and a; the lowest id wins.
    expect(kept.map((k) => k.row.ats_job_id)).toEqual(['a']);
    // Two losers means two collisions.
    expect(collisions).toBe(2);
  });
});

describe('persistJobBatch', () => {
  it('writes one row for a same-fingerprint pair (after dedupe)', async () => {
    const { db, upserts } = fakeDb([]);
    // The caller's order of operations: dedupe, then persist.
    const { kept } = dedupeByFingerprint([job('f1', 'a'), job('f1', 'b')]);
    await persistJobBatch(db, kept, new Date());
    // One statement, one row: no duplicate conflict key can reach Postgres.
    expect(upserts).toHaveLength(1);
    expect(upserts[0]!.rows).toHaveLength(1);
  });

  it('refreshes an existing fingerprint without first_seen_at and bumps seen_count', async () => {
    const { db, upserts } = fakeDb([{ id: 'j1', fingerprint: 'f1', first_seen_at: '2026-09-01T00:00:00.000Z', seen_count: 4 }]);
    await persistJobBatch(db, [job('f1', 'a')], new Date('2026-10-05T00:00:00Z'));
    // Exactly one write: the refresh; nothing is new.
    expect(upserts).toHaveLength(1);
    const payload = upserts[0]!.rows[0]!;
    // The history column must never be in the DO UPDATE payload.
    expect('first_seen_at' in payload).toBe(false);
    // Incremented from the stored value.
    expect(payload.seen_count).toBe(5);
    // Refresh path overwrites, new path ignores duplicates.
    expect(upserts[0]!.opts.ignoreDuplicates).toBe(false);
  });

  it('surfaces a failed write as an error', async () => {
    const { db } = fakeDb([], true);
    const r = await persistJobBatch(db, [job('f1', 'a')], new Date());
    // The caller needs this to refuse the healthy mark.
    expect(r.errors[0]).toContain('boom');
  });
});

describe('watchlistPollUpdate', () => {
  const board = { poll_count: 2, first_polled_at: '2026-09-01T00:00:00Z', consecutive_failures: 1 };
  it('does not mark a board with failed job writes healthy', () => {
    const u = watchlistPollUpdate(board, ['insert jobs: boom'], 10, new Date());
    // Failure count goes up by one.
    expect(u.consecutive_failures).toBe(2);
    // No success-only field is written.
    expect('poll_count' in u).toBe(false);
    expect('last_poll_job_count' in u).toBe(false);
  });
  it('resets failures on a clean poll', () => {
    expect(watchlistPollUpdate(board, [], 10, new Date()).consecutive_failures).toBe(0);
  });
});
