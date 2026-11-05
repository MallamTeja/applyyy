/* "Unanswered questions": the Answer bank page's section for every required form question the
 * worker refused (Teja's ruling, 2026-11-05 22:55 IST). Teja answers each ONCE; the Save goes
 * through saveBankAnswer, the normal browser path, so the DB trigger stamps the answer as his
 * (attested_by_human = true) and the worker fills it on its next run.
 *
 * THE ONE RULE THIS FILE KEEPS: nothing here writes except a card's Save click, and a card only
 * offers Save when the worker's own planner would read the saved answer (unansweredQuestionsView.ts
 * asks planFill). Questions no answer can clear are listed under "Needs a planner rule" with no
 * input at all, so Teja is never asked to answer something that changes nothing.
 *
 * The decisions live in unansweredQuestionsView.ts as pure functions, tested without a DOM.
 */

// Per-card drafts, the loaded rows, and a load-on-mount effect.
import { useCallback, useEffect, useState } from 'react';
// Return type of the component, matching the other settings sections.
import type { ReactElement } from 'react';

// Save outcomes are reported the same way the rest of the page reports them.
import { useToast } from '../../app/Toast';
// The one save path: same payload, same read-error guard as every other answer on the page.
import { saveBankAnswer } from './answerBankStore';
// Type only: the loaded bank, from which "already answered" is read.
import type { BankQuestion } from './answerBankStore';
// The pure card rules and the read.
import { buildCards, cardToBankQuestion, loadUnanswered } from './unansweredQuestionsView';
// Types only: one card, the group union and the load result.
import type { CardGroup, QuestionCard, UnansweredLoad } from './unansweredQuestionsView';

// Everything bank-related comes from the page, so this section and the table share one state.
interface Props {
  // The loaded bank; a key answered there drops out of this section.
  readonly questions: readonly BankQuestion[];
  // While the bank loads, every question would look unanswered.
  readonly loading: boolean;
  // A failed bank read blocks saving in the store; the buttons mirror that.
  readonly loadError: string | null;
  // Lets the page re-read the bank after a save, so the card leaves because the DB says so.
  readonly onSaved: () => void;
}

/* Section headings per group, in display order. A Record so a new group fails to compile until named. */
const GROUP_TITLE: Record<CardGroup, string> = {
  // Reusable facts, answered once for every form.
  fact: 'Facts about you',
  // Statements only Teja may make.
  attest: 'Statements only you can make',
  // Per-company free text.
  essay: 'Essays, per company',
  // No saved answer can clear these yet.
  rule: 'Needs a planner rule',
};

/* "blocks 3 applications: Enterpret, UiPath, Quora", with the company names deduplicated. */
function blocksLine(card: QuestionCard): string {
  // One name per company; an unreadable job row is named honestly.
  const companies = [...new Set(card.blocks.map((b) => b.company || 'unknown company'))];
  // Singular or plural, so the sentence reads right at 1.
  const noun = card.blocks.length === 1 ? 'application' : 'applications';
  // The count is applications, the list is companies (two roles at one company = one name).
  return `Blocks ${card.blocks.length} ${noun}: ${companies.join(', ')}`;
}

// Named export, like the page's other sections.
export function UnansweredQuestions({ questions, loading, loadError, onSaved }: Props): ReactElement {
  // Toasts report each save.
  const toast = useToast();
  // The table read: 'loading' until the first answer, then the three honest outcomes.
  const [load, setLoad] = useState<UnansweredLoad | 'loading'>('loading');
  // Per-key drafts; nothing is written until Save.
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  // Which key is mid-save, to block a double click.
  const [savingKey, setSavingKey] = useState<string | null>(null);

  // One read, reusable by the Refresh button.
  const refresh = useCallback(async () => {
    // Shows "Loading" again rather than stale cards during a re-read.
    setLoad('loading');
    // loadUnanswered never throws; failures come back as kind 'error'.
    setLoad(await loadUnanswered());
  }, []);

  // Read once on mount.
  useEffect(() => {
    // Fire and forget; state updates arrive when it resolves.
    void refresh();
  }, [refresh]);

  /* The ONLY write path in this file, reached only from a Save click. */
  const save = async (card: QuestionCard): Promise<void> => {
    // Trimmed: the worker types the stored text exactly.
    const value = (drafts[card.key] ?? '').trim();
    // Never store a blank as an answer.
    if (value === '') {
      // Say why nothing happened.
      toast.error('Type or pick an answer first.');
      // No write.
      return;
    }
    // Disable this card's button while the request is out.
    setSavingKey(card.key);
    // try/finally so the button always re-enables, even if the save throws.
    try {
      // The normal browser save: no agent key, so the trigger marks it as Teja's own answer.
      const res = await saveBankAnswer(cardToBankQuestion(card), value);
      // ok: the bank now holds Teja's attested answer.
      if (res.ok) {
        // Name the question, so several quick saves are distinguishable.
        toast.success(`Saved "${card.text}"`);
        // The page re-reads the bank; the card then drops out because the bank holds the answer.
        onSaved();
      } else {
        // The store's own message (a blocked read, a sync failure).
        toast.error(res.error ?? 'Save failed.');
      }
    } finally {
      // Re-enable the button either way.
      setSavingKey(null);
    }
  };

  // The cards, once both reads are in; empty while either is loading or failed.
  const cards = load !== 'loading' && load.kind === 'ok' && !loading ? buildCards(load.rows, load.applications, questions) : [];

  /* One answerable card: question, input, what it blocks, Save. */
  const renderCard = (card: QuestionCard): ReactElement => {
    // The input's id, tying the label to it.
    const inputId = `unanswered-${card.key}`;
    // The current draft.
    const value = drafts[card.key] ?? '';
    // Records a keystroke or pick as a draft only.
    const setDraft = (next: string): void => setDrafts((prev) => ({ ...prev, [card.key]: next }));
    // Disabled while saving, while the bank read is failed, or with nothing typed.
    const disabled = savingKey === card.key || loadError !== null || value.trim() === '';
    // The card markup.
    return (
      <div /* question_key is unique per user: a stable React key. */ key={card.key} className="eligibility__field">
        {/* The question as the form asked it; the key is a hover tooltip for debugging only. */}
        <div className="eligibility__head">
          {/* A real label, so clicking it focuses the input and readers announce it. */}
          <label htmlFor={inputId} className="eligibility__label" title={card.key}>
            {/* Rendered as text: React escapes it, and this string came from an ATS page. */}
            {card.text}
          </label>
        </div>
        {/* A select only when the form's own options are known, so the answer matches one verbatim. */}
        {card.input === 'select' ? (
          // The table's input styling; the value is a draft until Save.
          <select id={inputId} className="answer-bank__input" value={value} onChange={(e) => setDraft(e.target.value)}>
            {/* An empty first choice, so nothing is pre-picked on Teja's behalf. */}
            <option value="">Choose…</option>
            {/* The form's options, verbatim. */}
            {card.options.map((o) => (
              <option /* Option text is unique within one question. */ key={o} value={o}>
                {/* Shown exactly as the form spells it, since that string is what gets typed. */}
                {o}
              </option>
            ))}
          </select>
        ) : card.input === 'textarea' ? (
          // Essays get room to write.
          <textarea id={inputId} className="answer-bank__textarea" rows={4} value={value} onChange={(e) => setDraft(e.target.value)} />
        ) : (
          // Short free text.
          <input id={inputId} type="text" className="answer-bank__input" value={value} onChange={(e) => setDraft(e.target.value)} />
        )}
        {/* What answering this unblocks, so the most useful answers are obvious. */}
        <p className="eligibility__hint">{blocksLine(card)}</p>
        {/* The one write: through the shared save path. */}
        <button type="button" className="answer-bank__btn-save" disabled={disabled} onClick={() => void save(card)}>
          {/* Shows progress so a slow save is not clicked twice. */}
          {savingKey === card.key ? 'Saving…' : 'Save'}
        </button>
      </div>
    );
  };

  /* One card no saved answer can clear: the question and what it blocks, no input. */
  const renderRuleCard = (card: QuestionCard): ReactElement => (
    <div /* Same stable key. */ key={card.key} className="eligibility__field">
      {/* The question, as text. */}
      <p className="eligibility__label" title={card.key}>
        {/* Text, escaped by React: it came from an ATS page. */}
        {card.text}
      </p>
      {/* What it blocks; the section note says why there is no input. */}
      <p className="eligibility__hint">{blocksLine(card)}</p>
    </div>
  );

  /* The essays, one collapsed block per company (an essay is written for one employer). */
  const renderEssays = (essays: readonly QuestionCard[]): ReactElement[] => {
    // Grouped by the first company the essay blocks.
    const byCompany = new Map<string, QuestionCard[]>();
    // One pass over the essays.
    for (const card of essays) {
      // The company name, or an honest placeholder.
      const company = card.blocks[0]?.company || 'unknown company';
      // Appended to that company's list.
      byCompany.set(company, [...(byCompany.get(company) ?? []), card]);
    }
    // One <details> per company: closed by default, so essays do not bury the facts.
    return [...byCompany].map(([company, list]) => (
      <details /* Company names are unique keys here. */ key={company}>
        {/* The count tells Teja how much writing each company asks for. */}
        <summary>
          {/* "Runway (2)": the company and how many essays it asks for. */}
          {company} ({list.length})
        </summary>
        {/* The essay cards, answerable like any other. */}
        <div className="eligibility__list">{list.map(renderCard)}</div>
      </details>
    ));
  };

  // The section markup.
  return (
    <section /* The page's existing section styling. */ className="settings-group">
      {/* Title and a refresh, since the worker adds questions while the page is open. */}
      <div className="settings-group__header-row">
        {/* The section's name from Teja's ruling. */}
        <h2 className="settings-group__title">Unanswered questions</h2>
        {/* Re-reads the table only; the bank has the page's own Refresh. */}
        <button type="button" className="answer-bank__btn-reset" onClick={() => void refresh()}>
          {/* Plain verb: it re-reads, it does not save. */}
          Refresh
        </button>
      </div>
      {/* The contract in one line. */}
      <p className="settings-group__note">
        {/* Says what the list is and what one answer buys: every form asking it. */}
        Required questions from application forms that stopped an application. Answer each once and
        every application asking it can go ahead.
      </p>
      {/* Same blocked-save banner as the other sections: the store refuses while its read is failed. */}
      {loadError !== null && (
        // Alert role: it changes what the buttons do.
        <p className="store-notice store-notice--bad" role="alert">
          {/* Points at the page Refresh, which re-reads the bank. */}
          Saving is blocked until the answer bank loads. Use Refresh above to retry.
        </p>
      )}
      {/* Loading, failed, no backend, empty, or the cards: each says what it is. */}
      {load === 'loading' || loading ? (
        // Not "nothing to answer": the reads are still out.
        <p className="settings-group__note">Loading unanswered questions…</p>
      ) : load.kind === 'error' ? (
        // A failed read is never shown as "nothing to answer".
        <p className="store-notice store-notice--bad" role="alert">
          {/* The store message, so the cause is visible. */}
          Could not load unanswered questions: {load.message}
        </p>
      ) : load.kind === 'no_backend' ? (
        // Local-only mode has no worker reports.
        <p className="settings-group__note">No backend configured, so there are no form reports to show.</p>
      ) : cards.length === 0 ? (
        // A successful read with nothing open.
        <p className="settings-group__note">Nothing is waiting on an answer.</p>
      ) : (
        // The groups in GROUP_TITLE order; an empty group is not shown.
        (Object.keys(GROUP_TITLE) as CardGroup[]).map((group) => {
          // This group's cards.
          const list = cards.filter((c) => c.group === group);
          // Nothing in it: no heading.
          if (list.length === 0) return null;
          // One block per non-empty group.
          return (
            <div /* Group names are unique. */ key={group}>
              {/* The group heading with its count. */}
              <h3 className="eligibility__subtitle">
                {/* "Facts about you (12)": the group and its size. */}
                {GROUP_TITLE[group]} ({list.length})
              </h3>
              {/* Why the last group has no inputs. */}
              {group === 'rule' && (
                // Note styling, as elsewhere on the page.
                <p className="settings-group__note">
                  {/* Why no input: a Save here would change nothing. */}
                  The worker cannot use a saved answer for these yet: the wording matches none of its
                  templates, or it is a tick box. They are listed so you can see what is blocked.
                </p>
              )}
              {/* Essays collapse per company; rule cards have no input; the rest are answerable. */}
              {group === 'essay' ? (
                // One collapsed block per company.
                renderEssays(list)
              ) : (
                // Cards in a column; rule cards render without an input.
                <div className="eligibility__list">{list.map(group === 'rule' ? renderRuleCard : renderCard)}</div>
              )}
            </div>
          );
        })
      )}
    </section>
  );
}
