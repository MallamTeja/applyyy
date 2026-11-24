/* GoneAfterReady (S40b, 2026-11-24; Teja: "i want a component that shows the jobs those are gone after appearing in
 * ready to tailor"). The passed_filters rows whose posting its board took down: S40 hides them from the Ready to tailor
 * lane (a read filter), and this collapsed section is where they stay visible, each with one-click Reject.
 *
 * A native <details>: collapsed by default, keyboard and screen-reader ready, no state to keep.
 * The "gone since" text comes from postingGoneNote, the SAME reader the drawer card uses, so the two never disagree.
 * Reject is one click with no confirm (no native dialogs ever; the move is undoable from the page's status line). */

import type { ReactElement } from 'react';

// Every board-supplied href goes through the http(s) gate.
import { safeHref } from '../../app/safeHref.ts';
// The new-tab cue the card's Apply link carries.
import { NewTabCue } from '../../app/SourceBadge';
// The one "is this posting gone, since when" reader.
import { postingGoneNote } from '../pipeline/DrawerAppCard.tsx';
// The card's own label rule, so a section row and a card name a job identically.
import { jobLabel } from './discoveredList.ts';
// Type only: the read's three states, defined beside the read itself.
import type { GoneState } from './discoveredList.ts';
// Only a real-shaped id gets a Reject the RPC can address.
import { isApplicationId } from '../pipeline/rowPipeline.ts';

import './GoneAfterReady.css';

/* Props: the read's state, and the page's Reject plumbing (the page owns the shared row lock and the Undo line). */
export function GoneAfterReady(props: {
  // What the read gave.
  readonly state: GoneState;
  // One-click reject of one row; the page runs it under the row lock.
  readonly onReject: (applicationId: string, label: string) => void;
  // Whether a row's lock is held (its Reject is then disabled).
  readonly isBusy: (applicationId: string) => boolean;
  // A failed Reject's sentence per row, or null/absent.
  readonly errors: Readonly<Record<string, string | null>>;
}): ReactElement {
  // Narrowed once for the summary and the body.
  const { state } = props;
  return (
    <details className="gone-after-ready" data-testid="gone-after-ready">
      {/* The count says how many are hidden from the lane; "?" while unknown, never 0. */}
      <summary className="gone-after-ready__summary">
        {/* The section's name, then the exact total. */}
        Gone after ready ({state.kind === 'rows' ? state.total : '?'})
      </summary>
      {/* Loading, failed and empty are each said in words. */}
      {state.kind === 'loading' ? (
        <p className="gone-after-ready__note">Loading gone postings…</p>
      ) : state.kind === 'error' ? (
        <p className="gone-after-ready__note" role="alert">Could not load gone postings: {state.message}</p>
      ) : state.rows.length === 0 ? (
        <p className="gone-after-ready__note">No Ready to tailor job has a gone posting.</p>
      ) : (
        <ul className="gone-after-ready__list">
          {state.rows.map((row) => {
            // The card's own label, for the Reject's accessible name and the status line.
            const label = jobLabel(row.job);
            // The shared reader; a non-date value is said as unreadable rather than guessed.
            const note = postingGoneNote(row.job.disappeared_at) ?? 'Posting gone (date unreadable)';
            // A failed Reject for this row, if any.
            const error = props.errors[row.id];
            return (
              <li key={row.id} className="gone-after-ready__row">
                {/* Company, bold, then the title. */}
                <span className="gone-after-ready__name">
                  {/* Company first, as on the card. */}
                  <strong>{row.job.company_name ?? 'Unknown company'}</strong> {row.job.title ?? 'Untitled job'}
                </span>
                {/* "Posting gone (since 2026-11-05)". */}
                <span className="gone-after-ready__since">{note}</span>
                {/* The posting itself, in case Teja wants to check it is really closed. */}
                <a href={safeHref(row.job.apply_url)} target="_blank" rel="noopener noreferrer" className="job-card__link">
                  {/* The cue announces the new tab. */}
                  <span>Apply Link<NewTabCue /></span>
                </a>
                {/* One click, no confirm: Undo on the page's status line takes it back. */}
                {isApplicationId(row.id) && (
                  <button
                    /* Not a submit: the page has no form. */
                    type="button"
                    /* The card's Reject look. */
                    className="button button--reject button--small"
                    /* Off while this row's lock is held. */
                    disabled={props.isBusy(row.id)}
                    /* The page runs it under the shared lock. */
                    onClick={() => props.onReject(row.id, label)}
                    /* Label-in-name, then the job. */
                    aria-label={`Reject: ${label}`}
                  >
                    {/* The visible name. */}
                    Reject
                  </button>
                )}
                {/* A Reject that did not land, under its row. */}
                {error ? <p className="job-card__reject-error" role="alert">{error}</p> : null}
              </li>
            );
          })}
        </ul>
      )}
    </details>
  );
}
