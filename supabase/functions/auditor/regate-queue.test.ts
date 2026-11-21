// The approval-queue re-gate (2026-11-11): Teja found 11 foreign jobs waiting for him, all queued before the gate fix
// c22d0d0. These tests pin that the sweep drops a foreign awaiting row, only flags an approved one, keeps an Indian
// one and a non-work-auth objection, and leaves a row alone when someone touched it after the read.
import { describe, test } from "node:test";
// Strict deep equality, so a changed report shape fails here.
import assert from "node:assert/strict";
// The unit under test.
import { regateQueue, regateVerdict, type QueueRow, type RegateDb } from "./regate-queue.ts";
// The preference shape, checked against the real type.
import type { PreGatePreferences } from "../matcher/tech-pregate.ts";
// The history key builder, so the committed set below is keyed exactly as the auditor keys it.
import { atsJobKeyOf } from "../_shared/filter/cascade.ts";

// Teja's live config (as in pregate.test.ts): India/Nepal/Bhutan, remote open unless locked elsewhere.
const LIVE: PreGatePreferences = {
  // Titles the queue rows match, so the tech gate never objects first.
  titles: ["Engineer", "Developer"],
  // Live keywords.
  keywords: ["React", "TypeScript"],
  // Live exclusions; "Senior" lets one fixture hit a non-work-auth gate.
  excludedKeywords: ["Senior"],
  // Live work-auth list.
  workAuthorizedCountries: ["India", "Nepal", "Bhutan"],
  // Live remote policy.
  remoteLocationPolicy: "unlocked_or_authorized",
  // Live ceiling.
  experienceMaxYears: 1,
};

// A queue row with a job at the given place and title.
function row(id: string, status: string, location: string, title = "Fullstack Engineer"): QueueRow {
  // Found by a scout, never pasted (pasted rows skip every automatic gate).
  return { id, status, updated_at: "2026-11-11T10:00:00.000000+00:00", jobs: { title, description_raw: "Build React apps.", location_raw: location, min_experience_years: null, discovered_via: ["greenhouse"] } };
}

// No committed history: the work-auth cases below must not depend on it.
const NO_HISTORY: ReadonlySet<string> = new Set<string>();

// The COMMITTED history (approved and later): the Canonical posting Teja already applied to (greenhouse 5150422).
const COMMITTED = new Set([atsJobKeyOf("greenhouse", "5150422")!]);

// An Indian queue row whose job is a copy of that applied posting (another title, same provider and id).
function copyRow(id: string, status: string): QueueRow {
  // The base row, at a place work-auth passes, so only the history can object.
  const base = row(id, status, "Bengaluru, India", "Web Engineer - JS, TS");
  // The same ATS identity as the applied job.
  return { ...base, jobs: { ...base.jobs!, ats_provider: "greenhouse", ats_job_id: "5150422" } };
}

// An Indian awaiting row whose JD asks for more years than the live ceiling (1).
function seniorJdRow(id: string, status = "awaiting_approval"): QueueRow {
  // The base row, at a place work-auth passes.
  const base = row(id, status, "Bengaluru, India");
  // A hard minimum the parser reads (the Axiad shape the required-experience tests pin).
  return { ...base, jobs: { ...base.jobs!, description_raw: "Build React apps. Requirements: 5+ years of professional software development experience." } };
}

// A recording double that answers like supabase-js: { error } values, never throws.
function fakeDb(staleIds: string[] = []): RegateDb & { moves: string[]; codes: string[] } {
  // Every row the double moved, in order.
  const moves: string[] = [];
  // The drop_reason each stamp wrote, in order, so a test can pin the code the DB trigger reads.
  const codes: string[] = [];
  // The double.
  return {
    // Records the moves for the assertions.
    moves,
    // Records the stamped codes for the assertions.
    codes,
    // A stale row matches nothing: null stamp, no error (what an .eq() miss returns).
    async stampDropReason(id, _expected, code) { codes.push(code); return staleIds.includes(id) ? { updatedAt: null, error: null } : { updatedAt: "2026-11-11T16:00:00.000000+00:00", error: null }; },
    // The move succeeds and is recorded.
    async dropRow(id) { moves.push(id); return { error: null }; },
  };
}

describe("regateVerdict", () => {
  test("foreign awaiting row drops; foreign approved row is only flagged; Indian row and a seniority objection are kept", () => {
    // Budapest (Silicon Labs, one of the 11) waiting for Teja.
    assert.equal(regateVerdict(row("a", "awaiting_approval", "Budapest"), LIVE, NO_HISTORY).kind, "drop");
    // The same place, already approved: his yes stands.
    assert.equal(regateVerdict(row("b", "approved", "Budapest"), LIVE, NO_HISTORY).kind, "flag_approved");
    // India passes.
    assert.equal(regateVerdict(row("c", "awaiting_approval", "Bengaluru, India"), LIVE, NO_HISTORY).kind, "keep");
    // A non-work-auth objection is Teja's call, never this sweep's.
    assert.equal(regateVerdict(row("d", "awaiting_approval", "Bengaluru, India", "Senior Engineer"), LIVE, NO_HISTORY).kind, "keep");
  });

  test("W2: an awaiting copy of a committed ATS posting drops as already_applied", () => {
    // The retitled copy of the applied Canonical posting, still waiting for Teja.
    const verdict = regateVerdict(copyRow("w", "awaiting_approval"), LIVE, COMMITTED);
    // Dropped, under the code the DB trigger is opened for.
    assert.deepEqual(verdict.kind === "drop" ? verdict.code : verdict.kind, "already_applied");
  });

  test("W2: an approved copy, a pasted copy and an unrelated posting are never dropped for already_applied", () => {
    // An approved row carries Teja's yes and no agent edge leaves it.
    assert.equal(regateVerdict(copyRow("w", "approved"), LIVE, COMMITTED).kind, "keep");
    // Pasted by Teja: re-applying is his choice.
    const pasted = copyRow("p", "awaiting_approval");
    // Same identity, discovered by hand.
    assert.equal(regateVerdict({ ...pasted, jobs: { ...pasted.jobs!, discovered_via: ["manual"] } }, LIVE, COMMITTED).kind, "keep");
    // Another id at the same board is another posting.
    assert.equal(regateVerdict({ ...pasted, jobs: { ...pasted.jobs!, ats_job_id: "9999999" } }, LIVE, COMMITTED).kind, "keep");
  });

  test("D9b: an experience_ceiling row is only reported, never dropped (Teja 2026-11-11: auditor drops for work_auth ONLY)", () => {
    // Waiting for Teja: reported for him, not moved.
    assert.equal(regateVerdict(seniorJdRow("e"), LIVE, NO_HISTORY).kind, "flag_experience");
    // Already approved: also only reported.
    assert.equal(regateVerdict(seniorJdRow("f", "approved"), LIVE, NO_HISTORY).kind, "flag_experience");
  });
});

describe("regateQueue", () => {
  test("moves only the foreign awaiting row, reports the approved one, skips a stale one, and reports a missing job", async () => {
    // The double; row "s" was touched after the read.
    const db = fakeDb(["s"]);
    // One of each case.
    const report = await regateQueue([
      row("a", "awaiting_approval", "Frankfurt, Hesse, Germany"),
      row("b", "approved", "Budapest"),
      row("c", "awaiting_approval", "Remote - India"),
      row("s", "awaiting_approval", "Palo Alto, CA"),
      { id: "m", status: "awaiting_approval", updated_at: "2026-11-11T10:00:00Z", jobs: null },
    ], LIVE, NO_HISTORY, db);
    // Only "a" moved.
    assert.deepEqual(db.moves, ["a"]);
    // The tally, bucket by bucket.
    assert.deepEqual({ checked: report.checked, dropped: report.dropped.map((d) => d.id), flagged: report.approved_flagged.map((f) => f.id), stale: report.skipped_stale, failed: report.failures.map((f) => f.id) },
      { checked: 5, dropped: ["a"], flagged: ["b"], stale: 1, failed: ["m"] });
  });

  test("W2 + D9b: the copy moves with drop_reason already_applied, the foreign row with work_auth, the senior-JD row is only reported", async () => {
    // A fresh double.
    const db = fakeDb();
    // One work-auth drop, one already-applied drop, one experience row.
    const report = await regateQueue([row("a", "awaiting_approval", "Budapest"), copyRow("w", "awaiting_approval"), seniorJdRow("e")], LIVE, COMMITTED, db);
    // Exactly the two drops moved; the experience row never reached a write.
    assert.deepEqual(db.moves, ["a", "w"]);
    // Each stamp wrote the code the DB trigger checks (20261111220000 + the 2026-11-21 widening).
    assert.deepEqual(db.codes, ["work_auth", "already_applied"]);
    // The report names each drop's code and lists the experience row for Teja.
    assert.deepEqual({ dropped: report.dropped.map((d) => [d.id, d.code]), experience: report.experience_flagged.map((f) => f.id) },
      { dropped: [["a", "work_auth"], ["w", "already_applied"]], experience: ["e"] });
  });
});
