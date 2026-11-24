// planServerEdits (S9i P2, 2026-11-21): the server folds an answer's actions one by one, keeps what the engine accepts,
// names what it refuses, holds ungrounded wording back as a suggestion, and checks the end state once.
import assert from "node:assert/strict";
// The runner.
import { describe, it } from "node:test";
// The module under test.
import { planServerEdits } from "./server-plan.ts";
// A real one-page resume (the page-fit suites' fixture).
import { zomatoBackendIntern } from "../../../../packages/resume-template/test/fixtures/zomato-backend-intern.ts";
// Types only.
import type { MasterProfile, ResolvedResume } from "../contracts/shared-types.ts";

// A fresh copy each test, so no test sees another's edits.
const resume = (): ResolvedResume => structuredClone(zomatoBackendIntern) as unknown as ResolvedResume;
// A master with nothing in it: every content floor is 0, so only the end-state fit can bind (as in page-fit-edit.test).
const master = { projects: [], experience: [], certifications: [], achievements: [], education: [], skills: [], summary: null } as unknown as MasterProfile;
// The plan for these actions on a fresh resume.
const plan = (actions: Parameters<typeof planServerEdits>[0]["actions"]) => planServerEdits({ current: resume(), master, full: resume(), jdKeywords: [], actions });

describe("planServerEdits", () => {
  it("one refused action never sinks the others: each is named, the rest land, and the end state is saved", () => {
    // A valid section place, an entry that is not there, a valid bullet place.
    const out = plan([
      { action: { kind: "move_section_to", section: "projects", place: 1 }, label: "Move projects first" },
      { action: { kind: "remove_entry", section: "projects", ref: "prj_nope" }, label: "Remove a project" },
      { action: { kind: "move_bullet_to", ref: "bul_auth", place: 1 }, label: "Move bullet to place 1" },
    ]);
    // Applied, refused with the engine's reason, applied.
    assert.deepEqual(out.outcomes.map((o) => o.status), ["applied", "refused", "applied"]);
    // The saved resume carries both landed moves.
    assert.equal(out.resume?.section_order[0], "projects");
    // Two steps for the history event, with the S9j kinds.
    assert.deepEqual(out.steps.map((s) => s.kind), ["resume_move_section", "resume_move_bullet"]);
  });

  it("an edit the master text cannot ground is held back as a suggestion; a grounded one lands", () => {
    // Invents a number (900) the master bullet never states.
    const invented = plan([{ action: { kind: "edit", target: { kind: "bullet", ref: "bul_auth" }, text: "Added JWT login and role checks to 900 APIs" }, label: "Edit bullet" }]);
    // Suggested, not applied, nothing saved.
    assert.deepEqual([invented.outcomes[0]?.status, invented.resume], ["suggested", null]);
    // The master's own words.
    const grounded = plan([{ action: { kind: "edit", target: { kind: "bullet", ref: "bul_auth" }, text: "Added JWT login and role checks to the event portal API" }, label: "Edit bullet" }]);
    // Applied.
    assert.equal(grounded.outcomes[0]?.status, "applied");
  });

  it("nothing landed: nothing to save", () => {
    // Only a refusal.
    const out = plan([{ action: { kind: "move_section_to", section: "certifications", place: 99 }, label: "Move certifications last" }]);
    // Certifications is already last in the fixture's order, so refused, and no resume.
    assert.deepEqual([out.outcomes[0]?.status, out.resume], ["refused", null]);
  });
});

describe("planServerEdits move_skill_to (2026-11-23)", () => {
  it("a skill moved to a place in its group lands and is logged as resume_move_skill", () => {
    // Python is third in Languages & Runtimes; to place 1.
    const out = plan([{ action: { kind: "move_skill_to", ref: "skl_python", place: 1 }, label: "Move skill to place 1" }]);
    // Applied.
    assert.equal(out.outcomes[0]?.status, "applied");
    // The saved list starts with Python.
    assert.equal(out.resume?.skills[0]?.ref, "skl_python");
    // The new event kind, naming the skill's ref.
    assert.deepEqual(out.steps.map((s) => [s.kind, s.ref]), [["resume_move_skill", "skl_python"]]);
  });
});
