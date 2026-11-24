// S9j (Teja 2026-11-21 18:54: "my ai need to full autonomous able to do most of things except those personal details").
// Live asks that failed: "place applyy at first place" (move_section needed up/down), "and one on one at 2nd place"
// (no op could move an ENTRY), "are you able to change the pos of projs" (the AI said it could not). These pin the
// absolute-position primitives the chat now uses: a section, an entry within its section, a bullet within its entry,
// each to a 1-based place, never a one-step swap.
import assert from "node:assert/strict";
// The runner.
import { describe, it } from "node:test";
// The engine under test.
import { moveBulletTo, moveEntryTo, moveSectionTo, moveSkillTo } from "./tailored-edits.ts";

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

// The live AI group (row 957991ec, 2026-11-23) between two other groups, so "other groups untouched" is checkable.
const AI_GROUP = ["AI Agents & Workflows", "Prompt Engineering", "MCP Integrations", "RAG Pipelines", "Context Engineering", "LLM/SLM API Integration", "Multi-Agent Systems", "Harness Engineering"];
// A flat skills array: a language first, the AI group, then a tool (the print order is the array order).
const skillResume = {
  skills: [
    { ref: "sk_ts", name: "TypeScript", category: "Languages" },
    ...AI_GROUP.map((name, i) => ({ ref: i === 7 ? "skill_6411aa6f-e2b1-48cd-b298-a924e239b849" : `sk_ai${i}`, name, category: "AI" })),
    { ref: "sk_docker", name: "Docker", category: "Tools" },
  ],
} as never;
// The skills of an outcome, for compact asserts.
const skillsOf = (outcome: ReturnType<typeof moveSkillTo>) => (outcome.ok ? (outcome.resume as { skills: { ref: string; name: string; category: string }[] }).skills : outcome);

describe("moveSkillTo (2026-11-23: 'put harness eng at first place in ai skill grp')", () => {
  it("live: Harness Engineering to place 1 of AI; the other 7 keep their order; other groups keep their slots", () => {
    // The live ask.
    const moved = moveSkillTo(skillResume, "skill_6411aa6f-e2b1-48cd-b298-a924e239b849", 1);
    // The whole printed list: TypeScript and Docker at the same index, Harness first in AI.
    assert.deepEqual((skillsOf(moved) as { name: string }[]).map((s) => s.name), ["TypeScript", "Harness Engineering", ...AI_GROUP.slice(0, 7), "Docker"]);
    // before/after are the group's names, so the event alone replays the move.
    assert.deepEqual(moved.ok && [moved.before, moved.after], [AI_GROUP.join(", "), ["Harness Engineering", ...AI_GROUP.slice(0, 7)].join(", ")]);
  });

  it("permutes inside the slots the group already holds, even when the group is split by another", () => {
    // AI members at indexes 0 and 2, a tool between them.
    const split = { skills: [{ ref: "a1", name: "A1", category: "AI" }, { ref: "t1", name: "T1", category: "Tools" }, { ref: "a2", name: "A2", category: "AI" }] } as never;
    // A2 to place 1 swaps the two AI slots; T1 stays at index 1.
    assert.deepEqual((skillsOf(moveSkillTo(split, "a2", 1)) as { ref: string }[]).map((s) => s.ref), ["a2", "t1", "a1"]);
  });

  it("refuses an unknown skill, a non-place and a no-op, with the siblings' wording; past the end means last", () => {
    // Not printed.
    assert.deepEqual(moveSkillTo(skillResume, "sk_nope", 1), { ok: false, reason: "That skill is no longer on this resume." });
    // Place 0.
    assert.deepEqual(moveSkillTo(skillResume, "sk_ai0", 0), { ok: false, reason: "A place is a whole number from 1." });
    // Already first in its group.
    assert.deepEqual(moveSkillTo(skillResume, "sk_ai0", 1), { ok: false, reason: "That skill is already in place 1 in its group." });
    // Place 99 clamps to last of the group, never past Docker.
    assert.equal((skillsOf(moveSkillTo(skillResume, "sk_ai0", 99)) as { ref: string }[])[8]?.ref, "sk_ai0");
  });
});
