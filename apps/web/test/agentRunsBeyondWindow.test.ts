/* Code-review finding #4 (2026-11-01): Health said "no success ever" for an agent whose newest
 * run failed while it had succeeded within cadence.
 *
 * WHY: the beyond-window lookup (W9, af3c7f0) fetched each missed agent's newest run only, and
 * `summarizeAgentRuns` derives the last success from the rows in hand. A failed newest run left
 * no success in hand, so the page said "running dry / never once succeeded" - missing data
 * turned into an answer (CLAUDE.md section 6). The same holds for an agent IN the window whose
 * success lies beyond it, so the success lookup covers every agent with no success in hand.
 *
 * HOW: drives the exported `readNewestBeyondWindow` with a fake client shaped like supabase-js.
 * The fake returns `{ data, error }` and never throws on a failed read, because supabase-js
 * does not (CLAUDE.md section 5: a test double must behave like the real dependency). */

// The .ts/.tsx loader first, so the dynamic imports below resolve as Vite would.
import './support/registerTsxHooks.ts';
// Strict asserts, so a loose equality cannot pass a wrong verdict.
import assert from 'node:assert/strict';
// One describe, a before() for the imports, one it() per behaviour.
import { describe, it, before } from 'node:test';

// The helper under test, loaded after the hooks are registered.
let runs: typeof import('../src/data/useAgentRuns.ts');
// The pure summariser, to prove the lookup's rows give the right verdict end to end.
let fresh: typeof import('../src/data/agentFreshness.ts');

// A fixed "now", so every age below is exact arithmetic.
const NOW = Date.parse('2026-11-01T12:00:00.000Z');
// One hour in ms, for readable offsets.
const HOUR = 3_600_000;

// One agent_runs row as the read returns it; status and age are the facts under test.
function row(agent: string, status: string, hoursAgo: number) {
  // Started hoursAgo before NOW.
  const started = NOW - hoursAgo * HOUR;
  // Every selected column, at clean values except the two under test.
  return {
    // Which agent ran.
    agent,
    // The outcome under test.
    status,
    // When it opened.
    started_at: new Date(started).toISOString(),
    // Closed one minute later, so no row reads as stuck.
    finished_at: new Date(started + 60_000).toISOString(),
    // Clean counters; not under test.
    error_count: 0,
    // Same.
    error_detail: null,
    // Same.
    rows_in: 0,
  };
}

// What the fake answers for one read: the PostgREST filters it was sent, and the rows or an error.
type Answer = { data: unknown; error: { message: string } | null };

/* A fake supabase client: records every read's filters and answers via `answer`.
 * Every builder method returns the builder, and the builder is thenable, like PostgrestFilterBuilder. */
function fakeClient(answer: (filters: Record<string, string>) => Answer) {
  // Every read's filters, so a test can prove which lookups were made.
  const reads: Record<string, string>[] = [];
  // The client: only `.from()` is reached by the helper.
  const client = {
    // A fresh builder per read, so filters never leak between parallel reads.
    from: () => {
      // This read's eq() filters, keyed by column.
      const filters: Record<string, string> = {};
      // Recorded now; filled in by eq() before the read resolves.
      reads.push(filters);
      // The chainable builder.
      const builder = {
        // Column list is not under test.
        select: () => builder,
        // The filters are what decide the answer.
        eq: (column: string, value: string) => {
          // Stored as given, e.g. agent -> 'screener'.
          filters[column] = value;
          // Chainable.
          return builder;
        },
        // Order is not under test; the fake answers newest-first itself.
        order: () => builder,
        // Same for the limit.
        limit: () => builder,
        // Awaiting the builder runs the read, asynchronously like the real one.
        then: (resolve: (value: Answer) => unknown, reject: (reason: unknown) => unknown) =>
          Promise.resolve().then(() => answer(filters)).then(resolve, reject),
      };
      // Handed back for chaining.
      return builder;
    },
  };
  // Cast once: the helper only reaches the methods faked above.
  return { client: client as unknown as Parameters<typeof runs.readNewestBeyondWindow>[0], reads };
}

describe('Health finds an agent\'s newest success beyond the window (finding #4)', () => {
  before(async () => {
    // Loaded after the hooks so extensionless imports inside resolve.
    runs = await import('../src/data/useAgentRuns.ts');
    // Same.
    fresh = await import('../src/data/agentFreshness.ts');
  });

  it('an out-of-window agent whose newest run FAILED but which succeeded within cadence reads succeeding, not "never succeeded"', async () => {
    // Screener: newest run failed 2 h ago, last success 6 h ago (screener cadence allows 36 h).
    const { client } = fakeClient((f) =>
      f['agent'] !== 'screener'
        ? { data: [], error: null }
        : f['status'] === 'succeeded'
          ? { data: [row('screener', 'succeeded', 6)], error: null }
          : { data: [row('screener', 'failed', 2)], error: null },
    );
    // An empty window: every roster agent is out of it.
    const beyond = await runs.readNewestBeyondWindow(client, []);
    // Summarised the way the hook does it.
    const screener = fresh.summarizeAgentRuns(beyond.rows, NOW, beyond.failed).find((e) => e.agent === 'screener');
    // The success 6 h ago is in hand, so its age is known (ages run from finished_at, one minute after start).
    assert.equal(screener?.successAgeMs, 6 * HOUR - 60_000, 'the last success must be found by its own lookup');
    // So the verdict is the healthy one, not running_dry.
    assert.equal(screener?.verdict, 'succeeding');
    // Non-vacuity: the heartbeat is still the newer failed run.
    assert.equal(screener?.heartbeatAgeMs, 2 * HOUR - 60_000);
  });

  it('an IN-window agent with no success in the window gets its success looked up; an agent with one in hand does not', async () => {
    // Window: screener failed 1 h ago (no success in window); tracker succeeded 1 h ago.
    const windowRows = [row('screener', 'failed', 1), row('tracker', 'succeeded', 1)];
    // Screener's success lies beyond the window, 5 h ago.
    const { client, reads } = fakeClient((f) =>
      f['agent'] === 'screener' && f['status'] === 'succeeded' ? { data: [row('screener', 'succeeded', 5)], error: null } : { data: [], error: null },
    );
    // The lookups for what the window missed.
    const beyond = await runs.readNewestBeyondWindow(client, windowRows);
    // Summarised over window plus lookups, as the hook does.
    const summary = fresh.summarizeAgentRuns([...windowRows, ...beyond.rows], NOW, beyond.failed);
    // The beyond-window success is found.
    assert.equal(summary.find((e) => e.agent === 'screener')?.verdict, 'succeeding');
    // Tracker's success is already in hand: no success lookup for it (and no newest lookup either).
    assert.equal(reads.some((f) => f['agent'] === 'tracker'), false, 'tracker is fully answered by the window');
  });

  it('a FAILED success lookup is lookup_failed, never "has never once succeeded"', async () => {
    // Window: screener failed 1 h ago; its success lookup returns an error, as supabase-js does.
    const windowRows = [row('screener', 'failed', 1)];
    // Every success lookup fails; every newest lookup answers empty.
    const { client } = fakeClient((f) =>
      f['status'] === 'succeeded' ? { data: null, error: { message: 'boom' } } : { data: [], error: null },
    );
    // The lookups.
    const beyond = await runs.readNewestBeyondWindow(client, windowRows);
    // The failure is recorded against the agent.
    assert.ok(beyond.failed.has('screener'), 'a failed success lookup must mark the agent');
    // Summarised as the hook does.
    const screener = fresh.summarizeAgentRuns([...windowRows, ...beyond.rows], NOW, beyond.failed).find((e) => e.agent === 'screener');
    // Unknown, not "never succeeded".
    assert.equal(screener?.verdict, 'lookup_failed');
    // And the sentence must not claim it never succeeded.
    assert.doesNotMatch(fresh.describeVerdict(screener!), /never/);
  });

  it('an out-of-window agent whose success lookup fails keeps NO partial rows, so its newest run cannot pose as the whole story', async () => {
    // Screener newest (failed) answers; its success lookup errors.
    const { client } = fakeClient((f) =>
      f['agent'] !== 'screener'
        ? { data: [], error: null }
        : f['status'] === 'succeeded'
          ? { data: null, error: { message: 'boom' } }
          : { data: [row('screener', 'failed', 2)], error: null },
    );
    // The lookups.
    const beyond = await runs.readNewestBeyondWindow(client, []);
    // The verdict is unknown.
    assert.equal(fresh.summarizeAgentRuns(beyond.rows, NOW, beyond.failed).find((e) => e.agent === 'screener')?.verdict, 'lookup_failed');
    // Non-vacuity: an agent whose two lookups answered [] still reads never_run.
    assert.equal(fresh.summarizeAgentRuns(beyond.rows, NOW, beyond.failed).find((e) => e.agent === 'matcher')?.verdict, 'never_run');
  });

  it('when the newest run IS the success, it is added once, not twice', async () => {
    // Screener's newest run and newest success are the same row.
    const { client } = fakeClient((f) => (f['agent'] === 'screener' ? { data: [row('screener', 'succeeded', 3)], error: null } : { data: [], error: null }));
    // The lookups.
    const beyond = await runs.readNewestBeyondWindow(client, []);
    // One screener row, so nothing downstream double-counts it.
    assert.equal(beyond.rows.filter((r) => r.agent === 'screener').length, 1);
  });
});
