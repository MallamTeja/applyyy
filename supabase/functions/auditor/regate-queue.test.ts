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

// A recording double that answers like supabase-js: { error } values, never throws.
function fakeDb(staleIds: string[] = []): RegateDb & { moves: string[] } {
  // Every row the double moved, in order.
  const moves: string[] = [];
  // The double.
  return {
    // Records the moves for the assertions.
    moves,
    // A stale row matches nothing: null stamp, no error (what an .eq() miss returns).
    async stampDropReason(id) { return staleIds.includes(id) ? { updatedAt: null, error: null } : { updatedAt: "2026-11-11T16:00:00.000000+00:00", error: null }; },
    // The move succeeds and is recorded.
    async dropRow(id) { moves.push(id); return { error: null }; },
  };
}

describe("regateVerdict", () => {
  test("foreign awaiting row drops; foreign approved row is only flagged; Indian row and a seniority objection are kept", () => {
    // Budapest (Silicon Labs, one of the 11) waiting for Teja.
    assert.equal(regateVerdict(row("a", "awaiting_approval", "Budapest"), LIVE).kind, "drop");
    // The same place, already approved: his yes stands.
    assert.equal(regateVerdict(row("b", "approved", "Budapest"), LIVE).kind, "flag_approved");
    // India passes.
    assert.equal(regateVerdict(row("c", "awaiting_approval", "Bengaluru, India"), LIVE).kind, "keep");
    // A non-work-auth objection is Teja's call, never this sweep's.
    assert.equal(regateVerdict(row("d", "awaiting_approval", "Bengaluru, India", "Senior Engineer"), LIVE).kind, "keep");
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
    ], LIVE, db);
    // Only "a" moved.
    assert.deepEqual(db.moves, ["a"]);
    // The tally, bucket by bucket.
    assert.deepEqual({ checked: report.checked, dropped: report.dropped.map((d) => d.id), flagged: report.approved_flagged.map((f) => f.id), stale: report.skipped_stale, failed: report.failures.map((f) => f.id) },
      { checked: 5, dropped: ["a"], flagged: ["b"], stale: 1, failed: ["m"] });
  });
});
