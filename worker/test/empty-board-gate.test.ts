// Tests for the CLI's emptied-board gate (worker/src/scout/empty-board-gate.ts).
//
// The fail-open these pin: SmartRecruiters answers a NONEXISTENT token with 200 and
// {"totalFound":0,"content":[]}. That parses clean and the identity guard reads it as
// no_signal, so before this gate the cron CLI recorded a SUCCESSFUL poll, reset
// consecutive_failures to 0 and stored last_poll_job_count = 0, and a dead token looked
// healthy forever. The gate mirrors scout-ats/index.ts's boardWentEmpty branch.
import { describe, expect, it } from 'vitest';
// The unit under test.
import { emptyBoardGate } from '../src/scout/empty-board-gate.ts';

// One fixed clock so the expected last_polled_at is byte-comparable.
const NOW = new Date('2026-10-24T07:00:00Z');
// A board that listed postings on its last successful poll (Nagarro's real size).
const WAS_FULL = { company_name: 'Nagarro', consecutive_failures: 1, last_poll_job_count: 585 };

describe('emptyBoardGate', () => {
  it('a board that had postings and now has none is a failure, never a success write', () => {
    const decision = emptyBoardGate(WAS_FULL, 0, NOW);
    // Nothing may be written for this board beyond the failure mark.
    expect(decision.proceed).toBe(false);
    if (decision.proceed) return;
    // Exactly the failure bookkeeping: NO poll_count, NO consecutive_failures reset, and
    // NO last_poll_job_count, which must stay the non-zero baseline so the board keeps
    // failing visibly on every later poll.
    expect(decision.watchlistUpdate).toEqual({ consecutive_failures: 2, last_polled_at: NOW.toISOString() });
    // The baseline is named, so the log says what changed without a re-poll.
    expect(decision.warning).toContain('585');
  });

  it('an empty board that was empty last time too is not a failure', () => {
    // 0 -> 0: no change to report; a genuinely quiet board stays healthy.
    expect(emptyBoardGate({ ...WAS_FULL, last_poll_job_count: 0 }, 0, NOW)).toEqual({ proceed: true });
  });

  it('a never-polled board (null baseline) that is empty is not a failure', () => {
    // No successful poll yet means no baseline to compare against.
    expect(emptyBoardGate({ ...WAS_FULL, last_poll_job_count: null }, 0, NOW)).toEqual({ proceed: true });
  });

  it('a board that shrank but still has postings proceeds', () => {
    // Fewer postings is normal churn; only reaching zero is the token signal.
    expect(emptyBoardGate(WAS_FULL, 3, NOW)).toEqual({ proceed: true });
  });
});
