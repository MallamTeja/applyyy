// May this batched run begin ANOTHER application?
//
// Two axes, both checked BEFORE `approved -> applying` and never inside it.
// That placement is the whole safety property, and it is worth stating plainly:
// `applying` is the single non-idempotent leg in the system. A token that dies
// between submitting and writing `applied` leaves a row whose real-world
// outcome is UNKNOWN — the sweeper then correctly routes it to
// `needs_verification`, and Teja has to open the employer's site and check by
// hand whether each one actually went out. A silent auth expiry converts clean
// submissions into a pile of "did this send?" questions, which is precisely the
// outcome PROJECT_PLAN.md §14 exists to prevent.
//
// So the token is made freshest exactly where a failure would be unrecoverable,
// rather than being refreshed reactively on a 401 — a 401 caught at the wrong
// moment is indistinguishable from the dangerous case, and by then it is too
// late to act on the difference.
//
// WHY THIS IS SUDDENLY NECESSARY, since a reader will otherwise assume it is
// over-engineering: batching. Under the old "~90s per application" estimate a
// run was ~90s against a 3600s token — about 40x slack. That estimate is
// refuted; the measured figure is ~3.75s of in-process work. But the binding
// cost is per-RUN overhead plus GitHub billing every job ROUNDED UP TO A WHOLE
// MINUTE, so 35 separate runs cost ≈88 min/day against a 66 min/day budget
// while ONE batched run costs ≈54 min/day and fits. Batching is therefore not
// an optimisation, it is the difference between fitting the budget and burning
// the month in ~13 days — and it means one run now carries the whole daily
// queue: ~54 min ≈ 3240s against a 3600s token. ~10% headroom, not 4000%.
//
// And 3.75s was measured against a LOCALHOST FIXTURE, so it excludes real-site
// latency and file upload. The true per-application figure is higher than the
// estimate, never lower, which is the direction that makes this gate load-bearing.

/** Everything the decision depends on. All clocks passed in, never read here. */
export interface RunWindowState {
  // Injected rather than read from Date.now() so the tests need no fake timers:
  // a decision function that reads the clock itself cannot be tested at a
  // boundary without mutating global state.
  readonly nowEpochSeconds: number;
  // Expiry of the current Supabase access token, from the session object.
  readonly tokenExpiresAtEpochSeconds: number;
  // When this run began claiming work, for the wall-clock budget.
  readonly runStartedAtEpochSeconds: number;
}

/** The tunable limits, defaulted but overridable so the tests can be explicit. */
export interface RunWindowLimits {
  // How much token life must remain before starting another application.
  readonly refreshMarginSeconds: number;
  // How long the whole run may spend claiming and processing.
  readonly runBudgetSeconds: number;
}

/** What the caller should do next. */
export interface RunWindowDecision {
  // 'stop' ends the run cleanly and leaves the overflow claimable; it is never
  // an error. The other two both continue, differing only in whether the
  // session must be renewed first.
  readonly action: 'proceed' | 'refresh_then_proceed' | 'stop';
  // Always populated. §14's subject is failures that do not announce
  // themselves, and a run that stopped early must say why — otherwise "we only
  // did 12 today" reads identically to "the queue only had 12".
  readonly reason: string;
}

export const DEFAULT_RUN_WINDOW_LIMITS: RunWindowLimits = {
  // Five minutes. Chosen to be far larger than any single application: ~3.75s
  // against a fixture, and even the superseded 90s worst-case estimate fits
  // more than three times over. The margin only needs to exceed the work done
  // between two checks, so generous costs nothing but makes the gate immune to
  // the real-site latency the fixture measurement could not capture.
  refreshMarginSeconds: 300,
  // 55 minutes. Sits between the ~53 min a full 35-application queue needs (so
  // a normal day is not truncated) and the 66 min/day average allowance (so a
  // slow day cannot overrun the monthly budget). Overflow is not lost: rows
  // stay claimable and the next cron tick takes them, which is the same
  // bounded-batch-and-re-fire principle the Edge Functions use for their 2s CPU
  // limit, applied to wall clock instead.
  runBudgetSeconds: 3300,
};

export function canStartAnotherApplication(
  state: RunWindowState,
  limits: RunWindowLimits = DEFAULT_RUN_WINDOW_LIMITS,
): RunWindowDecision {
  // How long this run has been going.
  const elapsedSeconds = state.nowEpochSeconds - state.runStartedAtEpochSeconds;

  // BUDGET IS CHECKED FIRST, and the precedence is deliberate: if the run is
  // out of time, refreshing a token to do work there is no time for would spend
  // a real billable minute to accomplish nothing.
  if (elapsedSeconds >= limits.runBudgetSeconds) {
    return {
      action: 'stop',
      reason:
        `run wall-clock budget spent (${elapsedSeconds}s of ${limits.runBudgetSeconds}s); ` +
        'stopping cleanly — remaining rows stay claimable for the next tick.',
    };
  }

  // Token life left. Negative when already expired, which the comparison below
  // handles without a separate branch — an expired token is just the extreme
  // case of an expiring one, and both are recovered the same way.
  const tokenRemainingSeconds = state.tokenExpiresAtEpochSeconds - state.nowEpochSeconds;

  if (tokenRemainingSeconds < limits.refreshMarginSeconds) {
    return {
      // NOT 'stop'. We hold the worker's password, so this is recoverable, and
      // treating it as fatal would abandon a queue we could have finished.
      action: 'refresh_then_proceed',
      reason:
        `access token has ${tokenRemainingSeconds}s left, inside the ` +
        `${limits.refreshMarginSeconds}s margin; re-authenticating before the ` +
        'next application so the token is freshest across the submit window.',
    };
  }

  // The ordinary path, which most of a run's applications take.
  return {
    action: 'proceed',
    reason:
      `token has ${tokenRemainingSeconds}s left and the run has ` +
      `${limits.runBudgetSeconds - elapsedSeconds}s of budget remaining.`,
  };
}
