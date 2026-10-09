/* Eligibility answers: the worker answers eligibility questions ONLY from answer_bank rows
 * Teja saved himself (attested_by_human = true). These tests pin the parts of that contract
 * the web owns: the exact keys, the suggestion helpers, the save payload, the read-error
 * block, and the strict reading of the attested flag. No jsdom: store functions only. */

// node:test, like every other web test; no jsdom needed for store functions.
import { test } from 'node:test';
// Strict mode so deepEqual compares types, not just loose equality.
import assert from 'node:assert/strict';
// Type only: the fake client is cast to this once.
import type { SupabaseClient } from '@supabase/supabase-js';

// Everything under test lives in the store, so no React import is needed.
import {
  // The EEO questions with their verbatim option lists.
  EEO_QUESTIONS,
  // The pure "may Save run" decision for an EEO choice.
  isSaveableEeoAnswer,
  ELIGIBILITY_KEYS,
  ELIGIBILITY_QUESTIONS,
  SEED_QUESTIONS,
  attestationState,
  loadAnswerBank,
  saveBankAnswer,
  suggestOpenSourceLinks,
  suggestPrimaryLanguage,
} from '../src/features/settings/answerBankStore.ts';
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
  // Captured payloads, so a test can assert the exact key and needs_human.
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
  // Linear find is fine for a dozen questions.
  const q = items.find((i) => i.key === key);
  // A missing key is itself the bug these tests exist to catch.
  assert.ok(q, `missing ${key}`);
  // Narrowed by the assert above.
  return q;
}

test('eligibility keys are the exact strings the worker matches on', () => {
  // Verbatim list; a rename here silently routes the question to a human.
  assert.deepEqual(ELIGIBILITY_KEYS, [
    // Location.
    'located_in_country',
    // Visa, reused seed.
    'visa_sponsorship_required',
    // Non-compete / agreements.
    'employment_restrictions',
    // GitLab language/framework label, normalised.
    'what_is_your_primary_programming_language_and_or_framework',
    // GitLab open-source links label, normalised.
    'please_share_links_of_any_open_source_projects_you_own_or_have_made_contributions_to',
  ]);
  // Visa is reused from the standard seeds, not duplicated.
  assert.equal(ELIGIBILITY_QUESTIONS.some((q) => q.key === 'visa_sponsorship_required'), false);
  // ...and it does exist there, with the "now or in the future" wording.
  assert.match(SEED_QUESTIONS.find((q) => q.key === 'visa_sponsorship_required')!.asks, /now or in the future/);
  // Unsaved eligibility answers carry no value: suggestions live in defaultValue only.
  for (const q of ELIGIBILITY_QUESTIONS) assert.equal(q.value, null, q.key);
  // Teja's rulings as suggestions.
  assert.equal(ELIGIBILITY_QUESTIONS.find((q) => q.key === 'located_in_country')!.defaultValue, 'India');
  // "None" is the exact value the worker turns into "No".
  assert.equal(ELIGIBILITY_QUESTIONS.find((q) => q.key === 'employment_restrictions')!.defaultValue, 'None');
});

test('suggestPrimaryLanguage takes language/framework skills in document order', () => {
  // Mixed categories; tools and soft skills must be skipped.
  const profile = {
    skills: [
      // Tool: skipped.
      { name: 'Docker', category: 'Tools' },
      // Language: first pick.
      { name: 'TypeScript', category: 'Languages' },
      // Compound category still reads as a framework.
      { name: 'React', category: 'Frameworks & Libraries' },
      // Third pick.
      { name: 'Python', category: 'Programming Languages' },
      // Fourth match: cut by the limit of three.
      { name: 'Express', category: 'Frameworks' },
    ],
  };
  // First three matches, original order, comma-joined.
  assert.equal(suggestPrimaryLanguage(profile), 'TypeScript, React, Python');
});

test('suggestions are empty for a missing or empty profile', () => {
  // No profile at all.
  assert.equal(suggestPrimaryLanguage(null), '');
  // Same for the links helper.
  assert.equal(suggestOpenSourceLinks(null), '');
  // A profile with nothing matching.
  assert.equal(suggestPrimaryLanguage({ skills: [{ name: 'Git', category: 'Tools' }] }), '');
  // A profile whose only link is not on GitHub.
  assert.equal(suggestOpenSourceLinks({ projects: [{ links: [{ url: 'https://example.com' }] }] }), '');
});

test('suggestOpenSourceLinks keeps only github.com hosts, de-duplicated', () => {
  // Live sites, look-alike hosts and a query-string mention must all be dropped.
  const profile = {
    projects: [
      // A live site (dropped) and a repo (kept).
      { links: [{ url: 'https://app.example.com' }, { url: 'https://github.com/teja/applyyy' }] },
      // Scheme-less repo (kept) and a look-alike host (dropped).
      { links: [{ url: 'github.com/teja/1on1' }, { url: 'https://github.com.evil.example/x' }] },
      // Substring-only mention (dropped) and a duplicate (collapsed).
      { links: [{ url: 'https://example.com/?ref=github.com' }, { url: 'https://github.com/teja/applyyy' }] },
    ],
  };
  // Scheme-less link kept as written; duplicate collapsed; order preserved.
  assert.equal(suggestOpenSourceLinks(profile), 'https://github.com/teja/applyyy\ngithub.com/teja/1on1');
});

test('attested flag is read strictly from rows; no row means unsaved', async () => {
  // Three rows: attested, machine-written, and a pre-migration row with no column.
  const { client } = fakeClient({
    data: [
      // Browser write, stamped by the trigger.
      { question_key: 'located_in_country', answer_value: 'India', needs_human: false, attested_by_human: true },
      // Machine write.
      { question_key: 'employment_restrictions', answer_value: 'None', needs_human: false, attested_by_human: false },
      // Column absent, as before the migration lands.
      { question_key: 'visa_sponsorship_required', answer_value: false, needs_human: false },
    ],
    // A clean read.
    error: null,
  });
  // A successful read also clears the store's read-error guard for later tests.
  const items = await loadAnswerBank(client);
  // true -> attested.
  assert.equal(attestationState(byKey(items, 'located_in_country')), 'attested');
  // false -> a row the worker will not use.
  assert.equal(attestationState(byKey(items, 'employment_restrictions')), 'unattested');
  // Missing column reads as false, never as true.
  assert.equal(byKey(items, 'visa_sponsorship_required').attestedByHuman, false);
  // No row -> unsaved, even though the question is in the bank.
  assert.equal(attestationState(byKey(items, 'what_is_your_primary_programming_language_and_or_framework')), 'unsaved');
  // The eligibility seeds load with their own metadata, not as "custom" rows.
  assert.equal(byKey(items, 'located_in_country').isCustom, undefined);
});

test('saving an eligibility answer upserts the exact key with needs_human false', async () => {
  // Empty successful read so the store is not blocked.
  const { client, upserts } = fakeClient({ data: [], error: null });
  // Load first: saves are refused unless the last read succeeded.
  const items = await loadAnswerBank(client);
  // The question as the page would hand it to saveBankAnswer.
  const q = byKey(items, 'employment_restrictions');
  // The user's click path: the store's existing save function.
  const res = await saveBankAnswer(q, 'None', client);
  // Saved.
  assert.equal(res.ok, true);
  // Exactly one write.
  assert.equal(upserts.length, 1);
  // The worker's key, verbatim.
  assert.equal(upserts[0]!.question_key, 'employment_restrictions');
  // Never parked as needing a human.
  assert.equal(upserts[0]!.needs_human, false);
  // The value written is the one passed.
  assert.equal(upserts[0]!.answer_value, 'None');
});

test('a read error still blocks eligibility saves', async () => {
  // A failed read, as in an outage.
  const { client, upserts } = fakeClient({ data: null, error: { message: 'boom' } });
  // loadAnswerBank throws on a failed read; that is the documented contract.
  await assert.rejects(loadAnswerBank(client), /boom/);
  // Each eligibility question must be refused.
  for (const q of ELIGIBILITY_QUESTIONS) {
    // Using the seed object directly, as a page that kept stale state might.
    const res = await saveBankAnswer(q, q.defaultValue, client);
    // Refused.
    assert.equal(res.ok, false, q.key);
  }
  // And nothing reached the database.
  assert.equal(upserts.length, 0);
});

test('EEO keys and option strings are verbatim from Greenhouse', () => {
  // Literal copy of the brief; a typo on either side goes red here, not on a live form.
  assert.deepEqual(
    // Key, label and options only: the rest is shared boilerplate.
    EEO_QUESTIONS.map((q) => ({ key: q.key, asks: q.asks, options: q.options })),
    [
      // Gender.
      { key: 'eeo_gender', asks: 'Gender', options: ['Decline To Self Identify', 'Female', 'Male'] },
      // Hispanic/Latino (list not in the API; flagged in the UI).
      { key: 'eeo_hispanic_latino', asks: 'Are you Hispanic/Latino?', options: ['Yes', 'No', 'Decline To Self Identify'] },
      // Race.
      {
        // Exact key.
        key: 'eeo_race',
        // Exact label.
        asks: 'Race (asked when Hispanic/Latino is No)',
        // Greenhouse's order.
        options: [
          // Verbatim; a single changed character fails this test.
          'American Indian or Alaskan Native',
          // Verbatim; a single changed character fails this test.
          'Asian',
          // Verbatim; a single changed character fails this test.
          'Black or African American',
          // Verbatim; a single changed character fails this test.
          'Hispanic or Latino',
          // Verbatim; a single changed character fails this test.
          'Native Hawaiian or Other Pacific Islander',
          // Verbatim; a single changed character fails this test.
          'White',
          // Verbatim; a single changed character fails this test.
          'Two or More Races',
          // Verbatim; a single changed character fails this test.
          'Decline To Self Identify',
        ],
      },
      // Veteran status.
      {
        // Exact key.
        key: 'eeo_veteran_status',
        // Exact label.
        asks: 'Veteran Status',
        options: [
          // Verbatim; a single changed character fails this test.
          'I am not a protected veteran',
          // Verbatim; a single changed character fails this test.
          'I identify as one or more of the classifications of a protected veteran',
          // Verbatim; a single changed character fails this test.
          "I don't wish to answer",
        ],
      },
    ],
  );
  // Every EEO question is single_select, unanswered, with no default to pre-select.
  for (const q of EEO_QUESTIONS) {
    // The AnswerType the upsert carries.
    assert.equal(q.type, 'single_select', q.key);
    // Unanswered until Teja saves.
    assert.equal(q.value, null, q.key);
    // No default: "Decline" is never pre-selected.
    assert.equal(q.defaultValue, null, q.key);
  }
});

test('"Not answered" and off-list strings cannot be saved', () => {
  // Gender is enough to exercise the rule; it is one function for all four.
  const gender = EEO_QUESTIONS.find((q) => q.key === 'eeo_gender')!;
  // The "Not answered (left blank)" choice's value.
  assert.equal(isSaveableEeoAnswer(gender, ''), false);
  // null / undefined: nothing chosen.
  assert.equal(isSaveableEeoAnswer(gender, null), false);
  // Near-miss casing: the form would refuse it, so Save must too.
  assert.equal(isSaveableEeoAnswer(gender, 'Decline to self-identify'), false);
  // An exact option is saveable.
  assert.equal(isSaveableEeoAnswer(gender, 'Female'), true);
});

test('saving eeo_gender upserts the exact key, text and single_select', async () => {
  // Clean empty read so the store is not blocked.
  const { client, upserts } = fakeClient({ data: [], error: null });
  // Load first: saves need a successful last read.
  const items = await loadAnswerBank(client);
  // The loaded copy, as the UI passes it.
  const q = byKey(items, 'eeo_gender');
  // Teja's click.
  const res = await saveBankAnswer(q, 'Female', client);
  // Saved.
  assert.equal(res.ok, true);
  // One write.
  assert.equal(upserts.length, 1);
  // Exact key.
  assert.equal(upserts[0]!.question_key, 'eeo_gender');
  // Exact chosen text, typed verbatim by the worker later.
  assert.equal(upserts[0]!.answer_value, 'Female');
  // The answer type.
  assert.equal(upserts[0]!.answer_type, 'single_select');
  // Never parked for a human.
  assert.equal(upserts[0]!.needs_human, false);
});

test('a read error blocks EEO saves too', async () => {
  // A failed read.
  const { client, upserts } = fakeClient({ data: null, error: { message: 'boom' } });
  // The documented contract: a failed read throws.
  await assert.rejects(loadAnswerBank(client), /boom/);
  // Each EEO question, with a valid option, is still refused.
  for (const q of EEO_QUESTIONS) {
    // A real option, so only the read-error guard can refuse it.
    const res = await saveBankAnswer(q, q.options[0], client);
    // Refused.
    assert.equal(res.ok, false, q.key);
  }
  // Nothing reached the database.
  assert.equal(upserts.length, 0);
});
