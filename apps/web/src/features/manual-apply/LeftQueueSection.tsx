/* "Left your queue" (2026-11-07): the jobs Teja approved that are no longer waiting for him, each with who
 * moved it and why. Collapsed by default: it is an audit trail, not a lane, so it must not push the real
 * work down the page.
 *
 * PURE VIEW. The read, the locks and the write all arrive as props, and so does the status rule
 * (`reopenTarget`): the section holds no state of its own, so a static render in a test shows exactly what
 * the page would. Every value shown is shape-proven first (a time must be ISO, a link must pass safeHref),
 * because a wrong date or a javascript: link on an audit trail is worse than a blank. */

// Types only: the component's return type.
import type { ReactElement } from 'react';
// Type only: the status union, for the move target.
import type { ApplicationStatus } from '../../data/contract';
// The one URL guard the page already uses: only http(s) becomes an href.
import { safeHref } from '../../app/safeHref';
// The shared inline confirm: no native dialogs anywhere in src (enforced by test/inlineConfirm.test.ts).
import { InlineConfirm, armConfirm } from '../../app/InlineConfirm';
// Types only: the data module's contract.
import type { LeftQueueRead, LeftQueueRow } from './leftQueue';

// The ISO-8601 shape PostgREST returns for a timestamptz (same proof as ManualApplyPage): Date.parse is
// lenient ("-5" is year -5), so the shape is checked before any date is built.
const ISO_STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

/* A time as a <time>, or the words "time unknown" when it does not prove its shape. Callers omit a null
   time before this, so the word is only ever for a malformed one. */
function Stamp(props: { readonly at: string }): ReactElement {
  // Malformed: said, never a wrong date.
  if (!ISO_STAMP.test(props.at)) return <>time unknown</>;
  // Machine stamp plus the same en-IN format the other pages use.
  return <time dateTime={props.at}>{new Date(props.at).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })}</time>;
}

/* Who moved the row, in words. 'human' is also every retro script run under Teja's JWT, so its stage tells
   the two apart. */
function actorWords(actor: string, stage: string | null): string {
  // A clean-up script ran as Teja's account: not Teja's own click.
  if (actor === 'human') return stage !== null && stage.startsWith('retro_') ? 'a clean-up script' : 'you';
  // A machine agent, by name.
  return `the ${actor}`;
}

/* The reason line: the sentence, else the code as words, else an honest blank. */
function reasonWords(row: LeftQueueRow): string {
  // The human sentence wins.
  if (row.reason !== null) return row.reason;
  // The machine code, readable.
  if (row.code !== null) return row.code.replace(/_/g, ' ');
  // Nothing was written down: say so rather than imply a cause.
  return 'No reason was recorded.';
}

/* One row of the list. */
function LeftQueueItem(props: {
  readonly row: LeftQueueRow;
  readonly locked: boolean;
  readonly frozen: boolean;
  readonly target: ApplicationStatus | null;
  readonly onReopen: (row: LeftQueueRow, to: ApplicationStatus) => void;
}): ReactElement {
  // Destructured once for readability below.
  const { row, locked, frozen, target, onReopen } = props;
  // The job link, only when the URL proves http(s); undefined means plain text.
  const href = safeHref(row.applyUrl);
  // The confirm slot id: unique per row and distinct from the other queues' slots.
  const confirmId = `left:${row.id}`;
  // The "moved ..." clause exists only when some part of the move is known.
  const hasMove = row.leftAt !== null || row.leftFrom !== null || row.actor !== null;
  return (
    /* Keyed by the caller; one line of audit per job. */
    <li className="left-queue__row">
      {/* The job, linked only when the URL is safe. */}
      {href !== undefined ? <a href={href} target="_blank" rel="noopener noreferrer">{row.label}</a> : <span>{row.label}</span>}
      {/* Where it is now. */}
      {' '}<span className="identifier">{row.status}</span>
      {/* Who, when, from where; null parts are left out, never printed. */}
      <p className="left-queue__meta">
        {/* The approve time, when one was recorded. */}
        {row.approvedAt !== null ? <>Approved <Stamp at={row.approvedAt} /></> : null}
        {/* The comma only between two clauses that both exist. */}
        {row.approvedAt !== null && hasMove ? ', ' : null}
        {/* The move, built from whichever parts are known. */}
        {hasMove ? (
          <>
            {/* The verb is always there once any part is. */}
            moved
            {/* When. */}
            {row.leftAt !== null ? <> <Stamp at={row.leftAt} /></> : null}
            {/* From which lane. */}
            {row.leftFrom !== null ? <> from {row.leftFrom}</> : null}
            {/* By whom, in words. */}
            {row.actor !== null ? <> by {actorWords(row.actor, row.stage)}</> : null}
          </>
        ) : null}
      </p>
      {/* Why, in the best words on file. */}
      <p className="left-queue__reason">
        {reasonWords(row)}
        {/* Which script or screen wrote it, muted, when known. */}
        {row.stage !== null ? <> <span className="identifier">{row.stage}</span></> : null}
        {/* The source, when it adds something the stage did not. */}
        {row.source !== null && row.source !== row.stage ? <> <span className="identifier">{row.source}</span></> : null}
      </p>
      {/* A way back exists only for some statuses; none means no button and no empty space. */}
      {target !== null ? (
        /* The confirm opens in place of the button, as on the other queues. */
        <InlineConfirm id={confirmId}>
          {/* Wrapper so the reload sentence sits under its button. */}
          <div className="recovery__move">
            <button
              /* Never a form submit. */
              type="button"
              /* The same look as the recovery buttons. */
              className="health-recovery-button"
              /* Off while a write is in flight or its outcome is unknown. */
              disabled={locked || frozen}
              /* Names the row: every row has the same verb. */
              aria-label={`Re-open: ${row.label}`}
              /* Opens the confirm; nothing is written until its Confirm. */
              onClick={(e) => armConfirm(confirmId, {
                // Plain words: what happens and where it goes next.
                message: `Re-open "${row.label}"? It goes to ${target} and comes back under the manual-apply lanes so you can check it by hand.`,
                // The confirm's own button names.
                action: `Re-open: ${row.label}`,
                // The one write, called at most once by Confirm.
                onConfirm: () => onReopen(row, target),
                // For focus return on Cancel.
                trigger: e.currentTarget,
              })}
            >
              {/* The visible word. */}
              Re-open
            </button>
            {/* After an unknown outcome the page state is stale; only a reload is safe. */}
            {frozen ? <p className="left-queue__meta">Reload the page before moving this again.</p> : null}
          </div>
        </InlineConfirm>
      ) : null}
    </li>
  );
}

/* The whole section. */
export function LeftQueueSection(props: {
  // Loading, error or the rows.
  readonly read: LeftQueueRead;
  // True while a write on this id is in flight (or frozen).
  readonly locked: (id: string) => boolean;
  // True after an unknown outcome on this id.
  readonly frozen: (id: string) => boolean;
  // The status a Re-open sends this status to, or null for no button; passed in so the view owns no rule.
  readonly reopenTarget: (status: ApplicationStatus) => ApplicationStatus | null;
  // Called only from the inline confirm's Confirm.
  readonly onReopen: (row: LeftQueueRow, to: ApplicationStatus) => void;
}): ReactElement {
  // Destructured once for readability below.
  const { read, locked, frozen, reopenTarget, onReopen } = props;
  // The summary says the count only when it is known, and says an unreadable list is unreadable.
  const title = read.kind === 'ready' ? `Left your queue (${read.rows.length})` : read.kind === 'error' ? 'Left your queue (could not read)' : 'Left your queue';
  return (
    /* Native details, collapsed (no open attribute): the audit trail stays out of the way. */
    <details className="panel left-queue" aria-label="Left your queue">
      {/* The always-visible line. */}
      <summary>{title}</summary>
      {/* What the section is, so the lines below need no explaining. */}
      <p className="panel__note">Jobs you approved that are no longer waiting for you. Each line says who moved it and why.</p>
      {/* Three honest states. */}
      {read.kind === 'loading' ? (
        /* Before the first answer. */
        <p className="panel__note">Reading what left your queue…</p>
      ) : read.kind === 'error' ? (
        /* role=alert: an unreadable audit trail should be noticed. */
        <p className="panel__note" role="alert">Could not read what left your queue: {read.message}</p>
      ) : read.rows.length === 0 ? (
        /* Only after a successful read. */
        <p className="panel__clear">Nothing has left your queue.</p>
      ) : (
        /* One line per job. */
        <ul className="left-queue__list">
          {read.rows.map((row) => (
            /* Keyed by application id, so a row's confirm follows it. */
            <LeftQueueItem key={row.id} row={row} locked={locked(row.id)} frozen={frozen(row.id)} target={reopenTarget(row.status)} onReopen={onReopen} />
          ))}
        </ul>
      )}
    </details>
  );
}
