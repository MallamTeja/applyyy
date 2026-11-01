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

describe('toEditAction', () => {
  it('maps each op onto the action a click would make', () => {
    // The draft whose ids the ops use.
    const draft = ai.buildAssistDraft(diff, ['Tools'], 'x');
    // A bullet edit lands on the bullet's ref.
    assert.deepEqual(ai.toEditAction({ op: 'edit', id: 'b0', text: 'New.', newNumbers: [] }, draft), { kind: 'edit', target: { kind: 'bullet', ref: 'exp_1_b1' }, text: 'New.' });
    // The summary has its own target.
    assert.deepEqual(ai.toEditAction({ op: 'edit', id: 'summary', text: 'S.', newNumbers: [] }, draft), { kind: 'edit', target: { kind: 'summary' }, text: 'S.' });
    // An id that was never sent maps to nothing.
    assert.equal(ai.toEditAction({ op: 'remove', id: 'b7' }, draft), null);
    // A skill always goes through the attest path (master first).
    assert.deepEqual(ai.toEditAction({ op: 'add_skill', name: 'Kafka', category: 'Tools' }, draft), { kind: 'attest_skill', keyword: 'Kafka', category: 'Tools' });
  });
});

describe('requestAssist', () => {
  // A client whose invoke answers `answer`.
  const client = (answer: () => Promise<{ data: unknown; error: unknown }>) => ({ functions: { invoke: answer } });
  // A minimal valid body.
  const body = { instruction: 'x', job: { title: '', company: '', missing: [] }, summary: null, bullets: [], skills: '', categories: [] };

  it('reads a valid answer, unknown token counts as null', async () => {
    // The ok shape the function returns.
    const result = await ai.requestAssist(
      client(async () => ({ data: { status: 'ok', ops: [{ op: 'remove', id: 'b0' }], dropped: 1, note: 'n', usage: { input: 10 } }, error: null })),
      body,
    );
    // Read through.
    assert.deepEqual(result, { kind: 'ok', ops: [{ op: 'remove', id: 'b0' }], dropped: 1, note: 'n', usage: { input: 10, cached: null, output: null, thinking: null } });
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

describe('AiEditPanel', () => {
  it('renders the box with Suggest disabled until something is typed', () => {
    // Static render; the seams are never called.
    const html = render(h(panel.AiEditPanel, { diff, onEdit: async () => ({ ok: true }), onAssist: async () => ({ kind: 'error', message: '' }), busy: false, categories: [] }));
    // The heading.
    assert.match(html, /<h3[^>]*class="ai-edit__title"[^>]*>Ask AI to edit this resume<\/h3>/);
    // The button exists and is disabled on an empty instruction.
    assert.match(html, /<button[^>]*disabled=""[^>]*>Suggest edits<\/button>/);
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
