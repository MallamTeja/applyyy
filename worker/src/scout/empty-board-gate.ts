// The CLI scout's emptied-board decision, mirroring scout-ats/index.ts's boardWentEmpty branch.
//
// WHY: SmartRecruiters answers a NONEXISTENT token with 200 and an empty board. That
// parses clean and the identity guard reads it as no_signal, so without this gate the
// cron CLI recorded a successful poll — consecutive_failures reset to 0 and
// last_poll_job_count overwritten with 0 — and a dead token looked healthy forever.
// Pure, in its own module, because worker/src/cli/scout.ts runs main() on import.

// The shared predicate, so the CLI and scout-ats agree on what "went empty" means.
import { boardWentEmpty } from '../../../supabase/functions/_shared/ats/registry.ts';

// The three watchlist fields this decision reads.
export interface EmptyBoardGateBoard {
  // Named in the warning, so the log points at the row to check.
  readonly company_name: string;
  // The running failure count; an emptied board is a failing poll and must advance it.
  readonly consecutive_failures: number;
  // The posting count stored by the last SUCCESSFUL poll; null when there has been none.
  readonly last_poll_job_count: number | null;
}

// What scout.ts must do with the board. Same shape as identity-gate's decision, so the
// call site handles both refusals the same way.
export type EmptyBoardGateDecision =
  // Not an emptied board: carry on to the normal writes.
  | { readonly proceed: true }
  // An emptied board: write only the failure mark, then skip every other write.
  | {
      // The discriminator scout.ts branches on.
      readonly proceed: false;
      // Failure bookkeeping ONLY. last_poll_job_count is deliberately absent so it stays
      // the non-zero baseline and the board keeps failing until postings return.
      readonly watchlistUpdate: { readonly consecutive_failures: number; readonly last_polled_at: string };
      // Names the baseline, so the change is diagnosable from the log alone.
      readonly warning: string;
    };

// Decide for one board after its pages were read. The clock is passed in so the
// expected update is byte-comparable in tests.
export function emptyBoardGate(
  // The watchlist row the board was polled for.
  board: EmptyBoardGateBoard,
  // How many postings this poll found across all pages.
  postingCount: number,
  // The run clock, shared with every other write in this poll.
  now: Date,
): EmptyBoardGateDecision {
  // Postings present, or no non-zero baseline to compare against: not this gate's concern.
  if (!boardWentEmpty(board.last_poll_job_count, postingCount)) return { proceed: true };
  // Had postings last time, has none now: most often a token gone bad.
  return {
    // The caller must `continue` past every write for this board.
    proceed: false,
    // `|| 0` matches the CLI's other failure marks, which tolerate a null count from old rows.
    watchlistUpdate: { consecutive_failures: (board.consecutive_failures || 0) + 1, last_polled_at: now.toISOString() },
    // Same wording as scout-ats's summary, so both scouts' logs grep alike.
    warning: `Board went empty: last poll stored ${board.last_poll_job_count}, this poll found 0 — check the token`,
  };
}
