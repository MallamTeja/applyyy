// Counts the tailor's Gemini calls for agent_runs.gemini_calls (2026-11-09).
//
// WHY IT EXISTS: the tailor's close-run update never wrote gemini_calls, so the column kept its
// default 0 on all 203 tailor runs since 2026-11-01. A counter that silently reads 0 is a fail-open
// (CLAUDE.md §6): the tailor looked like it spent no Gemini quota, and its calls/min could not be
// measured the way the matcher's was (docs/status/2026-11-09-matcher-stall.md).
//
// DEFINITION, the same as the matcher's (matcher/index.ts geminiCallsCount): one per
// generateGeminiContent call, counted BEFORE the call, so a call that fails or throws still
// counts. The client's internal retries and key failovers inside one call are NOT counted
// separately; that is a client-level number.

/** Wraps `call` so every invocation is counted; `count()` reads the total so far. */
export function countCalls<A extends unknown[], R>(call: (...args: A) => Promise<R>): {
  readonly call: (...args: A) => Promise<R>;
  readonly count: () => number;
} {
  // Invocations so far; only the wrapper below writes it.
  let calls = 0;
  // The wrapper the caller uses in place of `call`.
  return {
    // Counted first, so a call that rejects is still one call, as in the matcher.
    call: (...args: A) => {
      // One more Gemini call attempted by this run.
      calls += 1;
      // The real call, unchanged; its result or rejection passes straight through.
      return call(...args);
    },
    // A read, never a reset: the run's total is read once, when the run closes.
    count: () => calls,
  };
}
