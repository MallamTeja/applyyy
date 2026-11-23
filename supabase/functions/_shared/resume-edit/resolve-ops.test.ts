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
