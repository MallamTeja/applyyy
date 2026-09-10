// The batched run. ONE GitHub Actions job processes the whole day's queue.
//
// !! DO NOT SPLIT THIS INTO A MATRIX OF PARALLEL JOBS. !!
//
// That is the obvious speed-up and it multiplies the billed minutes by 35.
// GitHub bills every job ROUNDED UP TO A WHOLE MINUTE, and each run pays
// ~40-70s of checkout, pnpm install and browser restore before any work
// happens. So: 35 separate runs ≈ 35 min of pure overhead + ~53 min of work ≈
// 88 min/day, against a Free budget of 2,000 min/month ≈ 66 min/day — the month
// burns out in about 13 days. One batched run ≈ 1 min of overhead + ~53 min ≈
// 54 min/day, and fits.
//
// Batching is therefore not a performance tweak; it is the difference between
// fitting the budget and not having a product. The reasoning lives here, beside
// the loop, because THE CHANGE THAT BREAKS IT WILL LOOK LIKE AN IMPROVEMENT.
import type { AgentName } from '@applyy/shared-types';
import { applyToOne, type ApplicationPage, type ApplierGateway, type ClaimedApplication } from './apply-one.ts';
import { canStartAnotherApplication, type RunWindowLimits } from './run-window.ts';
import type { AnswerBankRow } from '@applyy/shared-types';
import type { SubmissionEnv } from './submission-mode.ts';

// This worker's identity, used for both the run row and the claim marker.
const ACTING_AGENT: AgentName = 'applier';

/** A page that the loop is responsible for closing. */
export type ClosableApplicationPage = ApplicationPage & { close(): Promise<void> };

/** Everything the run needs from the database and the auth session. */
export interface RunGateway extends ApplierGateway {
  // Opened BEFORE any work, so a crash leaves a visible stuck row rather than
  // no row at all — a missing run and a successful run look identical.
  openRun(agent: AgentName): Promise<{ id: string }>;
  closeRun(runId: string, update: Record<string, unknown>): Promise<void>;
  // Read for OBSERVABILITY, not for safety — see the call site.
  isSystemEnabled(): Promise<boolean>;
  sweepStaleClaims(): Promise<void>;
  claimApplications(claimedBy: string, limit: number): Promise<ClaimedApplication[]>;
  fetchAnswers(): Promise<readonly AnswerBankRow[]>;
  // Expiry of the current access token, in epoch seconds.
  sessionExpiresAtEpochSeconds(): number;
  // Sign in again. The worker holds an ordinary Supabase Auth user's
  // credentials, so this is always available and an expiring token is
  // recoverable rather than fatal.
  refreshSession(): Promise<void>;
}

/** Injected dependencies, so the whole loop is testable without a browser. */
export interface ClaimLoopInput {
  readonly gateway: RunGateway;
  readonly openPage: () => Promise<ClosableApplicationPage>;
  readonly env: SubmissionEnv;
  // Epoch seconds. Injected rather than read from Date.now() so budget
  // behaviour can be tested at a boundary without fake timers.
  readonly clock: () => number;
  readonly runStartedAtEpochSeconds?: number;
  readonly limits?: RunWindowLimits;
  // How many rows to claim per round trip. Small batches keep the lease short
  // so a crash strands little; the loop simply claims again.
  readonly batchSize?: number;
}

/** What the run did, for the log and for `agent_runs`. */
export interface RunSummary {
  readonly runId: string;
  readonly claimed: number;
  readonly submitted: number;
  readonly blocked: number;
  readonly dryRun: number;
  readonly outcomeUnknown: number;
  readonly errors: number;
  // Always populated, because "we did 12 today" must be distinguishable from
  // "the queue only had 12" and from "the kill switch was off" (§14).
  readonly stoppedReason: string;
}

export async function runApplierBatch(input: ClaimLoopInput): Promise<RunSummary> {
  const { gateway, openPage, env, clock } = input;
  // Default the run start to now, so a caller that does not care gets the whole
  // budget rather than accidentally starting mid-window.
  const runStartedAtEpochSeconds = input.runStartedAtEpochSeconds ?? clock();
  const batchSize = input.batchSize ?? 5;

  // Opened first, so a crash anywhere below still leaves a `running` row that
  // the health page can show as stuck.
  const run = await gateway.openRun(ACTING_AGENT);

  // Tallies, kept outside the try so the finally block can report them.
  let claimed = 0;
  let submitted = 0;
  let blocked = 0;
  let dryRun = 0;
  let outcomeUnknown = 0;
  let errors = 0;
  let stoppedReason = 'queue drained';
  // Distinguishes a deliberate no-op from a failure when the run is closed.
  let disabled = false;

  try {
    // THE KILL SWITCH (§18.1), read here for OBSERVABILITY rather than safety.
    // `claim_applications` already returns zero rows when `system_enabled` is
    // false — safety that depends on nine callers remembering is not safety —
    // so this call cannot be the mechanism. What it buys is the ability to say
    // WHICH zero it was: without it, "0 applications today" reads identically
    // whether the switch is off or the queue was empty, and §14's whole subject
    // is failures that do not announce themselves.
    if (!(await gateway.isSystemEnabled())) {
      disabled = true;
      stoppedReason = 'kill switch is off (system_enabled = false); claimed nothing';
      return summarise();
    }

    // Sweep BEFORE claiming. Cheap, and it turns a crashed previous run into a
    // self-healing one; sweeping afterwards would leave last night's stranded
    // rows invisible for another whole day. It is also what routes a row stuck
    // at `applying` to `needs_verification` rather than back into this queue.
    await gateway.sweepStaleClaims();

    // Fetched once per run rather than per application: the bank changes only
    // when a human edits it, and 35 refetches would be 35 needless round trips.
    const answers = await gateway.fetchAnswers();

    // The claim loop proper. Keeps going until the queue empties or a gate says
    // stop; it never drains in one query, so a lease stays short.
    for (;;) {
      // BOTH GATES, checked before claiming and again before each application.
      const decision = canStartAnotherApplication(
        {
          nowEpochSeconds: clock(),
          tokenExpiresAtEpochSeconds: gateway.sessionExpiresAtEpochSeconds(),
          runStartedAtEpochSeconds,
        },
        input.limits,
      );

      if (decision.action === 'stop') {
        stoppedReason = decision.reason;
        break;
      }

      // Re-authenticate HERE, before any row enters `applying`. Doing it
      // reactively on a 401 would mean discovering the problem inside the
      // non-idempotent window, where a failure is indistinguishable from the
      // dangerous case and no clean recovery exists.
      if (decision.action === 'refresh_then_proceed') {
        await gateway.refreshSession();
      }

      // Claim marker names the run, so a stranded row can be traced to the run
      // that stranded it.
      const rows = await gateway.claimApplications(`${ACTING_AGENT}:${run.id}`, batchSize);

      // An empty page means the queue is drained. Not an error.
      if (rows.length === 0) break;

      for (const row of rows) {
        claimed += 1;
        // Opened per application so one poisoned page cannot corrupt the next.
        const page = await openPage();
        try {
          const outcome = await applyToOne({ row, page, gateway, answers, env });

          // Counted separately rather than collapsed into a success/failure
          // pair, because these four mean genuinely different things to the
          // person reading the health page.
          if (outcome.kind === 'submitted') submitted += 1;
          else if (outcome.kind === 'blocked') blocked += 1;
          else if (outcome.kind === 'dry_run_complete') dryRun += 1;
          else outcomeUnknown += 1;
        } catch (error) {
          // One application failing must not end the run: the other 34 are
          // still worth doing, and the row it failed on keeps its lease and is
          // swept later rather than being retried blind here.
          errors += 1;
          stoppedReason = `continued after error: ${
            error instanceof Error ? error.message : String(error)
          }`;
        } finally {
          // A leaked page keeps Chromium alive and the job billing until its
          // timeout — a real cost against a budget measured in whole minutes.
          await page.close();
        }
      }
    }

    return summarise();
  } finally {
    // Closed in `finally` so an unexpected throw still leaves an accurate row.
    // A run opened and never closed shows as permanently "running", which reads
    // as a hung worker rather than as a failed application — the wrong
    // diagnosis pointed at the wrong component.
    await gateway.closeRun(run.id, {
      // `skipped_disabled` is not a failure; it is the kill switch working.
      status: disabled ? 'skipped_disabled' : errors > 0 ? 'failed' : 'succeeded',
      finished_at: new Date(clock() * 1000).toISOString(),
      rows_in: claimed,
      // Work genuinely completed. Dry runs contribute NOTHING here on purpose:
      // counting them would tell Teja the system is working while nothing has
      // actually been sent.
      rows_out: submitted,
      error_count: errors,
      error_detail: errors > 0 ? stoppedReason : null,
    });
  }

  /** Built in one place so the return and the log cannot disagree. */
  function summarise(): RunSummary {
    return {
      runId: run.id,
      claimed,
      submitted,
      blocked,
      dryRun,
      outcomeUnknown,
      errors,
      stoppedReason,
    };
  }
}
