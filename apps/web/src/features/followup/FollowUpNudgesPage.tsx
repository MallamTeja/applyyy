/* Follow-Up Nudges Queue Page — Operations Console
 *
 * Allows the operator to review Day-7 post-application follow-up email drafts.
 * Uses `supabase` client from `../../data/supabase.ts`.
 *
 * Enforces:
 *   - Manual copy & email compose (prevents automated Gmail spam blacklisting)
 *   - One-click "Copy & Open Gmail" compose window helper
 *   - Database status updates for sent, snoozed, and dismissed nudges
 */

import { useCallback, useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import { PageHeader } from '../../app/PageHeader';
import { supabase } from '../../data/supabase.ts';
import './followup.css';

// Interface for FollowUp Nudge Row from database
interface NudgeItem {
  id: string;
  application_id: string;
  job_id: string;
  nudge_type: string;
  draft_subject: string;
  draft_body: string;
  status: string;
  created_at: string;
  companyName?: string;
  jobTitle?: string;
}

export function FollowUpNudgesPage(): ReactElement {
  // State holding active follow-up nudges
  const [nudges, setNudges] = useState<readonly NudgeItem[]>([]);
  // State holding loading status
  const [loading, setLoading] = useState<boolean>(true);
  // State holding copy toast confirmation string
  const [copiedId, setCopiedId] = useState<string | null>(null);

  // Fetch pending follow-up nudges from database
  const loadNudges = useCallback(async () => {
    try {
      setLoading(true);
      if (supabase === null) {
        setLoading(false);
        return;
      }

      // Query follow_up_nudges table joined with applications & jobs
      const { data, error } = await supabase!
        .from('follow_up_nudges')
        .select('id, application_id, job_id, nudge_type, draft_subject, draft_body, status, created_at, applications(jobs(title, company_name))')
        .eq('status', 'pending')
        .order('created_at', { ascending: false });

      if (error || !data) {
        setLoading(false);
        return;
      }

      // Map rows to NudgeItem array
      const mapped: NudgeItem[] = data.map((row) => {
        const app = row.applications as unknown as { jobs?: { title?: string; company_name?: string } } | null;
        return {
          id: row.id,
          application_id: row.application_id,
          job_id: row.job_id,
          nudge_type: row.nudge_type,
          draft_subject: row.draft_subject,
          draft_body: row.draft_body,
          status: row.status,
          created_at: row.created_at,
          companyName: app?.jobs?.company_name ?? 'Company',
          jobTitle: app?.jobs?.title ?? 'Position',
        };
      });

      setNudges(mapped);
    } catch (err) {
      console.error('Failed to load follow-up nudges:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadNudges();
  }, [loadNudges]);

  // Open Gmail pre-filled compose window and copy draft text
  const handleOpenGmail = async (nudge: NudgeItem) => {
    try {
      await navigator.clipboard.writeText(`Subject: ${nudge.draft_subject}\n\n${nudge.draft_body}`);
      setCopiedId(nudge.id);
      setTimeout(() => setCopiedId(null), 2500);

      const gmailUrl = `https://mail.google.com/mail/?view=cm&fs=1&su=${encodeURIComponent(nudge.draft_subject)}&body=${encodeURIComponent(nudge.draft_body)}`;
      window.open(gmailUrl, '_blank', 'noopener,noreferrer');
    } catch (err) {
      console.error('Failed to open Gmail compose:', err);
    }
  };

  // Mark follow-up nudge as sent in database
  const handleMarkSent = async (id: string) => {
    try {
      if (supabase !== null) {
        await supabase!.from('follow_up_nudges').update({ status: 'sent', sent_at: new Date().toISOString() }).eq('id', id);
      }
      setNudges((prev) => prev.filter((n) => n.id !== id));
    } catch (err) {
      console.error('Failed to mark nudge as sent:', err);
    }
  };

  // Dismiss nudge from list
  const handleDismiss = async (id: string) => {
    try {
      if (supabase !== null) {
        await supabase!.from('follow_up_nudges').update({ status: 'dismissed' }).eq('id', id);
      }
      setNudges((prev) => prev.filter((n) => n.id !== id));
    } catch (err) {
      console.error('Failed to dismiss nudge:', err);
    }
  };

  return (
    <div className="page page--wide followup-page">
      <PageHeader path="nudges" />

      {/* Header banner */}
      <section className="followup-page__banner" aria-label="Follow-Up Nudges Overview">
        <div>
          <h2>📬 Day-7 Follow-Up Nudges Queue</h2>
          <p>
            Review polite follow-up email drafts generated for applications sitting for $\ge 7$ days without a recruiter response.
          </p>
        </div>
        <div className="followup-page__meta-badge">
          <span>{nudges.length} Pending Nudges</span>
        </div>
      </section>

      {/* Nudge list grid */}
      {loading ? (
        <div className="followup-page__empty">
          <p>Loading follow-up nudges from database...</p>
        </div>
      ) : nudges.length === 0 ? (
        <div className="followup-page__empty">
          <p>No pending follow-up nudges. Applications sitting for over 7 days will automatically appear here.</p>
        </div>
      ) : (
        <div className="followup-page__grid">
          {nudges.map((nudge) => (
            <article key={nudge.id} className="followup-card">
              <header className="followup-card__header">
                <div className="followup-card__top">
                  <span className="followup-card__company">{nudge.companyName}</span>
                  <span className="followup-card__badge">⏳ 7 Days Post-Apply</span>
                </div>
                <h3 className="followup-card__title">{nudge.jobTitle}</h3>
              </header>

              <div className="followup-card__body-box">
                <div className="followup-card__subject">
                  <strong>Subject:</strong> {nudge.draft_subject}
                </div>
                <div className="followup-card__message">{nudge.draft_body}</div>
              </div>

              <footer className="followup-card__footer">
                <div className="followup-card__actions">
                  <button
                    type="button"
                    className="button button--primary button--small"
                    onClick={() => void handleOpenGmail(nudge)}
                  >
                    {copiedId === nudge.id ? '✓ Copied & Gmail Opened!' : '✉️ Copy & Open Gmail ↗'}
                  </button>

                  <button
                    type="button"
                    className="button button--secondary button--small"
                    onClick={() => void handleMarkSent(nudge.id)}
                  >
                    ✅ Mark as Sent
                  </button>

                  <button
                    type="button"
                    className="button button--ghost button--small"
                    onClick={() => void handleDismiss(nudge.id)}
                  >
                    🗑️ Dismiss
                  </button>
                </div>
              </footer>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}
