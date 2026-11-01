/* THE AI BOX on the review page (2026-10-31).
 *
 * The operator says what to change; the AI proposes a short list of edits; each edit is applied
 * only by the operator's click, through the same save path as a hand edit (aiEdit.ts explains
 * why). Nothing here writes on its own, and the preview / "Download PDF" follow every applied
 * edit because the page re-renders the saved resume.
 *
 * THE AUDIT AS ADVICE, ON THE CARD (2026-11-01). Each bullet edit is run through the auditor's own
 * rule 5 (detector.ts bulletGroundingGaps) before Apply, and the card says which numbers and words
 * the master does not supply; a skill the master lacks says Apply saves it there too. Every apply
 * is one click: no popup, no block, no status change. Teja ruled native confirms out, since a
 * dialog on every click trains a reflex OK; the card is read before the click instead. The footer
 * counts flagged edits, so whether the audit should ever BLOCK is decided on measured numbers.
 *
 * Pure presentation: the ask and the save are both injected, so the component holds no client. */

// useId ties labels to inputs without a global counter; useState holds the box's local state.
import { useId, useState } from 'react';
// The return type of every component here.
import type { ReactElement } from 'react';

// Type only: the diff this box reads its context from.
import type { ResumeDiff } from './diffModel';
// Type only: the action vocabulary and save result the page already understands.
import type { EditAction, EditResult } from './DiffView';
// The pure halves: build the ask, map an op to an action, run the audit's rule, format the bill.
import { auditAdvice, buildAssistDraft, formatUsage, toEditAction } from './aiEdit';
// Types for the answer.
import type { AssistBody, AssistDraft, AssistOp, AssistResult, AssistUsage, AuditAdvice } from './aiEdit';

// The box's own styles, beside it, like DiffView.css beside DiffView.
import './AiEditPanel.css';

/* Where one suggestion stands. */
type SuggestionStatus = 'pending' | 'applying' | 'applied' | 'failed';

/* One proposed edit and what happened to it. */
interface Suggestion {
  // Stable within one answer; the list never reorders.
  readonly key: string;
  // What the AI proposed.
  readonly op: AssistOp;
  // The page action it maps to; null when its id is not on this resume.
  readonly action: EditAction | null;
  // What the audit would say, computed once at ask time; null for ops that change no wording.
  readonly advice: AuditAdvice | null;
  // Where it stands.
  readonly status: SuggestionStatus;
  // Why it failed, in the save path's own words.
  readonly reason: string | null;
}

/* One answer: the ask it came from, its suggestions, the note and the bill. */
interface Answer {
  // Holds the id -> text map the suggestions are shown against.
  readonly draft: AssistDraft;
  // In the AI's order.
  readonly suggestions: readonly Suggestion[];
  // The AI's one-line summary of what it changed.
  readonly note: string;
  // Ops the server could not map to this resume.
  readonly dropped: number;
  // What the ask cost.
  readonly usage: AssistUsage;
}

/* NO POPUPS (Teja, 2026-11-01). Everything a confirm() used to ask is on the card BEFORE Apply:
   the audit's flags in red, and for a skill the master lacks, that Apply saves it there too. A
   native dialog on every click trained a reflex OK, which is worse than reading the card. */

/* The audit's advice on one card. Words and numbers are listed so the operator judges each. */
function AdviceLine({ advice }: { readonly advice: AuditAdvice }): ReactElement {
  // No rule for this edit: said, never shown as a pass.
  if (advice.kind === 'not_checked') return <p className="ai-edit__meta">{advice.why}</p>;
  // The flagged parts, each list only when non-empty.
  const parts: string[] = [];
  // Numbers first: the costlier lie.
  if (advice.metrics.length > 0) parts.push(`numbers not in your master: ${advice.metrics.join(', ')}`);
  // Then words.
  if (advice.terms.length > 0) parts.push(`words not in your master: ${advice.terms.join(', ')}`);
  // Grounded: said plainly, in the traced green.
  if (parts.length === 0) return <p className="ai-edit__audit ai-edit__audit--clean">Audit: grounded in your master.</p>;
  // Flagged: what the audit would mark, in the fabrication colour.
  return <p className="ai-edit__audit">Audit would flag {parts.join('; ')}.</p>;
}

/* The before/after of one suggestion, with what the audit would say. */
function SuggestionBody({
  // The proposal.
  op,
  // Text by id at ask time.
  before,
  // The audit's rule on this op; null for ops that change no wording.
  advice,
  // Master skill names, lower-cased.
  masterSkills,
}: {
  // One of the three op kinds.
  readonly op: AssistOp;
  // From the draft the ask was built from, so "before" is what the AI saw.
  readonly before: ReadonlyMap<string, string | null>;
  // Computed once per answer, not per render.
  readonly advice: AuditAdvice | null;
  // From the skills line's master text.
  readonly masterSkills: ReadonlySet<string>;
}): ReactElement {
  // A new skill: name and group.
  if (op.op === 'add_skill') {
    // Stacked: the add, then what else Apply does.
    return (
      <div className="ai-edit__change">
        {/* The name in bold, since that is the claim being made. */}
        <span>
          Add skill <strong>{op.name}</strong> under {op.category}
        </span>
        {/* Said before the click, where the popup used to ask it: Apply makes this a master claim. */}
        {masterSkills.has(op.name.trim().toLowerCase()) ? null : (
          <p className="ai-edit__audit">Not in your master profile yet: Apply saves it there too. Only apply if you have it.</p>
        )}
      </div>
    );
  }
  // The text the id stood for when the ask was sent.
  const old = before.get(op.id) ?? null;
  // A removal: the bullet that goes.
  if (op.op === 'remove') {
    // The whole bullet, struck, so the operator sees exactly what leaves the PDF.
    return (
      <p className="ai-edit__change">
        {/* <del> carries "removed" to screen readers, not only to the eye. */}
        Remove bullet: <del className="ai-edit__old">{old}</del>
      </p>
    );
  }
  // An edit: old struck through, new beside it, and any new numbers called out.
  return (
    // Stacked, so a long bullet wraps instead of squeezing the button.
    <div className="ai-edit__change">
      {/* Which part of the resume the edit lands on. */}
      <span className="ai-edit__where">{op.id === 'summary' ? 'Summary' : 'Bullet'}</span>
      {/* Absent old text (a new summary) shows nothing struck. */}
      {old !== null ? <del className="ai-edit__old">{old}</del> : null}
      {/* The proposed wording. */}
      <ins className="ai-edit__new">{op.text}</ins>
      {/* What the audit would say, read before Apply instead of asked in a popup. */}
      {advice !== null ? <AdviceLine advice={advice} /> : null}
    </div>
  );
}

/* The box itself. Mounted by DiffView only where an edit could land (a save path, editing on). */
export function AiEditPanel({
  // Read for the context of every ask.
  diff,
  // Called once per applied suggestion.
  onEdit,
  // Called once per ask.
  onAssist,
  // Disables every control while a save runs.
  busy,
  // Where a new skill may be filed.
  categories,
}: {
  // The rendered diff: the AI's context is built from it, so it sees what the operator sees.
  readonly diff: ResumeDiff;
  // The page's guarded save; one call per applied suggestion.
  readonly onEdit: (action: EditAction) => Promise<EditResult>;
  // The ask; injected so this component never holds a client.
  readonly onAssist: (body: AssistBody) => Promise<AssistResult>;
  // A save is in flight somewhere in this diff; one write at a time per resume.
  readonly busy: boolean;
  // The master's skill groups, the only places a new skill may be filed.
  readonly categories: readonly string[];
}): ReactElement {
  // Ties the label to the textarea and the heading to the region.
  const baseId = useId();
  // What the operator is typing.
  const [instruction, setInstruction] = useState<string>('');
  // An ask is in flight.
  const [asking, setAsking] = useState<boolean>(false);
  // The last failed ask, in the function's words.
  const [error, setError] = useState<string | null>(null);
  // The last answer, or null before the first ask.
  const [answer, setAnswer] = useState<Answer | null>(null);
  // An Apply-all run is in progress, so its buttons wait.
  const [applyingAll, setApplyingAll] = useState<boolean>(false);

  /* Send the instruction with the current resume. */
  async function ask(): Promise<void> {
    // Blank, mid-ask or mid-save: nothing to send.
    if (instruction.trim() === '' || asking || busy) return;
    // Locks the button.
    setAsking(true);
    // A new ask clears the old failure.
    setError(null);
    // Built from the diff as it is NOW, so it includes every edit already applied.
    const draft = buildAssistDraft(diff, categories, instruction);
    // The call; never throws.
    const result = await onAssist(draft.body);
    // Unlocks.
    setAsking(false);
    // Said where the button is; the previous answer stays visible.
    if (result.kind === 'error') {
      // The function's own message.
      setError(result.message);
      // Nothing else changes.
      return;
    }
    // Each op paired with the action it maps to, all pending.
    const suggestions = result.ops.map((op, index) => ({
      // Stable within this answer.
      key: String(index),
      // As proposed.
      op,
      // The page action it maps to.
      action: toEditAction(op, draft),
      // The audit's rule, run now against the master text the ask was built from.
      advice: auditAdvice(op, draft),
      // Nothing applied yet.
      status: 'pending' as const,
      // No refusal yet.
      reason: null,
    }));
    // Replaces the previous answer.
    setAnswer({ draft, suggestions, note: result.note, dropped: result.dropped, usage: result.usage });
  }

  /* Change one suggestion's status, leaving the rest as they are. */
  function mark(key: string, status: SuggestionStatus, reason: string | null): void {
    // Functional update: several applies can resolve between renders.
    setAnswer((current) =>
      // No answer means nothing to mark; otherwise only the matching key changes.
      current === null ? current :{ ...current, suggestions: current.suggestions.map((s) => (s.key === key ? { ...s, status, reason } : s)) },
    );
  }

  /* Apply one suggestion. Answers what happened, so Apply all knows whether to go on. */
  async function apply(suggestion: Suggestion): Promise<'applied' | 'failed'> {
    // An id that no longer maps cannot be applied.
    if (suggestion.action === null) {
      // Said on the suggestion itself.
      mark(suggestion.key, 'failed', 'That part is no longer on this resume.');
      // Reported.
      return 'failed';
    }
    // Shown as in progress. No popup: the card already showed every flag before this click.
    mark(suggestion.key, 'applying', null);
    // The page's guarded save.
    const result = await onEdit(suggestion.action);
    // Landed.
    if (result.ok) {
      // Marked done; the diff above re-renders with it.
      mark(suggestion.key, 'applied', null);
      // Reported.
      return 'applied';
    }
    // Refused or unknown, in the save path's words.
    mark(suggestion.key, 'failed', result.reason);
    // Reported.
    return 'failed';
  }

  /* Apply every pending suggestion in order; stop at the first failure. */
  async function applyAll(): Promise<void> {
    // Nothing to do without an answer.
    if (answer === null) return;
    // Snapshot of what is pending now; statuses change as the loop runs.
    const pending = answer.suggestions.filter((s) => s.status === 'pending' || s.status === 'failed');
    // Locks the buttons.
    setApplyingAll(true);
    // One at a time: each save writes the whole resume, so two in flight would race.
    for (const suggestion of pending) {
      // Applied or failed.
      const outcome = await apply(suggestion);
      // A failure usually means the row changed; later saves would fail the same way.
      if (outcome === 'failed') break;
    }
    // Unlocks.
    setApplyingAll(false);
  }

  // What still waits for a click.
  const open = answer?.suggestions.filter((s) => s.status === 'pending' || s.status === 'failed') ?? [];
  // Bullet edits the audit rule ran on: the denominator of the flag count.
  const audited = answer?.suggestions.filter((s) => s.advice?.kind === 'checked') ?? [];
  // Of those, the ones it would flag: the number that decides whether the audit should ever block.
  const flagged = audited.filter((s) => s.advice?.kind === 'checked' && (s.advice.metrics.length > 0 || s.advice.terms.length > 0));
  // Every control waits while anything is in flight.
  const locked = busy || asking || applyingAll;

  // A labelled region, so a screen reader can jump to the AI box by name.
  return (
    <section className="ai-edit" aria-labelledby={`${baseId}-title`}>
      {/* h3: a sub-section of the diff, under its own heading level. */}
      <h3 id={`${baseId}-title`} className="ai-edit__title">
        Ask AI to edit this resume
      </h3>
      {/* The contract in one line: proposals only, the operator applies. */}
      <p className="ai-edit__hint">Say what to change. The AI proposes edits; nothing changes until you apply one.</p>
      {/* A real label, hidden: the placeholder vanishes on typing and is no label. */}
      <label className="visually-hidden" htmlFor={`${baseId}-input`}>
        Instruction for the AI
      </label>
      {/* Two rows: an instruction is a sentence or two, and the box can be dragged taller. */}
      <textarea
        /* Matches the label's htmlFor. */
        id={`${baseId}-input`}
        /* Styled in AiEditPanel.css. */
        className="ai-edit__input"
        /* Short by default; resize: vertical in the CSS lets it grow. */
        rows={2}
        // The edge function's cap; longer is refused there anyway.
        maxLength={500}
        /* An example, so the first ask is a good one. */
        placeholder="e.g. Add Kafka to skills and make the first bullet about latency"
        /* Controlled, so ask() reads exactly what is shown. */
        value={instruction}
        /* Every keystroke kept. */
        onChange={(event) => setInstruction(event.target.value)}
        // Ctrl/Cmd+Enter sends, so the keyboard path matches the button.
        onKeyDown={(event) => {
          // Plain Enter stays a newline.
          if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
            // No newline inserted.
            event.preventDefault();
            // Same guards as the button.
            void ask();
          }
        }}
        /* Frozen while asking, so the instruction shown is the one that was sent. */
        disabled={asking}
      />
      {/* The ask and, once there is an answer, the batch apply. */}
      <div className="ai-edit__actions">
        {/* Primary: the one action this box exists for. Disabled on blank, mid-ask and mid-save. */}
        <button type="button" className="button button--primary button--small" onClick={() => void ask()} disabled={locked || instruction.trim() === ''}>
          {/* The label says when an ask is in flight. */}
          {asking ? 'Asking…' : 'Suggest edits'}
        </button>
        {/* Offered only when more than one edit is waiting. */}
        {open.length > 1 ? (
          // Secondary: applying is the follow-up to asking.
          <button type="button" className="button button--secondary button--small" onClick={() => void applyAll()} disabled={locked}>
            {/* The count, so the operator knows how many saves one click makes. */}
            Apply all ({open.length})
          </button>
        ) : null}
      </div>
      {/* Polite: a failed ask is news, not an emergency. */}
      <p className="ai-edit__error" role="status" aria-live="polite">
        {error ?? ''}
      </p>
      {/* Nothing below until the first answer arrives. */}
      {answer !== null ? (
        // One block, so the whole answer is spaced from the controls together.
        <div className="ai-edit__answer">
          {/* The AI's own summary, or the reason it changed nothing. */}
          {answer.note !== '' ? <p className="ai-edit__note">{answer.note}</p> : null}
          {/* An empty list is said, not left as blank space. */}
          {answer.suggestions.length === 0 ? (
            // Said in the note style, since it is the AI's answer, not an error.
            <p className="ai-edit__note">No edits proposed.</p>
          ) : (
            // Ordered: the list order is the apply order.
            <ol className="ai-edit__list">
              {/* In the AI's order, which is the order Apply all uses. */}
              {answer.suggestions.map((suggestion) => (
                <li key={suggestion.key} className={`ai-edit__item ai-edit__item--${suggestion.status}`}>
                  {/* What changes, shown against the text it replaces. */}
                  <SuggestionBody op={suggestion.op} before={answer.draft.before} advice={suggestion.advice} masterSkills={answer.draft.masterSkills} />
                  {/* Applied items say so instead of offering the button again. */}
                  {suggestion.status === 'applied' ? (
                    <span className="ai-edit__done">Applied</span>
                  ) : (
                    <button
                      type="button"
                      /* Secondary: the primary action on this box is the ask. */
                      className="button button--secondary button--small"
                      /* One guarded save through the page. */
                      onClick={() => void apply(suggestion)}
                      /* Waits for any save, and an unmappable id can never apply. */
                      disabled={locked || suggestion.status === 'applying' || suggestion.action === null}
                    >
                      {/* A failed one is retried by the same button. */}
                      {suggestion.status === 'applying' ? 'Applying…' : suggestion.status === 'failed' ? 'Retry' : 'Apply'}
                    </button>
                  )}
                  {/* The save path's refusal, verbatim. */}
                  {suggestion.reason !== null ? <p className="ai-edit__error">{suggestion.reason}</p> : null}
                </li>
              ))}
            </ol>
          )}
          {/* Proposals the server could not map to this resume, so a silent drop is visible. */}
          {answer.dropped > 0 ? <p className="ai-edit__meta">{answer.dropped} proposed edit(s) did not fit this resume and were left out.</p> : null}
          {/* The measurement: how many bullet edits the audit would flag, when any were checked. */}
          {audited.length > 0 ? <p className="ai-edit__meta">Audit would flag {flagged.length} of {audited.length} bullet edits.</p> : null}
          {/* What this ask cost, so the token bill is visible per click. */}
          <p className="ai-edit__meta">{formatUsage(answer.usage)}</p>
        </div>
      ) : null}
    </section>
  );
}
