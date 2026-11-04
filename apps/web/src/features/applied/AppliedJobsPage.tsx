/* Applied jobs (/applied) - every application past a confirmed submission, with its stage, the
 * resume that was sent, and what has happened since. Asked for by Teja, approved 2026-11-04 20:20 IST.
 *
 * WHAT IT READS. One select of applications at the six post-apply stages, with the job, the
 * status_change events and the tracker's matched emails embedded; and the human edges of
 * application_status_transitions. The rules over both live in appliedView.ts (pure, tested).
 *
 * WHAT IT WRITES. One thing: a stage move, through advance_application_status as 'human' with the
 * row's updated_at stamp, after an INLINE confirm (no browser dialogs: Teja's ruling 19:06 IST
 * 2026-11-04). The buttons a row shows are exactly the edges the live table holds for its status;
 * a failed read of the table shows no buttons rather than a remembered graph.
 *
 * WHAT IT DOES NOT HAVE. A cover letter: the worker never attaches one, so the page says so. And
 * often a stored resume file (live 2026-11-04: 1 of 2 applied rows has a path); then the frozen
 * approved resume is rebuilt in the browser, labelled as a rebuild so it is never taken for the file.
 *
 * WHY THE VIEWS ARE PURE. AppliedListView and AppliedRowView take everything as props, so a static
 * render in test/appliedPage.test.ts draws exactly what the operator sees (apps/web has no DOM lib).
 * AppliedJobsPage alone owns state, reads and the write. */

// State, the reload callback, the in-flight lock, the read sequence.
import { useCallback, useEffect, useRef, useState } from 'react';
// Types only.
import type { ReactElement } from 'react';
// The app's single client; null when unconfigured, and every caller says so.
import { supabase } from '../../data/supabase';
// Title and lede from the route table, like every other page.
import { PageHeader } from '../../app/PageHeader';
// The stage chip: the app's badge, with this page's label.
import { StatusBadge } from '../../app/StatusBadge';
// The in-place "are you sure?" that replaced the browser's confirm popup.
import { InlineConfirm, armConfirm } from '../../app/InlineConfirm';
// Every stored URL that becomes an href goes through this (apply_url is untrusted).
import { safeHref } from '../../app/safeHref';
// The existing prep panel, rendered for rows at interview; it reads its own pack.
import { InterviewPrepPanel } from '../pipeline/InterviewPrepPanel';
// The existing preview, for rebuilding the frozen approved resume when no file was stored.
import { ResumePreview } from '../resume-preview/ResumePreview';
// Type only: the frozen resume the rebuild renders.
import type { ResolvedResume } from '../../data/contract';
// The page's rules.
import {
  APPLIED_SORT_LABELS,
  APPLIED_STAGES,
  DEFAULT_APPLIED_VIEW,
  STAGE_LABELS,
  applyAppliedView,
  buildMoveArgs,
  countByStage,
  daysSince,
  daysSinceText,
  dayText,
  fileNameOf,
  legalNextStages,
  moveErrorText,
  readAppliedRow,
  readEdges,
  statusText,
} from './appliedView';
// Types only.
import type { AppliedRow, AppliedSort, AppliedStage, AppliedView, StageEdge, StageFilter, TimelineItem } from './appliedView';
// The page's layout; semantic tokens only.
import './Applied.css';

// One read's cap; one more is fetched so an overflow is SAID, never silently cut.
const APPLIED_LIMIT = 500;
// A signed link only needs to outlive one click (the same window as ManualApplyPage).
const SIGNED_URL_SECONDS = 60;
// Everything one row needs, in one request. Events are filtered to status_change by the query below.
const APPLIED_SELECT =
  'id, status, updated_at, applied_at, resume_storage_path, screenshot_storage_path, tailored_profile, ' +
  'jobs:job_id(title, company_name, locations, apply_url), ' +
  'application_events(event_type, from_status, to_status, created_at), ' +
  'email_events(from_address, subject, received_at, classification)';

/* The rows read: three honest states, and an empty list only after a successful read. */
export type RowsRead =
  // Before the first answer.
  | { readonly kind: 'loading' }
  // The read failed; its words are kept.
  | { readonly kind: 'error'; readonly message: string }
  // The validated rows, and whether the cap cut the list.
  | { readonly kind: 'rows'; readonly rows: readonly AppliedRow[]; readonly more: boolean };

/* The transitions read, separate from the rows: a row list is still useful when the graph is not. */
export type EdgesRead =
  // Before the first answer: no buttons yet.
  | { readonly kind: 'loading' }
  // The graph could not be read: no buttons, and the reason.
  | { readonly kind: 'error'; readonly message: string }
  // The human edges between page stages.
  | { readonly kind: 'ok'; readonly edges: readonly StageEdge[] };

/* "Backend Engineer at Stripe": the row in words, for button names and the confirm. */
function rowName(row: AppliedRow): string {
  // "—" for a missing part, so the name never reads "null at null".
  return `${row.title ?? '—'} at ${row.company ?? '—'}`;
}

/* A time for the timeline, or "—". */
function momentText(at: number | null): string {
  // Missing is said as missing.
  if (at === null) return '—';
  // Date and time in the operator's locale; short enough for a phone line.
  return new Date(at).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });
}

/* One button that signs a private file on click and downloads it; the link is never on screen, so
   it can never be stale. Errors are shown beside it; supabase-js returns them, it does not throw. */
function SignedDownload(props: {
  // The private bucket the worker uploaded to.
  readonly bucket: 'resumes' | 'screenshots';
  // The stored path, already shape-checked by readStoragePath.
  readonly path: string;
  // The button's visible text.
  readonly label: string;
  // The button's accessible name, with its row.
  readonly name: string;
}): ReactElement {
  // The last failure, or null.
  const [error, setError] = useState<string | null>(null);
  // Sign, then navigate to the attachment URL; the page stays because the response is a download.
  const download = async (): Promise<void> => {
    // No client: said, not skipped.
    if (supabase === null) return setError('Not connected to the database.');
    // Signed for one minute, named after the stored file; storage RLS limits it to the owner's prefix.
    const { data, error: signError } = await supabase.storage.from(props.bucket).createSignedUrl(props.path, SIGNED_URL_SECONDS, { download: fileNameOf(props.path) });
    // A returned error, or an answer without a URL, is a failure in its own words.
    if (signError || !data?.signedUrl) return setError(signError?.message ?? 'No download link was returned.');
    // Cleared on success.
    setError(null);
    // Content-Disposition: attachment, so this downloads and the page stays.
    window.location.assign(data.signedUrl);
  };
  return (
    /* The button and its failure, together. */
    <span className="applied-row__doc">
      {/* type=button: never a form submit; the name carries the row. */}
      <button type="button" className="button button--small" aria-label={props.name} onClick={() => void download()}>{props.label}</button>
      {/* Shown only after a failed sign; role=alert so it is announced. */}
      {error !== null ? <span className="applied-row__error" role="alert">{error}</span> : null}
    </span>
  );
}

/* The frozen approved resume, rebuilt in the browser. Native <details>: keyboard-operable for free,
   and the preview mounts only when opened, so a closed row costs no master read. */
function RebuiltResume(props: { readonly row: AppliedRow; readonly resume: ResolvedResume }): ReactElement {
  // Whether the details is open; the preview renders only then.
  const [open, setOpen] = useState(false);
  return (
    /* onToggle mirrors the native open state. */
    <details className="applied-row__rebuild" onToggle={(e) => setOpen(e.currentTarget.open)}>
      {/* The exact label Teja asked for, so a rebuild is never taken for the file that was sent. */}
      <summary>Rebuilt from the approved resume — not the uploaded file</summary>
      {/* The existing preview, pinned to the resume's own master version, in a box that scrolls on a phone. */}
      {open ? (
        /* Its own horizontal scroll, so the page never scrolls sideways. */
        <div className="applied-row__preview">
          {/* Same props the pipeline drawer passes. */}
          <ResumePreview
            /* The row the preview belongs to. */
            applicationId={props.row.id}
            /* The frozen approved resume, already shape-checked by readResumeSnapshot. */
            tailoredProfile={props.resume}
            /* Its own master version, so a later master edit cannot change what is rebuilt. */
            masterVersion={props.resume.master_version}
            /* "—" for a missing job embed, never "null". */
            jobTitle={props.row.title ?? '—'}
            /* Same fallback as the title. */
            companyName={props.row.company ?? '—'}
          />
        </div>
      ) : null}
    </details>
  );
}

/* One timeline line in words. */
function TimelineLine(props: { readonly item: TimelineItem }): ReactElement {
  // Narrowed once.
  const { item } = props;
  return (
    /* Time first: it is what orders the list. */
    <li>
      {/* "—" when the stored time was junk; the item still shows. */}
      <span className="applied-row__when">{momentText(item.at)}</span>{' '}
      {/* A status change names both ends; an email names sender, subject and the tracker's reading. */}
      {item.kind === 'status' ? (
        /* The first status has no source. */
        <span>{item.from === null ? `Entered ${statusText(item.to)}` : `Moved from ${statusText(item.from)} to ${statusText(item.to)}`}</span>
      ) : (
        /* Untrusted text, escaped by React. */
        <span>Email from {item.sender}: “{item.subject}” ({item.classification.replace(/_/g, ' ')})</span>
      )}
    </li>
  );
}

/* One application, as drawn. Pure: everything arrives as props. */
export function AppliedRowView(props: {
  // The validated row.
  readonly row: AppliedRow;
  // The transitions read.
  readonly edges: EdgesRead;
  // True while this row's move is in flight.
  readonly busy: boolean;
  // The last refused move's sentence for this row, or null.
  readonly error: string | null;
  // "Now" for the day count, read once per render by the page.
  readonly now: number;
  // Called with the target stage when a move is CONFIRMED; the button only opens the confirm.
  readonly onMove: (to: AppliedStage) => void;
}): ReactElement {
  // Destructured once.
  const { row, edges, busy, error, now, onMove } = props;
  // The row's confirm slot; the page prefix keeps it apart from other screens' confirms.
  const confirmId = `applied:${row.id}`;
  // Only the moves the live edges hold for this status; none until the graph has been read.
  const moves = edges.kind === 'ok' ? legalNextStages(edges.edges, row.status) : [];
  // The vetted link, or undefined for a missing or unsafe one.
  const href = safeHref(row.applyUrl);
  // The row in words.
  const name = rowName(row);
  return (
    /* One card per application; cards stack on a phone where a table would scroll sideways. */
    <li className="applied-row">
      {/* The job, the stage chip and the dates. */}
      <div className="applied-row__head">
        {/* The title as the row's heading, under the page's h1. */}
        <h2 className="applied-row__title">{row.title ?? '—'}</h2>
        {/* Teja's labels on the app's badge colours; the status value itself is unchanged. */}
        <StatusBadge status={row.status} label={STAGE_LABELS[row.status]} />
      </div>
      {/* Company and places; "—" when the job embed is missing. */}
      <p className="applied-row__where">{row.company ?? '—'} · {row.locations.length > 0 ? row.locations.join(' / ') : '—'}</p>
      {/* "—" for both when no date is known: never 1970, never today. */}
      <p className="applied-row__meta">
        Applied <time dateTime={row.appliedAt === null ? undefined : new Date(row.appliedAt).toISOString()}>{dayText(row.appliedAt)}</time> · {daysSinceText(daysSince(row.appliedAt, now))}
      </p>
      {/* The posting, to check it or follow up by hand. */}
      {href !== undefined ? (
        /* New tab so the page stays; noopener noreferrer so the employer page gets no handle back. */
        <a className="applied-row__link" href={href} target="_blank" rel="noopener noreferrer">Open the job posting</a>
      ) : (
        /* Said, not hidden. */
        <span className="applied-row__muted">Apply link unavailable (missing, or not a safe http(s) URL).</span>
      )}
      {/* What was sent. */}
      <div className="applied-row__docs">
        {/* The stored file first; else the rebuild, labelled; else said. */}
        {row.resumePath !== null ? (
          /* The PDF the worker uploaded with the application. */
          <SignedDownload bucket="resumes" path={row.resumePath} label="Download submitted resume" name={`Download submitted resume: ${name}`} />
        ) : row.resume !== null ? (
          /* No stored file: the frozen approved resume, rebuilt and labelled as such. */
          <RebuiltResume row={row} resume={row.resume} />
        ) : (
          /* Neither: nothing to offer, and saying so. */
          <span className="applied-row__muted">No resume is on record for this application.</span>
        )}
        {/* The form screenshot, only when the worker stored one. */}
        {row.screenshotPath !== null ? (
          /* Same signed-download path, the screenshots bucket. */
          <SignedDownload bucket="screenshots" path={row.screenshotPath} label="Download form screenshot" name={`Download form screenshot: ${name}`} />
        ) : null}
        {/* The worker never attaches a cover letter, so there is nothing to download. */}
        <span className="applied-row__muted">No cover letter was sent</span>
      </div>
      {/* The stage moves. */}
      <div className="applied-row__moves">
        {/* The confirm opens in place of the buttons, so the card keeps its height. */}
        <InlineConfirm id={confirmId}>
          {/* A labelled group, so a screen reader hears what these buttons are for. */}
          <div className="applied-row__move-buttons" role="group" aria-label={`Move ${name} to`}>
            {/* Built from the live edges, so a migration's new edge appears with no edit here. */}
            {moves.map((to) => (
              <button
                /* A stage has at most one edge to each target. */
                key={to}
                /* type=button: never a form submit. */
                type="button"
                /* The app's small button; the extra class lets tests list exactly the stage buttons. */
                className="button button--small applied-row__move"
                /* Off while this row's move is in flight. */
                disabled={busy}
                /* Label first (label-in-name), then which row: every row has the same words. */
                aria-label={`${STAGE_LABELS[to]}: ${name}`}
                /* Opens the inline confirm; nothing is written until its Confirm. The trigger is kept for focus on Cancel. */
                onClick={(e) => armConfirm(confirmId, {
                  // Named row, named move; the extra sentence only when no edge leaves the target.
                  message: `Move "${name}" from ${STAGE_LABELS[row.status]} to ${STAGE_LABELS[to]}?${edges.kind === 'ok' && legalNextStages(edges.edges, to).length === 0 ? `\n\nNo stage move leads out of ${STAGE_LABELS[to]} afterwards.` : ''}`,
                  // For the Confirm and Cancel names.
                  action: `${STAGE_LABELS[to]}: ${name}`,
                  // The write, through the page's lock.
                  onConfirm: () => onMove(to),
                  // Where focus returns on Cancel or Escape.
                  trigger: e.currentTarget,
                })}
              >
                {/* The visible word. */}
                {STAGE_LABELS[to]}
              </button>
            ))}
          </div>
        </InlineConfirm>
        {/* Why there are no buttons, when there are none. */}
        {edges.kind === 'loading' ? (
          /* Before the graph arrives. */
          <span className="applied-row__muted">Reading the stage moves…</span>
        ) : edges.kind === 'error' ? (
          /* Never a fallback graph: no buttons, and the reason. */
          <span className="applied-row__muted">Stage moves are unavailable: the transition graph could not be read ({edges.message}).</span>
        ) : moves.length === 0 ? (
          /* A stage no human edge leaves. */
          <span className="applied-row__muted">No further stage moves from {STAGE_LABELS[row.status]}.</span>
        ) : null}
        {/* A refused or unanswered move, on its own row; the status shown is still the stored one. */}
        {error !== null ? <p className="applied-row__error" role="alert">{error}</p> : null}
      </div>
      {/* History: status changes and matched emails, oldest first. */}
      {row.timeline.length > 0 ? (
        /* Collapsed by default so the list stays scannable. */
        <details className="applied-row__timeline">
          {/* The count says how much is inside before opening. */}
          <summary>Timeline ({row.timeline.length})</summary>
          {/* An ordered list: the order is the information. */}
          <ol className="applied-row__events">
            {/* Keyed by position: items have no shared id, and the list is rebuilt whole on each read. */}
            {row.timeline.map((item, i) => <TimelineLine key={i} item={item} />)}
          </ol>
        </details>
      ) : (
        /* The normal case today: no matched emails, and possibly no events. */
        <span className="applied-row__muted">No status changes or emails yet.</span>
      )}
      {/* Interview prep only at interview; the panel reads its own pack. */}
      {row.status === 'interview' ? (
        /* Its own section, so its h3 sits under this row's h2. */
        <section className="applied-row__prep">
          {/* The existing panel, unchanged. */}
          <InterviewPrepPanel applicationId={row.id} />
        </section>
      ) : null}
    </li>
  );
}

/* The toolbar, the states and the rows. Pure: everything arrives as props. */
export function AppliedListView(props: {
  // The rows read.
  readonly read: RowsRead;
  // The transitions read.
  readonly edges: EdgesRead;
  // The toolbar's choices.
  readonly view: AppliedView;
  // Called with the new choices.
  readonly onView: (view: AppliedView) => void;
  // Rows with a move in flight.
  readonly busy: ReadonlySet<string>;
  // Per-row move errors.
  readonly errors: ReadonlyMap<string, string>;
  // "Now" for the day counts.
  readonly now: number;
  // A confirmed move.
  readonly onMove: (row: AppliedRow, to: AppliedStage) => void;
}): ReactElement {
  // Destructured once.
  const { read, edges, view, onView, busy, errors, now, onMove } = props;
  // Before the first answer: neither "none" nor an error is known.
  if (read.kind === 'loading') return <p className="applied__note">Reading applied jobs…</p>;
  // role=alert: a list that cannot be read is not an empty list.
  if (read.kind === 'error') return <p className="applied__note" role="alert">Could not read applied jobs: {read.message}</p>;
  // A successful read with no rows: the measured empty state (the normal case until the first submit).
  if (read.rows.length === 0) return <p className="applied__note">No applied jobs yet. An application appears here once its submission is confirmed.</p>;
  // The rows the toolbar's choices leave, in its order.
  const shown = applyAppliedView(read.rows, view);
  // Counts over every row, so a filter option says what it would show.
  const counts = countByStage(read.rows);
  return (
    /* Toolbar, counts, then the list. */
    <>
      {/* role=search names the toolbar as the list's search landmark. */}
      <div className="applied__toolbar" role="search">
        {/* A real label wraps each control. */}
        <label className="field applied__search">
          {/* The visible label. */}
          <span className="field__label">Search</span>
          {/* Every whitespace-separated word must match title, company or place. */}
          <input type="search" className="field__control" value={view.search} placeholder="Title, company or place" onChange={(e) => onView({ ...view, search: e.target.value })} />
        </label>
        {/* Applied date order. */}
        <label className="field">
          {/* The visible label. */}
          <span className="field__label">Sort</span>
          {/* Native select: keyboard and screen reader behaviour for free. */}
          <select className="field__control" value={view.sort} onChange={(e) => onView({ ...view, sort: e.target.value as AppliedSort })}>
            {/* One option per sort, from the label Record. */}
            {(Object.keys(APPLIED_SORT_LABELS) as AppliedSort[]).map((sort) => <option key={sort} value={sort}>{APPLIED_SORT_LABELS[sort]}</option>)}
          </select>
        </label>
        {/* Stage filter with counts. */}
        <label className="field">
          {/* The visible label. */}
          <span className="field__label">Stage</span>
          {/* The value is a StageFilter by construction: only these options exist. */}
          <select className="field__control" value={view.stage} onChange={(e) => onView({ ...view, stage: e.target.value as StageFilter })}>
            {/* All first. */}
            <option value="all">All ({counts.all})</option>
            {/* Every stage in pipeline order, empty ones included so the choice is always there. */}
            {APPLIED_STAGES.map((stage) => <option key={stage} value={stage}>{STAGE_LABELS[stage]} ({counts[stage]})</option>)}
          </select>
        </label>
      </div>
      {/* Polite, so a filter change is announced without interrupting. */}
      <p className="applied__note" aria-live="polite">Showing {shown.length} of {read.rows.length}</p>
      {/* Said whenever the cap cut the list. */}
      {read.more ? <p className="applied__note" role="status">Showing the newest {APPLIED_LIMIT} applied jobs; older ones are not listed.</p> : null}
      {/* A filtered-out list is not an empty one. */}
      {shown.length === 0 ? (
        /* Points at the toolbar, the only cause. */
        <p className="applied__note">No applied jobs match this search and stage.</p>
      ) : (
        /* One card per row. */
        <ul className="applied__list">
          {/* Keyed by id: the lock, the error and the confirm all follow the row. */}
          {shown.map((row) => (
            <AppliedRowView key={row.id} row={row} edges={edges} busy={busy.has(row.id)} error={errors.get(row.id) ?? null} now={now} onMove={(to) => onMove(row, to)} />
          ))}
        </ul>
      )}
    </>
  );
}

/* The page: state, the two reads, and the one write. */
export function AppliedJobsPage(): ReactElement {
  // The rows read.
  const [read, setRead] = useState<RowsRead>({ kind: 'loading' });
  // The transitions read.
  const [edges, setEdges] = useState<EdgesRead>({ kind: 'loading' });
  // The toolbar's choices; reset on reload, deliberately (no storage: a filter that survives hides rows).
  const [view, setView] = useState<AppliedView>(DEFAULT_APPLIED_VIEW);
  // Rows with a move in flight, rendered disabled.
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  // Per-row move errors.
  const [errors, setErrors] = useState<ReadonlyMap<string, string>>(new Map());
  // The real lock, read synchronously, so a second Confirm in the same tick finds it.
  const inflight = useRef(new Set<string>());
  // Only the newest read may land; an older one finishing late is dropped.
  const readSeq = useRef(0);

  // Both reads, together. Never throws: every failure becomes a visible state.
  const load = useCallback(async (): Promise<void> => {
    // This read's ticket.
    const seq = ++readSeq.current;
    // No client: both reads say so rather than showing an empty page.
    if (supabase === null) {
      // The list cannot be read.
      setRead({ kind: 'error', message: 'Not connected to the database.' });
      // Nor can the graph.
      return setEdges({ kind: 'error', message: 'not connected to the database' });
    }
    try {
      // Concurrent: neither depends on the other.
      const [apps, graph] = await Promise.all([
        supabase
          // Under RLS: the operator's own rows.
          .from('applications')
          // Job, status events and matched emails embedded.
          .select(APPLIED_SELECT)
          // The six post-apply stages.
          .in('status', [...APPLIED_STAGES])
          // Stage history only; claims, notes and llm_call rows stay out of the payload.
          .eq('application_events.event_type', 'status_change')
          // Newest first, so the cap keeps the recent end; undated rows last.
          .order('applied_at', { ascending: false, nullsFirst: false })
          // One past the cap, to know whether it cut.
          .limit(APPLIED_LIMIT + 1),
        supabase
          // The graph, readable by every signed-in user (rls_policies.sql "read the graph").
          .from('application_status_transitions')
          // The actor list too, so readEdges can prove each edge is human.
          .select('from_status, to_status, allowed_agents')
          // Only edges out of this page's stages.
          .in('from_status', [...APPLIED_STAGES])
          // Only edges a human may walk: the browser sends no agent key.
          .contains('allowed_agents', ['human']),
      ]);
      // A newer read started meanwhile: this answer is stale.
      if (seq !== readSeq.current) return;
      // supabase-js returns errors; each read reports its own.
      if (apps.error) setRead({ kind: 'error', message: apps.error.message || 'unknown error' });
      // Validated rows only; a row that cannot be shown or moved safely is skipped, not guessed.
      else {
        // The raw answer, as an array or nothing.
        const raw: readonly unknown[] = Array.isArray(apps.data) ? apps.data : [];
        // Each through the shape check.
        const rows = raw.map(readAppliedRow).filter((r): r is AppliedRow => r !== null);
        // Counted on the raw answer, so a skipped row cannot hide the overflow.
        setRead({ kind: 'rows', rows: rows.slice(0, APPLIED_LIMIT), more: raw.length > APPLIED_LIMIT });
      }
      // The graph's own state; a failure here shows no buttons, never a remembered graph.
      setEdges(graph.error ? { kind: 'error', message: graph.error.message || 'unknown error' } : { kind: 'ok', edges: readEdges(graph.data) });
    } catch {
      // A throwing client is a failed read, if this is still the newest one.
      if (seq !== readSeq.current) return;
      // Both fail together: they were one await.
      setRead({ kind: 'error', message: 'The applied jobs could not be read.' });
      // No graph, no buttons.
      setEdges({ kind: 'error', message: 'the read threw' });
    }
  }, []);

  // First read on mount; load never throws.
  useEffect(() => {
    // Fire and forget: failures are states.
    void load();
  }, [load]);

  // One CONFIRMED move: lock, write, then re-read on success or say why not.
  async function move(row: AppliedRow, to: AppliedStage): Promise<void> {
    // A second Confirm while the first is in flight does nothing.
    if (inflight.current.has(row.id)) return;
    // Claimed before the first await.
    inflight.current.add(row.id);
    // Mirrored into state so the buttons render disabled.
    setBusy((prev) => new Set(prev).add(row.id));
    // A new attempt clears the row's old error.
    setErrors((prev) => {
      // Copied so React sees a new map.
      const next = new Map(prev);
      // This row only.
      next.delete(row.id);
      return next;
    });
    // The outcome as supabase-js shapes it; a throw becomes a lost answer (status 0).
    let result: { error: { code?: unknown; message?: unknown } | null; status?: unknown };
    try {
      // The one write; the database's graph and the stamp have the final word.
      result = supabase === null ? { error: { code: 'NO_CLIENT', message: 'not connected to the database.' }, status: 400 } : await supabase.rpc('advance_application_status', buildMoveArgs(row, to));
    } catch {
      // Lost, not failed: moveErrorText says it may still land.
      result = { error: null, status: 0 };
    }
    // Accepted: re-read, so the chip, the buttons and the timeline all show what is stored now.
    if (result.error === null && result.status !== 0) await load();
    // Refused or unanswered: said on the row, and the shown status stays the stored one.
    else setErrors((prev) => new Map(prev).set(row.id, moveErrorText(result.status, result.error)));
    // Unlocked on every path.
    inflight.current.delete(row.id);
    // And its rendered mirror.
    setBusy((prev) => {
      // Copied so React sees a new set.
      const next = new Set(prev);
      // This row's move is over.
      next.delete(row.id);
      return next;
    });
  }

  return (
    /* The app's page frame. */
    <div className="page">
      {/* Title and lede from the route table. */}
      <PageHeader path="applied" />
      {/* Everything else is the pure list view. */}
      <AppliedListView read={read} edges={edges} view={view} onView={setView} busy={busy} errors={errors} now={Date.now()} onMove={(row, to) => void move(row, to)} />
    </div>
  );
}
