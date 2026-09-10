// The gate that decides whether a batched run may begin ANOTHER application.
//
// This exists because batching changed an assumption nobody re-derived. Under
// the old "~90s per application" reading, one run was ~90s against a 3600s
// token — 40x slack, so a single sign-in at the start was obviously safe. The
// measured figure is ~3.75s in-process, but the binding cost is per-RUN plus
// GitHub billing every job rounded up to a whole minute, which is why the whole
// day's queue goes through ONE run: ~35 applications ≈ ~54 min ≈ 3240s against
// a 3600s token. That is ~10% headroom, not 4000% — and 3.75s was measured
// against a localhost fixture, so it excludes real-site latency and file
// upload. The true number is higher, never lower.
//
// Both axes are checked BEFORE `approved -> applying`, never inside it: that is
// the one non-idempotent leg, so a token dying mid-submit leaves a row whose
// real-world outcome is unknown, and the sweeper must then route it to
// needs_verification for a human to check by hand. Deciding early is what keeps
// the dangerous window free of decisions.
import { describe, expect, it } from 'vitest';
import { canStartAnotherApplication } from '../src/run-window.js';

// A baseline that every case below perturbs one axis of, so each assertion
// attributes its outcome to exactly one variable.
const healthy = {
  nowEpochSeconds: 1_000_000,
  // Comfortably beyond the refresh margin.
  tokenExpiresAtEpochSeconds: 1_000_000 + 1800,
  runStartedAtEpochSeconds: 1_000_000 - 600,
} as const;

describe('canStartAnotherApplication', () => {
  it('proceeds when the token is fresh and the run has time left', () => {
    const decision = canStartAnotherApplication(healthy);
    // The ordinary case: most of a run's applications take this branch.
    expect(decision.action).toBe('proceed');
  });

  it('refreshes first when the token would expire inside the safety margin', () => {
    const decision = canStartAnotherApplication({
      ...healthy,
      // 60s left: longer than one application, but inside the margin, which is
      // the point — we refresh while there is still plenty of time, not once
      // the token is nearly dead.
      tokenExpiresAtEpochSeconds: healthy.nowEpochSeconds + 60,
    });
    // NOT 'stop'. An expiring token is recoverable; it must not end the run.
    expect(decision.action).toBe('refresh_then_proceed');
  });

  it('refreshes rather than stopping when the token has already expired', () => {
    const decision = canStartAnotherApplication({
      ...healthy,
      // Already dead. Reached when a single application hangs far longer than
      // budgeted — exactly the slow-site day this gate is for.
      tokenExpiresAtEpochSeconds: healthy.nowEpochSeconds - 30,
    });
    // Still recoverable: we hold the password and can sign in again. Treating
    // an expired token as fatal would abandon a queue we could have finished.
    expect(decision.action).toBe('refresh_then_proceed');
  });

  it('stops when the run has exhausted its wall-clock budget', () => {
    const decision = canStartAnotherApplication({
      ...healthy,
      // Started well beyond the budget. Bounded-batch-and-re-fire: the same
      // principle the Edge Functions use for the 2s CPU limit, applied to wall
      // clock. Overflow stays claimable for the next cron tick.
      runStartedAtEpochSeconds: healthy.nowEpochSeconds - 100_000,
    });
    expect(decision.action).toBe('stop');
  });

  it('stops on budget even when the token is also expiring', () => {
    // PRECEDENCE. Both axes are unhappy; the answer must be 'stop', because
    // refreshing a token to do work the run has no time for spends a real
    // minute of a 66 min/day budget to accomplish nothing.
    const decision = canStartAnotherApplication({
      nowEpochSeconds: healthy.nowEpochSeconds,
      tokenExpiresAtEpochSeconds: healthy.nowEpochSeconds + 10,
      runStartedAtEpochSeconds: healthy.nowEpochSeconds - 100_000,
    });
    expect(decision.action).toBe('stop');
  });

  it('explains every decision in words', () => {
    // §14's subject is failures that do not announce themselves. A run that
    // stopped early must say WHY in its log, or "we only did 12 today" is
    // indistinguishable from "the queue only had 12".
    for (const decision of [
      canStartAnotherApplication(healthy),
      canStartAnotherApplication({ ...healthy, tokenExpiresAtEpochSeconds: healthy.nowEpochSeconds }),
      canStartAnotherApplication({ ...healthy, runStartedAtEpochSeconds: 0 }),
    ]) {
      expect(decision.reason.length).toBeGreaterThan(0);
    }
  });
});
