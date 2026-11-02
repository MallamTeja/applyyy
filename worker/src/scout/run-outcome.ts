// How a scheduled ATS scout run ENDS: when it stops starting boards, and how it closes.
//
// WHY THIS EXISTS (W40, 2026-11-02). scout.yml's job timeout (then 15 min) killed both
// scheduled runs: 41334080711 and 41399027003 were cancelled after ~917 s in the scout step,
// 246 of 262 boards polled. Volume, not a stall: no board took over 19 s, but Workday boards
// at the 20-page cap take 12-19 s each. A killed run never closes its agent_runs row, so it
// read `running` until reaped ~6 h later and the workflow read `cancelled` twice a day.
// The fix stops STARTING boards once SCOUT_BUDGET_MS is spent, finishes the board in
// flight, and closes the run `succeeded` with a `deadline:` note.
//
// W12 (worker half). When the screener's context failed to load, scout.ts warned in the log,
// inserted rows at 'discovered', closed `succeeded` and exited 0: a green tick over a queue
// nothing screens on a schedule. scoutRunClose now counts it as an error named
// `screener_not_run: <reason>`, closes `failed` and returns exit code 1. The rows the
// fallback inserted are kept (rows_out still counts them): discovery is never thrown away.
//
// Pure on purpose: scout.ts runs main() on import and cannot be tested, so the decisions
// live here, with the clock injected through the shared Deadline.

// The shared countdown (and its outcome type) the matcher and tailor already use.
import { deadlineNote, type BatchOutcome, type Deadline } from '../../../supabase/functions/_shared/agent/deadline.ts';
// The one formatter every screening run uses to append rule warnings to error_detail.
import { withRuleWarnings } from '../../../supabase/functions/_shared/screen/run-summary.ts';

// 12 minutes, counted from main()'s start. Measured 2026-11-02: the scout step averages
// ~3.7 s per board (917 s / 246), so 12 min reaches ~190 boards; two runs a day give ~380
// board-polls against 262 enabled boards, and boards are read oldest-`last_polled_at` first,
// so a board skipped now goes first next run and none waits past ~24 h. The job timeout in
// .github/workflows/scout.yml (25 min) leaves ~13 min above this for setup (14 s measured)
// and the board in flight. Change the two together.
// ponytail: fixed constant; past ~380 enabled boards some wait >24 h, so raise this (and
// the timeout) or add a run then.
export const SCOUT_BUDGET_MS = 12 * 60_000;

// The boards a run may start, and a tally of how far it got.
export interface BudgetedBoards<T> {
  // Iterate with `for...of`; it ends early once the budget is spent.
  readonly boards: Iterable<T>;
  // Read after the loop: how many started, how many were left, and whether time ended it.
  outcome(): BatchOutcome;
}

// Gates a board list on the deadline. The check runs when the loop asks for the NEXT board,
// i.e. after the previous board's body has fully finished, so a board is never cut mid-write.
// A generator rather than a callback runner, so scout.ts's loop body (and its `continue`s)
// stays exactly as it was.
export function boardsWithinBudget<T>(boards: readonly T[], deadline: Deadline): BudgetedBoards<T> {
  // Boards handed to the loop body, failed and skipped ones included ("attempted").
  let started = 0;
  // True only when the clock, not the end of the list, stopped the loop.
  let stoppedEarly = false;
  // Lazily yields one board at a time, checking the budget before each.
  function* gate(): Generator<T> {
    // In the caller's order, which is oldest-polled first.
    for (const board of boards) {
      // Spent (or overdrawn): leave this board and every later one for the next run.
      if (deadline.remainingMs() <= 0) {
        // Recorded so the close can say the run was cut, not finished.
        stoppedEarly = true;
        // Ends the caller's for...of.
        return;
      }
      // Counted before the yield, so a board whose body throws still counts as attempted.
      started += 1;
      // Hand the board to the loop body.
      yield board;
    }
  }
  return {
    // One generator per call; the run iterates it once.
    boards: gate(),
    // The shape deadlineNote already formats, so the wording matches the matcher's.
    outcome: () => ({ processed: started, skippedForDeadline: boards.length - started, stoppedEarly }),
  };
}

// Everything the close needs, gathered by the run.
export interface ScoutRunTally {
  // Every failed database write, as "where: message".
  readonly dbErrors: readonly string[];
  // Why the screener could not run, or null when it did. Required, not optional, so a caller
  // cannot forget the fallback and get a silent success again.
  readonly screenerNotRun: string | null;
  // How far the board loop got before the budget.
  readonly budget: BatchOutcome;
  // De-duplicated rule warnings from the cascade.
  readonly screenWarnings: Iterable<string>;
  // Jobs processed, and application rows created.
  readonly rowsIn: number;
  readonly rowsOut: number;
  // When the run closed.
  readonly finishedAt: Date;
}

// The agent_runs update for the close, and the process exit code that goes with it.
export function scoutRunClose(tally: ScoutRunTally): {
  // Column names as agent_runs spells them, so scout.ts passes this straight to closeRun.
  readonly update: {
    // Closed union: a close can only ever be one of these two.
    readonly status: 'succeeded' | 'failed';
    // When the run ended; duration_ms is generated from it.
    readonly finished_at: string;
    // Jobs processed and applications created, as before.
    readonly rows_in: number;
    readonly rows_out: number;
    // Failed writes plus the screener fallback.
    readonly error_count: number;
    // The labelled segments, or null on a clean full run.
    readonly error_detail: string | null;
  };
  // 0 or 1 only, so a caller cannot set some other code by accident.
  readonly exitCode: 0 | 1;
} {
  // The screener fallback is a counted error: it is the reason the queue goes unscreened.
  const errorCount = tally.dbErrors.length + (tally.screenerNotRun === null ? 0 : 1);
  // Short facts first (screener, then budget), so withRuleWarnings's length cap can only
  // eat the tail of the db error list. The list is capped at 20, as it always was.
  const segments = [
    // The W12 label, with the loader's own reason.
    tally.screenerNotRun === null ? null : `screener_not_run: ${tally.screenerNotRun}`,
    // `deadline: attempted N of M; K left for next run`, or null when every board ran.
    deadlineNote(tally.budget),
    // Newline-joined, byte for byte the format scout.ts wrote before this module.
    tally.dbErrors.length > 0 ? tally.dbErrors.slice(0, 20).join('\n') : null,
  ].filter((segment): segment is string => segment !== null);
  return {
    update: {
      // agent_run_status has no `partial`: any error means the run is not a success.
      status: errorCount > 0 ? 'failed' : 'succeeded',
      // ISO, as every other agent_runs write.
      finished_at: tally.finishedAt.toISOString(),
      // Kept on a failed run too: the fallback's 'discovered' rows were really inserted.
      rows_in: tally.rowsIn,
      rows_out: tally.rowsOut,
      // The count the health page shows beside the status.
      error_count: errorCount,
      // "; " between segments, matching scout-ats; rule warnings ride along, labelled.
      error_detail: withRuleWarnings(segments.length > 0 ? segments.join('; ') : null, tally.screenWarnings),
    },
    // Non-zero on any error, so the Actions tick is red; a budget stop alone stays green.
    exitCode: errorCount > 0 ? 1 : 0,
  };
}
