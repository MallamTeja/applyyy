/* "Left your queue" (2026-11-07): the jobs Teja approved that are no longer in a live lane and were not
 * applied, with who moved them and why. The data half of the section: the types are its contract with the pure
 * view (LeftQueueSection.tsx), and this file owns the read (loadLeftQueue), the parse (parseLeftQueue) and the one
 * status rule (reopenTarget). ManualApplyPage.tsx wires them together; the Re-open write itself goes through
 * useRecoveryMoves / advance_application_status, never from here. */

// Type only: the status union.
import type { ApplicationStatus } from '../../data/contract';

/* One row of the section. */
export interface LeftQueueRow {
  // The application id.
  readonly id: string;
  // Its CURRENT status (anything outside approved/applying/needs_verification/blocked_needs_human/applied).
  readonly status: ApplicationStatus;
  // "Title at Company", as the other Manual apply cards say it.
  readonly label: string;
  // The job's apply URL, UNTRUSTED (safeHref at render); null when absent.
  readonly applyUrl: string | null;
  // updated_at exactly as returned: the stale-stamp guard of the Re-open move (never parsed).
  readonly stamp: string;
  // When the row was last approved (newest status_change to 'approved'), raw, for display after a shape check.
  readonly approvedAt: string | null;
  // The newest status_change event whose to_status equals the current status: how the row got where it is. Raw time.
  readonly leftAt: string | null;
  // That event's from_status (null when no such event could be read).
  readonly leftFrom: ApplicationStatus | null;
  // That event's agent: 'human', 'applier', 'matcher', ... (null when unreadable). 'human' is also a script under Teja's JWT.
  readonly actor: string | null;
  // The paired note's detail.source ("manual_apply", "health_recovery", a retro script name), or null.
  readonly source: string | null;
  // The paired note's detail.stage (retro_liveness_2026_11_05 ...), or null.
  readonly stage: string | null;
  // A short machine reason code (detail.reason: posting_stale, unanswerable_question ...), or null.
  readonly code: string | null;
  // The human sentence (detail.detail), or null; shown as the reason line.
  readonly reason: string | null;
}

/* The section's read state, same three honest states as the page. */
export type LeftQueueRead =
  | { readonly kind: 'loading' }
  | { readonly kind: 'error'; readonly message: string }
  | { readonly kind: 'ready'; readonly rows: readonly LeftQueueRow[] };

/* The statuses that mean "still live or done": a row at one of these is NOT in the section. */
export const LIVE_OR_DONE_STATUSES: readonly ApplicationStatus[] = ['approved', 'applying', 'needs_verification', 'blocked_needs_human', 'applied'];

// The page's shared client; null when the build has no Supabase config.
import { supabase } from '../../data/supabase';
// Runtime list of real statuses, for the shape check on each row.
import { APPLICATION_STATUSES } from '../../data/contract';
// The web's own graph: what a human may do, and which of those moves are held back.
import { heldReason, screenMoves } from '../../data/humanLanes';
// The row label the other Manual apply cards use, so all screens name a job alike.
import { rowLabel } from '../health/RecoveryQueue';

// A Set for the status membership test.
const KNOWN: ReadonlySet<string> = new Set(APPLICATION_STATUSES);
// The only shape an application id has; anything else never reaches an `in` filter.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Bounds the applications read; far above the real count (13 at 2026-11-07).
const READ_CAP = 200;
// Bounds the events read: a few events per application, so 1000 covers READ_CAP rows with room.
const EVENTS_CAP = 1000;
// The applications read's columns, with the inner-joined approve events. Exported so the test pins it.
export const LEFT_QUEUE_APPS_SELECT = 'id, status, updated_at, jobs:job_id(title, company_name, apply_url), application_events!inner(created_at)';
// The events read's columns: all the parse needs to pair a change with its note. Exported for the test.
export const LEFT_QUEUE_EVENTS_SELECT = 'application_id, event_type, agent, from_status, to_status, created_at, detail';

/* The status a Re-open sends a row to, or null when it offers no button. failed -> needs_verification only. */
export function reopenTarget(status: ApplicationStatus): ApplicationStatus | null {
  // The one move we want to offer.
  const target: ApplicationStatus = 'needs_verification';
  // Only failed gets it; every other status (dropped_filter included) gets no button.
  if (status !== 'failed') return null;
  // Re-check against the graph, so a future edge change cannot silently make the button wrong.
  return screenMoves(status).includes(target) && heldReason(status, target) === null ? target : null;
}

/* A non-empty string or null: the only shape a note field is trusted in. */
function text(v: unknown): string | null {
  // Numbers, empty strings, objects and null all read as "not said".
  return typeof v === 'string' && v !== '' ? v : null;
}

/* True when timestamp a is strictly later than b; unparseable stamps never win, so the first seen stays. */
function isLater(a: string, b: string): boolean {
  // Parsed only to compare; the raw string is what gets kept.
  const pa = Date.parse(a);
  // Same for the other side.
  const pb = Date.parse(b);
  // NaN on either side means no ordering can be proven.
  return Number.isFinite(pa) && Number.isFinite(pb) && pa > pb;
}

/* Pure parse of the two reads into rows. `apps`: applications with embedded jobs and an inner-joined
 * approved event; `events`: application_events rows (status_change and note) for those ids. */
export function parseLeftQueue(apps: unknown, events: unknown): readonly LeftQueueRow[] {
  // Not a list: nothing to show, never a guess.
  if (!Array.isArray(apps)) return [];
  // The status_change events per application id.
  const changes = new Map<string, Record<string, unknown>[]>();
  // The notes keyed by application id + exact created_at (same transaction as their change).
  const notes = new Map<string, Record<string, unknown>>();
  // A bad events value just means no event facts.
  for (const e of Array.isArray(events) ? events : []) {
    // Skip non-objects.
    if (typeof e !== 'object' || e === null) continue;
    // Loose read, then each field proven below.
    const ev = e as Record<string, unknown>;
    // Both keys are required to place an event.
    if (typeof ev.application_id !== 'string' || typeof ev.created_at !== 'string') continue;
    // A note is indexed by its pairing key.
    if (ev.event_type === 'note') notes.set(`${ev.application_id}|${ev.created_at}`, ev);
    // A status_change is collected per application.
    else if (ev.event_type === 'status_change') changes.set(ev.application_id, [...(changes.get(ev.application_id) ?? []), ev]);
  }
  // The rows that prove their shape.
  const rows: LeftQueueRow[] = [];
  // One pass over the applications.
  for (const a of apps) {
    // Loose read of the row.
    const r = a as { id?: unknown; status?: unknown; updated_at?: unknown; jobs?: unknown; application_events?: unknown } | null;
    // A row with a bad id, an unknown status or no stamp cannot be acted on safely: skipped, not guessed.
    if (typeof r !== 'object' || r === null || typeof r.id !== 'string' || !UUID.test(r.id) || typeof r.status !== 'string' || !KNOWN.has(r.status) || typeof r.updated_at !== 'string') continue;
    // The newest approve time, raw string kept.
    let approvedAt: string | null = null;
    // Walk the embedded approve events.
    for (const x of Array.isArray(r.application_events) ? r.application_events : []) {
      // Only a string created_at counts.
      const t = (x as { created_at?: unknown } | null)?.created_at;
      // First string seen, or a provably later one.
      if (typeof t === 'string' && (approvedAt === null || isLater(t, approvedAt))) approvedAt = t;
    }
    // The newest change whose to_status is the row's current status: how it got here.
    let left: Record<string, unknown> | null = null;
    // Walk this application's changes.
    for (const c of changes.get(r.id) ?? []) {
      // A change into some other status is not the exit.
      if (c.to_status !== r.status) continue;
      // First match, or a provably newer one (created_at is a string, proven when indexed).
      if (left === null || isLater(c.created_at as string, left.created_at as string)) left = c;
    }
    // The note from the same transaction, found by the exact created_at string.
    const pairedNote = left === null ? undefined : notes.get(`${r.id}|${left.created_at as string}`);
    // Its detail, when an object.
    const d = (typeof pairedNote?.detail === 'object' && pairedNote.detail !== null ? pairedNote.detail : {}) as Record<string, unknown>;
    // The job embed, tolerating the to-many array shape like manualApplyData does.
    const job = (Array.isArray(r.jobs) ? r.jobs[0] : r.jobs) as { apply_url?: unknown } | null | undefined;
    // The from_status, only when it is a real status.
    const from = typeof left?.from_status === 'string' && KNOWN.has(left.from_status) ? (left.from_status as ApplicationStatus) : null;
    // Shaped for the section.
    rows.push({
      // The proven id and status.
      id: r.id, status: r.status as ApplicationStatus,
      // Same label rule as the other cards.
      label: rowLabel(r.id, r.jobs),
      // Untrusted url, checked by safeHref at render.
      applyUrl: typeof job?.apply_url === 'string' ? job.apply_url : null,
      // The stale-stamp guard, never parsed.
      stamp: r.updated_at, approvedAt,
      // How it left.
      leftAt: left === null ? null : (left.created_at as string), leftFrom: from, actor: text(left?.agent),
      // Why it left, from the paired note only.
      source: text(d.source), stage: text(d.stage), code: text(d.reason), reason: text(d.detail),
    });
  }
  // Newest exit first; unknown times last. Array.sort is stable, so ties keep read order.
  return rows.sort((x, y) => {
    // Both unknown or both unparseable: keep order.
    if (x.leftAt === null && y.leftAt === null) return 0;
    // Unknown goes after known.
    if (x.leftAt === null) return 1;
    // Same, other side.
    if (y.leftAt === null) return -1;
    // Descending by time; an unparseable stamp compares as equal.
    return (Date.parse(y.leftAt) - Date.parse(x.leftAt)) || 0;
  });
}

/* The two reads, then the parse. Never throws; a failed read is { error }. */
export async function loadLeftQueue(): Promise<{ readonly rows: readonly LeftQueueRow[] } | { readonly error: string }> {
  // No client: a reported failure, not an empty section.
  if (supabase === null) return { error: 'Not connected to the database.' };
  // Approved-once rows now outside the live/done statuses; the inner join keeps only rows with an approve event.
  const apps = await supabase
    // Under RLS, own rows only.
    .from('applications')
    // The columns plus the embedded approve events.
    .select(LEFT_QUEUE_APPS_SELECT)
    // Not live, not done.
    .not('status', 'in', `(${LIVE_OR_DONE_STATUSES.join(',')})`)
    // Inner-join filter: only status_change events into approved.
    .eq('application_events.to_status', 'approved')
    // Same filter, the event kind.
    .eq('application_events.event_type', 'status_change')
    // Bounded.
    .limit(READ_CAP);
  // A failed read is said, never shown as "nothing left your queue".
  if (apps.error) return { error: apps.error.message || 'The left-queue jobs could not be read.' };
  // Ids that are real UUIDs, so nothing odd reaches the `in` filter.
  const ids = (Array.isArray(apps.data) ? apps.data : []).map((r: { id?: unknown }) => r.id).filter((id): id is string => typeof id === 'string' && UUID.test(id));
  // Nothing to explain: skip the second round trip.
  if (ids.length === 0) return { rows: [] };
  // The events that say how and why each one left.
  const evs = await supabase
    // The append-only log, under RLS.
    .from('application_events')
    // The pairing columns.
    .select(LEFT_QUEUE_EVENTS_SELECT)
    // Only these applications.
    .in('application_id', ids)
    // Newest first, so the cap keeps the useful end.
    .order('created_at', { ascending: false })
    // Bounded.
    .limit(EVENTS_CAP);
  // A failed read is said: rows without reasons would read as "no reason".
  if (evs.error) return { error: evs.error.message || 'The events could not be read.' };
  // Pure parse of both reads.
  return { rows: parseLeftQueue(apps.data, evs.data) };
}
