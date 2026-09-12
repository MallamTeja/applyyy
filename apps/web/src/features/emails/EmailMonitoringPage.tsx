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

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactElement } from 'react';

import { supabase } from '../../data/supabase.ts';
import { PageHeader } from '../../app/PageHeader.tsx';
import {
  canTriggerSync,
  EMAIL_SYNC_STORAGE_KEY,
  formatSyncTime,
  isInterviewEmail,
  resolveEmailSyncUrl,
  triggerGmailSync,
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
  /* Error state if query or sync fails */
  const [error, setError] = useState<string | null>(null);
  /* Informational notice describing sync result */
  const [syncNotice, setSyncNotice] = useState<string | null>(null);
  /* Timestamp of last successful sync execution */
  const [lastSyncedAt, setLastSyncedAt] = useState<number | null>(null);
  /* Query filter string for instant search */
  const [searchQuery, setSearchQuery] = useState<string>('');
  /* Custom webhook URL saved in localStorage */
  const [customSyncUrl, setCustomSyncUrl] = useState<string>(() => {
    try {
      return localStorage.getItem(EMAIL_SYNC_STORAGE_KEY) ?? '';
    } catch {
      return '';
    }
  });
  /* Toggle for sync settings drawer */
  const [showSettings, setShowSettings] = useState<boolean>(false);

  /* Resolved sync URL from environment or localStorage */
  const activeSyncUrl = useMemo(() => {
    const envUrl = (import.meta as unknown as { env?: Record<string, string> }).env?.VITE_EMAIL_SYNC_WEBHOOK_URL;
    return resolveEmailSyncUrl(envUrl, customSyncUrl);
  }, [customSyncUrl]);

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

  /* Execute on-demand live Gmail sync and re-fetch events */
  const performSync = useCallback(
    async (manual: boolean) => {
      // Always re-fetch current DB events first
      await fetchEvents();

      // If no sync URL is configured, report advice on manual click
      if (!activeSyncUrl) {
        if (manual) {
          setSyncNotice(
            'Tip: Deploy the updated Apps Script Web App and paste the URL in "Sync Settings" to enable live 1-click Gmail sync.',
          );
        }
        return;
      }

      // Check lock and cooldown constraints
      if (!canTriggerSync(lastSyncedAt, syncing)) {
        if (manual) {
          setSyncNotice('Sync cooldown active. Please wait a few seconds before checking Gmail again.');
        }
        return;
      }

      setSyncing(true);
      setSyncNotice('Connecting to Gmail & ingesting new interview emails...');

      try {
        const result = await triggerGmailSync(activeSyncUrl);
        if (result.ok) {
          setLastSyncedAt(Date.now());
          setSyncNotice('Gmail sync complete. Checking for latest events...');
          // Refresh database rows to surface any newly ingested emails
          await fetchEvents();
          setSyncNotice(null);
        } else {
          setError(result.message);
          setSyncNotice(null);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Error triggering Gmail sync.');
        setSyncNotice(null);
      } finally {
        setSyncing(false);
      }
    },
    [activeSyncUrl, fetchEvents, lastSyncedAt, syncing],
  );

  /* Initial on-demand sync and fetch on page mount (Page Open) */
  useEffect(() => {
    void performSync(false);
  }, [performSync]);

  /* Save custom sync URL to localStorage */
  const handleSaveSyncUrl = useCallback((newUrl: string) => {
    setCustomSyncUrl(newUrl);
    try {
      localStorage.setItem(EMAIL_SYNC_STORAGE_KEY, newUrl.trim());
    } catch {
      // LocalStorage access restricted in some sandboxes
    }
  }, []);

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
          <span className="email-stat-card__value">{metrics.directInvites}</span>
        </div>
        <div className="email-stat-card">
          <span className="email-stat-card__label">Monitoring Mode</span>
          <span className="email-stat-card__value" style={{ fontSize: 'var(--size-base)', fontWeight: 600 }}>
            {activeSyncUrl ? '⚡ On-Demand (Page Open)' : '📦 Supabase Cached'}
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
          <button
            type="button"
            className="email-monitor__settings-toggle"
            onClick={() => setShowSettings((prev) => !prev)}
            title="Configure Gmail On-Demand Sync URL"
          >
            {showSettings ? 'Close Settings' : 'Sync Settings'}
          </button>
        </div>
      </div>

      {/* Sync settings drawer for configuring the Apps Script Web App URL */}
      {showSettings && (
        <div className="email-monitor__settings-box">
          <h4 style={{ margin: '0 0 var(--gap-2) 0', fontSize: 'var(--size-sm)' }}>
            Gmail Webhook Configuration
          </h4>
          <p style={{ fontSize: 'var(--size-xs)', color: 'var(--ink-muted)', margin: '0 0 var(--gap-2) 0' }}>
            Enter your Google Apps Script Web App URL to enable on-demand Gmail sync for interview invitations.
          </p>
          <input
            type="url"
            className="email-monitor__url-input"
            placeholder="https://script.google.com/macros/s/.../exec?secret=YOUR_SECRET"
            value={customSyncUrl}
            onChange={(e) => handleSaveSyncUrl(e.target.value)}
          />
        </div>
      )}

      {/* Informational notification */}
      {syncNotice !== null && (
        <p className="store-notice store-notice--info" style={{ marginBottom: 'var(--gap-3)' }}>
          {syncNotice}
        </p>
      )}

      {/* Error banner if query or sync failed */}
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
              <li key={event.id} className="email-card" style={{ borderLeft: '3px solid #4ade80' }}>
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

                <h3 className="email-card__subject">
                  <a
                    href={`https://mail.google.com/mail/u/0/#all/${encodeURIComponent(event.provider_message_id)}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="email-card__subject-link"
                    title="Open email thread in Gmail"
                  >
                    {event.subject}
                  </a>
                </h3>
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
