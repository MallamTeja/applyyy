/* T10 (2026-11-10): an AI-chat project SWAP can be applied. Live bug (Teja, 12:20 IST, Data Analyst
 * at Barclays): "instead of one on one use f1 race pace proj" answered remove_entry + add_back of a
 * master entry. Each card refused alone ("projects: 1, needs 2" / "projects: 3, at most 2"), and
 * Apply all refused too, because it saved op by op and checked the content rules after EACH op.
 *
 * The fix under test: planBatch (pageFitEdit.ts) folds a whole batch and judges only the END STATE,
 * and swapPartners / applyTogether (aiEdit.ts) link the two halves so one card never applies alone.
 * Harness: support/registerTsxHooks.ts for the extensionless imports Vite resolves and Node does not. */

// The .tsx loader; must be the first import so it runs before any module under test loads.
import './support/registerTsxHooks.ts';
import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
// Types only: the resume and master shapes the fixtures are cast to.
import type { MasterProfile, ResolvedResume } from '../src/data/contract';
// Type only: the page action vocabulary a batch is made of.
import type { EditAction } from '../src/features/approval/DiffView.tsx';
// Type only: the stored AI ops the pairing reads.
import type { StoredOp } from '../src/features/approval/aiEdit.ts';

// The batch planner and the per-save fit.
let fit: typeof import('../src/features/approval/pageFitEdit.ts');
// The pairing and the op -> action mapping.
let ai: typeof import('../src/features/approval/aiEdit.ts');
// The real pure edits the page's pureEdit dispatches to.
let edits: typeof import('../src/features/approval/tailoredEdits.ts');
// The synthetic resume fixture (no real person), the one pageFitEdit.test.ts builds on.
let fixture: typeof import('../../../packages/resume-template/test/fixtures/zomato-backend-intern.ts');

before(async () => {
  // Loaded after the hooks so they apply to each module's own imports.
  fit = await import('../src/features/approval/pageFitEdit.ts');
  // Same.
  ai = await import('../src/features/approval/aiEdit.ts');
  // Same.
  edits = await import('../src/features/approval/tailoredEdits.ts');
  // Same.
  fixture = await import('../../../packages/resume-template/test/fixtures/zomato-backend-intern.ts');
});

/** One synthetic project with one short bullet, shaped like the fixture's own (pageFitEdit.test.ts). */
function project(ref: string) {
  // A distinct ref and bullet ref, so the rules count it as its own entry.
  return { ref, name: `Project ${ref}`, links: [], start_display: null, end_display: null, bullets: [{ ref: `bul_${ref}`, text: `Shipped ${ref}.`, master_text: `Shipped ${ref}.` }] };
}

/** The fixture holding exactly these project refs (prj_applyy is the fixture's own). */
function withProjects(refs: readonly string[]): ResolvedResume {
  // A deep copy per call, so no test mutates another's fixture.
  const base = structuredClone(fixture.zomatoBackendIntern) as unknown as ResolvedResume;
  // The fixture's own project kept as-is; the rest synthetic.
  const projects = refs.map((ref) => (ref === 'prj_applyy' ? base.projects[0]! : project(ref)));
  // Cast: the synthetic projects use the fixture's shape.
  return { ...base, projects } as unknown as ResolvedResume;
}

/** A master with three projects and nothing else: min(2, 3) = 2 is both the project floor and the cap. */
const THREE_PROJECT_MASTER = {
  // Empty, so their floors bind nothing (min(rule, 0) = 0).
  experience: [], certifications: [], achievements: [], education: [], skills: [],
  // Three projects, one bullet each.
  projects: ['prj_applyy', 'prj_two', 'prj_three'].map((id) => ({ id, bullets: [{ id: `bul_${id}`, text: id }] })),
} as unknown as MasterProfile;

// The live shape: a 2-project resume (the "One-on-One" stand-in is prj_two) ...
const CURRENT = () => withProjects(['prj_applyy', 'prj_two']);
// ... and FULL, every master project (prj_three is the "F1 Race Pace Predictor" stand-in).
const FULL = () => withProjects(['prj_applyy', 'prj_two', 'prj_three']);

/** The page's pureEdit for the kinds these tests send: the same tailoredEdits calls, nothing simulated. */
function step(resume: ResolvedResume, action: EditAction) {
  // A whole entry off, as the page's remove_entry arm does.
  if (action.kind === 'remove_entry') return edits.removeEntry(resume, action.section, action.ref);
  // A master entry back from FULL, as the add_master_entry arm does.
  if (action.kind === 'add_master_entry') return edits.addMasterEntry(resume, FULL(), action.section, action.ref);
  // A printed skill off, as the remove_skill arm does.
  if (action.kind === 'remove_skill') return edits.removeSkill(resume, action.ref);
  // Anything else is outside these tests.
  return { ok: false as const, reason: `unexpected ${action.kind}` };
}

// The two halves of the live answer, as the chat stores them.
const SWAP_OPS: readonly StoredOp[] = [
  // "Remove One-on-One".
  { op: 'remove_entry', section: 'projects', ref: 'prj_two', label: 'One-on-One - AI-Powered Learning Platform' },
  // "Add back F1 Race Pace Predictor" (an nN entry, so add_entry).
  { op: 'add_entry', section: 'projects', ref: 'prj_three', label: 'F1 Race Pace Predictor' },
];

describe('T10 swap: Apply all judges the end state, not each step', () => {
  it('T10 swap: a 2-project profile + a swap is applied and still has 2 projects', () => {
    // The two actions in the AI's order.
    const actions: EditAction[] = [{ kind: 'remove_entry', section: 'projects', ref: 'prj_two' }, { kind: 'add_master_entry', section: 'projects', ref: 'prj_three' }];
    // One plan over the whole batch.
    const plan = fit.planBatch(CURRENT(), actions, step, [], THREE_PROJECT_MASTER);
    // Applied: one end state, no rule newly broken.
    assert.equal(plan.ok, true, plan.ok ? '' : plan.reason);
    // Narrowed.
    if (!plan.ok) return;
    // Still exactly 2 projects: the swapped-out one gone, the swapped-in one present.
    assert.deepEqual(plan.resume.projects.map((p) => p.ref), ['prj_applyy', 'prj_three']);
    // One step record per action, for the history note.
    assert.equal(plan.steps.length, 2);
  });

  it('T10 swap: Apply all of [remove_entry, add_master_entry] passes', () => {
    // The real chat path: the stored ops turned into page actions, exactly as Apply all sends them.
    const actions = SWAP_OPS.flatMap((op) => (op.op === 'rejected' ? [] : [ai.toEditAction(op)]));
    // The kinds the live page actions were.
    assert.deepEqual(actions.map((a) => a.kind), ['remove_entry', 'add_master_entry']);
    // Planned as one batch.
    const plan = fit.planBatch(CURRENT(), actions, step, [], THREE_PROJECT_MASTER);
    // Passes.
    assert.equal(plan.ok, true, plan.ok ? '' : plan.reason);
    // (T16: the contrast with the deleted per-op preflightBatch, which refused this on "projects: 1, needs 2", is
    // kept by "the remove alone is still refused" below: that intermediate state is what the old check judged.)
  });

  it('T10 swap: the remove alone is still refused', () => {
    // Only the first half.
    const plan = fit.planBatch(CURRENT(), [{ kind: 'remove_entry', section: 'projects', ref: 'prj_two' }], step, [], THREE_PROJECT_MASTER);
    // Refused on the project floor.
    assert.ok(!plan.ok && plan.reason.includes('projects: 1, needs 2'), plan.ok ? 'applied' : plan.reason);
  });

  it('T10 swap: an over-limit batch applies nothing', () => {
    // Remove one, add two back: ends at 3 projects.
    const actions: EditAction[] = [
      // The swap's remove.
      { kind: 'remove_entry', section: 'projects', ref: 'prj_two' },
      // The swap's add.
      { kind: 'add_master_entry', section: 'projects', ref: 'prj_three' },
      // One too many.
      { kind: 'add_master_entry', section: 'projects', ref: 'prj_two' },
    ];
    // Planned.
    const plan = fit.planBatch(CURRENT(), actions, step, [], THREE_PROJECT_MASTER);
    // Refused whole, naming the cap: no resume to save, so nothing is applied.
    assert.ok(!plan.ok && plan.reason.includes('projects: 3, at most 2'), plan.ok ? 'applied' : plan.reason);
    // A step the edit itself refuses also refuses the whole batch (never a partial save).
    const refused = fit.planBatch(CURRENT(), [actions[0]!, { kind: 'remove_entry', section: 'projects', ref: 'prj_missing' }], step, [], THREE_PROJECT_MASTER);
    // Refused with the edit's own reason.
    assert.ok(!refused.ok && refused.reason.includes('no longer on this resume'), refused.ok ? 'applied' : refused.reason);
  });
});

describe('T10 swap: a linked pair is one unit in the chat', () => {
  it('T10 swap: Apply on one half of a linked pair never applies it alone', () => {
    // The pairing: remove and add of the same section are partners both ways.
    const partners = ai.swapPartners(SWAP_OPS);
    // 0 <-> 1.
    assert.equal(partners.get(0), 1);
    // And back.
    assert.equal(partners.get(1), 0);
    // Nothing applied yet: Apply on EITHER half takes both, in the answer's order.
    const none = () => false;
    // The remove's card.
    assert.deepEqual(ai.applyTogether(SWAP_OPS, 0, none), [0, 1]);
    // The add's card.
    assert.deepEqual(ai.applyTogether(SWAP_OPS, 1, none), [0, 1]);
    // A paired half never auto-applies alone (the add_back would otherwise land by itself).
    assert.equal(ai.isPairedHalf(SWAP_OPS, 1), true);
    // Once one half is on the resume, the other is applied on its own (it is no longer a swap).
    assert.deepEqual(ai.applyTogether(SWAP_OPS, 1, (op) => op.op === 'remove_entry'), [1]);
    // Different sections are not a swap: each card stays its own.
    const mixed: StoredOp[] = [SWAP_OPS[0]!, { op: 'add_entry', section: 'certifications', ref: 'cert_x', label: 'X' }];
    // Unpaired.
    assert.deepEqual(ai.applyTogether(mixed, 0, none), [0]);
  });
});

/* T13 (peer 1) adds to content-rules checkContentRules: the resume keeps an AI skills group with >= 5
   AI skills. This file does NOT build a second copy of that check; it pins that the editor's gate runs
   it. Was a todo until T13 landed; T10 and T13 ship together, so it is a real test now. */
describe('T10 AI group floor through the edit gate', () => {
  it('T10 AI group: removing a skill that drops the AI group below 5 is refused by the gate', () => {
    // Exactly five AI skills in an "AI" group.
    const ai5 = ['LLMs', 'RAG', 'LangChain', 'Prompt engineering', 'Embeddings'].map((name, i) => ({ ref: `sk_ai_${i}`, name, category: 'AI' }));
    // The 2-project resume with those skills.
    const resume = { ...CURRENT(), skills: ai5 } as ResolvedResume;
    // The master holds the same five, so the floor is not lowered by "what the master holds".
    const master = { ...THREE_PROJECT_MASTER, skills: ai5.map((s) => ({ id: s.ref, name: s.name, category: s.category })) } as unknown as MasterProfile;
    // One AI skill off, through the same batch gate the chat uses.
    const plan = fit.planBatch(resume, [{ kind: 'remove_skill', ref: 'sk_ai_0' }], step, [], master);
    // Refused by the AI-group rule itself (T13 names it "skills[AI]: ..."), not by some other floor.
    assert.ok(!plan.ok && plan.reason.includes('skills[AI]'), plan.ok ? 'applied' : plan.reason);
  });
});

describe('T10 review fixes', () => {
  it('T10 swap: an add-back outside a capped section is not linked to a remove', () => {
    // Certifications have a floor but no cap: an add there alone never breaks a rule, so it is no swap.
    const certs: StoredOp[] = [
      // A certification off.
      { op: 'remove_entry', section: 'certifications', ref: 'cert_a', label: 'A' },
      // Another one back.
      { op: 'add_entry', section: 'certifications', ref: 'cert_b', label: 'B' },
    ];
    // Unpaired: each card is its own.
    assert.equal(ai.swapPartners(certs).size, 0);
    // Two project removes and one project add: one pair, the second remove stands alone.
    const twoForOne: StoredOp[] = [SWAP_OPS[0]!, { op: 'remove_entry', section: 'projects', ref: 'prj_applyy', label: 'Applyy' }, SWAP_OPS[1]!];
    // The partners map.
    const partners = ai.swapPartners(twoForOne);
    // The first remove takes the add.
    assert.equal(partners.get(0), 2);
    // The second remove has no partner.
    assert.equal(partners.has(1), false);
  });

  it('T10 batch: a failed attest after the batch is reported, never silent', async () => {
    // Three cards: two resume-only ops and one skill new to the master (attest).
    const items = ['remove', 'add', 'attest'] as const;
    // The batch save lands; the attest is refused.
    const run = await ai.runApplyBatch(
      items,
      // Only the third writes the master.
      (item) => item === 'attest',
      // How the line names it.
      () => 'add skill "Kafka"',
      // The atomic save: landed.
      async () => ({ ok: true }),
      // The attest's own save: refused.
      async () => ({ ok: false, reason: 'the master changed' }),
    );
    // Partial, with counts and the refused card named.
    assert.deepEqual(run, { kind: 'partial', saved: 2, notSaved: 'add skill "Kafka"', reason: 'the master changed', notTried: 0 });
    // The line names what landed and what did not.
    assert.equal(ai.batchRunLine(run), 'Saved 2 changes; not saved: add skill "Kafka" — the master changed.');
    // A refused batch runs no attest at all and says nothing landed.
    let attempted = 0;
    // The batch save refused.
    const refused = await ai.runApplyBatch(items, (item) => item === 'attest', () => 'x', async () => ({ ok: false, reason: 'projects: 1, needs 2' }), async () => { attempted += 1; return { ok: true }; });
    // Nothing saved.
    assert.deepEqual(refused, { kind: 'none_saved', reason: 'projects: 1, needs 2' });
    // And no attest ran on top of it.
    assert.equal(attempted, 0);
  });
});
