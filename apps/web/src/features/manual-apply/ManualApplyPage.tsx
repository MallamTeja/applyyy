/* Manual apply: every job the operator must apply to BY HAND, with the whole form pre-answered from
 * our own data, so a captcha-protected application takes a minute (2026-10-24).
 *
 * WHY THIS PAGE. Greenhouse's captcha refuses CI submits, so some applications can only be sent from
 * Teja's own browser. The worker writes a "kit" per application (applyKit.ts has the contract); this
 * page lays it out in FORM ORDER with a Copy button per answer, the resume to download, and the
 * existing resolve buttons, so nothing has to be looked up while the form is open.
 *
 * WHAT IT REUSES (ponytail): the resolves are the System health RecoveryQueue components themselves
 * (same confirm, locks and advance_application_status path), the link guard is safeHref, and the
 * lanes are humanLanes.ts MANUAL_ACTION_STATUSES. Nothing here writes a status except through them.
 *
 * RESOLVE ON THE CARD (2026-11-05, Teja): every card carries "I applied (mark applied)" and
 * "Failed / skip", so a job applied to by hand is recorded where it was applied from. The buttons are
 * RecoveryMoves and the write is useRecoveryMoves, the very pieces the System health queues use; the
 * moves come from the graph (approved gained both human edges in migration 20261105121500), narrowed
 * to those two by kitResolveMoves. A card at `applying` has none: the worker owns that row. A card in a
 * manual-action lane has none either: its row is resolved in the queue under "After you apply", and two
 * sets of buttons for one row would mean two lock owners that cannot see each other's moves. */

// State for the read, the per-field copy feedback and the resume download.
import { useCallback, useEffect, useState } from 'react';
// Type only: the status union, for the move filter.
import type { ApplicationStatus } from '../../data/contract';
// The graph: the human moves out of a card's status.
import { nextStatuses } from '../../data/contract';
// The component return type, as elsewhere.
import type { ReactElement } from 'react';
// In-app link to the Answer bank, without a full page reload.
import { Link } from 'react-router-dom';
// The page heading, looked up from routes.ts so it matches the rail.
import { PageHeader } from '../../app/PageHeader';
// The one gate between untrusted URLs and an href.
import { safeHref } from '../../app/safeHref';
// The shared client, for the signed resume URL.
import { supabase } from '../../data/supabase';
// The two manual-action lanes whose resolves this page offers, shared with System health and the badge.
import { MANUAL_ACTION_STATUSES } from '../../data/humanLanes';
// The working resolve queues, reused whole, and their manual-action wording.
import { RecoveryMoves, RecoveryNotes, RecoveryQueue, manualActionMeaning, manualActionVerb, useRecoveryMoves } from '../health/RecoveryQueue';
// The kit's "Copy all" text.
import { copyAllText } from './applyKit';
// Types only: a kit, a field and the per-application state.
import type { ApplyKit, KitField, KitState } from './applyKit';
// The page's reads.
import { loadManualApply } from './manualApplyData';
// Type only: one row.
import type { ManualApplyRow } from './manualApplyData';
// The recovery queues' table styles, reused rather than copied.
import '../health/health.css';
// This page's own styles.
import './ManualApply.css';

// The private bucket the worker uploads attached resumes to (supabase-gateway.ts resumeBucket default).
const RESUME_BUCKET = 'resumes';
// A signed link only needs to outlive one click.
const SIGNED_URL_SECONDS = 60;

/* One copy button. Shows "Copied" on success and says so when the browser refuses, because a silent
   failure would have the operator paste whatever was on the clipboard before. */
export function CopyButton(props: { readonly text: string; readonly what: string }): ReactElement {
  // idle, copied, or failed: the visible feedback.
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  // One click: write, then report.
  const copy = async (): Promise<void> => {
    try {
      // The async clipboard API; rejects without permission or outside a secure context.
      await navigator.clipboard.writeText(props.text);
      // Confirmed.
      setState('copied');
    } catch {
      // Refused: the operator must select the text by hand, and is told so.
      setState('failed');
    }
  };
  return (
    /* The button and its feedback travel together. */
    <span className="kit-copy">
      {/* type=button so it can never submit anything; aria-label names what is copied. */}
      <button type="button" className="kit-copy__button" aria-label={`Copy ${props.what}`} onClick={() => void copy()}>
        {/* The verb, or the confirmation. */}
        {state === 'copied' ? 'Copied' : 'Copy'}
      </button>
      {/* Only on failure: what to do instead. role=status so it is announced. */}
      {state === 'failed' ? <span className="kit-copy__failed" role="status">Copy blocked by the browser: select the text and copy it by hand.</span> : null}
    </span>
  );
}

/* The resume download: a short-lived signed URL from the private bucket, fetched on click so a stale
   link is never on screen. Errors are shown beside the button. */
function ResumeDownload(props: { readonly resume: NonNullable<ApplyKit['resume']> }): ReactElement {
  // The last failure, or null.
  const [error, setError] = useState<string | null>(null);
  // One click: sign, then navigate to the attachment (download) URL.
  const download = async (): Promise<void> => {
    // No client: said.
    if (supabase === null) return setError('Not connected to the database.');
    // Signed for one minute, with the kit's file name as the download name; RLS limits it to the owner's prefix.
    const { data, error: signError } = await supabase.storage.from(RESUME_BUCKET).createSignedUrl(props.resume.storagePath, SIGNED_URL_SECONDS, { download: props.resume.fileName });
    // supabase-js returns the error; it does not throw.
    if (signError || !data?.signedUrl) return setError(signError?.message ?? 'No download link was returned.');
    // Cleared on success.
    setError(null);
    // The URL carries Content-Disposition: attachment, so this downloads and the page stays.
    window.location.assign(data.signedUrl);
  };
  return (
    /* Button plus its error line. */
    <span className="kit-resume">
      {/* Names the file, so the operator knows which version is attached. */}
      <button type="button" className="kit-resume__button" onClick={() => void download()}>Download resume ({props.resume.fileName})</button>
      {/* The failure, when there is one. */}
      {error !== null ? <span className="kit-copy__failed" role="alert">{error}</span> : null}
    </span>
  );
}

/* One field row: label, answer, provenance, and a Copy button where pasting makes sense. */
function KitFieldRow(props: { readonly field: KitField; readonly index: number }): ReactElement {
  // Destructured for readability.
  const { field, index } = props;
  // A required field we have no answer for: the one thing that will stop the submit.
  const missing = field.required && (field.source === 'unanswered' || field.value === null);
  return (
    /* data-field-index pins form order for the tests and for anyone inspecting the page. */
    <li className={missing ? 'kit-field kit-field--missing' : 'kit-field'} data-field-index={index}>
      {/* The form's label, with the required marker the form itself shows. */}
      <span className="kit-field__label">
        {/* The label text. */}
        {field.label}
        {/* Required marker, spelled out for screen readers. */}
        {field.required ? <span className="kit-field__required" aria-label="required"> *</span> : null}
      </span>
      {/* The answer, selectable as plain text so a blocked clipboard still leaves a way to copy it. */}
      <span className="kit-field__value">{field.value ?? 'No answer'}</span>
      {/* Where the answer came from, so trust can be judged before pasting. */}
      <span className="kit-field__source">{field.source.replace('_', ' ')}</span>
      {/* The choices of a select or radio, so a value can be matched to the option list. */}
      {field.options !== null && field.options.length > 0 ? <span className="kit-field__options">Choices: {field.options.join(' | ')}</span> : null}
      {/* Copy for typed answers; a file input takes the downloaded resume instead. */}
      {field.inputType !== 'file' && field.value !== null ? <CopyButton text={field.value} what={field.label} /> : null}
      {/* The file input's instruction. */}
      {field.inputType === 'file' ? <span className="kit-field__hint">Attach the downloaded resume.</span> : null}
      {/* A required gap points at where it gets answered once, for every later form. */}
      {missing ? <Link className="kit-field__fix" to="/answer-bank">Answer this in the Answer bank</Link> : null}
    </li>
  );
}

// The only moves a card offers: finishing the application, either way. Other human edges (approved ->
// passed_filters, blocked_needs_human -> dropped_filter) stay on their own screens.
const KIT_RESOLVES: readonly ApplicationStatus[] = ['applied', 'failed'];

/* The resolve moves a card at `status` offers: the graph's human edges, narrowed to KIT_RESOLVES. From the
   graph, so a status without the edge gets no button the database would refuse. Exported for the test. */
export function kitResolveMoves(status: ApplicationStatus): readonly ApplicationStatus[] {
  // A lane row's buttons live in its queue below (one lock owner per row); the card points there.
  if (MANUAL_ACTION_STATUSES.includes(status)) return [];
  // Graph first, then the narrowing; order follows the graph.
  return nextStatuses(status, 'human').filter((to) => KIT_RESOLVES.includes(to));
}

/* What a card needs to resolve its row: the lock state and the confirmed write. The page owns both. */
export interface KitResolve {
  // A move is in flight on this row, or its last one ended unknown.
  readonly locked: boolean;
  // Its last move ended unknown: reload before moving it again.
  readonly frozen: boolean;
  // The write, called only from the inline confirm's Confirm.
  readonly onMove: (to: ApplicationStatus) => void;
}

/* One job's card. Pure: everything arrives as props, so a static render tests exactly what is shown.
   `resolve` is required, so a card can never be drawn with its resolve buttons silently missing. */
export function KitCard(props: { readonly row: ManualApplyRow; readonly kit: KitState; readonly resolve: KitResolve }): ReactElement {
  // Destructured for readability.
  const { row, kit, resolve } = props;
  // This card's resolve moves; empty at applying.
  const moves = kitResolveMoves(row.status);
  // The kit's form URL first (it is the page the kit was read from), else the job's apply URL; both via safeHref.
  const formHref = safeHref(kit.kind === 'kit' ? kit.kit.formUrl : row.applyUrl);
  return (
    /* One panel per job, named for screen-reader landmarks. */
    <section className="panel kit-card" aria-label={`Manual apply: ${row.label}`}>
      {/* The job, and the lane it is waiting in. */}
      <h2 className="panel__title">
        {/* Same label as the recovery queues. */}
        {row.label} <span className="identifier">{row.status}</span>
      </h2>
      {/* The two actions that start an application by hand. */}
      <div className="kit-card__actions">
        {/* New tab so this page stays open beside the form; noopener noreferrer gives the employer page no handle back. */}
        {formHref !== undefined ? (
          /* The vetted link. */
          <a className="kit-card__open" href={formHref} target="_blank" rel="noopener noreferrer">Open the form</a>
        ) : (
          /* Said, not hidden. */
          <span className="recovery__held">Form link unavailable (missing, or not a safe http(s) URL).</span>
        )}
        {/* The resume, when the kit names one. */}
        {kit.kind === 'kit' && kit.kit.resume !== null ? <ResumeDownload resume={kit.kit.resume} /> : null}
        {/* Copy every answer at once, for pasting into notes or a long form. */}
        {kit.kind === 'kit' ? <CopyButton text={copyAllText(kit.kit)} what="all answers" /> : null}
      </div>
      {/* After applying by hand: record it here. At applying the worker owns the row, which is said. */}
      {row.status === 'applying' ? (
        /* No button: a human move out of applying would race a live submit. */
        <p className="panel__note">In flight: the worker owns it. If it stalls, it moves to System health for you to check.</p>
      ) : MANUAL_ACTION_STATUSES.includes(row.status) ? (
        /* Its queue below owns the buttons and their locks. */
        <p className="panel__note">After you apply, resolve it below under "After you apply: resolve".</p>
      ) : moves.length > 0 ? (
        /* The System health buttons themselves, with a kit-card confirm slot so the queue below never shares it. */
        <div className="kit-card__resolve">
          {/* No lease: only applying has one, and applying gets no buttons. */}
          <RecoveryMoves confirmId={`kit:${row.status}:${row.id}`} status={row.status} row={row} moves={moves} verb={manualActionVerb} meaning={manualActionMeaning} locked={resolve.locked} frozen={resolve.frozen} lease={null} onMove={resolve.onMove} />
        </div>
      ) : null}
      {/* The kit body: none, unreadable, or the full form. Never a partial form. */}
      {kit.kind === 'none' ? (
        /* No kit event for this application yet. */
        <p className="panel__note">Kit not generated yet: ask the orchestrator to generate it.</p>
      ) : kit.kind === 'unreadable' ? (
        /* role=alert: a kit that cannot be trusted must not be used, and the reason says what broke. */
        <p className="panel__note kit-card__unreadable" role="alert">Kit unreadable ({kit.reason}). Do not apply from it; ask the orchestrator to regenerate it.</p>
      ) : (
        /* A fragment: warnings above the fields. */
        <>
          {/* Warnings first, so they are read before anything is pasted. */}
          {kit.kit.warnings.length > 0 ? (
            /* A plain list; each warning one item. */
            <ul className="kit-card__warnings" role="note">
              {/* Keyed by position: warnings are a fixed list for this kit. */}
              {kit.kit.warnings.map((w, i) => <li key={i}>{w}</li>)}
            </ul>
          ) : null}
          {/* The fields, in the order the form asks them. */}
          <ol className="kit-card__fields">
            {/* Keyed by position, which IS the form order. */}
            {kit.kit.fields.map((f, i) => <KitFieldRow key={i} field={f} index={i} />)}
          </ol>
        </>
      )}
    </section>
  );
}

/* The page's read: loading, failed, or the rows with their kits. */
type PageRead =
  // Before the first answer.
  | { readonly kind: 'loading' }
  // A failed read, shown instead of an empty page.
  | { readonly kind: 'error'; readonly message: string }
  // The rows and each one's kit state.
  | { readonly kind: 'ready'; readonly rows: readonly ManualApplyRow[]; readonly kits: ReadonlyMap<string, KitState> };

// The kit state for an application with no kit event.
const NO_KIT: KitState = { kind: 'none' };

export function ManualApplyPage(): ReactElement {
  // The current read.
  const [read, setRead] = useState<PageRead>({ kind: 'loading' });
  // One read of everything; failures land as the error state.
  const load = useCallback(async () => {
    try {
      // Rows and kits together.
      const result = await loadManualApply();
      // Shown either way.
      setRead('error' in result ? { kind: 'error', message: result.error } : { kind: 'ready', rows: result.rows, kits: result.kits });
    } catch {
      // A broken client is a failed read, not an empty one.
      setRead({ kind: 'error', message: 'The manual-apply list could not be read.' });
    }
  }, []);
  // The card resolves: the System health locks, strip and write; each move re-reads the page so a resolved card leaves.
  const { busy, frozen, notes, move } = useRecoveryMoves(load, 'manual_apply');
  // Read on mount.
  useEffect(() => {
    // load never throws.
    void load();
  }, [load]);

  return (
    /* The page body. */
    <div className="page">
      {/* Heading and lede from routes.ts. */}
      <PageHeader path="manual-apply" />
      {/* What each card resolve did, kept after the card leaves (a landed move removes it). */}
      <RecoveryNotes notes={notes} />
      {/* Three honest states. */}
      {read.kind === 'loading' ? (
        /* Before the first answer. */
        <p className="panel__note">Reading the jobs to apply by hand…</p>
      ) : read.kind === 'error' ? (
        /* role=alert: an unreadable list is exactly when a job would be missed. */
        <p className="panel__note" role="alert">Could not read the manual-apply list: {read.message}</p>
      ) : read.rows.length === 0 ? (
        /* Only after a successful read. */
        <p className="panel__clear">Nothing to apply by hand right now.</p>
      ) : (
        /* One card per job, urgent lanes first. */
        read.rows.map((row) => (
          /* Keyed by application id: the card, its locks and its confirm slot all follow the same row. */
          <KitCard
            key={row.id}
            /* The validated row, with the stamp the move sends back. */
            row={row}
            /* Its newest kit, or "not generated yet". */
            kit={read.kits.get(row.id) ?? NO_KIT}
            /* In flight or frozen locks the buttons; frozen alone adds the reload sentence; the write runs through the shared move path. */
            resolve={{ locked: busy.has(row.id) || frozen.has(row.id), frozen: frozen.has(row.id), onMove: (to) => void move(row, row.status, to) }}
          />
        ))
      )}
      {/* The resolves, reused whole from System health: after applying by hand, mark it here. */}
      <section className="panel" aria-label="Resolve manual applications">
        {/* What these buttons are for. */}
        <h2 className="panel__title">After you apply: resolve</h2>
        {/* Each queue re-reads after a move; re-read the kits too with Refresh. */}
        <p className="panel__note">Mark each job once you have applied (or given up). <button type="button" className="kit-resume__button" onClick={() => void load()}>Refresh kits</button></p>
        {/* The unknown-outcome lane. */}
        {MANUAL_ACTION_STATUSES.map((status) => (
          /* Keyed by lane. */
          <div key={status} className="kit-resolve">
            {/* Which lane. */}
            <h3 className="kit-resolve__title"><span className="identifier">{status}</span></h3>
            {/* The working queue, with the manual-action wording. */}
            <RecoveryQueue source="manual_apply" status={status} verb={manualActionVerb} meaning={manualActionMeaning} />
          </div>
        ))}
      </section>
    </div>
  );
}
