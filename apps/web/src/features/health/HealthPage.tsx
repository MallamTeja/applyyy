/* System health - PROJECT_PLAN.md section 14 and section 15, row "System Health".
 *
 * THIS IS THE MOST IMPORTANT PAGE IN THE CONSOLE, and it is worth being precise
 * about why. Every other screen tells the operator what the system DID. This
 * one tells him whether it is still running at all - and the two silent deaths
 * in section 14 mean that question cannot be answered by waiting for an error:
 *
 *   - Supabase pauses a free project after one week idle.
 *   - GitHub disables scheduled workflows after 60 days of repo inactivity.
 *
 * NEITHER OF THEM ERRORS. They just stop. Nothing appears in a log, no email
 * arrives, and the console keeps rendering yesterday's rows perfectly happily.
 * The operator would believe the automation was working while getting no
 * interviews, and would find out weeks later. So this page is built around one
 * sentence it must always be able to say: "Scout has not run in 9 days."
 *
 * WHICH IS WHY EVERY PANEL HERE REPORTS AN AGE, NOT A STATUS. A green tick
 * meaning "the last run succeeded" is exactly the wrong indicator: a job that
 * stopped a month ago has a perfectly successful last run. Freshness is the
 * signal; outcome is secondary. Naming the pattern - this is a DEAD MAN'S
 * SWITCH read from the consumer side: absence of a recent heartbeat is itself
 * the alarm, so silence has to be rendered as loudly as failure.
 *
 * WHAT ELSE LIVES HERE, and why on this page rather than their own:
 *   - The `blocked_needs_human` queue. Captchas and login walls are NORMAL
 *     daily traffic, not errors (constraint 5 forbids circumventing them), so
 *     they get a real work queue with the screenshot the worker captured.
 *   - MANUAL CONTROL COVERAGE, as a first-class panel. A human-reachable edge
 *     with no control is a stall the operator cannot see from anywhere else -
 *     and the panel reports a four-way PARTITION of those edges rather than one
 *     list, because the single list it used to render was empty for a reason
 *     unrelated to coverage and therefore read as an all-clear it had not
 *     earned. See the panel's own header.
 *   - The Gemini key pool, because quota exhaustion is not an error either: all
 *     keys cooling means rows quietly wait, which looks identical to nothing
 *     happening.
 */

import type { ReactElement } from 'react';

import { PageHeader } from '../../app/PageHeader';
/* The agent roster and the run-outcome vocabulary come from the schema, so an
   agent added upstream appears here with no edit - an agent this page forgot to
   list is an agent whose death nobody would notice. */
import { AGENT_NAMES } from '../../data/contract';
/* The four recovery panels list their stuck rows with working moves through this one component
   (2026-10-09), so the moves are built from the graph in one place rather than four. */
import { RecoveryQueue, manualActionMeaning, manualActionVerb } from './RecoveryQueue';
/* The coverage check, imported rather than recomputed. Its own file explains
   why the predicate is `.includes('human')` and not `=== ['human']`, and why
   one list of gaps was not enough: a status claimed by a screen nobody wrote
   is a gap that `MISSING_HUMAN_CONTROLS` cannot see, because the status IS
   claimed. All four sets are imported so the panel can report a partition of
   the human-reachable edges rather than a single number that reads as an
   all-clear it has not earned. */
import {
  HUMAN_REACHABLE_LANES,
  INOPERABLE_HUMAN_CONTROLS,
  MISSING_HUMAN_CONTROLS,
  OPERABLE_HUMAN_CONTROLS,
  UNBUILT_HUMAN_CONTROLS,
} from '../../data/humanLanes';
/* Freshness is DERIVED, not measured here: the cadences, the age arithmetic and
   the verdict ladder all live in one pure module with a test per branch. A
   nine-day silence and a clock skewed into the future are both one line of test
   setup there and untestable in a component. */
import {
  AGENT_CADENCE,
  describeRunErrors,
  describeVerdict,
  formatAge,
  needsAttention,
  newestHeartbeat,
} from '../../data/agentFreshness';
/* The read itself. `RUN_WINDOW` is imported rather than restated so the note
   the panel renders about its own window cannot drift from the query's LIMIT -
   a page that misdescribes its own bounds is worse than one that says nothing,
   because the operator would trust it. */
import { useAgentRuns } from '../../data/useAgentRuns';
import type { AgentRunRow, AgentRunsRead } from '../../data/useAgentRuns';
/* The shared vocabulary for every state that is not an answer. Imported so
   "not signed in" reads identically on this page, the pipeline board and any
   panel added later - the operator learns one phrase per state, once. */
import { describeEmptyState } from '../../data/readState';
/* The shape-validating reader for the `rule_warnings:` segment of
   `error_detail`. Imported rather than parsed inline so the parity test can
   round-trip it against the writer. */
import { parseRuleWarnings } from '../../data/ruleWarnings';
/* Whether the console can reach a database at all.
   IMPORTING THIS IS LOAD-BEARING BEYOND THIS PANEL: `supabase.ts` enforces the
   anon-key rule at module scope, and until something imported it that check
   never executed. A guard in an unimported module cannot fail, cannot pass, and
   protects nothing - so this import is what turns it from documentation into
   enforcement. Health is the right home for it: "can we even connect" is the
   first question this page exists to answer. */
import { supabaseStatus } from '../../data/supabase';

import './health.css';

/* --- Panels ----------------------------------------------------------- */

/* The rules the screener skipped, from ONE run: the agent's newest CLOSED run
 * that took in rows (chosen by `pickRuleWarningRun` in `useAgentRuns`).
 *
 * WHAT THIS CLAIMS, and no more. A closed run that screened rows writes its
 * warnings into error_detail when there are any, so a clean detail on THAT run
 * means the rules ran. An idle run (rows_in 0) or one still open says nothing
 * about rules, so neither is allowed to replace an older run's list. When no
 * run ever screened rows, the caller passes null and nothing renders.
 *
 * NOTHING RENDERED MEANS "KNOWN: NONE", never "could not tell". The parser's
 * closed union makes the cut-off and unreadable cases say so out loud.
 *
 * Exported so a test can render it on its own; the freshness table is its only
 * caller. Everything in it is DATA from the database: rendered as text nodes,
 * which React escapes, never as markup. */
export function RuleWarningsNote({
  run,
}: {
  /* The chosen run, or null when this agent has none that screened rows. */
  readonly run: AgentRunRow | null;
}): ReactElement | null {
  /* Validated by the parser rather than trusted, since the column is free
     text and a fixture or older read may lack it entirely. */
  const parsed = run === null ? null : parseRuleWarnings(run.error_detail);
  /* Known-clean: the chosen run recorded no warnings and nothing was cut. */
  if (parsed === null) return null;

  /* The cap ate the segment, or its label: say warnings MAY exist. */
  if (parsed.kind === 'maybe_cut') {
    return (
      <div className="table__rule-warnings">
        Rule warnings may have been cut off: this run&apos;s error detail hit
        its 1000-character limit.
      </div>
    );
  }

  /* A label was recorded but its body is not the writer's shape: point the
     operator at the raw column rather than guessing at a list. */
  if (parsed.kind === 'unreadable') {
    return (
      <div className="table__rule-warnings">
        Rule warnings were recorded but could not be read; see this run&apos;s
        error_detail.
      </div>
    );
  }

  return (
    <div className="table__rule-warnings">
      {/* Scopes the claim to one named run, so it cannot be read as the
          agent's whole history or as the run in the other columns. */}
      <span>
        Rules skipped in the last run that screened jobs (
        <span className="identifier">{run?.finished_at}</span>)
      </span>
      {/* The cap note sits beside the heading: the writer cuts at 1000
          characters, so the last item below may be incomplete. */}
      {parsed.truncated ? <span> (list truncated)</span> : null}
      <ul className="table__rule-warnings-list">
        {parsed.warnings.map((warning) => (
          /* The writer dedupes, so the text itself is a unique, stable key. */
          <li key={warning}>{warning}</li>
        ))}
      </ul>
    </div>
  );
}

/* Agent freshness panel: roster-driven table showing age since last run.
 * Driven by AGENT_NAMES roster, not query results, so missing agents are visible. */
function AgentFreshnessPanel({
  read,
}: {
  /* The whole read, not just the rows. A panel handed only rows cannot tell
     "nothing has ever run" from "nobody is signed in", which is the one
     distinction this page cannot afford to lose. */
  readonly read: AgentRunsRead;
}): ReactElement {
  /* Null exactly when the read produced a real answer. Any other value is the
     shared phrase for why it did not - one vocabulary across the console, from
     one function, so "not signed in" always reads the same. */
  const unreadable = describeEmptyState(read.state);

  /* Keyed for lookup inside the roster loop. `summarizeAgentRuns` already
     returns one entry per agent in roster order, so this map is complete
     whenever the read was conclusive and empty otherwise - which is why the
     loop below can treat a missing entry as "the console does not know" rather
     than as "this agent never ran". */
  const byAgent = new Map(read.freshness.map((entry) => [entry.agent, entry]));

  return (
    <section className="panel">
      <h2 className="panel__title">Agent freshness</h2>
      <p className="panel__note">
        Read the AGE column, not the outcome. A job that stopped a month ago
        still has a perfectly successful last run, so &quot;succeeded&quot; on
        its own tells you nothing about whether anything is still happening.
      </p>

      {read.measuredAt === null || unreadable !== null ? (
        <p className="panel__note">
          No ages available: {unreadable ?? 'read has not completed'}.
        </p>
      ) : (
        <p className="panel__note">
          Measured at{' '}
          <span className="identifier">
            {new Date(read.measuredAt).toISOString()}
          </span>
          . Reload to re-measure.
        </p>
      )}

      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              {/* Agent first: the operator scans for a name he knows should
                  have run today. */}
              <th scope="col">Agent</th>
              {/* The expected cadence sits next to the age so a gap can be
                  judged without memorising the schedule. */}
              <th scope="col">Expected</th>
              {/* THE LOAD-BEARING COLUMN, and named for what it measures.
                  "Silent for" cannot be misread as an outcome the way a
                  "Status" column can. */}
              <th scope="col">Silent for</th>
              {/* The second clock: proof that work happened, as opposed to
                  proof that the scheduler fired. */}
              <th scope="col">Last success</th>
              {/* The two clocks in one sentence, because the pair of them is
                  what determines the operator's next action. */}
              <th scope="col">What that means</th>
            </tr>
          </thead>
          <tbody>
            {AGENT_NAMES.map((agent) => {
              /* Undefined whenever the read was not conclusive. Deliberately
                 NOT defaulted to a never-run entry: "we could not ask" and
                 "it has never run" are opposite claims. */
              const entry = byAgent.get(agent);
              /* The cadence comes from the pure module either way, so the
                 expected-schedule column is honest even with no data at all -
                 it describes configuration, not state. */
              const cadence = AGENT_CADENCE[agent];
              /* Computed once per row: the render below needs both the null
                 test and the text, and two calls could drift apart. */
              const runErrors =
                entry === undefined ? null : describeRunErrors(entry.lastRun);

              return (
                <tr
                  key={agent}
                  /* Emphasis only, never filtering. Hiding a healthy row would
                     make this page unable to prove it looked at everything. */
                  className={
                    entry !== undefined && needsAttention(entry.verdict)
                      ? 'table__row--attention'
                      : undefined
                  }
                >
                  {/* The schema's own identifier, so the name here matches the
                      one in `agent_runs` and in a peer's message. */}
                  <th scope="row" className="table__id">
                    {agent}
                  </th>
                  <td>
                    {/* An unknown cadence is stated, not guessed. Guessing here
                        would produce a threshold nobody chose. */}
                    {cadence === undefined ? (
                      <span className="unknown">cadence not set</span>
                    ) : (
                      cadence.expected
                    )}
                  </td>

                  {/* Silent for: the heartbeat age. */}
                  <td>
                    {entry === undefined ? (
                      /* The read's own phrase, so an unknown age can never be
                         mistaken for a measured one. */
                      <span className="unknown">{unreadable}</span>
                    ) : entry.heartbeatAgeMs === null ? (
                      /* THE LOUDEST CASE. Not a dash, not a blank, not a zero:
                         an agent with no runs at all has never run once, and
                         that is the most alarming thing this table can say. */
                      <span className="table__never">never run</span>
                    ) : (
                      <span className="table__age">
                        {formatAge(entry.heartbeatAgeMs)}
                      </span>
                    )}
                  </td>

                  {/* Last success: the outcome clock, with its own age. */}
                  <td>
                    {entry === undefined ? (
                      <span className="unknown">{unreadable}</span>
                    ) : entry.successAgeMs === null ? (
                      /* Has run, has never succeeded - a real state, and a
                         different one from never having run. */
                      <span className="table__never">no success on record</span>
                    ) : (
                      <>
                        <span className="table__age">
                          {formatAge(entry.successAgeMs)} ago
                        </span>
                        {/* The timestamp itself, monospaced, because it is a
                            string the operator may paste into a SQL query when
                            the age tells him to go looking. */}
                        {entry.lastSuccess === null ? null : (
                          <span className="identifier">
                            {entry.lastSuccess.finished_at ??
                              entry.lastSuccess.started_at}
                          </span>
                        )}
                      </>
                    )}
                  </td>

                  {/* The verdict sentence, plus the crashed-run note when there
                      is one. */}
                  <td>
                    {entry === undefined ? (
                      <span className="unknown">nothing read</span>
                    ) : (
                      <>
                        <span>{describeVerdict(entry)}</span>
                        {/* Rendered only when the latest run succeeded with row
                            errors: a clean or unknown count is not a caveat, so
                            `null` renders nothing rather than a reassuring
                            "0 errors" nobody measured. */}
                        {runErrors === null ? null : (
                          /* Its own class: `table__stuck` means "opened and
                             never closed" and carries the Applier alarm
                             colour, so it must not be reused here. */
                          <span className="table__run-caveat">
                            {/* "Latest run" scopes the claim to one run, not
                                the agent's whole history. */}
                            Latest run {runErrors}.
                          </span>
                        )}
                        {/* Which rules this agent's newest closed run that
                            screened rows skipped - deliberately not
                            entry.lastRun, which may be idle or still open. */}
                        <RuleWarningsNote
                          run={read.ruleWarningRuns.get(agent) ?? null}
                        />

                        {/* A run that opened and never closed, older than a
                            whole cycle. For the Applier this is the
                            safety-critical case: a row left at `applying`
                            means nobody knows whether an application was
                            actually submitted, and submission is the one
                            non-idempotent action in the system. */}
                        {entry.stuckRun === null ? null : (
                          <span className="table__stuck">
                            A run opened{' '}
                            {formatAge(
                              /* Measured from `started_at`, since a run that
                                 never closed has no `finished_at` to measure
                                 from. */
                              (read.measuredAt ?? 0) -
                                Date.parse(entry.stuckRun.started_at),
                            )}{' '}
                            ago and never closed - that is a crash mid-run, not
                            work in progress.
                          </span>
                        )}
                      </>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/* Can this console reach a database at all?
 *
 * FIRST PANEL ON THE PAGE, because every other panel below it reports "not read
 * yet", and there are two completely different reasons that could be true: the
 * query is not written, or there is no connection to run it against. Leaving
 * the operator to guess between those is exactly the ambiguity this page exists
 * to remove.
 *
 * Note what is NOT possible here: a "connected" state with a service-role key.
 * That case throws at import time in `supabase.ts`.
 *
 * REACHABILITY, NOT CONFIGURATION. `supabaseStatus.connected` only means the
 * URL and anon key are SET - it is decided at import time, before any request.
 * This panel used to print "Connected" in green from that flag alone, and the
 * sweep caught it staying green while every read below it failed. So green is
 * now earned by the page's own read of `agent_runs` succeeding; a configured
 * client whose read failed says so, and one whose read has not settled says
 * only "Configured". */
function ConnectionPanel({
  read,
}: {
  /* The same read the freshness panels use, so this panel cannot claim a
     connection the tables below it just failed to use. */
  readonly read: AgentRunsRead;
}): ReactElement {
  /* The read's own outcome is the only evidence of reachability on this page. */
  const kind = read.state.kind;

  return (
    <section className="panel">
      <h2 className="panel__title">Database connection</h2>

      {supabaseStatus.connected ? (
        kind === 'rows' || kind === 'empty' ? (
          /* Green only here: a query went out and an answer came back, empty
             or not. That is a positive, measured claim of reachability. */
          <p className="panel__clear">
            Reachable: the agent_runs read succeeded with the anon key. Row
            access is decided by RLS.
          </p>
        ) : kind === 'failed' ? (
          /* Degraded, in the alarm palette, with the database's own message -
             the operator needs to know the reads below are failing, and why. */
          <p className="panel__degraded" role="alert">
            Configured, but unreachable: the agent_runs read failed (
            {read.state.kind === 'failed' ? read.state.message : ''}). Every
            panel below that reads the database is showing no data for this
            reason.
          </p>
        ) : (
          /* Loading or signed-out: a key exists but nothing has proved it
             works, so the label claims only what is known. */
          <p className="panel__note">
            Configured (URL and anon key are set). Reachability not yet
            confirmed: {describeEmptyState(read.state) ?? 'read has not completed'}.
          </p>
        )
      ) : (
        <>
          {/* Not a failure, and deliberately not styled as one - this is the
              normal state of a fresh clone. The six settings pages work
              regardless, which is why the console still opens. */}
          <p className="panel__note">
            Not configured, so nothing on this page can report real state. The
            settings pages still work - they describe configuration rather than
            read it.
          </p>
          <ul className="gaps">
            {supabaseStatus.missing.map((variable) => (
              /* Named individually. "Check your environment" sends someone to a
                 file to guess which line is wrong. */
              <li key={variable} className="gaps__item">
                <span className="identifier">{variable}</span>
                <span className="gaps__why">
                  Not set, or set to an empty value, in apps/web/.env.local.
                </span>
              </li>
            ))}
          </ul>
          {/* Says which key, because this is exactly the moment someone reaches
              for whichever key is on their clipboard. */}
          <p className="panel__note">
            The anon key only. A service-role key pasted here stops the console
            from starting at all, on purpose.
          </p>
        </>
      )}
    </section>
  );
}

/* The two scheduled things that keep the free tiers alive.
 *
 * These are not agents - they do no work - so they get their own panel. Their
 * only job is to be recent, and each of them is read from a DIFFERENT clock in
 * the same table, which is the point worth being careful about:
 *
 *   Supabase's pause clock measures ANY database activity, so the evidence is
 *   the newest run anywhere in the roster rather than one named agent's run.
 *   Reading a single agent here would let the console report "idle for 8 days"
 *   while another agent had written a row this morning.
 *
 *   GitHub's 60-day clock is reset by the `keepalive` workflow specifically, so
 *   its evidence IS one named agent - which is why `keepalive` has its own
 *   identity in `AGENT_NAMES` rather than borrowing one. A keepalive logging
 *   itself as, say, the Applier would produce a health page that lies
 *   confidently, and a confident lie is worse than a gap because a gap prompts
 *   somebody to look. */
function KeepalivePanel({
  read,
}: {
  readonly read: AgentRunsRead;
}): ReactElement {
  /* Null when the read produced a real answer; otherwise the shared phrase. */
  const unreadable = describeEmptyState(read.state);

  /* The newest run anywhere - the console's best available proxy for "when did
     something last touch this database". Its own module documents the honest
     limit: the console's own queries are activity too and are not recorded in
     `agent_runs`, so this over-estimates idleness. Over-estimating is the right
     direction for a warning to err in - it can cry wolf, it cannot miss a
     pause. */
  const anyActivity = newestHeartbeat(read.freshness);

  /* The GitHub keepalive, by name. Found by lookup rather than by position so a
     roster reorder cannot silently point this panel at a different agent. */
  const keepalive = read.freshness.find((entry) => entry.agent === 'keepalive');

  return (
    <section className="panel">
      <h2 className="panel__title">Keepalives</h2>
      <p className="panel__note">
        Both of these exist to stop a free tier switching itself off. Neither
        does any useful work, so the only thing worth knowing about them is when
        each last ran.
      </p>

      <ul className="keepalive">
        <li className="keepalive__item">
          <span className="keepalive__what">Supabase project activity</span>
          <span className="keepalive__why">
            Prevents database auto-pause by tracking periodic agent activity.
          </span>
          {unreadable !== null ? (
            <span className="unknown">{unreadable}</span>
          ) : anyActivity === null ? (
            <span className="table__never">No agent activity recorded</span>
          ) : (
            <span className="table__age">
              last activity {formatAge(anyActivity.ageMs)} ago, by{' '}
              <span className="identifier">{anyActivity.agent}</span>
            </span>
          )}
        </li>
        <li className="keepalive__item">
          <span className="keepalive__what">GitHub scheduled workflows</span>
          <span className="keepalive__why">
            Ensures GitHub Actions cron schedules stay active.
          </span>
          {unreadable !== null ? (
            <span className="unknown">{unreadable}</span>
          ) : keepalive === undefined ||
            keepalive.heartbeatAgeMs === null ? (
            <span className="table__never">Never run</span>
          ) : (
            <span className="table__age">
              {formatAge(keepalive.heartbeatAgeMs)} ago
            </span>
          )}
        </li>
      </ul>
    </section>
  );
}

/* The Gemini key pool. */
function GeminiPoolPanel(): ReactElement {
  return (
    <section className="panel">
      <h2 className="panel__title">Gemini Key Pool</h2>
      <p className="panel__note">
        Automated key rotation and backoff across configured Gemini API credentials.
      </p>
    </section>
  );
}

/* MANUAL CONTROL COVERAGE - a first-class panel, and now an honest one.
 *
 * WHY IT IS FIRST-CLASS rather than a footnote: this is the one defect class
 * the operator has no other way to notice. Rows enter a status, no automation
 * can move them, no screen offers the move, and they sit there forever looking
 * like they are merely in progress. Section 14's lesson applied to the console
 * itself - the failure does not error, it just stalls.
 *
 * WHY IT WAS REWRITTEN, and this is the interesting part. The previous version
 * rendered one list: human-reachable edges whose source status NO SCREEN
 * CLAIMS. That list is empty, and it was empty for a reason that has nothing to
 * do with coverage - every status is claimed, and four of the claiming screens
 * DO NOT EXIST. So the panel said "every human-reachable transition has a
 * screen that offers it" while eight edges on the submit boundary had no screen
 * behind the claim and not one control in the console could perform any
 * transition at all.
 *
 * A FALSE ALL-CLEAR IS WORSE THAN NO CHECK. A missing check prompts somebody to
 * look; a green check tells them not to. So the panel now reports a PARTITION
 * of the human-reachable edges - unclaimed, claimed-but-unbuilt, visible-but-
 * inoperable, and actually operable - and the four numbers sum to the graph's
 * own total, which is what makes the report auditable rather than assertable.
 *
 * The operable count is shown even when it is zero (it was, until the write
 * path landed on 2026-10-08/09). A report that only
 * ever counts problems cannot be told apart from one whose predicate is
 * inverted; a report that also counts successes can.
 */
function ControlCoveragePanel(): ReactElement {
  /* The graph's own total, so the arithmetic below is checkable on screen
     rather than trusted. If these four buckets ever stopped summing to it, the
     partition would have a hole and the panel would be back to guessing. */
  const total = HUMAN_REACHABLE_LANES.length;

  return (
    <section className="panel">
      <h2 className="panel__title">Manual control coverage</h2>
      <p className="panel__note">
        Live coverage of manual workflow transitions across {total} permitted human actions.
      </p>

      {/* The same scroll container the freshness table above uses, and it was
          missing here. Without it this table sets its own intrinsic width and
          pushes the whole PAGE sideways on a narrow window - which loses the
          nav rail rather than scrolling one table. The rule this restores:
          a table scrolls inside its own container, never the page body. */}
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th scope="col">Coverage</th>
              <th scope="col">Edges</th>
              <th scope="col">What it means for the operator</th>
            </tr>
          </thead>
          <tbody>
            {/* Worst first. The order is the order of exposure, not the order the
                sets happen to be declared in. */}
            <tr
              className={
                MISSING_HUMAN_CONTROLS.length > 0
                  ? 'table__row--attention'
                  : undefined
              }
            >
              <th scope="row" className="table__id">
                no screen claims it
              </th>
              <td className="table__count">{MISSING_HUMAN_CONTROLS.length}</td>
              <td>
                Rows can reach the source status and never leave it by hand. This
                is the check that fires when the schema stream adds a
                human-reachable edge nobody has given a home.
              </td>
            </tr>

            <tr
              className={
                UNBUILT_HUMAN_CONTROLS.length > 0
                  ? 'table__row--attention'
                  : undefined
              }
            >
              <th scope="row" className="table__id">
                claimed by a screen that does not exist
              </th>
              <td className="table__count">{UNBUILT_HUMAN_CONTROLS.length}</td>
              <td>
                Strictly worse than the row above: the status is claimed, so the
                old check passed, and yet no screen renders these rows at all.
                They are not merely unmovable, they are invisible.
              </td>
            </tr>

            <tr>
              <th scope="row" className="table__id">
                visible, control disabled
              </th>
              <td className="table__count">{INOPERABLE_HUMAN_CONTROLS.length}</td>
              <td>
                A screen shows the move, built from{' '}
                <span className="identifier">nextStatuses(status, 'human')</span>,
                but the button cannot fire: either no screen writes from that
                status yet, or the move is held on purpose (shown with its
                reason beside the button).
              </td>
            </tr>

            <tr>
              <th scope="row" className="table__id">
                operable today
              </th>
              <td className="table__count">{OPERABLE_HUMAN_CONTROLS.length}</td>
              <td>
                Transitions a person can actually perform in this console. Shown
                even at zero, because a coverage report that only counts problems
                is indistinguishable from one whose predicate is inverted.
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      {/* The unclaimed set, listed edge by edge when it is non-empty. Normally
          empty - and when it is not, the graph's own note on each edge is the
          most useful sentence available about why it matters. */}
      {MISSING_HUMAN_CONTROLS.length > 0 ? (
        <ul className="gaps">
          {MISSING_HUMAN_CONTROLS.map((transition) => (
            /* `from`+`to` is the natural key of an edge, so it is a stable
               React key without inventing an id. */
            <li
              key={transition.from + '->' + transition.to}
              className="gaps__item"
            >
              <span className="identifier">
                {transition.from} &rarr; {transition.to}
              </span>
              <span className="gaps__why">{transition.note}</span>
            </li>
          ))}
        </ul>
      ) : null}

      {/* The unbuilt set, always listed when non-empty, because these are the
          eight the operator is actually exposed to right now. Named
          individually rather than counted: "eight edges" sends nobody
          anywhere, whereas `applying -> needs_verification` names the exact
          row that would be stuck. */}
      {UNBUILT_HUMAN_CONTROLS.length > 0 ? (
        <>
          <h3 className="panel__subtitle">
            Claimed by a screen nobody has written yet
          </h3>
          <ul className="gaps">
            {UNBUILT_HUMAN_CONTROLS.map((transition) => (
              <li
                key={transition.from + '->' + transition.to}
                className="gaps__item"
              >
                <span className="identifier">
                  {transition.from} &rarr; {transition.to}
                </span>
                <span className="gaps__why">{transition.note}</span>
              </li>
            ))}
          </ul>
        </>
      ) : (
        /* Said out loud, and said as a derived claim rather than a promise:
           what is asserted is that the check ran and found nothing. */
        <p className="panel__clear">
          Every claimed screen exists. Whether its control can fire is the row
          above.
        </p>
      )}
    </section>
  );
}

/* The blocked queue.
 *
 * Constraint 5 forbids circumventing captchas and anti-bot walls, so hitting
 * one is a normal outcome rather than a failure: the worker screenshots the
 * wall, parks the row and moves on. Because Actions runs with no human present,
 * this is expected daily traffic - which is why it gets a real work queue with
 * a "take it from here" hand-off instead of an error log. */
/* --- Operator Human Recovery Lane Controls ----------------------------- */

/* Stuck Submission Queue: status `applying`
 * Stale leases where the worker died mid-submission.
 * Human or sweeper advances to `needs_verification`. */
function StuckSubmissionQueuePanel(): ReactElement {
  return (
    <section className="panel" aria-label="Stuck submission recovery queue">
      <h2 className="panel__title">Stuck Submission Recovery (<span className="identifier">applying</span>)</h2>
      <p className="panel__note">
        Safety-critical recovery queue. A stale application lease indicates the worker
        died mid-submit. If the automated Sweeper is inactive, the operator can manually
        advance the stalled submission to verification.
      </p>
      {/* The stuck rows with working moves (2026-10-09); was a disabled edge list. */}
      <RecoveryQueue status="applying" verb={(to) => `Advance to ${to}`} />
    </section>
  );
}

/* Needs Verification Queue: status `needs_verification`
 * Human-only gate back to `approved` or to `applied` or `failed`.
 * A machine must never guess if an application landed. */
function NeedsVerificationQueuePanel(): ReactElement {
  return (
    <section className="panel" aria-label="Needs verification queue">
      <h2 className="panel__title">Needs Verification Queue (<span className="identifier">needs_verification</span>)</h2>
      <p className="panel__note">
        Human gate for questionable submissions. Requires manual inspection of the ATS
        confirmation or screenshot. Moves to <span className="identifier">applied</span> if confirmed,
        <span className="identifier">approved</span> to retry submission, or <span className="identifier">failed</span>.
        The retry (<span className="identifier">approved</span>) is held: under automatic submission it
        would send the application again.
      </p>
      {/* -> approved renders disabled with its reason (humanLanes.ts HELD_HUMAN_EDGES). Each row shows
          why it is here and its apply link, so the operator can check the portal or finish it by hand;
          the buttons use the manual-action wording ("I applied", "Failed / skip") shared with the blocked queue. */}
      <RecoveryQueue status="needs_verification" verb={manualActionVerb} meaning={manualActionMeaning} />
    </section>
  );
}

/* Blocked Queue: status `blocked_needs_human`
 * Captcha, Cloudflare, or anti-bot challenge parked applications. */
function BlockedQueuePanel(): ReactElement {
  return (
    <section className="panel" aria-label="Blocked queue">
      <h2 className="panel__title">Blocked, Needs Operator Action (<span className="identifier">blocked_needs_human</span>)</h2>
      <p className="panel__note">
        Applications parked when hitting anti-bot walls, captchas, or custom portal auth.
        Constraint #5 strictly prohibits automated bypass; finish manually and record outcome.
      </p>
      {/* The three resolutions, in the same manual-action wording as the verification queue; each row
          shows its block reason and apply link, so a captcha-blocked application can be finished by hand. */}
      <RecoveryQueue status="blocked_needs_human" verb={manualActionVerb} meaning={manualActionMeaning} />
    </section>
  );
}

/* Failed Rows Recovery: status `failed`
 * Submissions that crashed or threw fatal errors. Moves to `needs_verification`. */
function FailedRowsPanel(): ReactElement {
  return (
    <section className="panel" aria-label="Failed rows queue">
      <h2 className="panel__title">Failed Submission Recovery (<span className="identifier">failed</span>)</h2>
      <p className="panel__note">
        Submissions that encountered runtime errors or DOM submission rejections.
        The only edge out leads to <span className="identifier">needs_verification</span> so an operator
        reviews failure diagnostics before re-queueing.
      </p>
      {/* One move out: back to verification, never straight to a retry. */}
      <RecoveryQueue status="failed" verb={(to) => `Send to ${to}`} />
    </section>
  );
}

/* STATUS GRAPH CYCLE OBSERVABILITY - active warning indicator.
 *
 * Discovered by graph engineering analysis (docs/architecture/graph-engineering.md §3.1).
 * The machine-reachable status transition graph contains an unbounded 2-cycle:
 *   oa_pending -> interview  (allowedAgents: ['tracker', 'human'])
 *   interview  -> oa_pending (allowedAgents: ['tracker', 'human'])
 *
 * Why this warning is active:
 * Both edges are legitimate: post-interview assessments really happen. However,
 * tracker classifies inbound emails autonomously via Gemini. Because there is no
 * traversal bound, loop count, or status_history hysteresis on this pair, an
 * oscillating or noisy classifier can cycle a candidate application indefinitely.
 * This panel monitors and surfaces that cycle risk.
 */
function StatusGraphCyclePanel(): ReactElement {
  return (
    <section className="panel" aria-label="Status graph cycle warning">
      <h2 className="panel__title">Status graph cycle observability</h2>
      <p className="panel__note">
        Active surveillance of automated feedback cycles. Monitored to catch unbounded
        oscillation between assessment and interview stages.
      </p>

      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th scope="col">Cycle</th>
              <th scope="col">Acting Agent</th>
              <th scope="col">Warning & Invariant Status</th>
            </tr>
          </thead>
          <tbody>
            <tr className="table__row--attention">
              <th scope="row" className="table__id">
                oa_pending &harr; interview
              </th>
              <td>
                <span className="identifier">tracker</span>
              </td>
              <td>
                <strong className="table__never">Active Warning: Unbounded automated cycle.</strong>{' '}
                Both transitions permit the automated <span className="identifier">tracker</span> agent.
                No traversal counter or rate limit bounds how many times a fluctuating model classification
                on a noisy recruiter email thread can walk this edge pair.
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  );
}

/* --- The page --------------------------------------------------------- */

export function HealthPage(): ReactElement {
  /* ONE READ FOR THE WHOLE PAGE, shared by the freshness table and the
     keepalive panel. Two hooks reading `agent_runs` would be two round trips on
     a free tier and - worse - two chances for the panels to disagree about what
     is going on, which on this page is the failure it exists to prevent. */
  const agentRuns = useAgentRuns();

  return (
    <div className="page">
      <PageHeader path="health" />

      <p className="panel__note panel__note--lead">
        Pipeline health, agent heartbeat freshness, and connectivity surveillance.
      </p>

      {/* Order is deliberate: the two silent deaths first, then the things that
          are merely waiting, then the console's own coverage gaps, then the
          work queue. Freshness before workload. */}
      {/* Connection first: several panels below can only report why they have
          no data, and this is what says whether that is because the query is
          unwritten or because there is nothing to query. */}
      <ConnectionPanel read={agentRuns} />
      {/* The two panels that read real rows, both from the same read. */}
      <AgentFreshnessPanel read={agentRuns} />
      <KeepalivePanel read={agentRuns} />
      <GeminiPoolPanel />
      <ControlCoveragePanel />
      {/* Active cycle observer: surfaces the unbounded oa_pending <-> interview cycle */}
      <StatusGraphCyclePanel />
      {/* Operator recovery lane controls */}
      <StuckSubmissionQueuePanel />
      <NeedsVerificationQueuePanel />
      <BlockedQueuePanel />
      <FailedRowsPanel />
    </div>
  );
}
