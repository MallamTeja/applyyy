// The approval-queue re-gate (Teja, 2026-11-11): today's work-auth gate, run over rows ALREADY waiting for him.
//
// WHY IT EXISTS: every gate ran once, on the way in (screener, matcher, then the auditor at `tailored`). A row that
// passed an OLDER gate sat in awaiting_approval forever: on 2026-11-11 Teja found 11 foreign jobs there (Budapest,
// Frankfurt, Palo Alto, "NAMER"...), all queued before the place-table fix c22d0d0. A gate fix must also clear the
// rows it would have stopped, without a human hunting them down. postscreen-drain.yml calls this once per drain, so
// it runs after every scout and once a day.
//
// WHY ONLY work_auth: it is the one gate with no judgement in it (Teja may not legally work there). The tech and
// experience gates are fuzzier, and a row he already read and kept is his call; this sweep must never second-guess
// that. The DB enforces the same limit: the auditor may take awaiting_approval -> dropped_filter ONLY with a
// work_auth drop_reason (migration 20261111220000), so a bug here cannot turn into a broad cleanup.
//
// WHY NOT `approved`: an approved row carries Teja's explicit yes, and the graph gives no agent an edge off it. Those
// are REPORTED (`approved_flagged`) so the run log names them, and he withdraws them himself.

// The auditor's one job-gate verdict, reused so the sweep and the `tailored` check can never disagree.
import { auditorPreGateDrop, type AuditorJobEmbed } from "./pregate.ts";
// The gate inputs the verdict needs, loaded by the same loader the matcher calls.
import type { PreGatePreferences } from "../matcher/tech-pregate.ts";

// One queue row as the sweep reads it.
export interface QueueRow {
  // The application.
  readonly id: string;
  // awaiting_approval or approved; anything else is never read.
  readonly status: string;
  // The concurrency stamp: a row Teja touched after this read must not be moved on a stale verdict.
  readonly updated_at: string;
  // The job's gate inputs; null when the job row is missing.
  readonly jobs: AuditorJobEmbed | null;
}

// What the sweep decided for one row; pure, so a test can pin it without a database.
export type RegateVerdict =
  // Passes today's gate, or a non-work-auth objection this sweep leaves to Teja.
  | { readonly kind: "keep" }
  // Fails work-auth while still awaiting approval: the sweep drops it.
  | { readonly kind: "drop"; readonly reason: string }
  // Fails work-auth but Teja already approved it: named in the report, never moved.
  | { readonly kind: "flag_approved"; readonly reason: string };

// The pure decision for one row.
export function regateVerdict(row: QueueRow, preferences: PreGatePreferences): RegateVerdict {
  // The auditor's verdict; it throws on a missing job, which the caller reports as a per-row failure (never a pass).
  const drop = auditorPreGateDrop(row.jobs, preferences);
  // Only the work-auth code acts here (see the header); every other code, and no objection, keeps the row.
  if (drop === null || drop.code !== "work_auth") return { kind: "keep" };
  // Teja's yes stands; report it.
  if (row.status === "approved") return { kind: "flag_approved", reason: drop.reason };
  // Still waiting for him: drop it.
  if (row.status === "awaiting_approval") return { kind: "drop", reason: drop.reason };
  // Any other status was never asked for: refuse loudly rather than guess (CLAUDE.md §6).
  throw new Error(`regate: unexpected status ${row.status}`);
}

// The two database calls the sweep makes, typed narrowly so a test double has to behave like supabase-js.
export interface RegateDb {
  // Writes drop_reason only while the row is still awaiting approval at the stamp we read; returns the new stamp.
  stampDropReason(id: string, expectedUpdatedAt: string): Promise<{ updatedAt: string | null; error: string | null }>;
  // The status move, through advance_application_status, guarded by the stamp the first write returned.
  dropRow(id: string, updatedAt: string, reason: string): Promise<{ error: string | null }>;
}

// The run's tally, returned in the auditor's response and in the drain log.
export interface RegateReport {
  // Rows read.
  checked: number;
  // Rows moved to dropped_filter.
  dropped: Array<{ id: string; reason: string }>;
  // Approved rows that fail the gate today, for Teja to withdraw.
  approved_flagged: Array<{ id: string; reason: string }>;
  // Rows changed by someone else between the read and the write: left alone, judged again next run.
  skipped_stale: number;
  // Per-row errors (missing job, refused write); never a silent pass.
  failures: Array<{ id: string; error: string }>;
}

// Run the sweep over rows already read.
export async function regateQueue(rows: readonly QueueRow[], preferences: PreGatePreferences, db: RegateDb): Promise<RegateReport> {
  // An empty tally; every row lands in exactly one bucket (or `keep`, which needs none).
  const report: RegateReport = { checked: rows.length, dropped: [], approved_flagged: [], skipped_stale: 0, failures: [] };
  // One row at a time: ~120 rows of pure work plus a handful of writes, no batching needed.
  for (const row of rows) {
    // Any throw (a missing job) is this row's failure, never the run's and never a pass.
    try {
      // The decision.
      const verdict = regateVerdict(row, preferences);
      // Kept: nothing to do.
      if (verdict.kind === "keep") continue;
      // Approved: report only.
      if (verdict.kind === "flag_approved") { report.approved_flagged.push({ id: row.id, reason: verdict.reason }); continue; }
      // Step 1, the reason first (the matcher's order), guarded by the stamp so a row Teja just touched is left alone.
      const stamped = await db.stampDropReason(row.id, row.updated_at);
      // A refused write: reported.
      if (stamped.error !== null) { report.failures.push({ id: row.id, error: stamped.error }); continue; }
      // No row matched: Teja (or another run) changed it after our read. His action wins.
      if (stamped.updatedAt === null) { report.skipped_stale += 1; continue; }
      // Step 2, the move, guarded by OUR write's stamp.
      const moved = await db.dropRow(row.id, stamped.updatedAt, verdict.reason);
      // A refused move leaves the row at awaiting_approval with a reason no reader uses there; reported.
      if (moved.error !== null) { report.failures.push({ id: row.id, error: moved.error }); continue; }
      // Off the queue.
      report.dropped.push({ id: row.id, reason: verdict.reason });
    } catch (error) {
      // The message, not the object, so the response stays JSON.
      report.failures.push({ id: row.id, error: error instanceof Error ? error.message : String(error) });
    }
  }
  // The tally.
  return report;
}
