/* "Eligibility answers" - the Answer bank page's section for the questions the worker's
 * form filler answers ONLY from rows Teja saved himself.
 *
 * WHY A SEPARATE SECTION AND NOT JUST MORE TABLE ROWS. A DB trigger stamps
 * `answer_bank.attested_by_human` true for browser writes and false for machine writes,
 * and the worker trusts only true. So for these questions the thing that matters is not
 * the value but WHO wrote it, and this section shows that state per field.
 *
 * THE ONE RULE THIS FILE KEEPS: nothing here writes except a Save button's onClick (a
 * field's own Save, or "Save all answers"). Suggestions (Teja's 2026-10-09 rulings, and
 * values derived from his master profile) only prefill a draft. Auto-saving them would
 * stamp a machine's guess as his answer.
 *
 * The decisions (what a field shows, what may be saved, what Save all writes) live in
 * answerBankView.ts as pure functions, so node:test pins them without a DOM.
 */

// State for drafts and the profile read; an effect for the one-time profile load.
import { useEffect, useState } from 'react';
// Return type of the component, matching the other settings pages.
import type { ReactElement } from 'react';

// Save outcomes are reported the same way the main table reports them.
import { useToast } from '../../app/Toast';
// The app client; null when no backend is configured, which the effect handles.
import { supabase } from '../../data/supabase';
// Values from the store: the save path and the pure helpers this section is built on.
import {
  // The EEO questions and their verbatim option lists: one copy shared with the tests.
  EEO_QUESTIONS,
  // Which keys render, and in what order.
  ELIGIBILITY_KEYS,
  // Row flag to badge state, kept pure in the store so it is tested.
  attestationState,
  // The existing save path: one payload shape and one read-error guard for every save.
  saveBankAnswer,
  // Pure, tested derivation of the open-source links suggestion.
  suggestOpenSourceLinks,
  // Pure, tested derivation of the language/framework suggestion.
  suggestPrimaryLanguage,
} from './answerBankStore';
// Types only: the badge-state union and the question shape.
import type { AttestationState, BankQuestion } from './answerBankStore';
// The pure view rules this section renders from; tested in test/answerBankView.test.ts.
import {
  // Which writes "Save all answers" makes: only fields that differ from Teja's stored answer.
  planSaveAll,
  // Whether a value is a real answer; shared by both Save buttons so they cannot disagree.
  isSaveableValue,
  // Runs the planned writes one by one through saveBankAnswer and reports each outcome.
  saveAllPlanned,
  // Draft, else saved value, else suggestion; a yes/no shows no suggestion as a selection.
  shownValue,
  // Trims text the way it is stored, since the worker compares "None" exactly.
  valueToSave,
} from './answerBankView';
// Type only: one field's Save-all outcome, held in state for the results list.
import type { SaveResult } from './answerBankView';
// The existing master-profile read; it never throws, failures come back as a value.
import { loadCurrentMasterProfile } from './masterStore';
// Its result union, held in state as-is so every outcome renders honestly.
import type { LoadOutcome } from './masterStore';

/* Label per save state; a Record so adding a state is a compile error until labelled.
 * Plain words for a non-technical reader: "attested" was jargon (2026-10-09 render check). */
const STATE_LABEL: Record<AttestationState, string> = {
  // The only state the worker acts on; the tick is decoration, the words carry the meaning.
  attested: 'Saved by you ✓',
  // A row exists but was not saved from this browser, so the worker will not use it until Teja saves.
  unattested: 'Needs your save',
  // No row: the field shows a suggestion at most.
  unsaved: 'Not saved yet',
};

// Everything comes from the page, so the section and the table share one loaded bank.
interface Props {
  // The loaded bank; eligibility questions are looked up from it by key.
  readonly questions: readonly BankQuestion[];
  // While the bank loads, statuses would all read "Not saved yet", which is false.
  readonly loading: boolean;
  // A failed read blocks saving in the store; the buttons mirror that.
  readonly loadError: string | null;
  // Lets the page re-read the bank, so the shown state is the DB's, not a guess.
  readonly onSaved: () => void;
}

// Named export, like the page's other sections.
export function EligibilityAnswers({ questions, loading, loadError, onSaved }: Props): ReactElement {
  // Toasts report each save's outcome, same as the main table.
  const toast = useToast();
  // The master profile drives two suggestions and the read-only company list.
  const [master, setMaster] = useState<LoadOutcome | 'loading'>('loading');
  // Per-key drafts; a key absent here falls back to the saved value or the suggestion.
  const [drafts, setDrafts] = useState<Record<string, unknown>>({});
  // Which key is mid-save, to disable its button against double clicks.
  const [savingKey, setSavingKey] = useState<string | null>(null);
  // True while "Save all answers" runs, so no field Save can interleave with it.
  const [savingAll, setSavingAll] = useState<boolean>(false);
  // The last Save all's per-field outcomes, listed under the button; null before any run.
  const [saveAllResults, setSaveAllResults] = useState<readonly SaveResult[] | null>(null);

  // Read the master profile once on mount. A read only: no write happens here.
  useEffect(() => {
    // No backend configured means there is no profile to read.
    if (supabase === null) {
      // 'none' renders as "no master profile loaded", which is accurate.
      setMaster({ kind: 'none' });
      // Nothing to clean up.
      return;
    }
    // Guards against setting state after unmount.
    let live = true;
    // loadCurrentMasterProfile never throws; failures come back as kind 'failed'.
    void loadCurrentMasterProfile(supabase).then((outcome) => {
      // Dropped when the page has gone.
      if (live) setMaster(outcome);
    });
    // Empty dependency list below: one read per mount, no polling.
    // Cleanup flips the guard.
    return () => {
      // Late resolutions become no-ops.
      live = false;
    };
    // No dependencies: the profile is read once per mount.
  }, []);

  // The profile, or null when not (yet) loaded; the helpers treat null as "no suggestion".
  const profile = typeof master === 'object' && master.kind === 'loaded' ? master.profile : null;

  /* Suggestions per key. Only consulted when no row exists, so a saved answer always wins. */
  const suggestion = (q: BankQuestion): unknown => {
    // Derived from skills, per Teja's GitLab answers.
    if (q.key === 'what_is_your_primary_programming_language_and_or_framework') return suggestPrimaryLanguage(profile);
    // Derived from project links on github.com.
    if (q.key === 'please_share_links_of_any_open_source_projects_you_own_or_have_made_contributions_to') return suggestOpenSourceLinks(profile);
    // Everything else carries its ruling in defaultValue ('India', false, 'None').
    return q.defaultValue;
  };

  // The value the input shows; the rule (and why a yes/no shows no suggestion) is in answerBankView.
  const shown = (q: BankQuestion): unknown => shownValue(q, drafts, suggestion(q));

  // Records a keystroke or toggle as a draft. Never writes.
  const setDraft = (key: string, value: unknown): void => {
    // Functional update so two quick edits cannot lose one.
    setDrafts((prev) => ({ ...prev, [key]: value }));
  };

  /* The ONLY write path in this file, reached only from a Save click. */
  const save = async (q: BankQuestion): Promise<void> => {
    // Disable this field's button while the request is out.
    setSavingKey(q.key);
    // An older Save all list would now describe a state this save changes, so drop it.
    setSaveAllResults(null);
    // The store's own read-error guard still applies inside saveBankAnswer.
    try {
      // Trimmed for text, because the worker compares "None" exactly; booleans pass through.
      const value = valueToSave(shown(q));
      // Second line of defence behind the disabled button: never store a blank, an unpicked
      // yes/no, "Not answered" or an off-list EEO string.
      if (!isSaveableValue(q, value)) {
        // Say why nothing happened.
        toast.error('Pick or type an answer first, or leave it unanswered.');
        // No write; finally re-enables the button.
        return;
      }
      // Reuses the existing save path: same payload, same needs_human:false, same guard.
      const res = await saveBankAnswer(q, value);
      // Success: drop the draft and re-read so the status comes from the DB.
      if (res.ok) {
        // Name the field so several quick saves are distinguishable.
        toast.success(`Saved "${q.asks}"`);
        // Clear this key's draft; the re-read supplies the saved value.
        setDrafts((prev) => {
          // Copy, then delete, to keep the update immutable.
          const next = { ...prev };
          // The saved value now comes from the bank.
          delete next[q.key];
          // Hand back the trimmed map.
          return next;
        });
        // Re-read; this is where "Saved by you" can appear.
        onSaved();
      } else {
        // Refused or partially failed: nothing re-reads, so the badge keeps the DB's last state.
        // The store's message names the cause (e.g. blocked by a failed read).
        toast.error(res.error ?? 'Failed to save answer');
      }
    } catch (err) {
      // The store returns errors as values; this catch is for anything it did not foresee.
      // Unexpected throw: surface it rather than leaving the button spinning silently.
      toast.error(`Error saving answer: ${String(err)}`);
    } finally {
      // Runs on success and failure alike, so the button can never stay stuck.
      // Re-enable the button either way.
      setSavingKey(null);
    }
  };

  // Look each eligibility key up in the loaded bank; a missing one is skipped, not invented.
  const fields = ELIGIBILITY_KEYS.map((k) => questions.find((q) => q.key === k)).filter(
    // Narrowing filter so the map below sees BankQuestion, not undefined.
    (q): q is BankQuestion => q !== undefined,
  );
  // Pair each EEO question (for its options) with its loaded row (for value and attested state).
  // Built per render: four finds over a short list, no memo needed.
  const eeoFields = EEO_QUESTIONS.map((eeo) => ({
    // The verbatim option list.
    eeo,
    // The loaded copy; falls back to the seed itself if the bank somehow lacks it.
    loaded: questions.find((q) => q.key === eeo.key) ?? eeo,
  }));
  // Unique company names in document order, for the read-only "previously worked at" note.
  const companies = profile === null ? [] : [...new Set(profile.experience.map((e) => e.company.trim()))];

  // Every editable field with the value it shows, eligibility first then EEO, in screen order.
  const entries = [
    // The eligibility cards.
    ...fields.map((q) => ({ question: q, value: shown(q) })),
    // The EEO cards; the loaded row carries the attested state.
    ...eeoFields.map(({ loaded }) => ({ question: loaded, value: shown(loaded) })),
  ];
  // What "Save all answers" would write right now; empty means the button has nothing to do.
  const planned = planSaveAll(entries);
  // Unsaved typing or picking, as opposed to a suggestion nobody touched: only this warns on leave.
  const hasUnsavedEdits = planned.some((p) => p.question.key in drafts);

  // Warn before closing or reloading the tab while edits are unsaved. Cheap: one listener,
  // registered only while there is something to lose. In-app route changes are not covered.
  useEffect(() => {
    // Nothing typed and unsaved: no listener, so leaving never nags.
    if (!hasUnsavedEdits) return;
    // The browser shows its own generic prompt; custom text is ignored by modern browsers.
    const onBeforeUnload = (e: BeforeUnloadEvent): void => {
      // The standard way to ask for the prompt.
      e.preventDefault();
      // Legacy browsers need returnValue set as well.
      e.returnValue = '';
    };
    // Registered while edits are pending.
    window.addEventListener('beforeunload', onBeforeUnload);
    // Removed as soon as they are saved or the section unmounts.
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
    // Re-evaluated whenever the pending-edits answer changes.
  }, [hasUnsavedEdits]);

  /* "Save all answers": one click for every changed field. Each field still goes through
   * saveBankAnswer, so each row gets its own upsert and the trigger stamps each one. */
  const saveAll = async (): Promise<void> => {
    // Blocks every Save button until the run finishes.
    setSavingAll(true);
    // Clears the previous run's list, so a stale result is never read as this run's.
    setSaveAllResults(null);
    // finally guarantees the buttons come back even on an unexpected throw.
    try {
      // Sequential writes, one result per field; errors come back as values.
      const results = await saveAllPlanned(planned);
      // Shown under the button: which fields saved and which did not.
      setSaveAllResults(results);
      // The keys that saved, so only their drafts are dropped.
      const savedKeys = new Set(results.filter((r) => r.ok).map((r) => r.key));
      // The value each planned key was saved with, to spot a field edited while the run was out.
      const savedValue = new Map(planned.map((p) => [p.question.key, p.value]));
      // Drop a draft only when it saved AND still equals what was saved; a failed field, or one
      // typed into mid-run, keeps its draft so Teja's newer input is never silently replaced.
      setDrafts((prev) =>
        // Rebuilt from the latest drafts (functional update), not the render's copy.
        Object.fromEntries(
          // Keep the entry unless it is exactly the value that just landed.
          Object.entries(prev).filter(([k, v]) => !(savedKeys.has(k) && valueToSave(v) === savedValue.get(k))),
        ),
      );
      // How many did not save.
      const failed = results.length - savedKeys.size;
      // One summary toast; the per-field detail is in the list.
      if (failed === 0) toast.success(`Saved ${results.length} answer${results.length === 1 ? '' : 's'}`);
      // Partial or total failure is an error, never a quiet success.
      else toast.error(`${failed} of ${results.length} answers were not saved. See the list below.`);
      // Re-read only when something landed, so the badges come from the DB.
      if (savedKeys.size > 0) onSaved();
    } finally {
      // Re-enable every Save button.
      setSavingAll(false);
    }
  };

  // One settings-group section, so it sits in the page like the table section above it.
  return (
    <section /* Existing settings-group styling, so no new section chrome is invented. */ className="settings-group">
      {/* Heading text is the section's name in Teja's brief; keep it verbatim. */}
      <h2 className="settings-group__title">Eligibility answers</h2>
      {/* The one-line explainer: what these are for, and that only a saved answer counts. */}
      <p className="settings-group__note">
        {/* Wording from Teja's brief: "only answers you save here count" is the whole contract. */}
        These answers are used to fill eligibility questions automatically. Only answers you save
        here count.
      </p>

      {/* Same blocked-save banner logic as the table: the store refuses while the read is failed. */}
      {loadError !== null && (
        <p
          /* The page's existing bad-notice style, so both banners look like one problem. */
          className="store-notice store-notice--bad"
          /* Announced once by screen readers, since it changes what the buttons do. */
          role="alert"
        >
          {/* Points at the page's Refresh button rather than duplicating it here. */}
          Saving is blocked until the answer bank loads. Use Refresh above to retry.
        </p>
      )}

      {/* While loading, a status would claim "Not saved yet" for rows that may exist. */}
      {loading ? (
        <p /* Note styling: a quiet placeholder, not an error. */ className="settings-group__note">
          Loading eligibility answers...
        </p>
      ) : (
        <div /* Column of cards; layout lives in settings.css. */ className="eligibility__list">
          {/* One card per editable eligibility question, in ELIGIBILITY_KEYS order. */}
          {fields.map((q) => {
            // The state badge for this field.
            const state = attestationState(q);
            // The current input value.
            const value = shown(q);
            // Disabled while this key or Save all is saving, while the read is failed, or with no real answer to save.
            const disabled = savingKey === q.key || savingAll || loadError !== null || !isSaveableValue(q, valueToSave(value));
            // The input's id, so the label is programmatically tied to it.
            const inputId = `eligibility-${q.key}`;
            // The label's own id, so the yes/no group can name itself after it (a <label for> cannot label a div).
            const labelId = `${inputId}-label`;
            // The card itself; keyed by question_key, which is unique per user.
            return (
              <div
                /* question_key is unique per user, so it is a stable React key. */
                key={q.key}
                /* Bordered card so each Save visibly belongs to its own question. */
                className="eligibility__field"
              >
                {/* Label and state badge share a row so the state is read with the question. */}
                <div className="eligibility__head">
                  {/* A real label element, so clicking it focuses the input and readers announce it. */}
                  <label
                    /* Ties the label to its input; for the yes/no group, aria-labelledby below does the naming. */
                    htmlFor={inputId}
                    /* Referenced by the yes/no group's aria-labelledby. */
                    id={labelId}
                    /* Prompt styling. */
                    className="eligibility__label"
                    /* The worker's exact key as a hover tooltip: hidden from plain view (it overflowed a phone screen
                       and means nothing to a non-technical reader), still there for debugging. */
                    title={q.key}
                  >
                    {/* The same text that is saved as question_text, so Teja attests to what he read. */}
                    {q.asks}
                  </label>
                  {/* Modifier class carries the colour; the text carries the meaning for colour-blind users. */}
                  <span className={`eligibility__status eligibility__status--${state}`}>
                    {/* Text label from the Record above, so every state has words, not just colour. */}
                    {STATE_LABEL[state]}
                  </span>
                </div>
                {/* Boolean: the two existing yes/no buttons, styled as in the table. */}
                {q.type === 'boolean' ? (
                  <div
                    /* The table's yes/no layout, reused. */
                    className="answer-bank__bool-group"
                    /* Same id scheme as the text inputs. */
                    id={inputId}
                    /* Groups the two buttons as one control for assistive tech. */
                    role="group"
                    /* The group's accessible name is the question; without this it was announced unnamed. */
                    aria-labelledby={labelId}
                  >
                    {/* Yes: sets the draft only; nothing is written until Save. */}
                    <button
                      /* Not a form submit: there is no form, and a submit would be a write path. */
                      type="button"
                      /* Active styling mirrors the main table's yes button. */
                      className={`answer-bank__bool-btn ${value === true ? 'answer-bank__bool-btn--active-yes' : ''}`}
                      /* Toggle state for screen readers, since colour alone shows the choice. */
                      aria-pressed={value === true}
                      /* Draft only. */
                      onClick={() => setDraft(q.key, true)}
                    >
                      {/* Plain word: the table's "(True)" suffix is developer vocabulary. */}
                      Yes
                    </button>
                    {/* No: Teja's ruling for visa sponsorship, still only a draft until Save. */}
                    <button
                      /* Not a submit, same as Yes. */
                      type="button"
                      /* Active styling mirrors the main table's no button. */
                      className={`answer-bank__bool-btn ${value === false ? 'answer-bank__bool-btn--active-no' : ''}`}
                      /* Toggle state for screen readers. */
                      aria-pressed={value === false}
                      /* Draft only. */
                      onClick={() => setDraft(q.key, false)}
                    >
                      {/* Plain word, matching Yes. */}
                      No
                    </button>
                  </div>
                ) : q.type === 'long_text' ? (
                  // Multi-line for the open-source links answer (one URL per line).
                  <textarea
                    /* Tied to the label above. */
                    id={inputId}
                    /* Reuses the table's textarea styling. */
                    className="answer-bank__textarea"
                    /* Room for a few links, one per line. */
                    rows={3}
                    /* Draft, saved value, or suggestion, in that order. */
                    value={String(value ?? '')}
                    /* Each keystroke is a draft; no write. */
                    onChange={(e) => setDraft(q.key, e.target.value)}
                  />
                ) : (
                  // Every remaining eligibility type is short text.
                  <input
                    /* Tied to the label above. */
                    id={inputId}
                    /* Short free text: a country, "None", a language list. */
                    type="text"
                    /* Reuses the table's input styling. */
                    className="answer-bank__input"
                    /* Draft, saved value, or suggestion, in that order. */
                    value={String(value ?? '')}
                    /* Each keystroke is a draft; no write. */
                    onChange={(e) => setDraft(q.key, e.target.value)}
                  />
                )}

                {/* Says out loud that a prefilled value is a suggestion, not an answer. */}
                {state === 'unsaved' && (
                  <p className="eligibility__hint">
                    {/* A yes/no shows no pre-selection, so its suggestion is named in words; text fields are prefilled. */}
                    {q.type === 'boolean'
                      ? `Suggested: ${q.defaultValue === true ? 'Yes' : 'No'}. Pick an answer, then Save.`
                      : 'Suggested value. Not used until you click Save or Save all answers.'}
                  </p>
                )}
                {/* The worker's exact rule, so Teja knows what "None" buys him. */}
                {q.key === 'employment_restrictions' && (
                  <p className="eligibility__hint">
                    {/* Mirrors the worker's case-insensitive exact-match rule; keep the two in step. */}
                    The bot answers No only when this is exactly None or No. Anything else sends the
                    question to you.
                  </p>
                )}

                {/* The field's own Save: the only write trigger in this section. */}
                <div /* The table's action row spacing, reused. */ className="answer-bank__edit-actions">
                  <button
                    /* Not a submit; the click handler is the single write path. */
                    type="button"
                    /* Same look as the table's Save, so the action is recognisable. */
                    className="answer-bank__btn-save"
                    /* Blocked mid-save and while the read is failed. */
                    disabled={disabled}
                    /* The user's click is the attestation; void because the handler reports via toast. */
                    onClick={() => void save(q)}
                  >
                    {/* In-flight feedback, since the re-read after a save takes a moment. */}
                    {savingKey === q.key ? 'Saving...' : 'Save'}
                  </button>
                </div>
              </div>
            );
          })}

          {/* Read-only: this answer comes from the master profile, not from a bank row. */}
          <div /* Same card as the editable fields, so the list reads as one set. */ className="eligibility__field">
            {/* Same head layout as the editable cards, with a neutral "derived" badge. */}
            <div /* Label-and-badge row, as above. */ className="eligibility__head">
              {/* A span, not a label: there is no input to label. */}
              <span className="eligibility__label">Previously worked at / consulted for &lt;company&gt;</span>
              {/* Tells Teja where this answer comes from, so he edits the profile, not the bank. */}
              <span className="eligibility__status eligibility__status--derived">From master profile</span>
            </div>
            {/* The rule in one line. */}
            <p className="eligibility__hint">Answered from your master profile&apos;s experience.</p>
            {/* Four honest states: loading, failed, nothing to list, or the list. */}
            {master === 'loading' ? (
              // Not yet known; saying "none" here would be a false claim.
              <p className="eligibility__hint">Loading master profile...</p>
            ) : master.kind === 'failed' ? (
              // A failed read is shown as failed, never as an empty work history.
              <p className="eligibility__hint" role="alert">
                {/* Verbatim message, for diagnosis. */}
                Master profile failed to load: {master.message}
              </p>
            ) : companies.length === 0 ? (
              // Two different empties: no profile at all, or a profile with no experience.
              <p className="eligibility__hint">
                {/* Distinguished so Teja knows whether to upload a profile or edit one. */}
                {profile === null ? 'No master profile loaded.' : 'No experience entries in your master profile.'}
              </p>
            ) : (
              // The companies the worker will treat as "previously worked at".
              <ul className="eligibility__companies">
                {/* Company name doubles as the key: the list is de-duplicated above. */}
                {companies.map((c) => (
                  // Name is unique after the de-dup, so it is a safe key.
                  <li key={c}>{c}</li>
                ))}
              </ul>
            )}
          </div>

          {/* Voluntary self-identification: Teja's own answers, or a blank field on the form. */}
          <h3 /* Sub-heading inside the same section, so it reads as part of eligibility. */ className="eligibility__subtitle">
            {/* Name from Teja's 2026-10-09 brief. */}
            Voluntary self-identification (EEO)
          </h3>
          {/* The rule in one line: unanswered stays blank, only saved answers are used. */}
          <p className="settings-group__note">
            {/* Wording from the brief, verbatim. */}
            Voluntary. Leave any of these unanswered and the field is left blank on applications.
            Only answers you save here are used.
          </p>
          {/* One card per EEO question; options come from the store's single copy. */}
          {eeoFields.map(({ eeo, loaded }) => {
            // Badge state from the loaded row, same rule as the fields above.
            const state = attestationState(loaded);
            // Draft, else the saved text, else '' (the "Not answered" choice). Never a default.
            const value = String(shown(loaded) ?? '');
            // Save only for an exact option string; "Not answered" can never be saved.
            const saveable = isSaveableValue(loaded, value);
            // Tied to the label for focus and screen readers.
            const inputId = `eligibility-${eeo.key}`;
            // The card.
            return (
              <div
                /* question_key is unique per user. */
                key={eeo.key}
                /* Same card as the fields above. */
                className="eligibility__field"
              >
                {/* Label and state badge on one row. */}
                <div className="eligibility__head">
                  {/* A real label for the select. */}
                  <label
                    /* Ties the label to the select. */
                    htmlFor={inputId}
                    /* Prompt styling. */
                    className="eligibility__label"
                    /* The worker's exact key as a tooltip, hidden from plain view like the cards above. */
                    title={eeo.key}
                  >
                    {/* Saved as question_text. */}
                    {eeo.asks}
                  </label>
                  {/* Words, not just colour, for each state. */}
                  <span className={`eligibility__status eligibility__status--${state}`}>
                    {/* Same three labels as above. */}
                    {STATE_LABEL[state]}
                  </span>
                </div>
                {/* A native select: exact strings only, no free text the form could refuse. */}
                <select
                  /* Tied to the label above. */
                  id={inputId}
                  /* The table's input styling, reused. */
                  className="answer-bank__input"
                  /* '' selects "Not answered"; nothing is ever pre-selected for Teja. */
                  value={value}
                  /* A draft only; Save is the write. */
                  onChange={(e) => setDraft(eeo.key, e.target.value)}
                >
                  {/* First and default choice; its '' value fails isSaveableEeoAnswer. */}
                  <option /* '' is outside every option list, so it is never saveable. */ value="">
                    {/* Wording from the brief. */}
                    Not answered (left blank)
                  </option>
                  {/* Verbatim option strings; the worker types the stored text as-is. */}
                  {eeo.options.map((o) => (
                    // The string is unique within one list, so it is a safe key.
                    <option key={o} value={o}>
                      {o}
                    </option>
                  ))}
                </select>
                {/* This one list is not in Greenhouse's API, so say it is unverified. */}
                {eeo.key === 'eeo_hispanic_latino' && (
                  <p className="eligibility__hint">
                    {/* The worker still refuses if the live form's options differ. */}
                    Options not verified against a live form.
                  </p>
                )}
                {/* The field's own Save, disabled while "Not answered" is selected. */}
                <div /* The table's action row spacing. */ className="answer-bank__edit-actions">
                  <button
                    /* Not a submit; the click handler is the single write path. */
                    type="button"
                    /* Same look as every other Save. */
                    className="answer-bank__btn-save"
                    /* Blocked for "Not answered", mid-save, and while the read is failed. */
                    disabled={!saveable || savingKey === eeo.key || savingAll || loadError !== null}
                    /* The loaded question carries the attested state; the store saves it. */
                    onClick={() => void save(loaded)}
                  >
                    {/* In-flight feedback. */}
                    {savingKey === eeo.key ? 'Saving...' : 'Save'}
                  </button>
                </div>
              </div>
            );
          })}

          {/* One button for the whole section: writes only the fields that differ from Teja's stored answers. */}
          <div /* Bar layout lives in settings.css. */ className="eligibility__save-all">
            <button
              /* Not a submit: the click handler is the write path. */
              type="button"
              /* The primary button style, so it reads as the section's main action. */
              className="btn-primary"
              /* Nothing to write, a run in flight, or a failed read: nothing to click. */
              disabled={planned.length === 0 || savingAll || savingKey !== null || loadError !== null}
              /* The user's click is the attestation for every listed field; void because results render below. */
              onClick={() => void saveAll()}
            >
              {/* The count tells Teja how many answers this click will store. */}
              {savingAll ? 'Saving...' : `Save all answers (${planned.length})`}
            </button>
            {/* Says why the button is idle, so a disabled button is never a mystery. */}
            {planned.length === 0 && !savingAll && (
              <span className="eligibility__hint">
                {/* True only when every shown answer is already stored as Teja's, or is blank. */}
                Nothing new to save.
              </span>
            )}
          </div>
          {/* Permanent polite live region: screen readers announce content added to an existing region,
              not a region mounted together with its content. */}
          <div aria-live="polite">
          {/* Per-field outcome of the last Save all. */}
          {saveAllResults !== null && saveAllResults.length > 0 && (
            <ul className="eligibility__results">
              {/* One line per field, in screen order. */}
              {saveAllResults.map((r) => (
                // question_key is unique within one run.
                <li
                  /* Unique per run. */
                  key={r.key}
                  /* Success or failure ink, from semantic tokens. */
                  className={r.ok ? 'eligibility__result--ok' : 'eligibility__result--bad'}
                >
                  {/* Words carry the outcome, so it does not depend on colour. */}
                  {r.ok ? `Saved: ${r.asks}` : `Not saved: ${r.asks} (${r.error ?? 'unknown error'})`}
                </li>
              ))}
            </ul>
          )}
          </div>
        </div>
      )}
    </section>
  );
}
