// resolveWireOp (S9i P2 + S9j, 2026-11-21): the server turns each wire op into the engine action the browser would have
// made, from the id -> ref maps the browser sends. The three live S9j asks are pinned by name.
import assert from "node:assert/strict";
// The runner.
import { describe, it } from "node:test";
// The module under test.
import { resolveWireOp, type ApplyMaps } from "./resolve-ops.ts";

// The maps for a resume with one job (e0), two projects (e1 One-on-One, e2 applyyy), two bullets and two skills.
const maps: ApplyMaps = {
  bullets: { b0: "exp_b1", b1: "exp_b2" },
  entries: { e0: { section: "experience", ref: "exp_aczen" }, e1: { section: "projects", ref: "proj_1on1" }, e2: { section: "projects", ref: "proj_applyyy" } },
  availableBullets: { m0: "exp_b9" },
  availableEntries: { n0: { section: "achievements", ref: "ach_1" } },
  skills: [{ name: "Testing", category: "Tools", ref: "sk_t1" }, { name: "Testing", category: "AI", ref: "sk_t2" }],
};
// The printed section order.
const sections = ["summary", "experience", "projects", "skills"] as const;

describe("resolveWireOp", () => {
  it("S9j live: 'place applyy at first place' -> move_section to place 1, no direction needed", () => {
    // The live op had no direction and was refused ("did not say up or down").
    assert.deepEqual(resolveWireOp({ op: "move_section", section: "projects", place: 1 }, maps, [...sections]), { ok: true, action: { kind: "move_section_to", section: "projects", place: 1 } });
  });

  it("S9j live: 'one on one at 2nd place' -> move_entry e1 to place 2 (an ENTRY, not a bullet)", () => {
    // The entry move the live answer could not express.
    assert.deepEqual(resolveWireOp({ op: "move_entry", entry: "e1", place: 2 }, maps, [...sections]), { ok: true, action: { kind: "move_entry_to", section: "projects", ref: "proj_1on1", place: 2 } });
  });

  it("S9j live: a bullet moves to a place; 'Move e2' as a bullet id is still refused, by name", () => {
    // A bullet to the top of its entry.
    assert.deepEqual(resolveWireOp({ op: "move", id: "b1", place: 1 }, maps, [...sections]), { ok: true, action: { kind: "move_bullet_to", ref: "exp_b2", place: 1 } });
    // The live mistake: an entry id where a bullet id belongs.
    assert.equal(resolveWireOp({ op: "move", id: "e2", direction: "up" }, maps, [...sections]).ok, false);
  });

  it("maps every other kind to the browser's action, and refuses unknown ids", () => {
    // remove_skill takes the named group's copy.
    assert.deepEqual(resolveWireOp({ op: "remove_skill", name: "testing", category: "ai" }, maps, [...sections]), { ok: true, action: { kind: "remove_skill", ref: "sk_t2" } });
    // add_back of a master bullet and a master entry.
    assert.deepEqual([resolveWireOp({ op: "add_back", id: "m0" }, maps, [...sections]), resolveWireOp({ op: "add_back", id: "n0" }, maps, [...sections])], [{ ok: true, action: { kind: "add_master_bullet", ref: "exp_b9" } }, { ok: true, action: { kind: "add_master_entry", section: "achievements", ref: "ach_1" } }]);
    // set_role only on a job.
    assert.equal(resolveWireOp({ op: "set_role", entry: "e1", text: "Engineer" }, maps, [...sections]).ok, false);
    // The summary is edit-only.
    assert.equal(resolveWireOp({ op: "remove", id: "summary" }, maps, [...sections]).ok, false);
    // A place of 0 is not a place, so a direction-less move is refused.
    assert.equal(resolveWireOp({ op: "move_section", section: "projects", place: 0 }, maps, [...sections]).ok, false);
  });
});

describe("resolveWireOp move_skill (2026-11-23)", () => {
  // The live AI group plus a same-name copy in Tools, so the group question is real.
  const skillMaps: ApplyMaps = {
    ...maps,
    skills: [
      { name: "Prompt Engineering", category: "AI", ref: "sk_pe" },
      { name: "Harness Engineering", category: "AI", ref: "skill_6411aa6f-e2b1-48cd-b298-a924e239b849" },
      { name: "Testing", category: "Tools", ref: "sk_t1" },
      { name: "Testing", category: "Languages", ref: "sk_t2" },
    ],
  };

  it("live: 'put harness eng at first place in ai skill grp' -> move_skill_to the Harness ref, place 1", () => {
    // The op the AI should have sent instead of a bullet move; a typo in the name is forgiven (19 letters).
    assert.deepEqual(resolveWireOp({ op: "move_skill", name: "harnes engineering", category: "ai", place: 1 }, skillMaps, [...sections]), { ok: true, action: { kind: "move_skill_to", ref: "skill_6411aa6f-e2b1-48cd-b298-a924e239b849", place: 1 } });
  });

  it("refuses a skill not on the resume, a name in two groups with no group named, a missing place, a wrong group", () => {
    // Not printed.
    assert.deepEqual(resolveWireOp({ op: "move_skill", name: "Kubernetes", place: 1 }, skillMaps, [...sections]), { ok: false, what: 'Move skill "Kubernetes"', why: '"Kubernetes" is not on the resume.' });
    // Two groups, no group named: the reason names both.
    assert.deepEqual(resolveWireOp({ op: "move_skill", name: "testing", place: 1 }, skillMaps, [...sections]), { ok: false, what: 'Move skill "testing"', why: '"testing" prints under Tools and Languages; say which group.' });
    // The group settles it.
    assert.deepEqual(resolveWireOp({ op: "move_skill", name: "testing", category: "languages", place: 2 }, skillMaps, [...sections]), { ok: true, action: { kind: "move_skill_to", ref: "sk_t2", place: 2 } });
    // No place.
    assert.deepEqual(resolveWireOp({ op: "move_skill", name: "Prompt Engineering", place: 0 }, skillMaps, [...sections]), { ok: false, what: 'Move skill "Prompt Engineering"', why: "The AI did not say which place." });
    // "Al" is one edit from "AI" but a 2-letter group matches exactly only.
    assert.equal(resolveWireOp({ op: "move_skill", name: "Harness Engineering", category: "Al", place: 1 }, skillMaps, [...sections]).ok, false);
  });
});
