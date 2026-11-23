// The approval-queue re-gate (2026-11-11): Teja found 11 foreign jobs waiting for him, all queued before the gate fix
// c22d0d0. These tests pin that the sweep drops a foreign awaiting row, only flags an approved one, keeps an Indian
// one and a non-work-auth objection, and leaves a row alone when someone touched it after the read.
import { describe, test } from "node:test";
// Strict deep equality, so a changed report shape fails here.
import assert from "node:assert/strict";
// Read the auditor source for the wiring test.
import { readFileSync } from "node:fs";
// The unit under test.
import { queuedTwinOwners, regateQueue, regateVerdict, type QueueRow, type RegateDb } from "./regate-queue.ts";
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
function row(id: string, status: string, location: string, title = "Fullstack Engineer", createdAt = "2026-11-01T10:00:00.000000+00:00"): QueueRow {
  // Found by a scout, never pasted (pasted rows skip every automatic gate).
  return { id, status, updated_at: "2026-11-11T10:00:00.000000+00:00", created_at: createdAt, jobs: { title, description_raw: "Build React apps.", location_raw: location, min_experience_years: null, discovered_via: ["greenhouse"] } };
}

// No committed history: the work-auth cases below must not depend on it.
const NO_HISTORY: ReadonlySet<string> = new Set<string>();

// No queued twins: the oldest queued copy of every posting is the row itself.
const NO_TWINS: ReadonlyMap<string, string> = new Map<string, string>();

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
    assert.equal(regateVerdict(row("a", "awaiting_approval", "Budapest"), LIVE, NO_HISTORY, NO_TWINS).kind, "drop");
    // The same place, already approved: his yes stands.
    assert.equal(regateVerdict(row("b", "approved", "Budapest"), LIVE, NO_HISTORY, NO_TWINS).kind, "flag_approved");
    // India passes.
    assert.equal(regateVerdict(row("c", "awaiting_approval", "Bengaluru, India"), LIVE, NO_HISTORY, NO_TWINS).kind, "keep");
    // A non-work-auth objection is Teja's call, never this sweep's.
    assert.equal(regateVerdict(row("d", "awaiting_approval", "Bengaluru, India", "Senior Engineer"), LIVE, NO_HISTORY, NO_TWINS).kind, "keep");
  });

  test("W2: an awaiting copy of a committed ATS posting drops as already_applied", () => {
    // The retitled copy of the applied Canonical posting, still waiting for Teja.
    const verdict = regateVerdict(copyRow("w", "awaiting_approval"), LIVE, COMMITTED, NO_TWINS);
    // Dropped, under the code the DB trigger is opened for.
    assert.deepEqual(verdict.kind === "drop" ? verdict.code : verdict.kind, "already_applied");
  });

  test("W2: an approved copy, a pasted copy and an unrelated posting are never dropped for already_applied", () => {
    // An approved row carries Teja's yes and no agent edge leaves it.
    assert.equal(regateVerdict(copyRow("w", "approved"), LIVE, COMMITTED, NO_TWINS).kind, "keep");
    // Pasted by Teja: re-applying is his choice.
    const pasted = copyRow("p", "awaiting_approval");
    // Same identity, discovered by hand.
    assert.equal(regateVerdict({ ...pasted, jobs: { ...pasted.jobs!, discovered_via: ["manual"] } }, LIVE, COMMITTED, NO_TWINS).kind, "keep");
    // Another id at the same board is another posting.
    assert.equal(regateVerdict({ ...pasted, jobs: { ...pasted.jobs!, ats_job_id: "9999999" } }, LIVE, COMMITTED, NO_TWINS).kind, "keep");
  });

  test("D9b: an experience_ceiling row is only reported, never dropped (Teja 2026-11-11: auditor drops for work_auth ONLY)", () => {
    // Waiting for Teja: reported for him, not moved.
    assert.equal(regateVerdict(seniorJdRow("e"), LIVE, NO_HISTORY, NO_TWINS).kind, "flag_experience");
    // Already approved: also only reported.
    assert.equal(regateVerdict(seniorJdRow("f", "approved"), LIVE, NO_HISTORY, NO_TWINS).kind, "flag_experience");
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
      { id: "m", status: "awaiting_approval", updated_at: "2026-11-11T10:00:00Z", created_at: "2026-11-01T10:00:00Z", jobs: null },
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

// R4 (2026-11-21): the two gaps round 2 left open.
describe("r4: tech no longer hides work_auth, and a newer queued twin drops", () => {
  test("a row failing tech AND work_auth drops for work_auth (firstPreGateDrop stopped at tech, so the sweep kept it)", () => {
    // "Senior" trips the tech gate first; Budapest also fails work-auth.
    const both = row("t", "awaiting_approval", "Budapest", "Senior Engineer");
    // Dropped under the one code the sweep may act on.
    const verdict = regateVerdict(both, LIVE, NO_HISTORY, NO_TWINS);
    // The code the DB trigger accepts.
    assert.deepEqual(verdict.kind === "drop" ? verdict.code : verdict.kind, "work_auth");
    // Approved instead: still only flagged (his yes stands).
    assert.equal(regateVerdict({ ...both, status: "approved" }, LIVE, NO_HISTORY, NO_TWINS).kind, "flag_approved");
  });

  test("a row failing tech AND the experience ceiling is reported for experience, never kept silently", () => {
    // A senior title (tech) with a 5+ years JD (experience), at an Indian location.
    const base = seniorJdRow("x");
    // Retitled so the tech gate objects first.
    assert.equal(regateVerdict({ ...base, jobs: { ...base.jobs!, title: "Senior Engineer" } }, LIVE, NO_HISTORY, NO_TWINS).kind, "flag_experience");
  });

  test("queuedTwinOwners: the oldest queued copy of each posting owns it (created_at, then id); pasted and keyless rows are skipped as candidates only", () => {
    // Two copies of greenhouse 777: the older is "old".
    const older = { ...row("old", "awaiting_approval", "Bengaluru, India", "Engineer", "2026-11-01T10:00:00Z"), };
    // The newer copy.
    const newer = row("new", "awaiting_approval", "Bengaluru, India", "Engineer II", "2026-11-05T10:00:00Z");
    // Same identity on both.
    const key = { ats_provider: "greenhouse", ats_job_id: "777" };
    // The owners map.
    const owners = queuedTwinOwners([{ ...newer, jobs: { ...newer.jobs!, ...key } }, { ...older, jobs: { ...older.jobs!, ...key } }]);
    // The older row owns the key, whatever the read order.
    assert.equal(owners.get(atsJobKeyOf("greenhouse", "777")!), "old");
    // A tie on created_at falls to the smaller id, so the verdict never depends on read order.
    const tie = queuedTwinOwners([{ ...row("b", "awaiting_approval", "India"), jobs: { ...row("b", "awaiting_approval", "India").jobs!, ...key } }, { ...row("a", "awaiting_approval", "India"), jobs: { ...row("a", "awaiting_approval", "India").jobs!, ...key } }]);
    // "a" < "b".
    assert.equal(tie.get(atsJobKeyOf("greenhouse", "777")!), "a");
  });

  test("a newer queued twin drops as already_applied naming the older copy; the older copy, a pasted twin and an approved twin stay", () => {
    // The shared identity.
    const key = { ats_provider: "greenhouse", ats_job_id: "777" };
    // Older and newer awaiting copies.
    const older = row("old", "awaiting_approval", "Bengaluru, India", "Engineer", "2026-11-01T10:00:00Z");
    // Newer.
    const newer = row("new", "awaiting_approval", "Bengaluru, India", "Engineer II", "2026-11-05T10:00:00Z");
    // Keyed rows.
    const rows = [{ ...older, jobs: { ...older.jobs!, ...key } }, { ...newer, jobs: { ...newer.jobs!, ...key } }];
    // Who owns the posting.
    const owners = queuedTwinOwners(rows);
    // The newer copy drops under the trigger's already_applied code, and the reason names the copy that stays.
    const verdict = regateVerdict(rows[1]!, LIVE, NO_HISTORY, owners);
    // Code and reason.
    assert.ok(verdict.kind === "drop" && verdict.code === "already_applied" && verdict.reason.includes("old"), JSON.stringify(verdict));
    // The older copy stays.
    assert.equal(regateVerdict(rows[0]!, LIVE, NO_HISTORY, owners).kind, "keep");
    // A pasted newer copy is Teja's own pick: kept.
    assert.equal(regateVerdict({ ...rows[1]!, jobs: { ...rows[1]!.jobs!, discovered_via: ["manual"] } }, LIVE, NO_HISTORY, owners).kind, "keep");
    // An approved newer copy carries his yes: kept (no agent edge leaves approved).
    assert.equal(regateVerdict({ ...rows[1]!, status: "approved" }, LIVE, NO_HISTORY, owners).kind, "keep");
  });

  test("regateQueue end to end: only the newer twin moves, stamped already_applied", async () => {
    // A fresh double.
    const db = fakeDb();
    // The shared identity.
    const key = { ats_provider: "lever", ats_job_id: "abc-123" };
    // Newer first in the read, to prove order does not decide.
    const newer = row("new", "awaiting_approval", "Bengaluru, India", "Engineer", "2026-11-05T10:00:00Z");
    // Older second.
    const older = row("old", "awaiting_approval", "Bengaluru, India", "Engineer", "2026-11-01T10:00:00Z");
    // Swept.
    const report = await regateQueue([{ ...newer, jobs: { ...newer.jobs!, ...key } }, { ...older, jobs: { ...older.jobs!, ...key } }], LIVE, NO_HISTORY, db);
    // Only the newer copy moved, with the trigger's code.
    assert.deepEqual({ moves: db.moves, codes: db.codes, dropped: report.dropped.map((d) => d.id) }, { moves: ["new"], codes: ["already_applied"], dropped: ["new"] });
  });
});

describe("r4 wiring", () => {
  test("the regate read selects created_at (the read is cast to QueueRow, so only this test catches a missing column)", () => {
    // The auditor's source.
    const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    // The regate branch's queue read, from its select to its status filter.
    const read = source.slice(source.indexOf(".select(`id, status, updated_at"), source.indexOf('.in("status", ["awaiting_approval", "approved"])'));
    // created_at is selected, or every row's age would read as undefined.
    assert.ok(/\bcreated_at\b/.test(read), read.slice(0, 120));
  });

  test("a row whose created_at is not a time never owns a posting, so the dated copy stays and only one copy can drop", () => {
    // The shared identity.
    const key = { ats_provider: "greenhouse", ats_job_id: "888" };
    // A dated copy.
    const dated = row("dated", "awaiting_approval", "Bengaluru, India", "Engineer", "2026-11-05T10:00:00Z");
    // An undated copy, read first.
    const undated = row("undated", "awaiting_approval", "Bengaluru, India", "Engineer", "not-a-time");
    // The dated copy owns the posting.
    assert.equal(queuedTwinOwners([{ ...undated, jobs: { ...undated.jobs!, ...key } }, { ...dated, jobs: { ...dated.jobs!, ...key } }]).get(atsJobKeyOf("greenhouse", "888")!), "dated");
  });
});

// 2026-11-21, Teja 20:12 IST: "Drop AVP/VP/Director". The sweep asks the seniority rule directly (like work-auth),
// so rows queued before the rule existed leave the queue. Migration 20261121203000 lets the trigger accept the code.
describe("seniority 11-21: the queue re-gate drops a senior grade", () => {
  // The live Barclays shape: a plain title, the grade as a heading line in the body (AI Engineer afe8985b).
  function gradedRow(id: string, status: string, body = "Build AI systems.\n\nAssistant Vice President Expectations\n\nTo advise and influence decision making."): QueueRow {
    // An Indian row, so work-auth passes and only the grade can object.
    const base = row(id, status, "Pune, India", "AI Engineer");
    // The body carries the grade.
    return { ...base, jobs: { ...base.jobs!, description_raw: body } };
  }

  test("an awaiting row with a grade line drops as title_seniority; an approved one is only flagged", () => {
    // Waiting for Teja: dropped under the rule's one code, naming the line.
    const waiting = regateVerdict(gradedRow("g1", "awaiting_approval"), LIVE, NO_HISTORY, NO_TWINS);
    assert.equal(waiting.kind === "drop" && waiting.code, "title_seniority");
    assert.match(waiting.kind === "drop" ? waiting.reason : "", /Assistant Vice President Expectations/);
    // His yes stands: reported only.
    assert.equal(regateVerdict(gradedRow("g2", "approved"), LIVE, NO_HISTORY, NO_TWINS).kind, "flag_approved");
    // A VP / Director title, no grade line, also drops.
    assert.equal(regateVerdict(row("g3", "awaiting_approval", "Pune, India", "Director, Platform Engineering"), LIVE, NO_HISTORY, NO_TWINS).kind, "drop");
  });

  test("KEEPS: prose naming a VP, and a row Teja pasted himself", () => {
    // "reports to the VP" is not the role's grade.
    assert.equal(regateVerdict(gradedRow("k1", "awaiting_approval", "Build AI systems. You will report to the VP of Engineering."), LIVE, NO_HISTORY, NO_TWINS).kind, "keep");
    // A pasted row skips every automatic gate, this one included.
    const pasted = gradedRow("k2", "awaiting_approval");
    assert.equal(regateVerdict({ ...pasted, jobs: { ...pasted.jobs!, discovered_via: ["manual"] } }, LIVE, NO_HISTORY, NO_TWINS).kind, "keep");
  });

  test("regateQueue stamps drop_reason title_seniority, the value migration 20261121203000 lets through", async () => {
    // A fresh double.
    const db = fakeDb();
    // One graded row.
    const report = await regateQueue([gradedRow("g4", "awaiting_approval")], LIVE, NO_HISTORY, db);
    // Moved, with the code the trigger reads.
    assert.deepEqual({ moves: db.moves, codes: db.codes, dropped: report.dropped.map((d) => [d.id, d.code]) }, { moves: ["g4"], codes: ["title_seniority"], dropped: [["g4", "title_seniority"]] });
  });
});

// 2026-11-23 (BBHT 5e108a32): the queue sweep reads the language gate like work-auth and seniority.
test("language 11-23: an awaiting row requiring German drops as language_required; approved is flagged; pasted and unset keep", () => {
  // The seeded list.
  const prefs: PreGatePreferences = { ...LIVE, spokenLanguages: ["English"] };
  // An Indian row (work-auth passes) whose JD requires fluent German.
  const german = (id: string, status: string): QueueRow => { const base = row(id, status, "Bengaluru, India"); return { ...base, jobs: { ...base.jobs!, description_raw: "Build React apps. Fluent German (C1) is required." } }; };
  // Waiting for Teja: dropped under the gate's code.
  const waiting = regateVerdict(german("l1", "awaiting_approval"), prefs, NO_HISTORY, NO_TWINS);
  // The kind and code, with the quoted requirement in the reason so a wrong drop is diagnosable.
  assert.deepEqual(waiting.kind === "drop" && [waiting.code, /German/.test(waiting.reason)], ["language_required", true]);
  // Approved by him: reported, never moved.
  assert.equal(regateVerdict(german("l2", "approved"), prefs, NO_HISTORY, NO_TWINS).kind, "flag_approved");
  // Pasted by him: no automatic gate.
  const pasted = german("l3", "awaiting_approval");
  // The manual marker, as job-link-intake writes it.
  assert.equal(regateVerdict({ ...pasted, jobs: { ...pasted.jobs!, discovered_via: ["manual"] } }, prefs, NO_HISTORY, NO_TWINS).kind, "keep");
  // List never set: open.
  assert.equal(regateVerdict(german("l4", "awaiting_approval"), { ...LIVE, spokenLanguages: null }, NO_HISTORY, NO_TWINS).kind, "keep");
});
