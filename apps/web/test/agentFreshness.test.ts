/* Tests for agent freshness - the derivation the health page's whole purpose
 * rests on.
 *
 * WHAT THESE PROTECT, and it is one specific sentence: PROJECT_PLAN.md section
 * 14 says the health page must be able to say "Scout hasn't run in 9 days",
 * because Supabase pauses a free project after a week idle and GitHub disables
 * scheduled workflows after 60 days, and NEITHER ERRORS. There is no failed row
 * to find. The last run says `succeeded` and always will.
 *
 * So the tests worth writing are the ones that would fail if the page ever went
 * back to reporting an OUTCOME instead of an AGE, plus the ones that would fail
 * if the two clocks - scheduler heartbeat and last success - were ever
 * collapsed into one.
 *
 * NON-VACUITY IS EXPLICIT HERE. A freshness check that condemned every agent
 * would pass every "reports silence" test in this file, which is why each
 * rejection has an ACCEPT twin: a fresh run must produce `succeeding`, a run
 * exactly at the threshold must NOT be called silent, and a run in progress
 * must not be called stuck. Rejection tests alone cannot tell a correct guard
 * from one that rejects everything.
 *
 * RUN: `pnpm --filter @applyy/web test`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  AGENT_CADENCE,
  describeRunErrors,
  describeVerdict,
  formatAge,
  /* The page's roster: every identity but `human`. */
  HEALTH_ROSTER,
  needsAttention,
  newestHeartbeat,
  summarizeAgentRuns,
} from '../src/data/agentFreshness.ts';
import type { AgentRunFacts } from '../src/data/agentFreshness.ts';
import { AGENT_NAMES } from '../src/data/contract.ts';
import type { AgentName, AgentRunStatus } from '../src/data/contract.ts';

/* A fixed "now" so every age in this file is exact arithmetic rather than a
   value that drifts with the clock. Any date would do; a round one makes the
   offsets below readable. */
const NOW = Date.parse('2026-09-10T12:00:00.000Z');

const HOUR = 3_600_000;
const DAY = 86_400_000;

/* Build one run row. Defaults to a fresh success so each test overrides only
   the fact it is about - which is what makes each test NAME true. */
function run(overrides: Partial<AgentRunFacts> = {}): AgentRunFacts {
  const startedAt = NOW - HOUR;
  return {
    agent: 'scout_ats',
    status: 'succeeded',
    started_at: new Date(startedAt).toISOString(),
    finished_at: new Date(startedAt + 60_000).toISOString(),
    ...overrides,
  };
}

/* Pull one agent's summary out of the roster-ordered result. Throws rather than
   returning undefined, because an absent agent is the bug the roster-driven
   design exists to prevent - a test that silently skipped it would be worse
   than no test. */
function forAgent(
  runs: readonly AgentRunFacts[],
  agent: AgentName,
  now: number = NOW,
) {
  const found = summarizeAgentRuns(runs, now).find(
    (entry) => entry.agent === agent,
  );
  assert.ok(found !== undefined, 'no summary row for ' + agent);
  return found;
}

/* --- formatAge: no unit ever reports zero of itself ------------------- */

test('an age is reported in one unit, and never as a leading zero', () => {
  /* THE DIGIT-ZERO RULE from readState.ts, applied to ages. "0 days" looks like
     a measured value and is indistinguishable at a glance from no data, which
     on this page are opposite claims. */
  const samples = [0, 1, 1000, 59_000, HOUR - 1, HOUR, DAY - 1, DAY, 9 * DAY];
  for (const ms of samples) {
    const phrase = formatAge(ms);
    assert.ok(
      !/(^|\s)0(\s|$)/.test(phrase),
      'age phrase must not contain a bare zero: ' + phrase,
    );
  }
});

test('anything under an hour is words rather than a number', () => {
  assert.equal(formatAge(0), 'under an hour');
  assert.equal(formatAge(59 * 60_000), 'under an hour');
  /* The boundary belongs to the hours branch, not this one. */
  assert.equal(formatAge(HOUR), '1 hour');
});

test('units are singular at one and plural above it', () => {
  /* "1 hours" reads as a bug, and an operator who distrusts the page stops
     reading it - which on this page is the whole failure mode. */
  assert.equal(formatAge(HOUR), '1 hour');
  assert.equal(formatAge(2 * HOUR), '2 hours');
  assert.equal(formatAge(DAY), '1 day');
  assert.equal(formatAge(2 * DAY), '2 days');
});

test('hours are floored, so 23.6 hours never rounds up into a day', () => {
  /* Rounding would cross a threshold the operator is reading against. */
  assert.equal(formatAge(DAY - 60_000), '23 hours');
});

test('nine days reads as "9 days" — the sentence section 14 demands', () => {
  assert.equal(formatAge(9 * DAY), '9 days');
});

test('a negative age is named as a future timestamp, never as freshness', () => {
  /* A future timestamp is clock skew. Formatting it as "under an hour" would
     say ALIVE about a dead agent, which is the most dangerous string this page
     could produce. */
  assert.equal(formatAge(-1), 'timestamp is in the future');
  assert.equal(formatAge(-5 * DAY), 'timestamp is in the future');
});

/* --- The roster drives the table ------------------------------------- */

test('every agent in the roster gets a row, even with no runs at all', () => {
  /* THE CENTRAL DESIGN CLAIM. A table built from query rows omits the agent
     that has never run - so the agent whose failure is total would be the one
     missing from the page, and its absence would look like tidiness. */
  const summary = summarizeAgentRuns([], NOW);
  /* Every identity EXCEPT `human`, and only `human`: built from AGENT_NAMES here rather than
     from HEALTH_ROSTER, so a roster that quietly drops a second agent goes red. */
  assert.deepEqual(
    summary.map((entry) => entry.agent),
    AGENT_NAMES.filter((agent) => agent !== 'human'),
    'roster order must be preserved so the page order is stable',
  );
  /* The page loops HEALTH_ROSTER, so it must be the same list the summary used. */
  assert.deepEqual([...HEALTH_ROSTER], summary.map((entry) => entry.agent));
});

test('human is not on the health roster: it is an identity, not a scheduled job', () => {
  /* THE FALSE "HAS NEVER RUN" (Teja's ruling, 2026-11-01). `human` attributes events; it never
     writes an agent_runs row, so the roster-driven page reported it `never_run` forever - an
     alarm about a job that does not exist. Removed rather than special-cased in the verdict. */
  const summary = summarizeAgentRuns([], NOW);
  assert.equal(
    summary.some((entry) => entry.agent === 'human'),
    false,
    'human must not get a health row',
  );
  /* Even a stray `human` run row must not bring it back. */
  const withRow = summarizeAgentRuns([run({ agent: 'human' })], NOW);
  assert.equal(withRow.some((entry) => entry.agent === 'human'), false);
});

test('an agent with no runs reports never_run, not a zero age', () => {
  const entry = forAgent([], 'scout_ats');
  assert.equal(entry.verdict, 'never_run');
  assert.equal(entry.heartbeatAgeMs, null);
  assert.equal(entry.successAgeMs, null);
  assert.equal(describeVerdict(entry), 'has never run');
});

test('rows for one agent do not leak into another agent row', () => {
  /* A fresh Scout run must not make the Tracker look alive. Obvious, and
     exactly the kind of thing a `GROUP BY` refactor gets wrong once. */
  const entry = forAgent([run({ agent: 'scout_ats' })], 'tracker');
  assert.equal(entry.verdict, 'never_run');
});

/* --- The accept case: the guard must pass something ------------------ */

test('a fresh successful run reports succeeding — the non-vacuity twin', () => {
  /* WITHOUT THIS TEST every silence test below would also pass against a
     function that condemned every agent unconditionally. This is the input the
     check must ACCEPT. */
  const entry = forAgent([run()], 'scout_ats');
  assert.equal(entry.verdict, 'succeeding');
  assert.equal(needsAttention(entry.verdict), false);
  assert.match(describeVerdict(entry), /succeeded/);
});

/* --- Silence: the headline failure ----------------------------------- */

test('a nine-day-old successful run is reported as silent for 9 days', () => {
  /* The exact scenario section 14 names. Note the run SUCCEEDED - a
     status-based check would call this healthy. */
  /* The run FINISHED exactly nine days ago. Written from the finish backwards
     rather than from the start forwards, because ages are measured from
     `finished_at` and a run that started nine days ago and took a minute is
     eight-and-a-bit days old - which the floor correctly reports as 8 days.
     That is not a nitpick: it is the difference between a test that pins the
     documented sentence and one that happens to pass. */
  const finishedAt = NOW - 9 * DAY;
  const entry = forAgent(
    [
      run({
        agent: 'scout_ats',
        status: 'succeeded',
        started_at: new Date(finishedAt - 60_000).toISOString(),
        finished_at: new Date(finishedAt).toISOString(),
      }),
    ],
    'scout_ats',
  );
  assert.equal(entry.verdict, 'silent');
  assert.equal(needsAttention(entry.verdict), true);
  assert.equal(describeVerdict(entry), 'silent for 9 days');
});

test('an age exactly at the threshold is not yet silent', () => {
  /* BOUNDARY, and it is the accept side of the threshold comparison. The
     threshold is "how long silence is allowed", so an age exactly at it has not
     exceeded it. A `>=` here would condemn a run that arrived on time. */
  const cadence = AGENT_CADENCE['scout_ats'];
  assert.ok(cadence !== undefined);
  const exactly = NOW - cadence.staleAfterHours * HOUR;
  const entry = forAgent(
    [
      run({
        started_at: new Date(exactly).toISOString(),
        finished_at: new Date(exactly).toISOString(),
      }),
    ],
    'scout_ats',
  );
  assert.notEqual(entry.verdict, 'silent');
});

test('one millisecond past the threshold is silent', () => {
  /* The reject side of the same comparison, one millisecond away from the
     accept side - so the pair pins the boundary rather than merely bracketing
     it. */
  const cadence = AGENT_CADENCE['scout_ats'];
  assert.ok(cadence !== undefined);
  const past = NOW - cadence.staleAfterHours * HOUR - 1;
  const entry = forAgent(
    [
      run({
        started_at: new Date(past).toISOString(),
        finished_at: new Date(past).toISOString(),
      }),
    ],
    'scout_ats',
  );
  assert.equal(entry.verdict, 'silent');
});

test('per-agent thresholds are genuinely different, not one global number', () => {
  /* A 20-hour silence is fine for the Applier (48h) and is already a failure
     for the Tracker (12h). One global threshold would either cry wolf about the
     weekly keepalive or stay silent about a dead Tracker for a week - and an
     operator who learns to ignore one row has learned to ignore the page. */
  const twentyHoursAgo = new Date(NOW - 20 * HOUR).toISOString();
  const runs = [
    run({ agent: 'applier', started_at: twentyHoursAgo, finished_at: twentyHoursAgo }),
    run({ agent: 'tracker', started_at: twentyHoursAgo, finished_at: twentyHoursAgo }),
  ];
  assert.equal(forAgent(runs, 'applier').verdict, 'succeeding');
  assert.equal(forAgent(runs, 'tracker').verdict, 'silent');
});

/* --- The two clocks stay separate ------------------------------------ */

test('a fresh failure is a heartbeat but not a success', () => {
  /* "Runs daily, fails daily" must NOT read as healthy, and must not read as
     silent either: the cron is fine and the fix is a code fix. Collapsing the
     two clocks loses exactly this distinction. */
  const oldSuccess = NOW - 30 * DAY;
  const entry = forAgent(
    [
      run({ status: 'failed', finished_at: null }),
      run({
        status: 'succeeded',
        started_at: new Date(oldSuccess).toISOString(),
        finished_at: new Date(oldSuccess).toISOString(),
      }),
    ],
    'scout_ats',
  );
  assert.equal(entry.verdict, 'running_dry');
  assert.ok(entry.heartbeatAgeMs !== null && entry.heartbeatAgeMs < DAY);
  assert.ok(entry.successAgeMs !== null && entry.successAgeMs > 29 * DAY);
  assert.match(describeVerdict(entry), /last success was 30 days ago/);
});

test('an agent that has run but never succeeded says so explicitly', () => {
  /* Distinct from never_run: the scheduler IS firing. Reporting these
     identically would send the operator to fix the cron instead of the code. */
  const entry = forAgent([run({ status: 'failed', finished_at: null })], 'scout_ats');
  assert.equal(entry.verdict, 'running_dry');
  assert.equal(entry.successAgeMs, null);
  assert.equal(describeVerdict(entry), 'is running but has never once succeeded');
});

test('a skipped run counts as a heartbeat — quota exhaustion is not an error', () => {
  /* Section 14 is explicit: all keys cooling means rows return to their
     previous status and wait. Nothing failed. And a kill-switch skip is written
     precisely so the page can explain a quiet day. Treating either as "no run"
     would report a healthy system as dead. */
  const skips: readonly AgentRunStatus[] = ['skipped_quota', 'skipped_disabled'];
  for (const status of skips) {
    const entry = forAgent([run({ status, finished_at: null })], 'scout_ats');
    assert.notEqual(entry.verdict, 'silent', status + ' must count as a heartbeat');
    assert.notEqual(entry.verdict, 'never_run');
    assert.ok(entry.heartbeatAgeMs !== null);
    /* But it is NOT a success - no work happened. */
    assert.equal(entry.successAgeMs, null);
    assert.equal(entry.verdict, 'running_dry');
  }
});

/* --- Clock skew ------------------------------------------------------ */

test('a run timestamped in the future refuses to be judged', () => {
  /* A negative age is smaller than every threshold, so without this guard a
     skewed runner clock would present a dead agent as perfectly fresh. */
  const future = new Date(NOW + 2 * HOUR).toISOString();
  const entry = forAgent(
    [run({ started_at: future, finished_at: future })],
    'scout_ats',
  );
  assert.equal(entry.verdict, 'clock_skew');
  /* Skew needs attention: a page that can be fooled by a clock is itself the
     problem, and it must be fixed before any other row here means anything. */
  assert.equal(needsAttention(entry.verdict), true);
  assert.match(describeVerdict(entry), /clock skew/);
});

test('a normal past timestamp is not treated as skew', () => {
  /* The accept twin for the skew guard. */
  const entry = forAgent([run()], 'scout_ats');
  assert.notEqual(entry.verdict, 'clock_skew');
});

/* --- Unknown cadence ------------------------------------------------- */

test('an agent with no configured cadence reports an age and no judgement', () => {
  /* `skill_gap` has no cadence yet (a phase-3 side agent with no schedule
     chosen). It still appears in the table, reported as an age with no
     judgement, because a missing cadence is cosmetic and a missing row is not.
     It was `human` until 2026-11-01, when human left the roster. */
  assert.equal(AGENT_CADENCE['skill_gap'], undefined);
  const entry = forAgent([run({ agent: 'skill_gap' })], 'skill_gap');
  assert.equal(entry.verdict, 'age_only');
  assert.equal(entry.cadence, null);
  assert.equal(needsAttention(entry.verdict), false);
  assert.ok(entry.heartbeatAgeMs !== null);
});

test('a never-run agent with no cadence still reports never_run', () => {
  /* Precedence: no runs at all outranks no cadence. The other order would
     report the most alarming state on the page as a configuration note. */
  /* A cadence-less agent still on the roster; `human` is no longer on it. */
  const entry = forAgent([], 'skill_gap');
  assert.equal(entry.verdict, 'never_run');
});

/* --- Crashed runs ---------------------------------------------------- */

test('a run open longer than a whole cycle is reported as stuck', () => {
  /* A run is inserted BEFORE the work starts, so a crash leaves an open row.
     For the Applier this is safety-critical: a row left at `applying` means
     nobody knows whether an application was actually submitted, and submission
     is the one non-idempotent action in the system. */
  const openedAt = new Date(NOW - 5 * DAY).toISOString();
  const entry = forAgent(
    [run({ agent: 'applier', status: 'running', started_at: openedAt, finished_at: null })],
    'applier',
  );
  assert.ok(entry.stuckRun !== null);
  assert.equal(entry.stuckRun.started_at, openedAt);
});

test('a run in progress is not reported as stuck', () => {
  /* THE ACCEPT TWIN, and the reason `finished_at === null` alone is not the
     predicate: a run that started four seconds ago is simply working. A guard
     that flagged every open run would flag every healthy run in flight. */
  const openedAt = new Date(NOW - 4000).toISOString();
  const entry = forAgent(
    [run({ agent: 'applier', status: 'running', started_at: openedAt, finished_at: null })],
    'applier',
  );
  assert.equal(entry.stuckRun, null);
});

test('an open run is aged from started_at, so it cannot look fresh', () => {
  /* The fallback is deliberately the OLDER of the two available facts: an
     unfinished run must never look fresher than it is. */
  const openedAt = new Date(NOW - 3 * DAY).toISOString();
  const entry = forAgent(
    [run({ status: 'running', started_at: openedAt, finished_at: null })],
    'scout_ats',
  );
  assert.equal(entry.heartbeatAgeMs, 3 * DAY);
});

/* --- Picking the newest row ------------------------------------------ */

test('the newest run wins regardless of input order', () => {
  /* The query orders newest-first, but this module must not depend on that -
     an `.order()` clause someone edits upstream would otherwise silently change
     which run the page reports. */
  const old = new Date(NOW - 9 * DAY).toISOString();
  const recent = new Date(NOW - 2 * HOUR).toISOString();
  const ascending = [
    run({ started_at: old, finished_at: old }),
    run({ started_at: recent, finished_at: recent }),
  ];
  const descending = [...ascending].reverse();
  assert.equal(forAgent(ascending, 'scout_ats').heartbeatAgeMs, 2 * HOUR);
  assert.equal(forAgent(descending, 'scout_ats').heartbeatAgeMs, 2 * HOUR);
});

test('finished_at is preferred over started_at for a closed run', () => {
  /* The work stopped when it finished, not when it began. A long run would
     otherwise be reported as staler than it is. */
  const startedAt = new Date(NOW - 5 * HOUR).toISOString();
  const finishedAt = new Date(NOW - 2 * HOUR).toISOString();
  const entry = forAgent(
    [run({ started_at: startedAt, finished_at: finishedAt })],
    'scout_ats',
  );
  assert.equal(entry.heartbeatAgeMs, 2 * HOUR);
});

test('an unparseable finished_at falls back to started_at instead of poisoning the age', () => {
  /* `Date.parse` returns NaN, and every comparison with NaN is false - so an
     unguarded NaN would silently win or lose a comparison depending on input
     order. Falling back keeps the row readable. */
  const startedAt = new Date(NOW - 6 * HOUR).toISOString();
  const entry = forAgent(
    [run({ started_at: startedAt, finished_at: 'not a timestamp' })],
    'scout_ats',
  );
  assert.equal(entry.heartbeatAgeMs, 6 * HOUR);
});

test('the input array is never mutated', () => {
  /* The array belongs to React state. A `sort()` in place there shows up as
     rows reordering on an unrelated re-render, which is a real bug and a
     confusing one to chase. */
  const older = new Date(NOW - 9 * DAY).toISOString();
  const runs = [
    run({ started_at: older, finished_at: older }),
    run(),
  ];
  const before = JSON.stringify(runs);
  summarizeAgentRuns(runs, NOW);
  assert.equal(JSON.stringify(runs), before);
});

/* --- The roster-wide heartbeat, for the Supabase pause clock --------- */

test('the newest heartbeat anywhere is the freshest run across all agents', () => {
  /* Supabase's pause clock measures ANY database activity, not one agent's
     schedule - so reading a single agent here would report "idle for 9 days"
     while another agent had written a row two hours ago. */
  const old = new Date(NOW - 9 * DAY).toISOString();
  const recent = new Date(NOW - 2 * HOUR).toISOString();
  const summary = summarizeAgentRuns(
    [
      run({ agent: 'scout_ats', started_at: old, finished_at: old }),
      run({ agent: 'tracker', started_at: recent, finished_at: recent }),
    ],
    NOW,
  );
  const newest = newestHeartbeat(summary);
  assert.ok(newest !== null);
  assert.equal(newest.agent, 'tracker');
  assert.equal(newest.ageMs, 2 * HOUR);
});

test('with nothing ever run, the roster heartbeat is null rather than a zero age', () => {
  /* A zero age here would claim the database was touched just now, which is the
     precise inversion of the alarm. */
  assert.equal(newestHeartbeat(summarizeAgentRuns([], NOW)), null);
});

/* --- The attention predicate ----------------------------------------- */

test('needsAttention flags exactly the four verdicts that require action', () => {
  /* Enumerated rather than asserted case by case, so a new verdict added
     upstream cannot quietly default to "fine". */
  assert.equal(needsAttention('never_run'), true);
  assert.equal(needsAttention('silent'), true);
  assert.equal(needsAttention('running_dry'), true);
  assert.equal(needsAttention('clock_skew'), true);
  /* Added 2026-11-01 (W9): an agent the page could not look up is unknown,
     and an unknown agent is as much the operator's problem as a silent one. */
  assert.equal(needsAttention('lookup_failed'), true);
  /* And the two that do not - the non-vacuity side of the predicate. */
  assert.equal(needsAttention('succeeding'), false);
  assert.equal(needsAttention('age_only'), false);
});

/* W9 (2026-11-01 wiring audit): the page looks up, one by one, each agent the
   200-row window missed. A lookup that FAILED proves nothing about whether the
   agent ran, so it must never come out as "has never run" (CLAUDE.md section 6:
   missing data must not become an answer). */
test('an agent whose own lookup failed is lookup_failed, never never_run', () => {
  /* No rows anywhere, and the normalizer's lookup failed. */
  const summary = summarizeAgentRuns([], NOW, new Set<AgentName>(['normalizer']));
  /* The agent under test. */
  const normalizer = summary.find((entry) => entry.agent === 'normalizer');
  /* Present: the roster still drives the table. */
  assert.ok(normalizer !== undefined, 'the roster must still include the agent');
  /* The verdict that says "unknown", not the one that says "absent". */
  assert.equal(normalizer.verdict, 'lookup_failed');
  /* The sentence must not claim it never ran. */
  assert.doesNotMatch(describeVerdict(normalizer), /never/);
  /* An agent nobody can see is an agent that needs attention. */
  assert.equal(needsAttention(normalizer.verdict), true);
  /* Non-vacuity: an agent whose lookup answered with zero rows is still never_run. */
  assert.equal(summary.find((entry) => entry.agent === 'screener')?.verdict, 'never_run');
});

test('a run in hand outranks a failed lookup for the same agent', () => {
  /* A row proves the agent ran, so a lookup failure cannot erase it. */
  const summary = summarizeAgentRuns([run({ agent: 'normalizer' })], NOW, new Set<AgentName>(['normalizer']));
  /* The fresh success is judged as usual. */
  assert.equal(summary.find((entry) => entry.agent === 'normalizer')?.verdict, 'succeeding');
});

test('every verdict has a description, and none of them is a bare status word', () => {
  /* A phrase like "ok" or "failed" would put an OUTCOME where the page promises
     an AGE. Each description must talk about time. */
  const cases: readonly AgentRunFacts[][] = [
    [],
    [run()],
    [run({ status: 'failed', finished_at: null })],
    /* The age_only phrase, through a cadence-less agent still on the roster. */
    [run({ agent: 'skill_gap' })],
  ];
  for (const runs of cases) {
    for (const entry of summarizeAgentRuns(runs, NOW)) {
      const phrase = describeVerdict(entry);
      assert.ok(phrase.length > 0, 'every verdict needs words');
      assert.ok(
        !/(^|\s)0(\s|$)/.test(phrase),
        'no verdict phrase may contain a bare zero: ' + phrase,
      );
    }
  }
});

/* describeRunErrors: a `succeeded` run with row errors must say so. */

/* Minimal run builder; only status and error_count vary, so everything else is
   pinned to constants and cannot influence the label. */
function runWith(status: AgentRunStatus, error_count?: unknown): AgentRunFacts {
  return {
    // Any real agent works; the label never reads the name, so take the first.
    agent: AGENT_NAMES[0],
    status,
    // Fixed timestamps: the label ignores time, constants keep runs deterministic.
    started_at: '2026-01-01T00:00:00Z',
    // Closed run, so nothing here can be mistaken for a stuck one.
    finished_at: '2026-01-01T00:01:00Z',
    // undefined means "column absent" (an old row): omit the key instead of writing
    // `error_count: undefined`, which exactOptionalPropertyTypes rightly rejects as a
    // different shape from a missing property.
    ...(error_count === undefined
      ? {}
      : // Cast so the malformed shapes (NaN, 1.5) can be fed in like a bad DB row.
        { error_count: error_count as number | null }),
  };
}

/* Table: [status, error_count, expected label]. Accept twins (0, unknown)
   sit beside the rejections so a label that fires always cannot pass. */
// Typed tuple table: a malformed row is a compile error and each case is one line.
const ERROR_LABEL_CASES: ReadonlyArray<[AgentRunStatus, unknown, string | null]> = [
  // Zero errors is a clean success: no caveat to show.
  ['succeeded', 0, null],
  // Singular: "1 error", not "1 errors".
  ['succeeded', 1, 'succeeded with 1 error'],
  // Plural for anything above one.
  ['succeeded', 3, 'succeeded with 3 errors'],
  // Unknown (null/undefined) is NOT zero and NOT a count: no label.
  ['succeeded', null, null],
  ['succeeded', undefined, null],
  // Malformed numbers (NaN, -1, 1.5) must fail the shape check, not be coerced.
  ['succeeded', NaN, null],
  ['succeeded', -1, null],
  ['succeeded', 1.5, null],
  // A failed run is unaffected: it already reads as a failure.
  ['failed', 3, null],
];

for (const [status, count, expected] of ERROR_LABEL_CASES) {
  test(`describeRunErrors: ${status} / ${String(count)} -> ${expected}`, () => {
    // One assertion per row keeps the failing case named in the output.
    assert.equal(describeRunErrors(runWith(status, count)), expected);
  });
}

test('describeRunErrors: no run -> no label', () => {
  // The never-run agent has lastRun null; it must not throw.
  assert.equal(describeRunErrors(null), null);
});

// R2 (2026-11-05): the weekly tombstone run (migration 20261105201000, Sundays 06:45 UTC) has a cadence,
// so Health judges its silence like the keepalive's instead of showing an age with no verdict.
test('AGENT_CADENCE: jobs_tombstone is weekly with the keepalive threshold (204 h)', () => {
  // Exact shape: a weekly run plus a full missed week of slack, the same reasoning as the keepalive.
  assert.deepEqual(AGENT_CADENCE.jobs_tombstone, { expected: 'weekly', staleAfterHours: 204 });
});
