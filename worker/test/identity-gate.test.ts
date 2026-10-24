// Tests for the CLI's board-identity gate decision (worker/src/scout/identity-gate.ts).
//
// The gate exists because scout.ts executes main() on import, so the mismatch-handling
// decision had to live in a pure module to be testable at all. These tests pin the
// three verdicts of the closed union to their actions: only a positive mismatch skips
// the board, and "the provider could not say" is never punished as a failure.
import { describe, expect, it } from 'vitest';
// The unit under test: verdict -> what scout.ts must do with this board.
import { identityGate } from '../src/scout/identity-gate.ts';

// A watchlist row slice as scout.ts holds it mid-loop: the name the user entered and
// the failure count the mismatch branch must increment.
const BOARD = { company_name: 'Tata Consultancy Services', consecutive_failures: 2 };
// One fixed clock so the expected last_polled_at is byte-comparable.
const NOW = new Date('2026-10-24T06:00:00Z');

describe('identityGate', () => {
  it('mismatch: skip the board, bump consecutive_failures, warn with both spellings', () => {
    // The incident shape: the board answers as a different company entirely.
    const decision = identityGate(
      { verdict: 'mismatch', reported: 'Thornbury Community Services' },
      BOARD,
      NOW,
    );
    // Nothing from this response may be persisted.
    expect(decision.proceed).toBe(false);
    // Same bookkeeping as an HTTP/parse failure: the counter the health page reads.
    expect(decision.watchlistUpdate).toEqual({
      consecutive_failures: 3,
      last_polled_at: NOW.toISOString(),
    });
    // The warning must name BOTH spellings so the fix is diagnosable from the log alone.
    expect(decision.warning).toContain('Thornbury Community Services');
    expect(decision.warning).toContain('Tata Consultancy Services');
  });

  it('match: proceed, no watchlist write, no warning', () => {
    const decision = identityGate({ verdict: 'match', reported: 'Tata Consultancy Services' }, BOARD, NOW);
    // A healthy board flows on exactly as before the guard existed.
    expect(decision).toEqual({ proceed: true, watchlistUpdate: null, warning: null });
  });

  it('no_signal: proceed — an inapplicable check is NOT a failure', () => {
    // lever/ashby payloads carry no identity; punishing them would fire on healthy boards.
    const decision = identityGate(
      { verdict: 'no_signal', reason: 'lever: payload carries no reported identity' },
      BOARD,
      NOW,
    );
    expect(decision).toEqual({ proceed: true, watchlistUpdate: null, warning: null });
  });
});
