/* "Unanswered questions": the required form questions the worker's planner refused, turned
 * into one card per question for the Answer bank page (Teja's ruling, 2026-11-05 22:55 IST).
 *
 * WHERE THE DATA COMES FROM. public.unanswered_questions (migration 20261105230000), one row
 * per normalised question key, written by the worker whenever planFill refuses a required
 * field. This file reads it, joins the blocked applications for their status and company, and
 * builds cards. It never writes the table: answering means saving into answer_bank through the
 * normal browser path (saveBankAnswer), whose trigger stamps attested_by_human = true.
 *
 * "CAN A SAVED ANSWER CLEAR THIS?" IS ASKED OF THE PLANNER ITSELF. The worker answers EEO and
 * eligibility questions only through fixed templates, refuses every checkbox, and never answers
 * consent/criminal/pay-history questions. A card offering a Save that the worker will then
 * ignore would be a lie. So each card runs the REAL planFill (imported by relative path, the
 * way approveCheck.ts imports the auditor) with one hypothetical attested answer under its key:
 * if the planner would then fill the field, the card is answerable here; if not, it is listed
 * as "needs a planner rule". One source of truth, so this page cannot drift from the worker.
 *
 * The decisions are pure functions (buildCards and friends), tested in
 * test/unansweredQuestionsView.test.ts without a DOM.
 */

// The worker's own planner: pure (type-only imports), so it runs in the browser unchanged.
import { planFill } from '../../../../../worker/src/plan-fill.ts';
// Row shapes shared with the migration; Answer types for the save payload.
import type { AnswerBankRow, AnswerType, UnansweredQuestionRow } from '@applyy/shared-types';
// Type-only: the client is injectable so tests can fake it.
import type { SupabaseClient } from '@supabase/supabase-js';
// The app client; null when no backend is configured.
import { supabase } from '../../data/supabase.ts';
// The loaded bank's question shape: "already answered" is read from it.
import type { BankQuestion } from './answerBankStore.ts';

/* The application statuses in which an answer can still matter: the row may yet be approved,
 * submitted, or is parked waiting for exactly this answer. A closed or dropped application
 * no longer counts towards "blocks N applications". */
const OPEN_STATUSES: ReadonlySet<string> = new Set([
  // Tailored and audited rows are on their way to the approval queue.
  'tailored', 'audit_clean', 'audit_flagged',
  // In the queue, approved, or being submitted.
  'awaiting_approval', 'approved', 'applying',
  // Parked by the worker on an unanswered question: the case this page exists for.
  'blocked_needs_human',
]);

/* The card groups, as the 2026-11-05 submit-readiness sweep reported them.
 * 'fact': reusable facts (education, notice, years of experience), answered once for every form.
 * 'attest': statements only Teja may make (in-person events, acknowledgements), answerable here.
 * 'essay': per-company free text, collapsed under the company.
 * 'rule': no saved answer can clear it; the worker needs a new template or checkbox support. */
export type CardGroup = 'fact' | 'attest' | 'essay' | 'rule';

/* The input a card renders. A select only when the form's options are known; react-select
 * options are not captured yet (T3), so most dropdowns fall back to text. */
export type CardInput = 'select' | 'textarea' | 'text';

/* One application a question blocks, for the "blocks N applications" line. */
export interface BlockedApplication {
  // The application id, so the line can link or dedupe.
  readonly id: string;
  // UNTRUSTED company name, rendered as text only.
  readonly company: string;
}

/* One question card. */
export interface QuestionCard {
  // The normalised key the answer is saved under: the key the planner looks up.
  readonly key: string;
  // UNTRUSTED question text from the ATS page, rendered as text only.
  readonly text: string;
  // Which section the card sits in.
  readonly group: CardGroup;
  // Which input it renders (unused for 'rule' cards, which have no Save).
  readonly input: CardInput;
  // The form's options when known; empty when unknown.
  readonly options: readonly string[];
  // The answer_bank type the save writes.
  readonly answerType: AnswerType;
  // The still-open applications it blocks, one per company line.
  readonly blocks: readonly BlockedApplication[];
  // When a form last asked it, for ordering.
  readonly lastSeenAt: string;
}

/* The applications read alongside the questions: id, status and the job's company. */
export interface ApplicationLite {
  // Matches an id in blocked_application_ids.
  readonly id: string;
  // Only OPEN_STATUSES count.
  readonly status: string;
  // UNTRUSTED; '' when the job row could not be read.
  readonly company: string;
}

/** True when the planner would fill this question from an attested answer saved under its key.
 *
 * Runs the real planFill on one required field with one hypothetical attested bank row. The
 * placeholder value is never shown or saved; it only has to be a valid answer shape. Options
 * are left out on purpose: whether Teja's real answer matches an option is checked when he
 * picks it from the select, and a placeholder could never match. */
export function savedAnswerWouldClear(row: Pick<UnansweredQuestionRow, 'question_key' | 'question_text' | 'field_kind'>): boolean {
  // The one field, exactly as the worker extracted it, minus options.
  const field = { id: 'q', label: row.question_text, kind: row.field_kind, required: true };
  // A row as the page's Save would leave it: attested, not a placeholder.
  const bankRow = {
    question_key: row.question_key,
    answer_value: 'placeholder',
    needs_human: false,
    attested_by_human: true,
  } as unknown as AnswerBankRow;
  // No profile and no employer: a profile-derived answer is not this page's doing.
  const plan = planFill([field], [bankRow], null, null);
  // Cleared iff the planner now fills it and blocks nothing.
  return plan.blockers.length === 0 && plan.fills.length === 1;
}

/** The section a question belongs in. */
export function groupFor(row: Pick<UnansweredQuestionRow, 'question_key' | 'question_text' | 'field_kind' | 'reason'>): CardGroup {
  // Nothing saved here could clear it: say so instead of offering a Save that does nothing.
  if (!savedAnswerWouldClear(row)) return 'rule';
  // Long free text is an essay, written per company.
  if (row.field_kind === 'textarea') return 'essay';
  // human_only that a saved answer CAN clear: a statement only Teja may sign (opinion or acknowledgement).
  if (row.reason === 'human_only') return 'attest';
  // Everything else is a reusable fact.
  return 'fact';
}

/** Which input a card renders, and the answer_bank type its Save writes. */
export function inputFor(row: Pick<UnansweredQuestionRow, 'field_kind' | 'options'>): { input: CardInput; answerType: AnswerType } {
  // Known options: pick one verbatim, since the worker types the stored text exactly.
  if (row.options !== null && row.options.length > 0) return { input: 'select', answerType: 'single_select' };
  // A textarea is long text.
  if (row.field_kind === 'textarea') return { input: 'textarea', answerType: 'long_text' };
  // Anything else, including a dropdown whose options were not captured: plain text.
  return { input: 'text', answerType: 'text' };
}

/** True when the bank already holds an answer the worker will use for this key. */
function isAnswered(bank: ReadonlyMap<string, BankQuestion>, key: string): boolean {
  // The bank's question for the key, if any.
  const q = bank.get(key);
  // Only an attested, non-placeholder, non-empty answer counts: anything less still blocks.
  return q !== undefined && q.attestedByHuman === true && !q.needsHuman && q.value !== null && q.value !== undefined && q.value !== '';
}

/** The cards to show, newest first: answered keys and questions with no open application are left out. */
export function buildCards(
  // The table's rows.
  rows: readonly UnansweredQuestionRow[],
  // The applications those rows name.
  applications: readonly ApplicationLite[],
  // The loaded answer bank.
  bank: readonly BankQuestion[],
): QuestionCard[] {
  // Lookups once, not per row.
  const appById = new Map(applications.map((a) => [a.id, a]));
  // Bank by key.
  const bankByKey = new Map(bank.map((q) => [q.key, q]));
  // Accumulator.
  const cards: QuestionCard[] = [];
  for (const row of rows) {
    // Already answered: the worker will fill it next run, so it is no longer Teja's work.
    if (isAnswered(bankByKey, row.question_key)) continue;
    // Only applications that still exist for this user AND are still open.
    const blocks = row.blocked_application_ids
      .map((id) => appById.get(id))
      .filter((a): a is ApplicationLite => a !== undefined && OPEN_STATUSES.has(a.status))
      .map((a) => ({ id: a.id, company: a.company }));
    // Blocks nothing open: a stale report, not work.
    if (blocks.length === 0) continue;
    // Input and save type from the control.
    const { input, answerType } = inputFor(row);
    cards.push({
      // The key Save writes under.
      key: row.question_key,
      // Shown as text, never as markup.
      text: row.question_text,
      // Asked of the real planner.
      group: groupFor(row),
      // From the control kind and known options.
      input,
      // Known options only; null becomes empty.
      options: row.options ?? [],
      // Matches the input.
      answerType,
      // Open applications only.
      blocks,
      // For the tie-break sort.
      lastSeenAt: row.last_seen_at,
    });
  }
  // Most-blocking first, then most recently asked: the answer that unblocks the most comes first.
  return cards.sort((a, b) => b.blocks.length - a.blocks.length || b.lastSeenAt.localeCompare(a.lastSeenAt));
}

/** The answerable BankQuestion a card's Save hands to saveBankAnswer. */
export function cardToBankQuestion(card: QuestionCard): BankQuestion {
  return {
    // The exact key the planner looks up: the whole point of saving it.
    key: card.key,
    // Shown in the main table afterwards.
    asks: card.text,
    // Written as answer_type, matching the input the card rendered.
    type: card.answerType,
    // Unanswered-form questions are general until Teja recategorises them.
    category: 'general',
    // No previous value: this question had none.
    value: null,
    // No seed default either.
    defaultValue: null,
    // Shown in the main table, so the row explains where it came from.
    why: 'Asked by an application form; answered from Unanswered questions.',
    // saveBankAnswer writes needs_human false anyway; kept consistent here.
    needsHuman: false,
    // Never used yet.
    timesUsed: 0,
    // Never used yet.
    lastUsedAt: null,
    // A form question, not a seed: deletable like any discovered row.
    isCustom: true,
  };
}

/* What the loader returns: three honest states, never an empty list for a failed read. */
export type UnansweredLoad =
  | { readonly kind: 'ok'; readonly rows: readonly UnansweredQuestionRow[]; readonly applications: readonly ApplicationLite[] }
  | { readonly kind: 'no_backend' }
  | { readonly kind: 'error'; readonly message: string };

/** Reads the questions and the applications they block. Never throws. */
export async function loadUnanswered(client: SupabaseClient | null = supabase): Promise<UnansweredLoad> {
  // Local-only mode has no table to read.
  if (client === null) return { kind: 'no_backend' };
  try {
    // RLS returns only this user's rows.
    const q = await client.from('unanswered_questions').select('*');
    // "errored" and "no rows" are opposite claims; check each.
    if (q.error) return { kind: 'error', message: q.error.message };
    if (!Array.isArray(q.data)) return { kind: 'error', message: 'unanswered_questions read returned no data' };
    // The table's rows, shaped by the migration's CHECKs.
    const rows = q.data as UnansweredQuestionRow[];
    // Every application named anywhere, once.
    const ids = [...new Set(rows.flatMap((r) => r.blocked_application_ids))];
    // Nothing to join.
    if (ids.length === 0) return { kind: 'ok', rows, applications: [] };
    // Status and company in one read; the job join as AppliedJobsPage does it.
    const a = await client.from('applications').select('id, status, jobs:job_id(company_name)').in('id', ids);
    // A failed join is a failed load: counts without it would read as "blocks nothing".
    if (a.error) return { kind: 'error', message: a.error.message };
    if (!Array.isArray(a.data)) return { kind: 'error', message: 'applications read returned no data' };
    // Flattened; a missing job reads as '' (shown as "unknown company"), never a guess.
    const applications = (a.data as Array<{ id: string; status: string; jobs: { company_name?: unknown } | null }>).map((r) => ({
      // Matched against blocked_application_ids.
      id: r.id,
      // Filtered by OPEN_STATUSES in buildCards.
      status: r.status,
      // Only a real string is a name.
      company: typeof r.jobs?.company_name === 'string' ? r.jobs.company_name : '',
    }));
    // Both reads succeeded.
    return { kind: 'ok', rows, applications };
  } catch (err) {
    // Thrown network errors are read failures too.
    return { kind: 'error', message: err instanceof Error ? err.message : String(err) };
  }
}
