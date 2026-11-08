/* Why the bot cannot apply to a row, and which of its open questions Teja can answer from the card
 * (Teja, 2026-11-07 22:55 IST: "if something is not able to apply by bots, take the kit and push the
 * job into the manual section ... I will answer those questions ... so the answer bank grows").
 *
 * THE REASON LINE reads only what was recorded: the row's own block_reason (while it is parked), the
 * kit's skip code, the job's Workday signal, and the kit's open required fields. Nothing recorded means
 * no reason, and the card prints "—": a guessed reason would send Teja to fix the wrong thing (§6).
 *
 * THE QUESTIONS come from the kit's FIELDS (required, no answer), never from parsing its warning strings,
 * which are free text that also carries walls, drift and resume notes. Whether a question gets an input
 * is asked of the worker's REAL planner (savedAnswerWouldClear, the Answer bank page's own check): the
 * planner never fills consent/certify/birth/pay-history labels or any checkbox, and an input whose
 * answer the bot never uses would be a dead control (orchestrator ruling, 2026-11-07 23:31). The save
 * key is the planner's questionKey, so an answer saved here is exactly the one the next kit fills.
 *
 * Pure: tested in test/manualApplyBotCantApply.test.ts without a DOM. */

// The planner's own key for a label (accents folded, then normalised): what the bank row must be saved under.
import { questionKey } from '../../../../../worker/src/plan-fill.ts';
// The one Workday predicate, shared with apply-one's guard and the rehearse CLI (zero imports, browser-safe).
import { isWorkdayJob } from '../../../../../worker/src/workday.ts';
// The Answer bank page's planner check, input choice, answered rule and save row, reused so the two pages agree.
import { cardToBankQuestion, inputFor, isAnswered, savedAnswerWouldClear } from '../settings/unansweredQuestionsView.ts';
// Types only: the input kinds the card renders.
import type { CardInput } from '../settings/unansweredQuestionsView.ts';
// Type only: the bank's question shape.
import type { BankQuestion, KitRefresh } from '../settings/answerBankStore.ts';
// Types only: the shared enums for the save type, the park reason and the planner's field kind.
import type { AnswerType, BlockReason, UnansweredFieldKind } from '@applyy/shared-types';
// Types only: the parsed kit.
import type { KitField, KitInputType, KitState } from './applyKit';
// Type only: the card's row.
import type { ManualApplyRow } from './manualApplyData';

// The Workday line: one reason, whichever signal (host, provider, login_required park) found it.
const WORKDAY = 'Workday needs a candidate account';
// The robots line: the kit worker's skip and the applier's park say the same thing.
const ROBOTS = "the site's robots.txt refuses bots";

/* Words for each park reason. A Record over the closed union, so a new enum value fails tsc here until it is
   given words. robots_refused and login_required are listed for completeness; the function folds them into
   ROBOTS and (on a Workday job) WORKDAY so a reason is never said twice. */
const PARK_WORDS: Readonly<Record<BlockReason, string>> = {
  // An anti-bot challenge the bot must never solve.
  captcha: 'a captcha stops the bot',
  // A code sent to Teja's phone or email.
  mfa: 'the site asks for a verification code',
  // Covered by the question count when the kit lists them; said plainly when it does not.
  unanswerable_question: 'a required question has no answer',
  // A form shape no adapter handles.
  unsupported_form: 'the bot cannot read this form',
  // An account wall (a password field on the page, or the Workday guard).
  login_required: 'the site asks for a candidate account',
  // Submitted, outcome unknown: Teja checks the receipt.
  submission_unconfirmed: 'the bot could not confirm its submit',
  // The worker named no category; System health holds its detail.
  other: 'the worker parked it (see System health)',
  // Folded into ROBOTS.
  robots_refused: ROBOTS,
};

// The real park reasons, for the shape check on the untrusted column value.
const PARK_KEYS: ReadonlySet<string> = new Set(Object.keys(PARK_WORDS));

/** True for a kit field that is still Teja's to answer: required, no answer, and not the resume upload
 * (a file field takes the downloaded resume; it is not a question). The KitFieldRow "missing" rule, minus files. */
function isOpen(field: KitField): boolean {
  // Required and unanswered, as the card's red rows mark it; files left out.
  return field.required && (field.source === 'unanswered' || field.value === null) && field.inputType !== 'file';
}

/** The open questions of a kit; none for any other kit state. */
function openFields(kit: KitState): readonly KitField[] {
  // Only a real kit has fields.
  return kit.kind === 'kit' ? kit.kit.fields.filter(isOpen) : [];
}

/** The reasons the bot cannot apply to this row, in the order Teja acts on them; empty when none is recorded. */
export function botCantApplyReasons(row: Pick<ManualApplyRow, 'status' | 'blockReason' | 'applyUrl' | 'atsProvider'>, kit: KitState): readonly string[] {
  // A Set keeps first-insertion order and drops a reason two signals both found.
  const reasons = new Set<string>();
  // Workday by host or provider: known before the worker ever claims the row.
  const workday = isWorkdayJob(typeof row.applyUrl === 'string' ? row.applyUrl : null, typeof row.atsProvider === 'string' ? row.atsProvider : null);
  // Said first: nothing else on a Workday form matters to the bot.
  if (workday) reasons.add(WORKDAY);
  // The kit worker refused to read the form for robots.txt.
  if (kit.kind === 'skipped' && kit.code === 'robots_refused') reasons.add(ROBOTS);
  // The open questions, counted from the kit's fields.
  const open = openFields(kit).length;
  // The park reason, only while parked (the column may outlive the park) and only a real enum value.
  const park = row.status === 'blocked_needs_human' && typeof row.blockReason === 'string' && PARK_KEYS.has(row.blockReason) ? (row.blockReason as BlockReason) : null;
  // Folded: a Workday job's account wall is the Workday line; listed questions are the count below.
  if (park !== null && !(park === 'login_required' && workday) && !(park === 'unanswerable_question' && open > 0)) reasons.add(PARK_WORDS[park]);
  // The count, singular or plural.
  if (open > 0) reasons.add(`${open} question${open === 1 ? '' : 's'} need${open === 1 ? 's' : ''} you`);
  // In insertion order.
  return [...reasons];
}

/* One open question on the card. */
export interface OpenQuestion {
  // The planner's key for the label: the answer_bank key the save writes.
  readonly key: string;
  // UNTRUSTED form label, rendered as text only.
  readonly label: string;
  // True when a saved answer would make the planner fill it; false = "answer it on the form".
  readonly answerable: boolean;
  // Which input the card draws.
  readonly input: CardInput;
  // The answer_bank type the save writes.
  readonly answerType: AnswerType;
  // The form's options; empty when none were read.
  readonly options: readonly string[];
}

/* The kit's input type as the planner's field kind. A kit 'select' may have been a native select or a
   combobox; the planner treats both alike when no options are passed (savedAnswerWouldClear passes none). */
const PLANNER_KIND: Readonly<Record<Exclude<KitInputType, 'file'>, UnansweredFieldKind>> = {
  // Typed answer.
  text: 'text',
  // Long answer.
  textarea: 'textarea',
  // A dropdown.
  select: 'native_select',
  // One radio group.
  radio: 'radio_group',
  // A single box: the planner refuses every one.
  checkbox: 'checkbox',
  // Unknown control: asked as plain text, the planner's most permissive kind, so it is never wrongly hidden.
  other: 'text',
};

/** The kit's open questions, in form order, each with whether the card offers an input. */
export function openQuestions(kit: KitState): readonly OpenQuestion[] {
  return openFields(kit).map((field) => {
    // isOpen dropped files, so the cast only narrows what the filter already proved.
    const kind = PLANNER_KIND[field.inputType as Exclude<KitInputType, 'file'>];
    // The key the planner looks this label up by.
    const key = questionKey(field.label);
    // The form's options; a kit field without any carries null, which is "none read", never a list.
    const options = field.options ?? [];
    // Input and save type, by the Answer bank page's own rule (null options = free text); copied, its param is mutable.
    const { input, answerType } = inputFor({ field_kind: kind, options: options.length > 0 ? [...options] : null });
    // Asked of the real planner: would an attested answer under this key fill it?
    const answerable = savedAnswerWouldClear({ question_key: key, question_text: field.label, field_kind: kind });
    // The card's question.
    return { key, label: field.label, answerable, input, answerType, options };
  });
}

/** True when the loaded bank already holds the answer the worker will use for this question. */
export function isBanked(bank: readonly BankQuestion[], question: OpenQuestion): boolean {
  // The Answer bank page's rule, so a question hidden there is hidden here.
  return isAnswered(new Map(bank.map((q) => [q.key, q])), question.key);
}

/** The BankQuestion the card's Save hands to saveBankAnswer: the Answer bank page's own builder. */
export function openQuestionToBankQuestion(question: OpenQuestion): BankQuestion {
  // Same row shape as an Unanswered-questions save, marked as answered on Manual apply.
  return cardToBankQuestion({ key: question.key, text: question.label, answerType: question.answerType }, 'Manual apply');
}

/** The card's line after a Save that landed, saying whether the kit rebuild it asked for started (peer 4, 2026-11-08).
 *  `undefined` is a local-only save (no Supabase client): the worker never reads it, so no rebuild was asked. */
export function savedLine(kitRefresh: KitRefresh | undefined): string {
  // Started: the sweep rebuilds every stale kit; a run takes 1-2.5 min (apply-kit.yml runs, 2026-11-07).
  if (kitRefresh === 'requested') return 'Saved to your answer bank. Kit rebuild started; press Refresh kits in about 3 minutes.';
  // Not started: the answer is stored, and the next scheduled sweep still uses it.
  if (kitRefresh === 'failed') return 'Saved to your answer bank, but the kit rebuild could not be started; the next scheduled kit run fills it.';
  // Local only: say what is true and no more.
  return 'Saved in this browser only. The bot reads your answer bank, so sign in and save again.';
}
