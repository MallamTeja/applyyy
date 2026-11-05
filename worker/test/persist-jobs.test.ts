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

// The Workday detail read (2026-11-05, P1-3): persistJobBatch fills a NEW title-passing Workday
// row before inserting it, and never reads a re-sighted one (that would re-fetch every Workday
// posting on every run). The fill's own rules are unit-tested in workday-detail.test.ts; this
// pins WHERE the worker calls it.
describe('persistJobBatch: Workday detail read', () => {
  // A Workday posting with the apply-link shape workdayDetailUrl accepts, saved without text.
  function workdayJob(fingerprint: string, slug: string): PreparedJob {
    // Only the fields the fill and the persist read; the cast stands in for the full JobInsert.
    const row = {
      fingerprint, ats_job_id: slug, posted_at: '2026-11-01T00:00:00Z', first_seen_at: 'NOW',
      ats_provider: 'workday', title: 'Software Engineer', description_raw: null,
      apply_url: `https://mastercard.wd1.myworkdayjobs.com/CorporateCareers/job/Pune-India/SDE_${slug}`,
    } as never;
    // Same rebuild contract as job() above.
    return { row, rebuild: async (d: Date) => ({ ...(row as object), first_seen_at: d.toISOString() }) as never };
  }

  // A run whose GET answers every detail URL with a real description and records what it read.
  async function recordingRun() {
    // The run factory, from the same module the worker uses.
    const { newWorkdayDetailRun } = await import('../../supabase/functions/_shared/scout/workday-detail.ts');
    // Every URL the fill asked for.
    const reads: string[] = [];
    // The run: every title passes, a deadline that never runs out, and no real sleep.
    const run = newWorkdayDetailRun({
      // Answers with the detail endpoint's envelope.
      get: async (url: string) => {
        // Recorded so the test can say which postings were read.
        reads.push(url);
        // The one field parseWorkdayDescription reads.
        return new Response(JSON.stringify({ jobPostingInfo: { jobDescription: '<p>Build services in Go.</p>' } }));
      },
      // Title gate out of scope here.
      passesTitleGate: () => true,
      // Always plenty of time left.
      deadline: { remainingMs: () => 60_000 } as never,
      // Tests never sleep.
      pause: async () => {},
    }, 40);
    // Both, so a test can assert on the reads and the counters.
    return { run, reads };
  }

  it('fills a new Workday row before it is inserted', async () => {
    // Nothing stored: the row is new.
    const { db, upserts } = fakeDb([]);
    // A run that records its reads.
    const { run, reads } = await recordingRun();
    // One new Workday posting.
    await persistJobBatch(db, [workdayJob('wf1', 'R-1')], new Date(), run);
    // Read once.
    expect(reads).toHaveLength(1);
    // And the INSERTED payload carries the text, so jobs.description_raw is not stored blank.
    expect(upserts[0]!.rows[0]!.description_raw).toBe('Build services in Go.');
    // Counted for the run summary.
    expect(run.filled).toBe(1);
  });

  it('never reads a re-sighted Workday row', async () => {
    // wf1 is already stored; wf2 is new.
    const { db } = fakeDb([{ id: 'id-1', fingerprint: 'wf1', first_seen_at: '2026-10-01T00:00:00Z', seen_count: 3 }]);
    // A run that records its reads.
    const { run, reads } = await recordingRun();
    // One known posting, one new one.
    await persistJobBatch(db, [workdayJob('wf1', 'R-1'), workdayJob('wf2', 'R-2')], new Date(), run);
    // Only the new posting was read.
    expect(reads).toEqual(['https://mastercard.wd1.myworkdayjobs.com/wday/cxs/mastercard/CorporateCareers/job/Pune-India/SDE_R-2']);
  });

  it('reads nothing without a run (unscreened scout, or a caller that passes none)', async () => {
    // Nothing stored.
    const { db, upserts } = fakeDb([]);
    // No run argument at all.
    await persistJobBatch(db, [workdayJob('wf1', 'R-1')], new Date());
    // The row is inserted with no text. The upsert planner's blanking guard omits a null
    // description_raw key (upsert-plan.ts), so "absent" and "null" are both "no text" here.
    expect(upserts[0]!.rows[0]!.description_raw ?? null).toBeNull();
  });
});
