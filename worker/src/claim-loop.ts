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
import {
  applyToOne,
  type ApplicationPage,
  type ApplierGateway,
  type ClaimedApplication,
  type ResumeRenderer,
  // The robots port the loop requires and hands through untouched.
  type RobotsCheck,
  // Only to type formatDryRunLine's argument as the dry-run arm.
  type ApplyOutcome,
} from './apply-one.ts';
import { canStartAnotherApplication, type RunWindowLimits } from './run-window.ts';
// Type-only so the claim loop gains no runtime dependency on the profile module.
import type { AnswerBankRow, MasterProfile } from '@applyy/shared-types';
// The value import is for the circuit breaker, which acts only in a run that asked to submit.
import { resolveSubmissionMode, type SubmissionEnv } from './submission-mode.ts';

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
  // Optional so older gateways keep working; absent means no profile fills, the safe direction.
  // Declared on the loop's gateway type so the loop can fetch the profile without a cast.
  fetchLatestProfile?(): Promise<MasterProfile | null>;
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
  // Renders the tailored resume for one application. Passed straight through to
  // applyToOne and never called here: the loop's job is claiming and pacing, and
  // a render at this level would happen for rows that turn out to be blocked.
  //
  // It gets its own PAGE, not one of `openPage`'s — the renderer replaces the
  // document it renders on, so sharing the form's page would erase the form.
  // That is enforced where the renderer is built, not by convention here.
  readonly renderResume: ResumeRenderer;
  // The robots.txt gate, passed straight through to applyToOne. REQUIRED: a loop that
  // could be built without it would be an applier that never asks.
  readonly checkRobots: RobotsCheck;
  readonly env: SubmissionEnv;
  // Epoch seconds. Injected rather than read from Date.now() so budget
  // behaviour can be tested at a boundary without fake timers.
  readonly clock: () => number;
  readonly runStartedAtEpochSeconds?: number;
  readonly limits?: RunWindowLimits;
  // How many rows to claim per round trip. Small batches keep the lease short
  // so a crash strands little; the loop simply claims again.
  readonly batchSize?: number;
  // APPLY_ONLY_ID: when set, this run works on that ONE application and nothing
  // else. Any other row the claim hands back is released untouched (still
  // `approved`), and the run ends as soon as the target has been processed.
  // Exists for the first real submissions, where "exactly this one employer" is
  // the whole point and a newly approved row must not ride along. Already
  // validated as a UUID by the caller; absent means the normal whole-queue run.
  // `| undefined` because the CLI passes its parse result through as-is.
  readonly onlyApplicationId?: string | undefined;
}

/** What the run did, for the log and for `agent_runs`. */
export interface RunSummary {
  readonly runId: string;
  readonly claimed: number;
  readonly submitted: number;
  readonly blocked: number;
  readonly dryRun: number;
  readonly outcomeUnknown: number;
  // Rows robots.txt kept us from opening. Its own tally: a certain no-send is neither a
  // block a human must answer nor an unknown a human must check.
  readonly robotsRefused: number;
  readonly errors: number;
  // Always populated, because "we did 12 today" must be distinguishable from
  // "the queue only had 12" and from "the kill switch was off" (§14).
  readonly stoppedReason: string;
}

// A canonical UUID, case-insensitive: the only shape an application id has.
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * APPLY_ONLY_ID, validated by SHAPE before it can mean anything.
 *
 * ONLY an absent variable means "no filter". A variable that is SET must be a
 * UUID, blank included, or the run STOPS. Blank is the dangerous case: a local
 * `APPLY_ONLY_ID=$ID` with `$ID` empty, or an Actions `${{ }}` expanding to
 * nothing, is someone who meant to name one application. Reading it as "no
 * filter" would turn a one-application run into a whole-queue submit, which is
 * §6's fail-open exactly. (Unlike `required` in cli/apply.ts, where blank and
 * absent are rightly the same: both mean "missing" there, and both stop.)
 */
export function parseOnlyApplicationId(raw: string | undefined): string | undefined {
  // Absent: the normal whole-queue run. The one input that widens the scope.
  if (raw === undefined) return undefined;
  // Trimmed, so a stray space from a shell does not fail an otherwise valid id.
  const id = raw.trim();
  // Not a UUID: refuse to run rather than guess what was meant.
  if (!UUID_SHAPE.test(id)) {
    throw new Error(`APPLY_ONLY_ID must be an application UUID; got ${JSON.stringify(raw)}. Refusing to run.`);
  }
  // Lower-cased, because Postgres prints uuids lower-case and the filter compares strings.
  return id.toLowerCase();
}

// The per-run submit cap when APPLY_MAX_SUBMITS is absent. Small on purpose: the first
// unattended live runs should be able to cost Teja at most a handful of applications.
export const DEFAULT_MAX_SUBMITS = 3;

/**
 * APPLY_MAX_SUBMITS, validated by SHAPE: a positive integer in plain digits, or the run stops.
 *
 * Only ABSENT means the default. A SET value that is blank, zero, negative, fractional or
 * not a number throws, because the lenient readers turn it into a cap nobody chose:
 * Number('') is 0, parseInt('3abc') is 3, Number('1e9') is a billion (CLAUDE.md §6).
 */
export function parseMaxSubmits(raw: string | undefined): number {
  // Absent: the deliberate small default.
  if (raw === undefined) return DEFAULT_MAX_SUBMITS;
  // Trimmed, so a stray space from a shell does not fail an otherwise valid number.
  const text = raw.trim();
  // Digits only, no leading zero: rules out '', '0', '-1', '1.5', '1e3' and '0x10' in one test.
  if (!/^[1-9][0-9]*$/.test(text)) {
    throw new Error(`APPLY_MAX_SUBMITS must be a positive integer; got ${JSON.stringify(raw)}. Refusing to run.`);
  }
  // Safe now: a short digit string with no sign, exponent or fraction.
  const value = Number(text);
  // A digit string past 2^53 would round to a different number; refuse it rather than guess.
  if (!Number.isSafeInteger(value)) {
    throw new Error(`APPLY_MAX_SUBMITS is too large; got ${JSON.stringify(raw)}. Refusing to run.`);
  }
  // A positive, exactly represented integer.
  return value;
}

/**
 * The one log line a dry run leaves: `[applyy] dry run <id>: wouldSubmit=<bool> blockers=<n> [<label>: <reason>, …]`.
 *
 * Exported and pure so the format is tested directly. Reads only the verdict and each
 * blocker's label and reason: a label is the form's question text, never the answer.
 */
export function formatDryRunLine(
  applicationId: string,
  outcome: Extract<ApplyOutcome, { kind: 'dry_run_complete' }>,
): string {
  // "label: reason" per blocker, comma-separated, in the order the planner found them.
  const listed = outcome.blockers.map((blocker) => `${blocker.label}: ${blocker.reason}`).join(', ');
  // The count is printed even at zero, so "no blockers" is stated, not implied by absence.
  return `[applyy] dry run ${applicationId}: wouldSubmit=${outcome.wouldSubmit} blockers=${outcome.blockers.length} [${listed}]`;
}

// Compile-time exhaustiveness; at runtime it throws, which the per-row catch counts as an error.
function assertNever(value: never): never {
  // Reached only if a value outside the union arrives, e.g. from an untyped caller.
  throw new Error(`unhandled apply outcome: ${JSON.stringify(value)}`);
}

export async function runApplierBatch(input: ClaimLoopInput): Promise<RunSummary> {
  const { gateway, openPage, env, clock, renderResume, checkRobots } = input;
  // THE PER-RUN SUBMIT CAP, parsed BEFORE the run row opens, so a bad value stops the run
  // with nothing opened and nothing claimed (a startup failure, not a mid-run one).
  const maxSubmits = parseMaxSubmits(env['APPLY_MAX_SUBMITS']);
  // Whether this run asked to submit. The breaker below acts only then; a dry run never
  // submits, so an unconfirmed or captcha outcome cannot happen there and must not stop it.
  const live = resolveSubmissionMode(env).submits;
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
  // Counted apart from outcomeUnknown, so a robots refusal never reads as "maybe sent".
  let robotsRefused = 0;
  let errors = 0;
  let stoppedReason = 'queue drained';
  // Distinguishes a deliberate no-op from a failure when the run is closed.
  let disabled = false;
  // Every application id this run has claimed, so a row it already processed
  // (and a dry run released) is never processed twice in one run.
  const seen = new Set<string>();
  // Re-claimed rows whose lease we keep until the end; see the re-claim guard.
  const held: string[] = [];
  // Rows claimed while APPLY_ONLY_ID names a different one. HELD like the above,
  // not released on sight: a released row is the oldest unclaimed one again, so
  // the next claim would hand it straight back instead of reaching the target.
  const notTargeted: string[] = [];
  // Set once the targeted application has been processed, to end the run there.
  let targetDone = false;
  // THE CIRCUIT BREAKER's reason, set by the first outcome that says "this run cannot tell
  // whether, or cannot even, submit". Null until then. A reCAPTCHA scoring a datacenter IP
  // low makes EVERY submit unconfirmed; without this one run would park the whole queue at
  // needs_verification, each row needing Teja to check an employer site by hand.
  let breakerReason: string | null = null;

  /** Why to stop before the next application on this run's own budget, or null to go on. */
  // Separate from gateBeforeNextApplication: that gate is about time and auth, this one is
  // about how many real attempts this run has already made and whether it should keep making them.
  function submitBudgetStop(): string | null {
    // The breaker wins: a tripped run stops even below its cap.
    if (breakerReason !== null) return breakerReason;
    // Unknown outcomes COUNT toward the cap: each may well have been sent.
    const attempts = submitted + outcomeUnknown;
    // At the cap: stop claiming. Dry runs never reach it (both counters stay 0).
    if (attempts >= maxSubmits) {
      return `APPLY_MAX_SUBMITS reached (${attempts} of ${maxSubmits} submit attempts); stopped claiming`;
    }
    // Under the cap and the breaker untripped.
    return null;
  }

  /**
   * Both gates, in one place so the before-claim and before-each-application
   * checks cannot drift apart. Returns why to stop, or null to proceed.
   *
   * `checkKillSwitch` is false before a claim because `claim_applications`
   * already returns nothing when the switch is off; before an application the
   * row is already ours, so only an explicit read can notice the switch.
   */
  async function gateBeforeNextApplication(checkKillSwitch: boolean): Promise<string | null> {
    // The run-window gate: wall-clock budget and token lifetime.
    const decision = canStartAnotherApplication(
      {
        nowEpochSeconds: clock(),
        tokenExpiresAtEpochSeconds: gateway.sessionExpiresAtEpochSeconds(),
        runStartedAtEpochSeconds,
      },
      input.limits,
    );

    // Out of budget or out of token: stop, with the gate's own explanation.
    if (decision.action === 'stop') return decision.reason;

    // Re-authenticate HERE, before any row enters `applying`. Doing it
    // reactively on a 401 would mean discovering the problem inside the
    // non-idempotent window, where a failure is indistinguishable from the
    // dangerous case and no clean recovery exists.
    if (decision.action === 'refresh_then_proceed') {
      await gateway.refreshSession();
    }

    // THE KILL SWITCH between applications. Fails closed with the gateway: a
    // missing settings row reads as off.
    if (checkKillSwitch && !(await gateway.isSystemEnabled())) {
      return 'kill switch turned off mid-run (system_enabled = false); stopped between applications';
    }

    // Both gates passed.
    return null;
  }

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
    // Fetched once per run for the same reason as the bank: it changes only when a human edits it.
    // A gateway without the method silently loses every profile fill; warn once per run so a wiring slip is visible.
    // console.warn rather than throw: a missing profile degrades to blockers, it is not unsafe.
    if (gateway.fetchLatestProfile === undefined) console.warn('[claim-loop] gateway has no fetchLatestProfile; profile fills disabled');
    // Optional call plus null default, because an absent method must behave as "no profile".
    const profile = (await gateway.fetchLatestProfile?.()) ?? null;

    // The claim loop proper. Keeps going until the queue empties or a gate says
    // stop; it never drains in one query, so a lease stays short. Labelled so a
    // gate tripping between two applications can end the whole run, not just
    // the current batch.
    claiming: for (;;) {
      // The run-window gate before claiming, so an exhausted budget claims
      // nothing it would only have to hand back.
      // The submit budget first: a capped or tripped run must not even claim, since every
      // claimed row would only be released again.
      const beforeClaim = submitBudgetStop() ?? (await gateBeforeNextApplication(false));
      // A string is the reason to stop; null means carry on.
      if (beforeClaim !== null) {
        stoppedReason = beforeClaim;
        break;
      }

      // Claim marker names the run, so a stranded row can be traced to the run
      // that stranded it.
      const rows = await gateway.claimApplications(`${ACTING_AGENT}:${run.id}`, batchSize);

      // An empty page means the queue is drained. Not an error.
      if (rows.length === 0) break;

      // THE RE-CLAIM GUARD. A dry run releases each row it finishes, and the
      // claim takes the oldest unclaimed `approved` rows — so without this the
      // SAME rows come straight back and the run refills the same real employer
      // forms until the 55-minute budget runs out, every day. A row seen
      // earlier in this run is HELD (its fresh lease is kept, so the next claim
      // skips it and reaches new work) and released once, at the end.
      const unseen = rows.filter((row) => !seen.has(row.id));
      // Recorded before any work, so a row that throws is never retried either.
      for (const row of rows) {
        if (seen.has(row.id)) held.push(row.id);
        else seen.add(row.id);
      }
      // THE APPLY_ONLY_ID FILTER, applied to the claimed page and nowhere else, so
      // a non-target row is never navigated to, filled, or advanced. Its lease is
      // kept (so the next claim moves past it) and released at the end.
      const fresh = input.onlyApplicationId === undefined
        ? unseen
        // Only the target survives; everything else is set aside for release.
        : unseen.filter((row) => {
            // The one row this run exists for.
            if (row.id === input.onlyApplicationId) return true;
            // Any other: parked in the release list, never processed.
            notTargeted.push(row.id);
            return false;
          });

      for (const [index, row] of fresh.entries()) {
        // BOTH GATES, checked again before EACH application rather than once
        // per batch: the kill switch must stop the run between two employers'
        // forms, not after up to four more of them.
        // The submit budget too, so a cap or breaker reached mid-batch releases the rest of the
        // batch untouched through the same path below, instead of attempting another employer.
        const beforeRow = submitBudgetStop() ?? (await gateBeforeNextApplication(true));
        if (beforeRow !== null) {
          stoppedReason = beforeRow;
          // The rest of this batch is leased to us and untouched; hand it back
          // so it is not stranded until the lease expires.
          for (const unstarted of fresh.slice(index)) {
            await gateway.releaseClaim(unstarted.id, `not started: ${beforeRow}`);
          }
          break claiming;
        }

        claimed += 1;
        // Opened per application so one poisoned page cannot corrupt the next.
        const page = await openPage();
        try {
          // The same profile object is reused for every row, which is the point of fetching it once.
          const outcome = await applyToOne({ row, page, gateway, answers, profile, env, renderResume, checkRobots });

          // Counted separately rather than collapsed into a success/failure
          // pair, because these four mean genuinely different things to the
          // person reading the health page.
          if (outcome.kind === 'submitted') submitted += 1;
          else if (outcome.kind === 'blocked') blocked += 1;
          // Counted AND described: a bare count cannot say whether the form was fully filled.
          else if (outcome.kind === 'dry_run_complete') {
            // One line per dry run: the verdict plus each blocker's label and reason.
            dryRun += 1;
            // Labels only (question text), never answer values or profile data.
            console.log(formatDryRunLine(row.id, outcome));
          }
          // Not opened, so not sent: its own tally, and (below) it trips no breaker.
          else if (outcome.kind === 'robots_refused') robotsRefused += 1;
          // Named rather than a bare else, so a new outcome kind cannot be miscounted as unknown.
          else if (outcome.kind === 'submit_outcome_unknown') outcomeUnknown += 1;
          // Exhaustiveness: a new ApplyOutcome arm fails to compile here until it is counted.
          else assertNever(outcome);

          // TRIP THE BREAKER on the first outcome that would repeat for every row: an
          // unconfirmed or failed submit (we cannot tell whether it went out), or a captcha
          // (the next form on this IP will very likely challenge too). Only in a live run;
          // a dry run's outcomes are dry_run_complete and must not stop it.
          if (live && breakerReason === null) {
            // The unknown outcome: the most expensive kind, each one a manual check for Teja.
            if (outcome.kind === 'submit_outcome_unknown') {
              breakerReason = `circuit breaker: submit outcome unknown for ${row.id} (${outcome.error}); no further claims this run`;
            // A captcha, before or after the submit click.
            } else if (outcome.kind === 'blocked' && outcome.reason === 'captcha') {
              breakerReason = `circuit breaker: captcha on ${row.id}; no further claims this run`;
            }
            // Logged at the moment it trips, so the run log says why it ended early.
            if (breakerReason !== null) console.warn(`[claim-loop] ${breakerReason}`);
          }
        } catch (error) {
          // One application failing must not end the run: the other 34 are
          // still worth doing, and the row it failed on keeps its lease and is
          // swept later rather than being retried blind here.
          errors += 1;
          stoppedReason = `continued after error: ${
            error instanceof Error ? error.message : String(error)
          }`;
          // A THROW IN A LIVE RUN TRIPS THE BREAKER TOO. From here the loop cannot tell a
          // throw before `applying` from one after it, e.g. the `applied` write failing after
          // a confirmed send: the application went out, yet neither `submitted` nor
          // `outcomeUnknown` moved, so the cap alone would let the run keep submitting.
          // Stopping is the side that cannot over-send; the row itself is swept later.
          if (live && breakerReason === null) {
            // The reason names the row and the error, so the log says why the run ended early.
            breakerReason = `circuit breaker: error on ${row.id} in a live run (${
              error instanceof Error ? error.message : String(error)
            }); no further claims this run`;
            // Logged at the moment it trips, like the outcome-based trips above.
            console.warn(`[claim-loop] ${breakerReason}`);
          }
        } finally {
          // A leaked page keeps Chromium alive and the job billing until its
          // timeout — a real cost against a budget measured in whole minutes.
          await page.close();
          // Whatever happened to it, the targeted row has had its one attempt.
          if (row.id === input.onlyApplicationId) targetDone = true;
        }
      }

      // APPLY_ONLY_ID: the target has been processed, so the run is over. Without
      // this the loop would keep claiming, and holding, every other approved row.
      if (targetDone) {
        // APPENDED, not assigned: if the target threw, the error text already in
        // stoppedReason is the one fact the operator needs, and must survive.
        stoppedReason = errors > 0
          ? `${stoppedReason}; APPLY_ONLY_ID ${input.onlyApplicationId} processed; run ends here`
          : `APPLY_ONLY_ID ${input.onlyApplicationId} processed; run ends here`;
        break;
      }
    }

    // APPLY_ONLY_ID with a target that was never processed. Two different stories,
    // told apart so "nothing happened" is never misread: a gate (budget, kill
    // switch) stopped the run after the target was claimed, or the queue never
    // handed it to us at all (not `approved`, not ours, or leased elsewhere).
    if (input.onlyApplicationId !== undefined && !targetDone) {
      // `seen` holds every claimed id, so it says whether the target was ever claimed.
      stoppedReason = seen.has(input.onlyApplicationId)
        // Claimed, then a gate stopped the run; the gate's reason is kept.
        ? `${stoppedReason}; APPLY_ONLY_ID ${input.onlyApplicationId} was claimed but not processed (released, still approved)`
        // Never claimed.
        : `APPLY_ONLY_ID ${input.onlyApplicationId} was never claimed (not approved, or leased elsewhere); nothing applied`;
    }

    // Give back every re-claimed row exactly once. Held rather than released
    // on sight, because releasing would make it the oldest unclaimed row again
    // and the very next claim would return it instead of new work.
    for (const id of held) {
      await gateway.releaseClaim(id, 'already processed earlier in this run');
    }

    // Give back every row the APPLY_ONLY_ID filter set aside, untouched and still
    // `approved`: release only, never an advance, so the filter cannot move a row.
    for (const id of notTargeted) {
      await gateway.releaseClaim(id, `APPLY_ONLY_ID: not the targeted application (${input.onlyApplicationId})`);
    }

    return summarise();
  } catch (error) {
    // A throw OUTSIDE the per-application catch: the claim itself refused (42501
    // once the agent key is seeded and missing), the sweep failed, or the profile
    // read did. Counted here so closeRun below records `failed` with the reason;
    // without it the run rejected yet its agent_runs row read `succeeded`, 0
    // errors — a refused run looking like a clean one on the health page.
    errors += 1;
    // The reason the health page shows, replacing whatever the loop had so far.
    stoppedReason = `run failed: ${error instanceof Error ? error.message : String(error)}`;
    // Rethrown unchanged, so the CLI still exits non-zero.
    throw error;
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
      // Reported beside outcomeUnknown so the run log separates "not sent" from "maybe sent".
      robotsRefused,
      errors,
      stoppedReason,
    };
  }
}
