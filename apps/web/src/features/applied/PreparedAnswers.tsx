/* One applied row's "Answers prepared for this form" block (Teja, 2026-11-07). Pure: everything arrives
 * as props, so test/appliedSubmittedDetails.test.ts renders it with react-dom/server (no DOM lib here).
 * The words say "prepared", never "submitted": a kit is what the system prefilled (submittedDetails.ts). */

// Types only.
import type { ReactElement } from 'react';
// The Manual apply page's own choices view, reused (not mirrored) so both pages collapse a 240-option list alike.
import { FieldChoices } from '../manual-apply/ManualApplyPage';
// Type only: what this row's block shows.
import type { PreparedAnswers as PreparedAnswersState } from './submittedDetails';
// The page's date words, so this block and the row's applied date read alike.
import { dayText } from './appliedView';
// The kit-field classes live with the Manual apply page; imported, not copied, so the two never drift.
import '../manual-apply/ManualApply.css';

/* The block. `typedByHand` adds the caveat that the employer may have received different answers. */
export function PreparedAnswers(props: { readonly answers: PreparedAnswersState; readonly typedByHand: boolean }): ReactElement {
  // Destructured once.
  const { answers, typedByHand } = props;
  // Before the read answers: neither "none" nor an error is known.
  if (answers.kind === 'loading') return <span className="applied-row__muted">Reading the form answers…</span>;
  // A failed read is not "no answers": role=alert so it is announced.
  if (answers.kind === 'error') return <span className="applied-row__error" role="alert">Could not read the form answers: {answers.message}</span>;
  // The explicit empty state (Gushwork, eTeam live 2026-11-07).
  if (answers.kind === 'none') return <span className="applied-row__muted">No form answers on record.</span>;
  // A malformed newest kit: nothing shown rather than a list that looks complete.
  if (answers.kind === 'unreadable') return <span className="applied-row__muted">The prepared form answers could not be read (malformed kit).</span>;
  return (
    /* Collapsed by default, like the timeline, so the list of cards stays scannable. */
    <details className="applied-row__answers">
      {/* "Prepared", never "submitted"; the count says how much is inside. */}
      <summary>Answers prepared for this form ({answers.fields.length})</summary>
      {/* When the kit was built: tells two kits apart; "—" for a junk time. */}
      <p className="applied-row__muted">Prepared {dayText(answers.preparedAt)}.</p>
      {/* Only when the row was marked applied from Manual apply. */}
      {typedByHand ? <p className="applied-row__muted">You typed the final answers in the browser, so what the employer received may differ.</p> : null}
      {/* The Manual apply list styling: numbered in form order. */}
      <ol className="kit-card__fields">
        {/* Keyed by position: the form's order is the identity, and labels can repeat. */}
        {answers.fields.map((field, i) => (
          /* Missing required answers keep the Manual apply page's bronze highlight. */
          <li key={i} className={field.required && field.value === null ? 'kit-field kit-field--missing' : 'kit-field'}>
            {/* The form's own label, with the required star. */}
            <span className="kit-field__label">
              {/* Untrusted text, escaped by React. */}
              {field.label}
              {/* Named for screen readers. */}
              {field.required ? <span className="kit-field__required" aria-label="required"> *</span> : null}
            </span>
            {/* The prepared answer, or said missing. */}
            <span className="kit-field__value">{field.value ?? 'No answer'}</span>
            {/* Provenance, as on Manual apply. */}
            <span className="kit-field__source">{field.source.replace('_', ' ')}</span>
            {/* The select's choices, collapsed when long. */}
            <FieldChoices field={field} />
          </li>
        ))}
      </ol>
    </details>
  );
}
