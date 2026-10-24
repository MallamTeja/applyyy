/* Reads for the Manual apply page and its rail badge (2026-10-24).
 *
 * TWO SOURCES, ONE ROW SET. A job needs a manual apply when it sits in a manual-action lane
 * (needs_verification, blocked_needs_human) OR when the worker has written it a kit and it is still
 * open. Both reads key on application ids exactly; no text matching anywhere. supabase-js returns
 * { error } rather than throwing, so every read checks it and a failure is reported, never shown as
 * "nothing to do". */

// The page's shared client; null when the build has no Supabase config.
import { supabase } from '../../data/supabase';
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
}

// A Set for the status membership test.
const KNOWN: ReadonlySet<string> = new Set(APPLICATION_STATUSES);
// The only shape an application id has; anything else never reaches an `in` filter.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// The columns both application reads need.
const ROW_SELECT = 'id, status, jobs:job_id(title, company_name, apply_url)';
// Bounds every read; far above any real manual queue, so it only stops a pathological table.
const READ_CAP = 200;

/* One raw application row, validated, or null. */
function parseRow(raw: unknown): ManualApplyRow | null {
  // Loose read, then proven.
  const r = raw as { id?: unknown; status?: unknown; jobs?: unknown } | null;
  // An id and a known status are required; a row without them cannot be resolved safely.
  if (typeof r?.id !== 'string' || typeof r.status !== 'string' || !KNOWN.has(r.status)) return null;
  // The joined job, tolerating the to-many array shape like rowLabel does.
  const job = (Array.isArray(r.jobs) ? r.jobs[0] : r.jobs) as { apply_url?: unknown } | null | undefined;
  // Shaped for the card.
  return { id: r.id, status: r.status as ApplicationStatus, label: rowLabel(r.id, r.jobs), applyUrl: typeof job?.apply_url === 'string' ? job.apply_url : null };
}

/* The kit events, newest first, as one exact-filtered read. */
async function readKitEvents(): Promise<{ readonly states: ReadonlyMap<string, KitState> } | { readonly error: string }> {
  // No client: a reported failure, not an empty page.
  if (supabase === null) return { error: 'Not connected to the database.' };
  // Notes of kind apply_kit only, newest first.
  const { data, error } = await supabase
    // The append-only log, under RLS ("read own events").
    .from('application_events')
    // The join key, the ordering timestamp, the payload.
    .select('application_id, created_at, detail')
    // Kits are written as notes.
    .eq('event_type', 'note')
    // Of this kind only (a JSON path filter, evaluated by PostgREST).
    .eq('detail->>kind', 'apply_kit')
    // Newest first, so the cap keeps the useful end.
    .order('created_at', { ascending: false })
    // Bounded.
    .limit(READ_CAP);
  // A failed read is said.
  if (error) return { error: error.message || 'The kits could not be read.' };
  // Newest valid-or-unreadable state per application.
  return { states: newestKitStates(data) };
}

/* Applications by status (the two lanes) or by id (kit rows), with the same select. */
async function readRows(filter: { readonly statuses: readonly ApplicationStatus[] } | { readonly ids: readonly string[] }): Promise<{ readonly rows: readonly ManualApplyRow[] } | { readonly error: string }> {
  // No client: reported.
  if (supabase === null) return { error: 'Not connected to the database.' };
  // An empty id list asks for nothing; skip the round trip.
  if ('ids' in filter && filter.ids.length === 0) return { rows: [] };
  // The base read.
  const base = supabase.from('applications').select(ROW_SELECT);
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

/* Everything the page shows: the rows (lanes first, then open kit rows) and each one's kit state. */
export async function loadManualApply(): Promise<{ readonly rows: readonly ManualApplyRow[]; readonly kits: ReadonlyMap<string, KitState> } | { readonly error: string }> {
  // The kits first: their ids decide which extra rows to read.
  const kits = await readKitEvents();
  // A failed kit read fails the page: showing rows without kits would read as "no kits generated".
  if ('error' in kits) return kits;
  // Kit ids that are real application ids.
  const kitIds = [...kits.states.keys()].filter((id) => UUID.test(id));
  // Both row reads in parallel; they are independent.
  const [lanes, kitRows] = await Promise.all([readRows({ statuses: MANUAL_ACTION_STATUSES }), readRows({ ids: kitIds })]);
  // Either failing is said.
  if ('error' in lanes) return lanes;
  // Same for the kit rows.
  if ('error' in kitRows) return kitRows;
  // Lane rows by id, so a kit row already in a lane is listed once.
  const seen = new Set(lanes.rows.map((r) => r.id));
  // Kit rows not already listed and still at a submit stage: a row past the submit needs nothing more.
  const extra = kitRows.rows.filter((r) => !seen.has(r.id) && isOpenKitStatus(r.status));
  // Lanes first (they are the urgent ones), then the open kit rows.
  return { rows: [...lanes.rows, ...extra], kits: kits.states };
}

/* The statuses of every application that has a kit, for the rail badge. A failure yields [] so the
 * badge falls back to the lane counts alone: an undercount the page itself corrects, never a made-up row. */
export async function loadKitRowStatuses(): Promise<readonly ApplicationStatus[]> {
  // The kits.
  const kits = await readKitEvents();
  // Unreadable: lanes only.
  if ('error' in kits) return [];
  // Their rows, by exact id.
  const rows = await readRows({ ids: [...kits.states.keys()].filter((id) => UUID.test(id)) });
  // Statuses only; a failed read counts nothing extra.
  return 'error' in rows ? [] : rows.rows.map((r) => r.status);
}
