/* How long each agent has been silent, derived from `agent_runs`.
 *
 * WHY THIS IS THE MOST IMPORTANT DERIVATION IN THE CONSOLE. PROJECT_PLAN.md
 * section 14 names two things that kill this system: Supabase pauses a free
 * project after a week idle, and GitHub disables scheduled workflows after 60
 * days of repository inactivity. NEITHER OF THEM ERRORS. There is no failed
 * run to find, no error_detail to read, no alert to receive - the last row in
 * `agent_runs` says `succeeded` and always will, because it was the last thing
 * that happened before the scheduler stopped calling.
 *
 * THEREFORE: A STATUS COLUMN CANNOT DETECT THIS AND AN AGE COLUMN CAN. A job
 * that died a month ago has a perfectly successful last run. Every function in
 * this file computes an AGE and only ever treats outcome as a secondary
 * qualifier. Naming the pattern - this is a DEAD MAN'S SWITCH read from the
 * consumer side: the alarm condition is the ABSENCE of a recent heartbeat, so
 * silence has to be computed, not waited for.
 *
 * THE HEARTBEAT AND THE OUTCOME ARE TWO DIFFERENT CLOCKS, and conflating them
 * is the subtle version of the same bug. Consider the Matcher running every
 * morning and failing every morning: its last SUCCESS is thirty days old, so a
 * success-only view calls it dead - but the scheduler is fine and the fix is a
 * code fix, not a cron fix. Now consider the reverse: the scheduler stopped and
 * the last run succeeded. A run-only view calls it healthy. The operator's next
 * action differs completely between those two, so this module reports both:
 *
 *   heartbeatAgeMs - age of the last run of ANY outcome. Proof the SCHEDULER
 *                    is still firing. `skipped_disabled` and `skipped_quota`
 *                    count fully here: section 14 is explicit that quota
 *                    exhaustion is not an error, and a kill-switch skip is a
 *                    row deliberately written so the page can say WHY nothing
 *                    happened. Both are live proof that the tick occurred.
 *   successAgeMs   - age of the last `succeeded` run. Proof WORK happened.
 *
 * WHY IT IS PURE, and it is the same argument as `readState.ts` and
 * `keyRole.ts`: it classifies facts it is handed and performs no query. A
 * nine-day silence is otherwise untestable without waiting nine days, and a
 * clock skewed into the future is untestable at all. Handing `now` in as a
 * parameter is what makes both a two-line test.
 */

import { AGENT_NAMES } from './contract.ts';
import type { AgentName, AgentRunStatus } from './contract.ts';

/* --- What this module needs to know about one run --------------------- */

/* The narrowest projection of `agent_runs` that answers "how long has this been
 * quiet". Declared structurally rather than as `Pick<AgentRunRow, ...>` so this
 * module can be tested without constructing rows that carry `user_id` and eight
 * counters it never reads - and so the query in `useAgentRuns.ts` is visibly
 * selecting only these four columns.
 *
 * NOTHING PERSONAL IS IN HERE, which is why this read is safe to build today:
 * `agent_runs` carries an agent name, an outcome and two timestamps. No job
 * description, no resume, no answer bank. The row content cannot mislead about
 * anything except timing, and timing is exactly what the panel is for. */
export interface AgentRunFacts {
  readonly agent: AgentName;
  readonly status: AgentRunStatus;
  /* When the run opened. A run is inserted BEFORE the work starts, so this
     exists even for a run that crashed and never closed. */
  readonly started_at: string;
  /* When it closed, or null while still running / if it crashed mid-run. */
  readonly finished_at: string | null;
  /* Rows that failed inside a run. Optional/nullable so old rows and fixtures
     that predate the column still type-check; absence means "unknown", never 0. */
  readonly error_count?: number | null;
}

/* The "succeeded with N errors" label for a run, or null when there is none to
 * show. Pipeline agents mark a run `succeeded` if ANY row succeeded (see the
 * `const runStatus = ...` line in supabase/functions/matcher/index.ts: `failed`
 * only when no row moved; screener, normalizer, tailor and auditor follow the
 * same rule), so a plain success can hide 99 failures - this is the one place that says so.
 *
 * Shape-validated: only a non-negative integer counts. null/undefined/NaN/-1/1.5
 * are "unknown" and return null rather than being read as 0 or as an error
 * count, because a lenient coercion would invent either a clean bill or a
 * number nobody measured. */
export function describeRunErrors(run: AgentRunFacts | null): string | null {
  // Only a succeeded run needs the caveat; a failed run already says so.
  if (run === null || run.status !== 'succeeded') return null;
  const n = run.error_count;
  // Validate the shape (integer >= 0) instead of trusting truthiness.
  if (typeof n !== 'number' || !Number.isInteger(n) || n <= 0) return null;
  // Singular for 1 so the sentence reads as English.
  return `succeeded with ${n} ${n === 1 ? 'error' : 'errors'}`;
}

/* --- Per-agent cadence ------------------------------------------------- */

/* How long a given agent may be silent before silence means something is wrong.
 *
 * PER-AGENT AND NOT GLOBAL, because the roster runs on wildly different
 * schedules and one threshold cannot serve both ends of it. The keepalive
 * workflow is WEEKLY by design, so a global daily threshold would cry wolf
 * about it every single day - and an operator who learns to ignore one row on
 * this page has learned to ignore the page. Meanwhile the Tracker reads the
 * mailbox every few hours, so a weekly threshold would let it be dead for six
 * days without a word.
 *
 * Stated in hours as plain data so every number is reviewable in one place
 * rather than buried inside comparisons. */
export interface Cadence {
  /* What the operator should expect, in words, shown next to the age so a
     reported gap can be judged without knowing the schedule by heart. */
  readonly expected: string;
  /* Past this age, the agent is presumed dead rather than merely idle. */
  readonly staleAfterHours: number;
}

/* Keyed by `AgentName` and PARTIAL ON PURPOSE. An agent the schema stream adds
 * and this map has not been taught about still gets a row (reported as
 * `age_only` - an age with no judgement attached) instead of being dropped.
 * A missing cadence is a cosmetic gap; a missing AGENT ROW is a silent death,
 * which is the one thing this page exists to prevent. */
export const AGENT_CADENCE: Readonly<Partial<Record<AgentName, Cadence>>> = {
  /* The two discovery agents are the top of the funnel, and their death is the
     failure that looks most like success: everything downstream has nothing to
     do and reports itself perfectly healthy. 30 rather than 24 hours so a run
     that drifts by an hour is not called dead. */
  /* scout_ats runs twice a day since 2026-11-01 (.github/workflows/scout.yml,
     `17 0,12 * * *`). GitHub started those runs 3-6 hours late here (measured
     2026-10-29..11-01), so a healthy gap between two successes reaches ~18 hours;
     20 flags ONE missed run under those delays without calling a late one dead.
     The 30 above still governs the once-a-day aggregator below. A manual button
     scan also writes `scout_ats`: it can make a dead schedule look alive, never the reverse.
     Three runs a day since 2026-11-05 (`17 4 * * *` added, 09:47 IST). 20 is KEPT on purpose:
     the threshold is set by the LONGEST scheduled gap, 12:17 -> 00:17 UTC = 12 h, which the
     new run does not shorten; 12 h + the 6 h delay = 18 h still needs 20. Lowering it would
     call a healthy late night run dead. test/scoutScheduleFreshness.test.ts recomputes the
     gap from scout.yml, so a schedule change that outgrows 20 goes red there. */
  scout_ats: { expected: 'three times a day', staleAfterHours: 20 },
  scout_aggregator: { expected: 'every morning', staleAfterHours: 30 },
  /* Deterministic, cheap, runs with discovery. */
  normalizer: { expected: 'every morning', staleAfterHours: 30 },
  /* No LLM at all. Most discovered jobs die here, which is what keeps the
     running cost near zero - so a dead Screener surfaces as a surprising Gemini
     bill rather than as an error. */
  screener: { expected: 'every morning', staleAfterHours: 30 },
  matcher: { expected: 'every morning', staleAfterHours: 30 },
  tailor: { expected: 'every morning', staleAfterHours: 30 },
  auditor: { expected: 'every morning', staleAfterHours: 30 },
  /* GitHub Actions plus Playwright rather than an Edge Function, and the only
     agent that performs a non-idempotent action. Runs after approvals, so two
     quiet days can simply mean two days of not approving anything. */
  applier: { expected: 'after each approval', staleAfterHours: 48 },
  /* Reads the mailbox through Apps Script. Its death is the hardest to notice
     from the outside: applications still go out, they just never advance past
     `applied`, so the board looks merely quiet. Tightest threshold on the page
     for exactly that reason. */
  tracker: { expected: 'every few hours', staleAfterHours: 12 },
  /* Reclaims stale leases. If it stops, `applying` rows pile up - and that is
     the safety-critical status, because a row stuck at `applying` means nobody
     knows whether an application was submitted. */
  sweeper: { expected: 'every run', staleAfterHours: 24 },
  /* THE KEEPALIVE IS THE ONE WHOSE OWN SILENCE IS THE SECOND SILENT DEATH.
     GitHub disables cron schedules after 60 days of repo inactivity, and this
     workflow exists to touch a timestamp file so that clock never gets there.
     Weekly by design, so 8.5 days (204h) allows a full missed week plus slack
     before it is called dead - far tighter than the 60-day deadline it guards,
     which is the point: the warning has to arrive with weeks to spare. */
  keepalive: { expected: 'weekly', staleAfterHours: 204 },
  /* The weekly jobs tombstone run (2026-11-05, migration 20261105201000; Sundays 06:45 UTC). It keeps
     the database under the 500 MB Free quota, so its silence is news: same weekly shape and the same
     204 h (a full missed week plus slack) as the keepalive above. */
  jobs_tombstone: { expected: 'weekly', staleAfterHours: 204 },
  /* `human` is deliberately absent, here AND from HEALTH_ROSTER below. It is
     an identity for attributing events, not a scheduled job, so "the human has
     not run in 9 days" is a meaningless sentence and a threshold for it would
     be noise. This comment used to say it still rendered as `age_only`; it did
     not - with no agent_runs row it rendered `never_run`, a permanent false
     alarm. Teja ruled on 2026-11-01 to drop it from the roster instead. */
};

/* The agents the Health page lists: every `AgentName` EXCEPT `human`.
 *
 * "NEVER DROP A ROSTER ENTRY" STILL HOLDS, AND `human` IS ITS ONE EXCEPTION,
 * because the rule protects scheduled jobs whose silence means death, and
 * `human` is not a job. It is the identity a person's approvals and edits are
 * attributed to; it never opens an `agent_runs` row, so on this page its only
 * possible verdict was `never_run` - an alarm about something that cannot run.
 * The exception is by NAME, not by "has no cadence": a new agent with no
 * cadence must still get its row, which is what the rule exists to guarantee.
 * Derived from AGENT_NAMES, so every agent the schema adds still appears. */
export const HEALTH_ROSTER: readonly AgentName[] = AGENT_NAMES.filter(
  /* One named exclusion; anything else in the schema is listed. */
  (agent) => agent !== 'human',
);

/* --- Age formatting --------------------------------------------------- */

/* Milliseconds per unit, named so the comparisons below read as English. */
const MS_PER_HOUR = 3_600_000;
const MS_PER_DAY = 86_400_000;

/* Turn an age in milliseconds into the phrase section 14 asks for: "9 days".
 *
 * TWO RULES, BOTH LEARNED FROM THE FAILURE THIS PAGE IS ABOUT.
 *
 * 1. NEVER RENDER A LEADING ZERO. "0 days" is the digit-zero problem from
 *    `readState.ts` wearing a different hat: it looks like a measured value and
 *    is indistinguishable at a glance from "no data". Anything under an hour is
 *    the words "under an hour", and anything under a day is counted in hours,
 *    so no unit ever reports zero of itself.
 * 2. ONE UNIT, NOT TWO. "9 days 4 hours" invites the eye to read the small
 *    number. The operator's decision is a threshold decision, so the phrase is
 *    written to be scanned, not to be precise. */
export function formatAge(ms: number): string {
  /* A NEGATIVE AGE MEANS A TIMESTAMP IN THE FUTURE, which is clock skew, not
     freshness. Called out here as well as in the verdict because a caller that
     formats an age without checking the verdict would otherwise print "under an
     hour" for a run that has not happened - the single most dangerous string
     this page could show, since it says "alive" about a dead agent. */
  if (ms < 0) {
    return 'timestamp is in the future';
  }

  /* Under an hour: words, not a number. See rule 1. */
  if (ms < MS_PER_HOUR) {
    return 'under an hour';
  }

  /* Hours, while there are whole hours to count and fewer than a day of them.
     `Math.floor` is right rather than rounding: reporting 23.6 hours as "1 day"
     would cross a threshold the operator is reading against. */
  if (ms < MS_PER_DAY) {
    const hours = Math.floor(ms / MS_PER_HOUR);
    /* Singular vs plural, because "1 hours" reads as a bug and an operator who
       distrusts the page stops reading it. */
    return hours === 1 ? '1 hour' : String(hours) + ' hours';
  }

  /* Days. This is the branch section 14 quotes verbatim. */
  const days = Math.floor(ms / MS_PER_DAY);
  return days === 1 ? '1 day' : String(days) + ' days';
}

/* --- The verdict ------------------------------------------------------ */

/* What the two clocks add up to, as a closed set so the panel's rendering is
 * exhaustive and a new verdict cannot be silently unhandled.
 *
 * ORDER OF PRECEDENCE IS PART OF THE CONTRACT and is applied in `verdictFor`
 * below, most-alarming first. Getting it wrong is how a never-run agent gets
 * reported as merely "running dry". */
export type FreshnessVerdict =
  /* No run of any kind has ever been recorded. THE LOUDEST CASE: the agent has
     not run once, which a table built from query rows would render by simply
     omitting the agent - the exact silence this page exists to break. */
  | 'never_run'
  /* Added 2026-11-01 (wiring audit W9). The agent had no row in the 200-row
     window, and its own newest-run lookup FAILED. That proves nothing either
     way, so it must not fall through to `never_run`: a failed read reported as
     "has never run" is missing data turned into a confident answer.
     Widened 2026-11-01 (code-review #4): also an agent with no success in hand
     whose newest-success lookup failed, which must not read "never succeeded". */
  | 'lookup_failed'
  /* A timestamp lies in the future. Refuse to judge rather than judge wrongly:
     a skewed clock makes a dead agent look alive, and a page that can be fooled
     by a clock is a page that cannot be trusted about anything. */
  | 'clock_skew'
  /* Runs exist but no cadence is configured for this agent, so the age is
     reported with no judgement attached. Honest rather than invented - a
     guessed threshold is a threshold nobody chose. */
  | 'age_only'
  /* The scheduler has stopped firing. The headline failure of section 14. */
  | 'silent'
  /* The scheduler is firing but nothing has SUCCEEDED recently. A different
     diagnosis with a different fix: the cron is fine, the code or the quota is
     not. */
  | 'running_dry'
  /* Both clocks are inside their thresholds. THE NON-VACUITY CASE - if this
     verdict is unreachable then every test above it passes against a function
     that condemns everything, which is indistinguishable from a working one. */
  | 'succeeding';

/* Everything the panel needs about one agent, in roster order. */
export interface AgentFreshness {
  /* The schema's own identifier, so the name on screen matches the one in
     `agent_runs` and in a peer's message. */
  readonly agent: AgentName;
  /* Null when this module has not been taught the agent's schedule. */
  readonly cadence: Cadence | null;
  /* The most recent run of any outcome - the scheduler heartbeat - and its age.
     Null together: either there is a last run and an age, or neither. */
  readonly lastRun: AgentRunFacts | null;
  readonly heartbeatAgeMs: number | null;
  /* The most recent `succeeded` run, and its age. Separate clock, see the file
     header. Null when the agent has run but never once succeeded, which is a
     real and distinct state from never having run. */
  readonly lastSuccess: AgentRunFacts | null;
  readonly successAgeMs: number | null;
  /* An open `running` row older than the cadence allows: the run started, never
     closed, and nothing has closed it since. That is a crash mid-run rather
     than work in progress, and for the Applier it is the safety-critical case -
     a row stuck at `applying` means nobody knows whether an application was
     actually submitted. Null when there is no such row. */
  readonly stuckRun: AgentRunFacts | null;
  readonly verdict: FreshnessVerdict;
}

/* When did this run end, for age purposes?
 *
 * `finished_at` for a closed run, because that is when the work actually
 * stopped. `started_at` as the fallback for an OPEN run - and the fallback is
 * deliberately the older of the two available facts, so an unfinished run can
 * never look fresher than it is. A run that opened nine days ago and never
 * closed is nine days old, not unknown. */
function runInstant(run: AgentRunFacts): number {
  const closed = run.finished_at === null ? null : Date.parse(run.finished_at);
  /* `Date.parse` returns NaN on a malformed string. NaN would poison every
     comparison silently (all comparisons with NaN are false), so an
     unparseable `finished_at` falls back to `started_at` rather than being
     propagated. */
  if (closed !== null && !Number.isNaN(closed)) {
    return closed;
  }
  return Date.parse(run.started_at);
}

/* Decide the verdict from the two clocks. Extracted so the precedence order is
 * one readable ladder rather than a nest of conditions inside a loop. */
function verdictFor(
  cadence: Cadence | null,
  heartbeatAgeMs: number | null,
  successAgeMs: number | null,
): FreshnessVerdict {
  /* FIRST, because with no heartbeat at all there is nothing else to say and
     every branch below would be reasoning about a null. Also the most alarming
     thing the page can report. */
  if (heartbeatAgeMs === null) {
    return 'never_run';
  }

  /* SECOND, before any threshold comparison. A future timestamp produces a
     negative age, which is less than every threshold and would therefore sail
     through as healthy - a dead agent presented as alive because a runner's
     clock was wrong. Refusing to judge is the only honest answer. */
  if (heartbeatAgeMs < 0 || (successAgeMs !== null && successAgeMs < 0)) {
    return 'clock_skew';
  }

  /* THIRD: with no configured cadence there is no threshold to compare against,
     so the age is reported and no claim is made about it. */
  if (cadence === null) {
    return 'age_only';
  }

  const staleAfterMs = cadence.staleAfterHours * MS_PER_HOUR;

  /* The headline check. Strictly greater than, so an age exactly at the
     threshold is still inside it - the threshold is "how long silence is
     allowed", and a run at exactly that age has not yet exceeded it. */
  if (heartbeatAgeMs > staleAfterMs) {
    return 'silent';
  }

  /* The scheduler is firing. Now the second clock: no success ever, or a
     success older than the same window, both mean the tick is happening and the
     work is not. Deliberately NOT reported as `silent`, because the operator's
     next action is to read `error_detail`, not to check the cron. */
  if (successAgeMs === null || successAgeMs > staleAfterMs) {
    return 'running_dry';
  }

  /* Both clocks inside the window. */
  return 'succeeding';
}

/* Roll a flat list of runs up into one row per agent.
 *
 * DRIVEN BY THE ROSTER, NOT BY THE ROWS, and this is the single most important
 * line of reasoning in the file. A table built from `GROUP BY agent` contains
 * no row for an agent that has never run - so the one agent whose failure is
 * total would be the one agent absent from the page, and its absence would look
 * like tidiness. So `HEALTH_ROSTER` (AGENT_NAMES minus `human`, see its comment)
 * drives the output and the rows only fill it in. An agent the schema adds
 * appears here automatically, reported as `never_run` until it runs; an agent
 * this page forgot to list is an agent whose death nobody would notice.
 *
 * `now` is a parameter rather than a `Date.now()` call so that a nine-day
 * silence, a clock skew and a run in the future are each one line of test
 * setup instead of being untestable.
 *
 * `lookupFailed` names the agents whose own newest-run or newest-success lookup
 * failed (`useAgentRuns.ts`, W9 and code-review #4). With no success in hand,
 * such an agent is `lookup_failed`, never `never_run` or a "never succeeded"
 * `running_dry`. A success in hand still wins: that row proves the agent ran
 * and succeeded, whatever a later lookup did. Empty by default, so callers
 * that read every row (and the tests) need not pass it. */
export function summarizeAgentRuns(
  runs: readonly AgentRunFacts[],
  now: number,
  lookupFailed: ReadonlySet<AgentName> = new Set(),
): readonly AgentFreshness[] {
  /* The roster, not the rows: a `human` row in `runs` is ignored, never listed. */
  return HEALTH_ROSTER.map((agent) => {
    /* This agent's runs only. A linear filter per agent is O(agents × runs),
       which at twelve agents and a bounded run history is irrelevant, and it
       keeps the function readable - the query in `useAgentRuns.ts` caps the row
       count long before this could matter. */
    const mine = runs.filter((run) => run.agent === agent);

    /* The heartbeat: the newest run of ANY outcome, including the two
       `skipped_*` values. Section 14 is explicit that quota exhaustion is not
       an error and a kill-switch skip is recorded precisely so the page can
       explain a quiet day - so both are proof the scheduler fired. */
    const lastRun = newestBy(mine, runInstant);

    /* The outcome clock: `succeeded` only. A `failed` run is a heartbeat and is
       NOT a success, and collapsing the two is how "runs daily, fails daily"
       gets rendered as healthy. */
    const lastSuccess = newestBy(
      mine.filter((run) => run.status === 'succeeded'),
      runInstant,
    );

    const cadence = AGENT_CADENCE[agent] ?? null;

    /* Ages, or null when there is no such run. Null rather than a sentinel
       number: `-1` or `Infinity` would flow into `formatAge` and print
       something, and printing something about a run that does not exist is the
       fabrication this whole layer is built to prevent. */
    const heartbeatAgeMs = lastRun === null ? null : now - runInstant(lastRun);
    const successAgeMs =
      lastSuccess === null ? null : now - runInstant(lastSuccess);

    /* An open run that has outlived its own cadence. `finished_at === null`
       alone is not enough - a run that started four seconds ago is simply in
       progress. It only becomes evidence of a crash once it has been open
       longer than a whole cycle. With no cadence there is no "too long", so no
       claim is made. */
    const stuckRun =
      cadence === null
        ? null
        : (newestBy(
            mine.filter(
              (run) =>
                run.status === 'running' &&
                run.finished_at === null &&
                now - Date.parse(run.started_at) >
                  cadence.staleAfterHours * MS_PER_HOUR,
            ),
            runInstant,
          ) ?? null);

    return {
      agent,
      cadence,
      lastRun,
      heartbeatAgeMs,
      lastSuccess,
      successAgeMs,
      stuckRun,
      /* Unknown beats "never": with no success in hand and a failed lookup,
         neither "never ran" nor "never succeeded" is known (code-review #4:
         the success lookup is the one that may have failed). No run in hand
         implies no success in hand, so the W9 case is covered too. */
      verdict:
        lastSuccess === null && lookupFailed.has(agent)
          ? 'lookup_failed'
          : verdictFor(cadence, heartbeatAgeMs, successAgeMs),
    };
  });
}

/* The newest item by a numeric key, or null for an empty list.
 *
 * Written as a reduce rather than `sort()[0]` because `sort` mutates its
 * receiver, and the array handed to this module belongs to React state - a
 * sort in place there is a genuine bug that shows up as rows reordering on an
 * unrelated re-render. Returns null rather than `undefined` so the whole module
 * speaks one absence dialect. */
function newestBy<T>(items: readonly T[], key: (item: T) => number): T | null {
  return items.reduce<T | null>((best, item) => {
    const value = key(item);
    /* NaN guard: an unparseable timestamp must not win the comparison. Every
       comparison with NaN is false, so without this a NaN item could be
       returned as "best" simply by being first. */
    if (Number.isNaN(value)) return best;
    if (best === null) return item;
    return value > key(best) ? item : best;
  }, null);
}

/* --- Rendering vocabulary --------------------------------------------- */

/* One short sentence per verdict, so the same state never gets two wordings on
 * two panels - the operator learns one vocabulary and "silent" always means the
 * same thing. Centralised for the same reason as `describeEmptyState`.
 *
 * NOTE WHAT NONE OF THESE STRINGS ARE: a bare status word like "ok" or
 * "failed". Each one says what is known about TIMING, because timing is the
 * signal and outcome is the qualifier. */
export function describeVerdict(freshness: AgentFreshness): string {
  switch (freshness.verdict) {
    case 'never_run':
      /* Stated as an absolute, because it is one. There is no age to report. */
      return 'has never run';
    case 'lookup_failed':
      /* No claim about running or succeeding: the page simply could not look.
         Names both clocks, since either lookup may be the one that failed (#4). */
      return 'a run lookup failed, so when it last ran or succeeded is unknown — reload to retry';
    case 'clock_skew':
      return 'reported a run in the future — clock skew, so no age can be trusted';
    case 'age_only':
      /* No threshold exists, so no claim is made beyond the measurement. */
      return 'no expected cadence set, so this age is reported without judgement';
    case 'silent':
      /* The sentence section 14 demands the page be able to say. */
      return 'silent for ' + formatAge(freshness.heartbeatAgeMs ?? 0);
    case 'running_dry':
      return freshness.successAgeMs === null
        ? 'is running but has never once succeeded'
        : 'is running, but the last success was ' +
            formatAge(freshness.successAgeMs) +
            ' ago';
    case 'succeeding':
      return 'ran and succeeded ' + formatAge(freshness.successAgeMs ?? 0) + ' ago';
  }
}

/* The freshest heartbeat anywhere in the roster.
 *
 * WHAT IT IS EVIDENCE OF, and it is a different question from any single
 * agent's freshness: Supabase pauses a free project after one week with NO
 * activity at all, and the daily Actions cron exists to make sure that clock
 * never gets there. Any agent run whatsoever is a database write, so the
 * newest run across the whole roster is the console's best available answer to
 * "when did something last touch this database" - which is the clock the pause
 * is measured against, not any individual agent's schedule.
 *
 * HONEST LIMIT, stated because it changes how the number should be read: this
 * is the newest run the console can SEE. The console's own queries are activity
 * too and are not recorded in `agent_runs`, so the real idle clock may be
 * fresher than this. The number is therefore a safe over-estimate of idleness -
 * it can cry wolf, it cannot miss a pause - which is the correct direction for
 * a warning to err in.
 *
 * Returns null when nothing has ever run, rather than a zero age. */
export function newestHeartbeat(
  freshness: readonly AgentFreshness[],
): { readonly agent: AgentName; readonly ageMs: number } | null {
  /* Only entries that actually have a heartbeat. An agent that never ran
     contributes no evidence either way, and treating its null as a large age
     would invent one. */
  const withRuns = freshness.filter(
    (entry): entry is AgentFreshness & { heartbeatAgeMs: number } =>
      entry.heartbeatAgeMs !== null,
  );
  /* Smallest age is the newest run. Reduced rather than sorted, for the same
     reason as `newestBy`: the array belongs to React state and `sort` mutates
     in place. */
  return withRuns.reduce<{ agent: AgentName; ageMs: number } | null>(
    (best, entry) =>
      best === null || entry.heartbeatAgeMs < best.ageMs
        ? { agent: entry.agent, ageMs: entry.heartbeatAgeMs }
        : best,
    null,
  );
}

/* Is this verdict one the operator needs to act on?
 *
 * A NAMED PREDICATE rather than an inline comparison, for the reason
 * `humanLanes.ts` taught this codebase: a check whose name does not state its
 * predicate lets two readers assume two different ones. Used only to choose an
 * emphasis style - never to hide a row, because hiding rows on this page is the
 * failure mode it exists to prevent. */
export function needsAttention(verdict: FreshnessVerdict): boolean {
  return (
    verdict === 'never_run' ||
    /* An agent the page could not see is not an agent known to be fine. */
    verdict === 'lookup_failed' ||
    verdict === 'silent' ||
    verdict === 'running_dry' ||
    /* Skew counts: a page that cannot be trusted about ages is itself the
       problem, and it needs fixing before any other row here means anything. */
    verdict === 'clock_skew'
  );
}
