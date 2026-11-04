/* The Applied jobs page's rules (asked for by Teja, approved 2026-11-04 20:20 IST): which rows show,
 * how they read, which stage moves each may make, and the timeline under each.
 *
 * WHY A PURE MODULE. Every rule here has a named test (test/appliedView.test.ts), and the page and
 * its counts read the SAME normalisation, so a filter and its count can never disagree. Same
 * pattern as approval/queueView.ts: closed unions, label Records, shape-checked readers.
 *
 * WHY EVERY READER IS A SHAPE CHECK. Missing data quietly becoming an answer is this repo's
 * dominant bug (CLAUDE.md section 6). An applied date that is junk is shown as "—", never as 1970
 * or today; an edge row without its actor list is dropped, never assumed human; a {} resume is no
 * resume. Live 2026-11-04: 2 rows at applied, 1 with a resume path, no emails matched, so the sparse
 * row is the normal row, not an edge case.
 *
 * WHY THE GRAPH IS READ, NOT WRITTEN HERE. The legal moves come from application_status_transitions
 * as the page reads it. A copy of the graph in this file would keep offering a move after a
 * migration removed it, and the database would refuse every click on it. */

// Shared with the approval queue and the recovery queues, so "no answer" means one thing app-wide.
import { isNoAnswer } from '../approval/saveTailoredEdit.ts';
// The drawer's own shape check of a frozen tailored_profile: the rebuild renders only a real resume.
import { readResumeSnapshot } from '../pipeline/resumeSnapshot.ts';
// Type only: what the rebuild hands ResumePreview.
import type { ResolvedResume } from '../../data/contract';

/* The six statuses this page lists: everything after a confirmed submission (enums.sql). */
export type AppliedStage = 'applied' | 'employer_screening' | 'oa_pending' | 'interview' | 'offer' | 'rejected';

/* Pipeline order. The stage buttons and the filter options follow it, whatever order a read returns. */
export const APPLIED_STAGES: readonly AppliedStage[] = ['applied', 'employer_screening', 'oa_pending', 'interview', 'offer', 'rejected'];

/* The word each stage shows. A Record, so a new stage without a label fails to compile. */
export const STAGE_LABELS: Readonly<Record<AppliedStage, string>> = {
  // Submitted, nothing heard yet.
  applied: 'Applied',
  // Teja's ruling 2026-11-04: employer_screening is SHOWN as "Shortlisted"; the status value is unchanged.
  employer_screening: 'Shortlisted',
  // An online assessment is waiting.
  oa_pending: 'OA',
  // Interviewing.
  interview: 'Interview',
  // Terminal, good.
  offer: 'Offer',
  // Terminal, bad.
  rejected: 'Rejected',
};

/* A value is a page stage only when it is one of the six strings exactly. */
export function isAppliedStage(value: unknown): value is AppliedStage {
  // includes() over the closed list; a non-string can never match a string entry.
  return typeof value === 'string' && (APPLIED_STAGES as readonly string[]).includes(value);
}

/* Any status in words: a page stage by its label, an earlier status (approved, applying) by its name. */
export function statusText(status: string): string {
  // The page's own label first, so the timeline and the chip say "Shortlisted" alike.
  return isAppliedStage(status) ? STAGE_LABELS[status] : status.replace(/_/g, ' ');
}

/* An ISO timestamp WITH a zone: date, time, optional fraction, then Z or ±hh:mm / ±hhmm. A bare
   date or a zone-less time is refused: Date.parse reads one as UTC midnight and the other as local. */
const ISO_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(Z|[+-]\d{2}:?\d{2})$/;

/* Epoch ms for a real timestamptz string, or null. Never Date.parse alone: it reads "-5" as year -5
   and rolls Feb 31 into March. */
export function readTimestamp(value: unknown): number | null {
  // Only strings carry a timestamptz; a number is refused so an epoch never sneaks in unlabelled.
  if (typeof value !== 'string') return null;
  // The shape first; anything else is junk however Date.parse would read it.
  const m = ISO_TIMESTAMP.exec(value);
  // No match: no date.
  if (m === null) return null;
  // The calendar parts, as numbers, for the round-trip below.
  const [year, month, day, hour, minute, second] = [m[1], m[2], m[3], m[4], m[5], m[6] ?? '0'].map(Number) as [number, number, number, number, number, number];
  // Round-trip the calendar date: Feb 31 comes back as Mar 3, so it differs and is refused.
  const probe = new Date(Date.UTC(year, month - 1, day));
  // Each part must survive unchanged.
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) return null;
  // Clock parts in range; 24:00 and :60 are refused rather than rolled forward.
  if (hour > 23 || minute > 59 || second > 59) return null;
  // The shape is proven, so the parse now reads only what the shape allows (zone included).
  const ms = Date.parse(value);
  // A last guard: a proven shape that still fails to parse is no date.
  return Number.isFinite(ms) ? ms : null;
}

// One day in ms, for the day count.
const DAY_MS = 86_400_000;

/* Whole days from `atMs` to `nowMs`, or null when there is no date or it is more than a day ahead. */
export function daysSince(atMs: number | null, nowMs: number): number | null {
  // No date, no count: never 0.
  if (atMs === null) return null;
  // The signed gap.
  const gap = nowMs - atMs;
  // More than a day in the future is malformed data, not "-3 days".
  if (gap < -DAY_MS) return null;
  // Floored whole days; a few minutes of clock skew clamps to day 0.
  return Math.max(0, Math.floor(gap / DAY_MS));
}

/* The row's "N days since applied", or "—" when no date is known. */
export function daysSinceText(days: number | null): string {
  // Missing is said as missing.
  if (days === null) return '—';
  // Singular reads right.
  return days === 1 ? '1 day since applied' : `${days} days since applied`;
}

/* A date for display, or "—". The viewer's locale and zone: this is when THEY applied, locally. */
export function dayText(atMs: number | null): string {
  // Missing is said as missing.
  if (atMs === null) return '—';
  // "4 Nov 2026" style in en-IN, the operator's locale; dateStyle keeps it one short token.
  return new Date(atMs).toLocaleDateString('en-IN', { dateStyle: 'medium' });
}

/* A storage path to sign, or null. A blank, non-string or ".."-carrying path would sign a URL for a
   file the worker never wrote (the same guard as manual-apply/applyKit.ts). */
export function readStoragePath(value: unknown): string | null {
  // Only a non-blank string is a path.
  if (typeof value !== 'string' || value.trim() === '') return null;
  // No parent-directory segment anywhere.
  return value.split('/').includes('..') ? null : value;
}

/* The download name: the stored file's own name, its last path segment. */
export function fileNameOf(path: string): string {
  // split always yields at least one element; the fallback only satisfies the type.
  return path.split('/').pop() ?? path;
}

/* One legal move a human may make between two page stages. */
export interface StageEdge {
  // Where the row is.
  readonly from: AppliedStage;
  // Where it may go.
  readonly to: AppliedStage;
}

/* The human edges between page stages, from the table's rows. A row is kept only when both ends are
   page stages and its allowed_agents ARRAY names human; anything else is dropped, never assumed. */
export function readEdges(raw: unknown): StageEdge[] {
  // A failed or odd answer is no edges, so no buttons: never a fallback graph.
  if (!Array.isArray(raw)) return [];
  // Collected in read order; legalNextStages imposes the page order.
  const edges: StageEdge[] = [];
  // One pass.
  for (const item of raw) {
    // Arrays are objects to typeof; neither they nor null are rows.
    if (typeof item !== 'object' || item === null || Array.isArray(item)) continue;
    // Narrowed once for the field reads.
    const r = item as Record<string, unknown>;
    // The actor list must be an array that names human: the browser acts as human (no agent key).
    if (!Array.isArray(r.allowed_agents) || !r.allowed_agents.includes('human')) continue;
    // Both ends must be page stages; a move off this page is not a stage button.
    if (!isAppliedStage(r.from_status) || !isAppliedStage(r.to_status)) continue;
    // A proven edge.
    edges.push({ from: r.from_status, to: r.to_status });
  }
  return edges;
}

/* The stages a row at `from` may move to, in page order. Only what the edges say. */
export function legalNextStages(edges: readonly StageEdge[], from: AppliedStage): AppliedStage[] {
  // Walking the closed list keeps button order stable however the table returned its rows.
  return APPLIED_STAGES.filter((to) => edges.some((edge) => edge.from === from && edge.to === to));
}

/* One line in a row's timeline: a status change, or an email the tracker matched to the row. */
export type TimelineItem =
  // A status_change event; `from` is null for the row's first status.
  | { readonly kind: 'status'; readonly at: number | null; readonly from: string | null; readonly to: string }
  // A matched email; every field is untrusted text and is rendered escaped by React.
  | { readonly kind: 'email'; readonly at: number | null; readonly sender: string; readonly subject: string; readonly classification: string };

/* A plain object, or null for anything else (arrays, null, primitives). */
function asRecord(value: unknown): Record<string, unknown> | null {
  // Arrays are objects to typeof, so excluded explicitly.
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/* Status changes and matched emails, merged and sorted oldest first. An item with a junk time is
   KEPT, placed last with no time: hiding it loses history, ranking it invents a time. An item that
   cannot be described (no target status, a non-string subject) is dropped. */
export function mergeTimeline(events: unknown, emails: unknown): TimelineItem[] {
  // Built from both lists, then sorted once.
  const items: TimelineItem[] = [];
  // A missing embed is no history.
  for (const raw of Array.isArray(events) ? events : []) {
    // Rows only.
    const e = asRecord(raw);
    // Status changes only: claims, notes and llm_call rows are not stage history.
    if (e === null || e.event_type !== 'status_change') continue;
    // A status change with no target says nothing.
    if (typeof e.to_status !== 'string' || e.to_status === '') continue;
    // The source may be null (the first status); anything else non-string reads as null.
    items.push({ kind: 'status', at: readTimestamp(e.created_at), from: typeof e.from_status === 'string' ? e.from_status : null, to: e.to_status });
  }
  // The tracker's matches for this row.
  for (const raw of Array.isArray(emails) ? emails : []) {
    // Rows only.
    const m = asRecord(raw);
    // All three text fields must be strings; an email that cannot be described is dropped.
    if (m === null || typeof m.from_address !== 'string' || typeof m.subject !== 'string' || typeof m.classification !== 'string') continue;
    // Kept as the tracker stored it.
    items.push({ kind: 'email', at: readTimestamp(m.received_at), sender: m.from_address, subject: m.subject, classification: m.classification });
  }
  // Oldest first; null times last. Array.prototype.sort is stable, so ties keep input order.
  return items.sort((a, b) => (a.at === null ? (b.at === null ? 0 : 1) : b.at === null ? -1 : a.at - b.at));
}

/* One applied row, validated. Text fields are null when the job embed is missing: shown as "—". */
export interface AppliedRow {
  // The application id: the RPC target and the confirm key.
  readonly id: string;
  // The current stage.
  readonly status: AppliedStage;
  // updated_at exactly as PostgREST returned it, for p_expected_updated_at. Never parsed.
  readonly stamp: string;
  // The job title, untrusted text.
  readonly title: string | null;
  // The company, untrusted text.
  readonly company: string | null;
  // Parsed locations; [] when none.
  readonly locations: readonly string[];
  // jobs.apply_url as stored; the page passes it through safeHref before linking.
  readonly applyUrl: string | null;
  // When it was applied, epoch ms, or null.
  readonly appliedAt: number | null;
  // The submitted resume in the `resumes` bucket, or null.
  readonly resumePath: string | null;
  // The form screenshot in the `screenshots` bucket, or null.
  readonly screenshotPath: string | null;
  // The frozen approved resume, for the rebuild when no file was stored; null when not a resume.
  readonly resume: ResolvedResume | null;
  // Status changes and matched emails, oldest first.
  readonly timeline: readonly TimelineItem[];
}

/* A non-blank string, or null. */
function text(value: unknown): string | null {
  // Untrusted text is kept verbatim; only its presence is checked.
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

/* The applied date: applied_at, else the status_change event that entered applied, else null. */
function appliedAtOf(r: Record<string, unknown>): number | null {
  // The trigger stamps applied_at on entering applied (status_transition_guard.sql).
  const stamped = readTimestamp(r.applied_at);
  // Present and real: that is the answer.
  if (stamped !== null) return stamped;
  // Otherwise the event log's own witness of the move, if the embed carries one.
  for (const raw of Array.isArray(r.application_events) ? r.application_events : []) {
    // Rows only.
    const e = asRecord(raw);
    // The one event that says when the row entered applied.
    if (e !== null && e.event_type === 'status_change' && e.to_status === 'applied') {
      // Its time, if it is a real one.
      const at = readTimestamp(e.created_at);
      // A junk time keeps looking rather than answering.
      if (at !== null) return at;
    }
  }
  // Nothing says when: "—" on screen.
  return null;
}

/* One stored row as the page's select returns it, or null when it cannot be shown or moved safely:
   no id, no stamp, or a status outside the page. */
export function readAppliedRow(raw: unknown): AppliedRow | null {
  // Rows only.
  const r = asRecord(raw);
  // Not a row.
  if (r === null) return null;
  // The id names the RPC target; the stamp is the stale-click guard. Without either, no safe move.
  if (typeof r.id !== 'string' || r.id === '' || typeof r.updated_at !== 'string' || r.updated_at === '') return null;
  // A status the select should never return is shown nowhere rather than mislabelled.
  if (!isAppliedStage(r.status)) return null;
  // The job embed; missing keeps the row with "—" for its text.
  const job = asRecord(r.jobs);
  // Locations: strings only, so a stray null never renders as "null".
  const places = Array.isArray(job?.locations) ? job.locations.filter((p): p is string => typeof p === 'string' && p.trim() !== '') : [];
  return {
    // Proven above.
    id: r.id,
    // Proven above.
    status: r.status,
    // Verbatim, never parsed.
    stamp: r.updated_at,
    // Untrusted text or null.
    title: text(job?.title),
    // Untrusted text or null.
    company: text(job?.company_name),
    // Filtered above.
    locations: places,
    // Vetted by safeHref at render time.
    applyUrl: text(job?.apply_url),
    // Shape-checked, with the event fallback.
    appliedAt: appliedAtOf(r),
    // Guarded paths.
    resumePath: readStoragePath(r.resume_storage_path),
    // Guarded paths.
    screenshotPath: readStoragePath(r.screenshot_storage_path),
    // The drawer's shape check: {} and other junk read as null.
    resume: readResumeSnapshot(r.tailored_profile),
    // Merged and sorted.
    timeline: mergeTimeline(r.application_events, r.email_events),
  };
}

/* The sort choices: by applied date. */
export type AppliedSort = 'newest' | 'oldest';
/* The stage filter: one stage, or all. */
export type StageFilter = 'all' | AppliedStage;

/* Everything the operator chose in the toolbar. */
export interface AppliedView {
  // Free text over title, company and locations.
  readonly search: string;
  // Applied date order.
  readonly sort: AppliedSort;
  // Which stage is shown.
  readonly stage: StageFilter;
}

/* Newest first, nothing hidden. */
export const DEFAULT_APPLIED_VIEW: AppliedView = { search: '', sort: 'newest', stage: 'all' };

/* The sort options' text; a Record so a new sort without a label fails to compile. */
export const APPLIED_SORT_LABELS: Readonly<Record<AppliedSort, string>> = {
  // Most recent application first.
  newest: 'Applied: newest first',
  // Longest waiting first.
  oldest: 'Applied: oldest first',
};

/* Title, company and every location as one lowercased string for the search tokens. */
function haystack(row: AppliedRow): string {
  // A space between fields, so "Data" + "Base Inc" never matches "database"; nulls contribute nothing.
  return [row.title, row.company, ...row.locations].filter((part): part is string => part !== null).join(' ').toLowerCase();
}

/* The rows the page shows: stage, then search, then sort. Always a NEW array. */
export function applyAppliedView(rows: readonly AppliedRow[], view: AppliedView): AppliedRow[] {
  // Whitespace-separated lowercased tokens; a blank search has none and filters nothing.
  const tokens = view.search.trim().toLowerCase().split(/\s+/).filter(Boolean);
  // filter copies, so the sort below never touches the caller's array.
  const shown = rows.filter((row) => (view.stage === 'all' || row.status === view.stage) && tokens.every((token) => haystack(row).includes(token)));
  // Direction: newest is descending.
  const sign = view.sort === 'newest' ? -1 : 1;
  // Undated rows go last in BOTH directions: a missing date is never "newest" or "oldest".
  return shown.sort((a, b) => (a.appliedAt === null ? (b.appliedAt === null ? 0 : 1) : b.appliedAt === null ? -1 : sign * (a.appliedAt - b.appliedAt)));
}

/* How many rows each filter option would show; every option present, so an empty one reads 0. */
export function countByStage(rows: readonly AppliedRow[]): Readonly<Record<StageFilter, number>> {
  // Every stage starts at zero.
  const counts: Record<StageFilter, number> = { all: rows.length, applied: 0, employer_screening: 0, oa_pending: 0, interview: 0, offer: 0, rejected: 0 };
  // One pass; status is a proven stage, so the key always exists.
  for (const row of rows) counts[row.status] += 1;
  return counts;
}

/* The RPC arguments for one move, in one pure place so a test pins the actor and the stamp. */
export function buildMoveArgs(row: Pick<AppliedRow, 'id' | 'status' | 'stamp'>, to: AppliedStage): Record<string, unknown> {
  return {
    // The row.
    p_application_id: row.id,
    // The target; the database's graph has the final word.
    p_to_status: to,
    // The only agent a browser may honestly claim.
    p_agent: 'human',
    // Recorded on the status event, so the log says which screen made the move.
    p_detail: { source: 'applied_page', from: row.status },
    // Always sent: a row changed since load is refused with PT409 under the row lock.
    p_expected_updated_at: row.stamp,
  };
}

/* The inline sentence for a move that did not succeed. A lost answer is never called a failure. */
export function moveErrorText(httpStatus: unknown, error: { code?: unknown; message?: unknown } | null): string {
  // Status 0, or an error with no SQLSTATE: the network, not the database. The call may still commit.
  if (isNoAnswer(httpStatus, error)) return 'No answer from the database. The move may still land, so reload before trying again.';
  // The SQLSTATE, proven a string by isNoAnswer returning false with an error present.
  const code = typeof error?.code === 'string' ? error.code : '';
  // The stale-stamp guard: the row was edited or moved elsewhere since load.
  if (code === 'PT409') return 'Not moved: this row changed since this page loaded. Reload, then try again.';
  // Any other refusal, in the database's own words.
  return `Not moved (${code}): ${typeof error?.message === 'string' ? error.message : 'refused'}`;
}
