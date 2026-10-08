/* THE ONE WRITE PATH for an operator's edit to a tailored resume (task 8, 2026-10-06).
 *
 * Two writes, in a fixed order, and the order is the point:
 *   1. the resume itself (applications.tailored_profile) - the thing the worker will submit;
 *   2. a note in application_events - the permanent record of who changed which words.
 * The resume goes first because it is the write that matters to the operator. If the note
 * then fails, the edit IS saved and the caller is told exactly that, never "it failed".
 *
 * THIS FUNCTION NEVER THROWS (contract v2, fix 1). A thrown save used to leave the page showing
 * one resume while the database held another. Every path ends in a SaveOutcome, and when the
 * write's fate is unknown it re-reads the row and hands back what is actually stored.
 *
 * Kept out of the page so the guards below sit in one function every edit crosses, and so a
 * test can drive it with a fake client instead of a browser. */

import type { MasterProfile, ResolvedResume } from '../../data/contract';
// Builder-1's pure module: one definition of "a resume", and R0 enforced at the write boundary.
import { deepEqual, isResumeShape, onlyTextChanged } from './tailoredEdits';

/* Closed union, so the event log can only ever name one of five operator actions. The two skill
   kinds (T3) record a selection change: the event ref is the MASTER skill's id and before/after
   carry its name, so the log alone says which skill went on or came off. */
export type EditEventKind = 'resume_edit' | 'resume_remove' | 'resume_reset' | 'resume_add_skill' | 'resume_remove_skill';

/* What the database holds NOW, read back after an unknown or refused write. */
export interface StoredRow {
  // Unknown on purpose: the caller must shape-check it before adopting it.
  readonly resume: unknown;
  // The row's current concurrency stamp.
  readonly updatedAt: string;
  // So the caller can tell "edited elsewhere" from "approved elsewhere".
  readonly status: string;
}

/* Every way a save can end. A closed union, so the page must handle each reason by name. */
export type SaveOutcome =
  // Saved; updatedAt is the NEW stamp the next edit must present.
  | { readonly ok: true; readonly eventRecorded: boolean; readonly updatedAt: string }
  | {
      readonly ok: false;
      readonly reason: 'invalid_resume_shape' | 'not_text_only' | 'changed_elsewhere' | 'unconfirmed' | 'error';
      // Said for a person; the page shows it verbatim.
      readonly message: string;
      // Present on 'unconfirmed', and on 'changed_elsewhere' when the re-read works.
      readonly stored?: StoredRow;
    };

/* Typed as `any` on purpose: supabase-js's builder generics differ between the real client and a
   test double, and this function only touches the chained methods it names below. */
type MinimalClient = { from(table: string): any };

/* Re-read the row after a write whose effect is unknown or refused. Never throws: a failed
   re-read just means there is nothing to adopt. */
async function readBack(client: MinimalClient, applicationId: string): Promise<StoredRow | undefined> {
  try {
    // The three things the page needs to show the truth.
    const { data, error } = await client
      .from('applications')
      .select('tailored_profile, updated_at, status')
      .eq('id', applicationId)
      .maybeSingle();
    // No row or no answer: nothing trustworthy to adopt.
    if (error || data === null || data === undefined || typeof data.updated_at !== 'string') return undefined;
    // What the database holds, unvalidated; the page shape-checks before adopting.
    return { resume: data.tailored_profile, updatedAt: data.updated_at, status: String(data.status) };
  } catch {
    // A throwing re-read is the same as no re-read.
    return undefined;
  }
}

/* Fixes 2/3 (cross-tab): one row's freshness, read right before its approve RPC. */
export type FreshCheck =
  // Same stamp, still in review: the diff the operator saw is the one being approved.
  | { readonly kind: 'fresh' }
  // Moved on; `stored` is what is there now, absent when the row is gone or invisible.
  | { readonly kind: 'changed'; readonly stored?: StoredRow }
  // No trustworthy answer: the caller must not approve on it, and must not call it "changed" either.
  | { readonly kind: 'unverifiable' };

export async function confirmFresh(client: MinimalClient, applicationId: string, expectedUpdatedAt: string): Promise<FreshCheck> {
  /* Not built on readBack: readBack folds "error" and "no row" into one undefined, and here they
     mean opposite things - no row is a definite "changed", an error is "we do not know". */
  try {
    // The same three columns readBack takes, so a 'changed' carries an adoptable StoredRow.
    const { data, error } = await client
      // The row the approve RPC is about to move.
      .from('applications')
      // The stamp and status decide freshness; the resume rides along for adoption.
      .select('tailored_profile, updated_at, status')
      // This one row only: the batch checks each row right before its own RPC.
      .eq('id', applicationId)
      // A missing row is data: null, not an error, so "gone" stays distinct from "unknown".
      .maybeSingle();
    // Any error, a status-0 network drop included: no answer can vouch for the row.
    if (error) return { kind: 'unverifiable' };
    // No error and no row: it is gone, or RLS no longer shows it. Either way, not approvable as seen.
    if (data === null || data === undefined) return { kind: 'changed' };
    // A malformed stamp must not compare unequal (false "changed") or be trusted (false "fresh").
    if (typeof data.updated_at !== 'string') return { kind: 'unverifiable' };
    // Shaped once, for the 'changed' answer below.
    const stored: StoredRow = { resume: data.tailored_profile, updatedAt: data.updated_at, status: String(data.status) };
    // Either a status move or a newer write means the shown diff is not the stored one.
    if (stored.status !== 'awaiting_approval' || stored.updatedAt !== expectedUpdatedAt) return { kind: 'changed', stored };
    // Only an exact stamp match, still in review, licenses the approval.
    return { kind: 'fresh' };
  } catch {
    // A throwing client is the same as no answer, and this function is called mid-approval: never throw.
    return { kind: 'unverifiable' };
  }
}

/* Item 6 (2026-10-08): THE definition of "the request got no answer", shared by the save and by the
   page's approve/reject RPC so the two cannot drift. postgrest-js RETURNS a dropped fetch as
   {status: 0, error.code: ''} rather than throwing; any error without a SQLSTATE is not a database
   verdict either, so the write's fate is unknown and must be re-read, never reported as failed. */
export function isNoAnswer(status: unknown, error: { code?: unknown } | null | undefined): boolean {
  // Status 0 is the transport giving up before any HTTP response.
  if (status === 0) return true;
  // No error is an answer (success).
  if (error === null || error === undefined) return false;
  // A SQLSTATE is the database speaking; anything else is the network or a client bug.
  return typeof error.code !== 'string' || error.code === '';
}

/* Item 6: what a no-answer status transition actually did, read back from the row. A closed union,
   so the page handles each case by name: landed counts as done, not_landed is a safe retry,
   moved_elsewhere means another tab settled it, unknown is said as unknown. */
export type SettleCheck =
  // The row is at the status we asked for: our call (or an identical one) went through.
  | { readonly kind: 'landed' }
  // Still awaiting approval: nothing happened. Carries the row, so a PT409 (stale stamp) can redraw it.
  | { readonly kind: 'not_landed'; readonly stored: StoredRow }
  // Some other status: not ours to count, and the page should show what is stored.
  | { readonly kind: 'moved_elsewhere'; readonly stored: StoredRow }
  // The re-read failed too; never guessed.
  | { readonly kind: 'unknown' };

// Never throws (readBack cannot), because it is awaited inside settle()'s locked per-row loop.
export async function confirmSettle(client: MinimalClient, applicationId: string, to: string): Promise<SettleCheck> {
  // The same never-throwing re-read the save uses.
  const stored = await readBack(client, applicationId);
  // Unreadable: say so rather than pick an answer.
  if (stored === undefined) return { kind: 'unknown' };
  // At the target status: done.
  if (stored.status === to) return { kind: 'landed' };
  // Untouched: the transition did not happen.
  if (stored.status === 'awaiting_approval') return { kind: 'not_landed', stored };
  // Anywhere else: someone else moved it.
  return { kind: 'moved_elsewhere', stored };
}

/* Item 4 (2026-10-08): the advance_application_status arguments, built in ONE pure place so a test
   can prove the stamp's bytes. Migration 20261008130000 added p_expected_updated_at: a stale stamp is
   refused with PT409 under the row lock, which closes the read-then-write window confirmFresh left.
   The stamp is the STRING PostgREST returned - Postgres compares timestamptz to the MICROSECOND and a
   JS Date keeps milliseconds, so one Date round-trip would make every gated approval stale. */
export function buildSettleArgs(
  // The row being moved.
  applicationId: string,
  // approved or dropped_filter, the two human edges out of awaiting_approval.
  to: 'approved' | 'dropped_filter',
  // What the record says about this decision.
  detail: Readonly<Record<string, unknown>>,
  // updated_at exactly as loaded or last saved; never parsed.
  stamp: string,
): Record<string, unknown> {
  // The fields every move carries; p_agent 'human' is what makes the approval edge legal at all.
  const args: Record<string, unknown> = { p_application_id: applicationId, p_to_status: to, p_agent: 'human', p_detail: detail };
  // Only approvals are gated: rejecting a row that changed elsewhere is still a legitimate decision,
  // and leaving the key out lets the RPC's DEFAULT NULL skip the check.
  if (to === 'approved') args['p_expected_updated_at'] = stamp;
  // Handed straight to supabase.rpc.
  return args;
}

/* Exported so the page and the tests share one wording, and so each branch's promise is checkable:
   a message that says "showing" or "reloaded" must only go out when there IS a stored row adopted. */
export const SAVE_MESSAGES = {
  // Outcome unknown, and the page is now showing what the re-read found.
  unconfirmedShown: "Couldn't confirm the save; showing the stored version.",
  // Outcome unknown AND the re-read failed: nothing was adopted, so say so and ask for a reload.
  unconfirmedUnread: "Couldn't confirm the save or read the stored version; reload before editing again.",
  // Known not to have landed; the page adopted the newer stored row.
  changedShown: 'Changed elsewhere; reloaded.',
  // Known not to have landed, but the re-read failed, so the page still shows the stale resume.
  changedUnread: "Changed elsewhere, and the stored version couldn't be read; reload the page.",
  // Known not to have landed because the row left review.
  notAwaiting: 'this application is no longer awaiting approval, so the edit was not saved.',
} as const;

/* Postgres/PostgREST errors in words an operator can act on. */
function errorMessage(error: { code?: unknown; message?: unknown }): string {
  // 42501 is RLS or the status guard refusing: the row is not editable by this user any more.
  if (error.code === '42501') return 'This application can no longer be edited.';
  // Anything else, in the database's own words.
  return typeof error.message === 'string' ? error.message : 'the save failed.';
}

/* The arguments of one save, named once because the event write and the unknown-outcome path
   need them too. */
type SaveArgs = {
  // The row whose resume is being replaced.
  applicationId: string;
  // The WHOLE new resume, already produced by applyTextEdit / removeBullet / resetTarget.
  resume: ResolvedResume;
  // The resume this edit was computed from, for the R0 boundary check.
  previous: ResolvedResume;
  // The tailor's own version, the ground truth for refs and master_text.
  original: ResolvedResume;
  // T3: the PINNED master, the only source an added skill may come from; required so the R0
  // check below can never run without it.
  master: MasterProfile;
  // The stamp the page last saw; the write lands only if nobody changed the row since.
  expectedUpdatedAt: string;
  // What the operator did, for the append-only log.
  event: { kind: EditEventKind; ref: string; before: string | null; after: string | null };
};

/* The history note, written once the resume is KNOWN stored. One function, so the success path
   and the "unconfirmed but landed" path cannot drift into two event shapes. */
async function recordEvent(client: MinimalClient, args: SaveArgs, updatedAt: string): Promise<SaveOutcome> {
  /* Same shape as the referral precedent (ReferralOutreachPage.tsx:197-208).
     user_id is left to its auth.uid() default, so the row lands in the caller's RLS tenant. */
  try {
    const { error: eventError } = await client.from('application_events').insert({
      // Which application the note belongs to.
      application_id: args.applicationId,
      // 'note': an operator action that is not a status transition.
      event_type: 'note',
      // A human typed this; no agent did.
      agent: 'human',
      // Before and after text, so the log alone can reconstruct what changed.
      detail: { kind: args.event.kind, ref: args.event.ref, before: args.event.before, after: args.event.after },
    });
    // The resume is saved either way; only whether the log caught it differs.
    return { ok: true, eventRecorded: !eventError, updatedAt };
  } catch {
    // A thrown insert does not un-save the resume; say only that the note is missing.
    return { ok: true, eventRecorded: false, updatedAt };
  }
}

/* The write's fate is unknown (a throw, or a returned error with no SQLSTATE). Never assume either
   way: read back what is stored and decide from THAT. */
async function resolveUnknown(client: MinimalClient, args: SaveArgs): Promise<SaveOutcome> {
  // The database's answer, since the write's own answer was lost.
  const stored = await readBack(client, args.applicationId);
  /* D4: our exact resume, still in review, means the write landed. Reporting "not saved" would
     leave the page showing a resume that is not the stored one, so finish the save properly. */
  if (stored !== undefined && stored.status === 'awaiting_approval' && deepEqual(stored.resume, args.resume)) {
    // The stored stamp is the one the next edit must present.
    return recordEvent(client, args, stored.updatedAt);
  }
  // Not ours, or unreadable: say unknown, and only claim to show a stored version when there is one.
  return {
    // Not claimed as saved.
    ok: false,
    // Distinct from 'error': the database may hold the edit, so the page must not say "refused".
    reason: 'unconfirmed',
    // D7a: "showing the stored version" is only true when a row was read and handed back.
    message: stored ? SAVE_MESSAGES.unconfirmedShown : SAVE_MESSAGES.unconfirmedUnread,
    // The page adopts this when present; absent means it keeps its own copy and asks for a reload.
    ...(stored ? { stored } : {}),
  };
}

export async function saveTailoredEdit(
  // The supabase client, or a fake with the same chain.
  client: MinimalClient,
  // Everything one edit needs; see SaveArgs.
  args: SaveArgs,
): Promise<SaveOutcome> {
  /* Validate the SHAPE before touching the network. A malformed object written here would be
     what the worker renders to PDF, so refusing locally is cheaper than any repair later. */
  if (!isResumeShape(args.resume)) {
    return { ok: false, reason: 'invalid_resume_shape', message: 'the edited resume was malformed, so nothing was sent.' };
  }
  /* R0 at the boundary (fix 5): only bullet text, the summary, removed/restored bullets and (T3)
     master skills added after the tailor's own may differ. A change to master_text would make an edit read as traced, so it never leaves here. */
  if (!onlyTextChanged(args.previous, args.resume, args.original, args.master)) {
    return { ok: false, reason: 'not_text_only', message: 'the edit changed more than text, so nothing was sent.' };
  }

  // The write's result, or the fact that it threw.
  let rows: unknown;
  // Supabase's returned error, if any.
  let updateError: { code?: unknown; message?: unknown } | null = null;
  // The HTTP status; 0 means no response arrived at all.
  let httpStatus: unknown;
  try {
    /* Three filters, each a different guard:
       - status: the FIRST of two layers keeping an edit from landing after approval. This one is
         app-level and turns a moved row into a clean 'changed_elsewhere' (0 rows); the database
         backstop is 3724d35's trigger freezing tailored_profile outside
         scored/audit_flagged/awaiting_approval, which would surface here as a refused write;
       - updated_at: optimistic concurrency (fix 2a). Compared on the stamp, NEVER on the JSON,
         which would hit URL-length limits as a query parameter;
       - select: returns the rows actually written, so they can be counted. */
    const result = await client
      .from('applications')
      .update({ tailored_profile: args.resume })
      .eq('id', args.applicationId)
      .eq('status', 'awaiting_approval')
      .eq('updated_at', args.expectedUpdatedAt)
      .select('id, updated_at');
    // Held for the checks below.
    rows = result.data;
    // supabase-js returns errors rather than throwing; unchecked, a refused write looks like success.
    updateError = result.error ?? null;
    // Kept so a dropped connection can be told apart from a refusal.
    httpStatus = result.status;
  } catch {
    // Thrown (aborted fetch, a client that does throw): the write may or may not have landed.
    return resolveUnknown(client, args);
  }

  /* D1: postgrest-js CATCHES a failed fetch and RETURNS it (status 0, code ''), so the catch above
     never sees a real network drop. No SQLSTATE means the database never answered: unknown, not refused. */
  const noAnswer = isNoAnswer(httpStatus, updateError);
  // Same path as a throw, so both shapes of "the answer was lost" re-read.
  if (noAnswer) return resolveUnknown(client, args);
  // A refused write with a SQLSTATE: the outcome is known, so no re-read; said in words.
  if (updateError) return { ok: false, reason: 'error', message: errorMessage(updateError) };

  /* Exactly one row is the only proof the write landed on the row the operator was looking at.
     Zero means the status or the stamp no longer matched: approved, rejected, or edited elsewhere. */
  const written = Array.isArray(rows) && rows.length === 1 ? (rows[0] as { updated_at?: unknown }) : null;
  if (written === null || typeof written.updated_at !== 'string') {
    // What is there now, so the page can stop showing a resume that is not stored.
    const stored = await readBack(client, args.applicationId);
    // Named so the page can reload the row; "reloaded" only when a row was actually read (D7a).
    return {
      // Known not to have landed.
      ok: false,
      // Distinct from 'unconfirmed': here 0 rows proves the edit is NOT stored.
      reason: 'changed_elsewhere',
      message:
        // Unreadable: nothing was adopted, so never say "reloaded".
        stored === undefined
          ? SAVE_MESSAGES.changedUnread
          // Left review: the operator needs to know editing is over, not just that it moved.
          : stored.status !== 'awaiting_approval'
            ? SAVE_MESSAGES.notAwaiting
            // Still in review, newer stamp: the page now shows that newer row.
            : SAVE_MESSAGES.changedShown,
      // Handed back only when read, so the page never adopts an undefined row.
      ...(stored ? { stored } : {}),
    };
  }
  // Landed and confirmed: record it under the NEW stamp the next edit must present.
  return recordEvent(client, args, written.updated_at);
}
