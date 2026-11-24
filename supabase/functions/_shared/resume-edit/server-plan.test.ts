// planServerEdits (S9i P2, 2026-11-21): the server folds an answer's actions one by one, keeps what the engine accepts,
// names what it refuses, holds ungrounded wording back as a suggestion, and checks the end state once.
import assert from "node:assert/strict";
// The runner.
import { describe, it } from "node:test";
// The module under test.
import { planServerEdits, replyText } from "./server-plan.ts";
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

// S45 + S9k item 2 (Teja 2026-11-24 13:42, "very shit reply"): the readable reply, in the contract's sentence order.
describe("replyText (S45)", () => {
  it("orders: Done, removals (typed echoed), adds per group in first-seen order, other labels, refusals, suggestions, note, one-page line", () => {
    // One of each kind, deliberately interleaved so the order below is the function's, not the input's.
    const out = replyText([
      // An add to Tools.
      { status: "applied", label: 'Add skill "YAML Flows" under Tools', subject: { verb: "added", name: "YAML Flows", group: "Tools" } },
      // A removal matched by a typo.
      { status: "applied", label: 'Remove skill "XGBoost"', subject: { verb: "removed", name: "XGBoost", typed: "cgboost" } },
      // A move: no subject.
      { status: "applied", label: "Move bullet to place 1" },
      // An add to Languages: its own sentence.
      { status: "applied", label: 'Add skill "Go" under Languages', subject: { verb: "added", name: "Go", group: "Languages" } },
      // A second Tools add joins the first Tools sentence.
      { status: "applied", label: 'Add skill "Git" under Tools', subject: { verb: "added", name: "Git", group: "Tools" } },
      // An exact removal.
      { status: "applied", label: 'Remove skill "C#"', subject: { verb: "removed", name: "C#" } },
      // A refusal.
      { status: "refused", label: "Move section skills", why: "already first" },
      // A suggestion.
      { status: "suggested", label: "Edit bullet", why: "uses 900" },
    ], "Note here.");
    // Exactly the contract's sentences, joined by one space.
    assert.equal(out, "Done. Removed: XGBoost (you typed 'cgboost'), C#. Added to Tools: YAML Flows, Git. Added to Languages: Go. Also: Move bullet to place 1. Could not do: Move section skills (already first). Suggested, not applied: Edit bullet (uses 900). Note here. Resume still fits one page.");
  });

  it("nothing applied: 'Nothing changed.' first and no one-page line; empty everything is 'Nothing changed.' alone", () => {
    // Only a refusal (even a skill one: a refused subject is not listed as removed).
    assert.equal(replyText([{ status: "refused", label: 'Remove skill "Go"', why: "x", subject: { verb: "removed", name: "Go" } }], ""), 'Nothing changed. Could not do: Remove skill "Go" (x).');
    // No outcomes, no note.
    assert.equal(replyText([], "  "), "Nothing changed.");
    // An add with no group known.
    assert.equal(replyText([{ status: "applied", label: "a", subject: { verb: "added", name: "Kafka" } }], ""), "Done. Added: Kafka. Resume still fits one page.");
  });
});

describe("planServerEdits subjects (S45)", () => {
  it("a skill removal carries its printed name (and the typed spelling) on its outcome; a move carries none", () => {
    // Python off by ref, typed with a typo; a bullet moved.
    const out = plan([
      { action: { kind: "remove_skill", ref: "skl_python", name: "Python", typed: "pyhton" }, label: 'Remove skill "Python"' },
      { action: { kind: "move_bullet_to", ref: "bul_auth", place: 1 }, label: "Move bullet to place 1" },
    ]);
    // The subject rides on the applied outcome; the move has none.
    assert.deepEqual(out.outcomes, [{ status: "applied", label: 'Remove skill "Python"', subject: { verb: "removed", name: "Python", typed: "pyhton" } }, { status: "applied", label: "Move bullet to place 1" }]);
  });
});
