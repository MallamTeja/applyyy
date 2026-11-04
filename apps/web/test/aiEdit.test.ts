/* The AI box on the review page (2026-10-31): the projection it sends, the mapping of each
 * proposed op onto the page's own EditActions, and the strict read of the edge function's answer.
 *
 * Harness: support/registerTsxHooks.ts, for the panel render and the extensionless imports Vite
 * resolves and Node does not. The client is a hand-built fake; nothing reaches the network. */

// The .tsx loader; must be the first import so it runs before any component loads.
import './support/registerTsxHooks.ts';
import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';

// The pure module under test.
let ai: typeof import('../src/features/approval/aiEdit.ts');
// The panel, rendered statically.
let panel: typeof import('../src/features/approval/AiEditPanel.tsx');
// Static server renderer, no DOM.
let render: (element: unknown) => string;
// Element factory, so no JSX in this .ts file.
let h: typeof import('react').createElement;

before(async () => {
  // Loaded after the hooks so they apply.
  ai = await import('../src/features/approval/aiEdit.ts');
  panel = await import('../src/features/approval/AiEditPanel.tsx');
  render = (await import('react-dom/server')).renderToStaticMarkup as (element: unknown) => string;
  h = (await import('react')).createElement;
});

// A run of tailored text; verdict and trace do not matter to the projection.
const run = (text: string) => ({ text, verdict: 'traced', tracesTo: null });

// A diff with one editable bullet, one removed, one locked (D4), a summary and a skills line.
const diff = {
  applicationId: 'app-1',
  jobTitle: 'Backend Engineer',
  companyName: 'Acme',
  coverage: { jdKeywords: ['Kafka', 'TypeScript'], honestlyMatched: ['TypeScript'], matchedByFabrication: [], matchedByEdit: [] },
  lines: [
    { id: 's', kind: 'summary', tailoredRuns: [run('Ships APIs.')], editTarget: { kind: 'summary' }, editState: 'original' },
    { id: 'x1', kind: 'bullet', masterText: 'Built a billing API on Postgres.', tailoredRuns: [run('Built '), run('a billing API.')], editTarget: { kind: 'bullet', ref: 'exp_1_b1' }, editState: 'original' },
    { id: 'x2', kind: 'bullet', tailoredRuns: [run('Gone.')], editTarget: { kind: 'bullet', ref: 'exp_1_b2' }, editState: 'removed' },
    { id: 'x3', kind: 'bullet', tailoredRuns: [run('Locked.')], editTarget: null, editState: 'original' },
    { id: 'skills', kind: 'skills', masterText: 'TypeScript, Postgres, Kafka', tailoredRuns: [run('TypeScript, Postgres')], editTarget: { kind: 'skills' }, editState: 'original' },
  ],
} as never;

describe('buildAssistDraft', () => {
  it('sends only printed, editable bullets under short ids, and only the missing keywords', () => {
    // Built from the fixture.
    const draft = ai.buildAssistDraft(diff, ['Languages', 'Tools'], '  Add Kafka  ');
    // The removed and the locked bullet are left out; the kept one is b0, runs joined.
    assert.deepEqual(draft.body.bullets, [{ id: 'b0', text: 'Built a billing API.' }]);
    // The ref stays in the browser.
    assert.equal(draft.refs.get('b0'), 'exp_1_b1');
    // TypeScript is already matched; only Kafka is a hint.
    assert.deepEqual(draft.body.job.missing, ['Kafka']);
    // Summary, skills and the trimmed instruction travel as-is.
    assert.equal(draft.body.summary, 'Ships APIs.');
    // The printed skills line.
    assert.equal(draft.body.skills, 'TypeScript, Postgres');
    // Trimmed.
    assert.equal(draft.body.instruction, 'Add Kafka');
    // No ref anywhere in what is sent: a model that never sees a ref cannot invent one.
    assert.doesNotMatch(JSON.stringify(draft.body), /exp_1_/);
  });
});

describe('resolveOps (one op) + toEditAction', () => {
  // One op resolved on its own, as resolveOps resolves the first op of an answer.
  const one = (op: Parameters<typeof ai.resolveOps>[0][number], draft: Parameters<typeof ai.resolveOps>[1]) => ai.resolveOps([op], draft)[0] ?? null;

  it('resolves each op to a real target at answer time, then to the action a click would make', () => {
    // The draft whose ids the ops use.
    const draft = ai.buildAssistDraft(diff, ['Tools'], 'x');
    // A bullet edit: stored against the bullet's ref, with the text it replaces.
    const edit = one({ op: 'edit', id: 'b0', text: 'New.', newNumbers: [] }, draft);
    // The ref, not the short id, so a reloaded chat still targets the right bullet.
    assert.deepEqual(edit && edit.op === 'edit' ? [edit.target, edit.before] : null, [{ kind: 'bullet', ref: 'exp_1_b1' }, 'Built a billing API.']);
    // Applied as a plain edit on that ref.
    assert.deepEqual(edit && ai.toEditAction(edit), { kind: 'edit', target: { kind: 'bullet', ref: 'exp_1_b1' }, text: 'New.' });
    // The summary has its own target.
    const summary = one({ op: 'edit', id: 'summary', text: 'S.', newNumbers: [] }, draft);
    // Applied on the summary.
    assert.deepEqual(summary && ai.toEditAction(summary), { kind: 'edit', target: { kind: 'summary' }, text: 'S.' });
    // An id that was never sent becomes a "not done" card with its reason, never a silent drop (2026-11-04).
    assert.deepEqual(one({ op: 'remove', id: 'b7' }, draft), { op: 'rejected', what: 'Remove bullet b7', why: 'The AI named a bullet it was not shown.' });
    // A skill records whether the master had it, and applies through the attest path.
    const skill = one({ op: 'add_skill', name: 'Kafka', category: 'Tools' }, draft);
    // Kafka is in the fixture's master skills.
    assert.deepEqual(skill, { op: 'add_skill', name: 'Kafka', category: 'Tools', inMaster: true });
    // Master first, then the resume.
    assert.deepEqual(skill && ai.toEditAction(skill), { kind: 'attest_skill', keyword: 'Kafka', category: 'Tools' });
  });
});

describe('isApplied (derived from the resume, never stored)', () => {
  it('reads each op against the current diff', () => {
    // An edit whose text is what the bullet prints now: applied.
    assert.equal(ai.isApplied({ op: 'edit', target: { kind: 'bullet', ref: 'exp_1_b1' }, before: null, text: 'Built a billing API.', advice: null }, diff), true);
    // Different text: not yet.
    assert.equal(ai.isApplied({ op: 'edit', target: { kind: 'bullet', ref: 'exp_1_b1' }, before: null, text: 'Other.', advice: null }, diff), false);
    // The removed bullet in the fixture reads as removed.
    assert.equal(ai.isApplied({ op: 'remove', ref: 'exp_1_b2', before: null }, diff), true);
    // A printed skill reads as added, case-insensitively.
    assert.equal(ai.isApplied({ op: 'add_skill', name: 'postgres', category: 'Tools', inMaster: true }, diff), true);
    // One the resume lacks does not.
    assert.equal(ai.isApplied({ op: 'add_skill', name: 'Kafka', category: 'Tools', inMaster: true }, diff), false);
  });
});

describe('readStoredOp (rows are untrusted)', () => {
  it('reads each stored shape back and refuses a malformed one', () => {
    // A stored edit round-trips.
    const edit = { op: 'edit', target: { kind: 'bullet', ref: 'r1' }, before: 'a', text: 'b', advice: { kind: 'checked', metrics: [], terms: ['x'] } };
    // Read as stored.
    assert.deepEqual(ai.readStoredOp(edit), edit);
    // A target without a ref could save the wrong bullet: refused.
    assert.equal(ai.readStoredOp({ ...edit, target: { kind: 'bullet' } }), null);
    // Advice with a non-string word: refused, not shown as fewer flags.
    assert.equal(ai.readStoredOp({ ...edit, advice: { kind: 'checked', metrics: [], terms: [1] } }), null);
    // A skill without its master flag: refused.
    assert.equal(ai.readStoredOp({ op: 'add_skill', name: 'Kafka', category: 'Tools' }), null);
  });
});

describe('requestAssist', () => {
  // A client whose invoke answers `answer`.
  const client = (answer: () => Promise<{ data: unknown; error: unknown }>) => ({ functions: { invoke: answer } });
  // A minimal valid body.
  const body = { instruction: 'x', job: { title: '', company: '', missing: [] }, summary: null, bullets: [], skills: '', categories: [], history: [] };

  it('reads a valid answer, unknown token counts as null', async () => {
    // The ok shape the function returns.
    const result = await ai.requestAssist(
      client(async () => ({ data: { status: 'ok', ops: [{ op: 'remove', id: 'b0' }], dropped: 1, note: 'n', usage: { input: 10 } }, error: null })),
      body,
    );
    // Read through.
    assert.deepEqual(result, { kind: 'ok', ops: [{ op: 'remove', id: 'b0' }], rejected: [{ what: '1 proposed change', why: 'The AI service did not say why.' }], note: 'n', usage: { input: 10, cached: null, output: null, thinking: null } });
  });

  it("shows the function's own refusal message", async () => {
    // supabase-js puts the body behind error.context.
    const error = { context: { json: async () => ({ status: 'quota', message: 'The AI quota is used up for now.' }) } };
    // The refusal.
    const result = await ai.requestAssist(client(async () => ({ data: null, error })), body);
    // Verbatim.
    assert.deepEqual(result, { kind: 'error', message: 'The AI quota is used up for now.' });
  });

  it('refuses an answer with an unknown op shape rather than showing part of it', async () => {
    // One good op, one with no id.
    const result = await ai.requestAssist(client(async () => ({ data: { status: 'ok', ops: [{ op: 'remove', id: 'b0' }, { op: 'remove' }], usage: {} }, error: null })), body);
    // An error, not a shorter list.
    assert.equal(result.kind, 'error');
  });

  it('never throws: no client and a thrown invoke both come back as errors', async () => {
    // No client configured.
    assert.equal((await ai.requestAssist(null, body)).kind, 'error');
    // A network drop.
    assert.equal((await ai.requestAssist(client(async () => { throw new Error('offline'); }), body)).kind, 'error');
  });
});

describe('formatUsage', () => {
  it('leaves unknown counts out instead of printing 0', () => {
    // Nothing reported.
    assert.equal(ai.formatUsage({ input: null, cached: null, output: null, thinking: null }), 'Token use not reported.');
    // Everything reported, with a cache hit.
    assert.equal(ai.formatUsage({ input: 900, cached: 512, output: 120, thinking: 80 }), 'Tokens: 900 in (512 cached), 120 out, 80 thinking.');
  });
});

describe('AiEditPanel (chat)', () => {
  it('renders a new chat: picker, empty-state hint, and Send disabled until something is typed', () => {
    // Static render with no store: a session-only chat; the seams are never called.
    const html = render(h(panel.AiEditPanel, { diff, onEdit: async () => ({ ok: true }), onAssist: async () => ({ kind: 'error', message: '' }), busy: false, categories: [] }));
    // The heading.
    assert.match(html, /<h3[^>]*class="ai-chat__title"[^>]*>AI resume chat<\/h3>/);
    // The past-chats picker, offering the unsaved new chat.
    assert.match(html, /<select[^>]*class="ai-chat__picker"[^>]*><option[^>]*>New chat<\/option><\/select>/);
    // The empty chat explains itself.
    assert.match(html, /<li class="ai-chat__empty">Say what to change/);
    // Send exists and is disabled on an empty message.
    assert.match(html, /<button type="submit"[^>]*disabled=""[^>]*>Send<\/button>/);
  });
});

describe('auditAdvice (the audit as advice, 2026-11-01)', () => {
  it("runs the auditor's rule 5 on a bullet edit against its master text", () => {
    // Master bullet "Built a billing API on Postgres."; master skills include Kafka.
    const draft = ai.buildAssistDraft(diff, ['Tools'], 'x');
    // "Reduced" is in neither the master bullet nor the allowlist; Kafka is a master skill; 40 is new.
    const advice = ai.auditAdvice({ op: 'edit', id: 'b0', text: 'Reduced billing API latency 40% using Kafka.', newNumbers: ['40'] }, draft);
    // Flagged words and numbers, each once.
    assert.deepEqual(advice, { kind: 'checked', metrics: ['40'], terms: ['reduced', 'latency'] });
    // A rewording inside the master and the allowlist is grounded.
    assert.deepEqual(ai.auditAdvice({ op: 'edit', id: 'b0', text: 'Built billing API using Postgres.', newNumbers: [] }, draft), { kind: 'checked', metrics: [], terms: [] });
  });

  it('says "not checked" for the summary instead of reporting it clean, and nothing for a removal', () => {
    // Same draft.
    const draft = ai.buildAssistDraft(diff, ['Tools'], 'x');
    // The auditor has no wording rule for summaries; the new numbers are still shown.
    assert.deepEqual(ai.auditAdvice({ op: 'edit', id: 'summary', text: 'Ships 3 APIs.', newNumbers: ['3'] }, draft), {
      kind: 'not_checked',
      why: 'The audit does not check summary wording. New numbers: 3.',
    });
    // A removal changes no wording.
    assert.equal(ai.auditAdvice({ op: 'remove', id: 'b0' }, draft), null);
  });

  it("knows the master's skills, so a card can say when Apply also saves one there", () => {
    // Lower-cased whole names from the skills line's master text.
    assert.deepEqual([...ai.buildAssistDraft(diff, [], 'x').masterSkills], ['typescript', 'postgres', 'kafka']);
  });
});

describe('skill card group picker (2026-11-01)', () => {
  it("offers every master group, preselecting the AI's pick, so a misfiled skill is fixed before Apply", () => {
    // OS filed under Frameworks by the AI, the failure seen on 2026-11-01.
    const op = { op: 'add_skill', name: 'OS', category: 'Frameworks', inMaster: false } as const;
    // With a change handler: the picker renders.
    const html = render(h(panel.OpBody, { op, categories: ['Languages', 'Frameworks', 'Databases'], onGroup: () => {} }));
    // A labelled select.
    assert.match(html, /<select class="ai-chat__group" aria-label="Skill group for OS"/);
    // All three groups, Frameworks selected.
    assert.match(html, /<option value="Languages">Languages<\/option><option value="Frameworks" selected="">Frameworks<\/option><option value="Databases">Databases<\/option>/);
    // An operator pick overrides the AI's.
    assert.match(render(h(panel.OpBody, { op, categories: ['Languages', 'Frameworks'], group: 'Languages', onGroup: () => {} })), /<option value="Languages" selected="">/);
  });
});

describe('shouldAutoApply (the AI performs the actions, 2026-11-01)', () => {
  // A skill the master lacks.
  const skill = (name: string) => ({ op: 'add_skill', name, category: 'Tools', inMaster: false }) as const;

  it('applies edits and removals by itself', () => {
    // A bullet edit.
    assert.equal(ai.shouldAutoApply({ op: 'edit', target: { kind: 'bullet', ref: 'r' }, before: null, text: 't', advice: null }, 'x'), true);
    // A removal.
    assert.equal(ai.shouldAutoApply({ op: 'remove', ref: 'r', before: null }, 'x'), true);
  });

  it('adds a master-less skill only when the operator named it, by whole words', () => {
    // The 2026-11-01 message: each named skill auto-applies.
    const said = 'hey i wanan add dbms , os , cn , oops skills to';
    // Named, so applied.
    assert.deepEqual(['DBMS', 'OS', 'CN', 'OOPS'].map((n) => ai.shouldAutoApply(skill(n), said)), [true, true, true, true]);
    // "os" inside "cost" is not naming OS.
    assert.equal(ai.shouldAutoApply(skill('OS'), 'cut the cost line'), false);
    // A skill the AI chose on its own waits for a click.
    assert.equal(ai.shouldAutoApply(skill('Kubernetes'), said), false);
    // Every word of a multi-word name must be typed: "reviewing" is not "review".
    assert.equal(ai.shouldAutoApply(skill('Code review'), 'add the code reviewing skill'), false);
    // Already in the master: printing it claims nothing new.
    assert.equal(ai.shouldAutoApply({ ...skill('Kubernetes'), inMaster: true }, 'anything'), true);
  });
});

// --- structure edits (2026-11-01) ---------------------------------------------------

// A bullet line on ref `ref` printing `text`.
const bulletLine = (ref: string, text: string) => ({ id: ref, kind: 'bullet', masterText: text, tailoredRuns: [run(text)], editTarget: { kind: 'bullet', ref }, editState: 'original' });

// A diff with three job bullets and one project bullet, in print order.
const sdiff = {
  applicationId: 'app-2',
  jobTitle: 'Backend Engineer',
  companyName: 'Acme',
  coverage: { jdKeywords: [], honestlyMatched: [], matchedByFabrication: [], matchedByEdit: [] },
  lines: [bulletLine('x_b1', 'Shipped A.'), bulletLine('x_b2', 'Shipped B.'), bulletLine('x_b3', 'Shipped C.'), bulletLine('p_b1', 'Predicted pace.')],
} as never;

// The structure the page would build for sdiff: b0..b2 under e0 (the job), b3 under e1 (the project).
const structure = {
  sections: ['summary', 'experience', 'projects', 'skills'],
  entries: [
    { section: 'experience', ref: 'x', label: 'Aczen Technologies · Full Stack AI Engineer', bulletRefs: ['x_b1', 'x_b2', 'x_b3'] },
    { section: 'projects', ref: 'p', label: 'F1 Race Pace Predictor', bulletRefs: ['p_b1'] },
  ],
  addable: {
    // One master bullet under the job, and one under an entry that is NOT on the resume.
    bullets: [
      { ref: 'x_b4', text: 'Mentored two interns.', section: 'experience', parentRef: 'x', parentLabel: 'Aczen Technologies · Full Stack AI Engineer' },
      { ref: 'q_b1', text: 'Orphan.', section: 'projects', parentRef: 'q', parentLabel: 'Other' },
    ],
    // One whole achievement.
    entries: [{ ref: 'ach_1', section: 'achievements', label: 'LeetCode' }],
  },
} as const;

// The same structure with one entry's bullet order (or the section order) replaced.
const reordered = (bulletRefs: readonly string[], sections: readonly string[] = structure.sections) =>
  ({ ...structure, sections, entries: [{ ...structure.entries[0], bulletRefs }, structure.entries[1]] }) as never;

describe('buildAssistDraft with a structure (2026-11-01)', () => {
  it('tags each bullet with its entry, labels entries once, and lists placeable master items under short ids', () => {
    // Built with the structure.
    const draft = ai.buildAssistDraft(sdiff, [], 'x', [], structure as never);
    // b0..b2 under e0, b3 under e1.
    assert.deepEqual(draft.body.bullets.map((b) => b.entry), ['e0', 'e0', 'e0', 'e1']);
    // Each entry once, by section and label.
    assert.deepEqual(draft.body.entries, [
      { id: 'e0', section: 'experience', label: 'Aczen Technologies · Full Stack AI Engineer' },
      { id: 'e1', section: 'projects', label: 'F1 Race Pace Predictor' },
    ]);
    // Entries first, then bullets; the orphan (its entry is not on the resume) is left out.
    assert.deepEqual(draft.body.available, [
      { id: 'n0', section: 'achievements', label: 'LeetCode' },
      { id: 'm0', entry: 'e0', text: 'Mentored two interns.' },
    ]);
    // The section order travels as section_order spells it.
    assert.deepEqual(draft.body.sections, structure.sections);
    // No ref anywhere in what is sent.
    assert.doesNotMatch(JSON.stringify(draft.body), /x_b|p_b|ach_1|"ref"|parentRef/);
  });

  it('sends exactly the pre-structure body when the page passes no structure', () => {
    // No structure.
    const draft = ai.buildAssistDraft(sdiff, [], 'x');
    // None of the three keys, and no entry on any bullet: the old edge function sees what it always saw.
    assert.deepEqual(Object.keys(draft.body).sort(), ['bullets', 'categories', 'history', 'instruction', 'job', 'skills', 'summary']);
    // Bare bullets.
    assert.ok(draft.body.bullets.every((b) => !('entry' in b)));
  });

  it('caps AVAILABLE at 30 items and cuts a long master text', () => {
    // Forty master bullets under the job, one of them 300 characters long.
    const many = Array.from({ length: 40 }, (_, i) => ({ ...structure.addable.bullets[0], ref: `x_m${i}`, text: i === 0 ? 'y'.repeat(300) : `T${i}.` }));
    // Built.
    const draft = ai.buildAssistDraft(sdiff, [], 'x', [], { ...structure, addable: { entries: structure.addable.entries, bullets: many } } as never);
    // One entry plus 29 bullets.
    assert.equal(draft.body.available?.length, 30);
    // Cut to the function's 200, ending in an ellipsis.
    const first = draft.body.available?.[1];
    // A bullet item.
    assert.equal(first && 'text' in first ? first.text.length : null, 200);
  });
});

describe('resolveOps (structure ops, played in order)', () => {
  // The draft every case resolves against.
  const draft = () => ai.buildAssistDraft(sdiff, [], 'x', [], structure as never);

  it('gives repeated moves different siblings, and drops a move past the end', () => {
    // b2 (x_b3) up three times: past x_b2, past x_b1, then it is already first.
    const ops = ai.resolveOps(Array.from({ length: 3 }, () => ({ op: 'move', id: 'b2', direction: 'up' }) as const), draft());
    // The pasts, then a rejected card.
    assert.deepEqual(ops.map((op) => (op.op === 'move' ? op.past : op.op)), ['x_b2', 'x_b1', 'rejected']);
    // The first bullet cannot go up, and the last of an entry cannot go down: each says why.
    assert.deepEqual(ai.resolveOps([{ op: 'move', id: 'b0', direction: 'up' }, { op: 'move', id: 'b3', direction: 'down' }], draft()).map((op) => (op.op === 'rejected' ? op.why : op.op)), ['That bullet is already first in its entry.', 'That bullet is already last in its entry.']);
    // A removal earlier in the answer shortens the order: b1 becomes first, so it cannot go up.
    assert.equal(ai.resolveOps([{ op: 'remove', id: 'b0' }, { op: 'move', id: 'b1', direction: 'up' }], draft())[1]?.op, 'rejected');
  });

  it('resolves section moves, add-backs and new bullets to real targets, and unknown ids to "not done" cards', () => {
    // Projects up passes experience; an unprinted section and unknown ids resolve to nothing.
    const ops = ai.resolveOps(
      [
        { op: 'move_section', section: 'projects', direction: 'up' },
        { op: 'move_section', section: 'education', direction: 'up' },
        { op: 'add_back', id: 'm0' },
        { op: 'add_back', id: 'n0' },
        { op: 'add_back', id: 'm9' },
        { op: 'new_bullet', entry: 'e1', text: 'Modelled tyre wear.' },
        { op: 'new_bullet', entry: 'e7', text: 'x' },
      ],
      draft(),
    );
    // Each stored shape carries what its card and its Apply need.
    assert.deepEqual(ops, [
      { op: 'move_section', section: 'projects', direction: 'up', past: 'experience' },
      { op: 'rejected', what: 'Move section Education up', why: 'Education is not printed on this resume.' },
      { op: 'add_bullet', ref: 'x_b4', text: 'Mentored two interns.', parentLabel: 'Aczen Technologies · Full Stack AI Engineer' },
      { op: 'add_entry', section: 'achievements', ref: 'ach_1', label: 'LeetCode' },
      { op: 'rejected', what: 'Add back m9', why: 'The AI named a master item it was not shown.' },
      { op: 'new_bullet', section: 'projects', parentRef: 'p', parentLabel: 'F1 Race Pace Predictor', text: 'Modelled tyre wear.' },
      { op: 'rejected', what: 'New bullet under e7', why: 'The AI named an entry it was not shown.' },
    ]);
  });

  it('resolves no structural op without a structure', () => {
    // The pre-structure draft.
    const flat = ai.buildAssistDraft(sdiff, [], 'x');
    // Nothing to move among, nothing available, no entries.
    assert.deepEqual(ai.resolveOps([{ op: 'move', id: 'b1', direction: 'up' }, { op: 'add_back', id: 'm0' }, { op: 'new_bullet', entry: 'e0', text: 't' }], flat).map((op) => op.op), ['rejected', 'rejected', 'rejected']);
  });
});

describe('structure ops: action, auto-apply, applied state', () => {
  // One of each stored shape.
  const move = { op: 'move', ref: 'x_b3', direction: 'up', past: 'x_b2', before: 'Shipped C.' } as const;
  const section = { op: 'move_section', section: 'projects', direction: 'up', past: 'experience' } as const;
  const addBullet = { op: 'add_bullet', ref: 'x_b4', text: 'Mentored two interns.', parentLabel: 'Aczen' } as const;
  const addEntry = { op: 'add_entry', section: 'achievements', ref: 'ach_1', label: 'LeetCode' } as const;
  const fresh = { op: 'new_bullet', section: 'projects', parentRef: 'p', parentLabel: 'F1', text: 'Predicted pace.' } as const;

  it("maps each onto the page's own structural EditAction", () => {
    // The five actions DiffView declares.
    assert.deepEqual([move, section, addBullet, addEntry, fresh].map((op) => ai.toEditAction(op)), [
      { kind: 'move_bullet', ref: 'x_b3', direction: 'up' },
      { kind: 'move_section', section: 'projects', direction: 'up' },
      { kind: 'add_master_bullet', ref: 'x_b4' },
      { kind: 'add_master_entry', section: 'achievements', ref: 'ach_1' },
      { kind: 'attest_bullet', section: 'projects', parentRef: 'p', text: 'Predicted pace.' },
    ]);
  });

  it('applies moves and add-backs by itself; a new bullet always waits for a click', () => {
    // Reorder or reuse true master text.
    assert.deepEqual([move, section, addBullet, addEntry].map((op) => ai.shouldAutoApply(op, 'x')), [true, true, true, true]);
    // Even when the operator typed the exact words: it is a new master claim.
    assert.equal(ai.shouldAutoApply(fresh, 'add predicted pace'), false);
  });

  it('reads applied state from the structure, never from a stored flag', () => {
    // Not yet: x_b3 is still below x_b2.
    assert.equal(ai.isApplied(move, sdiff, structure as never), false);
    // After the swap.
    assert.equal(ai.isApplied(move, sdiff, reordered(['x_b1', 'x_b3', 'x_b2'])), true);
    // Projects is still below experience.
    assert.equal(ai.isApplied(section, sdiff, structure as never), false);
    // After the swap.
    assert.equal(ai.isApplied(section, sdiff, reordered(['x_b1', 'x_b2', 'x_b3'], ['summary', 'projects', 'experience', 'skills'])), true);
    // Not on the resume yet.
    assert.deepEqual([ai.isApplied(addBullet, sdiff, structure as never), ai.isApplied(addEntry, sdiff, structure as never)], [false, false]);
    // On the resume.
    assert.equal(ai.isApplied(addBullet, sdiff, reordered(['x_b1', 'x_b2', 'x_b3', 'x_b4'])), true);
    // The project already prints "Predicted pace." under p: applied.
    assert.equal(ai.isApplied(fresh, sdiff, structure as never), true);
    // Without a structure nothing structural can be confirmed.
    assert.equal(ai.isApplied(fresh, sdiff), false);
  });

  it('reads each new stored shape back, and refuses an open direction or a section outside its list', () => {
    // Round trips.
    assert.deepEqual([move, section, addBullet, addEntry, fresh].map((op) => ai.readStoredOp(op)), [move, section, addBullet, addEntry, fresh]);
    // "top" is not a direction.
    assert.equal(ai.readStoredOp({ ...move, direction: 'top' }), null);
    // Not a section name.
    assert.equal(ai.readStoredOp({ ...section, past: 'hobbies' }), null);
    // A section with no entries cannot hold one.
    assert.equal(ai.readStoredOp({ ...addEntry, section: 'skills' }), null);
    // A new bullet with no parent could land anywhere.
    assert.equal(ai.readStoredOp({ ...fresh, parentRef: undefined }), null);
  });

  it('renders each card; a new bullet says Apply also writes the master', () => {
    // Static markup without the <!-- --> React puts between adjacent text nodes.
    const card = (op: unknown) => render(h(panel.OpBody, { op } as never)).replace(/<!-- -->/g, '');
    // The new-bullet card.
    assert.match(card(fresh), /New bullet under F1.*Predicted pace\..*Not in your master profile yet: Apply saves it there too\./);
    // The section card.
    assert.match(card(section), /Move section <strong>Projects<\/strong> up/);
    // The entry card.
    assert.match(card(addEntry), /Add back to Achievements.*LeetCode/);
  });
});

describe('requestAssist reads the structure ops', () => {
  it('accepts the four new wire shapes and refuses one without its direction', async () => {
    // Every new shape at once.
    const ops = [
      { op: 'move', id: 'b0', direction: 'down' },
      { op: 'move_section', section: 'projects', direction: 'up' },
      { op: 'add_back', id: 'n0' },
      { op: 'new_bullet', entry: 'e0', text: 't' },
    ];
    // A client answering them.
    const answer = (list: unknown[]) => ({ functions: { invoke: async () => ({ data: { status: 'ok', ops: list, note: '' }, error: null }) } });
    // A minimal body.
    const body = { instruction: 'x', job: { title: '', company: '', missing: [] }, summary: null, bullets: [], skills: '', categories: [], history: [] };
    // Read through as-is.
    const ok = await ai.requestAssist(answer(ops), body);
    // Every op kept.
    assert.deepEqual(ok.kind === 'ok' ? ok.ops : null, ops);
    // A move with no direction is contract drift: an error, not a shorter list.
    assert.equal((await ai.requestAssist(answer([{ op: 'move', id: 'b0' }]), body)).kind, 'error');
  });
});

describe('structureFromDiff (the chat reads the structure the page renders, 2026-11-01)', () => {
  it('lists printed sections in order, live entries with printed bullets, and the master offers', () => {
    // One printed experience entry (one bullet kept, one removed, one offer); an unprinted section offering an achievement.
    const sectioned = {
      lines: [
        { id: 'l1', kind: 'bullet', editTarget: { kind: 'bullet', ref: 'b1' }, editState: 'original', tailoredRuns: [] },
        { id: 'l2', kind: 'bullet', editTarget: { kind: 'bullet', ref: 'b2' }, editState: 'removed', tailoredRuns: [] },
      ],
      sections: [
        { kind: 'summary', printed: true, entries: [], addableEntries: [] },
        { kind: 'experience', printed: true, entries: [{ section: 'experience', ref: 'exp1', label: 'Aczen', state: 'kept', lineIds: ['l1', 'l2'], addableBullets: [{ ref: 'm1', text: 'Built RAG' }] }], addableEntries: [] },
        { kind: 'achievements', printed: false, entries: [{ section: 'achievements', ref: 'gone', label: 'Old', state: 'removed', lineIds: [], addableBullets: [] }], addableEntries: [{ ref: 'ach2', label: 'Hackathon' }] },
      ],
    } as never;
    // The adapter under test.
    const structure = ai.structureFromDiff(sectioned);
    // Printed sections only, in print order (summary included: section_order names it).
    assert.deepEqual(structure?.sections, ['summary', 'experience']);
    // The live entry with only its printed bullet; the removed entry is not targetable.
    assert.deepEqual(structure?.entries, [{ section: 'experience', ref: 'exp1', label: 'Aczen', bulletRefs: ['b1'] }]);
    // The bullet offer carries its owner, as AddableBullet names it.
    assert.deepEqual(structure?.addable.bullets, [{ ref: 'm1', text: 'Built RAG', section: 'experience', parentRef: 'exp1', parentLabel: 'Aczen' }]);
    // The whole-entry offer from the unprinted section.
    assert.deepEqual(structure?.addable.entries, [{ ref: 'ach2', section: 'achievements', label: 'Hackathon' }]);
  });

  it('is null for a diff without sections, so the chat keeps its old behaviour', () => {
    // A hand-built fixture predating sections.
    assert.equal(ai.structureFromDiff({ lines: [] } as never), null);
  });
});

// --- an honest chat with full read/write (2026-11-04) ---------------------------------
// Live evidence that drove these: 20 of 25 stored AI replies carried no ops, and several still said
// "I have added C to the Languages skill group". The reply text was the model's, written before the
// server dropped its ops. These tests pin the fix: what the chat says was done is derived from the
// resume, every dropped op is shown with its reason, and the AI can read the JD and remove skills/entries.

// The skills line as the page renders it now: every printed skill with its ref and group.
const skillsLine = {
  id: 'skills',
  kind: 'skills',
  masterText: 'TypeScript, Postgres, Kafka, Testing',
  tailoredRuns: [run('TypeScript, Postgres, Testing')],
  editTarget: { kind: 'skills' },
  editState: 'original',
  printedSkills: [
    { ref: 'sk_ts', name: 'TypeScript', category: 'Languages' },
    { ref: 'sk_pg', name: 'Postgres', category: 'Databases' },
    { ref: 'sk_test', name: 'Testing', category: 'Tools' },
  ],
};

// sdiff with that skills line and the posting's own fields, as diffAdapter passes them through.
const jdiff = {
  ...(sdiff as object),
  lines: [...(sdiff as unknown as { lines: unknown[] }).lines, skillsLine],
  locations: ['Bengaluru, India', 'Remote'],
  workArrangement: 'hybrid',
  jobDescription: '<p>We need <b>Go</b> and   Kafka.</p><ul><li>Location: Bengaluru</li></ul>',
} as never;

describe('buildAssistDraft reads the posting and the skill groups (2026-11-04)', () => {
  it('sends the location, arrangement and the JD as plain text, and every printed skill with its group', () => {
    // Built with the structure, as the page builds it.
    const draft = ai.buildAssistDraft(jdiff, ['Languages', 'Databases', 'Tools'], 'where is this role?', [], structure as never);
    // Where the job is, so "is this remote?" has an answer.
    assert.equal(draft.body.job.location, 'Bengaluru, India; Remote');
    // How it is worked.
    assert.equal(draft.body.job.arrangement, 'hybrid');
    // Tags stripped and whitespace collapsed, exactly as DiffView shows the posting.
    assert.equal(draft.body.job.description, 'We need Go and Kafka. Location: Bengaluru');
    // Every printed skill with the group it prints under, so "which group?" is answerable.
    assert.deepEqual(draft.body.printedSkills, [
      { name: 'TypeScript', category: 'Languages' },
      { name: 'Postgres', category: 'Databases' },
      { name: 'Testing', category: 'Tools' },
    ]);
    // Refs still never leave the browser.
    assert.doesNotMatch(JSON.stringify(draft.body), /sk_/);
  });

  it('cuts a long JD to the function cap and leaves absent fields out entirely', () => {
    // A 9000-character posting.
    const long = ai.buildAssistDraft({ ...(jdiff as object), jobDescription: 'a'.repeat(9000) } as never, [], 'x');
    // Cut to the edge function's 8000, never refused there.
    assert.equal(long.body.job.description?.length, 8000);
    // The old fixture has none of the new fields: the job block is exactly what an old server read.
    assert.deepEqual(Object.keys(ai.buildAssistDraft(sdiff, [], 'x').body.job).sort(), ['company', 'missing', 'title']);
  });
});

describe('remove_skill and remove_entry (full write, 2026-11-04)', () => {
  // The draft the ops resolve against.
  const draft = () => ai.buildAssistDraft(jdiff, ['Tools'], 'remove testing', [], structure as never);

  it('resolve to the refs the save path removes, and unknown names to a reason', () => {
    // A printed skill by name, any case; an unprinted one; a known entry; an unknown one.
    const ops = ai.resolveOps(
      [
        { op: 'remove_skill', name: 'testing' },
        { op: 'remove_skill', name: 'Kafka' },
        { op: 'remove_entry', id: 'e1' },
        { op: 'remove_entry', id: 'e9' },
      ],
      draft(),
    );
    // Each carries what its card and its Apply need.
    assert.deepEqual(ops, [
      { op: 'remove_skill', ref: 'sk_test', name: 'Testing' },
      { op: 'rejected', what: 'Remove skill "Kafka"', why: '"Kafka" is not on the resume.' },
      { op: 'remove_entry', section: 'projects', ref: 'p', label: 'F1 Race Pace Predictor' },
      { op: 'rejected', what: 'Remove entry e9', why: 'The AI named an entry it was not shown.' },
    ]);
  });

  it("map onto the page's own actions, apply by themselves, and read applied from the resume", () => {
    // The two stored shapes.
    const skill = { op: 'remove_skill', ref: 'sk_test', name: 'Testing' } as const;
    const entry = { op: 'remove_entry', section: 'projects', ref: 'p', label: 'F1 Race Pace Predictor' } as const;
    // The save path's existing actions; no new write path.
    assert.deepEqual([ai.toEditAction(skill), ai.toEditAction(entry)], [
      { kind: 'remove_skill', ref: 'sk_test' },
      { kind: 'remove_entry', section: 'projects', ref: 'p' },
    ]);
    /* Review finding (2026-11-04): the JD is untrusted text in the prompt, so a posting could induce
       removals. A skill auto-applies only when the operator named it (the add_skill rule); a whole
       entry, the biggest removal, always waits for a click. */
    assert.deepEqual([ai.shouldAutoApply(skill, 'remove the duplicate testing'), ai.shouldAutoApply(skill, 'trim my skills'), ai.shouldAutoApply(entry, 'remove the F1 project')], [true, false, false]);
    // Testing still prints: not applied.
    assert.equal(ai.isApplied(skill, jdiff, structure as never), false);
    // A skill whose ref no longer prints: applied.
    assert.equal(ai.isApplied({ op: 'remove_skill', ref: 'sk_kafka', name: 'Kafka' }, jdiff, structure as never), true);
    // The project is still on the resume: not applied; without it: applied.
    assert.equal(ai.isApplied(entry, jdiff, structure as never), false);
    // Only the job entry left.
    assert.equal(ai.isApplied(entry, jdiff, { ...structure, entries: [structure.entries[0]] } as never), true);
    // Both round-trip through the store.
    assert.deepEqual([ai.readStoredOp(skill), ai.readStoredOp(entry)], [skill, entry]);
  });

  it('reads a skill removal by ref, so removing one of two same-named skills reads as done', () => {
    // Teja's case: "Testing" printed twice, under two groups; the AI removed one copy.
    const twice = { ...(jdiff as object), lines: [{ ...skillsLine, tailoredRuns: [run('TypeScript, Testing')], printedSkills: [skillsLine.printedSkills[0], { ref: 'sk_test_ai', name: 'Testing', category: 'AI' }] }] } as never;
    // The removed copy's ref is gone: done, although the name still prints once.
    assert.equal(ai.isApplied({ op: 'remove_skill', ref: 'sk_test', name: 'Testing' }, twice), true);
    // The copy still printed: not done.
    assert.equal(ai.isApplied({ op: 'remove_skill', ref: 'sk_test_ai', name: 'Testing' }, twice), false);
  });
});

describe('rejected cards (every dropped op is shown with its reason, 2026-11-04)', () => {
  // One rejected card.
  const rejected = { op: 'rejected', what: 'Add skill "C"', why: "The AI's answer did not name the skill." } as const;

  it('never apply, never read as applied, and round-trip through the store', () => {
    // Nothing to apply.
    assert.equal(ai.shouldAutoApply(rejected, 'add c'), false);
    // Never "Applied", whatever the resume holds.
    assert.equal(ai.isApplied(rejected, jdiff, structure as never), false);
    // Stored and read back.
    assert.deepEqual(ai.readStoredOp(rejected), rejected);
    // A card with no reason is not one.
    assert.equal(ai.readStoredOp({ op: 'rejected', what: 'x' }), null);
  });

  it('come from the server with their reasons, plus a count the server did not itemise', async () => {
    // The new server shape: two reasons listed, three dropped in all.
    const client = { functions: { invoke: async () => ({ data: { status: 'ok', ops: [], dropped: 3, rejected: [{ what: 'Add skill "C"', why: 'No name.' }, { what: 'Add skill "Go"', why: 'Not a group.' }], note: 'n', usage: {} }, error: null }) } };
    // Read.
    const result = await ai.requestAssist(client, { instruction: 'x', job: { title: '', company: '', missing: [] }, summary: null, bullets: [], skills: '', categories: [], history: [] });
    // Both listed, and the third said rather than lost.
    assert.deepEqual(result.kind === 'ok' ? result.rejected : null, [
      { what: 'Add skill "C"', why: 'No name.' },
      { what: 'Add skill "Go"', why: 'Not a group.' },
      { what: '1 more proposed change', why: 'The AI service did not say why.' },
    ]);
  });

  it('refuse a malformed reason list instead of showing part of it', async () => {
    // A reason that is not a string.
    const client = { functions: { invoke: async () => ({ data: { status: 'ok', ops: [], rejected: [{ what: 'x', why: 1 }], note: '', usage: {} }, error: null }) } };
    // An error, like an unreadable op.
    assert.equal((await ai.requestAssist(client, { instruction: 'x', job: { title: '', company: '', missing: [] }, summary: null, bullets: [], skills: '', categories: [], history: [] })).kind, 'error');
  });
});

describe('outcomeNote: what the chat remembers as done (2026-11-04)', () => {
  it('lists applied, not-yet-applied and impossible changes from the resume, never from the AI text', () => {
    // One applied (Testing is printed), one waiting (a new bullet), one rejected.
    const note = ai.outcomeNote(
      [
        { op: 'add_skill', name: 'Testing', category: 'Tools', inMaster: true },
        { op: 'new_bullet', section: 'projects', parentRef: 'p', parentLabel: 'F1', text: 'Modelled tyre wear across a race.' },
        { op: 'rejected', what: 'Add skill "C"', why: "The AI's answer did not name the skill." },
      ],
      jdiff,
      structure as never,
    );
    // The model reads this ahead of its own old reply, so it cannot believe a change it only claimed.
    assert.equal(note, '[Applied: add skill "Testing" | Not applied yet: new bullet "Modelled tyre wear across a race." | Could not do: Add skill "C" (The AI\'s answer did not name the skill.)]');
    // No ops: nothing to say.
    assert.equal(ai.outcomeNote([], jdiff, structure as never), '');
  });
});

describe('AiEditPanel shows the truth on each card (2026-11-04)', () => {
  it('renders a rejected card as "Not done" with its reason and no Apply button', () => {
    // Static markup without React's text separators.
    const html = render(h(panel.OpBody, { op: { op: 'rejected', what: 'Add skill "C"', why: "The AI's answer did not name the skill." } } as never)).replace(/<!-- -->/g, '');
    // What was asked and why it did not happen.
    assert.match(html, /Add skill &quot;C&quot;.*The AI&#x27;s answer did not name the skill\./);
    // No button inside a card body.
    assert.doesNotMatch(html, /<button/);
  });

  it('renders remove_skill and remove_entry cards', () => {
    // Static markup without React's text separators.
    const card = (op: unknown) => render(h(panel.OpBody, { op } as never)).replace(/<!-- -->/g, '');
    // The skill, struck.
    assert.match(card({ op: 'remove_skill', ref: 'sk_test', name: 'Testing' }), /Remove skill <del[^>]*>Testing<\/del>/);
    // The entry, struck, with its section.
    assert.match(card({ op: 'remove_entry', section: 'projects', ref: 'p', label: 'F1' }), /Remove from Projects.*<del[^>]*>F1<\/del>/);
  });

  it('offers starter questions in an empty chat', () => {
    // Static render with no store.
    const html = render(h(panel.AiEditPanel, { diff: jdiff, onEdit: async () => ({ ok: true }), onAssist: async () => ({ kind: 'error', message: '' }), busy: false, categories: [] }));
    // At least one suggestion button, typed into the composer on click.
    assert.match(html, /<button type="button" class="ai-chat__suggestion"/);
  });
});

describe('review fixes (2026-11-04)', () => {
  it('removes the named copy when one skill name prints under two groups, and the first copy otherwise', () => {
    // Testing under Frameworks and under Tools.
    const twice = { ...(jdiff as object), lines: [{ ...skillsLine, printedSkills: [{ ref: 'sk_t_fw', name: 'Testing', category: 'Frameworks' }, { ref: 'sk_t_tools', name: 'Testing', category: 'Tools' }] }] } as never;
    // The draft over it.
    const draft = ai.buildAssistDraft(twice, [], 'x');
    // "from Tools" takes the Tools copy; no group takes the first, as the server's spelling does.
    assert.deepEqual(ai.resolveOps([{ op: 'remove_skill', name: 'Testing', category: 'Tools' }, { op: 'remove_skill', name: 'testing' }], draft).map((op) => (op.op === 'remove_skill' ? op.ref : op.op)), ['sk_t_tools', 'sk_t_fw']);
  });

  it('refuses later ops on an entry this answer already removes, instead of failing them at save time', () => {
    // The job entry e0 holds b0..b2; the project e1 holds b3.
    const draft = ai.buildAssistDraft(sdiff, [], 'x', [], structure as never);
    // Remove the job, then edit and move its bullets and write under it; the project edit is untouched.
    const ops = ai.resolveOps(
      [
        { op: 'remove_entry', id: 'e0' },
        { op: 'edit', id: 'b0', text: 'New.', newNumbers: [] },
        { op: 'move', id: 'b1', direction: 'down' },
        { op: 'new_bullet', entry: 'e0', text: 'x' },
        { op: 'add_back', id: 'm0' },
        { op: 'edit', id: 'b3', text: 'Fine.', newNumbers: [] },
      ],
      draft,
    );
    // Each dependent op says why; the independent one resolves.
    assert.deepEqual(ops.map((op) => (op.op === 'rejected' ? op.why : op.op)), [
      'remove_entry',
      'An earlier change in this answer removes its entry.',
      'An earlier change in this answer removes its entry.',
      'An earlier change in this answer removes its entry.',
      'An earlier change in this answer removes its entry.',
      'edit',
    ]);
  });

  it('keeps a literal "<" in the posting instead of losing the rest of the text', () => {
    // A requirement written with "<" and no closing ">".
    const draft = ai.buildAssistDraft({ ...(jdiff as object), jobDescription: '<p>Need <3 years of Go.</p> Location: Pune' } as never, [], 'x');
    // Only the real tags go.
    assert.equal(draft.body.job.description, 'Need <3 years of Go. Location: Pune');
  });
});
