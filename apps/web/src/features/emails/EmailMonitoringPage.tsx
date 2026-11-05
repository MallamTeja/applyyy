/* Emails: every job email the Gmail tracker captured, with filters, sorting, an in-app read mark, and
 * "Add to Applied" for job mail about an application the pipeline does not track (2026-11-05).
 *
 * WHAT CHANGED (2026-11-05, Teja): the page showed only interview mail and stamped "Interview Invite" on
 * EVERY row, so a HackerRank receipt and a Simplilearn promo both read as interview invites. Each row now
 * shows its STORED class through emailView.ts classLabel (a closed map; unknown reads "Unclassified").
 * The default view is all job mail; the filters narrow it by class, tracked or not, sender text and
 * date, and sort it. The filter state lives in the URL, so a filtered view survives a reload.
 *
 * DUPLICATE GUARD (2026-11-05). Before offering a NEW job, Add to Applied looks up this user's applications
 * at the email's company slug (any status). Found: the row offers "Link to <title> (<status>)" FIRST, which
 * sets email_events.matched_application_id only (no new rows, no status move), and keeps "Add as a new job"
 * second. The live case: HackerRank's receipt did not match its own application, and creating would have
 * made a second one.
 *
 * NOT TRACKED + ADD TO APPLIED. The "Not tracked" filter is the list of job emails matched to no
 * application. On mail ABOUT an application (emailView.ts isTrackable) the row offers Add to Applied:
 * Teja confirms the company and title, then ONE call to public.track_email_as_applied creates the job and
 * its application at `applied` and links the email, in one transaction (migration 20261105124600). Never
 * automatic: only this button calls it.
 *
 * READ MARK. "Mark read" sets email_events.read_at for THIS APP only. Gmail's own read state is never read
 * or written: that would need the gmail.modify OAuth scope, which nobody asked for.
 *
 * ON-DEMAND SYNC INVARIANT (unchanged): no background polling. The page syncs once on open and when the
 * operator clicks Refresh. "Last checked" is the later of this visit's sync and the tracker's newest
 * successful run (agent_runs), so a cooldown answer still shows when the inbox was last read.
 *
 * ROW LEVEL SECURITY INVARIANT: every read and write is scoped by Postgres RLS to the operator's rows.
 */

// Hooks for the reads, the locks, the drafts and the URL state.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
// The component return type.
import type { ReactElement } from 'react';
// The URL query: where the filter state lives.
import { useSearchParams } from 'react-router-dom';

// The shared client; null when the build has no Supabase config.
import { supabase } from '../../data/supabase.ts';
// The page heading from routes.ts.
import { PageHeader } from '../../app/PageHeader.tsx';
// The shared "opens in a new tab" marker for the Open in Gmail link.
import { NewTabCue } from '../../app/SourceBadge.tsx';
// The in-place confirm in front of Add to Applied: it creates permanent rows.
import { InlineConfirm, armConfirm } from '../../app/InlineConfirm.tsx';
// The sync plumbing, unchanged.
import {
  formatSyncTime,
  readLastGmailSyncMs,
  shouldAutoSync,
  syncGmailInbox,
  syncStatusLine,
  writeLastGmailSyncMs,
  type EmailEventRow,
} from './emailSync.ts';
// The view rules this page renders.
import {
  applyEmailFilters,
  classBadgeTone,
  classLabel,
  CLASS_FILTER_OPTIONS,
  companySlugOf,
  filtersToParams,
  isTrackable,
  parseEmailFilters,
  parseLinkCandidates,
  prefillOf,
  unreadCount,
  type EmailFilters,
  type LinkCandidate,
} from './emailView.ts';

// The page's styles.
import './EmailMonitoringPage.css';

// ISO timestamp shape as PostgREST writes timestamptz; Date.parse alone would accept '-5'.
const ISO_STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

/* The tracker's newest successful run, in ms, or null when there is none or it cannot be read. Advisory:
   a failed read leaves "Last checked" as it was and never touches the email list's error banner. */
async function readTrackerLastRunMs(): Promise<number | null> {
  // No client: nothing to read.
  if (supabase === null) return null;
  try {
    // The newest finished, succeeded tracker run (email-tracker-intake closes one per batch).
    const { data, error } = await supabase
      // The run log, under RLS (only this user's runs).
      .from('agent_runs')
      // Only the finish time is needed.
      .select('finished_at')
      // The Gmail tracker's runs (email-tracker-intake records them as 'tracker').
      .eq('agent', 'tracker')
      // A failed run did not read the inbox successfully.
      .eq('status', 'succeeded')
      // A run still open has no finish yet.
      .not('finished_at', 'is', null)
      // Newest first.
      .order('finished_at', { ascending: false })
      // Just that one.
      .limit(1);
    // A failed read is not a time.
    if (error) return null;
    // The one row's stamp, shape-checked before parsing.
    const stamp = (data as { finished_at?: unknown }[] | null)?.[0]?.finished_at;
    // Only a real ISO stamp becomes a time.
    if (typeof stamp !== 'string' || !ISO_STAMP.test(stamp)) return null;
    // Parsed; an impossible date is no time.
    const ms = Date.parse(stamp);
    // An impossible date (month 13) passes the regex but not the parse.
    return Number.isFinite(ms) ? ms : null;
  } catch {
    // A throwing client is no time, never an error banner.
    return null;
  }
}

/* An open Add to Applied form: the company and title Teja confirms. */
interface TrackDraft {
  // The company name, prefilled from the sender.
  readonly company: string;
  // The job title, prefilled from the subject.
  readonly title: string;
}

/* One email row. Pure: everything arrives as props, so a static render tests exactly what is drawn. */
export function EmailRow(props: {
  // The stored email.
  readonly event: EmailEventRow;
  // A write is in flight on this row.
  readonly locked: boolean;
  // The last outcome on this row, or null.
  readonly note: string | null;
  // The open Add to Applied form, or null.
  readonly draft: TrackDraft | null;
  // Existing applications at this email's company, shown BEFORE the form; null when not looked up.
  readonly links: readonly LinkCandidate[] | null;
  // The confirmed link to one of them; only InlineConfirm's Confirm reaches it.
  readonly onLink: (applicationId: string) => void;
  // Skip the candidates and open the new-job form.
  readonly onAddNew: () => void;
  // Mark this email read in the app.
  readonly onMarkRead: () => void;
  // Open the Add to Applied form.
  readonly onOpenTrack: () => void;
  // Edit the open form.
  readonly onDraftChange: (draft: TrackDraft) => void;
  // Close the form without writing.
  readonly onCancelTrack: () => void;
  // The confirmed call; only InlineConfirm's Confirm reaches it.
  readonly onTrack: () => void;
}): ReactElement {
  // Destructured for readability.
  const { event, locked, note, draft, links } = props;
  // The Gmail permalink, built from the stored id (encoded: it is untrusted text).
  const gmailHref = `https://mail.google.com/mail/u/0/#all/${encodeURIComponent(event.provider_message_id)}`;
  // Unread in the app.
  const unread = event.read_at === null;
  // The row named by its subject, or its sender when the subject is empty (W33 redaction).
  const name = event.subject.trim() !== '' ? event.subject : event.from_address;
  // This row's confirm slot.
  const confirmId = `email-track:${event.id}`;
  // The slug the call would send; '' means the company has no usable letters or digits.
  const slug = draft !== null ? companySlugOf(draft.company) : '';
  return (
    /* One card; the unread modifier draws the unread marker. */
    <li className={unread ? 'email-card email-card--unread' : 'email-card'} aria-label={`${unread ? 'Unread' : 'Read'}: ${name}`}>
      {/* Sender, links, the stored class and the time. */}
      <div className="email-card__top">
        {/* Untrusted text, rendered as text. */}
        <span className="email-card__sender">{event.from_address}</span>
        {/* The right-hand group. */}
        <div className="email-card__top-actions">
          {/* Gmail opens in a new tab; the cue announces that. */}
          <a href={gmailHref} target="_blank" rel="noopener noreferrer" className="email-card__gmail-button" title="Open email thread in Gmail">
            Open in Gmail<NewTabCue />
          </a>
          {/* THE FIX: the stored class through the closed label map, never a hard-coded kind. */}
          <span className={`email-badge email-badge--${classBadgeTone(event.classification)}`}>{classLabel(event.classification)}</span>
          {/* Local time. */}
          <span className="email-card__time">{new Date(event.received_at).toLocaleString()}</span>
        </div>
      </div>

      {/* h2: the page h1 is the only heading above a card subject (fixed 2026-10-23). */}
      <h2 className="email-card__subject">
        {/* The subject opens the thread too. */}
        <a href={gmailHref} target="_blank" rel="noopener noreferrer" className="email-card__subject-link" title="Open email thread in Gmail">
          {/* Said when empty: W33 blanks the subject of unclassified, unmatched mail. */}
          {event.subject.trim() !== '' ? event.subject : '(subject not kept)'}
        </a>
      </h2>
      {/* The body excerpt, when kept. */}
      {event.snippet.trim() !== '' ? <p className="email-card__snippet">{event.snippet}</p> : null}

      {/* Tracking state and the row's actions. */}
      <div className="email-card__meta">
        {/* Linked or not, in words. */}
        {event.matched_application_id !== null ? (
          /* The application's short id. */
          <span className="email-card__tracked">Tracked: application <code className="identifier">{event.matched_application_id.slice(0, 8)}</code></span>
        ) : (
          /* The "Not tracked" state. */
          <span>Not tracked</span>
        )}
        {/* The in-app read mark; gone once read. */}
        {unread ? (
          /* type=button: never a form submit. */
          <button type="button" className="email-card__action" disabled={locked} aria-label={`Mark read: ${name}`} onClick={props.onMarkRead}>
            Mark read
          </button>
        ) : null}
        {/* Add to Applied: only on unmatched mail about an application, and only while no form or candidate list is open. */}
        {isTrackable(event) && draft === null && links === null ? (
          /* Opens the form; writes nothing. */
          <button type="button" className="email-card__action" disabled={locked} aria-label={`Add to Applied: ${name}`} onClick={props.onOpenTrack}>
            Add to Applied
          </button>
        ) : null}
      </div>

      {/* The duplicate guard: existing applications at this company, offered before a new job. */}
      {links !== null && links.length > 0 && draft === null && event.matched_application_id === null ? (
        /* The confirm replaces the options in place. */
        <InlineConfirm id={`email-link:${event.id}`}>
          {/* Reading order is the recommendation: link first, new job last. */}
          <div className="email-link__options" role="group" aria-label={`Already tracked at this company: ${name}`}>
            {/* Said, so the choice is understood. */}
            <span className="email-track__hint">This company already has {links.length === 1 ? 'an application' : `${links.length} applications`}. Link the email instead of adding a duplicate:</span>
            {links.map((l) => {
              // The button's name: the target and the email, so every row's buttons differ.
              const action = `Link to ${l.title} (${l.status}): ${name}`;
              return (
                /* One per application; keyed by its id. */
                <button
                  /* One button per application id. */
                  key={l.id}
                  /* Never a form submit. */
                  type="button"
                  /* The row actions' look. */
                  className="email-card__action"
                  /* Off while this row has a write in flight. */
                  disabled={locked}
                  /* Names the target AND the email, so every row's buttons are distinct. */
                  aria-label={action}
                  /* Arms the confirm; nothing is written until Confirm. */
                  onClick={(e) => armConfirm(`email-link:${event.id}`, {
                    // What happens, and what does not.
                    message: `Link this email to "${l.title}" (${l.status})? This only links it: no new job, no status change.`,
                    // For the Confirm and Cancel names.
                    action,
                    // The one write.
                    onConfirm: () => props.onLink(l.id),
                    // Focus returns here on Cancel.
                    trigger: e.currentTarget,
                  })}
                >
                  {/* The visible text names the target. */}
                  Link to {l.title} ({l.status})
                </button>
              );
            })}
            {/* The secondary path: a genuinely different job at the same company. Opens the form; writes nothing. */}
            <button type="button" className="email-card__action" disabled={locked} aria-label={`Add as a new job: ${name}`} onClick={props.onAddNew}>
              Add as a new job
            </button>
            {/* Closes the options; writes nothing. */}
            <button type="button" className="email-card__action" onClick={props.onCancelTrack}>Cancel</button>
          </div>
        </InlineConfirm>
      ) : null}

      {/* The open form: company and title, then a confirmed call. */}
      {draft !== null ? (
        /* The confirm replaces the form's buttons in place. */
        <InlineConfirm id={confirmId}>
          {/* A real form, so Enter submits; submitting only arms the confirm. */}
          <form
            /* The form's own layout class. */
            className="email-track"
            aria-label={`Add to Applied: ${name}`}
            onSubmit={(e) => {
              // Never a page navigation.
              e.preventDefault();
              // A name with no letters or digits has no slug: refused here, before any call.
              if (slug === '' || draft.title.trim() === '') return;
              // Arms the confirm; Confirm calls onTrack.
              armConfirm(confirmId, {
                // What will be created, named.
                message: `Add "${draft.title.trim()}" at ${draft.company.trim()} to Applied? This creates the job and its application at applied and links this email.`,
                // For the Confirm and Cancel names.
                action: `Add to Applied: ${name}`,
                // The one write.
                onConfirm: props.onTrack,
                // Focus returns to the submit button on Cancel.
                trigger: (e.nativeEvent as SubmitEvent).submitter instanceof HTMLElement ? ((e.nativeEvent as SubmitEvent).submitter as HTMLElement) : e.currentTarget,
              });
            }}
          >
            {/* Company, prefilled from the sender. */}
            <label className="email-track__field">
              Company
              {/* Bounded to what the RPC accepts; required so an empty submit is refused by the browser. */}
              <input value={draft.company} maxLength={200} required onChange={(e) => props.onDraftChange({ ...draft, company: e.target.value })} />
            </label>
            {/* Title, prefilled from the subject. */}
            <label className="email-track__field">
              Job title
              {/* Same bounds as the company. */}
              <input value={draft.title} maxLength={200} required onChange={(e) => props.onDraftChange({ ...draft, title: e.target.value })} />
            </label>
            {/* Said before the click, not after a refusal. */}
            {draft.company.trim() !== '' && slug === '' ? <span className="email-track__hint" role="status">The company name needs at least one letter or digit (a-z, 0-9).</span> : null}
            {/* Submit arms the confirm; Cancel closes the form. */}
            <div className="email-track__buttons">
              {/* Off until both fields can make a valid call. */}
              <button type="submit" className="email-card__action" disabled={locked || slug === '' || draft.title.trim() === ''}>Add to Applied</button>
              {/* Closes the form; writes nothing. */}
              <button type="button" className="email-card__action" onClick={props.onCancelTrack}>Cancel</button>
            </div>
          </form>
        </InlineConfirm>
      ) : null}

      {/* The row's last outcome, announced. */}
      {note !== null ? <p className="email-card__note" role="status">{note}</p> : null}
    </li>
  );
}

export function EmailMonitoringPage(): ReactElement {
  /* Raw list of email events retrieved from the database */
  const [events, setEvents] = useState<readonly EmailEventRow[]>([]);
  /* Loading state while database query is in flight */
  const [loading, setLoading] = useState<boolean>(true);
  /* Sync state while live Gmail fetch is in flight */
  const [syncing, setSyncing] = useState<boolean>(false);
  /* Error state if the DATABASE query fails — sync failures never land here, because a
     failed sync must stay a quiet one-liner while the stored events render normally. */
  const [error, setError] = useState<string | null>(null);
  /* Where this visit's sync attempt stands; drives the one-line status via syncStatusLine. */
  const [syncState, setSyncState] = useState<'idle' | 'syncing' | 'ok' | 'cooldown' | 'failed'>('idle');
  /* The failure's own words, shown only as the status line's hover title — detail on
     demand, noise never. */
  const [syncDetail, setSyncDetail] = useState<string | null>(null);
  /* Timestamp of last successful sync execution (this visit; the cross-visit cap lives
     in localStorage via read/writeLastGmailSyncMs). */
  const [lastSyncedAt, setLastSyncedAt] = useState<number | null>(null);
  /* The tracker's newest successful run, so a cooldown answer still shows a real time (2026-11-05). */
  const [trackerRunMs, setTrackerRunMs] = useState<number | null>(null);
  /* The filter state, in the URL (shareable, survives a reload). */
  const [searchParams, setSearchParams] = useSearchParams();
  // Parsed once per URL change; junk values fall back to defaults.
  const filters = useMemo(() => parseEmailFilters(searchParams), [searchParams]);
  // One filter field changed: the rest kept, defaults dropped from the URL, no history entry per keystroke.
  const setFilter = useCallback((change: Partial<EmailFilters>) => setSearchParams(filtersToParams({ ...filters, ...change }), { replace: true }), [filters, setSearchParams]);
  /* Open Add to Applied forms, by email id. */
  const [drafts, setDrafts] = useState<Readonly<Record<string, TrackDraft>>>({});
  /* Existing applications at each open email's company (the duplicate guard), by email id. */
  const [links, setLinks] = useState<Readonly<Record<string, readonly LinkCandidate[]>>>({});
  /* Rows with a write in flight: rendered disabled. */
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  /* Each row's last outcome sentence. */
  const [notes, setNotes] = useState<Readonly<Record<string, string>>>({});
  /* The REAL lock: a ref, read and written synchronously, so two clicks in one tick cannot both pass. */
  const inflight = useRef(new Set<string>());

  /* Fetch latest email events from Supabase */
  const fetchEvents = useCallback(async () => {
    // No client: say why instead of showing an empty list.
    if (supabase === null) {
      // Nothing is loading.
      setLoading(false);
      // The banner names the cause.
      setError('Supabase client is unconfigured. Connect your environment to view live email events.');
      // No read to make.
      return;
    }

    // A read is in flight; any earlier failure is about to be re-measured.
    setLoading(true);
    // Cleared so a recovered read does not keep a stale banner.
    setError(null);

    // supabase-js returns {error}; the catch is for a client that throws.
    try {
      // The events and the tracker's last run together; the run read never fails the list.
      const [{ data, error: queryError }, runMs] = await Promise.all([
        // The stored emails, under RLS.
        supabase
          // The tracker's table.
          .from('email_events')
          // Every column: the filters read class, match, read mark and time.
          .select('*')
          // Newest first, so the cap keeps the recent end.
          .order('received_at', { ascending: false })
          // Bounded; the filters run over what came back.
          .limit(200),
        // "Last checked", read alongside; never fails the list.
        readTrackerLastRunMs(),
      ]);
      // Kept only when known, so one failed read does not erase a time already shown.
      if (runMs !== null) setTrackerRunMs(runMs);

      // A failed read is the banner; the old list stays rather than turning into "no emails".
      if (queryError) {
        // The database's own words.
        setError(queryError.message);
      } else {
        // The rows, typed by the shared schema.
        setEvents((data as unknown as readonly EmailEventRow[]) ?? []);
      }
    } catch (err) {
      // A throwing client is a failed read, said as one.
      setError(err instanceof Error ? err.message : 'Failed to query email intake log.');
    } finally {
      // Settled either way.
      setLoading(false);
    }
  }, []);

  /* Execute on-demand Gmail sync via the gmail-sync edge function, then re-fetch events.
     ORDER IS THE SAFETY PROPERTY: stored events are fetched and rendered FIRST, so no
     sync outcome — not even a thrown one — can block the page's real job. */
  const performSync = useCallback(
    async (manual: boolean) => {
      // Always re-fetch current DB events first; the list never waits on Gmail.
      await fetchEvents();

      // No client, no call: the DB error banner from fetchEvents already explains why.
      if (supabase === null) return;

      // One sync at a time; a second click while in flight is a no-op, not a queue.
      if (syncing) return;

      // CLIENT-SIDE DEBOUNCE, auto-trigger only: Teja's once-a-minute cap on page open.
      // Advisory — the function's own cooldown is authoritative — and read through the
      // shape-checked storage helper, so a blocked or mangled localStorage only costs
      // one extra server-absorbed call. A manual click always goes through: the server
      // answers `cooldown` if it really is too soon, and the same quiet line shows.
      const storage = typeof localStorage === 'undefined' ? undefined : localStorage;
      if (!manual && !shouldAutoSync(readLastGmailSyncMs(storage), Date.now())) {
        // The same quiet "just ran" line the server's cooldown gives.
        setSyncState('cooldown');
        // No call.
        return;
      }

      // In flight: the Refresh button disables.
      setSyncing(true);
      // The quiet line says so.
      setSyncState('syncing');

      // syncGmailInbox never throws: every path lands in the closed outcome union.
      const outcome = await syncGmailInbox(supabase);
      if (outcome.kind === 'ok') {
        // Record the instant in state (the card's "Last checked") and in storage (the cap).
        const now = Date.now();
        // This visit's time, for "Last checked".
        setLastSyncedAt(now);
        // The cross-visit cap.
        writeLastGmailSyncMs(storage, now);
        // Surface whatever the sync just ingested.
        await fetchEvents();
        // Settled.
        setSyncState('ok');
        // No failure detail to hover.
        setSyncDetail(null);
      } else if (outcome.kind === 'cooldown') {
        // The server said "just ran" — same quiet line as the client-side skip.
        setSyncState('cooldown');
        // Nothing to hover.
        setSyncDetail(null);
      } else {
        // Failed (503 not-configured included): quiet line, detail on hover, events stay.
        setSyncState('failed');
        setSyncDetail(outcome.message);
      }
      // The button comes back on every path.
      setSyncing(false);
    },
    // Rebuilt when the read or the in-flight flag changes.
    [fetchEvents, syncing],
  );

  /* Set once the mount-time sync has been attempted. A ref, not state, so flipping it
     does not re-render — and it survives StrictMode's dev double-invoke of effects. */
  const autoSyncAttempted = useRef(false);

  /* Initial on-demand sync and fetch on page mount (Page Open) — EXACTLY ONCE.
     `performSync` is rebuilt whenever `syncing` or `lastSyncedAt` changes. A failed
     sync leaves `lastSyncedAt` null, so keying the effect on `performSync` refired it
     after every failure, and `fetchEvents` cleared the error each time: an invisible
     infinite retry loop. Later syncs come only from the explicit Refresh button. */
  useEffect(() => {
    // Already tried on this mount: never auto-retry, so a failure stays on screen.
    if (autoSyncAttempted.current) return;
    // Mark before awaiting, so a re-run of this effect mid-flight cannot start a second sync.
    autoSyncAttempted.current = true;
    // Fire-and-forget: performSync records its own errors in state.
    void performSync(false);
  }, [performSync]);

  /* The rows the filters keep, in their order. */
  const shown = useMemo(() => applyEmailFilters(events, filters), [events, filters]);
  /* The four numbers: job mail, unread among what is shown, and job mail no application tracks. */
  const metrics = useMemo(() => {
    // Job mail = the default view's class rule.
    const jobMail = applyEmailFilters(events, { ...filters, cls: 'job', track: 'all', q: '', from: '', to: '' });
    // Shown, then counted.
    return { jobMail: jobMail.length, unreadShown: unreadCount(shown), notTracked: jobMail.filter((e) => e.matched_application_id === null).length };
  }, [events, filters, shown]);
  /* "Last checked": the later of this visit's sync and the tracker's own newest run. */
  const lastCheckedMs = lastSyncedAt === null ? trackerRunMs : trackerRunMs === null ? lastSyncedAt : Math.max(lastSyncedAt, trackerRunMs);

  /* Claims the row lock, or says no. Synchronous, before any await. */
  const claim = (ids: readonly string[]): boolean => {
    // Any id already in flight: the whole action waits.
    if (ids.some((id) => inflight.current.has(id))) return false;
    // Claimed.
    for (const id of ids) inflight.current.add(id);
    // Mirrored for rendering.
    setBusy(new Set(inflight.current));
    return true;
  };
  /* Releases the row lock on every path. */
  const release = (ids: readonly string[]): void => {
    // Released.
    for (const id of ids) inflight.current.delete(id);
    // Mirrored.
    setBusy(new Set(inflight.current));
  };
  /* One outcome sentence per row. */
  const noteOn = (ids: readonly string[], text: string): void => setNotes((prev) => ({ ...prev, ...Object.fromEntries(ids.map((id) => [id, text])) }));

  /* Marks these emails read in the app. Only unread rows are written; the stored stamps come back and are shown. */
  const markRead = async (ids: readonly string[]): Promise<void> => {
    // Nothing to do, or no client.
    if (ids.length === 0 || supabase === null || !claim(ids)) return;
    try {
      // One update for all of them; read_at IS NULL keeps a first-read time from being overwritten.
      const { data, error: writeError } = await supabase.from('email_events').update({ read_at: new Date().toISOString() }).in('id', [...ids]).is('read_at', null).select('id, read_at');
      // supabase-js returns the error; it does not throw.
      if (writeError) return noteOn(ids, `Could not mark read: ${writeError.message}`);
      // The rows the database actually changed, by id.
      const stamped = new Map(((data ?? []) as { id: string; read_at: string | null }[]).map((r) => [r.id, r.read_at]));
      // Shown as stored.
      setEvents((prev) => prev.map((e) => (stamped.has(e.id) ? { ...e, read_at: stamped.get(e.id) ?? null } : e)));
    } catch {
      // A throwing client is a failed write, said on the row.
      noteOn(ids, 'Could not mark read: the request failed.');
    } finally {
      // Always released.
      release(ids);
    }
  };

  /* Add to Applied, step one: look for this company's existing applications before offering a new job. */
  const openAdd = async (event: EmailEventRow): Promise<void> => {
    // The prefill names the company; its slug is the lookup key.
    const prefill = prefillOf(event);
    // The same slug rule the create call sends.
    const slug = companySlugOf(prefill.company);
    // No client or no slug: nothing to look up, straight to the form.
    if (supabase === null || slug === '') {
      // The form, so the operator can still type a company.
      setDrafts((prev) => ({ ...prev, [event.id]: prefill }));
      return;
    }
    // A write already in flight on this row: this click does nothing.
    if (!claim([event.id])) return;
    try {
      // This user's applications whose job has this slug, any status (RLS scopes it to the caller).
      const { data, error: readError } = await supabase.from('applications').select('id, status, jobs!inner(title, company_slug)').eq('jobs.company_slug', slug).limit(20);
      // Candidates when the read worked; a failed read is said, and the form still opens.
      const found = readError ? [] : parseLinkCandidates(data);
      // A failed lookup must not silently turn into "no duplicates".
      if (readError) noteOn([event.id], `Could not check for an existing application (${readError.message}); check before adding.`);
      // Some: offer them first. None: the form.
      if (found.length > 0) setLinks((prev) => ({ ...prev, [event.id]: found }));
      // None: straight to the new-job form, prefilled.
      else setDrafts((prev) => ({ ...prev, [event.id]: prefill }));
    } catch {
      // A throwing client: said, and the form opens so the operator decides.
      noteOn([event.id], 'Could not check for an existing application; check before adding.');
      // The form still opens: the operator decides, warned.
      setDrafts((prev) => ({ ...prev, [event.id]: prefill }));
    } finally {
      // Always released.
      release([event.id]);
    }
  };

  /* Closes this row's candidates and form. */
  const closeAdd = (id: string): void => {
    // The candidate list closes.
    setLinks((prev) => Object.fromEntries(Object.entries(prev).filter(([k]) => k !== id)));
    // And the form, if it was open.
    setDrafts((prev) => Object.fromEntries(Object.entries(prev).filter(([k]) => k !== id)));
  };

  /* The confirmed link: matched_application_id only, and only while the email is still unlinked. */
  const link = async (event: EmailEventRow, applicationId: string): Promise<void> => {
    // No client, or already in flight.
    if (supabase === null || !claim([event.id])) return;
    try {
      // One guarded update; "is null" means a link made meanwhile (by the tracker) is never overwritten.
      const { data, error: writeError } = await supabase.from('email_events').update({ matched_application_id: applicationId }).eq('id', event.id).is('matched_application_id', null).select('id');
      // The database's words on a failure.
      if (writeError) return noteOn([event.id], `Not linked: ${writeError.message}`);
      // Zero rows: it was linked already; the re-read shows to what.
      // One row changed = linked; zero = someone linked it first (the null guard refused this write).
      noteOn([event.id], (data ?? []).length === 1 ? 'Linked to the existing application.' : 'Not linked: this email was already linked. Refreshed.');
      // Options closed either way: linked, or nothing left to link.
      closeAdd(event.id);
      // What is stored now.
      await fetchEvents();
    } catch {
      // A lost answer: retrying is safe (the null guard makes a second link a no-op).
      noteOn([event.id], 'Not confirmed: the request failed. Refresh to see whether it was linked.');
    } finally {
      // Always released.
      release([event.id]);
    }
  };

  /* The confirmed Add to Applied: one call, then the list re-reads so the row shows as tracked. */
  const track = async (event: EmailEventRow): Promise<void> => {
    // The confirmed draft.
    const draft = drafts[event.id];
    // Gone (cancelled meanwhile), no client, or already in flight.
    if (draft === undefined || supabase === null || !claim([event.id])) return;
    try {
      // The one write path: a single transaction in the database.
      const { error: rpcError } = await supabase.rpc('track_email_as_applied', {
        p_email_event_id: event.id,
        p_company: draft.company.trim(),
        p_company_slug: companySlugOf(draft.company),
        p_title: draft.title.trim(),
      });
      // A refusal carries a SQLSTATE and the database's own words. No code means the answer was lost: the call
      // may have committed, and a retry is safe because the function returns this email's own application.
      if (rpcError) return noteOn([event.id], typeof rpcError.code === 'string' && rpcError.code !== '' ? `Not added: ${rpcError.message}` : 'Not confirmed: the answer was lost. Refresh to see whether it was added; trying again is safe.');
      // Done: the form closes and the row says so.
      setDrafts((prev) => Object.fromEntries(Object.entries(prev).filter(([id]) => id !== event.id)));
      noteOn([event.id], `Added to Applied: ${draft.title.trim()} at ${draft.company.trim()}.`);
      // What is stored now: the email is linked.
      await fetchEvents();
    } catch {
      // A lost answer: the job may or may not exist, so the row says to look before retrying.
      noteOn([event.id], 'Not confirmed: the request failed. Refresh before trying again; it may already be added.');
    } finally {
      // Always released.
      release([event.id]);
    }
  };

  return (
    /* `page` gives the shared gutters; `email-monitor` carries this page's own rules. */
    <div className="page email-monitor">
      {/* Top page title and lede */}
      <div className="email-monitor__header">
        <PageHeader path="emails" />
      </div>

      {/* The four numbers (e2eSuite test 8 pins exactly four cards). */}
      <div className="email-monitor__stats">
        {/* All job mail stored, whatever the filters. */}
        <div className="email-stat-card">
          <span className="email-stat-card__label">Job emails</span>
          <span className="email-stat-card__value" style={{ color: 'var(--traced)' }}>{metrics.jobMail}</span>
        </div>
        {/* Unread among the rows on screen: what "Mark all shown as read" would clear. */}
        <div className="email-stat-card">
          <span className="email-stat-card__label">Unread (shown)</span>
          <span className="email-stat-card__value" style={{ color: 'var(--accent)' }} data-testid="unread-count">{metrics.unreadShown}</span>
        </div>
        {/* Job mail no application tracks: the "Not tracked" list's size. */}
        <div className="email-stat-card">
          <span className="email-stat-card__label">Not tracked</span>
          <span className="email-stat-card__value">{metrics.notTracked}</span>
        </div>
        {/* How and when the inbox is read. */}
        <div className="email-stat-card">
          <span className="email-stat-card__label">Monitoring Mode</span>
          {/* One mode since the edge-function transport: the page itself triggers the sync. */}
          <span className="email-stat-card__value" style={{ fontSize: 'var(--size-base)', fontWeight: 600 }}>
            On-Demand (Page Open)
          </span>
          {/* The later of this visit's sync and the tracker's newest run; a cooldown answer still has a time. */}
          <span className="email-monitor__last-checked">
            Last checked: {formatSyncTime(lastCheckedMs)}
          </span>
        </div>
      </div>

      {/* Search and the one sync control. */}
      <div className="email-monitor__toolbar">
        <input
          type="search"
          className="email-monitor__search"
          placeholder="Filter by sender, company or subject..."
          value={filters.q}
          onChange={(e) => setFilter({ q: e.target.value })}
          aria-label="Filter emails by sender, company or subject"
        />
        <div style={{ display: 'flex', gap: 'var(--gap-2)', alignItems: 'center' }}>
          <button
            type="button"
            className="ingest__button"
            style={{ padding: 'var(--gap-1) var(--gap-3)', fontSize: 'var(--size-sm)' }}
            onClick={() => void performSync(true)}
            disabled={loading || syncing}
          >
            {syncing ? 'Checking Gmail...' : loading ? 'Refreshing...' : 'Refresh emails'}
          </button>
        </div>
      </div>

      {/* The filters, the sort and the bulk read mark. Every control writes the URL. Each control carries its own
          aria-label: a <label> that wraps a <select> would fold the option texts into the select's name. */}
      <div className="email-monitor__filters">
        {/* The class, or all job mail, or everything. */}
        <label className="email-monitor__filter">
          Type
          <select aria-label="Type" value={filters.cls} onChange={(e) => setFilter({ cls: e.target.value as EmailFilters['cls'] })}>
            {CLASS_FILTER_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </label>
        {/* Tracked or not; "Not tracked" is the Add to Applied list. */}
        <label className="email-monitor__filter">
          Tracking
          <select aria-label="Tracking" value={filters.track} onChange={(e) => setFilter({ track: e.target.value as EmailFilters['track'] })}>
            {/* Both. */}
            <option value="all">All</option>
            {/* Linked to an application. */}
            <option value="tracked">Tracked</option>
            {/* The Add to Applied list. */}
            <option value="untracked">Not tracked</option>
          </select>
        </label>
        {/* Inclusive day range. */}
        <label className="email-monitor__filter">
          From
          <input type="date" aria-label="From" value={filters.from} onChange={(e) => setFilter({ from: e.target.value })} />
        </label>
        <label className="email-monitor__filter">
          To
          <input type="date" aria-label="To" value={filters.to} onChange={(e) => setFilter({ to: e.target.value })} />
        </label>
        {/* The order. */}
        <label className="email-monitor__filter">
          Sort
          <select aria-label="Sort" value={filters.sort} onChange={(e) => setFilter({ sort: e.target.value as EmailFilters['sort'] })}>
            {/* The default. */}
            <option value="newest">Newest first</option>
            {/* Catch-up order. */}
            <option value="oldest">Oldest first</option>
            {/* Groups one company's mail. */}
            <option value="sender">Sender A to Z</option>
          </select>
        </label>
        {/* Every unread row on screen, in one write. */}
        <button
          type="button"
          className="email-card__action email-monitor__mark-all"
          disabled={metrics.unreadShown === 0}
          onClick={() => void markRead(shown.filter((e) => e.read_at === null).map((e) => e.id))}
        >
          Mark all shown as read ({metrics.unreadShown})
        </button>
      </div>

      {/* The sync's quiet one-liner: muted fact, never a banner, never blocks the list.
          The failure detail rides in the hover title so the line itself stays calm. */}
      {syncStatusLine(syncState) !== null && (
        <p
          style={{ fontSize: 'var(--size-sm)', color: 'var(--ink-muted)', margin: '0 0 var(--gap-3) 0' }}
          title={syncDetail ?? undefined}
        >
          {syncStatusLine(syncState)}
        </p>
      )}

      {/* Error banner if the DATABASE query failed (sync failures stay in the line above) */}
      {error !== null && (
        <p className="store-notice store-notice--bad" style={{ marginBottom: 'var(--gap-3)' }}>
          {error}
        </p>
      )}

      {/* The list, or an empty state that names the filters as the reason when they are set. */}
      {shown.length === 0 ? (
        <div className="email-empty">
          <p style={{ fontWeight: 600, margin: '0 0 var(--gap-1) 0' }}>No emails match.</p>
          <p style={{ margin: 0, fontSize: 'var(--size-sm)' }}>
            {searchParams.toString() !== '' ? 'Clear or widen the filters above to see more.' : 'Job mail the tracker captures appears here.'}
          </p>
        </div>
      ) : (
        <ul className="email-list">
          {shown.map((event) => (
            /* Keyed by the email id: its lock, note and draft follow it. */
            <EmailRow
              key={event.id}
              event={event}
              locked={busy.has(event.id)}
              note={notes[event.id] ?? null}
              draft={drafts[event.id] ?? null}
              /* The duplicate guard's candidates, once looked up. */
              links={links[event.id] ?? null}
              /* The confirmed link: matched_application_id only. */
              onLink={(applicationId) => void link(event, applicationId)}
              /* From the candidates to the new-job form. */
              onAddNew={() => {
                // From the candidates to the form: the operator says this is a different job.
                setLinks((prev) => Object.fromEntries(Object.entries(prev).filter(([k]) => k !== event.id)));
                // The form, prefilled as usual.
                setDrafts((prev) => ({ ...prev, [event.id]: prefillOf(event) }));
              }}
              onMarkRead={() => void markRead([event.id])}
              /* Looks for existing applications first (the duplicate guard), then opens the right step. */
              onOpenTrack={() => void openAdd(event)}
              onDraftChange={(draft) => setDrafts((prev) => ({ ...prev, [event.id]: draft }))}
              /* Closes the candidates and the form; writes nothing. */
              onCancelTrack={() => closeAdd(event.id)}
              onTrack={() => void track(event)}
            />
          ))}
        </ul>
      )}
    </div>
  );
}
