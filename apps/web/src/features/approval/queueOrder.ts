/* The approval queue's order: the row that most recently ENTERED review comes first (asked for
 * 2026-10-24: "latest need to be on top").
 *
 * WHY status_changed_at AND NOT created_at OR updated_at. created_at is when the scout first
 * discovered the job, so a job found last week but tailored a minute ago sorted below older
 * ones. updated_at moves on every edit, so the row being reviewed would jump to the top mid-review.
 * status_changed_at is set by the transition trigger (status_transition_guard.sql) only when the
 * status moves, so for this page it is exactly "when it reached awaiting_approval", and an edit
 * leaves the order alone. */

/* The two fields the order reads; narrower than the queue row so the test can build rows freely. */
export interface ReviewOrderRow {
  // ISO timestamp from the database: when the row entered its current status.
  readonly status_changed_at: unknown;
  // The tie-break, so equal timestamps still give one fixed order on every load.
  readonly id: string;
}

/* A timestamp read by SHAPE first: Date.parse is lenient ("-5" is year -5), so only an ISO
 * date-time is parsed. Anything else is -Infinity and sorts last, never as the newest row. */
function enteredAt(row: ReviewOrderRow): number {
  // Only a string can be a timestamp.
  const raw = row.status_changed_at;
  // A date and a time, as PostgREST returns timestamptz; a bare number or word never qualifies.
  if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(raw)) return Number.NEGATIVE_INFINITY;
  // Parsed only after the shape check passed.
  const ms = Date.parse(raw);
  // A shaped but impossible date (month 13) still parses to NaN; it sorts last too.
  return Number.isFinite(ms) ? ms : Number.NEGATIVE_INFINITY;
}

/* Newest arrival in review first, ties broken by id, as a NEW array (the input is the fetched data). */
export function newestInReviewFirst<T extends ReviewOrderRow>(rows: readonly T[]): T[] {
  // Copied, so the caller's array is never reordered behind its back.
  return [...rows].sort((a, b) => {
    // Later entry first.
    const byTime = enteredAt(b) - enteredAt(a);
    // -Infinity minus -Infinity is NaN; treat two unreadable stamps as equal and fall to the id.
    if (byTime !== 0 && !Number.isNaN(byTime)) return byTime;
    // Deterministic tie-break, so the order never flickers between loads.
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}
