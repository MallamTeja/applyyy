/* The pipeline board - PROJECT_PLAN.md section 15, row "Pipeline".
 *
 * WHAT THIS SCREEN IS FOR. Every application the system has opened lives in
 * exactly one status, and this board is where the operator sees which. It
 * REPORTS; it does not drive. The email Tracker advances post-apply statuses on
 * its own and Supabase Realtime pushes those changes here, so live tracking is
 * close to free - the board just re-renders what the database already decided.
 *
 * WHY THE COLUMNS ARE DERIVED AND NOT LISTED. The obvious implementation is an
 * array of column names in this file. That array would be a second definition
 * of the workflow, and the moment the schema stream adds a status the board
 * silently stops showing those rows - they exist, they are just in no column,
 * which is the invisible-stall failure section 14 is entirely about. So the
 * columns come from `APPLICATION_STATUSES` and the per-card actions from
 * `nextStatuses(status, 'human')`. Naming the pattern: the status graph is the
 * single source of truth and every consumer - the database trigger, the agents,
 * this board - is a READER of it. A reader that keeps its own copy is not a
 * reader.
 *
 * WHY A BOARD THE TRACKER DRIVES STILL NEEDS MANUAL CONTROLS. Because the
 * Tracker is a scheduled job, and section 14's lesson is that scheduled jobs do
 * not fail, they stop. If Gmail forwarding breaks or Apps Script is disabled,
 * the Tracker advances nothing and every post-apply row needs a hand. The four
 * post-apply edges are `['tracker','human']` in the graph - a human is
 * PERMITTED on all of them - so the board offers them rather than assuming the
 * automation is alive.
 */

import type { ReactElement } from 'react';

import { PageHeader } from '../../app/PageHeader';
import { StatusBadge } from '../../app/StatusBadge';
/* Enum and helpers imported rather than restated - see the note above about
   readers keeping copies. `contract.ts` is the only domain-type import surface
   anywhere under apps/web. */
import { APPLICATION_STATUSES, isTerminal, nextStatuses } from '../../data/contract';
import type { ApplicationStatus } from '../../data/contract';
/* Whether any screen claims the human transitions out of a status, so a column
   whose manual moves have no home can say so. */
import { humanControlLocation, isHumanOnlyLane } from '../../data/humanLanes';
/* The first real read in this console: counts per status. Read-only, and it
   deliberately cannot express a fabricated zero - see readState.ts. */
import { useApplicationCounts } from '../../data/useApplicationCounts.ts';
import { describeEmptyState } from '../../data/readState.ts';
import type { ReadState } from '../../data/readState.ts';

import './pipeline.css';

/* --- How the columns are grouped ------------------------------------- */

/* The board has three lanes of meaning, and collapsing them would make it
 * unreadable: a row waiting for the operator is urgent, a row moving through
 * the machine is informational, and a finished row is history. Grouping by
 * meaning rather than showing eighteen equal columns is what keeps the eye on
 * the ones that need something. */
type BoardGroup = 'needs_you' | 'in_flight' | 'closed';

/* Statuses where the operator is the actor rather than the audience. These are
 * the only columns that should draw the eye. */
const NEEDS_YOU: readonly ApplicationStatus[] = [
  /* THE approval gate. `awaiting_approval -> approved` is human-only and is the
     only door into the submit path, so this column is the product. */
  'awaiting_approval',
  /* The Auditor flagged something and a person has to rule on it. */
  'audit_flagged',
  /* Captcha, login wall or an unanswerable question - the worker parked the row
     and screenshotted it. Normal daily traffic, not a failure. */
  'blocked_needs_human',
  /* SAFETY-CRITICAL. Submission is the one non-idempotent action in the system,
     so a row that may or may not have been sent is a person's problem only. */
  'needs_verification',
];

/* Statuses the machine owns. Shown so the operator can watch work move, but
 * deliberately quiet - nothing here is asking for anything. */
const IN_FLIGHT: readonly ApplicationStatus[] = [
  'discovered',
  'deduped',
  'passed_filters',
  'scored',
  'tailored',
  'approved',
  'applying',
  'applied',
  'employer_screening',
  'oa_pending',
  'interview',
];

/* Which lane a status belongs in.
 *
 * The fallback is the important part: anything the two lists above do not name
 * is filed as closed when the graph calls it terminal and as in-flight
 * otherwise. So a status added upstream lands in a sensible column with no edit
 * here, and never disappears. */
function groupOf(status: ApplicationStatus): BoardGroup {
  /* Operator-facing first - these are the ones with a cost to missing. */
  if (NEEDS_YOU.includes(status)) return 'needs_you';
  /* Then the machine's own lanes. */
  if (IN_FLIGHT.includes(status)) return 'in_flight';
  /* `isTerminal` is the graph's answer rather than this file's opinion, so a
     status that becomes an endpoint upstream is filed as history for free. */
  if (isTerminal(status)) return 'closed';
  /* Unknown and non-terminal: render it as live work rather than hide it. An
     unexpected column is a visible question; a missing one is a silent stall. */
  return 'in_flight';
}

/* Lane headings plus the reason each lane exists, in the operator's words. */
const GROUP_COPY: Readonly<Record<BoardGroup, { title: string; note: string }>> = {
  needs_you: {
    title: 'Action Required',
    note: 'Applications requiring human approval, manual review, or verification.',
  },
  in_flight: {
    title: 'In Flight',
    note: 'Applications progressing through discovery, tailoring, submission, and tracking.',
  },
  closed: {
    title: 'Closed',
    note: 'Terminal pipeline stages (accepted, rejected, expired).',
  },
};

/* Column order within a lane follows `APPLICATION_STATUSES`, which is the
 * schema's own ordering, so the board reads in workflow order without this file
 * asserting an order of its own. */
function columnsFor(group: BoardGroup): readonly ApplicationStatus[] {
  return APPLICATION_STATUSES.filter((status) => groupOf(status) === group);
}

/* --- One column ------------------------------------------------------- */

function StatusColumn({
  status,
  count,
  readState,
}: {
  readonly status: ApplicationStatus;
  /* Undefined means this status had no rows in a read that DID succeed, or that
     no successful read happened at all. Which of those it is comes from
     `readState`, never from the absence itself - that ambiguity is the bug the
     read layer exists to prevent. */
  readonly count: number | undefined;
  /* Passed down rather than read per column: one query feeds the whole board,
     and eighteen columns each classifying their own read would be eighteen
     chances to disagree about what is going on. */
  readonly readState: ReadState<unknown>;
}): ReactElement {
  /* The manual moves out of this status, asked of the graph at render time.
     This is the line that makes the board follow a schema change rather than
     need updating after one. */
  const humanMoves = nextStatuses(status, 'human');
  /* Where the operator is meant to perform those moves. A status no screen
     claims is a coverage gap, and saying so on the board itself is more use
     than a console warning nobody reads. */
  const controlHome = humanControlLocation(status);
  /* Terminal columns get no action affordances - offering a button the database
     would refuse is worse than offering none. */
  const terminal = isTerminal(status);

  return (
    <section
      /* Terminal columns are dimmed rather than hidden: hiding them would make
         "where did that application go" unanswerable. */
      className={terminal ? 'column column--terminal' : 'column'}
    >
      <header className="column__head">
        <h3 className="column__title">
          <StatusBadge status={status} />
        </h3>
        {/* THE HONEST COUNT. A number appears only when a read actually
            completed; otherwise the column shows WHY it has no number, in words.
            Never a bare 0 - "nobody is signed in" and "no applications in this
            status" are opposite claims that a zero renders identically, and the
            operator would act on the wrong one. */}
        {readState.kind === 'rows' || readState.kind === 'empty' ? (
          <span className="column__count">
            {/* An absent key in a successful read genuinely means none in this
                status, so a zero here is earned rather than assumed. */}
            {count ?? 0}
          </span>
        ) : (
          <span
            className="column__count column__count--unknown"
            /* The phrase is short enough to sit in the column head, and the
               title carries it in full for a narrow column. */
            title={describeEmptyState(readState) ?? undefined}
          >
            {/* One shared vocabulary across the console: the same state always
                produces the same words, from one function. */}
            {readState.kind === 'loading'
              ? '…'
              : readState.kind === 'no_session'
                ? 'not signed in'
                : readState.kind === 'failed'
                  ? 'read failed'
                  : 'not connected'}
          </span>
        )}
      </header>

      {/* The moves out of here, listed rather than mocked up as drag targets:
          the board is read-only until the write path is built and reviewed, and
          an affordance that looks live but is not is its own kind of lie. */}
      {humanMoves.length > 0 && (
        <ul className="column__moves">
          {humanMoves.map((target) => (
            <li
              key={target}
              /* Human-ONLY edges get the prominent treatment because a person is
                 the only actor that will ever move them. Edges shared with an
                 agent are quieter: normally the agent handles them and this
                 control is for when it has died. */
              className={
                isHumanOnlyLane(status, target)
                  ? 'move move--human-only'
                  : 'move move--fallback'
              }
            >
              {/* Disabled, and honestly so - the write path does not exist. */}
              <button type="button" className="move__button" disabled>
                Move to {target}
              </button>
            </li>
          ))}
        </ul>
      )}

      {/* A status with human-reachable edges and no owning screen is exactly the
          defect `MISSING_HUMAN_CONTROLS` exists to catch, reported next to the
          column it affects. */}
      {humanMoves.length > 0 && controlHome === null && (
        <p className="column__gap">
          No screen claims the manual moves out of this status, so rows can enter
          it and never leave by hand.
        </p>
      )}
    </section>
  );
}

/* --- The page --------------------------------------------------------- */

export function PipelinePage(): ReactElement {
  /* One read for the whole board. */
  const { state, counts } = useApplicationCounts();

  return (
    <div className="page">
      <PageHeader path="pipeline" />

      {/* Stated before anything else, because a board full of columns looks
          live. It is not, and the operator must not plan a day around it. */}
      <p className="not-wired">
        The columns, and the moves out of each, are read from the status graph -
        so this layout matches the real workflow. Counts are now read from{' '}
        <span className="identifier">applications</span>, but every control is
        still disabled: this board reports and does not write. No control on this
        page will ever fire{' '}
        <span className="identifier">awaiting_approval &rarr; approved</span> -
        that edge belongs to the approval queue, and to a person.
      </p>

      {/* Shown whenever a number is on screen, because a number invites a
          conclusion. The policies are confirmed to exist and have never been
          exercised as `authenticated` - every verifying query ran as
          `postgres`, which holds BYPASSRLS - so a count is evidence that the
          database answered, not that it answered with the right rows. */}
      {(state.kind === 'rows' || state.kind === 'empty') && (
        <p className="contract-gap">
          <strong>These counts are not yet trustworthy.</strong> Row-level
          security is confirmed to exist but has never been exercised as{' '}
          <span className="identifier">authenticated</span>, so a policy with an
          inverted predicate would produce numbers that look perfectly
          reasonable. Treat what follows as proof the query ran, not as proof it
          returned your rows.
        </p>
      )}

      {(['needs_you', 'in_flight', 'closed'] as const).map((group) => (
        <section key={group} className="lane">
          <h2 className="lane__title">{GROUP_COPY[group].title}</h2>
          <p className="lane__note">{GROUP_COPY[group].note}</p>
          <div className="lane__columns">
            {columnsFor(group).map((status) => (
              <StatusColumn
                key={status}
                status={status}
                count={counts[status]}
                readState={state}
              />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
