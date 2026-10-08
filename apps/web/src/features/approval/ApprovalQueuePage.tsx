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

import { useEffect, useMemo, useRef, useState } from 'react';
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
// ClaimDecision is imported because the decisions are not discarded: DiffViewProps.onApprove
// hands back a ReadonlyMap<string, ClaimDecision> of the claims the operator chose to KEEP, and
// the handler forwards it into the RPC's p_detail so the audit log records what was decided.
// EditAction/EditResult are the save contract between the diff's controls and this page.
import type { ClaimDecision, EditAction, EditResult } from './DiffView';
import { buildResumeDiff } from './diffAdapter';
import { deriveBucket } from './diffModel';
import type { ResumeDiff } from './diffModel';
// Pure edit operations and the original-rebuild (builder-1's module): no React, no Supabase.
import {
  applyTextEdit,
  editKey,
  isResumeShape,
  // A SHAPE check on the pinned master, so '{}' is refused like a missing version, not diffed against.
  masterFromRow,
  // The auditor's pin rules behind it, so a resume with a bad pin is refused by name (7b).
  classifyTailored,
  rebuildOriginal,
  removeBullet,
  resetTarget,
} from './tailoredEdits';
// The one write path for an edit: resume first, history note second.
// confirmFresh: the per-row cross-tab check every approval crosses right before its RPC.
// isNoAnswer + confirmSettle: a lost RPC response is re-read, never reported as failed (item 6);
// buildSettleArgs: the RPC arguments, with the stamp passed through byte-for-byte (item 4).
import { buildSettleArgs, confirmFresh, confirmSettle, isNoAnswer, saveTailoredEdit } from './saveTailoredEdit';
import type { EditEventKind, StoredRow } from './saveTailoredEdit';
// The submitted resume and its master side by side, rendered by the worker's own renderer,
// so every row can be SEEN before it is approved. Shared with the pipeline history page.
import { ResumePreview } from '../resume-preview/ResumePreview';
import { supabase } from '../../data/supabase';

import './ApprovalQueuePage.css';

/* A queue row we refuse to render as a diff, with enough identity for the
   operator to go and look at it. Deliberately not a ResumeDiff: making it one
   would let it flow into the buckets, which is the bug. */
interface UnreviewableRow {
  readonly applicationId: string;
  readonly jobTitle: string;
  readonly companyName: string;
  /* WHY it is refused. A closed union, because the three causes need different fixes (re-run
     the tailor vs restore a master version) and the reject is logged with the true one. Until
     2026-10-08 a missing pinned master was labelled "queued without a tailored resume". */
  readonly reason: RefusalReason;
}

// The only three ways a queued row can be unreviewable on this screen.
type RefusalReason = 'no_job' | 'no_tailored_resume' | 'no_pin' | 'no_pinned_master';

/* Per-cause wording for the refused list and the p_detail code for its reject. A literal table,
   so a new cause fails to compile here instead of rendering under the wrong explanation. */
const REFUSAL: Readonly<Record<RefusalReason, { readonly label: string; readonly code: string }>> = {
  // The job join came back empty.
  no_job: { label: 'Job record missing', code: 'refused_missing_job' },
  // The original cause; the code is kept so earlier rejections stay comparable.
  no_tailored_resume: { label: 'No tailored resume', code: 'refused_unreviewed_tailoring' },
  // A resume with no usable master_version: nothing says which master it must be checked against.
  no_pin: { label: 'Master version missing or invalid', code: 'refused_unpinned' },
  // A valid resume whose pinned master version is not stored (or is not a profile).
  no_pinned_master: { label: 'Master profile version missing', code: 'refused_missing_master' },
};

/* Everything needed to rebuild one row's diff after a save, kept from the load so a save never
   has to re-read the database (and so can never diff against a different master than the load). */
interface RowSource {
  // The queue row as loaded; its audit findings and keywords do not change on an edit.
  readonly application: ApplicationRow;
  // The job, for the header and the posting.
  readonly job: JobRow;
  // The PINNED master, at the version the resume was tailored from.
  readonly master: MasterProfile;
  // The tailor's own version, rebuilt from tailor_refs; null means editing is off (D4).
  readonly original: ResolvedResume | null;
  // Whether a generated cover letter exists, which an edit does not regenerate.
  readonly hasCoverLetter: boolean;
}

/* Which history event each operator action writes. A literal table, so a new action fails to
   compile here instead of logging under the wrong name. */
const EVENT_KIND: Readonly<Record<EditAction['kind'], EditEventKind>> = {
  // Text replaced.
  edit: 'resume_edit',
  // Whole bullet deleted.
  remove: 'resume_remove',
  // Tailor's text restored.
  reset: 'resume_reset',
};

/* D4, in words: why the controls are missing, so it does not read as a bug. */
const EDIT_DISABLED_REASON =
  'Editing is off for this application: the tailor’s original version could not be rebuilt from its saved references, so your edits could not be told apart from its text.';

/* Fix 3: WHICH lines carry the operator's wording, for p_detail.edited_refs. A count says that
   something changed; the refs say what, so the record can be checked against the event log. */
function editedRefs(diff: ResumeDiff | undefined): string[] {
  // No diff (should not happen for a loaded row) means nothing to name.
  if (diff === undefined) return [];
  // Edited and removed lines both have a target; skills and untouched lines are left out.
  return diff.lines.flatMap((line) =>
    line.editState !== 'original' && line.editTarget !== null ? [editKey(line.editTarget)] : [],
  );
}

/* A save that definitely did not happen. The prefix lives HERE, not in DiffView, because only the
   page knows whether a failure is definite or unconfirmed (fix 1); DiffView renders the reason as given. */
function notSaved(why: string): EditResult {
  // One wording for every definite refusal.
  return { ok: false, reason: `Not saved: ${why}` };
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

  /* The tailored resume behind each diff, keyed by application id. ResumeDiff holds
     the comparison lines, not the snapshot, and the preview must render the SNAPSHOT:
     that is what the worker turns into the PDF. Set in the same pass as the queue. */
  const [resumes, setResumes] = useState<ReadonlyMap<string, ResolvedResume>>(() => new Map());

  /* What each row's diff was built from, so a save can rebuild the diff without a re-read. */
  const [sources, setSources] = useState<ReadonlyMap<string, RowSource>>(() => new Map());

  /* THE LATEST SAVED STATE, outside the render closure. editRow and settle are async and can
     be called from a render that is already stale; reading `resumes`/`queue` there could
     compute an edit from an older resume and write it over a newer one, or approve a row on
     a bucket it has since left. Refs are updated synchronously on load and on every save. */
  const latestResumes = useRef<Map<string, ResolvedResume>>(new Map());
  // The latest diff per row, for the bucket re-check and edited_lines at settle time.
  const latestDiffs = useRef<Map<string, ResumeDiff>>(new Map());
  /* Fix 2a: each row's updated_at as last seen. An edit is written only if the row still carries
     this stamp, so a change from another tab is refused instead of silently overwritten. */
  const latestStamps = useRef<Map<string, string>>(new Map());
  // Rows with a save in flight: a second save would start from the pre-save resume.
  const editing = useRef<Set<string>>(new Set());
  // Rows with an approve/reject RPC in flight; a ref so the async loop sees it immediately.
  const settlingRef = useRef<Set<string>>(new Set());
  // The same set as state, so DiffView re-renders with its controls locked.
  const [settling, setSettling] = useState<ReadonlySet<string>>(() => new Set());

  /* Bucket A rows the operator has opened, for the diff and for the preview
     separately. Added 2026-10-06: Bucket A used to be a count and a batch button
     only, so a clean row could be approved by someone who never saw its resume. */
  const [reviewing, setReviewing] = useState<ReadonlySet<string>>(() => new Set());
  // Rows whose rendered resume is showing; separate because a preview is tall.
  const [previewing, setPreviewing] = useState<ReadonlySet<string>>(() => new Set());

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

        // 1. Fetch applications at awaiting_approval
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
        // The snapshot each diff was built from, so the preview renders exactly that.
        const snapshots = new Map<string, ResolvedResume>();
        // The inputs of each diff, so a save can rebuild it.
        const rowSources = new Map<string, RowSource>();
        /* Collected alongside, never merged in. See UnreviewableRow. */
        const refused: UnreviewableRow[] = [];
        /* PINNED masters, cached by version: rows tailored from the same version share one read.
           Until 2026-10-06 this page loaded the LATEST master once and stamped its version onto
           every row, so a resume tailored from v2 was audited against v3. */
        // null = "this version is not stored", cached so every row on it is refused without re-asking.
        const masters = new Map<number, MasterProfile | null>();
        // Each row's concurrency stamp from the same read, seeded into latestStamps below.
        const stamps = new Map<string, string>();
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
              // The job itself is what is missing.
              reason: 'no_job',
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
             by the gate itself. Fail loud, never fail clean.
             A SHAPE check (isResumeShape), never a null check: '{}' is not a resume. */
          /* 7b: a tailored resume whose PIN is missing or malformed is refused with that cause.
             It used to fall into the shape check below and read "No tailored resume", which sent
             the operator to re-run a tailor that had run. Never resolved to another version:
             same verdicts as the auditor (readPin is parity-tested against it). classifyTailored blames
             the pin ONLY when the rest is resume-shaped, so '{}' still reads "No tailored resume". */
          if (classifyTailored(app.tailored_profile) === 'no_pin') {
            refused.push({
              // The real row id, so the operator can reject it.
              applicationId: app.id,
              // The job is known; name it.
              jobTitle: job.title,
              // Same.
              companyName: job.company_name,
              // The resume exists; which master it was tailored from is unknown or malformed.
              reason: 'no_pin',
            });
            // Refuse THIS row only; the rest of the queue still loads.
            continue;
          }

          if (!isResumeShape(app.tailored_profile)) {
            refused.push({
              applicationId: app.id,
              jobTitle: job.title,
              companyName: job.company_name,
              // There is no resume to review; the fix is to re-run the tailor.
              reason: 'no_tailored_resume',
            });
            continue;
          }

          const resolved = app.tailored_profile;
          // The version the Tailor resolved against; the only honest master to diff with.
          const version = resolved.master_version;

          // Read each pinned version once.
          let master = masters.get(version);
          // Only a version never asked about is fetched; a cached null stays refused.
          if (master === undefined) {
            const { data: masterData, error: masterError } = await supabase!
              .from('master_profiles')
              .select('profile')
              .eq('version', version)
              .maybeSingle();
            // A cancelled render has nothing to report.
            if (!live) return;
            /* NO MASTER, NO AUDIT. Until 2026-10-04 a failed read diffed every resume against a
               HARDCODED profile. Audit findings computed against invented data are worse than
               none: they look like a verdict.
               A TRANSPORT failure stops the page: nothing else can be trusted to load either. */
            if (masterError) {
              // "Could not ask" is page-level: the operator's fix is the connection, not a row.
              setLoadError(
                `Could not load master profile version ${version}, so no tailored resume can be audited against it. Nothing here was checked.`,
              );
              // Nothing below may run while the database is unreachable.
              return;
            }
            /* Fix 4: a version that is simply NOT STORED refuses only the rows pinned to it. One
               bad row used to blank the whole queue, hiding every reviewable row behind it. */
            /* A SHAPE check, not "is it an object": '{}' used to pass and be diffed against, so
               every claim would read as untraced against a master with no content. */
            master = masterFromRow(masterData?.profile);
            // Cached either way: the master, or the fact that it is missing.
            masters.set(version, master);
          }
          // No pinned master: named in the refused list, never diffed against another version.
          if (master === null) {
            // Same shape as the other refusals, so the operator can reject it from the pipeline.
            refused.push({
              applicationId: app.id,
              jobTitle: job.title,
              companyName: job.company_name,
              // The resume is fine; the version it must be audited against is not.
              reason: 'no_pinned_master',
            });
            // The rest of the queue still loads.
            continue;
          }

          // The tailor's own version, so "edited" can be DERIVED rather than stored. Null = D4.
          const original = rebuildOriginal(app.tailor_refs, master, version);
          // The row as loaded, with the keyword list made safe for the adapter; master_version left as stored.
          const application = { ...app, selected_jd_keywords: app.selected_jd_keywords || [] } as ApplicationRow;

          const diff = buildResumeDiff({ application, job, resolved, master, original });

          diffs.push(diff);
          // Same row, same snapshot: the preview can never show a different resume than the diff.
          snapshots.set(app.id, resolved);
          // The stamp this snapshot was read at; the first edit must present it.
          /* Only a real string: String(undefined) would be the stamp "undefined", sent as if it were
             a timestamp. Without one the row has no stamp, so it can never be approved (unverifiable). */
          if (typeof app.updated_at === 'string') stamps.set(app.id, app.updated_at);
          // Kept so a save rebuilds this exact diff with the new resume.
          rowSources.set(app.id, {
            application,
            job,
            master,
            original,
            // Any stored letter, even empty-but-present, was written before the edit.
            hasCoverLetter: app.cover_letter !== null && app.cover_letter !== undefined,
          });
        }

        setQueue(diffs);
        // Published with the queue so a rendered row always has its snapshot.
        setResumes(snapshots);
        // Same pass, so every rendered row can be rebuilt after a save.
        setSources(rowSources);
        // The refs start from the same load, so the first edit and approval read what is on screen.
        latestResumes.current = new Map(snapshots);
        // Same, for the diffs the bucket re-check reads.
        latestDiffs.current = new Map(diffs.map((diff) => [diff.applicationId, diff]));
        // And the stamps, from the same read.
        latestStamps.current = stamps;

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
    // The batch button's promise: only rows that are STILL Bucket A when their turn comes.
    requireBucketA = false,
  ): Promise<void> {
    /* No client means no database. Say so instead of optimistically clearing
       rows the operator would then believe were submitted. */
    if (supabase === null) {
      toast.error('Not connected to the database. Nothing was recorded.');
      return;
    }

    const moved: string[] = [];
    const failed: string[] = [];
    // Rows left alone because they changed (or were busy) after the click; named, never silent.
    const skipped: string[] = [];

    // Rows already being settled by an earlier click are not sent twice.
    const mine = ids.filter((id) => !settlingRef.current.has(id));
    // Locked BEFORE the first await, so no edit can start on these rows mid-approval.
    for (const id of mine) settlingRef.current.add(id);
    // Mirrored into state so every affected DiffView disables its controls.
    setSettling(new Set(settlingRef.current));

    // Approvals not sent because the row changed elsewhere since this tab loaded or saved it.
    const changed: string[] = [];
    // Approvals not sent because the freshness read itself failed.
    const unverified: string[] = [];
    // Sent, but the answer was lost and the re-read failed too: outcome unknown (item 6).
    const unconfirmed: string[] = [];
    // Stored statuses of rows another tab or the worker settled first (item 6), named in the summary.
    const settledElsewhere: string[] = [];

    try {
      for (const id of mine) {
        /* Fixes 2b/3, the CROSS-TAB hole, checked PER ROW, right before this row's RPC, for EVERY
           approval (batch and individual). Until 2026-10-08 one read covered a whole batch, so an
           edit landing between that read and row N's RPC was approved as clean, and individual
           approvals were not checked at all. Rejects skip it: dropping a row needs no clean diff.
           confirmFresh catches a change BEFORE sending; the RPC's p_expected_updated_at (item 4,
           migration 20261008130000) refuses one that lands in between, under the row lock, as PT409. */
        /* The stamp this tab's diff describes. Hoisted (item 4) so the RPC gates on the SAME string
           confirmFresh checked below, not a second read of the ref. */
        const stamp = latestStamps.current.get(id);
        if (to === 'approved') {
          // Never throws; a missing stamp counts as unverifiable rather than slipping through.
          const check = stamp === undefined ? { kind: 'unverifiable' as const } : await confirmFresh(supabase, id, stamp);
          // Changed elsewhere: redraw what is stored so the operator sees the other tab's words.
          if (check.kind === 'changed') {
            // Only when the re-read produced a row; a vanished row has nothing to draw.
            if (check.stored !== undefined) adoptStored(id, check.stored);
            // Named in the summary, never approved on the strength of the old diff.
            changed.push(id);
            // Next row.
            continue;
          }
          // Could not ask: unverifiable means unapproved, because the promise is "what you saw".
          if (check.kind === 'unverifiable') {
            // Named in the summary so the operator retries it.
            unverified.push(id);
            // Next row.
            continue;
          }
        }
        // The diff as it is NOW (after any adoption above), not as it was when the button was clicked.
        const latest = latestDiffs.current.get(id);
        /* R2 at the moment of writing: a row edited into Bucket B after the batch snapshot, or with a
           save still in flight in this tab, must not be approved as 'bucket_a_batch'. */
        if (requireBucketA && (latest === undefined || deriveBucket(latest) !== 'A' || editing.current.has(id))) {
          // Left in the queue for individual review.
          skipped.push(id);
          // Next row.
          continue;
        }
        /* `human` is not decoration: the guard reads it to decide whether this
           edge is legal at all, and no other agent value opens this one. */
        // The RPC's whole result: the status is needed to tell "refused" from "no answer" (item 6).
        let result: { error: { code?: unknown } | null; status?: unknown };
        try {
          result = await supabase.rpc(
            'advance_application_status',
            // Built in one tested place, so the stamp reaches Postgres byte-for-byte (item 4).
            buildSettleArgs(
              id,
              to,
              /* edited_lines and edited_refs (fix 3) from the LATEST diff, per row at send time: the
                 record must describe the words actually being approved, not a click-time snapshot.
                 Every approve path goes through here, so none can omit them. */
              to === 'approved'
                ? { ...detail, edited_lines: latest?.editCount ?? 0, edited_refs: editedRefs(latest) }
                : detail,
              // Always defined for an approval (a missing stamp was refused above); unused for a reject.
              stamp ?? '',
            ),
          );
        } catch {
          // A thrown call is no answer too: its fate is unknown, exactly like a status-0 return.
          result = { error: { code: '' }, status: 0 };
        }
        // Accepted: the row leaves the queue.
        if (result.error === null) {
          moved.push(id);
          // Next row.
          continue;
        }
        /* Item 6: an error is only a FAILURE when the database refused for its own reasons. Two kinds
           need the row re-read first:
           - NO ANSWER (status 0 / no SQLSTATE): the call may have landed with its response lost;
           - a GUARD REFUSAL (42501/23514, status_transition_guard.sql:217,235,245): often a retry of
             a call that DID land, which the guard now refuses because the row already moved.
           Reporting either as "failed" sent the operator into a retry loop on a settled row. */
        const noAnswer = isNoAnswer(result.status, result.error);
        // The guard's own SQLSTATEs; anything else (e.g. P0002 no such row) is a plain failure.
        // PT409 (item 4): the RPC's own stale-stamp refusal - another tab changed the row in between.
        const staleStamp = result.error.code === 'PT409';
        const guardRefused = staleStamp || result.error.code === '42501' || result.error.code === '23514';
        // A refusal for any other reason needs no re-read.
        if (!noAnswer && !guardRefused) {
          // The database said no.
          failed.push(id);
          // Next row.
          continue;
        }
        // What the row says now.
        const outcome = await confirmSettle(supabase, id, to);
        // At the asked-for status: it went through (this call or an earlier one), so it leaves the queue.
        /* At the asked-for status. After a PT409 our call is KNOWN not to have landed, so another tab
           made this move: named as settled elsewhere, never claimed as "Approved 1" by this click. */
        if (outcome.kind === 'landed') {
          // Stale stamp: someone else's identical move.
          if (staleStamp) settledElsewhere.push(to);
          // Otherwise this call (or an earlier one of ours) went through.
          else moved.push(id);
        }
        // Another tab (or the worker) settled it: show what is stored and NAME that status.
        else if (outcome.kind === 'moved_elsewhere') {
          // adoptStored removes a no-longer-awaiting row from the queue.
          adoptStored(id, outcome.stored);
          // Its own toast, never the "not approved" one: the row may well BE approved.
          settledElsewhere.push(outcome.stored.status);
        }
        /* Still awaiting, or unreadable. After a refusal that is a definite failure. After NO
           answer it proves nothing: the original call may still commit after this read, so it is
           said as unknown and the row stays locked until reload (see the finally below). */
        // Stale stamp and still awaiting: another tab's edit won; show it and ask for a fresh review.
        else if (staleStamp && outcome.kind === 'not_landed') {
          // The newer stored row replaces the diff the operator was about to approve.
          adoptStored(id, outcome.stored);
          // Reported with the other cross-tab changes: "not approved ... review the current version".
          changed.push(id);
        }
        // Stale stamp but the re-read failed: we know the row changed, not to what. Retry runs confirmFresh first.
        else if (staleStamp) unverified.push(id);
        else if (noAnswer) unconfirmed.push(id);
        // Refused, and nothing moved: a real failure, safe to retry.
        else failed.push(id);
      }
    } finally {
      /* Unlocked whatever happened (moved rows leave the queue anyway, failed ones become editable
         again) - EXCEPT unconfirmed rows: their call may still land, so Approve/Reject stay disabled
         until a reload shows the truth, instead of inviting a retry the guard would refuse (item 6). */
      for (const id of mine) if (!unconfirmed.includes(id)) settlingRef.current.delete(id);
      // And the controls re-render unlocked.
      setSettling(new Set(settlingRef.current));
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
    // Skipped rows changed under the batch; they wait for an individual review instead.
    if (skipped.length > 0) {
      toast.error(
        `${skipped.length} ${skipped.length === 1 ? 'application was' : 'applications were'} not batch-approved because ${skipped.length === 1 ? 'it was' : 'they were'} edited or still saving. Review ${skipped.length === 1 ? 'it' : 'them'} individually.`,
      );
    }
    // Changed in another tab: what is stored is now on screen, and the operator must look again.
    /* Item 6: settled by another tab or the worker before this click counted. Says WHAT it became,
       because "not approved" would be false for a row another tab approved. */
    if (settledElsewhere.length > 0) {
      // Plain words for the statuses an operator knows; anything else is shown as stored.
      const words = [...new Set(settledElsewhere.map((status) => (status === 'approved' ? 'approved' : status === 'dropped_filter' ? 'rejected' : status)))];
      toast.error(
        `${settledElsewhere.length} ${settledElsewhere.length === 1 ? 'application had' : 'applications had'} already been ${words.join(' or ')} elsewhere, so this click changed nothing.`,
      );
    }
    if (changed.length > 0) {
      toast.error(
        `${changed.length} ${changed.length === 1 ? 'application was' : 'applications were'} not approved because ${changed.length === 1 ? 'it' : 'they'} changed elsewhere since you opened ${changed.length === 1 ? 'it' : 'them'}. Review the current version.`,
      );
    }
    // Sent with no answer and no readable row afterwards: neither "done" nor "failed" is known.
    if (unconfirmed.length > 0) {
      toast.error(
        `Could not confirm whether ${unconfirmed.length} ${unconfirmed.length === 1 ? 'application was' : 'applications were'} recorded: the connection dropped. ${unconfirmed.length === 1 ? 'It stays' : 'They stay'} locked; reload the page to see what was stored.`,
      );
    }
    // The check could not run; nothing was sent for these.
    if (unverified.length > 0) {
      toast.error(
        `Could not confirm ${unverified.length} ${unverified.length === 1 ? 'application is' : 'applications are'} unchanged, so ${unverified.length === 1 ? 'it was' : 'they were'} not approved. Try again.`,
      );
    }
    if (failed.length > 0) {
      const noun = failed.length === 1 ? 'application' : 'applications';
      toast.error(
        `${failed.length} ${noun} could not be recorded and ${failed.length === 1 ? 'is' : 'are'} still waiting. Check you are signed in, then try again.`,
      );
    }
  }

  /* ONE approval path for every individually reviewed row, Bucket A or B, so the
     two buckets cannot drift into recording different things. It still ends in
     settle(), i.e. the advance_application_status RPC with p_agent 'human'.
     The decisions map is FORWARDED, not dropped: each entry is one flagged claim
     the operator chose to keep, and it travels into the RPC's p_detail so the
     audit log records the reasoning rather than a bare verdict. Serialised as an
     object because p_detail is jsonb and a Map has no JSON representation - it
     would have arrived as {}. A CUT claim is not here: since 2026-10-06 cutting
     removes the bullet from the saved resume, and edited_lines / edited_refs (added
     by settle() from the latest diff at send time) record it. */
  function approveReviewed(
    // The one row being approved.
    applicationId: string,
    // The operator's per-claim choices from DiffView (empty for a clean row).
    decisions: ReadonlyMap<string, ClaimDecision>,
    // Which screen path produced this approval, for the audit trail.
    reviewPath: 'bucket_b_review' | 'bucket_a_review',
  ): void {
    // Fire and forget: settle() reports success and failure through toasts itself.
    void settle([applicationId], 'approved', {
      // What was decided, claim by claim.
      claim_decisions: Object.fromEntries(decisions),
      // Distinguishes an opened-and-read Bucket A row from the batch button.
      review_path: reviewPath,
    });
  }

  /* A rejection is a modelled edge, not an ad-hoc state write:
     `awaiting_approval -> dropped_filter` is human-only, noted in the graph as
     "a human is the last filter in the cascade". drop_reason carries why. */
  function rejectReviewed(applicationId: string, reason: string): void {
    // Same door as approval, other edge.
    void settle([applicationId], 'dropped_filter', { drop_reason: reason });
  }

  /* Put one row's resume on screen and in the refs, rebuilt against the SAME pinned master and
     original as the load. The single place a row's displayed resume changes after load, so the
     diff, preview, Download, bucket and stamp can never describe different versions. */
  function adoptRow(applicationId: string, resume: ResolvedResume, updatedAt: string): void {
    // The load inputs; static after load, so the render closure is safe here.
    const source = sources.get(applicationId);
    // A row this page never loaded has nothing to rebuild.
    if (source === undefined) return;
    // Same adapter, same pinned master, same original: only the resume differs.
    const next = buildResumeDiff({
      application: source.application,
      job: source.job,
      resolved: resume,
      master: source.master,
      original: source.original,
    });
    // The refs move first and synchronously, so the very next edit or approval reads this.
    latestResumes.current.set(applicationId, resume);
    // Same, for the bucket re-check and edited_lines / edited_refs.
    latestDiffs.current.set(applicationId, next);
    // The stamp the next edit must present.
    latestStamps.current.set(applicationId, updatedAt);
    // The diff on screen now describes what is stored; an edited row moves to Bucket B by derivation.
    setQueue((previous) => previous.map((diff) => (diff.applicationId === applicationId ? next : diff)));
    // The preview and Download render the snapshot, so they follow too.
    setResumes((previous) => new Map(previous).set(applicationId, resume));
  }

  /* Show what the DATABASE holds after a write we could not confirm or that was refused (fix 1,
     fix 2a). Showing the operator's unsaved version here is how the UI used to drift from the DB. */
  function adoptStored(applicationId: string, stored: StoredRow): void {
    // Approved or rejected elsewhere: it is no longer in this queue.
    if (stored.status !== 'awaiting_approval') {
      // Leaves the screen like any settled row.
      setSettled((previous) => new Set(previous).add(applicationId));
      // Nothing to draw.
      return;
    }
    // A stored value that is not a resume cannot be reviewed; refuse it by name, never render it.
    if (!isResumeShape(stored.resume)) {
      // The job's names, for the refused list.
      const job = sources.get(applicationId)?.job;
      // Out of the buckets...
      setQueue((previous) => previous.filter((diff) => diff.applicationId !== applicationId));
      // ...and into the refused list, where it can be rejected.
      setUnreviewable((previous) => [
        ...previous,
        // What is stored is not a resume, so the cause is the same as a row loaded without one.
        { applicationId, jobTitle: job?.title ?? 'unknown job', companyName: job?.company_name ?? 'unknown company', reason: 'no_tailored_resume' },
      ]);
      // Dropped from the refs so no batch or edit reads the old diff.
      latestDiffs.current.delete(applicationId);
      // Nothing more to draw.
      return;
    }
    // The stored resume, rebuilt and shown.
    adoptRow(applicationId, stored.resume, stored.updatedAt);
  }

  /* THE EDIT PATH: click -> pure edit -> saveTailoredEdit -> state replaced with the SAVED
     resume (or, if the save is refused or unconfirmed, with what IS stored). Nothing is shown as
     changed until the database has accepted it, so the preview, the Download and the score can
     never describe a resume that was not stored. */
  async function editRow(applicationId: string, action: EditAction): Promise<EditResult> {
    // What this row's diff was built from.
    const source = sources.get(applicationId);
    // An approval or rejection is in flight; an edit now could land mid-approval.
    if (settlingRef.current.has(applicationId)) return notSaved('this application is being approved or rejected.');
    // One save at a time per row, or the second would start from the pre-save resume.
    if (editing.current.has(applicationId)) return notSaved('another edit to this application is still saving.');
    // The LATEST saved resume (ref, not render closure), so an edit never builds on an older one.
    const current = latestResumes.current.get(applicationId);
    // The stamp that resume was read or saved at.
    const stamp = latestStamps.current.get(applicationId);
    // Without these the row was never editable; the controls are not offered then.
    if (source === undefined || current === undefined || stamp === undefined) return notSaved('this row is not loaded.');
    // D4: no original means no honest "edited" and no Reset; refuse rather than guess.
    if (source.original === null) return notSaved(EDIT_DISABLED_REASON);
    // No client, no write; say so instead of pretending.
    if (supabase === null) return notSaved('not connected to the database.');

    /* The pure operation. Each returns a NEW resume, touching only one bullet's text or the
       summary (R0), and refuses empty, oversized or unknown-ref edits before any write. */
    const outcome =
      action.kind === 'edit'
        ? applyTextEdit(current, action.target, action.text)
        : action.kind === 'remove'
          ? removeBullet(current, action.target)
          : resetTarget(current, source.original, action.target);
    // A refused edit never reaches the network.
    if (!outcome.ok) return notSaved(outcome.reason);

    // Marked before the await, so a batch approval skips this row while it saves.
    editing.current.add(applicationId);
    // Declared outside the try so the result survives the finally.
    let saved: Awaited<ReturnType<typeof saveTailoredEdit>>;
    try {
      // Resume first, history note second; see saveTailoredEdit. It never throws (fix 1).
      saved = await saveTailoredEdit(supabase, {
        // The row being edited.
        applicationId,
        // The whole new resume.
        resume: outcome.resume,
        // What it was computed from, for the R0 boundary check (fix 5).
        previous: current,
        // The tailor's version: the ground truth for refs and master_text.
        original: source.original,
        // Optimistic concurrency: refused if another tab changed the row (fix 2a).
        expectedUpdatedAt: stamp,
        // What changed, for the append-only log.
        event: { kind: EVENT_KIND[action.kind], ref: editKey(action.target), before: outcome.before, after: outcome.after },
      });
    } finally {
      // Released whatever happened, so a failure never strands the row as "saving".
      editing.current.delete(applicationId);
    }

    if (!saved.ok) {
      /* Unconfirmed or changed elsewhere: show what IS stored, never the operator's draft and
         never the pre-save version, because either may now be false. */
      if (saved.stored !== undefined) {
        // Redraw from the database.
        adoptStored(applicationId, saved.stored);
        // Page-level notice, because the whole row may have changed, not just this line.
        toast.error(saved.message);
      }
      // The line shows the reason under its (now stored) text.
      /* 'unconfirmed' may in fact have landed, so it is NOT prefixed "Not saved"; its own message
         says what is known. Every other reason is a definite refusal. */
      return saved.reason === 'unconfirmed' ? { ok: false, reason: saved.message } : notSaved(saved.message);
    }

    // Saved: the new resume and the NEW stamp, so the next edit presents the right one.
    adoptRow(applicationId, outcome.resume, saved.updatedAt);
    // The edit IS saved; only the history note is missing, and the operator should know.
    if (!saved.eventRecorded) toast.error('Your edit was saved, but it could not be added to the application history.');
    // The line closes its editor and shows the saved text.
    return { ok: true };
  }

  // Flip one id in a set-valued state; used by both Bucket A disclosures.
  function toggle(setter: typeof setReviewing, id: string): void {
    // A new Set each time, so React sees the change.
    setter((previous) => {
      // Copy, then flip membership.
      const next = new Set(previous);
      // Open if closed, close if open.
      if (next.has(id)) next.delete(id);
      else next.add(id);
      // The new state.
      return next;
    });
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
              {pendingRefused.length === 1 ? 'application cannot' : 'applications cannot'} be
              reviewed here
            </h2>
            <button
              type="button"
              className="button button--secondary button--small"
              onClick={() =>
                void settle(
                  pendingRefused.map((r) => r.applicationId),
                  'dropped_filter',
                  /* One detail for the whole batch, so each row's TRUE cause rides along by id
                     rather than one code being stamped on rows refused for different reasons. */
                  {
                    reason: 'refused_unreviewable',
                    refusals: Object.fromEntries(pendingRefused.map((r) => [r.applicationId, REFUSAL[r.reason].code])),
                  },
                )
              }
            >
              Reject all {pendingRefused.length} from pipeline
            </button>
          </div>
          <p className="queue__bucket-note">
            Nothing compared these against your master profile, so this screen cannot
            tell you whether they are honest. They are held here rather than shown as
            verified. Each one says why below. Re-run tailoring, restore the master version, or
            reject them from the pipeline.
          </p>
          <ul className="queue__refused-list">
            {pendingRefused.map((row) => (
              <li key={row.applicationId} className="queue__refused-item">
                <div className="queue__refused-info">
                  <span className="queue__refused-role">{row.jobTitle}</span>
                  <span className="queue__refused-company">{row.companyName}</span>
                  {/* The cause, per row, because the fix differs by cause. */}
                  <span className="queue__refused-company">{REFUSAL[row.reason].label}</span>
                </div>
                <button
                  type="button"
                  className="button button--secondary button--small"
                  onClick={() =>
                    void settle([row.applicationId], 'dropped_filter', {
                      // The row's own cause, so the log never records a reason it did not have.
                      reason: REFUSAL[row.reason].code,
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
            {bucketB.map((diff) => {
              // The snapshot behind this diff, for the rendered preview.
              const resume = resumes.get(diff.applicationId);
              // Whether this row's rendered resume is open.
              const isPreviewing = previewing.has(diff.applicationId);
              // Region id for the disclosure.
              const previewId = `preview-${diff.applicationId}`;
              return (
                <li key={diff.applicationId} className="queue__item">
                  <DiffView
                    diff={diff}
                    /* The shared approval path; see approveReviewed for why the
                       decisions are forwarded and how they are serialised. */
                    onApprove={(decisions) => approveReviewed(diff.applicationId, decisions, 'bucket_b_review')}
                    /* The shared rejection path; see rejectReviewed. */
                    onReject={(reason) => rejectReviewed(diff.applicationId, reason)}
                    /* Saves for real; see editRow. */
                    onEdit={(action) => editRow(diff.applicationId, action)}
                    /* D4: only when the tailor's original could not be rebuilt. */
                    editDisabledReason={sources.get(diff.applicationId)?.original === null ? EDIT_DISABLED_REASON : null}
                    /* So the diff can say the letter predates the edits. */
                    hasCoverLetter={sources.get(diff.applicationId)?.hasCoverLetter === true}
                    /* Locks edits and Approve while this row's approve/reject is in flight. */
                    locked={settling.has(diff.applicationId)}
                  />
                  {/* The diff stays expanded (Bucket B is never collapsed); the
                      rendered document is an extra, opened on demand because it is tall. */}
                  <button
                    type="button"
                    className="button button--secondary button--small queue__preview-toggle"
                    /* Disclosure semantics, as in Bucket A. */
                    aria-expanded={isPreviewing}
                    aria-controls={previewId}
                    onClick={() => toggle(setPreviewing, diff.applicationId)}
                  >
                    {/* Same words as Bucket A, so the action reads the same everywhere. */}
                    {isPreviewing ? 'Hide resume' : 'Preview resume'}
                  </button>
                  {isPreviewing && resume ? (
                    <div id={previewId}>
                      <ResumePreview
                        applicationId={diff.applicationId}
                        tailoredProfile={resume}
                        /* Pinned version from the snapshot; see Bucket A. */
                        masterVersion={resume.master_version}
                        jobTitle={diff.jobTitle}
                        companyName={diff.companyName}
                      />
                    </div>
                  ) : null}
                </li>
              );
            })}
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

          {/* One compact line per application, collapsed by default, and every
              line OPENS: "Review" expands the same DiffView Bucket B uses, and
              "Preview resume" renders the exact document the worker will submit.
              Until 2026-10-06 this comment claimed the operator "can still open any
              of them" while the rows had no way to open - a clean row could only be
              approved unseen, through the batch button below. */}
          <ul className="queue__clean-list">
            {bucketA.map((diff) => {
              // Whether this row's diff is open.
              const isReviewing = reviewing.has(diff.applicationId);
              // Whether this row's rendered resume is open.
              const isPreviewing = previewing.has(diff.applicationId);
              // The snapshot behind this diff; always set in the same pass as the queue.
              const resume = resumes.get(diff.applicationId);
              // Stable ids so each button can name the region it controls.
              const reviewId = `review-${diff.applicationId}`;
              // Same, for the preview region.
              const previewId = `preview-${diff.applicationId}`;
              return (
                <li key={diff.applicationId} className="queue__clean-row queue__clean-row--openable">
                  <div className="queue__clean-line">
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
                      <button
                        type="button"
                        className="button button--secondary button--small"
                        /* aria-expanded is what tells a screen reader this is a disclosure. */
                        aria-expanded={isReviewing}
                        aria-controls={reviewId}
                        onClick={() => toggle(setReviewing, diff.applicationId)}
                      >
                        {/* Says what opening does, and what closing does. */}
                        {isReviewing ? 'Hide review' : 'Review'}
                      </button>
                      <button
                        type="button"
                        className="button button--secondary button--small"
                        /* Same disclosure semantics as Review. */
                        aria-expanded={isPreviewing}
                        aria-controls={previewId}
                        onClick={() => toggle(setPreviewing, diff.applicationId)}
                      >
                        {/* "resume", not "PDF": the PDF is one button further in. */}
                        {isPreviewing ? 'Hide resume' : 'Preview resume'}
                      </button>
                    </span>
                  </div>

                  {/* The full comparison, identical to Bucket B's, approving through
                      the same RPC path. Only mounted when open: thirty diffs rendered
                      hidden would cost the whole page for rows nobody opened. */}
                  {isReviewing ? (
                    <div id={reviewId} className="queue__clean-detail">
                      <DiffView
                        diff={diff}
                        /* Same path as Bucket B, tagged so the audit log shows this
                           clean row was opened and read, not batch-approved. */
                        onApprove={(decisions) => approveReviewed(diff.applicationId, decisions, 'bucket_a_review')}
                        /* Same rejection edge as Bucket B. */
                        onReject={(reason) => rejectReviewed(diff.applicationId, reason)}
                        /* Same save path as Bucket B; an edit moves the row there (R2). */
                        onEdit={(action) => editRow(diff.applicationId, action)}
                        /* D4, as in Bucket B. */
                        editDisabledReason={sources.get(diff.applicationId)?.original === null ? EDIT_DISABLED_REASON : null}
                        /* Cover-letter note, as in Bucket B. */
                        hasCoverLetter={sources.get(diff.applicationId)?.hasCoverLetter === true}
                        /* Same lock as Bucket B, including during the batch. */
                        locked={settling.has(diff.applicationId)}
                      />
                    </div>
                  ) : null}

                  {/* The submitted document itself. A missing snapshot cannot happen
                      (rows without one are refused above), but if it did, saying so
                      beats an empty frame next to an approve button. */}
                  {isPreviewing ? (
                    <div id={previewId} className="queue__clean-detail">
                      {resume ? (
                        <ResumePreview
                          applicationId={diff.applicationId}
                          tailoredProfile={resume}
                          /* The PINNED version from the snapshot itself: it is the version
                             the renderer resolved against, whatever the row column says. */
                          masterVersion={resume.master_version}
                          jobTitle={diff.jobTitle}
                          companyName={diff.companyName}
                        />
                      ) : (
                        <p className="resume-preview__refused" role="alert">
                          {/* Names the gap rather than hiding it. */}
                          No tailored resume snapshot was loaded for this application.
                        </p>
                      )}
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>

          <button
            type="button"
            className="button button--approve"
            /* Bucket A carries no flagged claims and no operator edits by definition
               (deriveBucket sends any edited row to B, R2), so there are no per-claim
               decisions to record - only the fact that this was the batch path. */
            onClick={() =>
              void settle(
                bucketA.map((diff) => diff.applicationId),
                'approved',
                { review_path: 'bucket_a_batch' },
                // Re-checks each row's bucket at send time (R2), not at click time.
                true,
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
