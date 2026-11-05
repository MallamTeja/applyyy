/* Unanswered questions (Answer bank page, 2026-11-05): which cards show, in which group, with
 * which input. Pure functions over rows, so no DOM. The planner calls are the REAL worker
 * planFill, so a test here going red means the page and the worker disagree.
 *
 * The bugs guarded:
 *   1. A Save offered for a question the worker will never read from the bank (EEO/eligibility
 *      template misses, checkboxes, consent): Teja answers, nothing unblocks. Must be 'rule'.
 *   2. A card for a question already answered (attested), or one blocking only closed
 *      applications: noise that hides the real work.
 *   3. An UNATTESTED bank row treated as answered: the worker refuses it, so the card must stay.
 *   4. A failed read rendered as "no unanswered questions".
 */

// node:test, like every other web test.
import { test } from 'node:test';
// Strict comparisons.
import assert from 'node:assert/strict';
// Type only: the fake client is cast to this once.
import type { SupabaseClient } from '@supabase/supabase-js';
// The row shape the migration defines.
import type { UnansweredQuestionRow } from '@applyy/shared-types';

// The module under test.
import { buildCards, groupFor, inputFor, loadUnanswered, savedAnswerWouldClear } from '../src/features/settings/unansweredQuestionsView.ts';
// Type only: bank questions as the store loads them.
import type { BankQuestion } from '../src/features/settings/answerBankStore.ts';

// A table row with defaults; each test overrides what it is about.
function row(over: Partial<UnansweredQuestionRow> & Pick<UnansweredQuestionRow, 'question_key' | 'question_text'>): UnansweredQuestionRow {
  return {
    // Fixed owner; RLS is not under test here.
    user_id: 'u',
    // A plain text no_answer question unless overridden.
    reason: 'no_answer',
    field_kind: 'text',
    options: null,
    blocked_application_ids: ['a1'],
    last_seen_at: '2026-11-05T10:00:00Z',
    ...over,
  };
}

// A bank question with defaults.
function bankQ(key: string, over: Partial<BankQuestion> = {}): BankQuestion {
  return {
    key,
    asks: key,
    type: 'text',
    category: 'general',
    value: 'answer',
    defaultValue: null,
    why: '',
    needsHuman: false,
    timesUsed: 0,
    lastUsedAt: null,
    attestedByHuman: true,
    ...over,
  };
}

// One open application at a known company.
const OPEN = [{ id: 'a1', status: 'approved', company: 'Enterpret' }];

// Bug 1, the positive side: a plain fact IS cleared by a saved answer.
test('a plain fact question is answerable here', () => {
  // As the sweep saw it on a real form.
  const r = row({ question_key: 'university', question_text: 'University' });
  // The planner reads the bank row under this key.
  assert.equal(savedAnswerWouldClear(r), true);
  // Reusable fact.
  assert.equal(groupFor(r), 'fact');
});

// EEO and eligibility wordings are NOT pinned here on purpose. Teja ruled 2026-11-05 23:19 IST
// that an attested answer on the EXACT label may answer them; bf implements that in plan-fill
// (H1). This page asks the real planner, so those cards turn answerable the moment H1 lands, with
// no change here. Only the checkbox and consent cases below stay planner-rule cards either way.

// Bug 1: checkboxes are refused by the planner whatever the bank holds.
test('a checkbox is a planner-rule card', () => {
  // Stripe's internship-window ticks.
  const r = row({ question_key: 'may_to_july_10_weeks', question_text: 'May to July (10 weeks)', reason: 'human_only', field_kind: 'checkbox' });
  // Never fillable today.
  assert.equal(groupFor(r), 'rule');
});

// Bug 1: consent is never automatic.
test('a consent question is a planner-rule card', () => {
  // A text-shaped consent question, so only the NEVER rule (not the checkbox rule) can catch it.
  const r = row({ question_key: 'do_you_consent_to_data_processing', question_text: 'Do you consent to data processing?', reason: 'human_only' });
  // NEVER_FRAGMENTS refuses it before any bank lookup.
  assert.equal(groupFor(r), 'rule');
});

// The 'attest' group: human_only questions an attested answer DOES clear (opinions, acknowledgements).
test('an in-person acknowledgement is answerable and grouped as attest', () => {
  // Shortened Canonical wording; "in_person" is an OPINION fragment.
  const r = row({ question_key: 'we_require_all_colleagues_to_meet_in_person', question_text: 'We require all colleagues to meet in person', reason: 'human_only' });
  // Answered only from Teja's attested row: which this page writes.
  assert.equal(groupFor(r), 'attest');
});

// Essays collapse per company.
test('a textarea question is an essay', () => {
  // Runway's essay.
  const r = row({ question_key: 'what_would_you_build_with_runway', question_text: 'What would you build with Runway?', field_kind: 'textarea' });
  // Long text, per company.
  assert.equal(groupFor(r), 'essay');
  // And it renders a textarea saving long_text.
  assert.deepEqual(inputFor(r), { input: 'textarea', answerType: 'long_text' });
});

// Options known: a select; unknown (react-select, T3): text.
test('inputFor: select only when the options are known', () => {
  // A native select with captured options.
  assert.deepEqual(inputFor({ field_kind: 'native_select', options: ['Yes', 'No'] }), { input: 'select', answerType: 'single_select' });
  // A combobox whose options were never captured.
  assert.deepEqual(inputFor({ field_kind: 'combobox', options: null }), { input: 'text', answerType: 'text' });
});

// Bug 2 and 3: answered keys hide, unattested ones do not.
test('buildCards hides an attested answer but keeps an unattested or placeholder one', () => {
  // Three questions, one per bank state.
  const rows = [
    row({ question_key: 'university', question_text: 'University' }),
    row({ question_key: 'gpa', question_text: 'GPA' }),
    row({ question_key: 'degree', question_text: 'Degree' }),
  ];
  // Attested (hidden), machine-written (kept), placeholder (kept).
  const bank = [bankQ('university'), bankQ('gpa', { attestedByHuman: false }), bankQ('degree', { needsHuman: true })];
  // Only the two the worker would still refuse.
  assert.deepEqual(buildCards(rows, OPEN, bank).map((c) => c.key).sort(), ['degree', 'gpa']);
});

// Bug 2: counts only open applications; closed and unknown ids drop out.
test('buildCards counts only still-open applications and drops a card that blocks none', () => {
  // One question on three applications: open, applied, and an id RLS did not return.
  const rows = [
    row({ question_key: 'university', question_text: 'University', blocked_application_ids: ['a1', 'a2', 'gone'] }),
    row({ question_key: 'gpa', question_text: 'GPA', blocked_application_ids: ['a2'] }),
  ];
  // a1 open, a2 already applied.
  const apps = [...OPEN, { id: 'a2', status: 'applied', company: 'UiPath' }];
  // Only the open one counts, and gpa (closed only) has no card.
  const cards = buildCards(rows, apps, []);
  assert.deepEqual(cards.map((c) => [c.key, c.blocks.map((b) => b.company)]), [['university', ['Enterpret']]]);
});

// The most-blocking question comes first.
test('buildCards sorts by applications blocked', () => {
  // gpa blocks two, university one.
  const rows = [
    row({ question_key: 'university', question_text: 'University' }),
    row({ question_key: 'gpa', question_text: 'GPA', blocked_application_ids: ['a1', 'a3'] }),
  ];
  // Both open.
  const apps = [...OPEN, { id: 'a3', status: 'awaiting_approval', company: 'Quora' }];
  // gpa first.
  assert.deepEqual(buildCards(rows, apps, []).map((c) => c.key), ['gpa', 'university']);
});

// Bug 4: a failed read is an error, never "nothing unanswered".
test('loadUnanswered reports a failed read as an error', async () => {
  // A client whose table read returns a supabase-js { error } (it does not throw).
  const client = {
    from: () => ({ select: () => Promise.resolve({ data: null, error: { message: 'permission denied' } }) }),
  } as unknown as SupabaseClient;
  // The honest failure, carrying the message.
  assert.deepEqual(await loadUnanswered(client), { kind: 'error', message: 'permission denied' });
});

// The happy path flattens the job join.
test('loadUnanswered joins each application to its company', async () => {
  // Table read, then the applications read.
  const client = {
    from: (table: string) =>
      table === 'unanswered_questions'
        ? { select: () => Promise.resolve({ data: [row({ question_key: 'gpa', question_text: 'GPA' })], error: null }) }
        : { select: () => ({ in: () => Promise.resolve({ data: [{ id: 'a1', status: 'approved', jobs: { company_name: 'Enterpret' } }], error: null }) }) },
  } as unknown as SupabaseClient;
  // Loaded.
  const res = await loadUnanswered(client);
  // The application with its company.
  assert.equal(res.kind, 'ok');
  assert.deepEqual(res.kind === 'ok' ? res.applications : null, [{ id: 'a1', status: 'approved', company: 'Enterpret' }]);
});
