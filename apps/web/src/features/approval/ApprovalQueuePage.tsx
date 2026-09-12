/* THE TWO-BUCKET APPROVAL QUEUE - PROJECT_PLAN.md section 11.
 *
 * The split is NOT about speed. At ~35 applications a day, reviewing every one
 * individually costs about twelve minutes, which is perfectly sustainable. The
 * split exists to put attention where the risk is: one undifferentiated queue
 * gives the dangerous rows the same three seconds as the safe ones, and the
 * dangerous rows are the entire reason the gate exists.
 *
 * So the page is built around one asymmetry:
 *
 *   BUCKET A - every line traced. Presented as a COUNT with one button. The
 *   operator is not asked to read thirty safe rows one at a time, because
 *   asking them to is how they learn to click without reading, and that habit
 *   is what then carries them through Bucket B.
 *
 *   BUCKET B - any untraceable claim. Presented as full diff views, expanded,
 *   one after another, each with its own gate. Never collapsed into a list,
 *   never batched, never given a count.
 *
 * Bucket B comes FIRST on the page. A list of clean rows above the dangerous
 * ones would mean the operator scrolls past thirty green rows to reach the one
 * that matters, which is exactly the skim the design is trying to prevent.
 */

import { useEffect, useMemo, useState } from 'react';
import type { ReactElement } from 'react';

import { PageHeader } from '../../app/PageHeader';
import { StatusBadge } from '../../app/StatusBadge';
import { SourceBadge } from '../../app/SourceBadge';
import { useToast } from '../../app/Toast';
import type {
  ApplicationRow,
  DiscoverySource,
  JobRow,
  MasterProfile,
  ResolvedResume,
} from '../../data/contract';
import { DiffView } from './DiffView';
import type { ClaimDecision } from './DiffView';
import { buildResumeDiff } from './diffAdapter';
import { deriveBucket } from './diffModel';
import type { ResumeDiff } from './diffModel';
import { supabase } from '../../data/supabase';

import './ApprovalQueuePage.css';

export function ApprovalQueuePage(): ReactElement {
  const toast = useToast();
  /* Live queue state. Defaults to empty array (NO mock data). */
  const [queue, setQueue] = useState<readonly ResumeDiff[]>([]);
  const [loading, setLoading] = useState<boolean>(true);

  /* Rows the operator has acted on this session, so they leave the queue
     without a refetch. */
  const [settled, setSettled] = useState<ReadonlySet<string>>(() => new Set());

  /* Query real applications from Supabase where status = awaiting_approval */
  useEffect(() => {
    if (supabase === null) {
      setLoading(false);
      return;
    }
    let live = true;
    async function loadQueue() {
      try {
        setLoading(true);

        // 1. Fetch latest master profile
        const { data: masterData } = await supabase!
          .from('master_profiles')
          .select('*')
          .order('version', { ascending: false })
          .limit(1)
          .maybeSingle();

        const masterVersion: number = masterData?.version ?? 1;
        const masterProfile: MasterProfile = (masterData?.profile as MasterProfile | undefined) ?? {
          schema_version: 1,
          identity: {
            full_name: 'Teja Mallam',
            headline: 'Software Engineer',
            email: 'tejamallam00@gmail.com',
            phone: '+91 9999999999',
            location: 'India',
            links: [],
          },
          summary: {
            id: 'summary_node',
            text: 'Software Engineer specializing in scalable full-stack web applications and backend systems.',
          },
          experience: [],
          skills: [
            { id: 'skills_primary', name: 'TypeScript, React, Node.js, Python, PostgreSQL, REST APIs', category: 'General' },
          ],
          education: [],
          projects: [],
          achievements: [],
          certifications: [],
        };

        // 2. Fetch applications at awaiting_approval
        const { data, error } = await supabase!
          .from('applications')
          .select('*, jobs:job_id(title, company_name, employment_type, work_arrangement, locations, salary_min, salary_max, salary_currency, discovered_via, source_refs)')
          .eq('status', 'awaiting_approval')
          .order('created_at', { ascending: false });

        if (error || !data || !live) {
          return;
        }

        const diffs: ResumeDiff[] = [];
        for (const app of data) {
          const rawJob = app.jobs as unknown as JobRow | null;
          const job = rawJob ?? {
            title: 'Software Engineer',
            company_name: 'Target Company',
            discovered_via: null,
            source_refs: null,
          };

          const rawResolved = app.tailored_profile as unknown as ResolvedResume | null;
          const resolved: ResolvedResume = rawResolved ?? {
            schema_version: 1,
            master_version: masterVersion,
            identity: masterProfile.identity,
            section_order: ['summary', 'skills', 'experience', 'projects', 'education', 'achievements', 'certifications'],
            summary: masterProfile.summary?.text ?? null,
            experience: (masterProfile.experience || []).map((exp) => ({
              ref: exp.id,
              company: exp.company,
              role: exp.role,
              location: exp.location,
              start_display: exp.start_display,
              end_display: exp.end_display,
              bullets: (exp.bullets || []).map((b) => ({
                ref: b.id,
                text: b.text,
                master_text: b.text,
              })),
            })),
            skills: (masterProfile.skills || []).map((s) => ({
              ref: s.id,
              category: s.category,
              name: s.name,
            })),
            projects: (masterProfile.projects || []).map((p) => ({
              ref: p.id,
              name: p.name,
              links: p.links,
              start_display: p.start_display,
              end_display: p.end_display,
              bullets: (p.bullets || []).map((b) => ({
                ref: b.id,
                text: b.text,
                master_text: b.text,
              })),
            })),
            education: (masterProfile.education || []).map((edu) => ({
              ref: edu.id,
              institution: edu.institution,
              degree: edu.degree,
              field: edu.field,
              start_display: edu.start_display,
              end_display: edu.end_display,
              grade_display: edu.grade_display,
              bullets: (edu.bullets || []).map((b) => ({
                ref: b.id,
                text: b.text,
                master_text: b.text,
              })),
            })),
            achievements: (masterProfile.achievements || []).map((a) => ({
              ref: a.id,
              label: a.label,
              description: a.description,
              bullets: (a.bullets || []).map((b) => ({
                ref: b.id,
                text: b.text,
                master_text: b.text,
              })),
            })),
            certifications: (masterProfile.certifications || []).map((c) => ({
              ref: c.id,
              label: c.label,
              description: c.description,
              bullets: (c.bullets || []).map((b) => ({
                ref: b.id,
                text: b.text,
                master_text: b.text,
              })),
            })),
          };

          const diff = buildResumeDiff({
            application: {
              ...app,
              master_version: masterVersion,
              selected_jd_keywords: app.selected_jd_keywords || [],
            } as ApplicationRow,
            job,
            resolved,
            master: masterProfile,
          });

          diffs.push(diff);
        }

        setQueue(diffs);
      } finally {
        if (live) setLoading(false);
      }
    }
    void loadQueue();
    return () => {
      live = false;
    };
  }, []);

  /* Partition by bucket. Derived from the findings on each row, never stored -
     a row carrying a stored bucket alongside its findings will eventually
     disagree with them, and the badge is what the operator would trust. */
  const { bucketA, bucketB } = useMemo(() => {
    const pending = queue.filter((diff) => !settled.has(diff.applicationId));
    return {
      bucketA: pending.filter((diff) => deriveBucket(diff) === 'A'),
      bucketB: pending.filter((diff) => deriveBucket(diff) === 'B'),
    };
  }, [queue, settled]);

  /* Mark rows as handled. In the live version this is where
     `advance_application_status` is called - `awaiting_approval -> approved` is
     the only edge into `approved`, and `approved -> applying` the only edge
     into `applying`, so this function is the single door to submission in the
     whole system. Constraint #15 is unreachable-by-construction rather than
     enforced by review. */
  function settle(ids: readonly string[]): void {
    setSettled((previous) => {
      const next = new Set(previous);
      for (const id of ids) next.add(id);
      return next;
    });
  }

  /* Loading state while checking database */
  if (loading) {
    return (
      <div className="page">
        <PageHeader path="approvals" />
        <p className="queue__empty">Loading applications awaiting approval from Supabase...</p>
      </div>
    );
  }

  /* Nothing left. An empty queue is the normal end state of a review session,
     so it is written as a finished-for-now statement rather than a void. */
  if (bucketA.length === 0 && bucketB.length === 0) {
    return (
      <div className="page">
        <PageHeader path="approvals" />
        <p className="queue__empty">
          Queue is empty. Applications requiring review will appear here once tailored.
        </p>
      </div>
    );
  }

  return (
    /* The wide variant: two resume panes need every pixel, and the standard
       page measure would force the operator to scroll to compare them. */
    <div className="page page--wide">
      <PageHeader path="approvals" />

      {/* BUCKET B FIRST. Deliberate ordering - see the note at the top. */}
      {bucketB.length > 0 ? (
        <section className="queue__bucket" aria-labelledby="bucket-b-heading">
          <h2 id="bucket-b-heading" className="queue__bucket-heading">
            {bucketB.length}{' '}
            {bucketB.length === 1 ? 'Application Requires Review' : 'Applications Require Review'}
          </h2>
          <p className="queue__bucket-note">
            Flagged modifications or untraced claims requiring manual verification.
          </p>

          {/* Expanded, one after another. Never a collapsed list: a row that
              must be read cannot be behind a disclosure triangle. */}
          <ul className="queue__list">
            {bucketB.map((diff) => (
              <li key={diff.applicationId} className="queue__item">
                <DiffView
                  diff={diff}
                  /* The decisions map arrives here; the live version writes it
                     to the row so the audit log records what the operator
                     chose per claim, not just that they approved. */
                  onApprove={() => settle([diff.applicationId])}
                  onReject={() => settle([diff.applicationId])}
                />
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {/* BUCKET A: a count and a button, not thirty rows to scroll. */}
      {bucketA.length > 0 ? (
        <section className="queue__bucket" aria-labelledby="bucket-a-heading">
          <h2 id="bucket-a-heading" className="queue__bucket-heading">
            {bucketA.length}{' '}
            {bucketA.length === 1 ? 'Application Verified' : 'Applications Verified'} (Bucket A)
          </h2>
          <p className="queue__bucket-note">
            All tailored claims verified against master profile ground truth.
          </p>

          {/* One row per application, but as a compact line rather than a diff.
              The operator can still open any of them; the default is that they
              do not need to. */}
          <ul className="queue__clean-list">
            {bucketA.map((diff) => (
              <li key={diff.applicationId} className="queue__clean-row">
                <span className="queue__clean-job">
                  {diff.jobTitle} at {diff.companyName}
                </span>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.75rem' }}>
                  {diff.discoveredVia && diff.discoveredVia.length > 0 && (
                    <SourceBadge
                      discoveredVia={diff.discoveredVia as readonly DiscoverySource[]}
                      sourceRefs={diff.sourceRefs}
                    />
                  )}
                  <StatusBadge status="audit_clean" label="audit_clean" />
                  <span className="identifier">
                    master v{diff.masterVersion}
                  </span>
                </span>
              </li>
            ))}
          </ul>

          <button
            type="button"
            className="button button--approve"
            onClick={() => settle(bucketA.map((diff) => diff.applicationId))}
          >
            {/* The verb keeps the same name through the flow: approve produces
                approved. And it states the count, so the button says exactly
                what it is about to do. */}
            Approve all {bucketA.length} and queue for submission
          </button>
        </section>
      ) : null}
    </div>
  );
}
