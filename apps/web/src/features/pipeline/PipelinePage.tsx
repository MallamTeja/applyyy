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

import { useState } from 'react';
import type { ReactElement } from 'react';

import { PageHeader } from '../../app/PageHeader';
import { StatusBadge } from '../../app/StatusBadge';
import { APPLICATION_STATUSES, isTerminal, nextStatuses } from '../../data/contract';
import type { ApplicationStatus } from '../../data/contract';
import { humanControlLocation, isHumanOnlyLane } from '../../data/humanLanes';
import { useApplicationCounts } from '../../data/useApplicationCounts.ts';
import { describeEmptyState } from '../../data/readState.ts';
import type { ReadState } from '../../data/readState.ts';
import { PipelineDrawer } from './PipelineDrawer';
import { DiscoveryModal } from './DiscoveryModal';

import './pipeline.css';

/* --- How the columns are grouped ------------------------------------- */

type BoardGroup = 'needs_you' | 'in_flight' | 'closed';

const NEEDS_YOU: readonly ApplicationStatus[] = [
  'awaiting_approval',
  'audit_flagged',
  'blocked_needs_human',
  'needs_verification',
];

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

function groupOf(status: ApplicationStatus): BoardGroup {
  if (NEEDS_YOU.includes(status)) return 'needs_you';
  if (IN_FLIGHT.includes(status)) return 'in_flight';
  if (isTerminal(status)) return 'closed';
  return 'in_flight';
}

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

function columnsFor(group: BoardGroup): readonly ApplicationStatus[] {
  return APPLICATION_STATUSES.filter((status) => groupOf(status) === group);
}

/* --- One column ------------------------------------------------------- */

function StatusColumn({
  status,
  count,
  readState,
  onOpenDrawer,
}: {
  readonly status: ApplicationStatus;
  readonly count: number | undefined;
  readonly readState: ReadState<unknown>;
  readonly onOpenDrawer: (status: ApplicationStatus) => void;
}): ReactElement {
  const humanMoves = nextStatuses(status, 'human');
  const controlHome = humanControlLocation(status);
  const terminal = isTerminal(status);

  return (
    <section className={terminal ? 'column column--terminal' : 'column'}>
      <header
        className="column__head column__head--interactive"
        onClick={() => onOpenDrawer(status)}
        title={`View applications in ${status}`}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onOpenDrawer(status);
          }
        }}
      >
        <h3 className="column__title">
          <StatusBadge status={status} />
        </h3>
        {readState.kind === 'rows' || readState.kind === 'empty' ? (
          <span className="column__count">{count ?? 0}</span>
        ) : (
          <span
            className="column__count column__count--unknown"
            title={describeEmptyState(readState) ?? undefined}
          >
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

      {humanMoves.length > 0 && (
        <ul className="column__moves">
          {humanMoves.map((target) => (
            <li
              key={target}
              className={
                isHumanOnlyLane(status, target)
                  ? 'move move--human-only'
                  : 'move move--fallback'
              }
            >
              <button type="button" className="move__button" disabled>
                Move to {target}
              </button>
            </li>
          ))}
        </ul>
      )}

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
  const { state, counts, refetch } = useApplicationCounts();
  const [activeDrawerStatus, setActiveDrawerStatus] = useState<ApplicationStatus | null>(null);
  const [discoveryMode, setDiscoveryMode] = useState<'remote' | 'watchlist' | null>(null);

  return (
    <div className="page">
      <PageHeader path="pipeline" />

      {/* Operational Discovery Bar */}
      <div className="pipeline-dispatch-bar">
        <div className="pipeline-dispatch-bar__info">
          <span className="pipeline-dispatch-bar__label">Live Scouting Dispatch</span>
          <span className="pipeline-dispatch-bar__desc">
            Trigger autonomous job discovery across open-web international remote boards or your registered watchlist ATS boards.
          </span>
        </div>
        <div className="pipeline-dispatch-bar__actions">
          <button
            type="button"
            className="btn-dispatch btn-dispatch--remote"
            onClick={() => setDiscoveryMode('remote')}
          >
            🌍 Find Remote Jobs (Global)
          </button>
          <button
            type="button"
            className="btn-dispatch btn-dispatch--watchlist"
            onClick={() => setDiscoveryMode('watchlist')}
          >
            🏢 Scan Watchlist Boards
          </button>
          <button
            type="button"
            className="btn-dispatch btn-dispatch--refresh"
            onClick={refetch}
            title="Reload pipeline counts from database"
          >
            ↻ Refresh
          </button>
        </div>
      </div>

      {discoveryMode && (
        <DiscoveryModal
          mode={discoveryMode}
          onClose={() => setDiscoveryMode(null)}
          onRefresh={refetch}
          onOpenDiscovered={() => setActiveDrawerStatus('discovered')}
        />
      )}

      {activeDrawerStatus && (
        <PipelineDrawer
          status={activeDrawerStatus}
          count={counts[activeDrawerStatus] ?? 0}
          onClose={() => setActiveDrawerStatus(null)}
        />
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
                onOpenDrawer={(s) => setActiveDrawerStatus(s)}
              />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
