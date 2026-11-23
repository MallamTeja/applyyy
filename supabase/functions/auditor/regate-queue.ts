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
//
// ALREADY APPLIED (W2, 2026-11-21): the second no-judgement drop. An awaiting row whose job has the same ATS provider
// and id as a COMMITTED application (approved or later) is a copy of a posting Teja already said yes to: a fact
// about two rows, not a reading of prose. Only awaiting rows are checked (an approved row is itself committed and
// would match its own key), and queued history is left out for the same self-match reason. Migration
// 20261121110000 opens the trigger to this one extra drop_reason.
//
// EXPERIENCE (D9b, orch ruling A 2026-11-21): REPORTED in `experience_flagged`, never moved. The 11-11 rule above
// stands until Teja changes it himself; auto-dropping it later is a one-line verdict change plus the trigger.
//
// R4 (2026-11-21), two gaps closed:
// - TECH NO LONGER HIDES WORK-AUTH. The sweep used firstPreGateDrop, which stops at the first code; a row failing
//   tech (a code this sweep never acts on) had its work-auth failure hidden, and stayed in Teja's queue. The verdict
//   now asks the work-auth and experience gates directly (auditorRegateGates).
// - QUEUED TWINS. Two awaiting rows for the same ATS posting both stayed (W2 matches committed history only). History
//   shows it costs: one posting was APPLIED TWICE (live, 2026-11-21). The OLDEST queued copy owns the posting
//   (created_at, then id); a newer copy drops as already_applied, the same no-judgement class as W2 (two rows' keys
//   compared, no prose read), so the 20261121110000 trigger already allows it.

// The auditor's gates, already-applied verdict and posting key, reused so the sweep and the `tailored` check agree.
import { auditorAlreadyAppliedDrop, auditorAtsKey, auditorRegateGates, type AuditorJobEmbed } from "./pregate.ts";
// "Teja pasted this himself": his pick is never dropped as a twin.
import { isHumanPicked } from "../_shared/match/score-threshold.ts";
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
  // When the row was created: the oldest queued copy of a posting owns it (r4). Required, so no read can leave it out.
  readonly created_at: string;
  // The job's gate inputs; null when the job row is missing.
  readonly jobs: AuditorJobEmbed | null;
}

// The only drop_reasons this sweep may write; the DB trigger accepts exactly these from the auditor on this edge.
// title_seniority since 2026-11-21 (Teja 20:12, "Drop AVP/VP/Director"): migration 20261121203000 opens the trigger to it.
// language_required since 2026-11-23 (BBHT 5e108a32): migration 20261123210000 opens the trigger to it.
export type RegateDropCode = "work_auth" | "already_applied" | "title_seniority" | "language_required";

// What the sweep decided for one row; pure, so a test can pin it without a database.
export type RegateVerdict =
  // Passes today's gates, or an objection this sweep leaves to Teja.
  | { readonly kind: "keep" }
  // Fails work-auth, or copies a committed posting, while still awaiting approval: the sweep drops it.
  | { readonly kind: "drop"; readonly code: RegateDropCode; readonly reason: string }
  // Fails work-auth but Teja already approved it: named in the report, never moved.
  | { readonly kind: "flag_approved"; readonly reason: string }
  // Over the experience ceiling: named in the report for Teja, never moved (D9b ruling A).
  | { readonly kind: "flag_experience"; readonly reason: string };

// The owner of each posting in the queue: ATS key -> id of the OLDEST awaiting row holding it (created_at, then id, so
// the answer never depends on read order). Every awaiting keyed row competes, a pasted one too: an older pasted copy
// owns the posting, and only a newer scouted copy can be dropped. Rows without a job or a key own nothing.
export function queuedTwinOwners(rows: readonly QueueRow[]): ReadonlyMap<string, string> {
  // Key -> the oldest row seen so far.
  const oldest = new Map<string, QueueRow>();
  // Each row.
  for (const row of rows) {
    // Only rows still waiting for Teja; an approved copy is committed history, which W2 already reads.
    if (row.status !== "awaiting_approval" || row.jobs === null) continue;
    // Its posting key, or none.
    const key = auditorAtsKey(row.jobs);
    // No identity, no twin.
    if (key === null) continue;
    // A stamp that is not a time cannot be ranked by age; such a row never owns a posting (it may still be dropped as a
    // twin of a row that does, so at least one copy always stays). Postgres timestamptz always parses; this is the guard.
    if (Number.isNaN(Date.parse(row.created_at))) continue;
    // The current holder.
    const held = oldest.get(key);
    // Older wins; a tie on created_at falls to the smaller id. Timestamps compare as instants, never as strings.
    const older = held === undefined || Date.parse(row.created_at) < Date.parse(held.created_at)
      || (Date.parse(row.created_at) === Date.parse(held.created_at) && row.id < held.id);
    // Replace the holder.
    if (older) oldest.set(key, row);
  }
  // Key -> owner id.
  return new Map([...oldest].map(([key, row]) => [key, row.id] as const));
}

// The pure decision for one row. `committedKeys` are ATS keys of committed applications only (see the header);
// `queuedOwners` is queuedTwinOwners over the same read (required, so no caller can forget the twin check).
export function regateVerdict(row: QueueRow, preferences: PreGatePreferences, committedKeys: ReadonlySet<string>, queuedOwners: ReadonlyMap<string, string>): RegateVerdict {
  // Both gates the sweep acts on, each asked directly (r4: tech no longer hides them); throws on a missing job.
  const gates = auditorRegateGates(row.jobs, preferences);
  // Work-auth first, as before.
  if (gates.workAuth !== null) {
    // Teja's yes stands; report it.
    if (row.status === "approved") return { kind: "flag_approved", reason: gates.workAuth.reason };
    // Still waiting for him: drop it.
    if (row.status === "awaiting_approval") return { kind: "drop", code: "work_auth", reason: gates.workAuth.reason };
    // Any other status was never asked for: refuse loudly rather than guess (CLAUDE.md §6).
    throw new Error(`regate: unexpected status ${row.status}`);
  }
  // A senior grade (title word, or a grade line in the JD): Teja ruled these drop (2026-11-21 20:12). Same shape as
  // work-auth: his yes on an approved row stands and is reported; a waiting row drops.
  if (gates.seniority !== null) {
    // Approved: report only.
    if (row.status === "approved") return { kind: "flag_approved", reason: gates.seniority.reason };
    // Still waiting for him: drop it under the rule's one code.
    if (row.status === "awaiting_approval") return { kind: "drop", code: "title_seniority", reason: gates.seniority.reason };
    // Any other status was never asked for.
    throw new Error(`regate: unexpected status ${row.status}`);
  }
  // A JD requiring a language the user does not speak (2026-11-23): same shape as work-auth and seniority, his yes on an
  // approved row stands and is reported; a waiting row drops.
  if (gates.language !== null) {
    // Approved: report only.
    if (row.status === "approved") return { kind: "flag_approved", reason: gates.language.reason };
    // Still waiting for him: drop it under the gate's own code.
    if (row.status === "awaiting_approval") return { kind: "drop", code: "language_required", reason: gates.language.reason };
    // Any other status was never asked for.
    throw new Error(`regate: unexpected status ${row.status}`);
  }
  // Already applied or already queued: awaiting rows only (an approved row would match its own committed key).
  if (row.status === "awaiting_approval") {
    // The same pure check the main run uses on `tailored` rows.
    const applied = auditorAlreadyAppliedDrop(row.jobs, committedKeys);
    // A copy of a committed posting: drop it.
    if (applied !== null) return { kind: "drop", code: "already_applied", reason: applied.reason };
    // The posting's key (row.jobs is non-null here: auditorRegateGates threw otherwise).
    const key = auditorAtsKey(row.jobs!);
    // The oldest queued copy of the same posting, when it is another row.
    const owner = key === null ? undefined : queuedOwners.get(key);
    // A newer scouted twin drops; Teja's own pasted copy is never dropped by the sweep.
    if (owner !== undefined && owner !== row.id && !isHumanPicked(row.jobs!.discovered_via)) {
      // Named with the copy that stays, so he can find it.
      return { kind: "drop", code: "already_applied", reason: `an older copy of this ATS posting is already awaiting approval (${owner}, ${key})` };
    }
  }
  // Over the ceiling: report only, whatever the status.
  if (gates.experience !== null) return { kind: "flag_experience", reason: gates.experience.reason };
  // Nothing this sweep acts on.
  return { kind: "keep" };
}

// The two database calls the sweep makes, typed narrowly so a test double has to behave like supabase-js.
export interface RegateDb {
  // Writes drop_reason `code` only while the row is still awaiting approval at the stamp we read; returns the new stamp.
  stampDropReason(id: string, expectedUpdatedAt: string, code: RegateDropCode): Promise<{ updatedAt: string | null; error: string | null }>;
  // The status move, through advance_application_status, guarded by the stamp the first write returned.
  dropRow(id: string, updatedAt: string, code: RegateDropCode, reason: string): Promise<{ error: string | null }>;
}

// The run's tally, returned in the auditor's response and in the drain log.
export interface RegateReport {
  // Rows read.
  checked: number;
  // Rows moved to dropped_filter, with the drop_reason written.
  dropped: Array<{ id: string; code: RegateDropCode; reason: string }>;
  // Approved rows that fail the gate today, for Teja to withdraw.
  approved_flagged: Array<{ id: string; reason: string }>;
  // Rows over the experience ceiling, for Teja to judge (never moved by this sweep).
  experience_flagged: Array<{ id: string; reason: string }>;
  // Rows changed by someone else between the read and the write: left alone, judged again next run.
  skipped_stale: number;
  // Per-row errors (missing job, refused write); never a silent pass.
  failures: Array<{ id: string; error: string }>;
}

// Run the sweep over rows already read.
export async function regateQueue(rows: readonly QueueRow[], preferences: PreGatePreferences, committedKeys: ReadonlySet<string>, db: RegateDb): Promise<RegateReport> {
  // An empty tally; every row lands in exactly one bucket (or `keep`, which needs none).
  const report: RegateReport = { checked: rows.length, dropped: [], approved_flagged: [], experience_flagged: [], skipped_stale: 0, failures: [] };
  // Who owns each queued posting, computed once over the whole read (r4 queued twins).
  const owners = queuedTwinOwners(rows);
  // One row at a time: ~120 rows of pure work plus a handful of writes, no batching needed.
  for (const row of rows) {
    // Any throw (a missing job) is this row's failure, never the run's and never a pass.
    try {
      // The decision.
      const verdict = regateVerdict(row, preferences, committedKeys, owners);
      // Kept: nothing to do.
      if (verdict.kind === "keep") continue;
      // Approved: report only.
      if (verdict.kind === "flag_approved") { report.approved_flagged.push({ id: row.id, reason: verdict.reason }); continue; }
      // Experience: report only.
      if (verdict.kind === "flag_experience") { report.experience_flagged.push({ id: row.id, reason: verdict.reason }); continue; }
      // Step 1, the reason first (the matcher's order), guarded by the stamp so a row Teja just touched is left alone.
      const stamped = await db.stampDropReason(row.id, row.updated_at, verdict.code);
      // A refused write: reported.
      if (stamped.error !== null) { report.failures.push({ id: row.id, error: stamped.error }); continue; }
      // No row matched: Teja (or another run) changed it after our read. His action wins.
      if (stamped.updatedAt === null) { report.skipped_stale += 1; continue; }
      // Step 2, the move, guarded by OUR write's stamp.
      const moved = await db.dropRow(row.id, stamped.updatedAt, verdict.code, verdict.reason);
      // A refused move leaves the row at awaiting_approval with a reason no reader uses there; reported.
      if (moved.error !== null) { report.failures.push({ id: row.id, error: moved.error }); continue; }
      // Off the queue.
      report.dropped.push({ id: row.id, code: verdict.code, reason: verdict.reason });
    } catch (error) {
      // The message, not the object, so the response stays JSON.
      report.failures.push({ id: row.id, error: error instanceof Error ? error.message : String(error) });
    }
  }
  // The tally.
  return report;
}
