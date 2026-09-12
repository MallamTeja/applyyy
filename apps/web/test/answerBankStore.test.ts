/* Tests for Answer Bank store, typed input formatting, and question lifecycle.
 *
 * Protected invariants:
 * 1. Seed questions are exhaustive across standard ATS screening fields
 *    (notice period, compensation, relocation, work auth, visa, EEO, cover letter).
 * 2. Typed preview formatting correctly formats INR, days, booleans, and long text.
 * 3. Local persistence cache correctly overrides defaults and tracks custom questions.
 * 4. Saving an answer marks `needs_human: false` (Constraint #4: human answer unblocks bot).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  SEED_QUESTIONS,
  formatAnswerPreview,
  readLocalOverrides,
  writeLocalOverrides,
  saveBankAnswer,
  deleteCustomBankQuestion,
} from '../src/features/settings/answerBankStore.ts';
import type { BankQuestion } from '../src/features/settings/answerBankStore.ts';

// Mock localStorage for node test runner
const mockStorage: Record<string, string> = {};
global.localStorage = {
  getItem: (key: string) => mockStorage[key] || null,
  setItem: (key: string, val: string) => {
    mockStorage[key] = val;
  },
  removeItem: (key: string) => {
    delete mockStorage[key];
  },
  clear: () => {
    for (const k of Object.keys(mockStorage)) delete mockStorage[k];
  },
  length: 0,
  key: () => null,
} as Storage;

test('seed questions contain all required screening questions with strict types', () => {
  assert.equal(SEED_QUESTIONS.length, 10, 'Should have 10 standard seed questions');

  const keys = new Set(SEED_QUESTIONS.map((q) => q.key));
  const expectedKeys = [
    'notice_period_days',
    'current_ctc_inr',
    'expected_ctc_inr',
    'willing_to_relocate',
    'work_authorisation_india',
    'visa_sponsorship_required',
    'earliest_start_date',
    'gender',
    'disability_status',
    'cover_letter_generic',
  ];

  for (const exp of expectedKeys) {
    assert.ok(keys.has(exp), `Missing standard question key: ${exp}`);
  }

  // Type assertions
  const notice = SEED_QUESTIONS.find((q) => q.key === 'notice_period_days')!;
  assert.equal(notice.type, 'number');
  assert.equal(notice.defaultValue, 0);

  const relocate = SEED_QUESTIONS.find((q) => q.key === 'willing_to_relocate')!;
  assert.equal(relocate.type, 'boolean');
  assert.equal(relocate.defaultValue, true);

  const visa = SEED_QUESTIONS.find((q) => q.key === 'visa_sponsorship_required')!;
  assert.equal(visa.type, 'boolean');
  assert.equal(visa.defaultValue, false);

  const cover = SEED_QUESTIONS.find((q) => q.key === 'cover_letter_generic')!;
  assert.equal(cover.type, 'long_text');
  assert.ok(String(cover.defaultValue).length > 20);
});

test('formatAnswerPreview formats numbers, CTC in INR, notice periods, and booleans', () => {
  // Booleans
  assert.equal(formatAnswerPreview('boolean', true), 'Yes');
  assert.equal(formatAnswerPreview('boolean', false), 'No');
  assert.equal(formatAnswerPreview('boolean', 'true'), 'Yes');

  // Numbers & CTC
  assert.equal(formatAnswerPreview('number', 0, 'notice_period_days'), '0 days (Immediate)');
  assert.equal(formatAnswerPreview('number', 30, 'notice_period_days'), '30 days');
  assert.equal(formatAnswerPreview('number', 0, 'current_ctc_inr'), '₹ 0 (Fresher / Student)');
  assert.equal(formatAnswerPreview('number', 1200000, 'expected_ctc_inr'), '₹ 12.0 LPA (12,00,000)');

  // Text & Long text
  assert.equal(formatAnswerPreview('text', 'Immediate'), 'Immediate');
  const longText = 'A'.repeat(100);
  assert.ok(formatAnswerPreview('long_text', longText).endsWith('...'));

  // Empty / Not answered
  assert.equal(formatAnswerPreview('text', ''), '— Not answered —');
  assert.equal(formatAnswerPreview('text', null), '— Not answered —');
});

test('localStorage write and read overrides work reliably', () => {
  localStorage.clear();

  writeLocalOverrides({
    notice_period_days: {
      key: 'notice_period_days',
      value: 15,
      needsHuman: false,
    },
  });

  const readBack = readLocalOverrides();
  assert.equal(readBack.notice_period_days?.value, 15);
  assert.equal(readBack.notice_period_days?.needsHuman, false);
});

test('saving an answer resets needs_human to false and updates cache', async () => {
  localStorage.clear();

  const testQuestion: BankQuestion = {
    key: 'custom_cert',
    asks: 'Do you have AWS certification?',
    type: 'boolean',
    category: 'general',
    value: null,
    defaultValue: null,
    why: 'Discovered ATS question',
    needsHuman: true,
    timesUsed: 0,
    lastUsedAt: null,
    isCustom: true,
  };

  const res = await saveBankAnswer(testQuestion, true);
  assert.ok(res.ok);

  const overrides = readLocalOverrides();
  assert.equal(overrides.custom_cert?.value, true);
  assert.equal(overrides.custom_cert?.needsHuman, false);
});

test('deleteCustomBankQuestion removes custom entries from cache', async () => {
  localStorage.clear();

  writeLocalOverrides({
    custom_docker: {
      key: 'custom_docker',
      value: 'Intermediate',
      isCustom: true,
    },
  });

  assert.ok(readLocalOverrides().custom_docker !== undefined);

  const res = await deleteCustomBankQuestion('custom_docker');
  assert.ok(res.ok);
  assert.equal(readLocalOverrides().custom_docker, undefined);
});
