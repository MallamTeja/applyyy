// THE SHARED STAGE LOOP. All five agents are this function plus a per-row handler.
//
// WHY THE SKELETON IS SHARED RATHER THAN COPIED FIVE TIMES: everything it does is a rule
// that must hold for EVERY agent, and five copies means five chances to get one of them
// wrong in a way that is invisible until it matters:
//
//   1. THE KILL SWITCH IS CHECKED FIRST (§18.1, safety-critical). Before the run row,
//      before the sweep, before the claim.
//   2. Open a run row BEFORE the work, so a crash leaves a visible `running` row. A
//      missing row and a successful run look identical — the §14 silent death.
//   3. SWEEP BEFORE CLAIMING, so a crashed peer's rows are available to THIS run.
//   4. CLAIM A BOUNDED BATCH and let `pg_cron` re-fire. An agent written to "process all
//      pending" passes on ten rows and fails on four hundred.
//   5. NO ROLLBACK ANYWHERE. Claiming takes a lease and never advances `status`, so an
//      agent that gives up has nothing to undo: it calls `release_application_claim` and
//      the row is picked up next run. `previous_status` is informational — never branch.
//   6. Close the run out with a status the health page can act on, distinguishing
//      "paused", "out of quota", "nothing to do" and "broken". Those four look identical
//      from outside and want four different responses.
//
// THE ONE THING THIS LOOP WILL NOT DO IS RETRY. Nothing here increments `retry_count`
// and nothing backs off, so a row that fails deterministically is re-claimed on every
// tick forever. Called out rather than quietly accepted: it is a real gap, it is bounded
// (a failing row costs one Gemini call per tick, not a runaway), and the fix belongs with
// whoever owns the retry policy rather than being invented here.

// Rows and enums from the schema owner. Imported, never redefined.
import type { AgentName, AgentRunStatus, ApplicationRow, ApplicationStatus } from "../contracts/shared-types.ts";
// The derived batch sizes. A stage cannot choose its own.
import { batchSizeFor } from "./batch.ts";
// The kill switch, checked first.
import { checkKillSwitch } from "./kill-switch.ts";
// The ports this loop needs. Deliberately only two: no `GeminiPort`, no `JobPort` — the
// loop is stage-agnostic, and everything stage-specific happens inside `handleRow`.
import type { QueuePort, RunPort } from "./port.ts";

// What one row's handler decided.
//
// A CLOSED SET RATHER THAN A BOOLEAN, because "did the row work?" has four operationally
// different answers and collapsing them is what produces a health page nobody trusts.
export type RowOutcome =
  // Advanced to the next status. `geminiCalls` is reported so the observability panel
  // counts what was actually spent rather than what we assumed a stage spends.
  | { readonly kind: "advanced"; readonly geminiCalls?: number }
  // The handler decided this row should be given back untouched for a non-quota reason —
  // a missing master profile, say. Not an error, and not progress either.
  | { readonly kind: "released"; readonly reason: string }
  // Something went wrong with THIS row. The batch continues: one malformed model
  // response must not cost the other four rows their turn.
  | { readonly kind: "errored"; readonly detail: string; readonly geminiCalls?: number }
  // EVERY GEMINI KEY IS COOLING, or the daily budget is spent. Stops the batch, because
  // the next row would hit the same empty pool — and it is NOT an error (§14).
  | { readonly kind: "quota_exhausted" }
  // The key pool has no rows at all, because nothing ever seeded it. Same SQL NULL as
  // cooling and the OPPOSITE response: this one never self-heals, so it stops the batch
  // AND fails the run so it reaches the health page immediately.
  | { readonly kind: "needs_human"; readonly detail: string };

// How the whole stage ended.
export interface StageOutcome {
  // What the run row says.
  readonly status: AgentRunStatus;
  // Rows claimed.
  readonly rowsIn: number;
  // Rows advanced.
  readonly rowsOut: number;
  // Rows that errored.
  readonly errorCount: number;
  // Gemini calls actually spent.
  readonly geminiCalls: number;
  // Everything a human might need, joined into one string for `agent_runs.error_detail`.
  readonly errorDetail: string | null;
  // Whether the stage refused to run at all. Distinct from `status` so a caller can
  // answer 200-with-an-explanation rather than an error for a paused system.
  readonly halted: boolean;
}

// One stage's definition. `Ctx` is whatever the stage loads once for the whole batch —
// filter rules, the master profile, the jobs behind the rows.
export interface StageOptions<Ctx> {
  // Who is acting. Used for `claimed_by`, for the run row, and as the transition actor.
  readonly agent: AgentName;
  // Which status this stage claims from.
  readonly inputStatus: ApplicationStatus;
  // Settings, run bookkeeping, sweeping.
  readonly run: RunPort;
  // Claiming, advancing, releasing, patching.
  readonly queue: QueuePort;
  // Load whatever the whole batch shares, ONCE. A per-row load would turn the Screener's
  // 200 rows into 800 round trips, and the CPU budget is ~2s.
  readonly prepare: (
    rows: readonly ApplicationRow[],
  ) => Promise<
    | { readonly ok: true; readonly context: Ctx; readonly warnings?: readonly string[] }
    | { readonly ok: false; readonly reason: string }
  >;
  // Do one row.
  readonly handleRow: (row: ApplicationRow, context: Ctx) => Promise<RowOutcome>;
  // Override the derived batch size. Present ONLY for the Auditor's second phase, which
  // claims from two statuses in one invocation and must split its budget between them.
  // Not a general tuning knob: the default comes from the CPU-limit derivation.
  readonly batchSize?: number;
}

// Run one stage.
export async function runStage<Ctx>(options: StageOptions<Ctx>): Promise<StageOutcome> {
  // ── 1. THE KILL SWITCH, FIRST, BEFORE ANYTHING ELSE ──────────────────────────────
  // Nothing above this line touches the queue, opens a run, or sweeps. That ordering is
  // the safety property, and it is asserted by an EXACT transcript comparison in the
  // tests rather than by a "does not include" check — because a loop that claimed first
  // and checked second would pass a negative assertion on the final call.
  const verdict = await checkKillSwitch(options.run);
  // Refused for one of three reasons, all of which halt.
  if (!verdict.allowed) {
    // A deliberate pause is `skipped_disabled`; a broken control panel is `failed`. The
    // health page must not report an incident for a switch Teja flipped on purpose, and
    // must report one for a settings row it could not read.
    const status: AgentRunStatus = verdict.reason === "disabled" ? "skipped_disabled" : "failed";
    // Record the halt so "the stage ran and was told no" is distinguishable from "the
    // stage never ran" — that distinction IS the §14 silent death.
    const opened = await options.run.openRun(options.agent, status);
    // The run id, or null when even the insert failed.
    const runId = opened.ok ? opened.value : null;
    // The reason travels onto the row, so the difference between a pause, an
    // un-bootstrapped account and an unreadable panel is visible without the log.
    const detail = verdict.detail === null ? verdict.reason : `${verdict.reason}: ${verdict.detail}`;
    // Close it immediately: nothing was attempted, so there is nothing to leave open.
    await options.run.closeRun(runId, {
      status,
      rowsIn: 0,
      rowsOut: 0,
      errorCount: 0,
      errorDetail: detail,
      geminiCalls: 0,
    });
    // Halted.
    return { status, rowsIn: 0, rowsOut: 0, errorCount: 0, geminiCalls: 0, errorDetail: detail, halted: true };
  }

  // ── 2. OPEN THE RUN BEFORE THE WORK ──────────────────────────────────────────────
  // A crash after this point leaves a `running` row the health page can show as stuck.
  const opened = await options.run.openRun(options.agent);
  // May be null: losing observability must not lose the work.
  const runId = opened.ok ? opened.value : null;
  // Diagnostics accumulated across the whole run, joined into `error_detail` at the end.
  const notes: string[] = [];
  // Note the missing run row rather than swallowing it — a stage whose runs never appear
  // on the health page looks like a stage that never fires.
  if (!opened.ok) notes.push(`openRun failed: ${opened.reason}`);

  // ── 3. SWEEP BEFORE CLAIMING ─────────────────────────────────────────────────────
  // Reclaims leases from a crashed peer, so those rows are visible to THIS claim rather
  // than waiting a whole tick. Cheap, and it is what makes a crashed agent self-heal.
  const swept = await options.run.sweepStaleClaims();
  // A sweep failure is not fatal: the lease will still expire and the next run retries.
  if (!swept.ok) {
    // Recorded, because a sweeper that has silently stopped is how stuck rows accumulate.
    notes.push(`sweep failed: ${swept.reason}`);
  } else if (swept.value.needsVerificationCount > 0 || swept.value.releasedCount > 0) {
    // SAFETY-CRITICAL WHEN NON-ZERO. A stale `applying` row routed to
    // `needs_verification` means a worker died mid-submit and nobody knows whether the
    // application landed — a human must check the employer's portal before that row moves
    // again. `released` is reported alongside it but is NOT a metric to trust: the SQL
    // double-counts rows its own first statement just moved.
    notes.push(`swept released=${swept.value.releasedCount} needs_verification=${swept.value.needsVerificationCount}`);
  }

  // ── 4. CLAIM A BOUNDED BATCH ─────────────────────────────────────────────────────
  // The size comes from the CPU-limit derivation, never from the queue depth.
  const limit = options.batchSize ?? batchSizeFor(options.agent);
  // `agent:runId` per §6. The fallback marker is a WORD rather than the string "null",
  // which would be indistinguishable from a real run id in a `claimed_by` column.
  const claimedBy = `${options.agent}:${runId ?? "unrecorded"}`;
  // Take the lease. Returns [] when the kill switch is off — checked inside the SQL too,
  // so the switch is enforced twice and can be forgotten by neither layer.
  const claimed = await options.queue.claimApplications(options.inputStatus, claimedBy, limit);
  // An unreachable queue is an OUTAGE, and it must not be reported as the empty batch a
  // quiet day produces. Those two look identical in every column except this one.
  if (!claimed.ok) {
    // Note it.
    notes.push(`claim failed: ${claimed.reason}`);
    // Close as failed.
    return await finish(options, runId, "failed", 0, 0, 1, 0, notes);
  }
  // The batch.
  const rows = claimed.value;
  // NOTHING TO DO is the ordinary state of a cron-fired stage. Answer before preparing:
  // loading context for zero rows is pure waste, repeated every tick, forever.
  if (rows.length === 0) return await finish(options, runId, "succeeded", 0, 0, 0, 0, notes);

  // ── 5. PREPARE ONCE FOR THE WHOLE BATCH ──────────────────────────────────────────
  const prepared = await options.prepare(rows);
  // Could not build the context — unreadable filter rules, a missing master profile.
  if (!prepared.ok) {
    // GIVE EVERY ROW BACK. A row claimed and then abandoned is invisible for its whole
    // lease, which presents as "the pipeline is slow" rather than as a failure.
    for (const row of rows) await options.queue.releaseClaim(row.id, options.agent, prepared.reason);
    // Note and fail.
    notes.push(`prepare failed: ${prepared.reason}`);
    // Nothing advanced on a context we could not build.
    return await finish(options, runId, "failed", rows.length, 0, 1, 0, notes);
  }
  // Warnings are not failures: a misconfigured filter rule must be VISIBLE without
  // stopping the other rules from protecting the quota.
  if (prepared.warnings !== undefined) notes.push(...prepared.warnings);

  // ── 6. ONE ROW AT A TIME ─────────────────────────────────────────────────────────
  // Rows advanced.
  let rowsOut = 0;
  // Rows that errored.
  let errorCount = 0;
  // Gemini calls actually spent.
  let geminiCalls = 0;
  // Set when the batch stops early, so the run status reflects WHY it stopped.
  let stopped: "quota" | "needs_human" | null = null;
  // Sequential rather than parallel, deliberately: five concurrent Gemini calls would
  // claim five keys at once and turn the pool's least-recently-used ordering into a
  // thundering herd, which is the exact failure the SQL-side LRU exists to prevent.
  for (let index = 0; index < rows.length; index += 1) {
    // The row. Indexed rather than `for..of` because the quota path needs the remainder.
    const row = rows[index] as ApplicationRow;
    // Do the stage's actual work.
    const outcome = await options.handleRow(row, prepared.context);
    // Tally whatever the call cost, on every path — the pool learns its capacity from
    // what was really spent, and a call omitted from the count is capacity we cannot see.
    if (outcome.kind === "advanced" || outcome.kind === "errored") geminiCalls += outcome.geminiCalls ?? 0;
    // EVERY KEY COOLING, or the pool is empty. Both stop the batch, for opposite reasons.
    if (outcome.kind === "quota_exhausted" || outcome.kind === "needs_human") {
      // Remember which, because one is normal and one needs a person.
      stopped = outcome.kind === "quota_exhausted" ? "quota" : "needs_human";
      // The empty-pool case is worth its own note; ordinary cooling deliberately is not,
      // because a health page that cries wolf about routine quota behaviour is a page
      // Teja stops reading.
      if (outcome.kind === "needs_human") notes.push(outcome.detail);
      // GIVE BACK THIS ROW AND EVERY ROW NOT YET OFFERED. NO STATUS WRITE: claiming never
      // advanced the status, so there is nothing to roll back and no backward edge to
      // walk. This is the whole of the "quota exhaustion is not an error" design.
      for (const remaining of rows.slice(index)) {
        await options.queue.releaseClaim(remaining.id, options.agent, outcome.kind);
      }
      // Stop. The next row would hit the same empty pool.
      break;
    }
    // A row-level failure. The batch continues.
    if (outcome.kind === "errored") {
      // Counted.
      errorCount += 1;
      // Kept for the run row, truncated by the join at the end rather than here.
      notes.push(`${row.id}: ${outcome.detail}`);
      // Released so the next tick can retry immediately rather than waiting out the
      // lease. Nothing increments `retry_count`, which is the gap named in the header.
      await options.queue.releaseClaim(row.id, options.agent, "errored");
      // Next row.
      continue;
    }
    // The handler chose to give the row back for a non-quota reason.
    if (outcome.kind === "released") {
      // Recorded, because a stage that releases every row looks identical to one that
      // has nothing to do.
      notes.push(`${row.id}: released (${outcome.reason})`);
      // Handed back.
      await options.queue.releaseClaim(row.id, options.agent, outcome.reason);
      // Next row.
      continue;
    }
    // Advanced.
    rowsOut += 1;
  }

  // ── 7. CLOSE THE RUN WITH A STATUS THE HEALTH PAGE CAN ACT ON ───────────────────
  // Ordinary quota exhaustion. NOT a failure: nothing is lost and it self-heals.
  const status: AgentRunStatus = stopped === "quota"
    ? "skipped_quota"
    // An empty key pool never self-heals, so it must reach the health page as a failure
    // even though the SQL returned the same NULL as cooling.
    : stopped === "needs_human"
    ? "failed"
    // No progress at all is the signal a systematic bug produces...
    : rowsOut === 0 && errorCount > 0
    ? "failed"
    // ...whereas partial progress is a successful run. A run marked failed because one
    // row of five was malformed would make the health page useless within a week.
    : "succeeded";
  // Write it.
  return await finish(options, runId, status, rows.length, rowsOut, errorCount, geminiCalls, notes);
}

// Close the run row and return the outcome. Extracted so every exit path writes the run
// EXACTLY once — a path that forgets leaves a permanently `running` row, which the health
// page correctly reports as a stuck agent and a human then investigates for nothing.
async function finish<Ctx>(
  // The stage, for its port and agent name.
  options: StageOptions<Ctx>,
  // The run row, or null if it was never created.
  runId: string | null,
  // The verdict.
  status: AgentRunStatus,
  // Counts.
  rowsIn: number,
  rowsOut: number,
  errorCount: number,
  geminiCalls: number,
  // Accumulated diagnostics.
  notes: readonly string[],
): Promise<StageOutcome> {
  // One string, or null when there is genuinely nothing to say. An empty string would
  // render as a blank detail field and read as "detail lost".
  const errorDetail = notes.length === 0 ? null : notes.join(" | ");
  // Persist. A failure here is logged rather than thrown: the work has already happened,
  // and losing the record of it must not undo it.
  const closed = await options.run.closeRun(runId, {
    status,
    rowsIn,
    rowsOut,
    errorCount,
    errorDetail,
    geminiCalls,
  });
  // Visible in the function log without derailing the caller.
  if (!closed.ok) console.error(`[${options.agent}] closeRun failed: ${closed.reason}`);
  // The caller turns this into an HTTP response.
  return { status, rowsIn, rowsOut, errorCount, geminiCalls, errorDetail, halted: false };
}
