// Tests for the scout's job persistence: the "cannot affect row a second time" fix.
import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { backfillWorkdayDescriptions, dedupeByFingerprint, dueForPoll, persistJobBatch, watchlistPollUpdate, WORKDAY_BACKFILL_STATUSES, type PreparedJob } from '../src/scout/persist-jobs.ts';

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
      worthReading: () => true,
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

// D3 (2026-11-18): the fill above reads NEW rows only, so a Workday row stored blank stays blank
// forever (8,539 of 9,090 Workday applications had no text on 11-18). Each run now also fills up
// to 20 stored rows, oldest first, but only rows still moving through the pipeline: the 8,495
// blank rows at dropped_filter would spend the reads and change nothing.
describe('backfillWorkdayDescriptions', () => {
  // One recorded builder call: the method name and its arguments.
  type Call = [string, unknown[]];
  // A chainable supabase-js double. Every builder method records itself and returns the builder;
  // awaiting the builder resolves like supabase-js does: { data, error }, never a throw.
  function fakeJobsDb(stored: Record<string, unknown>[], selectError: { message: string } | null = null) {
    // Calls on the SELECT chain.
    const selectCalls: Call[] = [];
    // One entry per UPDATE chain: its payload and its filters.
    const updates: { payload: Record<string, unknown>; calls: Call[] }[] = [];
    // A builder that records into `calls` and resolves to `result`.
    function builder(calls: Call[], result: () => unknown) {
      // The chain object; a Proxy so any filter method the code uses is recorded.
      const chain: unknown = new Proxy({}, {
        get(_t, prop) {
          // Awaiting the chain resolves to the scripted result, as supabase-js does.
          if (prop === 'then') return (resolve: (v: unknown) => unknown) => resolve(result());
          // Any other method: record it and keep chaining.
          return (...args: unknown[]) => { calls.push([String(prop), args]); return chain; };
        },
      });
      // The chain, to be filtered and awaited.
      return chain;
    }
    // The client: only from('jobs') is used.
    const db = {
      from: (table: string) => ({
        // The read: answers with the stored rows, or the scripted error.
        select: (...args: unknown[]) => {
          // Recorded with the table, so the test can see what was read and from where.
          selectCalls.push(['from', [table]], ['select', args]);
          // Rows or error, never both.
          return builder(selectCalls, () => (selectError ? { data: null, error: selectError } : { data: stored, error: null }));
        },
        // The write: records the payload and its filters, answers { error: null }.
        update: (payload: Record<string, unknown>) => {
          // A fresh record per UPDATE statement.
          const entry = { payload, calls: [['from', [table]]] as Call[] };
          // Kept for the assertions.
          updates.push(entry);
          // No error.
          return builder(entry.calls, () => ({ error: null }));
        },
      }),
    } as unknown as SupabaseClient;
    // Everything a test asserts on.
    return { db, selectCalls, updates };
  }

  // A stored blank Workday job, as the SELECT returns it.
  function storedRow(id: string, slug: string): Record<string, unknown> {
    // The columns the backfill selects.
    return {
      id, ats_provider: 'workday', title: 'Software Engineer', description_raw: null, location_raw: 'Pune, India',
      apply_url: `https://fractal.wd1.myworkdayjobs.com/Careers/job/Pune/SDE_${slug}`,
    };
  }

  // A run whose GET answers with `description` (null = a response without text).
  async function runAnswering(description: string | null) {
    // The run factory the worker uses.
    const { newWorkdayDetailRun } = await import('../../supabase/functions/_shared/scout/workday-detail.ts');
    // URLs read, in order.
    const reads: string[] = [];
    // A run with no real sleep and plenty of time.
    const run = newWorkdayDetailRun({
      // The detail endpoint's envelope, with or without text.
      get: async (url: string) => {
        // Recorded for the "what was read" assertions.
        reads.push(url);
        // jobDescription is the one field the parser reads.
        return new Response(JSON.stringify({ jobPostingInfo: { jobDescription: description } }));
      },
      // Stored rows already passed the title gate when they were screened.
      worthReading: () => true,
      // Never runs out.
      deadline: { remainingMs: () => 60_000 } as never,
      // No real sleep.
      pause: async () => {},
    }, 40);
    // Both.
    return { run, reads };
  }

  it('selects only live-pipeline Workday jobs with no text and no tombstone, oldest first, 20 at most', async () => {
    // Nothing stored: only the query shape matters here.
    const { db, selectCalls } = fakeJobsDb([]);
    // A run that would answer.
    const { run } = await runAnswering('<p>x</p>');
    // Run the backfill with its default limit.
    await backfillWorkdayDescriptions(db, run);
    // Every filter that keeps the reads on rows that can still use a description.
    expect(selectCalls).toContainEqual(['from', ['jobs']]);
    expect(selectCalls).toContainEqual(['eq', ['ats_provider', 'workday']]);
    expect(selectCalls).toContainEqual(['is', ['description_raw', null]]);
    expect(selectCalls).toContainEqual(['is', ['tombstoned_at', null]]);
    expect(selectCalls).toContainEqual(['in', ['applications.status', [...WORKDAY_BACKFILL_STATUSES]]]);
    expect(selectCalls).toContainEqual(['order', ['first_seen_at', { ascending: true }]]);
    expect(selectCalls).toContainEqual(['limit', [20]]);
    // dropped_filter is never a backfill target.
    expect(WORKDAY_BACKFILL_STATUSES).not.toContain('dropped_filter');
  });

  it('reads each stored blank row and writes its text, guarded so stored text is never overwritten', async () => {
    // Two stored blank rows.
    const { db, updates } = fakeJobsDb([storedRow('j1', 'R-1'), storedRow('j2', 'R-2')]);
    // Every read returns text.
    const { run, reads } = await runAnswering('<p>Build services in Go.</p>');
    // The backfill.
    const result = await backfillWorkdayDescriptions(db, run);
    // Both rows read through the detail URL.
    expect(reads).toHaveLength(2);
    // Two UPDATEs, one per row.
    expect(updates).toHaveLength(2);
    // Each carries the text...
    expect(updates[0]!.payload.description_raw).toBe('Build services in Go.');
    // ...targets its own row...
    expect(updates[0]!.calls).toContainEqual(['eq', ['id', 'j1']]);
    // ...and only while the row is still blank (a concurrent writer's text wins).
    expect(updates[0]!.calls).toContainEqual(['is', ['description_raw', null]]);
    // Counted.
    expect(result).toEqual({ selected: 2, written: 2, errors: [] });
    // And the run counters show it in the scout's "workday detail" log line.
    expect(run.filled).toBe(2);
  });

  it('a read with no text writes nothing', async () => {
    // One stored blank row.
    const { db, updates } = fakeJobsDb([storedRow('j1', 'R-1')]);
    // The detail answers without a description.
    const { run } = await runAnswering(null);
    // The backfill.
    const result = await backfillWorkdayDescriptions(db, run);
    // No UPDATE: a null description is never written over the null that is there.
    expect(updates).toHaveLength(0);
    // Selected but not written.
    expect(result).toEqual({ selected: 1, written: 0, errors: [] });
  });

  it('a SELECT error is returned, and nothing is read', async () => {
    // supabase-js reports failure as { error }, never a throw (CLAUDE.md §5).
    const { db, updates } = fakeJobsDb([], { message: 'boom' });
    // A run that would answer.
    const { run, reads } = await runAnswering('<p>x</p>');
    // The backfill.
    const result = await backfillWorkdayDescriptions(db, run);
    // The error surfaces for the run log.
    expect(result.errors).toEqual(['select workday backfill rows: boom']);
    // No read, no write.
    expect(reads).toHaveLength(0);
    expect(updates).toHaveLength(0);
  });
});

// D10 (2026-11-18): a board failing >= 5 polls in a row is polled once a day, not every run.
// last_polled_at is stamped on every attempt (failureMark), so "polled in the last 24 h" needs
// no new column. A robots-unavailable skip writes nothing, so it never resets this clock.
describe('dueForPoll', () => {
  // A fixed "now".
  const NOW = new Date('2026-11-18T12:00:00Z');

  it('a healthy or briefly failing board is always due', () => {
    // 4 failures, polled a minute ago: still due.
    expect(dueForPoll({ consecutive_failures: 4, last_polled_at: '2026-11-18T11:59:00Z' }, NOW)).toBe(true);
  });

  it('a board at 5+ failures polled under 24 h ago rests', () => {
    // 23 h ago.
    expect(dueForPoll({ consecutive_failures: 5, last_polled_at: '2026-11-17T13:00:00Z' }, NOW)).toBe(false);
  });

  it('a board at 5+ failures polled 24 h or more ago is due again', () => {
    // Exactly 24 h ago.
    expect(dueForPoll({ consecutive_failures: 27, last_polled_at: '2026-11-17T12:00:00Z' }, NOW)).toBe(true);
  });

  it('a failing board with no readable last poll is due (never rested on missing data)', () => {
    // No stamp at all.
    expect(dueForPoll({ consecutive_failures: 9, last_polled_at: null }, NOW)).toBe(true);
    // A stamp that does not parse.
    expect(dueForPoll({ consecutive_failures: 9, last_polled_at: 'not a date' }, NOW)).toBe(true);
  });
});
