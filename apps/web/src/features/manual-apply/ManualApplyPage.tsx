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
import { MANUAL_ACTION_STATUSES, screenMoves } from '../../data/humanLanes';
// The working resolve queues, reused whole, and their manual-action wording.
import { RecoveryMoves, RecoveryNotes, RecoveryQueue, manualActionMeaning, manualActionVerb, useRecoveryMoves } from '../health/RecoveryQueue';
// The kit's "Copy all" text.
import { copyAllText } from './applyKit';
// Types only: a kit, a field, the per-application state and a skip code.
import type { ApplyKit, KitField, KitSkipCode, KitState } from './applyKit';
// The Approval page's tailored-resume preview with its Download PDF, reused whole (never forked) so the
// resume printed here is byte-for-byte the one approved.
import { ResumePreview } from '../resume-preview/ResumePreview';
// The page's reads.
import { loadManualApply } from './manualApplyData';
// The pure rules behind the preview toggle and the select-choices display.
import { pressPreview } from './previewToggle';
// Same, for the choices.
import { choiceView } from './fieldChoices';// Type only: one row.
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

/* The id of a row's tailored-resume block: the preview button's aria-controls and its open target, from one
   function so the two can never drift apart. */
const resumeBlockId = (rowId: string): string => `tailored-resume-${rowId}`;

/* "Resume preview" / "Hide preview", beside the download (Teja, 2026-11-06; made a real toggle 2026-11-07
   after pressing it a second time did nothing). The preview sits inline in the card's <details> below: a
   press opens it (and scrolls to it) or closes it, and the label and aria-expanded follow the element, so
   the button also stays right when the operator clicks the <details> summary directly. Shown only when the
   row has a valid snapshot: otherwise it controls nothing. */
function ResumePreviewButton(props: { readonly rowId: string }): ReactElement {
  // Whether the block is open. Starts true because the card renders the block open; the effect below corrects it.
  const [open, setOpen] = useState(true);
  // Keep the label in step with the element, whoever toggles it (this button or the native summary).
  useEffect(() => {
    // The block this button controls; absent only if the card was re-rendered away.
    const block = document.getElementById(resumeBlockId(props.rowId));
    // Not a <details>: nothing to follow.
    if (!(block instanceof HTMLDetailsElement)) return undefined;
    // Read the element's real state once (the operator may have collapsed it before this mounted).
    setOpen(block.open);
    // The browser fires "toggle" after every open/close, from the button, the summary or the keyboard.
    const sync = (): void => setOpen(block.open);
    // Listening on the element itself, not the document, so other cards' blocks cannot disturb this label.
    block.addEventListener('toggle', sync);
    // Removed on unmount so a re-rendered card does not leak listeners.
    return () => block.removeEventListener('toggle', sync);
  }, [props.rowId]);
  // One press: toggle the element (pressPreview owns the rule and is unit tested), then show what it reports.
  const press = (): void => {
    // The block this button controls.
    const block = document.getElementById(resumeBlockId(props.rowId));
    // Only a real <details> is toggled; anything else is treated as "no block".
    setOpen(pressPreview(block instanceof HTMLDetailsElement ? block : null));
  };
  return (
    /* Same class as the download button so the two read as a pair; aria-controls names the block, aria-expanded its state. */
    <button type="button" className="kit-resume__button kit-resume__preview" aria-controls={resumeBlockId(props.rowId)} aria-expanded={open} onClick={press}>{open ? 'Hide preview' : 'Resume preview'}</button>
  );
}

/* A select/radio field's choices (Teja, 2026-11-07): a matched answer shows only its own option, no choices
   read shows nothing, and everything else sits behind a native disclosure with its count, never a wall of text. */
function FieldChoices(props: { readonly field: KitField }): ReactElement | null {
  // What to show for this answer against these options (pure, unit tested).
  const view = choiceView(props.field.value, props.field.options);
  // No options were read.
  if (view.kind === 'none') return null;
  // The answer names its option: just that, the exact one to pick.
  if (view.kind === 'matched') return <span className="kit-field__options">Choices: {view.picks.join(' | ')}</span>;
  return (
    /* Closed by default: the list is a lookup, not something to read. */
    <details className="kit-field__choices">
      {/* The count says how long the list is before it is opened. */}
      <summary>Show {view.options.length} choices</summary>
      {/* Every option, still reachable for a manual pick. */}
      <span className="kit-field__options">{view.options.join(' | ')}</span>
    </details>
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
      <FieldChoices field={field} />
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
  return screenMoves(status).filter((to) => KIT_RESOLVES.includes(to));
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

// The ISO-8601 shape PostgREST returns for a timestamptz. Proven before display because Date.parse is
// lenient ("-5" parses as year -5): a malformed approve time must read "unknown", never a wrong date.
const ISO_STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

/* An approve time as a <time> (exact stamp in dateTime, readable text in the operator's locale, as the
   Applied page formats times), or the plain words "approve time unknown" when it is missing or malformed. */
function ApproveTime(props: { readonly at: string | null }): ReactElement {
  // Absent or not the ISO shape: said, not guessed.
  if (props.at === null || !ISO_STAMP.test(props.at)) return <>approve time unknown</>;
  // The machine-readable stamp plus the same en-IN medium/short format AppliedJobsPage uses.
  return <time dateTime={props.at}>{new Date(props.at).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })}</time>;
}

/* The card's sentence for each skip code. A Record over the closed union, so a new code fails tsc here
   until it is given words. */
const SKIP_WORDS: Readonly<Record<KitSkipCode, string>> = {
  // The site's robots.txt refuses automated visits, so the worker never opened the form.
  robots_refused: 'Site refuses bots: apply by hand.',
  // The worker found the posting closed; it may have reopened, so the form link stays.
  posting_closed: 'Posting closed: check the form, and mark it failed if it is gone.',
};

/* The row's own tailored resume, kit or no kit (Teja, 2026-11-05: "the tailored resume must be there in
   the Manual apply section, kit or no kit"). Built in the browser from applications.tailored_profile and
   its pinned master by the shared ResumePreview, whose Download PDF prints it. Open by default: it is the
   one thing every manual application needs. */
function TailoredResume(props: { readonly row: ManualApplyRow }): ReactElement {
  // Destructured for readability.
  const { row } = props;
  // No valid snapshot: said, never a master shown under this job's name (resumeSnapshot.ts explains why).
  if (row.resume === null) return <p className="panel__note" role="note">No tailored resume on this row, so there is nothing to download here.</p>;
  return (
    /* Native details: keyboard-operable, and collapsible once the PDF is saved. */
    <details className="kit-card__resume" id={resumeBlockId(row.id)} open>
      {/* Names both things the block offers. */}
      <summary>Tailored resume: preview and Download PDF</summary>
      {/* The same props the Applied page and the pipeline drawer pass. */}
      <ResumePreview
        /* The row the preview belongs to, for unique element ids. */
        applicationId={row.id}
        /* The shape-checked snapshot. */
        tailoredProfile={row.resume}
        /* Its own pinned master version, so a later master edit cannot change what is printed. */
        masterVersion={row.resume.master_version}
        /* "—" for a missing job embed, never "null". */
        jobTitle={row.jobTitle ?? '—'}
        /* Same fallback as the title. */
        companyName={row.company ?? '—'}
      />
    </details>
  );
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
        {/* The tailored resume, opened inline: from the row's own snapshot, so it needs no kit. */}
        {row.resume !== null ? <ResumePreviewButton rowId={row.id} /> : null}
        {/* Copy every answer at once, for pasting into notes or a long form. */}
        {kit.kind === 'kit' ? <CopyButton text={copyAllText(kit.kit)} what="all answers" /> : null}
      </div>
      {/* The tailored resume, whatever the kit's state. */}
      <TailoredResume row={row} />
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
      {/* The kit body: skipped, none, unreadable, or the full form. Never a partial form. */}
      {kit.kind === 'skipped' ? (
        /* The worker refused the kit; without this the row read "Kit pending" forever. role=status so it is announced. */
        <p className="panel__note" role="status">
          {/* The code's sentence, then the worker's own detail when it gave one. */}
          <strong>Kit skipped.</strong> {SKIP_WORDS[kit.code]}{kit.reason !== '' ? <span className="kit-card__skip-reason"> ({kit.reason})</span> : null}
        </p>
      ) : kit.kind === 'none' && row.status === 'approved' ? (
        /* Approved, kit on its way: dispatch-apply starts the kit workflow on approve (5c3ce87), so this is
           a wait, not a fault. role=status so the state is announced; the kit-only actions above are absent. */
        <p className="panel__note" role="status">
          {/* The state, then when the wait began, then why the resume and answers are missing. */}
          <strong>Kit pending</strong>, approved <ApproveTime at={row.approvedAt} />. The resume and pre-answered fields appear here when the kit lands (usually within minutes); Refresh kits to check. You can still open the form and apply by hand.
        </p>
      ) : kit.kind === 'none' ? (
        /* No kit event for this application yet, and none is on its way at this status. */
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
      const result = await loadManualApply('page');
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
