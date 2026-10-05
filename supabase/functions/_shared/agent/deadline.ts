// Per-invocation deadline for the batch agents (matcher, tailor).
//
// WHY THIS EXISTS: a Supabase Edge Function is killed at 150 s wall clock. Since 7ffc22a the
// Gemini client retries (4 attempts, 25 s each, with backoff), so ONE call on a saturated
// model can take 113750 ms and a batch of ten rows can outlive the isolate. The kill leaves
// `agent_runs` at `running` and the batch half done. This module plans each call's budget
// from the time left, and stops BETWEEN rows when nothing useful fits.
//
// SCOPE OF THE STOP: the deadline is checked only BETWEEN rows, never mid-row, and it only
// shapes the LLM call budget. It never touches the write path, so a row is never left between
// its payload write and its status RPC.
//
// SEQUENTIAL ONLY: index.ts hands each row's budget to its Gemini callback through one shared
// `callBudget` variable. That is safe ONLY because rows run strictly one after another;
// running rows concurrently would let one row overwrite another's budget.
//
// Pure on purpose: no Deno APIs and an injected clock, so `node --test` can exercise it.

// Per-attempt timeout default. Equal to gemini/client.ts (`options.timeoutMs ?? 25000`) so the
// full-budget plan matches what the client does with no options; 25 s is also long enough for
// a legitimate 10-20 s scoring call. deadline.test.ts reads client.ts to enforce the match.
export const DEFAULT_TIMEOUT_MS = 25000;
// Retry default, equal to gemini/client.ts (`options.maxRetries ?? 3`: four attempts).
export const DEFAULT_MAX_RETRIES = 3;
// Duplicated from gemini/client.ts:186 (`const BACKOFF_BASE_MS`): it is not exported and that
// directory is finished and deployed, so it cannot be changed from here. THE TRIPWIRE is the
// "client.ts still matches" test in deadline.test.ts, which reads client.ts source and fails
// if this table or either default above drifts from it.
const BACKOFF_BASE_MS: readonly number[] = [1000, 3000, 7000];
// The client adds up to 25% jitter on top of each backoff; planned at the maximum.
const MAX_JITTER = 0.25;
// Reserved for the RPC writes after the last call and for closing the agent_runs row.
export const SAFETY_MARGIN_MS = 10000;
// Below this a scoring call is likely to time out anyway (a real call takes 10-20 s).
export const MIN_TIMEOUT_MS = 15000;
// Leaves 30 s under the 150 s kill for cold start, auth, the queue read and the final writes.
export const DEFAULT_BUDGET_MS = 120000;

// The two knobs the Gemini client accepts per call.
export interface CallOptions {
  // Abort timer applied to every attempt, in ms.
  readonly timeoutMs: number;
  // Retries after the first attempt, so attempts = maxRetries + 1.
  readonly maxRetries: number;
}

// Longest one call can take: every attempt times out and every gap sleeps its maximum.
// The client sleeps after no final attempt, hence only `maxRetries` backoffs.
export function worstCaseCallMs(opts: CallOptions): number {
  // The first try plus each retry, all running to their timeout.
  let total = (opts.maxRetries + 1) * opts.timeoutMs;
  // One backoff sits before each retry.
  for (let i = 0; i < opts.maxRetries; i++) {
    // Clamp to the last table entry, as the client does when retries outrun the table.
    const base = BACKOFF_BASE_MS[Math.min(i, BACKOFF_BASE_MS.length - 1)]!;
    // Maximum jitter, so the estimate is an upper bound and never a hope.
    total += base * (1 + MAX_JITTER);
  }
  // Compared directly with the time available in planCall.
  return total;
}

// A discriminated union, not a boolean, so a caller cannot read `timeoutMs` off a "stop".
export type CallPlan =
  // The call may go ahead with exactly these knobs.
  | { readonly kind: "call"; readonly timeoutMs: number; readonly maxRetries: number }
  // Nothing useful fits: the caller must not start another row.
  | { readonly kind: "stop" };

// The biggest call budget that fits in what is left, after reserving the margin.
export function planCall(remainingMs: number): CallPlan {
  // The part of the remaining time the call itself may consume.
  const available = remainingMs - SAFETY_MARGIN_MS;
  // Retries are dropped first: a retry is a luxury, while a call cut short is a wasted row.
  for (let maxRetries = DEFAULT_MAX_RETRIES; maxRetries >= 0; maxRetries--) {
    // The first (largest) retry count whose worst case fits wins.
    if (worstCaseCallMs({ timeoutMs: DEFAULT_TIMEOUT_MS, maxRetries }) <= available) {
      return { kind: "call", timeoutMs: DEFAULT_TIMEOUT_MS, maxRetries };
    }
  }
  // Not even one full-length attempt fits: spend what is left on a single shortened attempt.
  if (available >= MIN_TIMEOUT_MS) return { kind: "call", timeoutMs: available, maxRetries: 0 };
  // Under the floor a call would likely time out and burn the row's quota for nothing.
  return { kind: "stop" };
}

// A countdown from creation; the clock is injected so tests control time.
export interface Deadline {
  // Milliseconds until the budget ends; negative once overdrawn.
  remainingMs(): number;
}

// `Date.now` as the default keeps production wiring to a bare `createDeadline()`.
export function createDeadline(
  opts: { readonly budgetMs?: number; readonly clock?: () => number } = {},
): Deadline {
  // Resolved once so creation and every later read use the same seam.
  const clock = opts.clock ?? Date.now;
  // The budget starts counting at handler entry, not at the first row.
  const endsAt = clock() + (opts.budgetMs ?? DEFAULT_BUDGET_MS);
  return {
    // Negative is possible and harmless: planCall treats it as "stop".
    remainingMs: () => endsAt - clock(),
  };
}

// What the batch did, so the caller can report an early stop honestly.
export interface BatchOutcome {
  // Rows whose processItem ran to completion; includes rows that ran and then failed.
  readonly processed: number;
  // Rows never started, left untouched for the next run.
  readonly skippedForDeadline: number;
  // True only when the deadline, not the end of the queue, ended the batch.
  readonly stoppedEarly: boolean;
}

// Runs `processItem` over `items` in order, planning each call's budget from the time left.
// Never stops mid-item (see the header); rows not reached are untouched for the next run.
//
// ERRORS: an item that throws propagates and aborts the batch. index.ts never relies on that:
// its `processItem` keeps the per-row try/catch, so nothing throws out of here in practice.
export async function runBatchWithDeadline<T>(
  items: readonly T[],
  processItem: (item: T, call: CallOptions) => Promise<void>,
  opts: { readonly deadline: Deadline; readonly targeted: boolean },
): Promise<BatchOutcome> {
  // Counted after each await, so a throw is never counted as processed.
  let processed = 0;
  for (const item of items) {
    // A targeted run is one row the caller asked for by id: it gets the full default budget
    // and is never skipped, because skipping would answer a direct request with nothing.
    let call: CallOptions = { timeoutMs: DEFAULT_TIMEOUT_MS, maxRetries: DEFAULT_MAX_RETRIES };
    if (!opts.targeted) {
      // Planned fresh before EACH item: earlier rows may have eaten more time than expected.
      const plan = planCall(opts.deadline.remainingMs());
      // Out of time: leave this and every later row for the next run.
      if (plan.kind === "stop") {
        return { processed, skippedForDeadline: items.length - processed, stoppedEarly: true };
      }
      // Narrowed to the "call" arm by the check above.
      call = { timeoutMs: plan.timeoutMs, maxRetries: plan.maxRetries };
    }
    // Awaited to completion before the next deadline check: this is what makes it never mid-item.
    await processItem(item, call);
    processed += 1;
  }
  // Every item ran, so the queue ended the batch and not the clock.
  return { processed, skippedForDeadline: 0, stoppedEarly: false };
}

// The agent_runs.error_detail note for an early stop; null when the batch ran to the end.
// One home for the wording so matcher and tailor report it identically. "attempted" because
// the count includes rows that ran and failed. The `deadline:` prefix is how the health page
// tells a stop apart: the run stays `succeeded` (agent_run_status has no `partial`) with
// error_count 0, so this text is the only trace.
export function deadlineNote(outcome: BatchOutcome): string | null {
  // A batch that ran to the end has nothing to report.
  if (!outcome.stoppedEarly) return null;
  return `deadline: attempted ${outcome.processed} of ${outcome.processed + outcome.skippedForDeadline}; ${outcome.skippedForDeadline} left for next run`;
}

// Suffix for a row failure when its Gemini call ran on a reduced budget, so a timeout the
// deadline caused is distinguishable from a real model timeout. Empty at the full budget.
export function shortenedBudgetNote(call: CallOptions): string {
  // Full budget: the failure is the model's, so nothing is added.
  if (call.timeoutMs >= DEFAULT_TIMEOUT_MS && call.maxRetries >= DEFAULT_MAX_RETRIES) return "";
  return ` (deadline-shortened budget: ${call.timeoutMs}ms, ${call.maxRetries} retries)`;
}
