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
// Type-only (erased at runtime, so the hooks-first load order above still holds): the fixture is typed as
// the REAL row, so a status or agent name the schema does not allow is a compile error, not a passing test.
import type { AgentRunRow } from '../src/data/useAgentRuns.ts';
// The closed unions the row's agent and status columns use; narrower than string on purpose.
import type { AgentName, AgentRunStatus } from '../src/data/contract.ts';

// The helper under test, loaded after the hooks are registered.
let runs: typeof import('../src/data/useAgentRuns.ts');
// The pure summariser, to prove the lookup's rows give the right verdict end to end.
let fresh: typeof import('../src/data/agentFreshness.ts');

// A fixed "now", so every age below is exact arithmetic.
const NOW = Date.parse('2026-11-01T12:00:00.000Z');
// One hour in ms, for readable offsets.
const HOUR = 3_600_000;

// One agent_runs row as the read returns it; status and age are the facts under test.
// Typed params + return: a plain string widened agent/status and made the rows unassignable to AgentRunRow.
function row(agent: AgentName, status: AgentRunStatus, hoursAgo: number): AgentRunRow {
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
        /* The one-request read (2026-11-08) filters with in(). Recorded under its own key, so
           these answers (which key on `agent`) give it no count; with no count it cannot prove
           completeness, and these tests keep exercising the per-agent fallback they were written for. */
        in: (column: string, values: readonly string[]) => {
          // Stored joined, e.g. agent.in -> 'scout_ats,screener,...'.
          filters[`${column}.in`] = values.join(',');
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

/* A fake client backed by a whole `agent_runs` table, answering like PostgREST would:
 * eq()/in() filter, order() sorts newest-first, limit() caps the page, and `count` is the
 * EXACT number of matching rows before the cap (what `{ count: 'exact' }` returns).
 * Needed for the one-request read, whose "none" verdict rests on rows === count. */
function tableClient(table: ReturnType<typeof row>[]) {
  // Every read's filters, so a test can count requests and see which agents were read alone.
  const reads: Record<string, string>[] = [];
  // Only `.from()` is reached by the helper.
  const client = {
    // A fresh builder per read, as above.
    from: () => {
      // This read's filters, recorded for the test.
      const filters: Record<string, string> = {};
      // Recorded now; filled by the builder before the read resolves.
      reads.push(filters);
      // Row predicates accumulated by eq()/in().
      const keep: ((r: ReturnType<typeof row>) => boolean)[] = [];
      // The page cap; unlimited until limit() sets it.
      let cap = Infinity;
      // The chainable builder.
      const builder = {
        // Columns are not under test.
        select: () => builder,
        // Equality filter on one column.
        eq: (column: 'agent' | 'status', value: string) => {
          // Recorded for assertions.
          filters[column] = value;
          // Applied to the table.
          keep.push((r) => r[column] === value);
          // Chainable.
          return builder;
        },
        // Membership filter, as `.in('agent', [...])` sends.
        in: (column: 'agent', values: readonly string[]) => {
          // Recorded for assertions.
          filters[`${column}.in`] = values.join(',');
          // Applied to the table.
          keep.push((r) => values.includes(r[column]));
          // Chainable.
          return builder;
        },
        // The helper always orders newest-first; the answer below sorts that way.
        order: () => builder,
        // The page cap.
        limit: (n: number) => {
          // Remembered for the answer.
          cap = n;
          // Chainable.
          return builder;
        },
        // Awaiting the builder runs the read, asynchronously, returning { data, error, count } like supabase-js.
        then: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
          Promise.resolve()
            .then(() => {
              // Every matching row, newest first.
              const matched = table.filter((r) => keep.every((k) => k(r))).sort((a, b) => b.started_at.localeCompare(a.started_at));
              // The capped page plus the exact pre-cap count.
              return { data: matched.slice(0, cap), error: null, count: matched.length };
            })
            .then(resolve, reject),
      };
      // Handed back for chaining.
      return builder;
    },
  };
  // Cast once, as above.
  return { client: client as unknown as Parameters<typeof runs.readNewestBeyondWindow>[0], reads };
}

describe('Health reads agent_runs in one request, not one per agent (2026-11-08)', () => {
  before(async () => {
    // Loaded after the hooks so extensionless imports inside resolve.
    runs = await import('../src/data/useAgentRuns.ts');
    // Same.
    fresh = await import('../src/data/agentFreshness.ts');
  });

  it('health reads agent_runs once when the window covers every agent', async () => {
    // Every roster agent is in the window; the first two only with a failure there.
    const roster = fresh.HEALTH_ROSTER;
    // One window row per agent: failed for the first two, succeeded for the rest.
    const windowRows = roster.map((agent, i) => row(agent, i < 2 ? 'failed' : 'succeeded', 1));
    // The table behind the window holds an older success for the two failing agents.
    const { client, reads } = tableClient([...windowRows, row(roster[0]!, 'succeeded', 5), row(roster[1]!, 'succeeded', 7)]);
    // The beyond-window lookups.
    const beyond = await runs.readNewestBeyondWindow(client, windowRows);
    // ONE request answers both missing successes (the per-agent path made two, one per failing agent).
    assert.equal(reads.length, 1, `expected one agent_runs read beyond the window, got ${reads.length}`);
    // And it found both successes, so neither agent reads "never succeeded".
    const summary = fresh.summarizeAgentRuns([...windowRows, ...beyond.rows], NOW, beyond.failed);
    // First failing agent: succeeding (5 h ago is within every cadence).
    assert.equal(summary.find((e) => e.agent === roster[0])?.successAgeMs, 5 * HOUR - 60_000);
    // Second failing agent: same.
    assert.equal(summary.find((e) => e.agent === roster[1])?.successAgeMs, 7 * HOUR - 60_000);
    // Non-vacuity of the zero-read branch: a window with a success for EVERY agent makes no read at all.
    const all = tableClient(roster.map((agent) => row(agent, 'succeeded', 1)));
    // The window is the whole table here.
    await runs.readNewestBeyondWindow(all.client, roster.map((agent) => row(agent, 'succeeded', 1)));
    // Nothing owed, nothing read.
    assert.equal(all.reads.length, 0);
  });

  it('an empty window costs one request, and a complete page proves "never ran" for the agents it lacks', async () => {
    // The table holds only a screener success; the window came back empty.
    const { client, reads } = tableClient([row('screener', 'succeeded', 3)]);
    // The lookups.
    const beyond = await runs.readNewestBeyondWindow(client, []);
    // One request, not two per roster agent.
    assert.equal(reads.length, 1, `expected one read, got ${reads.length}`);
    // Summarised as the hook does.
    const summary = fresh.summarizeAgentRuns(beyond.rows, NOW, beyond.failed);
    // The agent with a row is found.
    assert.equal(summary.find((e) => e.agent === 'screener')?.verdict, 'succeeding');
    // rows === count proved the page complete, so an absent agent truly never ran.
    assert.equal(summary.find((e) => e.agent === 'matcher')?.verdict, 'never_run');
  });

  it('an agent missing from the window is still looked up', async () => {
    // Matcher fails more often than one page holds, so the one-request page is all matcher.
    const flood = Array.from({ length: 250 }, (_, i) => row('matcher', 'failed', 1 + i * 0.01));
    // Screener's only run is older than every matcher failure, so the capped page cannot hold it.
    const { client, reads } = tableClient([...flood, row('screener', 'succeeded', 10)]);
    // An empty window: every agent is owed.
    const beyond = await runs.readNewestBeyondWindow(client, []);
    // The page was capped (count > rows), so screener was read on its own, not declared never-run.
    assert.ok(reads.some((f) => f['agent'] === 'screener'), 'screener must get its own lookup');
    // And that lookup found it.
    assert.equal(
      fresh.summarizeAgentRuns(beyond.rows, NOW, beyond.failed).find((e) => e.agent === 'screener')?.verdict,
      'succeeding',
    );
    // Matcher's newest run came from the page, so it needed no newest-run read of its own.
    assert.equal(reads.some((f) => f['agent'] === 'matcher' && f['status'] === undefined), false);
  });
});

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
