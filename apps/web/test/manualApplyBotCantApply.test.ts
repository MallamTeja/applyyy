/* Manual apply is the home of every approved row the bot cannot submit (Teja, 2026-11-07 22:55 IST).
 * Pins three things:
 *   1. the card's "Bot can't apply: <reason>" line, from the row and the kit only, with "—" when
 *      nothing recorded a reason (never a guess, CLAUDE.md §6);
 *   2. the open questions it lists, and which of them get an input: only those a saved answer can
 *      clear (the REAL planner decides); a never-fill label or a checkbox gets the "answer it on the
 *      form" line instead (orchestrator ruling 2026-11-07 23:31);
 *   3. the round trip: an answer saved under the card's key is the one the worker's planFill uses
 *      for that label, accents and punctuation included. */

// The .tsx loader; must be the first import so it runs before any component loads.
import './support/registerTsxHooks.ts';
import assert from 'node:assert/strict';
import { describe, it, before } from 'node:test';

// The pure module under test.
let mod: typeof import('../src/features/manual-apply/botCantApply.ts');
// The page module, for KitCard.
let page: typeof import('../src/features/manual-apply/ManualApplyPage.tsx');
// The worker's own planner: the consumer the saved key must satisfy.
let planner: typeof import('../../../worker/src/plan-fill.ts');
// Static markup, no DOM.
let render: (element: unknown) => string;
// Element factory, so this .ts file needs no JSX.
let h: typeof import('react').createElement;
// A router for the card's in-app links.
let MemoryRouter: typeof import('react-router-dom').MemoryRouter;

before(async () => {
  // Plain .ts.
  mod = await import('../src/features/manual-apply/botCantApply.ts');
  // Transpiled by the hook.
  page = await import('../src/features/manual-apply/ManualApplyPage.tsx');
  // Relative import, exactly as the web module does it.
  planner = await import('../../../worker/src/plan-fill.ts');
  // From the installed react-dom.
  render = (await import('react-dom/server')).renderToStaticMarkup as (element: unknown) => string;
  // React's factory.
  h = (await import('react')).createElement;
  // The router the app already uses.
  MemoryRouter = (await import('react-router-dom')).MemoryRouter;
});

// One kit field as applyKit.ts parses it; `over` changes it per case.
const field = (label: string, over: Record<string, unknown> = {}) => ({ label, value: null, source: 'unanswered', required: true, inputType: 'text', options: [], ...over });

// A parsed kit state holding `fields`.
const kitOf = (fields: readonly unknown[]) => ({
  kind: 'kit',
  kit: { generatedAt: '2026-11-07T17:18:00Z', runId: null, formUrl: 'https://job-boards.greenhouse.io/canonical/jobs/1', resume: null, fields, warnings: [] },
});

// The Canonical row shape the page builds; `over` per case.
const row = (over: Record<string, unknown> = {}) => ({
  id: '8e9d58ce-0000-4000-8000-000000000001',
  status: 'approved',
  label: 'Software Engineer at Canonical',
  applyUrl: 'https://job-boards.greenhouse.io/canonical/jobs/1',
  stamp: '2026-11-07T17:18:00.000000+00:00',
  approvedAt: null,
  resume: null,
  jobTitle: 'Software Engineer',
  company: 'Canonical',
  blockReason: null,
  atsProvider: 'greenhouse',
  ...over,
});

describe('botCantApplyReasons', () => {
  // The Workday guard's signal, read before the worker ever claims the row.
  it('names Workday from the host, before the worker parks the row', () => {
    // Approved, not yet claimed: the URL alone says it.
    const reasons = mod.botCantApplyReasons(row({ applyUrl: 'https://acme.wd5.myworkdayjobs.com/x/job/1', atsProvider: 'unknown' }) as never, { kind: 'none' } as never);
    // One reason, the Workday one.
    assert.deepEqual(reasons, ['Workday needs a candidate account']);
  });

  // Parked by the guard: login_required is folded into the Workday line, not said twice.
  it('says Workday once when the parked row also carries login_required', () => {
    // As apply-one parks it.
    const reasons = mod.botCantApplyReasons(row({ status: 'blocked_needs_human', blockReason: 'login_required', atsProvider: 'workday' }) as never, { kind: 'none' } as never);
    // Not "Workday ... ; the site asks for a candidate account".
    assert.deepEqual(reasons, ['Workday needs a candidate account']);
  });

  // The kit worker's robots skip and the applier's robots park say one thing.
  it('names a robots refusal once, from the kit skip or the park', () => {
    // Both signals at once.
    const reasons = mod.botCantApplyReasons(row({ status: 'blocked_needs_human', blockReason: 'robots_refused' }) as never, { kind: 'skipped', code: 'robots_refused', reason: '' } as never);
    // Deduplicated.
    assert.deepEqual(reasons, ["the site's robots.txt refuses bots"]);
  });

  // The count comes from the kit's fields, never from parsing the warning strings.
  it('counts the required unanswered questions, leaving out the resume upload', () => {
    // Two open questions, one open file field (the resume, not a question), one answered.
    const kit = kitOf([field('Gender'), field('Essay', { inputType: 'textarea' }), field('Resume/CV', { inputType: 'file' }), field('Email', { value: 'x@y.z', source: 'identity' })]);
    // The plural line.
    assert.deepEqual(mod.botCantApplyReasons(row() as never, kit as never), ['2 questions need you']);
  });

  // A block_reason is only read while the row is parked: elsewhere the column may be stale.
  it('ignores block_reason on a row that is not parked', () => {
    // Approved, with a leftover reason and nothing else.
    assert.deepEqual(mod.botCantApplyReasons(row({ blockReason: 'captcha' }) as never, { kind: 'none' } as never), []);
  });

  // Nothing recorded: the page shows "—", so the function returns no reasons at all.
  it('returns no reasons rather than a guess', () => {
    // A plain Greenhouse row with a clean kit.
    assert.deepEqual(mod.botCantApplyReasons(row() as never, kitOf([field('Email', { value: 'x@y.z', source: 'identity' })]) as never), []);
  });
});

describe('openQuestions', () => {
  // A plain fact a saved answer clears: answerable, keyed exactly as the planner keys it.
  it('keys a question with the planner questionKey and marks a fact answerable', () => {
    // The Canonical "grading system" question.
    const [q] = mod.openQuestions(kitOf([field('What grading system does your degree use?')]) as never);
    // The planner's own key.
    assert.equal(q?.key, planner.questionKey('What grading system does your degree use?'));
    // A saved answer would fill it.
    assert.equal(q?.answerable, true);
  });

  // The orchestrator's ruling: no input for what the bot never fills.
  it('marks a consent question and a checkbox not answerable', () => {
    // Consent is on the planner's never list; a checkbox is never ticked by the bot.
    const qs = mod.openQuestions(kitOf([field('Do you consent to our privacy notice?', { inputType: 'select', options: ['Yes', 'No'] }), field('I confirm these are my own words', { inputType: 'checkbox' })]) as never);
    // Both refused.
    assert.deepEqual(qs.map((q) => q.answerable), [false, false]);
  });

  // The select input when the form's options are known.
  it('offers the form options as a select', () => {
    // A select with options.
    const [q] = mod.openQuestions(kitOf([field('Highest level of education completed', { inputType: 'select', options: ['Bachelor', 'Master'] })]) as never);
    // The select shape and its save type.
    assert.deepEqual([q?.input, q?.answerType, q?.options], ['select', 'single_select', ['Bachelor', 'Master']]);
  });

  // A kit that is not a kit has no questions.
  it('is empty for a skipped or missing kit', () => {
    // No kit.
    assert.deepEqual(mod.openQuestions({ kind: 'none' } as never), []);
  });
});

describe('the saved answer reaches the planner (goal 3)', () => {
  // The exact row the browser save leaves (the trigger stamps it attested), against the worker planner.
  it('fills the label from an answer saved under the card key, accents included', () => {
    // An accented label, so a key without folding would miss.
    const label = 'Système de notation du diplôme';
    // The card's question.
    const [q] = mod.openQuestions(kitOf([field(label)]) as never);
    // What saveBankAnswer upserts for it, after the attestation trigger.
    const saved = { ...mod.openQuestionToBankQuestion(q!), value: 'CGPA out of 10' };
    // The bank row shape planFill reads.
    const bankRow = { question_key: saved.key, answer_value: saved.value, needs_human: false, attested_by_human: true };
    // The worker's planner on the same form field.
    const plan = planner.planFill([{ id: 'f1', label, kind: 'text', required: true }], [bankRow as never], null, null);
    // Filled from the bank with exactly the saved text, and nothing blocks.
    assert.deepEqual([plan.blockers.length, plan.fills[0]?.value, plan.fills[0]?.source], [0, 'CGPA out of 10', 'answer_bank']);
  });
});

describe('KitCard', () => {
  // The rendered card under a router.
  const card = (r: unknown, kit: unknown, answers?: unknown) => render(h(MemoryRouter, null, h(page.KitCard, { row: r, kit, resolve: { locked: false, frozen: false, onMove: () => undefined }, answers } as never)));

  // The reason line on every card, with "—" when nothing is known.
  it('says "Bot can\'t apply: —" when no reason is recorded', () => {
    // A clean row, no kit.
    assert.match(card(row(), { kind: 'none' }), /Bot can(&#x27;|')t apply:<\/strong> —/);
  });

  // The reasons joined into one line.
  it('joins the reasons in one line', () => {
    // Workday by provider plus one open question.
    const html = card(row({ atsProvider: 'workday' }), kitOf([field('Gender')]));
    // Both, in order.
    assert.match(html, /Bot can(&#x27;|')t apply:<\/strong> Workday needs a candidate account; 1 question needs you/);
  });

  // An answerable question gets an input and a Save; a never-fill one gets the form line, no input.
  it('renders an input for an answerable question and the form line for a never-fill one', () => {
    // One of each, with a loaded (empty) bank.
    const html = card(row(), kitOf([field('What grading system does your degree use?'), field('Do you consent to our privacy notice?')]), { bank: [], error: null, onSaved: () => undefined });
    // Exactly one text input, labelled by its question.
    assert.equal((html.match(/<input/g) ?? []).length, 1);
    // The Save for it.
    assert.match(html, />Save answer</);
    // The ruling's line for the consent question.
    assert.match(html, /The bot never fills this one; answer it on the form\./);
  });

  // Already in the bank: no input, the next kit fills it.
  it('shows a banked question as answered, with no input', () => {
    // The key the card will look up.
    const key = planner.questionKey('What grading system does your degree use?');
    // The attested bank entry for it.
    const bank = [{ key, asks: 'x', type: 'text', category: 'general', value: 'CGPA', defaultValue: null, why: '', needsHuman: false, timesUsed: 0, lastUsedAt: null, isCustom: true, attestedByHuman: true }];
    // Rendered.
    const html = card(row(), kitOf([field('What grading system does your degree use?')]), { bank, error: null, onSaved: () => undefined });
    // No input, and the answered line.
    assert.deepEqual([(html.match(/<input/g) ?? []).length, /In your answer bank/.test(html)], [0, true]);
  });

  // A failed bank read: no Save may be offered (saveBankAnswer would refuse it anyway).
  it('offers no Save when the answer bank failed to load', () => {
    // The read error.
    const html = card(row(), kitOf([field('What grading system does your degree use?')]), { bank: null, error: 'network down', onSaved: () => undefined });
    // No Save, and the reason.
    assert.deepEqual([/>Save answer</.test(html), /network down/.test(html)], [false, true]);
  });
});
