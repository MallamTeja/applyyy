/* Email Intake & Interview Tracker Monitoring Screen.
 *
 * PURPOSE:
 * Displays strictly interview invitations and recruiter screening requests
 * received from recruiters in the user's Gmail.
 *
 * ON-DEMAND SYNC INVARIANT:
 * Zero continuous 15-minute background polling triggers.
 * Monitoring is triggered automatically on page mount (opening the page)
 * and manually when the operator clicks "Refresh Interviews".
 *
 * FILTERING INVARIANT:
 * ONLY interview emails are displayed. General alerts, Google security notices,
 * social newsletters (Reddit, LinkedIn suggestions) and non-interview mail
 * are filtered out completely so the operator only sees high-value interview leads.
 *
 * ROW LEVEL SECURITY INVARIANT:
 * Scoped by Postgres RLS: (select auth.uid()) = user_id.
 * Only the authenticated operator's emails are returned by the query.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactElement } from 'react';

import { supabase } from '../../data/supabase.ts';
import { PageHeader } from '../../app/PageHeader.tsx';
import {
  formatSyncTime,
  isInterviewEmail,
  readLastGmailSyncMs,
  shouldAutoSync,
  syncGmailInbox,
  syncStatusLine,
  writeLastGmailSyncMs,
  type EmailEventRow,
} from './emailSync.ts';

import './EmailMonitoringPage.css';

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
  /* Query filter string for instant search */
  const [searchQuery, setSearchQuery] = useState<string>('');

  /* Fetch latest email events from Supabase */
  const fetchEvents = useCallback(async () => {
    if (supabase === null) {
      setLoading(false);
      setError('Supabase client is unconfigured. Connect your environment to view live email events.');
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const { data, error: queryError } = await supabase
        .from('email_events')
        .select('*')
        .order('received_at', { ascending: false })
        .limit(200);

      if (queryError) {
        setError(queryError.message);
      } else {
        setEvents((data as unknown as readonly EmailEventRow[]) ?? []);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to query email intake log.');
    } finally {
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
        setSyncState('cooldown');
        return;
      }

      setSyncing(true);
      setSyncState('syncing');

      // syncGmailInbox never throws: every path lands in the closed outcome union.
      const outcome = await syncGmailInbox(supabase);
      if (outcome.kind === 'ok') {
        // Record the instant in state (the card's "Last checked") and in storage (the cap).
        const now = Date.now();
        setLastSyncedAt(now);
        writeLastGmailSyncMs(storage, now);
        // Surface whatever the sync just ingested.
        await fetchEvents();
        setSyncState('ok');
        setSyncDetail(null);
      } else if (outcome.kind === 'cooldown') {
        // The server said "just ran" — same quiet line as the client-side skip.
        setSyncState('cooldown');
        setSyncDetail(null);
      } else {
        // Failed (503 not-configured included): quiet line, detail on hover, events stay.
        setSyncState('failed');
        setSyncDetail(outcome.message);
      }
      setSyncing(false);
    },
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

  /* STRICT INTERVIEW FILTER: Discard all non-interview emails */
  const interviewEvents = useMemo(() => {
    return events.filter(isInterviewEmail);
  }, [events]);

  /* Filter interview events based on active search text */
  const filteredEvents = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) return interviewEvents;
    return interviewEvents.filter(
      (ev) =>
        ev.from_address.toLowerCase().includes(query) ||
        ev.subject.toLowerCase().includes(query) ||
        ev.snippet.toLowerCase().includes(query),
    );
  }, [interviewEvents, searchQuery]);

  /* Calculate summary interview metrics */
  const metrics = useMemo(() => {
    const totalInterviews = interviewEvents.length;
    const linkedToApps = interviewEvents.filter((e) => e.matched_application_id !== null).length;
    const directInvites = interviewEvents.filter((e) => e.matched_application_id === null).length;
    return { totalInterviews, linkedToApps, directInvites };
  }, [interviewEvents]);

  return (
    /* `page` first: this was the ONLY screen in the app missing it, so the
       title, the KPI cards and every email card sat flush against the nav
       rail's border and the right edge of the viewport with no top padding,
       where every other screen has a --gap-6 gutter. `email-monitor` keeps
       carrying the page's own rules on top of the shared ones. */
    <div className="page email-monitor">
      {/* Top page title and lede */}
      <div className="email-monitor__header">
        <PageHeader path="emails" />
      </div>

      {/* Summary KPI metric cards focusing strictly on interviews */}
      <div className="email-monitor__stats">
        <div className="email-stat-card">
          <span className="email-stat-card__label">Interview Invitations</span>
          <span className="email-stat-card__value" style={{ /* Success token: #4ade80 is the dark-mode green and only 1.6:1 on a light sheet. */ color: 'var(--traced)' }}>
            {metrics.totalInterviews}
          </span>
        </div>
        <div className="email-stat-card">
          <span className="email-stat-card__label">Linked to Pipeline</span>
          <span className="email-stat-card__value" style={{ color: 'var(--accent)' }}>
            {metrics.linkedToApps}
          </span>
        </div>
        <div className="email-stat-card">
          <span className="email-stat-card__label">Direct Inbound Invites</span>
          <span className="email-stat-card__value">{metrics.directInvites}</span>
        </div>
        <div className="email-stat-card">
          <span className="email-stat-card__label">Monitoring Mode</span>
          {/* One mode since the edge-function transport: the page itself triggers the sync. */}
          <span className="email-stat-card__value" style={{ fontSize: 'var(--size-base)', fontWeight: 600 }}>
            ⚡ On-Demand (Page Open)
          </span>
          <span style={{ fontSize: 'var(--size-xs)', color: 'var(--ink-muted)' }}>
            Last checked: {formatSyncTime(lastSyncedAt)}
          </span>
        </div>
      </div>

      {/* Action toolbar with search, refresh button and settings toggle */}
      <div className="email-monitor__toolbar">
        <input
          type="search"
          className="email-monitor__search"
          placeholder="Filter interviews by company or recruiter..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          aria-label="Filter interview invitations"
        />
        <div style={{ display: 'flex', gap: 'var(--gap-2)', alignItems: 'center' }}>
          <button
            type="button"
            className="ingest__button"
            style={{ padding: 'var(--gap-1) var(--gap-3)', fontSize: 'var(--size-sm)' }}
            onClick={() => void performSync(true)}
            disabled={loading || syncing}
          >
            {syncing ? 'Checking Gmail...' : loading ? 'Refreshing...' : 'Refresh Interviews'}
          </button>
        </div>
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

      {/* Main interview list */}
      {filteredEvents.length === 0 ? (
        <div className="email-empty">
          <p style={{ fontWeight: 600, margin: '0 0 var(--gap-1) 0' }}>No interview invitations found.</p>
          <p style={{ margin: 0, fontSize: 'var(--size-sm)' }}>
            When recruiters email you regarding interviews, screening rounds, or technical chats, they will
            automatically be isolated and displayed here.
          </p>
        </div>
      ) : (
        <ul className="email-list">
          {filteredEvents.map((event) => {
            const formattedDate = new Date(event.received_at).toLocaleString();

            return (
              <li key={event.id} className="email-card" style={{ /* Success token so the interview stripe reads in both themes, not just dark. */ borderLeft: '3px solid var(--traced)' }}>
                <div className="email-card__top">
                  <span className="email-card__sender">{event.from_address}</span>
                  <div style={{ display: 'flex', gap: 'var(--gap-2)', alignItems: 'center' }}>
                    <a
                      href={`https://mail.google.com/mail/u/0/#all/${encodeURIComponent(event.provider_message_id)}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="email-card__gmail-button"
                      title="Open email thread in Gmail"
                    >
                      Open in Gmail ↗
                    </a>
                    <span className="email-badge email-badge--interview">Interview Invite</span>
                    <span className="email-card__time">{formattedDate}</span>
                  </div>
                </div>

                {/* h2, not h3: the page h1 is the only heading above a card subject,
                    and h1→h3 skips a level (fixed 2026-10-23); the class carries the size. */}
                <h2 className="email-card__subject">
                  <a
                    href={`https://mail.google.com/mail/u/0/#all/${encodeURIComponent(event.provider_message_id)}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="email-card__subject-link"
                    title="Open email thread in Gmail"
                  >
                    {event.subject}
                  </a>
                </h2>
                <p className="email-card__snippet">{event.snippet}</p>

                <div className="email-card__meta">
                  <span>
                    ID: <code className="identifier">{event.provider_message_id}</code>
                  </span>
                  {event.matched_application_id !== null ? (
                    <span style={{ color: 'var(--accent)' }}>
                      Matched to Job: <code className="identifier">{event.matched_application_id.slice(0, 8)}</code>
                    </span>
                  ) : (
                    <span>Direct Recruiter Inbound</span>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
