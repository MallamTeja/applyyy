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

/* ROUND 6 (2026-11-21): the gate moved from ONE line to SKILL_GROUP_MAX_LINES (2), because the tailor now prints
   2-line groups by design (Teja 11-18: "compact skills block, a group may wrap to 2 lines"); a one-line gate would
   refuse every add to a group the tailor itself emitted. Measured with skillGroupLineCount at every rung (2026-11-21):
   the five PRINTED are 1 line, plus WRAPPER 2 lines, plus four more (TEN) still 2 lines, and an ELEVENTH makes 3. */
const TWO_LINE_EXTRA = ['Terraform', 'Prometheus', 'Grafana Observability Stack', 'Amazon Elastic Kubernetes Service'];
// The skill whose add would push the ten-skill group onto a THIRD line.
const THIRD_LINER = 'HashiCorp Vault';
// A master holding all eleven DevOps skills.
const MASTER_TEN = { skills: [...PRINTED, WRAPPER, ...TWO_LINE_EXTRA, THIRD_LINER].map((name, index) => ({ id: `t${index}`, name, category: DEVOPS })) };
// A resume printing the first ten: a full two-line group.
const RESUME_TEN = { skills: MASTER_TEN.skills.slice(0, 10).map((skill) => ({ ref: skill.id, name: skill.name, category: DEVOPS })) };

describe('addSkill keeps every skill group within SKILL_GROUP_MAX_LINES (2) lines', () => {
  it('refuses an add that would push the group onto a THIRD line, naming the full group', () => {
    // The eleventh DevOps skill, onto a full two-line group.
    const out = edits.addSkill(RESUME_TEN as never, MASTER_TEN as never, 't10');
    // Refused, so nothing is written.
    assert.equal(out.ok, false);
    // The reason names the group and the limit, so the owner knows what to trim.
    assert.equal(out.ok ? '' : out.reason, '"DevOps & Cloud" is full: adding HashiCorp Vault would wrap it onto a third line. Remove a skill from that group first, or say "all" to add it anyway.');
  });

  it('allows an add that wraps a one-line group onto its second line (the tailor prints such groups)', () => {
    // The sixth DevOps skill: one line becomes two, within the limit.
    assert.equal(edits.addSkill(RESUME as never, MASTER as never, 's5').ok, true);
  });

  it('still adds a skill that fits (positive control)', () => {
    // Go into Languages, a group with nothing printed: one short line.
    assert.equal(edits.addSkill(RESUME as never, MASTER as never, 'go').ok, true);
  });

  it('adds past the limit when the caller allows it (the owner said "all")', () => {
    // The third-line add, allowed.
    assert.equal(edits.addSkill(RESUME_TEN as never, MASTER_TEN as never, 't10', 'allow').ok, true);
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
