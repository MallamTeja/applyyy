/* Answer bank view rules: what a field shows, what may be saved, what "Save all answers"
 * writes, and which keys the main table hides. Pure functions over loaded BankQuestions,
 * so no jsdom: the store is driven through a fake client, exactly as the page drives it. */

// node:test, like every other web test.
import { test } from 'node:test';
// Strict mode so deepEqual compares types, not loose equality.
import assert from 'node:assert/strict';
// Type only: the fake client is cast to this once.
import type { SupabaseClient } from '@supabase/supabase-js';

// The module under test.
import {
  // Hides legacy and EEO keys from the main table.
  isTableHiddenKey,
  // The draft/saved/suggestion choice a field renders.
  shownValue,
  // The shared "is this a real answer" rule.
  isSaveableValue,
  // What Save all would write.
  planSaveAll,
  // Runs the planned writes one by one.
  saveAllPlanned,
} from '../src/features/settings/answerBankView.ts';
// The real store: rows load through it and every write goes through its one save path.
import { SEED_QUESTIONS, loadAnswerBank, saveBankAnswer } from '../src/features/settings/answerBankStore.ts';
// For the byKey helper's return type.
import type { BankQuestion } from '../src/features/settings/answerBankStore.ts';

// The store caches in localStorage; Node has none, so a Map-backed stand-in.
const mem: Record<string, string> = {};
// Only the members the store touches need to behave.
globalThis.localStorage = {
  // Missing keys read as null, as the real Storage does.
  getItem: (k: string) => mem[k] ?? null,
  // Writes land in the map so a save's local cache path runs.
  setItem: (k: string, v: string) => {
    mem[k] = v;
  },
  // Present for completeness of the Storage shape.
  removeItem: (k: string) => {
    delete mem[k];
  },
  // Present for completeness of the Storage shape.
  clear: () => {
    for (const k of Object.keys(mem)) delete mem[k];
  },
  // Unused by the store; stubbed to satisfy the type.
  length: 0,
  // Unused by the store; stubbed to satisfy the type.
  key: () => null,
} as Storage;

// A fake client: reads answer `read`, every upsert payload is captured.
function fakeClient(read: { data: unknown; error: { message: string } | null }) {
  // Captured payloads, so a test can assert which keys Save all wrote.
  const upserts: Array<Record<string, unknown>> = [];
  // Shape mirrors supabase-js: errors are returned, never thrown.
  const client = {
    from: () => ({
      // loadAnswerBank calls select('*').order(...).
      select: () => ({ order: async () => read }),
      // saveBankAnswer calls upsert(payload, opts).
      upsert: async (payload: Record<string, unknown>) => {
        // Captured for the assertions.
        upserts.push(payload);
        // Success, in supabase-js's returned-error shape.
        return { error: null };
      },
    }),
    // saveBankAnswer asks who is signed in.
    auth: { getUser: async () => ({ data: { user: { id: 'u1' } } }) },
  };
  // One cast: the fake implements only what the store calls.
  return { client: client as unknown as SupabaseClient, upserts };
}

// Finds a question by key in a loaded bank, failing loudly when absent.
function byKey(items: readonly BankQuestion[], key: string): BankQuestion {
  // Linear find is fine for a few dozen questions.
  const q = items.find((i) => i.key === key);
  // A missing key is itself a bug worth a loud failure.
  assert.ok(q, `missing ${key}`);
  // Narrowed by the assert above.
  return q;
}

// The visa key, spelled once so every test names the same question.
const VISA = 'visa_sponsorship_required';

test('visa yes/no shows no selection before a save or a pick', async () => {
  // The seed copy: no remote row, so attestation is 'unsaved'.
  const seed = SEED_QUESTIONS.find((q) => q.key === VISA)!;
  // Guard the premise: the seed is a boolean question.
  assert.equal(seed.type, 'boolean');
  // Unsaved, no draft, suggestion false: neither button may look selected.
  assert.equal(shownValue(seed, {}, false), undefined);
  // Teja picked "No" this session: the draft wins, even though it is falsy.
  assert.equal(shownValue(seed, { [VISA]: false }, undefined), false);
  // A loaded attested row with value false shows false.
  const attested = byKey(
    // Loaded through the store so attestedByHuman is set the way the page sees it.
    await loadAnswerBank(
      fakeClient({ data: [{ question_key: VISA, answer_value: false, needs_human: false, attested_by_human: true }], error: null }).client,
    ),
    // The visa row.
    VISA,
  );
  // Saved value shown as-is.
  assert.equal(shownValue(attested, {}, undefined), false);
  // An unattested (machine-written) row is still a saved value and is shown.
  const unattested = byKey(
    // Same load path, attested_by_human false this time.
    await loadAnswerBank(
      fakeClient({ data: [{ question_key: VISA, answer_value: false, needs_human: false, attested_by_human: false }], error: null }).client,
    ),
    // The visa row.
    VISA,
  );
  // Saved value shown as-is, not hidden for being unattested.
  assert.equal(shownValue(unattested, {}, undefined), false);
  // An unpicked yes/no can never be saved.
  assert.equal(isSaveableValue(seed, undefined), false);
});

test('legacy gender and disability_status are hidden from the main table', () => {
  // Legacy seeds the worker never reads.
  for (const k of ['gender', 'disability_status']) assert.equal(isTableHiddenKey(k), true, k);
  // The four EEO keys are edited only in the Eligibility section.
  for (const k of ['eeo_gender', 'eeo_hispanic_latino', 'eeo_race', 'eeo_veteran_status']) {
    // Each one hidden.
    assert.equal(isTableHiddenKey(k), true, k);
  }
  // Ordinary keys stay visible.
  for (const k of ['notice_period_days', 'located_in_country']) assert.equal(isTableHiddenKey(k), false, k);
});

test("Save all writes only changed fields; an unchanged field isn't upserted", async () => {
  // Three saved rows: attested, machine-written, attested EEO.
  const { client, upserts } = fakeClient({
    data: [
      // Teja's own answer.
      { question_key: 'located_in_country', answer_value: 'India', needs_human: false, attested_by_human: true },
      // Machine-written, so re-saving it is what makes it Teja's.
      { question_key: 'employment_restrictions', answer_value: 'None', needs_human: false, attested_by_human: false },
      // Teja's own EEO answer.
      { question_key: 'eeo_gender', answer_value: 'Male', needs_human: false, attested_by_human: true },
    ],
    // A clean read.
    error: null,
  });
  // Load first: saves are refused unless the last read succeeded.
  const items = await loadAnswerBank(client);
  // The fields as the section hands them to the planner.
  const entries = [
    // Unchanged attested; trailing space trims to equal, so skipped.
    { question: byKey(items, 'located_in_country'), value: 'India ' },
    // Unchanged but unattested: included.
    { question: byKey(items, 'employment_restrictions'), value: 'None' },
    // Changed from Male: included.
    { question: byKey(items, 'eeo_gender'), value: 'Female' },
    // "Not answered": skipped.
    { question: byKey(items, 'eeo_race'), value: '' },
    // Unpicked yes/no: skipped.
    { question: byKey(items, VISA), value: undefined },
    // Blank text: skipped.
    { question: byKey(items, 'what_is_your_primary_programming_language_and_or_framework'), value: '  ' },
  ];
  // Through the real single save path, as production does.
  const results = await saveAllPlanned(planSaveAll(entries), (q, v) => saveBankAnswer(q, v, client));
  // Exactly the two real changes reached the DB, in section order.
  assert.deepEqual(
    // Keys of the captured payloads.
    upserts.map((p) => p.question_key),
    // The expected writes.
    ['employment_restrictions', 'eeo_gender'],
  );
  // The browser never claims attestation or an agent identity; the trigger decides.
  for (const p of upserts) {
    // No attestation flag in the body.
    assert.equal('attested_by_human' in p, false);
    // No agent key of any spelling.
    assert.equal(Object.keys(p).some((k) => k.includes('agent')), false);
  }
  // Per-field results carry the key and outcome.
  assert.deepEqual(
    // Key and ok only; asks is display text.
    results.map((r) => ({ key: r.key, ok: r.ok })),
    // Both writes succeeded.
    [
      // First write.
      { key: 'employment_restrictions', ok: true },
      // Second write.
      { key: 'eeo_gender', ok: true },
    ],
  );
});

test('saveAllPlanned turns a throwing save into a failed result and keeps going', async () => {
  // A clean empty read, so the bank loads.
  const { client } = fakeClient({ data: [], error: null });
  // Load to get real question objects.
  const items = await loadAnswerBank(client);
  // Two planned writes; the first will throw.
  const planned = [
    // Will throw.
    { question: byKey(items, 'located_in_country'), value: 'India' },
    // Must still run.
    { question: byKey(items, 'employment_restrictions'), value: 'None' },
  ];
  // Keys the fake save was called with, to prove the second ran.
  const called: string[] = [];
  // A save that throws on the first key only.
  const results = await saveAllPlanned(planned, async (q) => {
    // Record every call.
    called.push(q.key);
    // An unforeseen throw, unlike the store's returned errors.
    if (q.key === 'located_in_country') throw new Error('kaboom');
    // The second succeeds.
    return { ok: true };
  });
  // Both ran, in order.
  assert.deepEqual(called, ['located_in_country', 'employment_restrictions']);
  // The throw became a failed result carrying the message.
  assert.equal(results[0]!.ok, false);
  // The message survives for the toast.
  assert.match(results[0]!.error ?? '', /kaboom/);
  // The next field's success is still reported.
  assert.deepEqual({ key: results[1]!.key, ok: results[1]!.ok }, { key: 'employment_restrictions', ok: true });
});

test('Save all includes an untouched suggestion and an unattested yes/no row', async () => {
  // Pins the reviewed decision: Save all is a human click on the values on screen, so an
  // unsaved field showing a suggestion IS written, and a machine-written row is re-saved
  // (that re-save is what makes the trigger stamp it as Teja's). Changing either is a ruling.
  const { client } = fakeClient({
    // One unattested boolean row; located_in_country has no row at all.
    data: [{ question_key: VISA, answer_value: false, needs_human: false, attested_by_human: false }],
    // A clean read so saves are allowed.
    error: null,
  });
  // Loaded through the store, as the page does.
  const items = await loadAnswerBank(client);
  // No draft: the suggestion 'India' is what the input shows.
  const located = byKey(items, 'located_in_country');
  // The unattested visa row shows its saved false.
  const visa = byKey(items, VISA);
  // Both are planned, with their shown values.
  assert.deepEqual(
    // Key and value only, in screen order.
    planSaveAll([
      // Shown value built by the same rule the page uses.
      { question: located, value: shownValue(located, {}, 'India') },
      // Same for the visa row.
      { question: visa, value: shownValue(visa, {}, false) },
    ]).map((p) => [p.question.key, p.value]),
    // Both written; the boolean stays a boolean.
    [['located_in_country', 'India'], [VISA, false]],
  );
});
