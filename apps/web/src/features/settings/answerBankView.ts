/* View rules for the Answer bank page: which value a field shows, which values may be
 * saved, what "Save all answers" writes, and which rows the main table hides.
 *
 * WHY A SEPARATE PURE MODULE. The web tests run under node:test with no jsdom, so a rule
 * that lives inside a component cannot be pinned by a test. Each rule here is a plain
 * function over BankQuestion values; the components only call them.
 *
 * WHAT THIS MODULE NEVER DOES: build a write payload. Every write still goes through
 * saveBankAnswer, so the upsert body keeps one shape and never carries attested_by_human
 * or an agent key. The DB trigger decides who wrote a row, not this file. */

// Value imports: the EEO list, the save-state reader, the EEO option rule and the one save path.
import { EEO_QUESTIONS, attestationState, isSaveableEeoAnswer, saveBankAnswer } from './answerBankStore.ts';
// Type only: every function here reads the loaded question shape.
import type { BankQuestion } from './answerBankStore.ts';

/* Keys the main table hides. Two different reasons, kept in one set so the filter is one lookup:
 * - eeo_*: edited only in the Eligibility section's exact-option selects; the table's
 *   single_select editor offers free text the live form would refuse.
 * - gender / disability_status: legacy seeds. The worker's EEO path reads only the eeo_*
 *   keys (worker/src/plan-fill.ts EEO_TEMPLATES), so an answer saved here is never used,
 *   and their option text ("Decline to self-identify") does not match Greenhouse's
 *   ("Decline To Self Identify"). Showing them invites Teja to fill the wrong Gender row.
 *   UI only: the rows stay in the seed list and in the DB; nothing is deleted. */
export const TABLE_HIDDEN_KEYS: ReadonlySet<string> = new Set([
  // The four EEO keys, taken from the one shared list so a new EEO question is hidden too.
  ...EEO_QUESTIONS.map((q) => q.key),
  // Legacy seed the worker never reads; superseded by eeo_gender.
  'gender',
  // Legacy seed the worker never reads; no eeo_* replacement exists yet.
  'disability_status',
]);

/** True when the main table should not list this key (see TABLE_HIDDEN_KEYS for why). */
export function isTableHiddenKey(key: string): boolean {
  // A plain set lookup; the reasons live on the set.
  return TABLE_HIDDEN_KEYS.has(key);
}

/** The value a field shows: the user's draft, else the saved value, else the suggestion.
 * A yes/no question shows NO suggestion: a highlighted "No" before any save reads as an
 * answer already given (found in the 2026-10-09 render check), so a boolean starts with
 * neither button selected until Teja picks one or a saved row exists. */
export function shownValue(
  // The loaded question, carrying its saved value and attested state.
  question: BankQuestion,
  // Per-key drafts typed or picked this session.
  drafts: Readonly<Record<string, unknown>>,
  // The suggestion for this key (a ruling or a profile-derived value), or undefined.
  suggestion: unknown,
): unknown {
  // `in`, not `??`, so a draft deliberately set to '' or false is kept.
  if (question.key in drafts) return drafts[question.key];
  // Any row in the bank, attested or not, is a saved value and is shown as-is.
  if (attestationState(question) !== 'unsaved') return question.value;
  // No row and a yes/no question: nothing is selected (the hint names the suggestion instead).
  if (question.type === 'boolean') return undefined;
  // No row, any other type: the suggestion prefills the input, labelled as a suggestion.
  return suggestion;
}

/** The value as it would be stored: text trimmed (the worker compares "None" exactly),
 * everything else untouched. */
export function valueToSave(raw: unknown): unknown {
  // Only strings are normalised; booleans and null pass through.
  return typeof raw === 'string' ? raw.trim() : raw;
}

/** Whether a value may be saved for this question. Shared by the per-field Save and by
 * Save all, so the two buttons can never disagree about what is a real answer. */
export function isSaveableValue(question: BankQuestion, value: unknown): boolean {
  // The EEO definition, when this key is one.
  const eeo = EEO_QUESTIONS.find((e) => e.key === question.key);
  // EEO: only one of the form's exact option strings; "Not answered" ('') never.
  if (eeo !== undefined) return isSaveableEeoAnswer(eeo, value);
  // Yes/no: only a real boolean, so an unpicked field (undefined) cannot be saved.
  if (question.type === 'boolean') return typeof value === 'boolean';
  // Text: a non-blank string; an empty answer would read as "answered" to the worker.
  return typeof value === 'string' && value.trim() !== '';
}

/* One field as the section hands it to the planner: the question and the value it shows. */
export interface FieldEntry {
  // The loaded question.
  readonly question: BankQuestion;
  // What the input currently shows (draft, saved value, or suggestion).
  readonly value: unknown;
}

/* One planned write: the question and the already-normalised value to store. */
export interface PlannedSave {
  // The loaded question, passed to saveBankAnswer unchanged.
  readonly question: BankQuestion;
  // Trimmed for text, as stored.
  readonly value: unknown;
}

/** The writes "Save all answers" would make. A field is included when its shown value is
 * saveable AND it is not already stored as Teja's own answer with that same value. So:
 * - an attested row whose value is unchanged is skipped (no needless upsert);
 * - an unsaved field showing a suggestion IS included: the button is a human click on the
 *   values on screen, the same as pressing that field's own Save;
 * - an unattested row (machine-written) is included even when unchanged, because
 *   re-saving it from the browser is what makes the trigger stamp it as Teja's. */
export function planSaveAll(entries: readonly FieldEntry[]): PlannedSave[] {
  // Collected in section order, so results read top to bottom like the form.
  const planned: PlannedSave[] = [];
  // One pass over the fields.
  for (const { question, value } of entries) {
    // Normalise first, so "India " and "India" compare equal.
    const v = valueToSave(value);
    // Not a real answer (blank text, unpicked yes/no, "Not answered"): never written.
    if (!isSaveableValue(question, v)) continue;
    // Already Teja's answer with this exact value: nothing to write.
    if (attestationState(question) === 'attested' && valueToSave(question.value) === v) continue;
    // Everything else is a write.
    planned.push({ question, value: v });
  }
  // The planned writes, possibly none.
  return planned;
}

/* One field's outcome, so the section can say which saves failed. */
export interface SaveResult {
  // The question_key written (or refused).
  readonly key: string;
  // The label Teja sees, for the toast.
  readonly asks: string;
  // Whether this field's upsert succeeded.
  readonly ok: boolean;
  // The store's message when it did not.
  readonly error?: string | undefined;
}

/** Run the planned writes one at a time through the single save path. Sequential on
 * purpose: seven small upserts, and a failure on one must not hide the others' outcomes.
 * `save` is injectable for tests; production passes nothing and gets saveBankAnswer. */
export async function saveAllPlanned(
  // The output of planSaveAll.
  planned: readonly PlannedSave[],
  // The write function; defaults to the store's, which owns the payload shape.
  save: (question: BankQuestion, value: unknown) => Promise<{ ok: boolean; error?: string }> = saveBankAnswer,
): Promise<SaveResult[]> {
  // One result per planned write.
  const results: SaveResult[] = [];
  // In order, awaited one by one.
  for (const { question, value } of planned) {
    // The store returns errors as values; a throw is caught so one field cannot stop the rest.
    try {
      // The same upsert the per-field Save makes, so the trigger stamps each row.
      const res = await save(question, value);
      // Record the outcome as returned.
      results.push({ key: question.key, asks: question.asks, ok: res.ok, error: res.error });
    } catch (err) {
      // An unforeseen throw becomes a failed result, never a silent skip.
      results.push({ key: question.key, asks: question.asks, ok: false, error: String(err) });
    }
  }
  // Every planned field has exactly one result.
  return results;
}
