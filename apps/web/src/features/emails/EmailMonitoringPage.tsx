/* Email Intake & Interview Tracker Monitoring Screen.
 *
 * PURPOSE:
 * Displays strictly interview invitations and recruiter screening requests
 * received from recruiters in the user's Gmail.
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
  readonly classification: string;
  readonly classification_confidence: number | null;
  readonly matched_application_id: string | null;
  readonly processed_at: string | null;
  readonly created_at: string;
}

/* Pure helper: determines if an inbound email represents a legitimate interview invitation.
 * Rejects newsletters, security alerts, and social digests outright. */
export function isInterviewEmail(ev: EmailEventRow): boolean {
  /* 1. Explicit classifier positive match */
  if (ev.classification === 'interview_invite' || ev.classification === 'interview') {
    return true;
  }

  /* 2. Disqualify known system and social senders */
  const fromLower = ev.from_address.toLowerCase();
  if (
    fromLower.includes('no-reply@accounts.google.com') ||
    fromLower.includes('redditmail.com') ||
    fromLower.includes('updates-noreply@linkedin.com') ||
    fromLower.includes('messages-noreply@linkedin.com') ||
    fromLower.includes('notifications@') ||
    fromLower.includes('security-noreply')
  ) {
    return false;
  }

  /* 3. Disqualify obvious automated newsletters by subject */
  const subjectLower = ev.subject.toLowerCase();
  if (
    subjectLower.includes('security alert') ||
    subjectLower.includes('digest') ||
    subjectLower.includes('new sign-in') ||
    subjectLower.includes('passkey added')
  ) {
    return false;
  }

  /* 4. Detect interview invitation intent in subject or body snippet */
  const content = (ev.subject + ' ' + ev.snippet).toLowerCase();
  return (
    content.includes('interview') ||
    content.includes('invitation to interview') ||
    content.includes('screening call') ||
    content.includes('schedule a call') ||
    content.includes('schedule a chat') ||
    content.includes('technical round') ||
    content.includes('hiring manager chat') ||
    content.includes('shortlisted')
  );
}

export function EmailMonitoringPage(): ReactElement {
  /* Raw list of email events retrieved from the database */
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

  /* Initial fetch on mount */
  useEffect(() => {
    void fetchEvents();
  }, [fetchEvents]);

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
    <div className="email-monitor">
      {/* Top page title and lede */}
      <div className="email-monitor__header">
        <PageHeader path="emails" />
      </div>

      {/* Summary KPI metric cards focusing strictly on interviews */}
      <div className="email-monitor__stats">
        <div className="email-stat-card">
          <span className="email-stat-card__label">Interview Invitations</span>
          <span className="email-stat-card__value" style={{ color: '#4ade80' }}>
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
          <span className="email-stat-card__value">
            {metrics.directInvites}
          </span>
        </div>
      </div>

      {/* Action toolbar with search and refresh button */}
      <div className="email-monitor__toolbar">
        <input
          type="search"
          className="email-monitor__search"
          placeholder="Filter interviews by company or recruiter..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          aria-label="Filter interview invitations"
        />
        <button
          type="button"
          className="ingest__button"
          style={{ padding: 'var(--gap-1) var(--gap-3)', fontSize: 'var(--size-sm)' }}
          onClick={() => void fetchEvents()}
          disabled={loading}
        >
          {loading ? 'Refreshing...' : 'Refresh Interviews'}
        </button>
      </div>

      {/* Error banner if query failed */}
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
            When recruiters email you regarding interviews, screening rounds, or technical chats, they will automatically be isolated and displayed here.
          </p>
        </div>
      ) : (
        <ul className="email-list">
          {filteredEvents.map((event) => {
            const formattedDate = new Date(event.received_at).toLocaleString();

            return (
              <li key={event.id} className="email-card" style={{ borderLeft: '3px solid #4ade80' }}>
                <div className="email-card__top">
                  <span className="email-card__sender">{event.from_address}</span>
                  <div style={{ display: 'flex', gap: 'var(--gap-2)', alignItems: 'center' }}>
                    <span className="email-badge email-badge--interview">
                      Interview Invite
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
