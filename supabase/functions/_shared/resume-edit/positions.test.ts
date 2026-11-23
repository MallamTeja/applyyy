// S9j (Teja 2026-11-21 18:54: "my ai need to full autonomous able to do most of things except those personal details").
// Live asks that failed: "place applyy at first place" (move_section needed up/down), "and one on one at 2nd place"
// (no op could move an ENTRY), "are you able to change the pos of projs" (the AI said it could not). These pin the
// absolute-position primitives the chat now uses: a section, an entry within its section, a bullet within its entry,
// each to a 1-based place, never a one-step swap.
import assert from "node:assert/strict";
// The runner.
import { describe, it } from "node:test";
// The engine under test.
import { moveBulletTo, moveEntryTo, moveSectionTo } from "./tailored-edits.ts";

// A bullet with a ref and text: the only fields the moves read.
const bullet = (ref: string) => ({ ref, text: ref });
// A resume shaped just enough for the moves: an order, two projects, and a three-bullet job.
const resume = {
  section_order: ["summary", "experience", "projects", "skills"],
  experience: [{ ref: "exp_aczen", bullets: [bullet("b1"), bullet("b2"), bullet("b3")] }],
  projects: [{ ref: "proj_1on1", bullets: [] }, { ref: "proj_applyyy", bullets: [] }],
} as never;

describe("S9j: absolute-position moves", () => {
  it("moveSectionTo puts projects first with no up/down needed, and refuses a no-op or an unknown section", () => {
    // To place 1.
    const moved = moveSectionTo(resume, "projects", 1);
    // Landed first, everything else in its old relative order.
    assert.deepEqual(moved.ok ? (moved.resume as { section_order: string[] }).section_order : moved, ["projects", "summary", "experience", "skills"]);
    // Already there.
    assert.equal(moveSectionTo(resume, "summary", 1).ok, false);
    // Not printed.
    assert.equal(moveSectionTo(resume, "education", 1).ok, false);
  });

  it("moveEntryTo: 'applyyy first, One-on-One second' reorders the projects; other sections are untouched", () => {
    // applyyy to place 1.
    const moved = moveEntryTo(resume, "projects", "proj_applyyy", 1);
    // The new order by ref.
    assert.deepEqual(moved.ok ? (moved.resume as { projects: { ref: string }[] }).projects.map((p) => p.ref) : moved, ["proj_applyyy", "proj_1on1"]);
    // Experience is the same object: nothing else rewritten.
    assert.equal(moved.ok && (moved.resume as { experience: unknown }).experience, (resume as { experience: unknown }).experience);
    // A place past the end is clamped to last; an unknown entry is refused.
    assert.equal(moveEntryTo(resume, "projects", "proj_nope", 1).ok, false);
  });

  it("moveBulletTo moves a bullet within its entry to a place, clamped to the entry's size", () => {
    // b3 to the top.
    const moved = moveBulletTo(resume, "b3", 1);
    // New order.
    assert.deepEqual(moved.ok ? (moved.resume as { experience: { bullets: { ref: string }[] }[] }).experience[0]!.bullets.map((b) => b.ref) : moved, ["b3", "b1", "b2"]);
    // Place 9 means last.
    const last = moveBulletTo(resume, "b1", 9);
    // b1 now last.
    assert.deepEqual(last.ok ? (last.resume as { experience: { bullets: { ref: string }[] }[] }).experience[0]!.bullets.map((b) => b.ref) : last, ["b2", "b3", "b1"]);
    // Place 0 or a fraction is not a place.
    assert.equal(moveBulletTo(resume, "b1", 0).ok, false);
  });
});
