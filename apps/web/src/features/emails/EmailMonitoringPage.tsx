/* Email Intake & Tracker Monitoring Screen.
 *
 * PURPOSE:
 * Displays real-time inbound recruiter email telemetry ingested from Gmail Apps Script
 * via the /email-tracker-intake edge function.
 *
 * ROW LEVEL SECURITY INVARIANT:
 * Scoped by Postgres RLS: (select auth.uid()) = user_id.
 * Only the authenticated operator's emails are returned by the query.
 *
 * UNTRUSTED CONTENT SAFEGUARD:
 * Email subjects and snippets are untrusted recruiter input and rendered safely
 * through React's text escaping, never interpolated into HTML or executable contexts.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactElement } from 'react';

import { supabase } from '../../data/supabase.ts';
import { PageHeader } from '../../app/PageHeader.tsx';

import './EmailMonitoringPage.css';

/* Data model matching the public.email_events schema */
export interface EmailEventRow {
  readonly id: string;
  readonly user_id: string;
  readonly provider_message_id: string;
  readonly from_address: string;
  readonly subject: string;
  readonly snippet: string;
  readonly received_at: string;
  readonly classification: 'unclassified' | 'rejection' | 'interview_invite' | 'assessment' | 'acknowledgement' | string;
  readonly classification_confidence: number | null;
  readonly matched_application_id: string | null;
  readonly processed_at: string | null;
  readonly created_at: string;
}

export function EmailMonitoringPage(): ReactElement {
  /* List of email events retrieved from the database */
  const [events, setEvents] = useState<readonly EmailEventRow[]>([]);
  /* Loading state while query is in flight */
  const [loading, setLoading] = useState<boolean>(true);
  /* Error state if query fails or client is disconnected */
  const [error, setError] = useState<string | null>(null);
  /* Query filter string for instant search */
  const [searchQuery, setSearchQuery] = useState<string>('');

  /* Fetch latest email events from Supabase */
  const fetchEvents = useCallback(async () => {
    /* If Supabase client is unconfigured, transition safely */
    if (supabase === null) {
      setLoading(false);
      setError('Supabase client is unconfigured. Connect your environment to view live email events.');
      return;
    }

    setLoading(true);
    setError(null);

    try {
      /* Query email_events ordered by received_at descending */
      const { data, error: queryError } = await supabase
        .from('email_events')
        .select('*')
        .order('received_at', { ascending: false })
        .limit(100);

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

  /* Initial fetch on mount */
  useEffect(() => {
    void fetchEvents();
  }, [fetchEvents]);

  /* Filter events based on active search text */
  const filteredEvents = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) return events;
    return events.filter(
      (ev) =>
        ev.from_address.toLowerCase().includes(query) ||
        ev.subject.toLowerCase().includes(query) ||
        ev.snippet.toLowerCase().includes(query),
    );
  }, [events, searchQuery]);

  /* Calculate summary telemetry metrics */
  const metrics = useMemo(() => {
    const total = events.length;
    const interviews = events.filter((e) => e.classification === 'interview_invite').length;
    const rejections = events.filter((e) => e.classification === 'rejection').length;
    const pending = events.filter((e) => e.processed_at === null || e.classification === 'unclassified').length;
    return { total, interviews, rejections, pending };
  }, [events]);

  return (
    <div className="email-monitor">
      {/* Top page title and lede */}
      <div className="email-monitor__header">
        <PageHeader path="emails" />
      </div>

      {/* Summary KPI metric cards */}
      <div className="email-monitor__stats">
        <div className="email-stat-card">
          <span className="email-stat-card__label">Total Inbounds</span>
          <span className="email-stat-card__value">{metrics.total}</span>
        </div>
        <div className="email-stat-card">
          <span className="email-stat-card__label">Interviews</span>
          <span className="email-stat-card__value" style={{ color: '#4ade80' }}>
            {metrics.interviews}
          </span>
        </div>
        <div className="email-stat-card">
          <span className="email-stat-card__label">Rejections</span>
          <span className="email-stat-card__value" style={{ color: '#f87171' }}>
            {metrics.rejections}
          </span>
        </div>
        <div className="email-stat-card">
          <span className="email-stat-card__label">Awaiting Classifier</span>
          <span className="email-stat-card__value" style={{ color: '#c084fc' }}>
            {metrics.pending}
          </span>
        </div>
      </div>

      {/* Action toolbar with search and refresh button */}
      <div className="email-monitor__toolbar">
        <input
          type="search"
          className="email-monitor__search"
          placeholder="Filter by sender, subject, or keywords..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          aria-label="Filter email events"
        />
        <button
          type="button"
          className="ingest__button"
          style={{ padding: 'var(--gap-1) var(--gap-3)', fontSize: 'var(--size-sm)' }}
          onClick={() => void fetchEvents()}
          disabled={loading}
        >
          {loading ? 'Refreshing...' : 'Refresh Feed'}
        </button>
      </div>

      {/* Error banner if query failed */}
      {error !== null && (
        <p className="store-notice store-notice--bad" style={{ marginBottom: 'var(--gap-3)' }}>
          {error}
        </p>
      )}

      {/* Main event list */}
      {filteredEvents.length === 0 ? (
        <div className="email-empty">
          <p style={{ fontWeight: 600, margin: '0 0 var(--gap-1) 0' }}>No email events found.</p>
          <p style={{ margin: 0, fontSize: 'var(--size-sm)' }}>
            Inbound emails sent by the Gmail Apps Script will automatically appear here in real-time.
          </p>
        </div>
      ) : (
        <ul className="email-list">
          {filteredEvents.map((event) => {
            const categoryClass =
              event.classification === 'interview_invite'
                ? 'email-badge--interview'
                : event.classification === 'rejection'
                  ? 'email-badge--rejection'
                  : event.classification === 'acknowledgement'
                    ? 'email-badge--acknowledgement'
                    : 'email-badge--unclassified';

            const formattedDate = new Date(event.received_at).toLocaleString();

            return (
              <li key={event.id} className="email-card">
                <div className="email-card__top">
                  <span className="email-card__sender">{event.from_address}</span>
                  <div style={{ display: 'flex', gap: 'var(--gap-2)', alignItems: 'center' }}>
                    <span className={`email-badge ${categoryClass}`}>
                      {event.classification.replace('_', ' ')}
                    </span>
                    <span className="email-card__time">{formattedDate}</span>
                  </div>
                </div>

                <h3 className="email-card__subject">{event.subject}</h3>
                <p className="email-card__snippet">{event.snippet}</p>

                <div className="email-card__meta">
                  <span>
                    ID: <code className="identifier">{event.provider_message_id}</code>
                  </span>
                  {event.matched_application_id !== null ? (
                    <span style={{ color: 'var(--accent)' }}>
                      Linked to Application: <code className="identifier">{event.matched_application_id.slice(0, 8)}</code>
                    </span>
                  ) : (
                    <span>Unlinked Inbound</span>
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
