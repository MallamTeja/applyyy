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

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { PageHeader } from '../../app/PageHeader';
// Write failures must be visible; the app's toast is the existing channel for that.
import { useToast } from '../../app/Toast';
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
  // Load failure message, kept apart from "no rows" so a broken query never reads as an empty queue.
  const [loadError, setLoadError] = useState<string | null>(null);
  // Pending "Copied!" reset timer, held so unmount can cancel it instead of setting state on a dead component.
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Error toasts for failed status writes.
  const toast = useToast();

  // Cancel the copy-feedback timer on unmount.
  useEffect(() => () => {
    // Nothing to clear if no copy happened.
    if (copyTimerRef.current !== null) clearTimeout(copyTimerRef.current);
  }, []);

  // Fetch pending follow-up nudges from database
  const loadNudges = useCallback(async () => {
    try {
      setLoading(true);
      // A retry starts from a clean slate, not the previous failure.
      setLoadError(null);
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

      // A failed query is shown as an error, never as the friendly "no nudges" state.
      if (error || !data) {
        // The database's own message, so the cause is diagnosable.
        setLoadError(error?.message ?? 'No data returned.');
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
      // A thrown error (network) is also a load failure, not an empty queue.
      setLoadError(err instanceof Error ? err.message : String(err));
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
      // Replace any earlier timer so two quick copies do not cut each other's feedback short.
      if (copyTimerRef.current !== null) clearTimeout(copyTimerRef.current);
      // Held in the ref so the unmount cleanup can cancel it.
      copyTimerRef.current = setTimeout(() => setCopiedId(null), 2500);

      // No `to=`: neither follow_up_nudges nor the joined applications/jobs rows store a
      // recruiter address, so the operator fills the recipient in Gmail.
      const gmailUrl = `https://mail.google.com/mail/?view=cm&fs=1&su=${encodeURIComponent(nudge.draft_subject)}&body=${encodeURIComponent(nudge.draft_body)}`;
      window.open(gmailUrl, '_blank', 'noopener,noreferrer');
    } catch (err) {
      console.error('Failed to open Gmail compose:', err);
    }
  };

  // Writes a nudge's new status and removes it from the list ONLY once the row changed.
  // Shared by Mark-as-Sent and Dismiss, which differ only in the patch and the wording.
  const updateNudge = async (id: string, patch: Record<string, string>, verb: string) => {
    // Without a client nothing is saved, so the card must stay put.
    if (supabase === null) {
      // Tell the operator why the click did nothing.
      toast.error(`Not connected to Supabase — nudge was not ${verb}.`);
      return;
    }
    try {
      // supabase-js returns errors rather than throwing; the old code ignored this and
      // removed the card anyway, so it came back on the next reload.
      const { error } = await supabase.from('follow_up_nudges').update(patch).eq('id', id);
      if (error) {
        // Visible failure; the card stays so the operator can retry.
        toast.error(`Could not mark nudge ${verb}: ${error.message}`);
        return;
      }
      // Remove only after the database agrees the nudge is no longer pending.
      setNudges((prev) => prev.filter((n) => n.id !== id));
    } catch (err) {
      // Network-level failure, same treatment as a returned error.
      toast.error(`Could not mark nudge ${verb}: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  // Mark follow-up nudge as sent, stamping when so reporting can measure response time.
  const handleMarkSent = (id: string) => updateNudge(id, { status: 'sent', sent_at: new Date().toISOString() }, 'sent');

  // Dismiss: the operator decided not to follow up on this one.
  const handleDismiss = (id: string) => updateNudge(id, { status: 'dismissed' }, 'dismissed');

  return (
    <div className="page page--wide followup-page">
      <PageHeader path="nudges" />

      {/* Header banner */}
      <section className="followup-page__banner" aria-label="Follow-Up Nudges Overview">
        <div>
          <h2>📬 Day-7 Follow-Up Nudges Queue</h2>
          <p>
            Review polite follow-up email drafts generated for applications sitting for ≥ 7 days without a recruiter response.
          </p>
        </div>
        <div className="followup-page__meta-badge">
          {/* Singular at exactly one: "1 Pending Nudges" read as a bug and made
              the operator doubt the count itself. */}
          <span>{nudges.length} Pending {nudges.length === 1 ? 'Nudge' : 'Nudges'}</span>
        </div>
      </section>

      {/* Nudge list grid */}
      {loading ? (
        <div className="followup-page__empty">
          <p>Loading follow-up nudges from database...</p>
        </div>
      ) : loadError !== null ? (
        // Distinct from the empty state: a failed query must not read as "nothing to follow up".
        <div className="followup-page__empty" role="alert">
          {/* The database's own message, so the cause is diagnosable. */}
          <p>Could not load follow-up nudges: {loadError}</p>
          {/* Retry without a full page reload. */}
          <button type="button" className="button button--secondary button--small" onClick={() => void loadNudges()}>
            Retry
          </button>
        </div>
      ) : nudges.length === 0 ? (
        <div className="followup-page__empty">
          {/* Names the real trigger (W22, 2026-11-01): nothing drafts nudges on its own; the
              satellites workflow calls follow-up once a day, which drafts at most 5 per run. */}
          <p>No pending follow-up nudges. The daily satellites workflow drafts up to 5 per run, for applications marked applied at least 7 days ago.</p>
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
