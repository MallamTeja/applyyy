/* ONE LINE PER SKILL GROUP, held at the edit (2026-11-12). Commit 4b7e75a made the tailor print every skill
 * group as ONE line (Teja, 13:57 IST). A later add could still wrap a group onto a second line, so every add
 * now asks the same width helper the tailor uses (packages/resume-template skillGroupFitsOneLine):
 *   - an add that would wrap is REFUSED, and the refusal names the full group;
 *   - when the owner said "all" in the chat, the add lands and the save says the group now wraps.
 * Each test fails if its rule is reverted: the refusal tests go red when the guard is removed, and the
 * "all" tests go red when the flag stops travelling from the chat to the save. */

// The .tsx loader; must be the first import so the extensionless relative imports resolve.
import './support/registerTsxHooks.ts';
// Strict asserts: deepEqual compares exactly.
import assert from 'node:assert/strict';
// The runner the web suite uses.
import { before, describe, it } from 'node:test';

// The pure edits: addSkill and the shared wrap check.
let edits: typeof import('../src/features/approval/tailoredEdits.ts');
// The chat's resolver and the stored-op reader.
let ai: typeof import('../src/features/approval/aiEdit.ts');

// Loaded after the hooks are registered, so extensionless imports inside them resolve.
before(async () => {
  // Pure module.
  edits = await import('../src/features/approval/tailoredEdits.ts');
  // Pure module.
  ai = await import('../src/features/approval/aiEdit.ts');
});

// The live case from master v41: five DevOps & Cloud skills fit one line; the sixth below wraps it (probed 2026-11-12).
const DEVOPS = 'DevOps & Cloud';
// Printed now, in this order.
const PRINTED = ['Kubernetes', 'Docker', 'AWS', 'Microsoft Azure', 'Google Cloud Platform'];
// The skill whose add would wrap the group onto a second line.
const WRAPPER = 'CI/CD & GitHub Actions';

// A master holding all six, plus one short skill in another group.
const MASTER = {
  // Only skills matter to addSkill; the rest is never read there.
  skills: [...PRINTED, WRAPPER].map((name, index) => ({ id: `s${index}`, name, category: DEVOPS })).concat([{ id: 'go', name: 'Go', category: 'Languages' }]),
};
// A resume printing the five; addSkill reads only `skills` and spreads the rest.
const RESUME = { skills: PRINTED.map((name, index) => ({ ref: `s${index}`, name, category: DEVOPS })) };

describe('addSkill keeps every skill group on one line', () => {
  it('refuses an add that would wrap the group, naming the full group', () => {
    // The sixth DevOps skill.
    const out = edits.addSkill(RESUME as never, MASTER as never, 's5');
    // Refused, so nothing is written.
    assert.equal(out.ok, false);
    // The reason names the group that is full, so the owner knows what to trim.
    assert.match(out.ok ? '' : out.reason, /"DevOps & Cloud" is full/);
  });

  it('still adds a skill that fits (positive control)', () => {
    // Go into Languages, a group with nothing printed: one short line.
    assert.equal(edits.addSkill(RESUME as never, MASTER as never, 'go').ok, true);
  });

  it('adds past the line when the caller allows it (the owner said "all")', () => {
    // The same add, allowed.
    assert.equal(edits.addSkill(RESUME as never, MASTER as never, 's5', 'allow').ok, true);
  });
});

describe('the chat carries "all" from the instruction to the save', () => {
  // The smallest draft resolveOps reads for an add_skill: the instruction and the master's skill names.
  const draft = (instruction: string) => ({ body: { instruction }, masterSkills: new Set([WRAPPER.toLowerCase()]), structure: null, entries: new Map(), printedSkills: new Map() }) as never;
  // One add_skill op as the server sends it.
  const op = { op: 'add_skill', name: WRAPPER, category: DEVOPS } as const;

  it('an "all" turn marks the add as allowed to wrap, and the save action carries it', () => {
    // Resolved against an instruction that says "all".
    const [stored] = ai.resolveOps([op], draft('add all devops skills'));
    // Marked on the stored card, so a later click still knows.
    assert.deepEqual(stored, { op: 'add_skill', name: WRAPPER, category: DEVOPS, inMaster: true, allowWrap: true });
    // And handed to the attest save.
    assert.deepEqual(ai.toEditAction(stored as never), { kind: 'attest_skill', keyword: WRAPPER, category: DEVOPS, wrap: 'allow' });
    // It survives the round trip through the stored chat row.
    assert.deepEqual(ai.readStoredOp(stored), stored);
  });

  it('a turn without "all" is not marked, so the save refuses a wrap', () => {
    // "small" contains "all" but is not the word.
    const [stored] = ai.resolveOps([op], draft('add a small devops skill'));
    // No flag.
    assert.deepEqual(stored, { op: 'add_skill', name: WRAPPER, category: DEVOPS, inMaster: true });
    // The plain attest action, which refuses a wrap.
    assert.deepEqual(ai.toEditAction(stored as never), { kind: 'attest_skill', keyword: WRAPPER, category: DEVOPS });
  });
});
