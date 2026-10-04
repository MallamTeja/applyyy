/* A failed remote read must BLOCK saving, not fall back to defaults.
 *
 * Protected invariant (2026-10-04): after an outage, filtersStore and answerBankStore
 * used to return seed values as if they were the user's, and the next Save wrote those
 * seeds over the real remote rows. Now a failed read returns nothing (filters) or throws
 * (answer bank), and every write refuses until a read succeeds. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SupabaseClient } from '@supabase/supabase-js';

import {
  DEFAULT_FILTER_RULES,
  getFilterRulesReadError,
  loadFilterRules,
  saveFilterRules,
} from '../src/features/settings/filtersStore.ts';
import {
  SEED_QUESTIONS,
  getAnswerBankReadError,
  loadAnswerBank,
  saveBankAnswer,
} from '../src/features/settings/answerBankStore.ts';

// Both stores touch localStorage; Node has none.
const mem: Record<string, string> = {};
// Minimal Storage so the cache paths run instead of throwing.
globalThis.localStorage = {
  getItem: (k: string) => mem[k] ?? null,
  setItem: (k: string, v: string) => {
    mem[k] = v;
  },
  removeItem: (k: string) => {
    delete mem[k];
  },
  clear: () => {
    for (const k of Object.keys(mem)) delete mem[k];
  },
  length: 0,
  key: () => null,
} as Storage;

// A fake client whose reads answer `read` and which counts every write attempt.
function fakeClient(read: { data: unknown; error: { message: string } | null }) {
  // Write attempts; the assertion that matters is that this stays 0 when blocked.
  const writes = { count: 0 };
  // Every query chain ends in .order(...) for both stores' reads.
  const client = {
    from: () => ({
      // Read path: select(...).order(...) resolves to the canned answer.
      select: () => ({ order: async () => read }),
      // Write path: counted, then succeeds.
      upsert: async () => {
        writes.count += 1;
        return { error: null };
      },
    }),
    // saveX asks who is signed in before writing.
    auth: { getUser: async () => ({ data: { user: { id: 'u1' } } }) },
  };
  // Cast once here: the fake implements only what the stores call.
  return { client: client as unknown as SupabaseClient, writes };
}

test('filters: a read error returns no rules and blocks save without writing', async () => {
  // A refused read, as during an outage or an RLS failure.
  const { client, writes } = fakeClient({ data: null, error: { message: 'boom' } });
  // Load through the failing client.
  const rules = await loadFilterRules(client);
  // NOT the seed defaults — the old behaviour returned all of them here.
  assert.equal(rules.length, 0);
  // The failure is recorded for the page to show.
  assert.equal(getFilterRulesReadError(), 'boom');
  // Saving the (seed) rules must refuse...
  const res = await saveFilterRules(DEFAULT_FILTER_RULES, client);
  // ...with ok:false...
  assert.equal(res.ok, false);
  // ...and must not have attempted a single remote write.
  assert.equal(writes.count, 0);
});

test('filters: a successful read with zero rows applies defaults and allows save', async () => {
  // Empty but successful: the only case defaults are for.
  const { client, writes } = fakeClient({ data: [], error: null });
  // Load clears the earlier failure.
  const rules = await loadFilterRules(client);
  // Every default rule present.
  assert.equal(rules.length, DEFAULT_FILTER_RULES.length);
  // No error recorded.
  assert.equal(getFilterRulesReadError(), null);
  // Save goes through.
  const res = await saveFilterRules(rules, client);
  // ok, and one upsert per rule.
  assert.equal(res.ok, true);
  assert.equal(writes.count, rules.length);
});

test('answer bank: a read error throws and blocks save without writing', async () => {
  // Same outage, other store.
  const { client, writes } = fakeClient({ data: null, error: { message: 'down' } });
  // Load must reject rather than resolve to seeds.
  await assert.rejects(() => loadAnswerBank(client), /down/);
  // Recorded for the write guard.
  assert.equal(getAnswerBankReadError(), 'down');
  // Try to save a seed answer.
  const res = await saveBankAnswer(SEED_QUESTIONS[0]!, 30, client);
  // Refused, with no remote write.
  assert.equal(res.ok, false);
  assert.equal(writes.count, 0);
});

test('answer bank: a successful empty read returns seeds and allows save', async () => {
  // Successful, no stored answers yet.
  const { client, writes } = fakeClient({ data: [], error: null });
  // Seeds are the honest answer here.
  const items = await loadAnswerBank(client);
  // At least every seed question is present.
  assert.ok(items.length >= SEED_QUESTIONS.length);
  // Guard cleared.
  assert.equal(getAnswerBankReadError(), null);
  // Save proceeds to exactly one upsert.
  const res = await saveBankAnswer(SEED_QUESTIONS[0]!, 30, client);
  assert.equal(res.ok, true);
  assert.equal(writes.count, 1);
});
