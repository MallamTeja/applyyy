/* Reads for the Manual apply page and its rail badge (2026-10-24).
 *
 * TWO SOURCES, ONE ROW SET. A job needs a manual apply when it sits in a manual-action lane
 * (needs_verification, blocked_needs_human) OR when the worker has written it a kit and it is still
 * open. Both reads key on application ids exactly; no text matching anywhere. supabase-js returns
 * { error } rather than throwing, so every read checks it and a failure is reported, never shown as
 * "nothing to do". */

// The page's shared client; null when the build has no Supabase config.
import { supabase } from '../../data/supabase';
// Type only: the client a test can pass in place of the module one.
import type { SupabaseClient } from '@supabase/supabase-js';
// Runtime list of real statuses, for the shape check on each row.
import { APPLICATION_STATUSES } from '../../data/contract';
// Type only: the status union.
import type { ApplicationStatus } from '../../data/contract';
// The two manual-action lanes, shared with the System health queues and the badge.
import { MANUAL_ACTION_STATUSES } from '../../data/humanLanes';
// The row label the recovery queues and their confirm dialogs use, so all screens name a job alike.
import { rowLabel } from '../health/RecoveryQueue';
// Kit parsing, newest-per-application selection, and which statuses a kit row still needs applying at.
import { isOpenKitStatus, newestKitStates } from './applyKit';
// Type only: the per-application kit state.
import type { KitState } from './applyKit';
// The tailored resume shape check the Applied page and pipeline drawer use, so every page agrees on "has a resume".
import { readResumeSnapshot } from '../pipeline/resumeSnapshot';
// Type only: the frozen render input ResumePreview takes.
import type { ResolvedResume } from '../../data/contract';

/* One job on the Manual apply page. */
export interface ManualApplyRow {
  // The application id: the exact key the kit and the resolves use.
  readonly id: string;
  // Its current status, already checked against APPLICATION_STATUSES.
  readonly status: ApplicationStatus;
  // "Title at Company", as the recovery queues say it.
  readonly label: string;
  // The job's own apply URL, UNTRUSTED (safeHref at render); the fallback when the kit has no form URL.
  readonly applyUrl: string | null;
  // updated_at exactly as returned: the stale-stamp guard of the card's Mark applied / Mark failed (never parsed).
  readonly stamp: string;
  // When the row was approved (applications.status_changed_at) for an `approved` row; null at any other
  // status. Raw, as returned: the card proves its shape before showing it ("Kit pending, approved <time>").
  readonly approvedAt: string | null;
  // The row's own tailored resume (applications.tailored_profile), shape-checked; null when it has none.
  // Read on the row, not from the kit, so the resume is on the card whether or not a kit exists (Teja, 2026-11-05).
  readonly resume: ResolvedResume | null;
  // The job's title and company, apart, for the resume preview's heading and its PDF filename; null when the job embed lacks them.
  readonly jobTitle: string | null;
  // Same, the company.
  readonly company: string | null;
  // applications.block_reason as returned (UNTRUSTED text; botCantApply.ts proves it against the enum), null when
  // absent. The card's "Bot can't apply" line reads it while the row is parked (2026-11-07). Null on a badge row.
  readonly blockReason: string | null;
  // jobs.ats_provider as returned, null when absent: the provider half of the Workday signal (a tenant fronted on
  // careers.company.com has no Workday host). Null on a badge row.
  readonly atsProvider: string | null;
}

// A Set for the status membership test.
const KNOWN: ReadonlySet<string> = new Set(APPLICATION_STATUSES);
// The only shape an application id has; anything else never reaches an `in` filter.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// The columns every application read needs; status_changed_at is the approve time of an approved row
// (the transition trigger sets it only when the status changes, so later edits do not move it).
// tailored_profile is the resume the card previews and prints (P1, 2026-11-05). block_reason and the job's
// ats_provider feed the card's "Bot can't apply" line (2026-11-07). Exported for the test that pins it.
export const ROW_SELECT = 'id, status, updated_at, status_changed_at, block_reason, tailored_profile, jobs:job_id(title, company_name, apply_url, ats_provider)';
// The rail badge only counts rows, so it skips the tailored_profile jsonb (every cold load pays for this read, 420dc2d).
export const BADGE_ROW_SELECT = 'id, status, updated_at, status_changed_at, jobs:job_id(title, company_name, apply_url)';
// Bounds every read; far above any real manual queue, so it only stops a pathological table.
const READ_CAP = 200;

/* One raw application row, validated, or null. Exported so the test proves the resume and job fields map. */
export function parseRow(raw: unknown): ManualApplyRow | null {
  // Loose read, then proven.
  const r = raw as { id?: unknown; status?: unknown; updated_at?: unknown; status_changed_at?: unknown; block_reason?: unknown; tailored_profile?: unknown; jobs?: unknown } | null;
  // An id, a known status and the stamp are required; a row without them cannot be resolved safely.
  if (typeof r?.id !== 'string' || typeof r.status !== 'string' || !KNOWN.has(r.status) || typeof r.updated_at !== 'string') return null;
  // The joined job, tolerating the to-many array shape like rowLabel does.
  const job = (Array.isArray(r.jobs) ? r.jobs[0] : r.jobs) as { apply_url?: unknown; title?: unknown; company_name?: unknown; ats_provider?: unknown } | null | undefined;
  // The approve time: meaningful only while the row sits at approved (at other statuses it is when THAT status began).
  const approvedAt = r.status === 'approved' && typeof r.status_changed_at === 'string' ? r.status_changed_at : null;
  // Shaped for the card.
  return { id: r.id, status: r.status as ApplicationStatus, label: rowLabel(r.id, r.jobs), applyUrl: typeof job?.apply_url === 'string' ? job.apply_url : null, stamp: r.updated_at, approvedAt, resume: readResumeSnapshot(r.tailored_profile), jobTitle: typeof job?.title === 'string' ? job.title : null, company: typeof job?.company_name === 'string' ? job.company_name : null, blockReason: typeof r.block_reason === 'string' ? r.block_reason : null, atsProvider: typeof job?.ats_provider === 'string' ? job.ats_provider : null };
}

/* The kit events, newest first, as one exact-filtered read. */
async function readKitEvents(client: SupabaseClient | null): Promise<{ readonly states: ReadonlyMap<string, KitState> } | { readonly error: string }> {
  // No client: a reported failure, not an empty page.
  if (client === null) return { error: 'Not connected to the database.' };
  // Notes of kind apply_kit or apply_kit_skipped, newest first: the newest of the two decides the card.
  const { data, error } = await client
    // The append-only log, under RLS ("read own events").
    .from('application_events')
    // The join key, the ordering timestamp, the payload.
    .select('application_id, created_at, detail')
    // Kits are written as notes.
    .eq('event_type', 'note')
    // Of these two kinds only (a JSON path filter, evaluated by PostgREST). The skip note is read so a
    // row whose kit the worker refused says why, instead of "Kit pending" forever (2026-11-05).
    .in('detail->>kind', ['apply_kit', 'apply_kit_skipped'])
    // Newest first, so the cap keeps the useful end.
    .order('created_at', { ascending: false })
    // Bounded.
    .limit(READ_CAP);
  // A failed read is said.
  if (error) return { error: error.message || 'The kits could not be read.' };
  // Newest valid-or-unreadable state per application.
  return { states: newestKitStates(data) };
}

/* Applications by status (the two lanes) or by id (kit rows), with the caller's column list (page or badge). */
async function readRows(client: SupabaseClient | null, select: string, filter: { readonly statuses: readonly ApplicationStatus[] } | { readonly ids: readonly string[] }): Promise<{ readonly rows: readonly ManualApplyRow[] } | { readonly error: string }> {
  // No client: reported.
  if (client === null) return { error: 'Not connected to the database.' };
  // An empty id list asks for nothing; skip the round trip.
  if ('ids' in filter && filter.ids.length === 0) return { rows: [] };
  // The base read.
  const base = client.from('applications').select(select);
  // Lanes by status, kit rows by exact id.
  const { data, error } = await ('statuses' in filter ? base.in('status', [...filter.statuses]) : base.in('id', [...filter.ids]))
    // Longest-waiting first, as on System health.
    .order('updated_at', { ascending: true })
    // Bounded.
    .limit(READ_CAP);
  // A failed read is said.
  if (error) return { error: error.message || 'The applications could not be read.' };
  // Only rows that prove their shape.
  return { rows: (data ?? []).map(parseRow).filter((r: ManualApplyRow | null): r is ManualApplyRow => r !== null) };
}

/* The page's row list from its three reads: lanes first (the urgent ones), then every approved row, then
 * the other open kit rows; each application once. Pure, so the "approved row never hidden" rule is
 * tested without a database (test/manualApplyKitPending.test.ts).
 *
 * WHY APPROVED ROWS ARE READ ON THEIR OWN (2026-11-05). The page used to list only lane rows and rows
 * that already had a kit. dispatch-apply starts the kit workflow on approve (5c3ce87), so for the
 * minutes until the kit lands an approved row was in neither set and the page showed "Nothing to apply
 * by hand" over 5 approved jobs. An approved row is now listed with or without its kit ("Kit pending"). */
export function mergeManualApplyRows(reads: {
  // Rows in the two manual-action lanes.
  readonly lanes: readonly ManualApplyRow[];
  // Every approved row, kit or not.
  readonly approved: readonly ManualApplyRow[];
  // Rows that have a kit, at any status.
  readonly kitRows: readonly ManualApplyRow[];
}): readonly ManualApplyRow[] {
  // Lanes, then approved, then kit rows (a kit row past the submit stage needs nothing more, so it is left
  // out). Keyed by id so a row from two reads is listed once: a Map keeps the FIRST insertion's position,
  // which is the most urgent placement (both copies are the same database row).
  return [...new Map([...reads.lanes, ...reads.approved, ...reads.kitRows.filter((k) => isOpenKitStatus(k.status))].map((r) => [r.id, r] as const)).values()];
}

/* Everything the page shows: the rows (see mergeManualApplyRows) and each one's kit state. The rail
 * badge (AppShell) calls this same loader and counts its rows, so badge and page cannot drift. */
/* `purpose` is required, so no caller gets the cheap badge read by accident: the page needs the resumes,
 * the badge needs only the count (a badge row's resume is null). */
/* `client` defaults to the app's one client; the parameter exists so a node test can pass a recording fake
 * and prove the read ORDER below (test/manualApplyLoadOrder.test.ts). */
export async function loadManualApply(purpose: 'page' | 'badge', client: SupabaseClient | null = supabase): Promise<{ readonly rows: readonly ManualApplyRow[]; readonly kits: ReadonlyMap<string, KitState> } | { readonly error: string }> {
  // The column list for this caller.
  const select = purpose === 'page' ? ROW_SELECT : BADGE_ROW_SELECT;
  /* TWO ROUNDS, NOT THREE (2026-11-08). Only the kit-row read needs the kit ids; the two status reads
     need nothing, so they start WITH the kit events instead of after them. That saves one serial round
     trip (~0.3 s from India to the Sydney project) on every badge read and every page load. Approved rows
     are read by status, so one whose kit has not landed yet is still listed (as "Kit pending"). */
  const [kits, lanes, approved] = await Promise.all([readKitEvents(client), readRows(client, select, { statuses: MANUAL_ACTION_STATUSES }), readRows(client, select, { statuses: ['approved'] })]);
  // A failed kit read fails the page: showing rows without kits would read as "no kits generated".
  if ('error' in kits) return kits;
  // Either failing is said; checked before the kit-row read so a failed load spends no third round trip.
  if ('error' in lanes) return lanes;
  // Same for the approved rows: a failed read must not look like "no approved jobs".
  if ('error' in approved) return approved;
  // Kit ids that are real application ids.
  const kitIds = [...kits.states.keys()].filter((id) => UUID.test(id));
  // The one read that needs the kits: the rows they belong to (skipped, no round trip, when there are none).
  const kitRows = await readRows(client, select, { ids: kitIds });
  // Same for the kit rows.
  if ('error' in kitRows) return kitRows;
  // One list, each row once, lanes first.
  return { rows: mergeManualApplyRows({ lanes: lanes.rows, approved: approved.rows, kitRows: kitRows.rows }), kits: kits.states };
}
