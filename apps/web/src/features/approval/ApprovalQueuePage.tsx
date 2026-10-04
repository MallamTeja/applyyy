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
// useToast is back, and now has a consumer: settle() reports every approve and
// every reject. It was removed in a build-unblocking pass when the handler wrote
// nothing, which was the honest state then and is not the state now.
import { useToast } from '../../app/Toast';
import type {
  ApplicationRow,
  DiscoverySource,
  JobRow,
  MasterProfile,
  ResolvedResume,
} from '../../data/contract';
import { DiffView } from './DiffView';
// ClaimDecision is imported again because the decisions are no longer discarded.
// DiffViewProps.onApprove hands back a ReadonlyMap<string, ClaimDecision> of the
// operator's per-claim keep/remove choices; the handler now forwards it into the
// RPC's p_detail, so the audit log records WHAT WAS DECIDED rather than only that
// someone approved. Previously the button could read "Approve without 2 claims"
// while the page recorded a plain approval - the string described an action the
// handler did not perform.
import type { ClaimDecision } from './DiffView';
import { buildResumeDiff } from './diffAdapter';
import { deriveBucket } from './diffModel';
import type { ResumeDiff } from './diffModel';
import { supabase } from '../../data/supabase';

import './ApprovalQueuePage.css';

/* A queue row we refuse to render as a diff, with enough identity for the
   operator to go and look at it. Deliberately not a ResumeDiff: making it one
   would let it flow into the buckets, which is the bug. */
interface UnreviewableRow {
  readonly applicationId: string;
  readonly jobTitle: string;
  readonly companyName: string;
}

/**
 * Structural shape validation for tailored profile snapshots.
 * Ensures the profile has required sections (identity/contact, experience, skills)
 * and is not an empty object `{}` or malformed JSON.
 */
function isValidTailoredProfile(profile: unknown): profile is ResolvedResume {
  if (typeof profile !== 'object' || profile === null) {
    return false;
  }
  const p = profile as Record<string, unknown>;

  return (
    typeof p.identity === 'object' &&
    p.identity !== null &&
    Array.isArray(p.experience) &&
    Array.isArray(p.skills)
  );
}


export function ApprovalQueuePage(): ReactElement {
  /* Feedback for the one irreversible action in the product. */
  const toast = useToast();

  /* Live queue state. Defaults to empty array (NO mock data). */
  const [queue, setQueue] = useState<readonly ResumeDiff[]>([]);
  const [loading, setLoading] = useState<boolean>(true);

  /* THE THIRD STATE. Until 2026-09-17 a failed read was indistinguishable from
     an empty queue: the catch swallowed the error, `queue` stayed [], and the
     page rendered "Queue is empty" inside a box whose green --traced left
     border is commented "it is a statement that the work is done". So a
     database outage rendered as a green all-clear on the screen that gates
     irreversible submissions - fail-loud inverted into fail-reassuring.
     Held separately rather than folded into `queue`, because "no rows" and
     "could not ask" are opposite claims and must not share a branch. */
  const [loadError, setLoadError] = useState<string | null>(null);

  /* ROWS THAT CANNOT HONESTLY BE REVIEWED. Added 2026-09-17.
     An application reaches awaiting_approval with `tailored_profile` null when
     something stamped the status without a Tailor ever running - which the
     "Tailor & Queue" button on Discovered Jobs does today, walking six
     transitions in a loop while naming six agents that did not execute.
     Before this, such a row fell through to a fallback resume built from the
     master profile. That produced ZERO audit findings, so deriveBucket returned
     'A', so it rendered under "Every line traced" in the one-click batch bucket.
     Every line did trace - to the master, because the master was all it ever
     was. The badge was earned by the absence of a tailored resume rather than
     by the honesty of one.
     Held apart so these rows can be named and refused rather than approved. */
  const [unreviewable, setUnreviewable] = useState<readonly UnreviewableRow[]>([]);

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
        const { data: masterData, error: masterError } = await supabase!
          .from('master_profiles')
          .select('*')
          .order('version', { ascending: false })
          .limit(1)
          .maybeSingle();

        // A cancelled render has nothing to report (same rule as the queue read below).
        if (!live) return;

        /* NO MASTER, NO AUDIT. Until 2026-10-04 this read never checked `error`, and
           on failure (or no row) diffed every tailored resume against a HARDCODED
           profile — a literal name, email and skills line. Audit findings computed
           against invented data are worse than none: they look like a verdict.
           So a failed read and a missing row both stop here, before any diff exists. */
        if (masterError || masterData === null || typeof masterData.profile !== 'object' || masterData.profile === null) {
          // Distinguish "could not ask" from "nothing stored" so the operator knows which fix applies.
          setLoadError(
            masterError
              ? 'Could not load your master profile, so no tailored resume can be audited against it. Nothing here was checked.'
              : 'No master profile is stored, so there is nothing to audit tailored resumes against. Upload one in Master profile.',
          );
          // Nothing below may run without a real master.
          return;
        }

        // Real values only: the version and profile of the row that actually loaded.
        const masterVersion: number = masterData.version;
        // Shape-checked above as a non-null object; the contract type is the stored profile.
        const masterProfile: MasterProfile = masterData.profile as MasterProfile;

        // 2. Fetch applications at awaiting_approval
        const { data, error } = await supabase!
          .from('applications')
          /* apply_url and description_raw added 2026-09-17: the diff could not
             show the operator the job they were approving against, because the
             query never asked for it. Everything here is an explicit column
             list rather than jobs:job_id(*) so that adding a column to the
             jobs table does not silently start shipping it to the browser. */
          .select('*, jobs:job_id(title, company_name, employment_type, work_arrangement, locations, salary_min, salary_max, salary_currency, discovered_via, source_refs, apply_url, description_raw)')
          .eq('status', 'awaiting_approval')
          .order('created_at', { ascending: false });

        /* `live` is a cancelled render, not a failure - a component that
           unmounted mid-fetch has nothing to report. Separated from the two
           real failures below so that leaving the page cannot paint an error. */
        if (!live) {
          return;
        }

        /* A refused or unreachable read. Recorded rather than swallowed: the
           whole point of the third state. The operator gets the console's own
           sentence; error.message is kept out of the UI because it is
           Postgres's words, not something anyone can act on. */
        if (error || !data) {
          setLoadError(
            'Could not reach the application queue. This screen cannot tell you what is waiting until the connection is back.',
          );
          return;
        }

        /* A read that succeeded clears any error from a previous attempt, so a
           recovered connection does not leave a stale alarm on screen. */
        setLoadError(null);

        const diffs: ResumeDiff[] = [];
        /* Collected alongside, never merged in. See UnreviewableRow. */
        const refused: UnreviewableRow[] = [];
        for (const app of data) {
          const job = app.jobs as unknown as JobRow | null;
          /* A missing job row used to fall back to an invented "Software Engineer at
             Target Company", so the operator approved against a job that was never
             shown. No job, no honest review: refuse the row and say why in its label. */
          if (job === null) {
            // Refused rows are named, not hidden, so the operator can reject them.
            refused.push({
              // The id is real even when the join came back empty.
              applicationId: app.id,
              // States the reason in place of the title we cannot show.
              jobTitle: 'Job record missing',
              // No company is known; say so rather than invent one.
              companyName: 'unknown company',
            });
            // Skip diffing: there is nothing to compare against.
            continue;
          }

          /* THE GATE ON THE GATE.
             No tailored resume means there is nothing to compare against the
             master, so there is no honest verdict this screen can render. The
             fallback below would build one out of the master profile itself,
             which trivially traces to the master and therefore reports zero
             findings and lands in the one-click batch bucket wearing "Every
             line traced" - a verdict produced by the ABSENCE of the thing it
             claims to have checked.
             Refused here rather than rendered quietly, because the alternative
             is the exact failure the approval gate exists to prevent, delivered
             by the gate itself. Fail loud, never fail clean. */
          if (!isValidTailoredProfile(app.tailored_profile)) {
            refused.push({
              applicationId: app.id,
              jobTitle: job.title,
              companyName: job.company_name,
            });
            continue;
          }

          const resolved = app.tailored_profile;

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

        /* Published in the same pass, so the banner and the buckets can

           never disagree about what this read found. */

        setUnreviewable(refused);
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
  const { bucketA, bucketB, pendingRefused } = useMemo(() => {
    const pending = queue.filter((diff) => !settled.has(diff.applicationId));
    return {
      bucketA: pending.filter((diff) => deriveBucket(diff) === 'A'),
      bucketB: pending.filter((diff) => deriveBucket(diff) === 'B'),
      pendingRefused: unreviewable.filter((row) => !settled.has(row.applicationId)),
    };
  }, [queue, unreviewable, settled]);

  /* THE DOOR. Wired to the database on 2026-09-17; until then this function
     added ids to a React Set and wrote nothing, so the row vanished from the
     screen and stayed at `awaiting_approval` in Postgres. The operator was
     told, by the row disappearing, that something had happened. Nothing had.

     `advance_application_status` rather than a bare UPDATE, because
     core_tables.sql:471 says a bare update "passes the guard but skips the
     claim release and strands the row". The RPC sets `applyy.acting_agent`
     inside the transaction, which is what lets the transition guard prove a
     HUMAN made this move - `awaiting_approval -> approved` is
     allowedAgents:['human'] and is the only edge into `approved`, so this call
     is the single door to submission in the whole system. Constraint #15 is
     unreachable-by-construction rather than enforced by review.

     Rows are advanced ONE AT A TIME rather than in a single bulk call. Bucket A
     is a batch to the operator, not to the database: if the ninth of thirty
     fails, the eight that succeeded must stay succeeded, and the failure has to
     name which row. A bulk RPC would give us one error for thirty rows. */
  async function settle(
    ids: readonly string[],
    to: 'approved' | 'dropped_filter',
    detail: Readonly<Record<string, unknown>> = {},
  ): Promise<void> {
    /* No client means no database. Say so instead of optimistically clearing
       rows the operator would then believe were submitted. */
    if (supabase === null) {
      toast.error('Not connected to the database. Nothing was recorded.');
      return;
    }

    const moved: string[] = [];
    const failed: string[] = [];

    for (const id of ids) {
      /* `human` is not decoration: the guard reads it to decide whether this
         edge is legal at all, and no other agent value opens this one. */
      const { error } = await supabase.rpc('advance_application_status', {
        p_application_id: id,
        p_to_status: to,
        p_agent: 'human',
        p_detail: detail,
      });
      if (error) {
        failed.push(id);
      } else {
        moved.push(id);
      }
    }

    /* Only rows the DATABASE accepted leave the queue. Removing a failed row
       would hide it from the one person who can fix it, which is the same
       fail-clean behaviour this whole screen exists to prevent. */
    if (moved.length > 0) {
      setSettled((previous) => {
        const next = new Set(previous);
        for (const id of moved) next.add(id);
        return next;
      });
    }

    /* Say what happened, in the verb the button used. An irreversible action
       with no confirmation trains the operator to distrust the screen. */
    if (moved.length > 0) {
      const noun = moved.length === 1 ? 'application' : 'applications';
      toast.success(
        to === 'approved'
          ? `Approved ${moved.length} ${noun} and queued for submission.`
          : `Rejected ${moved.length} ${noun}.`,
      );
    }
    if (failed.length > 0) {
      const noun = failed.length === 1 ? 'application' : 'applications';
      toast.error(
        `${failed.length} ${noun} could not be recorded and ${failed.length === 1 ? 'is' : 'are'} still waiting. Check you are signed in, then try again.`,
      );
    }
  }

  /* Loading state while checking database */
  if (loading) {
    return (
      <div className="page">
        <PageHeader path="approvals" />
        {/* Names what the operator is waiting for, not which vendor we ask. */}
        <p className="queue__empty">Loading the applications waiting for you…</p>
      </div>
    );
  }

  /* THE FAILED READ, and it must be tested BEFORE the empty branch below.
     Order is the fix: both conditions are true when a read fails - the queue is
     empty precisely BECAUSE we could not fill it - so whichever branch is
     reached first decides what the operator is told. Put the empty branch
     first and the outage renders as a green all-clear.
     This is a third branch, not a repaint: the green --traced framing on
     .queue__empty stays correct for a genuinely empty queue and is untouched. */
  if (loadError !== null) {
    return (
      <div className="page">
        <PageHeader path="approvals" />
        <p className="queue__failed" role="alert">
          {loadError}
        </p>
        <button
          type="button"
          className="button button--secondary"
          onClick={() => window.location.reload()}
        >
          Try again
        </button>
      </div>
    );
  }

  /* Nothing left. An empty queue is the normal end state of a review session,
     so it is written as a finished-for-now statement rather than a void. */
  if (bucketA.length === 0 && bucketB.length === 0 && pendingRefused.length === 0) {
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

      {/* REFUSED ROWS FIRST, above even Bucket B. They are not a third bucket
          and carry no approve button: this screen cannot form a verdict on
          them, and offering an action would imply it had.
          They DO carry a reject button so the operator can drop them from the
          pipeline instead of being permanently stranded by them. */}
      {pendingRefused.length > 0 ? (
        <section className="queue__refused" aria-labelledby="refused-heading" role="alert">
          <div className="queue__refused-header">
            <h2 id="refused-heading" className="queue__bucket-heading">
              {pendingRefused.length}{' '}
              {pendingRefused.length === 1 ? 'application was' : 'applications were'} queued
              without a tailored resume
            </h2>
            <button
              type="button"
              className="button button--secondary button--small"
              onClick={() =>
                void settle(
                  pendingRefused.map((r) => r.applicationId),
                  'dropped_filter',
                  { reason: 'refused_unreviewed_tailoring' },
                )
              }
            >
              Reject all {pendingRefused.length} from pipeline
            </button>
          </div>
          <p className="queue__bucket-note">
            Nothing compared these against your master profile, so this screen cannot
            tell you whether they are honest. They are held here rather than shown as
            verified. Re-run tailoring for them, or reject them from the pipeline.
          </p>
          <ul className="queue__refused-list">
            {pendingRefused.map((row) => (
              <li key={row.applicationId} className="queue__refused-item">
                <div className="queue__refused-info">
                  <span className="queue__refused-role">{row.jobTitle}</span>
                  <span className="queue__refused-company">{row.companyName}</span>
                </div>
                <button
                  type="button"
                  className="button button--secondary button--small"
                  onClick={() =>
                    void settle([row.applicationId], 'dropped_filter', {
                      reason: 'refused_unreviewed_tailoring',
                    })
                  }
                >
                  Reject from pipeline
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

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
                  /* The decisions map is now FORWARDED, not dropped. Each entry
                     is one flagged claim the operator explicitly chose to keep
                     or remove, and it travels into the RPC's p_detail so the
                     audit log records the reasoning rather than a bare verdict.
                     Serialised as an object because p_detail is jsonb and a Map
                     has no JSON representation - it would have arrived as {}. */
                  onApprove={(decisions) =>
                    void settle([diff.applicationId], 'approved', {
                      claim_decisions: Object.fromEntries(decisions),
                      /* Counted here rather than derived later: this is the
                         number the button showed the operator, so it is the
                         number the record should be able to reproduce. */
                      claims_removed: [...decisions.values()].filter(
                        (d: ClaimDecision) => d === 'remove',
                      ).length,
                    })
                  }
                  /* A rejection is a modelled edge, not an ad-hoc state write:
                     `awaiting_approval -> dropped_filter` is human-only, noted
                     in the graph as "a human is the last filter in the
                     cascade". drop_reason carries why. */
                  onReject={(reason) =>
                    void settle([diff.applicationId], 'dropped_filter', {
                      drop_reason: reason,
                    })
                  }
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
            /* Bucket A carries no flagged claims by definition, so there are no
               per-claim decisions to record - only the fact that this was the
               batch path rather than an individual review. */
            onClick={() =>
              void settle(
                bucketA.map((diff) => diff.applicationId),
                'approved',
                { review_path: 'bucket_a_batch' },
              )
            }
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
