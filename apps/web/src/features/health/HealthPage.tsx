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
 *   - `MISSING_HUMAN_CONTROLS`, as a first-class panel. A human-reachable edge
 *     with no control is a stall the operator cannot see from anywhere else.
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
import type { AgentName } from '../../data/contract';
/* The coverage check, imported rather than recomputed. Its own file explains
   why the predicate is `.includes('human')` and not `=== ['human']`. */
import { MISSING_HUMAN_CONTROLS } from '../../data/humanLanes';

import './health.css';

/* --- Freshness thresholds -------------------------------------------- */

/* How long a given agent may be silent before silence means something is
 * wrong. This has to be per-agent, because the roster runs on wildly different
 * cadences: the Scout runs daily and a day of silence is already suspicious,
 * whereas the keepalive workflow is weekly by design and a two-day gap is
 * perfectly healthy. One global threshold would either cry wolf about the
 * keepalive or stay silent about a dead Scout for a week.
 *
 * Stated in hours as plain data so the numbers are reviewable in one place
 * rather than buried in comparisons. */
interface Cadence {
  /* What the operator should expect, in words - shown next to the age so a
     reported gap can be judged without knowing the schedule by heart. */
  readonly expected: string;
  /* Past this age, the agent is presumed dead rather than idle. */
  readonly staleAfterHours: number;
}

/* Keyed by `AgentName` and PARTIAL on purpose: an agent the schema adds and
 * this map does not describe still renders (with a stated unknown cadence)
 * instead of being dropped from the page. A missing cadence is a cosmetic gap;
 * a missing agent row is a silent death. */
const CADENCE: Readonly<Partial<Record<AgentName, Cadence>>> = {
  /* The two discovery agents are the top of the funnel. If these stop, every
     downstream agent has nothing to do and reports itself perfectly healthy
     while the pipeline runs dry - the exact failure that looks like success. */
  scout_ats: { expected: 'every morning', staleAfterHours: 30 },
  scout_aggregator: { expected: 'every morning', staleAfterHours: 30 },
  /* Deterministic, cheap, runs with discovery. */
  normalizer: { expected: 'every morning', staleAfterHours: 30 },
  /* No LLM at all. Most discovered jobs die here, which is what keeps the
     running cost near zero - so a dead Screener shows up as a surprising
     Gemini bill, not as an error. */
  screener: { expected: 'every morning', staleAfterHours: 30 },
  matcher: { expected: 'every morning', staleAfterHours: 30 },
  tailor: { expected: 'every morning', staleAfterHours: 30 },
  auditor: { expected: 'every morning', staleAfterHours: 30 },
  /* GitHub Actions plus Playwright rather than an Edge Function, and the only
     agent that performs a non-idempotent action. */
  applier: { expected: 'after each approval', staleAfterHours: 48 },
  /* Reads the mailbox through Apps Script. This is the one whose death is
     hardest to notice from the outside: applications still go out, they just
     never advance past `applied`, so the board looks merely quiet. */
  tracker: { expected: 'every few hours', staleAfterHours: 12 },
  /* Reclaims stale leases. If it stops, `applying` rows pile up - and that is
     the safety-critical status, so its silence is worth flagging early. */
  sweeper: { expected: 'every run', staleAfterHours: 24 },
};

/* --- Panels ----------------------------------------------------------- */

/* Last-successful-run per agent.
 *
 * Rendered from the roster rather than from the rows: an agent with NO rows at
 * all is the most alarming case there is - it has never run once - and a table
 * built from query results would simply omit it. So the roster drives the
 * table and a missing row is rendered as "never", loudly. */
function AgentFreshnessPanel(): ReactElement {
  return (
    <section className="panel">
      <h2 className="panel__title">Last successful run</h2>
      <p className="panel__note">
        Read the AGE column, not the outcome. A job that stopped a month ago
        still has a perfectly successful last run, so &quot;succeeded&quot; on
        its own tells you nothing about whether anything is still happening.
      </p>

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
              {/* The load-bearing column. */}
              <th scope="col">Last success</th>
              <th scope="col">Age</th>
            </tr>
          </thead>
          <tbody>
            {AGENT_NAMES.map((agent) => {
              /* Undefined for an agent the schema added and this page has not
                 been taught about - handled below rather than crashing. */
              const cadence = CADENCE[agent];
              return (
                <tr key={agent}>
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
                  {/* Both cells are unknown until `agent_runs` is queried, and
                      an unknown age must never render as "just now" - that
                      would be the single most dangerous default on this page. */}
                  <td>
                    <span className="unknown">not read yet</span>
                  </td>
                  <td>
                    <span className="unknown">&mdash;</span>
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

/* The two scheduled things that keep the free tiers alive.
 *
 * These are not agents - they do no work - so they get their own panel. Their
 * only job is to be recent. */
function KeepalivePanel(): ReactElement {
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
          {/* The mechanism is stated because the reason it matters is not
              obvious from the name: a paused project fails every query, so this
              keepalive is what stands between the operator and a dead app. */}
          <span className="keepalive__why">
            A free project pauses after one week idle. The daily Actions cron
            runs one database query purely so that clock never reaches a week.
          </span>
          <span className="unknown">not read yet</span>
        </li>
        <li className="keepalive__item">
          <span className="keepalive__what">GitHub scheduled workflows</span>
          <span className="keepalive__why">
            GitHub disables cron schedules after 60 days of repository
            inactivity - silently, and every scheduled agent stops with them. A
            weekly workflow touches a timestamp file to reset that counter.
          </span>
          <span className="unknown">not read yet</span>
        </li>
      </ul>
    </section>
  );
}

/* The Gemini key pool.
 *
 * On this page because quota exhaustion is NOT an error: when every key is
 * cooling, rows return to their previous status and wait for the next run.
 * Nothing fails and nothing is lost - which is exactly why it needs a display,
 * since from the outside it is indistinguishable from nothing happening. */
function GeminiPoolPanel(): ReactElement {
  return (
    <section className="panel">
      <h2 className="panel__title">Gemini key pool</h2>
      <p className="panel__note">
        The pool is reactive by design: it uses a key until the API returns 429,
        believes the <span className="identifier">retry_after</span> it is
        given, and moves to the next one. There is no hardcoded rate limit
        anywhere, because Google stopped publishing the free-tier numbers and a
        guessed limit breaks silently when they change it.
      </p>
      <p className="not-wired">
        Per-key state comes from{' '}
        <span className="identifier">gemini_key_state</span> and is not being
        read yet. Note that the quota date is stored in US/Pacific, not IST -
        Gemini resets on Pacific midnight, and an IST-dated counter would reset
        five and a half hours after the quota it tracks.
      </p>
    </section>
  );
}

/* Human-reachable edges no screen offers a control for.
 *
 * A FIRST-CLASS PANEL rather than a footnote, because this is the one defect
 * class the operator has no other way to notice: rows enter a status, no
 * automation can move them, no screen offers the move, and they sit there
 * forever looking like they are merely in progress.
 *
 * Empty is the good case and is stated positively - a blank panel would be
 * ambiguous between "no gaps" and "not checked". */
function MissingControlsPanel(): ReactElement {
  return (
    <section className="panel">
      <h2 className="panel__title">Manual controls the console is missing</h2>
      <p className="panel__note">
        Derived from the status graph at load time, so this check cannot go
        stale: it lists every transition a human is permitted to make whose
        source status no screen in this console claims. Non-empty means rows can
        reach a status and never leave it by hand.
      </p>

      {MISSING_HUMAN_CONTROLS.length === 0 ? (
        /* Said out loud, and said as a derived claim rather than a promise:
           what is being asserted is that the check ran and found nothing. */
        <p className="panel__clear">
          Every human-reachable transition has a screen that offers it.
        </p>
      ) : (
        <ul className="gaps">
          {MISSING_HUMAN_CONTROLS.map((transition) => (
            /* `from`+`to` is the natural key of an edge, so it is a stable
               React key without inventing an id. */
            <li key={transition.from + '->' + transition.to} className="gaps__item">
              <span className="identifier">
                {transition.from} &rarr; {transition.to}
              </span>
              {/* The graph's own note on the edge, which is usually the most
                  useful sentence available about why it matters. */}
              <span className="gaps__why">{transition.note}</span>
            </li>
          ))}
        </ul>
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
function BlockedQueuePanel(): ReactElement {
  return (
    <section className="panel">
      <h2 className="panel__title">Blocked, needs a person</h2>
      <p className="panel__note">
        These are not failures. Nothing in this system tries to defeat a captcha
        or an identity challenge, so a wall is simply where the automation stops
        and you carry on by hand - with the screenshot the worker captured, and
        a link straight to the form.
      </p>
      <p className="not-wired">
        Reads <span className="identifier">applications</span> where{' '}
        <span className="identifier">status = blocked_needs_human</span>, plus
        the screenshot from storage. Not wired up yet.
      </p>
      {/* Recorded in the UI, not just in a report to the orchestrator, because
          the operator is the one who will notice the consequence. The three
          question-shaped block reasons in the design brief need three different
          renderings - one writes an answer back to the bank, one asks for a
          confirmation, one is a decision about whether to apply at all - and
          the schema currently has one value covering all three. Rendering them
          identically would lose the write-back trigger, which is the entire
          value of an answer bank that grows itself. */}
      <p className="contract-gap">
        <strong>Schema gap, not a UI decision.</strong>{' '}
        <span className="identifier">BLOCK_REASONS</span> has a single{' '}
        <span className="identifier">unanswerable_question</span> value, and{' '}
        <span className="identifier">block_detail</span> carries only{' '}
        <span className="identifier">question_key</span>. Telling &quot;the
        profile has no answer&quot; apart from &quot;an answer exists but the
        match is uncertain&quot; and &quot;this cannot be answered
        honestly&quot; needs a sub-kind on{' '}
        <span className="identifier">block_detail</span>. Until the schema
        stream adds one, this queue can only say that a question stopped the
        run - not which of the three it was.
      </p>
    </section>
  );
}

/* --- The page --------------------------------------------------------- */

export function HealthPage(): ReactElement {
  return (
    <div className="page">
      <PageHeader path="health" />

      {/* The page's own thesis, stated at the top. Everything below is an
          instance of it. */}
      <p className="panel__note panel__note--lead">
        Nothing that kills this system fails loudly. Supabase pauses a free
        project after a week idle; GitHub disables scheduled workflows after 60
        days of repository inactivity. Neither errors - they stop. So read this
        page for ages and silences rather than for red marks.
      </p>

      {/* Order is deliberate: the two silent deaths first, then the things that
          are merely waiting, then the console's own coverage gaps, then the
          work queue. Freshness before workload. */}
      <AgentFreshnessPanel />
      <KeepalivePanel />
      <GeminiPoolPanel />
      <MissingControlsPanel />
      <BlockedQueuePanel />
    </div>
  );
}
