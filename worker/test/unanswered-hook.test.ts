// H2 (2026-11-06): the worker reports every required field the planner refused to
// record_unanswered_questions (migration 20261105230000, live), so the Answer bank page can ask Teja
// each question once. Spec: ae's hook-for-bf.md. The page saves Teja's answer under the key sent
// here, so the key MUST be the planner's own lookup key, or a saved answer never meets its field.
import { describe, expect, test, vi } from 'vitest';
// The bank row shape the planner reads.
import type { AnswerBankRow } from '@applyy/shared-types';
// The extractor's field shape.
import type { FormField } from '../src/extract-fields.ts';
// Under test: the key function and the blockers that carry it.
import { planFill, questionKey } from '../src/plan-fill.ts';
// Under test: the production gateway's report method.
import { createSupabaseGateway } from '../src/supabase-gateway.ts';
// The client shape the gateway accepts.
import type { SupabaseLike } from '../src/supabase-gateway.ts';

describe('questionKey', () => {
  test('folds accents and normalises exactly as the planner looks a label up', () => {
    // "Consént*" must become "consent", never "cons_nt": one definition for the hook and the planner.
    expect(questionKey('Consént*')).toBe('consent');
  });
});

describe('FillBlocker carries the lookup key, the kind and the options', () => {
  test('a refused required select carries key = questionKey(label), its kind and its options', () => {
    // No answer anywhere for this question.
    const field: FormField = { id: 'q', label: 'Notice period (days)?', kind: 'native_select', required: true, options: ['30', '60'] };
    // Planned with an empty bank.
    const plan = planFill([field], [], null, null);
    // The one blocker, with all three new facts.
    expect(plan.blockers).toEqual([{ id: 'q', label: 'Notice period (days)?', reason: 'no_answer', key: questionKey('Notice period (days)?'), kind: 'native_select', options: ['30', '60'] }]);
  });

  test('a field whose options are unknown carries no options key', () => {
    // A free-text question.
    const plan = planFill([{ id: 'q', label: 'Notice period?', kind: 'text', required: true }], [], null, null);
    // Absent, never null or [] (absent = unknown, which the page renders as free text).
    expect(plan.blockers[0]).not.toHaveProperty('options');
  });

  test('the ambiguous_answer_key blocker sends the UNDECORATED key, not one derived from its decorated label', () => {
    // Two rows that normalise to one key.
    const rows = [
      { question_key: 'Notice period', answer_value: '30', needs_human: false, answer_type: 'text' },
      { question_key: 'notice_period', answer_value: '60', needs_human: false, answer_type: 'text' },
    ] as unknown as AnswerBankRow[];
    // Planned.
    const plan = planFill([{ id: 'q', label: 'Notice period', kind: 'text', required: true }], rows, null, null);
    // The label is decorated with both raw keys...
    expect(plan.blockers[0]?.label).toMatch(/ambiguous answer_bank keys/);
    // ...but the key is the field's own.
    expect(plan.blockers[0]).toMatchObject({ reason: 'ambiguous_answer_key', key: 'notice_period' });
  });
});

describe('gateway.recordUnansweredQuestions', () => {
  // A client whose rpc records its calls and answers with the given result.
  function rpcClient(result: { data: unknown; error: { message: string } | null }) {
    // Every rpc call.
    const calls: Array<{ fn: string; args: unknown }> = [];
    // Only rpc is reached by this method.
    const client = { rpc: async (fn: string, args: unknown) => { calls.push({ fn, args }); return result; } } as unknown as SupabaseLike;
    return { client, calls };
  }
  // One blocker as the planner now makes it.
  const blocker = { id: 'q', label: 'Notice period?', reason: 'no_answer', key: 'notice_period', kind: 'text' } as const;

  test('sends the planner key, label, reason, kind and options to the RPC', async () => {
    // A healthy RPC.
    const { client, calls } = rpcClient({ data: 1, error: null });
    // Reported.
    await createSupabaseGateway(client, { userId: 'u' }).recordUnansweredQuestions('app-1', [blocker]);
    // One call, in the migration's argument names.
    expect(calls).toEqual([{ fn: 'record_unanswered_questions', args: { p_application_id: 'app-1', p_items: [{ key: 'notice_period', label: 'Notice period?', reason: 'no_answer', kind: 'text', options: null }] } }]);
  });

  test('an RPC { error } is logged and resolves: a report never changes the outcome', async () => {
    // supabase-js returns errors; the method must not throw on one.
    const { client } = rpcClient({ data: null, error: { message: 'function not found' } });
    // The warning is the only trace.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // Resolves.
    await expect(createSupabaseGateway(client, { userId: 'u' }).recordUnansweredQuestions('app-1', [blocker])).resolves.toBeUndefined();
    // And said.
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('function not found'));
    // Restored for the next test.
    warn.mockRestore();
  });

  test("an item with key '' is dropped (it would refuse the whole call), and no call is made when none remain", async () => {
    // An all-symbol label normalises to ''.
    const { client, calls } = rpcClient({ data: 0, error: null });
    // Only an empty-key blocker.
    await createSupabaseGateway(client, { userId: 'u' }).recordUnansweredQuestions('app-1', [{ ...blocker, key: '' }]);
    // Nothing sent.
    expect(calls).toEqual([]);
  });
});
