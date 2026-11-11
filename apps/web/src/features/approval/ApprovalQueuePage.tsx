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
 *   one after another, each with its own gate. Never batched, never given a
 *   count, and OPEN BY DEFAULT. Since 2026-11-02 the operator may fold one away
 *   ("Hide review", Teja asked); folding only hides it, it never approves, and
 *   the diff stays mounted so the AI chat and unsaved edits survive.
 *
 * Bucket B comes FIRST on the page. A list of clean rows above the dangerous
 * ones would mean the operator scrolls past thirty green rows to reach the one
 * that matters, which is exactly the skim the design is trying to prevent.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactElement } from 'react';

import { PageHeader } from '../../app/PageHeader';
import { StatusBadge } from '../../app/StatusBadge';
/* No SourceBadge import (2026-11-07): Teja dropped the source badge from the queue row as noise;
   DiffView keeps its own badge in the opened card, which is where the provenance is read. */
// useToast is back, and now has a consumer: settle() reports every approve and
// every reject. It was removed in a build-unblocking pass when the handler wrote
// nothing, which was the honest state then and is not the state now.
import { useToast } from '../../app/Toast';
import type {
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
// The one-page rule, live: every edit is fitted on one page before it is saved (2026-11-07).
import { planBatch } from './pageFitEdit';
// Type only (T10 review): what the Apply-all preview answers.
import type { BatchPlan } from './pageFitEdit';
// T10: the overflow preview an AI-chat card shows before Apply, run on the same fit the save runs.
import { overflowPreview, previewAdd } from './pageFitEdit';
// Type only: the preview's answer, handed to the chat through its context.
import type { OverflowPreview } from './pageFitEdit';
// T10: the context the chat reads the preview from (DiffView sits between this page and the chat).
import { OverflowPreviewContext } from './AiEditPanel';
// T10 review: the Apply-all line's preview, provided beside the card preview.
import { BatchPreviewContext } from './AiEditPanel';
// The adapter's own row shape, so the page holds exactly the fields the diff is built from.
import type { DiffAdapterInput } from './diffAdapter';
// coveragePercent (2026-11-04): the row's "ATS score" chip, the same honest figure as the badge and the 'ats' sort.
import { coveragePercent, deriveBucket } from './diffModel';
import type { ResumeDiff } from './diffModel';
// The bucket a save moved a row from and to, for the page-level announcement.
import type { ReviewBucket } from './diffModel';
// T3: the skill add/remove actions, declared in diffModel until DiffView's EditAction names them too.
import type { SkillEditAction } from './diffModel';
// Pure edit operations and the original-rebuild (builder-1's module): no React, no Supabase.
import {
  // T3: put one unselected PINNED-master skill on the resume, built from the master node.
  addSkill,
  applyTextEdit,
  editKey,
  isResumeShape,
  // A SHAPE check on the pinned master, so '{}' is refused like a missing version, not diffed against.
  masterFromRow,
  // The auditor's pin rules behind it, so a resume with a bad pin is refused by name (7b).
  classifyTailored,
  rebuildOriginal,
  // Take any printed skill off the resume, the tailor's or the operator's (since 2026-11-04).
  removeSkill,
  removeBullet,
  resetTarget,
  // Structural edits (2026-11-01): each returns a new resume or a refusal, like the text edits.
  moveBullet,
  moveSection,
  addMasterBullet,
  addMasterEntry,
  removeEntry,
  // A job title set to the owner's wording (2026-11-11).
  setEntryRole,
  // FULL: the whole pinned master resolved once per row, the only source an add-back may copy from.
  resolveFullMaster,
} from './tailoredEdits';
// Types only: the pure edits' result, named by the dispatcher below, and the section a new bullet goes in.
import type { BulletSection, EditOutcome } from './tailoredEdits';
// The one write path for an edit: resume first, history note second.
// confirmFresh: the per-row cross-tab check every approval crosses right before its RPC.
// isNoAnswer + confirmSettle: a lost RPC response is re-read, never reported as failed (item 6);
// buildSettleArgs: the RPC arguments, with the stamp passed through byte-for-byte (item 4).
import { buildSettleArgs, confirmFresh, confirmSettle, isNoAnswer, saveTailoredEdit } from './saveTailoredEdit';
import type { EditEventKind, EditSource, StoredRow } from './saveTailoredEdit';
// Vouching for a skill the master lacks: master version first, then the re-pinned resume.
import { attestSkill } from './attestSkill';
// The same two-step write for a brand-new bullet under one entry (2026-11-01).
import { attestBullet } from './attestBullet';
// The submitted resume and its master side by side, rendered by the worker's own renderer,
// so every row can be SEEN before it is approved. Shared with the pipeline history page.
import { ResumePreview } from '../resume-preview/ResumePreview';
import { supabase } from '../../data/supabase';
// The queue's first read, shared with the shell-side prefetch App.tsx kicks before this chunk loads (2026-11-09).
import { readQueue, takeQueuePrefetch } from './queuePrefetch';
// The AI box's ask: the resume-assist edge function, never-throwing (2026-10-31).
import { requestAssist } from './aiEdit';
// The AI chat's memory: resume_chat_messages over the page's client (2026-11-01).
import { createChatStore } from './resumeChat';

/* One chat store for the page, built once: it holds no state, only the client. Undefined when the
   app is not connected, which leaves the chat session-only rather than pretending to save. */
const chatStore = supabase === null ? undefined : createChatStore(supabase);
// Newest arrival in review first; pure, so the order is testable without rendering the page.
import { newestInReviewFirst } from './queueOrder';
/* The toolbar's sort, work-type filter and search (Teja asked 2026-11-04). Pure, so every rule has a
   named test and the chip counts read the same normalisation as the filter. Client-side only. */
import { DEFAULT_QUEUE_VIEW, QUEUE_ARRANGEMENT_LABELS, QUEUE_SORT_LABELS, applyQueueView, countByArrangement, fitChip } from './queueView';
// The view's types: the state the toolbar edits, and the closed unions its controls choose from.
import type { QueueArrangement, QueueSort, QueueView } from './queueView';
/* Finding N2 (Teja ruled option C, 2026-11-07): a remote job whose pay band names only UK/US places is
   never dropped, it is flagged on the card. The screener's own pure function, imported by relative path
   (as aiEdit.ts imports the detector), so the browser and the gate can never disagree on the rule. */
import { payBandRegionWarning } from '../../../../../supabase/functions/_shared/screen/work-auth-gate.ts';
/* The auditor's own check, re-run on Approve of an EDITED row (Teja, 2026-11-05: "Check on Approve,
   hold for a 2nd click"). Pure and fail-closed: anything but a clean verdict holds the row. */
import { checkBeforeApprove } from './approveCheck';
// What a held card shows: the findings, or why the check could not run.
import type { ApproveHold } from './approveCheck';
// Apply on approve (P1-6): asks dispatch-apply to start the applier once per approve action.
import { requestDispatch } from './dispatchApply';

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
  readonly application: DiffAdapterInput['application'];
  // The job, for the header and the posting.
  readonly job: JobRow;
  // The PINNED master, at the version the resume was tailored from.
  readonly master: MasterProfile;
  // The tailor's own version, rebuilt from tailor_refs; null means editing is off (D4).
  readonly original: ResolvedResume | null;
  // Whether a generated cover letter exists, which an edit does not regenerate.
  readonly hasCoverLetter: boolean;
  // applications.tailor_refs as loaded (untyped JSON): an attested skill re-pins it with the resume.
  readonly tailorRefs: unknown;
  // FULL: every master node resolved at the pin (resolveFullMaster). Add-backs copy from it and the
  // diff offers from it; null means the master cannot be resolved, so editing is off like D4.
  readonly full: ResolvedResume | null;
}

/* Why the edit controls are off for a row, or null when they are on. One place, so the banner the
   operator reads and the guard editRow enforces cannot disagree. */
function editOffReason(source: RowSource | undefined): string | null {
  // A row never loaded offers nothing; the guard in editRow says so if it is ever reached.
  if (source === undefined) return null;
  // D4: no original, so an edit could not be told apart from the tailor's text.
  if (source.original === null) return EDIT_DISABLED_REASON;
  // No FULL: nothing could be checked against the master, so every save would be refused.
  if (source.full === null) return FULL_UNRESOLVED_REASON;
  // Editable.
  return null;
}

/* The pinned master's skill groups, in master order, offered when vouching for a missing skill.
   Only existing groups: the resume prints skills grouped, so a new group would be a new heading. */
function skillGroups(source: RowSource | undefined): string[] | undefined {
  // A row never loaded has no master, so no offer.
  if (source === undefined) return undefined;
  // Distinct, first appearance wins, blanks dropped.
  return [...new Set(source.master.skills.map((skill) => skill.category))].filter((group) => group.trim() !== '');
}

/* Every action the page saves: DiffView's text actions plus T3's skill actions. A union rather
   than waiting for DiffView to name the skill arms, so the page handles them now; once DiffView's
   EditAction gains the same two arms the union simply overlaps and nothing here changes. */
type PageEditAction = EditAction | SkillEditAction;

/* Which history event each operator action writes. A literal table, so a new action fails to
   compile here instead of logging under the wrong name. */
const EVENT_KIND: Readonly<Record<PageEditAction['kind'], EditEventKind>> = {
  // Text replaced.
  edit: 'resume_edit',
  // Whole bullet deleted.
  remove: 'resume_remove',
  // Tailor's text restored.
  reset: 'resume_reset',
  // T3: an unselected master skill put on the resume.
  add_skill: 'resume_add_skill',
  // T3: an operator-added skill taken back off.
  remove_skill: 'resume_remove_skill',
  // A skill the operator vouched for: new master version, then this resume, re-pinned.
  attest_skill: 'resume_attest_skill',
  // Structural edits (2026-11-01), one event kind each, as the contract names them.
  // One bullet one place up or down.
  move_bullet: 'resume_move_bullet',
  // One section one place up or down.
  move_section: 'resume_move_section',
  // A master bullet the tailor left out, put back.
  add_master_bullet: 'resume_add_bullet',
  // A whole master entry put back.
  add_master_entry: 'resume_add_entry',
  // A whole entry taken off.
  remove_entry: 'resume_remove_entry',
  // A job's title set to the owner's wording (2026-11-11).
  set_role: 'resume_set_role',
  // A brand-new bullet: master version first, then this resume (attestBullet.ts writes the event).
  attest_bullet: 'resume_attest_bullet',
};

/* The event's ref: the line key for text actions, the MASTER node id for every other action, so the
   log names exactly which skill, bullet, entry or section went on, off or moved. A switch with a
   `never` default, so a new action fails to compile here instead of logging an empty ref. */
function eventRef(action: PageEditAction): string {
  // One arm per action kind; the compiler checks the list is complete (see default).
  switch (action.kind) {
    // An attest has no master id until it lands; attestSkill.ts writes its own event with the real one.
    case 'attest_skill':
      return action.keyword;
    // Same for a new bullet: its parent is the only master node known before it lands.
    case 'attest_bullet':
      return action.parentRef;
    // A section has no node id; its key is the name section_order stores.
    case 'move_section':
      return action.section;
    // These all carry the master ref directly; there is no line target to key.
    // T3: the master skill put on.
    case 'add_skill':
    // T3: the master skill taken off.
    case 'remove_skill':
    // The bullet that moved.
    case 'move_bullet':
    // The master bullet put back.
    case 'add_master_bullet':
    // The master entry put back.
    case 'add_master_entry':
    // The entry taken off.
    case 'remove_entry':
    // The job whose title changed (2026-11-11).
    case 'set_role':
      // The node the log names.
      return action.ref;
    // Text actions name their line.
    case 'edit':
    case 'remove':
    case 'reset':
      // The same line key p_detail.edited_refs uses.
      return editKey(action.target);
    // Only for the never check: every kind is listed above.
    default: {
      // Unreachable while every arm is listed; a new arm turns this into a compile error.
      const unhandled: never = action;
      // Returned only so the function still has a string at runtime.
      return String(unhandled);
    }
  }
}

/* What the page-level live region says after a save landed. It lives on the PAGE, not in DiffView,
   because a save that moves a row between buckets remounts DiffView under the other bucket's list
   and wipes DiffView's own region with it; a screen-reader user then heard nothing at all.
   `before`/`after` are the pure edit's outcome: the skill's printed name rides in them. */
function announcementFor(
  // Which operator action landed; each gets its own sentence.
  kind: PageEditAction['kind'],
  // The outcome's before/after text, the only place the skill's NAME is known on the page.
  outcome: { readonly before: string | null; readonly after: string | null },
  // The row's bucket before the save, so a move can be named.
  from: ReviewBucket | undefined,
  // The row's bucket after the save.
  to: ReviewBucket | undefined,
): string {
  // One sentence per action; a literal table could not carry the skill name, so a ternary over the closed union.
  const what =
    // The attest arms first: they are the only actions that also wrote the master, and must say so.
    kind === 'attest_skill'
      ? // Both places it went, so the master write is never silent.
        `Added ${outcome.after ?? 'the skill'} to your master profile and this resume.`
      : // A new bullet also wrote the master.
        kind === 'attest_bullet'
      ? // Same for a new bullet; its text is not read back, it is on screen under its entry.
        'Added your new bullet to your master profile and this resume.'
      : // The structural arms (2026-11-01), one sentence each.
        kind === 'move_bullet'
      ? // Where it went is on screen; the sentence confirms the save.
        'Moved the bullet.'
      : // A section moved.
        kind === 'move_section'
      ? // Same, for a whole section.
        'Moved the section.'
      : // A master bullet put back.
        kind === 'add_master_bullet'
      ? // Says where the words came from: the master, not the operator.
        'Added the bullet back from your master profile.'
      : // A master entry put back.
        kind === 'add_master_entry'
      ? // Same, for a whole entry and its bullets.
        'Added the entry back from your master profile.'
      : // An entry taken off.
        kind === 'remove_entry'
      ? // A whole entry taken off.
        'Removed the entry.'
      : // A job title changed (2026-11-11); the new title is on screen in the entry heading.
        kind === 'set_role'
      ? // Confirms the save.
        'Changed the job title.'
      : kind === 'add_skill'
      ? // An add carries the new skill's name in `after`.
        `Added ${outcome.after ?? 'the skill'} to this resume.`
      : kind === 'remove_skill'
        ? // A removal carries the old skill's name in `before`.
          `Removed ${outcome.before ?? 'the skill'}.`
        : kind === 'edit'
          ? // Text replaced; reading the new text back would be noise.
            'Saved your edit.'
          : kind === 'remove'
            ? // A whole bullet deleted.
              'Removed the bullet.'
            : // The only arm left is reset.
              "Reset to the tailor's version.";
  // No move (or an unknown bucket): the action alone says it all.
  if (from === undefined || to === undefined || from === to) return what;
  // Into B: the batch button no longer covers this row, and the operator must know why it moved.
  if (to === 'B') return `${what} This application now needs individual approval.`;
  // Back into A: the batch covers it again.
  return `${what} This application is back in the verified batch.`;
}

/* The stale notice's id, referenced by its card's aria-describedby. Built in one place, like cardId. */
function staleNoticeId(applicationId: string): string {
  // Prefixed so it cannot collide with app-card-, review- or preview- ids on the same page.
  return `stale-notice-${applicationId}`;
}

/* The focus target for one application's card, in either bucket. ONE builder so the id the effect
   looks up and the id the markup carries cannot drift apart. */
function cardId(applicationId: string): string {
  // Prefixed so it can never collide with the review-/preview- region ids of the same row.
  return `app-card-${applicationId}`;
}

/* The card-level words for an Approve that was refused because the row changed under it (a newer
   updated_at from confirmFresh, a PT409 from the RPC, or a batch row that left Bucket A). Added
   2026-10-08: Teja's first real approval "did nothing" - the fresh row was adopted, nothing was
   approved, and the only signal was a toast that had already faded. One constant so the page and
   its test cannot drift. Rejects never need their own wording: they carry no stamp gate
   (buildSettleArgs omits p_expected_updated_at for dropped_filter), so they are never refused as stale. */
const STALE_CLICK_MESSAGE = 'This application changed since you opened it. Review the latest version, then click Approve again.';

/* The card-level words for an Approve held by the re-check (2026-11-05): the edited resume has claims
   the audit could not trace to the master, or the check could not run. Said at the top of the card,
   with focus, like a stale refusal: a held click must never read as "did nothing". */
const HELD_FOR_CHECK_MESSAGE = 'Not approved yet: your edits were re-checked against your master profile. Read the result above the Approve button, then approve again or change the edits.';

/* The batch skipped a row because the operator's OWN edit to it is still saving. Nothing changed
   elsewhere, so STALE_CLICK_MESSAGE ("this application changed") would be untrue here; the truthful
   next step is to wait for the save, review, then approve individually. */
const SAVING_SKIP_MESSAGE = 'Your edit is still saving, so this was not batch-approved. When it has saved, review it, then approve it.';

/* confirmFresh re-read no row at all (deleted, or hidden by RLS): there is no "latest version" to
   review, so the stale wording would send the operator looking for something that is not there. */
const GONE_MESSAGE = 'This application is no longer available to you. Reload the page to see the current queue.';

/* Rows settle() moves at once (2026-11-08). 4 cuts a 10-row batch from 10 sequential row trips to 3 waves,
   while staying far under PostgREST's connection pool; one tab's batch should not crowd out the worker. */
const SETTLE_CONCURRENCY = 4;

/* D4, in words: why the controls are missing, so it does not read as a bug. */
const EDIT_DISABLED_REASON =
  'Editing is off for this application: the tailor’s original version could not be rebuilt from its saved references, so your edits could not be told apart from its text.';

/* The other way editing is off (2026-11-01): the pinned master could not be resolved whole, so no
   edit could be checked against it and an add-back would have nothing to copy from. */
const FULL_UNRESOLVED_REASON =
  'Editing is off for this application: its pinned master profile version could not be resolved, so no change could be checked against it.';

/* Fix 3: WHICH lines carry the operator's wording, for p_detail.edited_refs. A count says that
   something changed; the refs say what, so the record can be checked against the event log. */
function editedRefs(diff: ResumeDiff | undefined): string[] {
  // No diff (should not happen for a loaded row) means nothing to name.
  if (diff === undefined) return [];
  // Edited and removed lines both have a target, the skills line too since T3 (key 'skills'); untouched lines are left out.
  return diff.lines.flatMap((line) =>
    line.editState !== 'original' && line.editTarget !== null ? [editKey(line.editTarget)] : [],
  );
}

/* Every action that is a pure edit of this resume alone (the two attest arms also write the master
   and take their own paths). A switch with a `never` default, so a new action fails to compile here
   instead of falling through to whatever the last branch did. Pure: no state, no network. */
function pureEdit(
  // The action, minus the two that write the master.
  action: Exclude<PageEditAction, { readonly kind: 'attest_skill' } | { readonly kind: 'attest_bullet' }>,
  // The latest saved resume, the only thing an edit may build on.
  current: ResolvedResume,
  // The tailor's version, for Reset and for telling an added skill from a chosen one.
  original: ResolvedResume,
  // The pinned master, the only source a skill may come from.
  master: MasterProfile,
  // FULL at the pin, the only source a put-back bullet or entry may come from.
  full: ResolvedResume,
): EditOutcome {
  // One arm per action kind; the compiler checks the list is complete (see default).
  switch (action.kind) {
    // One bullet's text, or the summary.
    case 'edit':
      return applyTextEdit(current, action.target, action.text);
    // One whole bullet off (D2).
    case 'remove':
      return removeBullet(current, action.target);
    // T3: only the ref crosses from the UI; the skill is built from the PINNED master.
    case 'add_skill':
      return addSkill(current, master, action.ref);
    // Any printed skill; the AI chat's "remove the duplicate Testing" lands here too (2026-11-04).
    case 'remove_skill':
      return removeSkill(current, action.ref);
    // Back to the tailor's text, or a removed bullet back in place.
    case 'reset':
      return resetTarget(current, original, action.target);
    // One bullet one place among its siblings.
    case 'move_bullet':
      return moveBullet(current, action.ref, action.direction);
    // One section one place in section_order.
    case 'move_section':
      return moveSection(current, action.section, action.direction);
    // Only the ref crosses from the UI; the bullet is copied from FULL under its own parent.
    case 'add_master_bullet':
      return addMasterBullet(current, full, action.ref);
    // Same for a whole entry, with all its FULL bullets.
    case 'add_master_entry':
      return addMasterEntry(current, full, action.section, action.ref);
    // A whole entry off.
    case 'remove_entry':
      return removeEntry(current, action.section, action.ref);
    // A job's title, as the owner dictated it; only the role field changes (2026-11-11).
    case 'set_role':
      return setEntryRole(current, action.ref, action.role);
    // Only for the never check: every kind is listed above.
    default: {
      // Unreachable while every arm is listed; a new arm turns this into a compile error.
      const unhandled: never = action;
      // A refusal, never a throw, if it is ever reached at runtime.
      return { ok: false, reason: `Unknown edit ${String((unhandled as { kind?: unknown }).kind)}.` };
    }
  }
}

/* A save that definitely did not happen. The prefix lives HERE, not in DiffView, because only the
   page knows whether a failure is definite or unconfirmed (fix 1); DiffView renders the reason as given. */
function notSaved(why: string): EditResult {
  // One wording for every definite refusal.
  return { ok: false, reason: `Not saved: ${why}` };
}

/* --- Toolbar options (2026-11-04) -------------------------------------------------------------
   The option lists, read off the label Records, so the <select> and the chips can only offer a value
   the view module has a label for. `as` because Object.keys types its result as string[]; the
   Records are total over their unions, so the keys are exactly those unions. */
// Every sort, in the order the view module declares them.
const QUEUE_SORTS = Object.keys(QUEUE_SORT_LABELS) as QueueSort[];
// Every work-type chip, 'all' first, in declaration order.
const QUEUE_ARRANGEMENTS = Object.keys(QUEUE_ARRANGEMENT_LABELS) as QueueArrangement[];

/* --- Row chips (Teja asked 2026-11-04) --------------------------------------------------------
   The facts per queue row, weighed before approving. Each is SHAPE-checked before it is shown,
   because missing data quietly becoming an answer is this repo's dominant bug (CLAUDE.md section 6):
   a null score reads "—", never "0", and a non-string column is no location at all.
   The queued-at chip went on 2026-11-07 (Teja: slim cards); its date parsing went with it. */

/* The values the chips are built from, captured in the load pass and keyed by application id.
   A side map like `stamps`, not fields on ResumeDiff: diffModel/diffAdapter are not this page's to
   change, and none of these facts changes when the resume is edited. */
interface RowChipFacts {
  // applications.match_score: the matcher's fit of the MASTER profile to the JD, 0..100. `unknown`: fitChip proves its shape.
  readonly fit: unknown;
  // jobs.location_raw as a string, or null: the board's own words, shown beside the company on the row.
  readonly location: string | null;
  // Finding N2's chip text, or null when the band is not UK/US only (or nothing could be read).
  readonly payBand: ReturnType<typeof payBandRegionWarning>;
}

/* One stored row as the approval select returns it, narrowed to what the chips read. `unknown` columns:
   the client is untyped, so this is where their shape is proven, not assumed. */
interface ChipSourceRow {
  // applications.match_score.
  readonly match_score: unknown;
  // The jobs embed; null when the job row is missing (that row is refused before this is called).
  readonly jobs: { readonly location_raw?: unknown; readonly description_raw?: unknown } | null;
}

/* A column value as text, or null. A number or an object is not a location or a JD, and String() would
   turn it into "[object Object]" for the gate to read. */
function textOrNull(value: unknown): string | null {
  // Only a real string passes; everything else is "not stored".
  return typeof value === 'string' ? value : null;
}

/* The chip facts for one stored row. Exported and pure so a test can render the row's chips from a
   stored-row fixture, through the same path the load pass takes. */
export function chipFactsFor(app: ChipSourceRow): RowChipFacts {
  // The board location, shape-checked once and used by both the row and the gate.
  const location = textOrNull(app.jobs?.location_raw);
  // The facts the row renders.
  return {
    // Passed through as stored; fitChip shape-checks it at render.
    fit: app.match_score,
    // Shown on the row's meta line.
    location,
    // The screener's own rule over the same two columns it reads (d5247b4); null in, null out.
    payBand: payBandRegionWarning({ locationRaw: location, description: textOrNull(app.jobs?.description_raw) }),
  };
}

/* "ATS score 85% · tailored vs JD": honest keyword coverage of the TAILORED resume, the same figure
   as DiffView's "ATS Match Score" badge and the toolbar's 'ats' sort. After AI-chat edits it adds
   " · +N% from edits" (Teja, 2026-11-07: "ATS score not changed after doing edits"). An edit's words
   never count as master-verified, so the honest anchor cannot move; the gain is shown beside it. */
function atsChip(diff: ResumeDiff): string {
  // The badge's own call, so the chip, the badge and the sort can never disagree.
  const measure = coveragePercent(diff.coverage, 'honest');
  // A closed union: only the measured arm has a percent; no JD keywords means nothing was measured.
  if (measure.kind !== 'measured') return 'ATS score —';
  // The same scorer counting the operator's edits; measured whenever honest is (same denominator).
  const withEdits = coveragePercent(diff.coverage, 'withEdits');
  // The rise the edits bought; the unmeasured arm cannot occur here, so 0 is only a real "no gain".
  const gain = withEdits.kind === 'measured' ? withEdits.percent - measure.percent : 0;
  // The gain only when there is one: "+0%" would read as an edit that did nothing.
  return `ATS score ${measure.percent}% · tailored vs JD` + (gain > 0 ? ` · +${gain}% from edits` : '');
}

/* The chips under a queue row's title, in both buckets. One component, so Bucket A and Bucket B can never
   show different facts or different words for the same fact. Exported for the static-render test. */
export function QueueRowChips({ diff, facts }: { readonly diff: ResumeDiff; readonly facts: RowChipFacts | undefined }): ReactElement {
  return (
    /* A wrapping flex row (ApprovalQueuePage.css), so the chips fold onto two lines at phone width
       instead of pushing the page sideways. */
    <div className="queue__row-chips">
      {/* tag-pill is DiffView's pill (DiffView.css), reused so the chips match the card's own tags. */}
      <span className="tag-pill">{fitChip(facts?.fit)}</span>
      {/* The tailored resume's coverage, beside the master's fit, so the two scores read as a pair. */}
      <span className="tag-pill">{atsChip(diff)}</span>
      {/* Finding N2: only when the gate says so. A warning, so it is set apart by weight and edge, not a new colour. */}
      {facts?.payBand ? <span className="tag-pill queue__row-chip--warn">{facts.payBand}</span> : null}
    </div>
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
  /* Each row's source (master, original, tailor_refs, FULL) as last published. Added 2026-11-01
     (review finding): an attest RE-PINS the row, and the next op of the same Apply all ran with the
     render closure's OLD source, so it was refused as "master version changed". Read here, never
     from `sources`, anywhere an async edit needs the row's current pin. */
  const latestSources = useRef<Map<string, RowSource>>(new Map());
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
  /* Whether THIS page instance is still mounted (2026-11-05, AI chat bug b). A remount mid-ask left the old
     page's auto-apply landing late and writing the row, so the new page held a stale stamp and its next
     Apply hit 0 rows. A ref, so an async continuation reads the current value, not a render closure's. */
  const mountedRef = useRef(true);
  // Set true in the body too: StrictMode's dev double-mount runs the cleanup once, then the effect again.
  useEffect(() => {
    // (Re)mounted: this instance may write.
    mountedRef.current = true;
    // Unmounted: any late call into editRow from this instance is refused.
    return () => {
      // Read by editRow's first guard.
      mountedRef.current = false;
    };
  }, []);

  /* Bucket A rows the operator has opened, for the diff and for the preview
     separately. Added 2026-10-06: Bucket A used to be a count and a batch button
     only, so a clean row could be approved by someone who never saw its resume. */
  const [reviewing, setReviewing] = useState<ReadonlySet<string>>(() => new Set());
  // Rows whose rendered resume is showing; separate because a preview is tall.
  const [previewing, setPreviewing] = useState<ReadonlySet<string>>(() => new Set());
  /* Bucket B rows the operator FOLDED away (2026-11-02). Inverted on purpose: Bucket A tracks
     what is open, Bucket B tracks what is closed, so an empty set means every Bucket B row is
     open, which keeps the "a flagged row is read by default" rule. */
  const [foldedB, setFoldedB] = useState<ReadonlySet<string>>(() => new Set());
  /* THE DOCKED AI CHAT (Teja 2026-11-06): the ONE row whose chat shows in the right-hand dock, or null.
     Page state, not DiffView state, so a cross-bucket remount keeps the dock on the same row, and so
     there can never be two chats open: the dock holds exactly this id's chat, and that chat's edits
     are bound to the same id (DiffView builds onEdit from its own diff). */
  const [dockId, setDockId] = useState<string | null>(null);
  /* The dock element, as state (a callback ref), so rows re-render once it exists and can portal into it. */
  const [dockNode, setDockNode] = useState<HTMLElement | null>(null);
  /* The page-level polite announcement. Page state, not DiffView state, so it survives the
     DiffView remount a cross-bucket save causes. */
  const [announcement, setAnnouncement] = useState<string>('');
  /* The row whose card should take focus once the save that moved it has rendered. Set ONLY on a
     bucket move: an in-bucket save keeps DiffView mounted, and its own focus return handles it. */
  const [pendingFocusId, setPendingFocusId] = useState<string | null>(null);
  /* Per-row "your click was refused because the row changed" notices, keyed by application id.
     Page state (not DiffView state) so it survives the remount an adoption that moves the row
     between buckets causes, and stays on the card until the operator acts on that row again. */
  const [staleNotices, setStaleNotices] = useState<ReadonlyMap<string, string>>(new Map());
  /* Per-row held re-checks (2026-11-05), each tied to the stamp of the stored version it checked, so a
     second click acknowledges exactly those words. Page state for the same remount reason as above. */
  const [approveHolds, setApproveHolds] = useState<ReadonlyMap<string, { readonly stamp: string; readonly hold: ApproveHold }>>(new Map());
  /* The toolbar's choices: sort, work type and search (2026-11-04). Page state, never stored:
     Teja asked for a view, not a preference, so a reload starts from the default again. */
  const [view, setView] = useState<QueueView>(DEFAULT_QUEUE_VIEW);
  /* Each row's chip facts (fit, location, pay-band warning), from the same load pass as the queue. State,
     not a ref: only the render reads it, and no async path ever writes it after the load. */
  const [chipFacts, setChipFacts] = useState<ReadonlyMap<string, RowChipFacts>>(() => new Map());
  /* The rows' job descriptions, read after the first paint (loadJobDescriptions). A closed union, so
     "still loading", "failed" and "loaded" are three different things on screen, never one blank. */
  const [jobDescriptions, setJobDescriptions] = useState<{ readonly state: 'loading' } | { readonly state: 'error'; readonly message: string } | { readonly state: 'ready'; readonly byApplication: ReadonlyMap<string, string | null> }>({ state: 'loading' });

  /* Put a stale-refusal notice on one row's card and move focus there, so a refused click is never
     silent. Functional update: settle() runs across awaits, and its render closure is stale.
     `focus` defaults to true (a single-row click focuses its card); a batch passes false for every
     refused row after the first, so focus lands once instead of jumping to the last card. */
  function noteStale(applicationId: string, message: string = STALE_CLICK_MESSAGE, { focus = true }: { focus?: boolean } = {}): void {
    // A new Map every time (never mutate), so React sees the change and the old map stays valid.
    setStaleNotices((previous) => new Map(previous).set(applicationId, message));
    // Reuses the bucket-move focus effect (the card id exists in both buckets), unless the caller already focused one.
    if (focus) setPendingFocusId(applicationId);
  }

  /* Drop one row's notice when the operator acts on it again, so a repeat refusal re-announces
     (a status region only speaks on a change) and a successful retry leaves no stale warning behind. */
  function clearStale(applicationId: string): void {
    // Functional + copy, as in noteStale; a no-op copy is skipped so an unrelated click costs no render.
    setStaleNotices((previous) => {
      // Nothing showing for this row: keep the same map, so React bails out of the render.
      if (!previous.has(applicationId)) return previous;
      // A copy without this row's notice.
      const next = new Map(previous);
      // The removal itself, on the copy.
      next.delete(applicationId);
      // Handed back as the new state.
      return next;
    });
  }

  /* Runs after the commit that drew the moved card in its new bucket, so the element exists.
     Without it focus falls to <body> when the old card unmounts. */
  useEffect(() => {
    // Nothing moved: leave focus wherever the operator (or DiffView) put it.
    if (pendingFocusId === null) return;
    // The card in its NEW bucket; absent only if the row also left the queue, and then there is nothing to focus.
    document.getElementById(cardId(pendingFocusId))?.focus();
    // One-shot: a later unrelated render must not yank focus back here.
    setPendingFocusId(null);
  }, [pendingFocusId]);

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

        /* Both first-paint reads (applications + newest master), from queuePrefetch.ts since 2026-11-09.
           App.tsx kicks them while this chunk is still downloading; take that in-flight read when there is
           one, so the page does not send a second copy. null = none kicked, taken already, too old, or
           skipped (signed out at boot): read here, exactly as before. The select lives in readQueue, so the
           prefetched read and this one cannot drift apart. */
        const [{ data, error }, newestMaster] = (await takeQueuePrefetch()) ?? (await readQueue(supabase!));

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
        // Each reviewable row's chip facts from the same read (2026-11-04), published with the queue.
        const facts = new Map<string, RowChipFacts>();
        /* EVERY pinned version is read AT ONCE, before the row pass (2026-11-05). The row loop used
           to await each new version in turn, so 4 versions cost 4 sequential round trips (~0.6-1.2 s)
           before anything rendered. Same per-version maybeSingle read as before, only concurrent. */
        // The versions some row will actually be diffed against; refused rows never need a master.
        const pinned = new Set<number>();
        // Same three gates as the row pass below, so no master is fetched for a row it refuses.
        for (const app of data) {
          // A missing job, a bad pin or a non-resume is refused below; skip its read.
          if (app.jobs !== null && classifyTailored(app.tailored_profile) !== 'no_pin' && isResumeShape(app.tailored_profile)) {
            // The version the Tailor resolved against, the only honest master for this row.
            pinned.add(app.tailored_profile.master_version);
          }
        }
        /* The prefetched newest master, if it is one some row is pinned to. A failed or empty prefetch
           is NOT a page error: its version simply stays unread and is fetched below like any other,
           so the failure is reported (or not) exactly as before this prefetch existed. */
        const newestVersion = newestMaster.error === null ? newestMaster.data?.version : undefined;
        // Only an integer version can be a pin; anything else is ignored rather than guessed at.
        if (Number.isInteger(newestVersion) && pinned.has(newestVersion as number)) {
          /* Keyed by the version the DATABASE returned with this profile, never by "the newest", so a
             row pinned to v26 can never be resolved against a v27 that landed in between (§6). */
          masters.set(newestVersion as number, masterFromRow(newestMaster.data?.profile));
        }
        // One concurrent read per version; each result keeps its version so a failure can be named.
        const masterReads = await Promise.all(
          // One read per distinct version the prefetch did not already answer (usually none).
          [...pinned].filter((version) => !masters.has(version)).map(async (version) => {
            // The same read the loop used to make serially.
            const read = await supabase!.from('master_profiles').select('profile').eq('version', version).maybeSingle();
            // The version travels with its answer.
            return { version, data: read.data, error: read.error };
          }),
        );
        // A cancelled render has nothing to report.
        if (!live) return;
        /* NO MASTER, NO AUDIT. Until 2026-10-04 a failed read diffed every resume against a
           HARDCODED profile. Audit findings computed against invented data are worse than
           none: they look like a verdict.
           A TRANSPORT failure stops the page: nothing else can be trusted to load either. */
        const failedRead = masterReads.find((read) => read.error);
        // "Could not ask" is page-level: the operator's fix is the connection, not a row.
        if (failedRead !== undefined) {
          // Names the version, as the serial read did.
          setLoadError(
            `Could not load master profile version ${failedRead.version}, so no tailored resume can be audited against it. Nothing here was checked.`,
          );
          // Nothing below may run while the database is unreachable.
          return;
        }
        /* Fix 4: a version that is simply NOT STORED refuses only the rows pinned to it. One
           bad row used to blank the whole queue, hiding every reviewable row behind it.
           A SHAPE check, not "is it an object": '{}' used to pass and be diffed against, so
           every claim would read as untraced against a master with no content. */
        for (const read of masterReads) masters.set(read.version, masterFromRow(read.data?.profile));
        // FULL per pinned version, filled on first use in the row pass; one resolve per version, not per row.
        const fullByVersion = new Map<number, ReturnType<typeof resolveFullMaster>>();
        // Re-ordered client-side too, for the id tie-break and a malformed stamp sorting last.
        for (const app of newestInReviewFirst(data)) {
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

          /* Read up front, above. A version absent from the map was never fetched; that must refuse
             the row like a missing master, never diff it against nothing (fail closed). */
          const master = masters.get(version) ?? null;
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
          /* Only the three fields the adapter reads, with the keyword list made safe for it. Built field
             by field, not cast: the select no longer returns a whole ApplicationRow (latency fix 2a). */
          const application: DiffAdapterInput['application'] = {
            // The row's id, which keys everything on the page.
            id: app.id,
            // The auditor's findings, located on the diff by the adapter.
            audit_findings: app.audit_findings,
            // A null keyword list reads as none, never as a crash.
            selected_jd_keywords: app.selected_jd_keywords || [],
          };

          // FULL at the same pin: every master node as a tailoring would render it, for add-backs. Null = edits off.
          /* Memoised per version (2026-11-08): FULL depends only on (master, version), and the master is
             one cached object per version, so every row on v26 got the same answer recomputed (~70% of the
             mount's CPU). has(), not ?? : a cached null (edits off) must stay cached, not be recomputed. */
          if (!fullByVersion.has(version)) fullByVersion.set(version, resolveFullMaster(master, version));
          // The one shared FULL for this pin; nothing downstream mutates it (diff and edits copy from it).
          const full = fullByVersion.get(version) ?? null;

          // The diff, with FULL so the add-back offers come from the same pin as everything else.
          const diff = buildResumeDiff({ application, job, resolved, master, original, full });

          diffs.push(diff);
          // Same row, same snapshot: the preview can never show a different resume than the diff.
          snapshots.set(app.id, resolved);
          // The stamp this snapshot was read at; the first edit must present it.
          /* Only a real string: String(undefined) would be the stamp "undefined", sent as if it were
             a timestamp. Without one the row has no stamp, so it can never be approved (unverifiable). */
          if (typeof app.updated_at === 'string') stamps.set(app.id, app.updated_at);
          // The chips' inputs (fit, location, pay-band warning), through the same pure builder the test renders.
          /* `job`, not app.jobs: the untyped client infers the embed as an array, and `job` is the one row this
             pass already narrowed (and refused when missing). */
          facts.set(app.id, chipFactsFor({ match_score: app.match_score, jobs: job }));
          // Kept so a save rebuilds this exact diff with the new resume.
          rowSources.set(app.id, {
            application,
            job,
            master,
            original,
            // Any stored letter, even empty-but-present, was written before the edit.
            hasCoverLetter: app.cover_letter !== null && app.cover_letter !== undefined,
            // The tailor's record, needed again only if the operator vouches for a skill.
            tailorRefs: app.tailor_refs,
            // The whole master at the pin, so a save never re-resolves it against another version.
            full,
          });
        }

        setQueue(diffs);
        // Published with the queue so a rendered row always has its snapshot.
        setResumes(snapshots);
        // Same pass, so every rendered row can be rebuilt after a save.
        setSources(rowSources);
        // Same pass, so a rendered row never shows another load's chips.
        setChipFacts(facts);
        // The ref starts from the same load, like latestResumes below.
        latestSources.current = new Map(rowSources);
        // The refs start from the same load, so the first edit and approval read what is on screen.
        latestResumes.current = new Map(snapshots);
        // Same, for the diffs the bucket re-check reads.
        latestDiffs.current = new Map(diffs.map((diff) => [diff.applicationId, diff]));
        // And the stamps, from the same read.
        latestStamps.current = stamps;

        /* Published in the same pass, so the banner and the buckets can
           never disagree about what this read found. */
        setUnreviewable(refused);
        /* The descriptions, AFTER the queue is published and NOT awaited, so the cards paint without
           them. The ids only decide whether there is anything to read (an empty queue skips the request). */
        void loadJobDescriptions(diffs.map((diff) => diff.applicationId));
      } finally {
        if (live) setLoading(false);
      }
    }
    /* The loaded rows' job descriptions, read after the first paint (2026-11-09). One request, filtered like
       the queue read (status), NOT by an id list: 36 characters per id would put a 400-row queue's URL near
       the gateways' limits, and a refused URL would switch off every chip and chat at once. A row that left
       the queue in between gets no text; it can no longer be approved here anyway. The answer feeds the
       pay-band chips and the AI chat; until it lands, the chat is locked (AiEditPanel), so the AI never
       answers from a description that was simply not loaded yet. */
    async function loadJobDescriptions(applicationIds: readonly string[]): Promise<void> {
      // No rows, nothing to read: an empty answer is complete.
      if (applicationIds.length === 0) {
        // Ready with nothing in it, so no notice and no lock.
        setJobDescriptions({ state: 'ready', byApplication: new Map() });
        // Done.
        return;
      }
      // Each application with its job's text only; the inner fields stay out of the first paint's read.
      const { data, error } = await supabase!.from('applications').select('id, jobs:job_id(description_raw)').eq('status', 'awaiting_approval');
      // The page was left (or StrictMode remounted it): this answer belongs to no one.
      if (!live) return;
      // supabase-js returns failures as data. A failure is said on the page, never read as "no description".
      if (error !== null || !Array.isArray(data)) {
        // The page-level notice names it; the chips stay off and the chats stay locked.
        setJobDescriptions({ state: 'error', message: error?.message ?? 'the job descriptions came back in an unexpected shape' });
        // Nothing to fill.
        return;
      }
      // Application id -> its job's description, or null when the job has none stored.
      const byApplication = new Map<string, string | null>();
      // Each returned row, shape-checked: the client is untyped.
      for (const row of data as readonly { readonly id?: unknown; readonly jobs?: unknown }[]) {
        // A row without a string id cannot be matched to a card.
        if (typeof row.id !== 'string') continue;
        // The embed may come back as one object or a one-element array, depending on the client's inference.
        const job: unknown = Array.isArray(row.jobs) ? row.jobs[0] : row.jobs;
        // Only a real string is a description; anything else is "none stored".
        byApplication.set(row.id, job !== null && typeof job === 'object' ? textOrNull((job as { readonly description_raw?: unknown }).description_raw) : null);
      }
      // Published: the chats unlock and render reads the text from here.
      setJobDescriptions({ state: 'ready', byApplication });
      /* The pay-band chip, now that its second input exists: the screener's own rule over the location the
         load pass stored and this text. A row with no answer keeps its chip off, as a missing JD always did. */
      setChipFacts((previous) => {
        // A copy, so React sees a change and the old map stays valid.
        const next = new Map(previous);
        // Only rows this answer covered.
        for (const [applicationId, facts] of previous) {
          // Not returned: leave its facts as they are.
          if (!byApplication.has(applicationId)) continue;
          // The same pure gate the screener runs, with the same two inputs.
          next.set(applicationId, { ...facts, payBand: payBandRegionWarning({ locationRaw: facts.location, description: byApplication.get(applicationId) ?? null }) });
        }
        // Handed back as the new state.
        return next;
      });
    }
    void loadQueue();
    return () => {
      live = false;
    };
  }, []);

  /* The diff a card hands to DiffView, with its job description laid over it once loaded (2026-11-09).
     The queue's diffs never carry it (the first read does not select it), so `undefined` keeps meaning
     "not loaded yet" and AiEditPanel stays locked; null means "loaded, the job has none". */
  function withJobDescription(diff: ResumeDiff): ResumeDiff {
    // Not loaded, failed, or this row not answered: the diff as it is.
    if (jobDescriptions.state !== 'ready' || !jobDescriptions.byApplication.has(diff.applicationId)) return diff;
    // A copy with the text; the queue's own diff is never mutated.
    return { ...diff, jobDescription: jobDescriptions.byApplication.get(diff.applicationId) ?? null };
  }

  /* Partition by bucket. Derived from the findings on each row, never stored -
     a row carrying a stored bucket alongside its findings will eventually
     disagree with them, and the badge is what the operator would trust. */
  /* THE TOOLBAR'S VIEW (2026-11-04) is applied HERE, before the split, so both buckets, their
     headings and the Approve-all button all read the rows the operator can SEE. `pending` stays
     unfiltered: it is what the counts and the "Queue is empty" gate must judge, because a filter
     that hides every row is not an empty queue. */
  const { bucketA, bucketB, bucketBFilteredOut, bucketBShownCount, pendingRefused, pendingCount, arrangementCounts } = useMemo(() => {
    // Every row still waiting, in queue order (newest first), which applyQueueView requires as input.
    const pending = queue.filter((diff) => !settled.has(diff.applicationId));
    // Work type, then search, then sort; a new array, so `queue` keeps its fetched order.
    const shown = applyQueueView(pending, view);
    // Membership, to find the Bucket B rows the view hides.
    const shownIds = new Set(shown.map((diff) => diff.applicationId));
    // Split AFTER the view, so Bucket B's visible rows keep the chosen sort.
    const shownB = shown.filter((diff) => deriveBucket(diff) === 'B');
    /* Bucket B rows the view hides. Still MOUNTED (with `hidden`), never dropped: a Bucket B
       DiffView holds the operator's claim decisions and half-typed edits in its own state, and the
       fold rule above (2026-11-02) keeps it mounted for exactly that reason. Typing a search must
       not wipe a review in progress. Bucket A rows unmount, as they already do when folded. */
    const filteredOutB = pending.filter((diff) => deriveBucket(diff) === 'B' && !shownIds.has(diff.applicationId));
    return {
      // Split AFTER the view too: only visible rows, in the chosen order, so Approve all sends what is seen.
      bucketA: shown.filter((diff) => deriveBucket(diff) === 'A'),
      /* Bucket B in RENDER order: the visible rows, then the hidden ones. One list, so React keeps each
         row's DiffView by key as it moves between visible and hidden; two lists would remount it. */
      bucketB: [...shownB, ...filteredOutB],
      // Which Bucket B cards render `hidden`.
      bucketBFilteredOut: new Set(filteredOutB.map((diff) => diff.applicationId)),
      // Bucket B's VISIBLE count, for its heading; bucketB.length also counts the hidden rows.
      bucketBShownCount: shownB.length,
      /* NOT filtered: a refused row has no diff to search or sort, and every one needs a decision
         (reject or re-tailor), so hiding one behind a search would strand it. */
      pendingRefused: unreviewable.filter((row) => !settled.has(row.applicationId)),
      // The unfiltered count: the empty-state gate, the toolbar's presence and "of Y".
      pendingCount: pending.length,
      // Each work-type chip's count over every waiting row, so a chip says what choosing it would show.
      arrangementCounts: countByArrangement(pending),
    };
  }, [queue, unreviewable, settled, view]);

  /* The docked row's diff, if it is still in the page: a row that was approved, rejected or filtered
     out of the view takes its chat with it, so the dock never describes a row that is not on screen.
     Computed here, above the page's early returns, so the effect below keeps the hooks order stable. */
  const dockDiff = dockId === null ? undefined : [...bucketA, ...bucketB].find((d) => d.applicationId === dockId);

  /* A docked row that left the page forgets the dock: otherwise the same id coming back (filter cleared,
     refetch) would silently re-open its chat. */
  useEffect(() => {
    // Only when a dock was set and its row is gone.
    if (dockId !== null && dockDiff === undefined) setDockId(null);
  }, [dockId, dockDiff]);
  // How many reviewable rows the view lets through, for "Showing X of Y" and the no-match state.
  const shownCount = bucketA.length + bucketBShownCount;

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
  /* Ask dispatch-apply to start the runs (apply-kit always, the applier when the switch is on), and say what happened.
     Since 5c3ce87: with Teja's switch OFF the kit is still dispatched and only the applier is skipped (200,
     silent: the expected state, not news). ANY dispatch error, the kit's included, is a 502 and a toast.error. */
  async function dispatchAfterApprove(): Promise<void> {
    // No client means no connection; the approve toast already said what happened.
    if (supabase === null) return;
    // One call; never throws.
    const result = await requestDispatch(supabase);
    // Started: say so, with how many rows the run will try.
    if (result.kind === 'dispatched') toast.info(`Applier started for ${result.approved} approved ${result.approved === 1 ? 'job' : 'jobs'}. Results show in Pipeline within a few minutes.`);
    /* Failed: the approve stands; only the automatic start did not happen. "the run", not "the applier"
       (2026-11-05): every approve also dispatches apply-kit, and the message already names which workflow. */
    else if (result.kind === 'error') toast.error(`Approved, but GitHub did not start the run: ${result.message}`);
  }

  async function settle(
    ids: readonly string[],
    to: 'approved' | 'dropped_filter',
    detail: Readonly<Record<string, unknown>> = {},
    // The batch button's promise: only rows that are STILL Bucket A when their turn comes.
    requireBucketA = false,
    /* The stamp of the stored version whose held re-check the operator just approved past (the
       "Approve with these" click, 2026-11-05). Undefined on every first click. */
    acknowledgedStamp: string | undefined = undefined,
  ): Promise<void> {
    /* A new Approve/Reject on these rows retires their old stale notice FIRST, before any await, so
       a second stale refusal is a fresh change to the status region and is announced again. */
    for (const id of ids) clearStale(id);

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
    /* Whether this settle already moved focus to a refused card. A batch can refuse several rows;
       focusing each in turn would leave focus on the LAST one and skip past the first notice.
       Rows now settle concurrently (2026-11-08), so "first" is the first refusal to FINISH, which is
       not always the first in list order; still exactly one focus move per settle. */
    let focusedOne = false;

    try {
      /* CONCURRENT, capped at SETTLE_CONCURRENCY rows in flight (2026-11-08). Each row costs two sequential
         round trips (confirmFresh, then the RPC; ~0.3 s each to Sydney), so a 10-row batch took ~6 s one row
         at a time. Rows are independent: each keeps its own confirm -> re-check -> RPC order inside settleOne,
         and each writes only its own id into the outcome lists, so one failed row can never mark another.
         The batch is still N per-row RPCs, never one bulk call (see THE DOOR above). */
      // Narrowed once: the null check above does not reach into the closure below.
      const client = supabase;
      // One row, start to finish; `return` is the old loop's `continue`.
      const settleOne = async (id: string): Promise<void> => {
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
          const check = stamp === undefined ? { kind: 'unverifiable' as const } : await confirmFresh(client, id, stamp);
          // Changed elsewhere: redraw what is stored so the operator sees the other tab's words.
          if (check.kind === 'changed') {
            // Only when the re-read produced a row; a vanished row has nothing to draw.
            if (check.stored !== undefined) adoptStored(id, check.stored);
            // Named in the summary, never approved on the strength of the old diff.
            changed.push(id);
            /* STALE PATH 1: said ON the card (and focused), because the toast alone read as "did nothing".
               Only when a fresh row was adopted and is still awaiting: that is the "latest version" the
               words point at. A row now approved/rejected elsewhere was removed by adoptStored (no card). */
            if (check.stored?.status === 'awaiting_approval') {
              // The newer stored version is on screen now; ask for a review of it.
              noteStale(id, STALE_CLICK_MESSAGE, { focus: !focusedOne });
              // Later refusals in this settle keep focus here.
              focusedOne = true;
            }
            // Vanished (no row re-read): nothing adopted, so the old card may still show; say it is gone.
            else if (check.stored === undefined && latestDiffs.current.has(id)) {
              // Truthful wording: there is no newer version to review, only a reload to do.
              noteStale(id, GONE_MESSAGE, { focus: !focusedOne });
              // Same focus-once rule.
              focusedOne = true;
            }
            // Next row.
            return;
          }
          // Could not ask: unverifiable means unapproved, because the promise is "what you saw".
          if (check.kind === 'unverifiable') {
            // Named in the summary so the operator retries it.
            unverified.push(id);
            // Next row.
            return;
          }
        }
        // The diff as it is NOW (after any adoption above), not as it was when the button was clicked.
        const latest = latestDiffs.current.get(id);
        /* R2 at the moment of writing: a row edited into Bucket B after the batch snapshot, or with a
           save still in flight in this tab, must not be approved as 'bucket_a_batch'. */
        if (requireBucketA && (latest === undefined || deriveBucket(latest) !== 'A' || editing.current.has(id))) {
          // Left in the queue for individual review.
          skipped.push(id);
          /* STALE PATH 2: the batch refused a row; the card says why. No card when the row left the
             queue (latest undefined), so the summary toast is the only place left to say it. */
          if (latest !== undefined) {
            // The operator's own save is still in flight: "changed" would be untrue, so say "still saving".
            noteStale(id, editing.current.has(id) ? SAVING_SKIP_MESSAGE : STALE_CLICK_MESSAGE, { focus: !focusedOne });
            // Later refusals in this batch keep focus on this first card.
            focusedOne = true;
          }
          // Next row.
          return;
        }
        /* THE RE-CHECK (Teja, 2026-11-05: "Check on Approve, hold for a 2nd click"). The auditor ran
           once, at tailoring; an edit made since was never re-checked, and the worker submits an
           approved row by itself. So an EDITED row is audited again here, after confirmFresh proved
           this tab's resume is the stored one, by the auditor's own function against the row's
           CURRENT pinned master (an attest replaced latestSources with the re-pinned one). Anything
           but a clean verdict holds the row: the card lists the findings, or why the check could not
           run, and only a second click naming THIS stored version (its stamp) sends it. A newer save
           changes the stamp, so an acknowledgement never carries over to words nobody saw checked.
           Unedited rows skip it, the Bucket A batch included (R2 keeps edited rows out of it): the
           auditor's verdict still describes every word of those. */
        if (to === 'approved' && latest !== undefined && latest.editCount > 0 && (acknowledgedStamp === undefined || acknowledgedStamp !== stamp)) {
          // The row's inputs as they are now, re-pin included.
          const source = latestSources.current.get(id);
          // The auditor's verdict on what is stored; fail-closed by construction (approveCheck.ts).
          const verdict = checkBeforeApprove(source?.master, latestResumes.current.get(id), source?.tailorRefs);
          // A pass sends on this click, as before; anything else holds.
          if (verdict.kind !== 'clean') {
            // The result, tied to the version it describes; a missing stamp was refused above, so '' never matches one.
            const held = { stamp: stamp ?? '', hold: verdict };
            // Copied, never mutated, as every per-row map here.
            setApproveHolds((previous) => new Map(previous).set(id, held));
            // Said at the top of the card, with focus once per settle, like every refused click.
            noteStale(id, HELD_FOR_CHECK_MESSAGE, { focus: !focusedOne });
            // Later refusals in this settle keep focus here.
            focusedOne = true;
            // Not sent: the row stays in the queue, unlocked by the finally below.
            return;
          }
        }
        /* `human` is not decoration: the guard reads it to decide whether this
           edge is legal at all, and no other agent value opens this one. */
        // The RPC's whole result: the status is needed to tell "refused" from "no answer" (item 6).
        let result: { error: { code?: unknown } | null; status?: unknown };
        try {
          result = await client.rpc(
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
          return;
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
          return;
        }
        // What the row says now.
        const outcome = await confirmSettle(client, id, to);
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
          // STALE PATH 3: PT409 with the newer row adopted; the card says why nothing was approved.
          noteStale(id, STALE_CLICK_MESSAGE, { focus: !focusedOne });
          // Focus-once, as on the other two paths.
          focusedOne = true;
        }
        // Stale stamp but the re-read failed: we know the row changed, not to what. Retry runs confirmFresh first.
        /* No card notice here on purpose: nothing was adopted, so "review the latest version" would
           point at a version not on screen. The "could not confirm" toast asks for a retry, and the
           retry's confirmFresh adopts the newer row and raises the notice (STALE PATH 1). */
        else if (staleStamp) unverified.push(id);
        else if (noAnswer) unconfirmed.push(id);
        // Refused, and nothing moved: a real failure, safe to retry.
        else failed.push(id);
      };
      // The next row a free worker takes; shared, so no row is taken twice.
      let nextRow = 0;
      // A worker settles rows until none are left; JS is single-threaded, so the read-and-bump is atomic.
      const worker = async (): Promise<void> => {
        // Take the next untaken row, in the order the operator sees them.
        for (let id = mine[nextRow++]; id !== undefined; id = mine[nextRow++]) await settleOne(id);
      };
      /* allSettled, not all: a throwing row must not let the finally below unlock rows other workers still
         have in flight. Every worker finishes first; the first throw is then re-raised, as the loop did. */
      const runs = await Promise.allSettled(Array.from({ length: Math.min(SETTLE_CONCURRENCY, mine.length) }, worker));
      // The first failure, if any; a clean batch has none.
      const thrown = runs.find((run): run is PromiseRejectedResult => run.status === 'rejected');
      // Re-raised after every row settled, so the finally runs once, with nothing still in flight.
      if (thrown !== undefined) throw thrown.reason;
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
    /* APPLY ON APPROVE (P1-6, 2026-11-05): ONE dispatch per approve action, after the per-row loop,
       so the Bucket A batch (N rows, one settle call) starts one workflow run, not N. Fire and forget:
       dispatchAfterApprove reports through toasts itself, and the approve already stands either way. */
    if (to === 'approved' && moved.length > 0) void dispatchAfterApprove();
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
        `${changed.length} ${changed.length === 1 ? 'application was' : 'applications were'} not approved because ${changed.length === 1 ? 'it' : 'they'} changed elsewhere since you opened ${changed.length === 1 ? 'it' : 'them'}. Review the latest version, then click Approve again.`,
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
    // True on the held card's "Approve with these" click (2026-11-05): the operator read the re-check.
    acknowledged = false,
  ): void {
    // Fire and forget: settle() reports success and failure through toasts itself.
    void settle(
      [applicationId],
      'approved',
      {
        // What was decided, claim by claim.
        claim_decisions: Object.fromEntries(decisions),
        // Distinguishes an opened-and-read Bucket A row from the batch button.
        review_path: reviewPath,
      },
      // Never a batch: one row, opened and read.
      false,
      // The stamp of the version whose re-check was shown; settle sends only if it is still the stored one.
      acknowledged ? approveHolds.get(applicationId)?.stamp : undefined,
    );
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
  function adoptRow(
    // The row to redraw.
    applicationId: string,
    // The resume now stored for it.
    resume: ResolvedResume,
    // The stamp that resume was stored at; the next edit must present it.
    updatedAt: string,
    // An attest re-pins the row, so it hands in the NEW source; the render closure still holds the old one.
    source: RowSource | undefined = latestSources.current.get(applicationId),
    // No return value: the refs and the rendered state ARE the result.
  ): void {
    // A row this page never loaded has nothing to rebuild.
    if (source === undefined) return;
    // Same adapter, same pinned master, same original: only the resume differs.
    const next = buildResumeDiff({
      application: source.application,
      job: source.job,
      resolved: resume,
      master: source.master,
      original: source.original,
      // The same FULL as the load (or the re-pin), so the add-back offers match what an add would copy.
      full: source.full,
    });
    // The refs move first and synchronously, so the very next edit or approval reads this.
    latestResumes.current.set(applicationId, resume);
    // Same, for the bucket re-check and edited_lines / edited_refs.
    latestDiffs.current.set(applicationId, next);
    // The stamp the next edit must present.
    latestStamps.current.set(applicationId, updatedAt);
    // A new stored version: a held re-check described the old words, so it goes (the next Approve re-checks).
    setApproveHolds((previous) => {
      // Nothing held for this row: the same map, so React skips the render.
      if (!previous.has(applicationId)) return previous;
      // A copy without this row's hold.
      const next = new Map(previous);
      // The removal itself, on the copy.
      next.delete(applicationId);
      // Handed back as the new state.
      return next;
    });
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
      const job = latestSources.current.get(applicationId)?.job;
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

  /* VOUCHING FOR A SKILL THE MASTER LACKS. Not a pure edit of this resume: attestSkill writes a new
     master version first, then the resume with all three pins moved to it. Called only from editRow,
     after its guards (not mid-approval, one save at a time, loaded, pin unchanged since load). */
  async function attestRow(
    // The row being reviewed.
    applicationId: string,
    // What the operator vouched for, and the group it prints under.
    action: { readonly keyword: string; readonly category: string },
    // The row's load inputs, which the re-pin replaces.
    source: RowSource,
    // The tailor's version at the current pin; editRow has proven it non-null.
    original: ResolvedResume,
    // The latest saved resume.
    current: ResolvedResume,
    // The stamp it was read or saved at.
    stamp: string,
    // The connected client; editRow refused a null one.
    client: NonNullable<typeof supabase>,
    // Who decided it (a hand click or the AI chat), for the history note (2026-11-04).
    editSource: EditSource,
    // The same result shape as any edit, so DiffView locks, reports and undoes it the same way.
  ): Promise<EditResult> {
    // Emptied first, so the same sentence twice is still re-announced.
    setAnnouncement('');
    // The bucket before, to tell whether the save moved the row.
    const previousDiff = latestDiffs.current.get(applicationId);
    // Marked before the await, so a batch approval skips this row while it saves.
    editing.current.add(applicationId);
    // Declared outside the try so the result survives the finally.
    let attested: Awaited<ReturnType<typeof attestSkill>>;
    // try/finally, so the per-row lock is released even if attestSkill throws.
    try {
      // Master version first, then the re-pinned resume; it never throws by design.
      attested = await attestSkill(client, {
        // The row being written.
        applicationId,
        // The chip's keyword, which becomes the skill's printed name.
        keyword: action.keyword,
        // The group the operator picked.
        category: action.category,
        // The latest saved resume, so the add never builds on an older one.
        current,
        // The tailor's version at the current pin, for the rebuild proof.
        original,
        // The tailor's record, re-pinned in the same write as the resume.
        tailorRefs: source.tailorRefs,
        // Optimistic concurrency, same as every other edit.
        expectedUpdatedAt: stamp,
        // A fresh master node id; NodeIds must be unique across the whole master.
        newSkillId: `skill_${crypto.randomUUID()}`,
        // The row's JD keywords, for the one-page fit in the same save.
        jdKeywords: source.application.selected_jd_keywords,
        // Into the history note's detail.source.
        source: editSource,
      });
    // Runs on success, refusal and throw alike.
    } finally {
      // Released whatever happened.
      editing.current.delete(applicationId);
    }
    // Not saved, or not known to be saved.
    if (!attested.ok) {
      // A refused or unknown row write: show what IS stored, as every other edit does.
      if (attested.stored !== undefined) {
        // Redrawn from the database, never from the operator's attempt.
        adoptStored(applicationId, attested.stored);
        // Page-level, because the whole row may have changed.
        toast.error(attested.message);
      }
      // The master write is never silent: if a version was made, the operator is told it exists.
      // "Not saved" stays true for the resume; the master half is spelled out after the reason.
      return notSaved(attested.masterInserted ? `${attested.message} ${action.keyword} was added to your master profile; this resume was not changed.` : attested.message);
    }
    // The row now traces to the new version: its master, original and tailor_refs move with it.
    // FULL is re-resolved at the NEW pin: the old one lacks the attested skill's master version.
    const nextSource: RowSource = { ...source, master: attested.master, original: attested.original, tailorRefs: attested.tailorRefs, full: resolveFullMaster(attested.master, attested.resume.master_version) };
    // Published for later renders and edits.
    setSources((previous) => new Map(previous).set(applicationId, nextSource));
    // Synchronously, so the very next op of the same batch reads the new pin.
    latestSources.current.set(applicationId, nextSource);
    // Redrawn against the NEW source now; the closure would still hold the old pin's master.
    adoptRow(applicationId, attested.resume, attested.updatedAt, nextSource);
    // A one-page trim in this save is never silent.
    if (attested.notice !== null) toast.info(attested.notice);
    // Bucket before and after, derived the same way the render partitions the queue.
    const from = previousDiff === undefined ? undefined : deriveBucket(previousDiff);
    // adoptRow just put the rebuilt diff in the ref synchronously, so this is the bucket it renders in.
    const nextDiff = latestDiffs.current.get(applicationId);
    // Bucket after; undefined only for a row never loaded, which editRow's guards refused.
    const to = nextDiff === undefined ? undefined : deriveBucket(nextDiff);
    // Page-level only on a move; an in-bucket attest is announced by CoverageBar's own region.
    if (from !== to) setAnnouncement(announcementFor('attest_skill', { before: null, after: action.keyword }, from, to));
    // A move needs the page to place focus.
    if (from !== undefined && to !== undefined && from !== to) setPendingFocusId(applicationId);
    // Saved; only the history note is missing.
    if (!attested.eventRecorded) toast.error('The skill was saved, but it could not be added to the application history.');
    // The skill's master id, which CoverageBar's Undo removes.
    return { ok: true, skillRef: attested.skillRef };
  }

  /* A BRAND-NEW BULLET (2026-11-01). Modelled on attestRow: the words never enter the resume directly.
     attestBullet writes them into the master as a new immutable version under their parent entry,
     re-pins the row, then adds the bullet by ref, so FULL contains it and the auditor can trace it.
     Called only from editRow, after its guards (not mid-approval, one save at a time, loaded, pin
     unchanged since load, FULL resolved). */
  async function attestBulletRow(
    // The row being reviewed.
    applicationId: string,
    // Where the bullet goes and what it says.
    action: { readonly section: BulletSection; readonly parentRef: string; readonly text: string },
    // The row's load inputs, which the re-pin replaces.
    source: RowSource,
    // The tailor's version at the current pin; editRow has proven it non-null.
    original: ResolvedResume,
    // The latest saved resume.
    current: ResolvedResume,
    // The stamp it was read or saved at.
    stamp: string,
    // The connected client; editRow refused a null one.
    client: NonNullable<typeof supabase>,
    // Who decided it (a hand click or the AI chat), for the history note (2026-11-04).
    editSource: EditSource,
    // The same result shape as any edit, so DiffView locks and reports it the same way.
  ): Promise<EditResult> {
    // Emptied first, so the same sentence twice is still re-announced.
    setAnnouncement('');
    // The bucket before, to tell whether the save moved the row.
    const previousDiff = latestDiffs.current.get(applicationId);
    // Marked before the await, so a batch approval skips this row while it saves.
    editing.current.add(applicationId);
    // Declared outside the try so the result survives the finally.
    let attested: Awaited<ReturnType<typeof attestBullet>>;
    // try/finally, so the per-row lock is released even if attestBullet throws.
    try {
      // Master version first, then the re-pinned resume; it never throws by design.
      attested = await attestBullet(client, {
        // The row being written.
        applicationId,
        // The section and entry the bullet belongs under: its true parent in the master.
        section: action.section,
        parentRef: action.parentRef,
        // The operator's words, which become the master bullet's text.
        text: action.text,
        // The latest saved resume, so the add never builds on an older one.
        current,
        // The tailor's version at the current pin, for the rebuild proof.
        original,
        // The tailor's record, re-pinned in the same write as the resume.
        tailorRefs: source.tailorRefs,
        // Optimistic concurrency, same as every other edit.
        expectedUpdatedAt: stamp,
        // A fresh master node id; NodeIds must be unique across the whole master.
        newBulletId: `bullet_${crypto.randomUUID()}`,
        // The row's JD keywords, for the one-page fit in the same save.
        jdKeywords: source.application.selected_jd_keywords,
        // Into the history note's detail.source.
        source: editSource,
      });
    // Runs on success, refusal and throw alike.
    } finally {
      // Released whatever happened.
      editing.current.delete(applicationId);
    }
    // Not saved, or not known to be saved.
    if (!attested.ok) {
      // A refused or unknown row write: show what IS stored, as every other edit does.
      if (attested.stored !== undefined) {
        // Redrawn from the database, never from the operator's attempt.
        adoptStored(applicationId, attested.stored);
        // Page-level, because the whole row may have changed.
        toast.error(attested.message);
      }
      // The master write is never silent: if a version was made, the operator is told it exists.
      return notSaved(attested.masterInserted ? `${attested.message} The bullet was added to your master profile; this resume was not changed.` : attested.message);
    }
    // The row now traces to the new version: master, original, tailor_refs and FULL all move with it.
    const nextSource: RowSource = { ...source, master: attested.master, original: attested.original, tailorRefs: attested.tailorRefs, full: resolveFullMaster(attested.master, attested.resume.master_version) };
    // Published for later renders and edits.
    setSources((previous) => new Map(previous).set(applicationId, nextSource));
    // Synchronously, so the very next op of the same batch reads the new pin.
    latestSources.current.set(applicationId, nextSource);
    // Redrawn against the NEW source now; the closure would still hold the old pin's master.
    adoptRow(applicationId, attested.resume, attested.updatedAt, nextSource);
    // A one-page trim in this save is never silent.
    if (attested.notice !== null) toast.info(attested.notice);
    // Bucket before and after, derived the same way the render partitions the queue.
    const from = previousDiff === undefined ? undefined : deriveBucket(previousDiff);
    // adoptRow just put the rebuilt diff in the ref synchronously.
    const nextDiff = latestDiffs.current.get(applicationId);
    // Bucket after; undefined only for a row never loaded, which editRow's guards refused.
    const to = nextDiff === undefined ? undefined : deriveBucket(nextDiff);
    // Always announced: unlike a skill attest, no other live region speaks a landed bullet.
    setAnnouncement(announcementFor('attest_bullet', { before: null, after: action.text }, from, to));
    // A move needs the page to place focus.
    if (from !== undefined && to !== undefined && from !== to) setPendingFocusId(applicationId);
    // Saved; only the history note is missing.
    if (!attested.eventRecorded) toast.error('The bullet was saved, but it could not be added to the application history.');
    // Saved.
    return { ok: true };
  }

  /* THE EDIT PATH: click -> pure edit -> saveTailoredEdit -> state replaced with the SAVED
     resume (or, if the save is refused or unconfirmed, with what IS stored). Nothing is shown as
     changed until the database has accepted it, so the preview, the Download and the score can
     never describe a resume that was not stored. */
  /* editSource (2026-11-04): who decided the edit, written to the history note; required, so no path
     is logged as the operator by omission. Named editSource because `source` below is the RowSource. */
  /* T10 (2026-11-10): THE OVERFLOW PREVIEW for one content-adding AI card, before its Apply. Built from the
     same refs and the same edit its save would use, then the same fit, so the drop it names is the trim the
     save makes. Pure: reads refs, writes nothing. null = no preview (not an add, or the row is not simulable;
     its save's own guards then speak). */
  function overflowFor(applicationId: string, action: EditAction): OverflowPreview | null {
    // The same inputs editRow reads.
    const source = latestSources.current.get(applicationId);
    // The latest saved resume, the one Apply builds on.
    const current = latestResumes.current.get(applicationId);
    // Not simulable: Apply's own guards will say why.
    if (source === undefined || current === undefined || source.original === null || source.full === null) return null;
    // The row's JD keywords, exactly as every save ranks the trim by.
    const jd = source.application.selected_jd_keywords;
    // A skill the master lacks: its real ref is minted at the save, so the preview builds it with a stand-in.
    if (action.kind === 'attest_skill') return previewAdd(current, { kind: 'skill', name: action.keyword, category: action.category }, jd);
    // A vouched bullet: appended under its parent, as attestBullet places it.
    if (action.kind === 'attest_bullet') return previewAdd(current, { kind: 'bullet', section: action.section, entryRef: action.parentRef, text: action.text }, jd);
    // Every other add is a pure edit from the master: the very resume its save would fit.
    if (action.kind === 'add_skill' || action.kind === 'add_master_bullet' || action.kind === 'add_master_entry') {
      // The same pure edit editRow runs.
      const outcome = pureEdit(action, current, source.original, source.master, source.full);
      // A refused edit adds nothing, so there is nothing to preview (its Apply reports the refusal).
      return outcome.ok ? overflowPreview(current, outcome.resume, jd) : null;
    }
    // Removes, moves and text edits never add a line.
    return null;
  }

  /* T10 review fix (2026-11-10): THE APPLY-ALL PREVIEW. The very planBatch editRows runs, over the same latest
     saved resume, master and JD keywords, so the line by Apply all names the trim the save makes (or its refusal).
     Pure: reads refs, writes nothing. null = not simulable, or an attest in the list (the panel never sends one). */
  function batchPreviewFor(applicationId: string, actions: readonly EditAction[]): BatchPlan | null {
    // The same inputs editRow reads.
    const source = latestSources.current.get(applicationId);
    // The latest saved resume, the one the batch folds over.
    const current = latestResumes.current.get(applicationId);
    // Not simulable: Apply all's own guards will say why.
    if (source === undefined || current === undefined || source.original === null || source.full === null) return null;
    // Narrowed copies for the step closure.
    const { original, master, full } = source;
    // Resume-only actions; an attest cannot be folded, so its presence means no preview.
    const pure = actions.flatMap((action) => (action.kind === 'attest_skill' || action.kind === 'attest_bullet' ? [] : [action]));
    // Mixed in: the save would refuse with its own words; the preview stays quiet.
    if (pure.length !== actions.length) return null;
    // Exactly what editRows plans.
    return planBatch(current, pure, (resume, action) => pureEdit(action, resume, original, master, full), source.application.selected_jd_keywords, master);
  }

  async function editRow(applicationId: string, action: PageEditAction, editSource: EditSource): Promise<EditResult> {
    // One edit is a batch of one: the same guards, the same fit, the same single save (T10 made editRows the one path).
    return editRows(applicationId, [action], editSource);
  }

  /* T10 (2026-11-10): THE ATOMIC BATCH SAVE. An AI swap (remove_entry + add_master_entry) can never pass a
     check after each op (Teja's live bug: "projects: 1, needs 2" on the remove, then nothing), so every
     pure action of the batch is folded first and only the END STATE is fitted and rule-checked
     (pageFitEdit.planBatch), then saved in ONE guarded write. All or none. The attest_* kinds also write
     the master, so they are never folded into a batch: one alone takes its own path below, and a batch
     that mixes them in is refused whole (the chat sends them on their own). */
  async function editRows(applicationId: string, actions: readonly PageEditAction[], editSource: EditSource): Promise<EditResult> {
    /* A page that is gone never writes: its refs hold a stamp the mounted page no longer trusts. In the
       page, never the panel: a Bucket A->B move remounts the panel while this page stays current. */
    if (!mountedRef.current) return notSaved('the page was reloaded before this edit could be saved; apply it again.');
    // Editing IS reviewing the latest version, which is what the stale notice asked for, so it retires.
    clearStale(applicationId);
    // What this row's diff was built from, as last published (never the render closure's copy).
    const source = latestSources.current.get(applicationId);
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
    /* Review fix (2026-10-08): the master and the original were built from the pin read at load.
       A resume now pinned elsewhere (adopted from another tab) would have a skill added from, and
       an edit checked against, the WRONG master; refuse every edit until a reload re-reads it. */
    if (current.master_version !== source.original.master_version) {
      // Operator-phrased: the fix is a reload, not anything on this line.
      return notSaved("this resume's master version changed since the page loaded; reload before editing.");
    }
    // No client, no write; say so instead of pretending.
    if (supabase === null) return notSaved('not connected to the database.');

    // No FULL: nothing could be checked against the master, so refuse before any write (same rule as the banner).
    if (source.full === null) return notSaved(FULL_UNRESOLVED_REASON);

    // A lone action, the only shape the two master-writing kinds may arrive in.
    const only = actions.length === 1 ? actions[0] : undefined;
    // Vouching for a missing skill also writes the master, so it has its own path (attestRow above).
    if (only?.kind === 'attest_skill') return attestRow(applicationId, only, source, source.original, current, stamp, supabase, editSource);
    // A brand-new bullet writes the master too, so it has the same kind of path (attestBulletRow above).
    if (only?.kind === 'attest_bullet') return attestBulletRow(applicationId, only, source, source.original, current, stamp, supabase, editSource);
    // T10: the batch's resume-only actions; an attest inside a batch cannot be folded (it writes the master).
    const pure = actions.flatMap((action) => (action.kind === 'attest_skill' || action.kind === 'attest_bullet' ? [] : [action]));
    // Refused whole rather than saving the rest: a partial batch is what T10 exists to prevent.
    if (pure.length !== actions.length) return notSaved('a skill or bullet new to your master profile is applied on its own, never inside a batch.');
    // The first action names the history note and the announcement; an empty batch is refused by planBatch.
    const first = pure[0];
    // Narrowed copies for the step closure (property narrowing does not reach into a callback).
    const { original, master, full } = source;

    /* The pure operation. Each returns a NEW resume, or a refusal before any write; tracesToMaster
       then checks at the save boundary that every node still traces to the pinned master. */
    /* THE ONE-PAGE RULE, LIVE (Teja, 2026-11-07 23:18 IST): the edited resume is fitted on one page
       BEFORE the save, and the fitted one is what is saved, so no save ever stores page two. The
       same pure trimmer the tailor runs; a cut is announced below and recorded in the history note.
       Floors that overflow, or a resume the check cannot measure, refuse the edit (fail closed). */
    // Content rules judged against the stored resume (only a newly broken rule refuses) and the pinned master.
    // T10: every action folded first, then ONE fit and rule check on the end state; a refused step refuses all.
    const fitted = planBatch(current, pure, (resume, action) => pureEdit(action, resume, original, master, full), source.application.selected_jd_keywords, master);
    // Refused before any write, in the check's own words.
    if (!fitted.ok || first === undefined) return notSaved(fitted.ok ? 'there was nothing to apply.' : fitted.reason);
    // The first step's record: the single edit's before/after, exactly as it was before batches.
    const outcome = fitted.steps[0] ?? { before: null, after: null };

    // Emptied before the save, so the same sentence twice in a row still changes the text and is re-announced.
    setAnnouncement('');
    // The bucket BEFORE the save, from the ref (not the render closure), to tell whether the save moved the row.
    const previousDiff = latestDiffs.current.get(applicationId);
    // Marked before the await, so a batch approval skips this row while it saves.
    editing.current.add(applicationId);
    // Declared outside the try so the result survives the finally.
    let saved: Awaited<ReturnType<typeof saveTailoredEdit>>;
    try {
      // Resume first, history note second; see saveTailoredEdit. It never throws (fix 1).
      saved = await saveTailoredEdit(supabase, {
        // The row being edited.
        applicationId,
        // The whole new resume, fitted on one page (the edit plus any one-page trims).
        resume: fitted.resume,
        // What it was computed from, for the R0 boundary check (fix 5).
        previous: current,
        // The tailor's version: the ground truth for refs and master_text.
        original: source.original,
        // T3: the pinned master the diff was built against, the only source an added skill may come from.
        master: source.master,
        // Optimistic concurrency: refused if another tab changed the row (fix 2a).
        expectedUpdatedAt: stamp,
        // What changed and who decided it, for the append-only log.
        // pageFitTrimmed: the one-page cuts this save made, so the history shows them beside the edit.
        // T10 batch: every step of a multi-action save, so the note names the swap's both halves.
        event: { kind: EVENT_KIND[first.kind], ref: eventRef(first), before: outcome.before, after: outcome.after, source: editSource, pageFitTrimmed: fitted.trimmed, batch: pure.map((action, i) => ({ kind: EVENT_KIND[action.kind], ref: eventRef(action), before: fitted.steps[i]?.before ?? null, after: fitted.steps[i]?.after ?? null })) },
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

    // Saved: the STORED resume (fitted, not the raw edit) and the NEW stamp, so the page shows what is stored.
    adoptRow(applicationId, fitted.resume, saved.updatedAt);
    // A one-page trim is never silent: what was cut, in words, on the page (Teja asked to see it).
    if (fitted.notice !== null) toast.info(fitted.notice);
    // Bucket before, derived the same way the render partitions the queue.
    const from = previousDiff === undefined ? undefined : deriveBucket(previousDiff);
    // adoptRow just put the rebuilt diff in the ref synchronously, so this is the bucket the row now renders in.
    const nextDiff = latestDiffs.current.get(applicationId);
    // Bucket after; undefined only if the row was never loaded, which the guards above already refused.
    const to = nextDiff === undefined ? undefined : deriveBucket(nextDiff);
    // Page-level, so it is still mounted when the save remounts DiffView in the other bucket.
    // An add that STAYS in its bucket is already announced by CoverageBar's own status region
    // (DiffView did not remount), so the page stays quiet then rather than speak it twice.
    // T10: a batch is announced as one save of N changes; a single edit keeps its own sentence.
    if (pure.length > 1) setAnnouncement(`Saved ${pure.length} changes together.`);
    // A single edit, as before.
    else if (!(first.kind === 'add_skill' && from === to)) setAnnouncement(announcementFor(first.kind, outcome, from, to));
    // Only a MOVE needs the page to place focus; an in-bucket save keeps DiffView's own focus return.
    if (from !== undefined && to !== undefined && from !== to) setPendingFocusId(applicationId);
    // The edit IS saved; only the history note is missing, and the operator should know.
    if (!saved.eventRecorded) toast.error('Your edit was saved, but it could not be added to the application history.');
    // The line closes its editor and shows the saved text.
    return { ok: true };
  }

  // Flip one id in a set-valued state; used by every disclosure on the page (both buckets).
  /* Opens this row's review, its live resume preview AND its chat in the dock, in one step: the chat is
     only useful beside the resume it edits, and a Bucket A row mounts its DiffView (and so its chat)
     only while its review is open. Opening another row's chat replaces the dock's: one thread at a time. */
  function openDock(id: string): void {
    // The dock now shows this row's chat.
    setDockId(id);
    // Bucket A: the review (and so the chat) must be mounted.
    setReviewing((previous) => new Set(previous).add(id));
    // Bucket B: unfold it, since a folded row is hidden.
    setFoldedB((previous) => {
      // Copy, then drop the id.
      const next = new Set(previous);
      next.delete(id);
      return next;
    });
    // The resume the chat edits, rendered beside it so each applied edit is visible.
    setPreviewing((previous) => new Set(previous).add(id));
  }

  /* The chat button: opens this row's chat, or closes the dock when it already shows this row's. */
  function toggleDock(id: string): void {
    // Already docked on this row: close it.
    if (dockId === id) setDockId(null);
    // Otherwise dock this row.
    else openDock(id);
  }

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
  /* Gated on the UNFILTERED count (2026-11-04): with a search that matches nothing, both buckets are
     empty while rows still wait, and this branch would tell the operator the queue is done. */
  if (pendingCount === 0 && pendingRefused.length === 0) {
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
       page measure would force the operator to scroll to compare them.
       queue-page scopes the page's one control height (ApprovalQueuePage.css) to this screen only.
       T10: the provider hands every AI chat on the page (docked or inline) its overflow preview. */
    <OverflowPreviewContext.Provider value={overflowFor}>
    <BatchPreviewContext.Provider value={batchPreviewFor}>
    <div className="page page--wide queue-page">
      <PageHeader path="approvals" />

      {/* SPLIT VIEW (Teja 2026-11-06): the queue on the left, the docked AI chat on the right while a row's
          chat is open. A plain block otherwise, so the page is unchanged until a chat is opened. */}
      <div className={dockDiff === undefined ? 'queue__split' : 'queue__split queue__split--docked'}>
      <div className="queue__main">

      {/* THE PAGE'S ONE polite live region, mounted outside both buckets so a save that moves a
          card from A to B (or back) cannot unmount it mid-announcement. Always rendered, even
          empty, because a region inserted together with its text is often not read at all. */}
      <p className="visually-hidden" role="status" aria-live="polite">
        {announcement}
      </p>

      {/* THE TOOLBAR (Teja asked 2026-11-04): search, sort and work type, all client-side over the
          rows already loaded. Shown whenever any reviewable row waits, INCLUDING when the filters
          hide all of them, so the operator can always undo a filter from where they set it. Native
          controls only: a search input, a select and a radio group, so keyboard and screen-reader
          behaviour come from the browser. Refused rows above are never filtered. */}
      {pendingCount > 0 ? (
        <div className="queue__toolbar" role="search" aria-label="Filter and sort the queue">
          {/* .field: the app's label-over-control pair (base.css), so the toolbar reads like every form. */}
          <div className="field queue__toolbar-search">
            {/* A visible label, not a placeholder: a placeholder vanishes the moment you type. */}
            <label className="field__label" htmlFor="queue-search">
              Search
            </label>
            <input
              id="queue-search"
              /* type=search: the browser draws its own clear button and Escape clears it. */
              type="search"
              className="field__control"
              placeholder="Title, company or location"
              value={view.search}
              /* Live on every keystroke: the rows are in memory, so there is nothing to submit. */
              onChange={(event) => {
                // Read now: the functional update below runs after this handler returns.
                const search = event.target.value;
                // Functional, so a quick sort change in between is never overwritten.
                setView((previous) => ({ ...previous, search }));
              }}
            />
          </div>
          {/* Same label-over-control pair as Search. */}
          <div className="field">
            <label className="field__label" htmlFor="queue-sort">
              Sort
            </label>
            <select
              id="queue-sort"
              className="field__control"
              value={view.sort}
              onChange={(event) => {
                /* Looked up, not cast: only a value the option list holds becomes the sort, so a
                   tampered option can never put an unknown sort into state. */
                const sort = QUEUE_SORTS.find((option) => option === event.target.value);
                // An unknown value changes nothing.
                if (sort !== undefined) setView((previous) => ({ ...previous, sort }));
              }}
            >
              {QUEUE_SORTS.map((option) => (
                // The view module's own words, so the option and the sort it runs share one name.
                <option key={option} value={option}>
                  {QUEUE_SORT_LABELS[option]}
                </option>
              ))}
            </select>
          </div>
          {/* A fieldset + legend: one named group of radios, the same pattern as ThemeToggle, so a
              screen reader says "Work type" before each option and arrow keys move between them. */}
          <fieldset className="queue__worktype">
            <legend className="field__label">Work type</legend>
            <div className="queue__worktype-options">
              {QUEUE_ARRANGEMENTS.map((option) => (
                /* The label wraps its radio, so the whole chip is the hit target. */
                <label
                  key={option}
                  className={view.arrangement === option ? 'queue__worktype-option queue__worktype-option--selected' : 'queue__worktype-option'}
                >
                  <input
                    type="radio"
                    /* One shared name makes these one group to the browser and to assistive tech. */
                    name="queue-worktype"
                    value={option}
                    checked={view.arrangement === option}
                    /* The option is a closed-union value from the map, so no lookup is needed here. */
                    onChange={() => setView((previous) => ({ ...previous, arrangement: option }))}
                    /* Visually hidden, still focusable; the chip draws its focus ring (CSS :has). */
                    className="queue__worktype-input"
                  />
                  {/* The count says what choosing this chip shows, before it is chosen. */}
                  {QUEUE_ARRANGEMENT_LABELS[option]} ({arrangementCounts[option]})
                </label>
              ))}
            </div>
          </fieldset>
          {/* The toolbar's own polite region: it sits outside both buckets, so a bucket move cannot
              unmount it, and it speaks only when the visible count changes. */}
          <p className="queue__showing" aria-live="polite">
            Showing {shownCount} of {pendingCount}
          </p>
        </div>
      ) : null}

      {/* FILTERS HID EVERY ROW. Said in words, with the undo beside it, so a filtered-out queue is never
          mistaken for a finished one. Not .queue__empty: that sage "you are done" framing would be a lie. */}
      {pendingCount > 0 && shownCount === 0 ? (
        <div className="queue__no-match">
          <p>No applications match these filters.</p>
          <button
            type="button"
            className="button button--secondary button--small"
            onClick={() => {
              // Back to the page as it loads: newest first, every work type, no search.
              setView(DEFAULT_QUEUE_VIEW);
              /* This button unmounts once rows return; focus goes to the search box, which stays,
                 instead of falling to <body>. */
              document.getElementById('queue-search')?.focus();
            }}
          >
            Clear filters
          </button>
        </div>
      ) : null}

      {/* The deferred description read failed (2026-11-09). Said once, above the buckets: without it the
          pay-band chips cannot be computed and every AI chat stays locked, and both would otherwise look
          like "no warning" and "not ready" with no reason given (CLAUDE.md section 6). */}
      {jobDescriptions.state === 'error' ? (
        <p className="queue__failed" role="alert">
          {/* The cause, then the two things it switches off, then the fix. */}
          Could not load the job descriptions ({jobDescriptions.message}). Pay-band warnings are not shown and the AI chat is unavailable. Reload the page to try again.
        </p>
      ) : null}

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
      {/* Mounted while ANY Bucket B row waits, shown or filtered out (2026-11-04: bucketB holds both),
          so a filter can never unmount a review in progress; hidden whole when the view shows none. */}
      {bucketB.length > 0 ? (
        <section className="queue__bucket" aria-labelledby="bucket-b-heading" hidden={bucketBShownCount === 0}>
          <h2 id="bucket-b-heading" className="queue__bucket-heading">
            {/* The VISIBLE count (2026-11-04), so the heading counts the cards beneath it. */}
            {bucketBShownCount}{' '}
            {bucketBShownCount === 1 ? 'Application Requires Review' : 'Applications Require Review'}
          </h2>
          <p className="queue__bucket-note">
            Flagged modifications or untraced claims requiring manual verification.
          </p>

          {/* Expanded, one after another, open by default: a row that must be read
              starts in front of the operator. Each can be folded by hand (2026-11-02). */}
          <ul className="queue__list">
            {/* Shown rows first, in the view's order, then the filtered-out ones (2026-11-04). Keyed by
                id, so React keeps each row's DiffView (and its unsaved state) as it moves between them. */}
            {bucketB.map((diff) => {
              // Whether the toolbar's view hides this row; it stays mounted either way.
              const isFilteredOut = bucketBFilteredOut.has(diff.applicationId);
              // Whether the operator folded this row's review away; false until they click.
              const isFolded = foldedB.has(diff.applicationId);
              // Region id for the review disclosure, same builder shape as Bucket A's.
              const reviewId = `review-${diff.applicationId}`;
              // The snapshot behind this diff, for the rendered preview.
              const resume = resumes.get(diff.applicationId);
              // Whether this row's rendered resume is open.
              const isPreviewing = previewing.has(diff.applicationId);
              // Region id for the disclosure.
              const previewId = `preview-${diff.applicationId}`;
              return (
                <li
                  key={diff.applicationId}
                  className="queue__item"
                  /* The focus target after a save moved this row INTO Bucket B. The card, not its
                     heading: the heading is DiffView's, and the card is what this page renders. */
                  id={cardId(diff.applicationId)}
                  /* Focusable by script only; -1 keeps the card out of the Tab order. */
                  tabIndex={-1}
                  /* What a screen reader says on landing here: the same words as the card's title. */
                  aria-label={`${diff.jobTitle} at ${diff.companyName}`}
                  /* Focus lands here after a stale refusal; the description makes a screen reader read the
                     notice WITH the card's name, since a live region inserted already filled is not reliably spoken. */
                  aria-describedby={staleNotices.has(diff.applicationId) ? staleNoticeId(diff.applicationId) : undefined}
                  /* `hidden`, not unmounted, when the toolbar's view leaves it out: same reason as the fold
                     below. A hidden card cannot take focus, so a bucket-move focus never lands here. */
                  hidden={isFilteredOut}
                >
                  {/* A refused stale Approve, said at the TOP of the card the focus lands on. A status,
                      not an alert: nothing failed, the operator just has newer words to read. */}
                  {staleNotices.get(diff.applicationId) !== undefined ? (
                    <p className="queue__stale-notice" id={staleNoticeId(diff.applicationId)} role="status" aria-live="polite">
                      {staleNotices.get(diff.applicationId)}
                    </p>
                  ) : null}
                  {/* THE ROW HEAD (2026-11-07), the same shape in both buckets: who and where on the left,
                      the row's one toolbar on the right, so every row's buttons share one right edge.
                      The title stays when the row opens, so the toolbar never jumps sideways. */}
                  <div className="queue__row">
                    <div className="queue__row-id">
                      {/* The job, in chrome type: the resume preview is the page's one paper-font element. */}
                      <p className="queue__row-title">{diff.jobTitle}</p>
                      {/* Company, then the board's own location when it gave one. */}
                      <p className="queue__row-meta">
                        {/* One text node, so the flex gap never splits "Company · place" apart. */}
                        {chipFacts.get(diff.applicationId)?.location ? `${diff.companyName} · ${chipFacts.get(diff.applicationId)?.location}` : diff.companyName}
                      </p>
                    </div>
                    {/* One toolbar per row, same order in both buckets: read it, see it, then ask the AI. A named
                        group so a screen reader says which job these three buttons act on. */}
                    <div className="queue__row-tools" role="group" aria-label={`${diff.jobTitle} at ${diff.companyName}`}>
                      <button
                        type="button"
                        className="button button--secondary"
                        /* Disclosure semantics, as in Bucket A: true while the review shows. */
                        aria-expanded={!isFolded}
                        aria-controls={reviewId}
                        onClick={() => {
                          // Pressing Review opens the review AND docks this row's chat beside it.
                          if (isFolded) openDock(diff.applicationId);
                          else {
                            // Hiding the review of the docked row closes its chat too: nothing left to chat beside.
                            toggle(setFoldedB, diff.applicationId);
                            if (dockId === diff.applicationId) setDockId(null);
                          }
                        }}
                      >
                        {/* Same words as Bucket A, so the action reads the same everywhere. */}
                        {isFolded ? 'Review' : 'Hide review'}
                      </button>
                      <button
                        type="button"
                        className="button button--secondary"
                        /* Disclosure semantics, as in Bucket A. */
                        aria-expanded={isPreviewing}
                        aria-controls={previewId}
                        onClick={() => toggle(setPreviewing, diff.applicationId)}
                      >
                        {/* Same words as Bucket A, so the action reads the same everywhere. */}
                        {isPreviewing ? 'Hide resume' : 'Preview resume'}
                      </button>
                      {/* Bucket B rows start open, so Review is not pressed: this docks the chat without folding.
                          aria-pressed: a toggle, so its state is announced, not only its words. */}
                      <button
                        type="button"
                        className="button button--secondary"
                        aria-pressed={dockId === diff.applicationId}
                        onClick={() => toggleDock(diff.applicationId)}
                      >
                        {dockId === diff.applicationId ? 'Close chat' : 'Chat with AI'}
                      </button>
                    </div>
                  </div>
                  {/* Fit, ATS score and the pay-band warning, shown folded or open: DiffView shows only the ATS
                      badge, so the others would vanish when a row opens. */}
                  <QueueRowChips diff={diff} facts={chipFacts.get(diff.applicationId)} />
                  {/* THE RESUME, above the audit (2026-11-07): read the document first, then the audit and its
                      Approve/Reject bar, which DiffView ends with, so the decision is always the last block.
                      Opened on demand because it is tall; outside the fold, so it shows folded or open. */}
                  {isPreviewing && resume ? (
                    <div id={previewId} className="queue__detail">
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
                  {/* `hidden`, NOT a conditional mount: unmounting would drop the AI chat, a
                      half-typed edit and the row's attestations. Bucket A can unmount because
                      its rows open fresh; a Bucket B row may be mid-review when folded. */}
                  <div id={reviewId} hidden={isFolded}>
                  <DiffView
                    /* The row's diff with its job description laid over once loaded (withJobDescription). */
                    diff={withJobDescription(diff)}
                    /* The shared approval path; see approveReviewed for why the
                       decisions are forwarded and how they are serialised. */
                    onApprove={(decisions, acknowledged) => approveReviewed(diff.applicationId, decisions, 'bucket_b_review', acknowledged)}
                    /* The held re-check for this row (2026-11-05), shown above Approve; undefined when nothing is held. */
                    approveHold={approveHolds.get(diff.applicationId)?.hold}
                    /* The shared rejection path; see rejectReviewed. */
                    onReject={(reason) => rejectReviewed(diff.applicationId, reason)}
                    /* Saves for real; see editRow. */
                    onEdit={(action, editSource) => editRow(diff.applicationId, action, editSource)}
                    /* T10: the AI chat's atomic batch save (a swap is judged on its end state); see editRows. */
                    onEditBatch={(actions, editSource) => editRows(diff.applicationId, actions, editSource)}
                    /* D4: only when the tailor's original could not be rebuilt. */
                    editDisabledReason={editOffReason(sources.get(diff.applicationId))}
                    /* So the diff can say the letter predates the edits. */
                    hasCoverLetter={sources.get(diff.applicationId)?.hasCoverLetter === true}
                    /* Locks edits and Approve while this row's approve/reject is in flight. */
                    locked={settling.has(diff.applicationId)}
                    /* The pinned master's groups, so a missing keyword can be vouched for and printed in one. */
                    attestCategories={skillGroups(sources.get(diff.applicationId))}
                    /* The AI box's ask; its proposals come back through onEdit like any hand edit. */
                    onAssist={(body) => requestAssist(supabase, body)}
                    /* Where the chat keeps its chats; undefined when not connected. */
                    chat={chatStore}
                    /* The chat renders in the right-hand dock, and only while it is THIS row's turn. */
                    chatDock={{ node: dockNode, active: dockId === diff.applicationId }}
                    /* Finding N2's warning, from the same facts as the row chip, so the card and the row agree. */
                    payBandWarning={chipFacts.get(diff.applicationId)?.payBand ?? null}
                  />
                  </div>
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
                <li
                  key={diff.applicationId}
                  className="queue__clean-row queue__clean-row--openable"
                  /* The focus target after a save moved this row BACK into Bucket A; same builder as Bucket B. */
                  id={cardId(diff.applicationId)}
                  /* Script-focusable only, as in Bucket B. */
                  tabIndex={-1}
                  /* Same accessible name as the Bucket B card, so the row is announced the same either side. */
                  aria-label={`${diff.jobTitle} at ${diff.companyName}`}
                  /* Focus lands here after a stale refusal; the description makes a screen reader read the
                     notice WITH the card's name, since a live region inserted already filled is not reliably spoken. */
                  aria-describedby={staleNotices.has(diff.applicationId) ? staleNoticeId(diff.applicationId) : undefined}
                >
                  {/* Same notice as Bucket B, at the top of the row so it shows even with Review closed. */}
                  {staleNotices.get(diff.applicationId) !== undefined ? (
                    <p className="queue__stale-notice" id={staleNoticeId(diff.applicationId)} role="status" aria-live="polite">
                      {staleNotices.get(diff.applicationId)}
                    </p>
                  ) : null}
                  {/* The same row head as Bucket B (2026-11-07). No source badge and no master-version tag any
                      more (Teja: slim cards); the audit badge stays, on the meta line, so it lines up
                      under the title instead of floating between buttons. */}
                  <div className="queue__row">
                    <div className="queue__row-id">
                      {/* Chrome type, as in Bucket B. */}
                      <p className="queue__row-title">{diff.jobTitle}</p>
                      {/* Company, the board's location when known, then the audit verdict. */}
                      <p className="queue__row-meta">
                        {/* One text node, so the flex gap never splits "Company · place" apart. */}
                        {chipFacts.get(diff.applicationId)?.location ? `${diff.companyName} · ${chipFacts.get(diff.applicationId)?.location}` : diff.companyName}
                        {/* Every Bucket A row is audit-clean by definition (deriveBucket); the badge says so. */}
                        {/* Plain words, matching DiffView's facts line; the status keeps the colour. */}
                        <StatusBadge status="audit_clean" label="Verified" />
                      </p>
                    </div>
                    {/* Bucket B's toolbar, same order and size. */}
                    <div className="queue__row-tools" role="group" aria-label={`${diff.jobTitle} at ${diff.companyName}`}>
                      <button
                        type="button"
                        className="button button--secondary"
                        /* aria-expanded is what tells a screen reader this is a disclosure. */
                        aria-expanded={isReviewing}
                        aria-controls={reviewId}
                        onClick={() => {
                          // Pressing Review opens the review AND docks this row's chat beside it.
                          if (!isReviewing) openDock(diff.applicationId);
                          else {
                            // Hiding the docked row's review closes its chat too: nothing left to chat beside.
                            toggle(setReviewing, diff.applicationId);
                            if (dockId === diff.applicationId) setDockId(null);
                          }
                        }}
                      >
                        {/* Says what opening does, and what closing does. */}
                        {isReviewing ? 'Hide review' : 'Review'}
                      </button>
                      <button
                        type="button"
                        className="button button--secondary"
                        /* Same disclosure semantics as Review. */
                        aria-expanded={isPreviewing}
                        aria-controls={previewId}
                        onClick={() => toggle(setPreviewing, diff.applicationId)}
                      >
                        {/* "resume", not "PDF": the PDF is one button further in. */}
                        {isPreviewing ? 'Hide resume' : 'Preview resume'}
                      </button>
                      {/* Last, as in Bucket B; a toggle, so its state is announced. */}
                      <button
                        type="button"
                        className="button button--secondary"
                        aria-pressed={dockId === diff.applicationId}
                        onClick={() => toggleDock(diff.applicationId)}
                      >
                        {dockId === diff.applicationId ? 'Close chat' : 'Chat with AI'}
                      </button>
                    </div>
                  </div>
                  {/* The same chips as Bucket B, on their own wrapping line under the head. */}
                  <QueueRowChips diff={diff} facts={chipFacts.get(diff.applicationId)} />

                  {/* The submitted document itself, ABOVE the audit, as in Bucket B: the decision bar that
                      DiffView ends with stays the last block of the row. A missing snapshot cannot happen
                      (rows without one are refused above), but if it did, saying so beats an empty frame. */}
                  {isPreviewing ? (
                    <div id={previewId} className="queue__detail">
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

                  {/* The full comparison, identical to Bucket B's, approving through
                      the same RPC path. Only mounted when open: thirty diffs rendered
                      hidden would cost the whole page for rows nobody opened. */}
                  {isReviewing ? (
                    <div id={reviewId} className="queue__detail">
                      <DiffView
                        /* Same overlay as Bucket B: the AI chat unlocks once the description is in. */
                        diff={withJobDescription(diff)}
                        /* Same path as Bucket B, tagged so the audit log shows this
                           clean row was opened and read, not batch-approved. */
                        onApprove={(decisions, acknowledged) => approveReviewed(diff.applicationId, decisions, 'bucket_a_review', acknowledged)}
                        /* Same hold slot as Bucket B; a Bucket A row is unedited, so it stays empty unless an edit moves it. */
                        approveHold={approveHolds.get(diff.applicationId)?.hold}
                        /* Same rejection edge as Bucket B. */
                        onReject={(reason) => rejectReviewed(diff.applicationId, reason)}
                        /* Same save path as Bucket B; an edit moves the row there (R2). */
                        onEdit={(action, editSource) => editRow(diff.applicationId, action, editSource)}
                    /* T10: the AI chat's atomic batch save (a swap is judged on its end state); see editRows. */
                    onEditBatch={(actions, editSource) => editRows(diff.applicationId, actions, editSource)}
                        /* D4, as in Bucket B. */
                        editDisabledReason={editOffReason(sources.get(diff.applicationId))}
                        /* Cover-letter note, as in Bucket B. */
                        hasCoverLetter={sources.get(diff.applicationId)?.hasCoverLetter === true}
                        /* Same lock as Bucket B, including during the batch. */
                        locked={settling.has(diff.applicationId)}
                        /* Same vouch-and-add groups as Bucket B. */
                        attestCategories={skillGroups(sources.get(diff.applicationId))}
                        /* Same AI box as Bucket B. */
                        onAssist={(body) => requestAssist(supabase, body)}
                        /* Where the chat keeps its chats; undefined when not connected. */
                        chat={chatStore}
                        /* Same dock as Bucket B: this row's chat shows only while it is the docked one. */
                        chatDock={{ node: dockNode, active: dockId === diff.applicationId }}
                        /* Finding N2's warning, from the same facts as the row chip, as in Bucket B. */
                        payBandWarning={chipFacts.get(diff.applicationId)?.payBand ?? null}
                      />
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
                /* Only the rows the toolbar shows (2026-11-04): bucketA is split from the view's output,
                   so the count on this button is exactly what it sends, and a hidden row is never
                   approved unseen. */
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
      {/* THE DOCK. Rendered only for a row still on the page; it is the portal target of that row's chat. The
          header names the job so the operator always sees which resume this chat edits. */}
      {dockDiff !== undefined ? (
        <aside className="queue__dock" aria-label="AI resume chat dock">
          <h2 className="queue__dock-title">
            {dockDiff.jobTitle} at {dockDiff.companyName}
          </h2>
          <div ref={setDockNode} className="queue__dock-body" />
        </aside>
      ) : null}
      </div>
    </div>
    </BatchPreviewContext.Provider>
    </OverflowPreviewContext.Provider>
  );
}
