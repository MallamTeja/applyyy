// The CLI scout's board-identity decision, extracted from worker/src/cli/scout.ts.
//
// WHY A SEPARATE MODULE: scout.ts runs main() the moment it is imported, so no test can
// load it. The mismatch-handling decision is the part worth pinning (a wrong token can
// answer 200 with a stranger's jobs — the 2026-10-23 'tcs'→Thornbury incident), so it
// lives here as a pure function and scout.ts only performs what this returns.
//
// The behaviour mirrors supabase/functions/scout-ats/index.ts on purpose: the scheduled
// CLI and the browser-invoked edge function poll the same watchlist, and a board must
// not be "failing" under one scout and "healthy" under the other.

// The verdict type is imported from the guard's owner, never redefined, so a new verdict
// added there becomes a compile error here instead of a silently unhandled case.
import type { BoardIdentityVerdict } from '../../../supabase/functions/_shared/ats/identity.ts';

// The two watchlist fields this decision reads; narrower than the CLI's WatchlistRow so
// the test can build one without inventing columns it does not need.
export interface IdentityGateBoard {
  // The human-entered employer name the provider's identity was compared against.
  readonly company_name: string;
  // The running failure count; a mismatch is a failing poll and must advance it.
  readonly consecutive_failures: number;
}

// What scout.ts must do with one board after evaluating its identity. A record rather
// than a bare boolean so the write and the log line travel with the decision and the
// caller cannot "skip" without also recording why.
export type IdentityGateDecision =
  // Persist as normal: the identity matched, or the provider offers no identity signal.
  | { readonly proceed: true; readonly watchlistUpdate: null; readonly warning: null }
  // Persist NOTHING from this response; write the failure bump and print the warning.
  | {
      // The discriminator scout.ts branches on.
      readonly proceed: false;
      // Same bookkeeping as an HTTP or parse failure, which the health page already reads.
      readonly watchlistUpdate: { readonly consecutive_failures: number; readonly last_polled_at: string };
      // Names both spellings so the fix (correct the token or the row) is diagnosable.
      readonly warning: string;
    };

// Map one identity verdict to the CLI's action for that board. Pure: no I/O, the clock
// is passed in, so the expected update is byte-comparable in tests.
export function identityGate(
  // The guard's closed-union verdict for this board's payload.
  verdict: BoardIdentityVerdict,
  // The watchlist row the payload was fetched for.
  board: IdentityGateBoard,
  // The run clock, the same one every other write in this poll uses.
  now: Date,
): IdentityGateDecision {
  // Only a POSITIVE mismatch blocks the board. `no_signal` (lever, ashby, an empty board)
  // means the check is inapplicable; failing it would fire on healthy boards (CLAUDE.md §6).
  if (verdict.verdict !== 'mismatch') return { proceed: true, watchlistUpdate: null, warning: null };
  // A mismatch: nothing persisted, failure counted, both names reported.
  return {
    // The caller must `continue` past every write for this board.
    proceed: false,
    // `|| 0` matches scout.ts's other failure marks, which tolerate a null count from old rows.
    watchlistUpdate: {
      // One more consecutive failure, exactly like a 404 or an unparseable body.
      consecutive_failures: (board.consecutive_failures || 0) + 1,
      // Stamped so the board rotates to the back of the poll order like any polled board.
      last_polled_at: now.toISOString(),
    },
    // Same wording shape as scout-ats's summary error, so both scouts' logs grep alike.
    warning: `Identity mismatch: board reports "${verdict.reported}", watchlist says "${board.company_name}" — nothing persisted`,
  };
}
