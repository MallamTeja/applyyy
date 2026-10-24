/* Shape check for the `application_status_counts` RPC result.
 *
 * WHY THIS IS ITS OWN FILE. useApplicationCounts.ts imports the supabase client, and
 * node --test cannot load that without Vite's env. The validation is the part worth
 * testing, so it lives here as a plain function of its argument.
 *
 * WHY VALIDATE AT ALL. The RPC replaced a browser-side tally of `select=status`, which
 * hosted PostgREST silently cut at max_rows = 1000 (confirmed live 2026-10-24: 1,000 of
 * 21,560 rows). That bug was missing data becoming an answer. So this reader does not
 * ask a lenient parser whether it coped: it checks the exact shape (an array of
 * {status: known status, row_count: non-negative integer}, each status once) and
 * refuses anything else as a failed read, never as a smaller count. */

// Runtime list of real statuses, so an unknown string from the wire is refused rather than displayed.
import { APPLICATION_STATUSES } from './contract.ts';
// Type only: the closed status union the counts are keyed by.
import type { ApplicationStatus } from './contract.ts';

// One row of the RPC: a status and how many of the user's applications sit in it.
export interface StatusCountRow {
  // The status, already checked against APPLICATION_STATUSES.
  readonly status: ApplicationStatus;
  // The server's count(*), already checked to be a non-negative integer.
  readonly row_count: number;
}

// Either every row passed the shape check, or a sentence saying which one did not.
export type ParsedStatusCounts =
  // All rows valid; an empty array is a real "no applications".
  | { readonly ok: true; readonly rows: readonly StatusCountRow[] }
  // The first problem found, worded for the read-failure banner.
  | { readonly ok: false; readonly reason: string };

// A Set for the membership test, built once; the list itself stays the single source of truth.
const KNOWN_STATUSES: ReadonlySet<string> = new Set(APPLICATION_STATUSES);

// Validates the RPC's `data`. Never coerces: a string count, a duplicate status or an
// unknown status is a contract break and is reported, because a quietly-adjusted number
// on the pipeline page is the kind of wrong answer someone acts on.
export function parseStatusCountRows(data: unknown): ParsedStatusCounts {
  // supabase-js returns an array for a set-returning function; anything else is not this RPC's answer.
  if (!Array.isArray(data)) return { ok: false, reason: 'status counts: the response was not a list' };
  // Statuses already seen, so a repeated status cannot be summed or overwritten silently.
  const seen = new Set<string>();
  // The validated rows, in server order.
  const rows: StatusCountRow[] = [];
  // Each row checked on its own; the first failure ends the read.
  for (const raw of data) {
    // A row must be a plain object to have fields at all.
    if (typeof raw !== 'object' || raw === null) return { ok: false, reason: 'status counts: a row was not an object' };
    // Read the two fields loosely, then prove their types below.
    const { status, row_count: count } = raw as { status?: unknown; row_count?: unknown };
    // The status must be one the app knows; a new enum value needs a contract update first.
    if (typeof status !== 'string' || !KNOWN_STATUSES.has(status)) return { ok: false, reason: `status counts: unknown status ${JSON.stringify(status)}` };
    // A count is a whole number of rows; Number.isInteger also refuses strings, NaN and Infinity.
    if (typeof count !== 'number' || !Number.isInteger(count) || count < 0) return { ok: false, reason: `status counts: bad count for ${status}` };
    // GROUP BY yields each status once; a repeat means this is not the GROUP BY's output.
    if (seen.has(status)) return { ok: false, reason: `status counts: ${status} appeared twice` };
    // Remembered for the duplicate check.
    seen.add(status);
    // Narrowed by the checks above, so the cast states what was just proven.
    rows.push({ status: status as ApplicationStatus, row_count: count });
  }
  // Every row passed.
  return { ok: true, rows };
}
