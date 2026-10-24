// The Supabase adapter behind the Screener's four reads.
//
// WHY THIS IS SEPARATE FROM `context.ts`: that module owns the POLICY — what counts as
// a failure, how the trailing week is computed, which error message an operator sees.
// This one owns the PLUMBING. Keeping them apart is what lets every policy decision be
// tested under `node --test`, where no Supabase client can be constructed at all.
//
// THE CLIENT IS TAKEN STRUCTURALLY, not as a `SupabaseClient`. The two callers are
// different runtimes — the worker's npm `@supabase/supabase-js` and the Edge Function's
// Deno client — and naming either type here would drag that runtime's imports into the
// other's type graph. The shape below is all this module actually uses.

// The result and row shapes the loader expects back.
import type { ApplicationHistoryRow, ScreenQueries, ScreenQueryResult, SearchPreferencesRow } from "./context.ts";
// Row shape and status union from the schema owner. Never redefined.
import type { ApplicationStatus, FilterRuleRow } from "../contracts/shared-types.ts";

// The application statuses that mean "Teja has committed to applying to this job".
//
// EVERYTHING BEFORE `approved` IS PIPELINE-ONLY. `applications` holds every discovered
// job, including the very row being screened (at `deduped`) and every row the filters
// dropped. Counting those as history made a row its own already_applied duplicate and
// charged every dropped posting against the weekly cap as if it had been sent.
//
// `failed` IS INCLUDED, BUT NOT ALONE. The graph has failed → needs_verification →
// applied, so a failed row may already have been submitted. But `failed` is ALSO reached
// before approval (discovered/deduped/passed_filters/scored/tailored → failed; the
// auditor writes tailored → failed), and such a row was never sent. The server can't
// tell the two apart by status, so `applicationHistory` drops a failed row only when
// `approved_at` is null — see `wasNeverApproved` below. When we cannot tell, the
// screener fails CLOSED: re-offering a job costs nothing, a double application a lot.
//
// Typed `readonly ApplicationStatus[]` via `satisfies`, so a misspelt or retired status
// is a compile error rather than a predicate that silently matches nothing.
export const COMMITTED_STATUSES = [
  // Human said yes; submission is now intended.
  "approved",
  // The worker has started submitting.
  "applying",
  // Submission paused on a captcha/MFA wall; still intended.
  "blocked_needs_human",
  // A swept lease: the submit may have landed.
  "needs_verification",
  // Submitted.
  "applied",
  // Post-apply tracker states: all submitted.
  "employer_screening",
  // Post-apply: online assessment sent.
  "oa_pending",
  // Post-apply: interviewing.
  "interview",
  // Post-apply terminal, good.
  "offer",
  // Post-apply terminal, bad. Still applied to; must not be re-offered.
  "rejected",
  // May have been submitted (see above), so it counts — unless never approved.
  "failed",
] as const satisfies readonly ApplicationStatus[];

// One postgrest response, as far as this module reads it. `count` is present only when
// the read asked for `{ count: "exact" }`: the TOTAL matching rows on the server, which
// can exceed `data.length` when max_rows cut the page. supabase-js sends null otherwise.
type QueryResponse = { data: unknown[] | null; error: { message: string } | null; count?: number | null };

// The minimum a client must offer to serve these reads.
//
// NO USER FILTER, ON PURPOSE. Every table is already scoped to the signed-in user by RLS,
// so a `.eq('user_id', …)` would be redundant. Block expiry stays in code, where it can
// be tested against a fixed clock.
//
// ONE FILTER METHOD, `in`, AND ONLY FOR THE STATUS PREDICATE. That predicate must run
// on the SERVER: PostgREST truncates an unfiltered read at max_rows (1000), so filtering
// in JS after the fetch would silently drop real applications past the cut — and it
// would also fetch every pipeline row for nothing. `select()` stays directly awaitable
// because the other three tables never filter.
export interface SelectableClient {
  from(table: string): {
    // Awaitable as-is, and narrowable with `.in()` — the supabase-js builder is both.
    // `options.count` is supabase-js's own option; only the history read passes it, to
    // prove its single page is the whole set (see `applicationHistory`).
    select(columns: string, options?: { count: "exact" }): PromiseLike<QueryResponse> & {
      // A server-side `status IN (values)`, resolving to the same response shape. The
      // column is the literal "status" because that is the only column this port
      // filters. Matching supabase-js's generic `in<ColumnName>` against this overflows
      // tsc (TS2589), so callers never meet this type: see the one cast in
      // `supabaseScreenQueries` below.
      in(column: "status", values: readonly string[]): PromiseLike<QueryResponse>;
    };
  };
}

// One row of `company_blocklist`, as far as this module reads it.
interface BlocklistRow {
  readonly company_slug: string;
  readonly blocked_until: string | null;
}

// One row of the applications-with-job join, before flattening.
interface HistoryRow {
  // Read so a `failed` row can be told apart from the committed statuses.
  readonly status: string;
  // Stamped only on entering `approved`: the witness that a failed row was ever sendable.
  readonly approved_at: string | null;
  // Stamped only on entering `applied`: the precise moment of submission.
  readonly applied_at: string | null;
  readonly jobs: { readonly fingerprint: string; readonly company_slug: string } | null;
}

// Normalise one postgrest response into the loader's result shape.
//
// THE ERROR IS CARRIED THROUGH RATHER THAN ABSORBED, and that is the whole contract:
// `context.ts` distinguishes "the query failed" from "the table is empty" and can only
// do so if this layer refuses to flatten the two. Returning `[]` on an error here would
// silently disable three cascade rules one layer up.
function toResult<T>(response: QueryResponse, map: (rows: unknown[]) => readonly T[]): ScreenQueryResult<T> {
  // A genuine error wins, and keeps its message for `agent_runs.error_detail`.
  if (response.error !== null) return { rows: null, error: response.error.message };
  // Null data without an error should not happen, but treating it as an empty table
  // would be inventing a fact — it is reported as the anomaly it is.
  if (response.data === null) return { rows: null, error: "query returned no data and no error" };
  // A real result, including a legitimately empty one.
  return { rows: map(response.data), error: null };
}

// Refuse a history page that is not the whole set; null means "complete, carry on".
//
// WHY: PostgREST cuts every read at max_rows (1000) WITHOUT an error. A user with 1001
// committed applications would get 1000, and already_applied and the weekly cap would
// UNDERCOUNT. That is a fail-open (CLAUDE.md §6). The server's exact count is compared to the rows
// received, and any mismatch, or a missing count, is a named error rather than an answer.
//
// WHY NOT A `.range()` PAGE LOOP: paging needs a stable `.order()`, and a row inserted or
// deleted between pages shifts the offsets: its own silent miss or duplicate. One page
// plus a count has no such window. ponytail: the read now REFUSES above 1000 committed
// rows per user (live count 0); add an ordered page loop if a user ever gets near that.
function checkComplete(response: QueryResponse): ScreenQueryResult<never> | null {
  // A query error or missing data is toResult's to report, with its original message.
  if (response.error !== null || response.data === null) return null;
  // No count means completeness can't be proven: fail closed, never assume "all of it".
  // Number.isInteger, not typeof: postgrest-js parseInt()s Content-Range, so a "0-n/*"
  // header yields NaN, which IS typeof "number" and would mis-name the guard below.
  if (!Number.isInteger(response.count)) {
    // Named so agent_runs.error_detail says exactly which guard fired.
    return { rows: null, error: "history_count_unavailable: the server returned no exact count, so the history cannot be proven complete" };
  }
  // Fewer rows than the server counted: max_rows cut the page.
  if (response.count !== response.data.length) {
    // Both numbers, so the operator sees the size of the gap.
    return {
      rows: null,
      error: `history_truncated: ${response.count} committed rows on the server, ${response.data.length} returned (PostgREST max_rows)`,
    };
  }
  // The page is the whole set.
  return null;
}

// Build the four reads against a live client.
//
// `now` is injected rather than read inside, so block expiry is assertable — the same
// discipline the cascade and the loader follow.
//
// THE PUBLIC PARAMETER IS DELIBERATELY MINIMAL: anything with a `from()`. Typed as
// `SelectableClient`, tsc matched supabase-js's generic `in<ColumnName>` chain against
// the port at every real-client call site and overflowed (TS2589), the same overflow
// cover-letter/index.ts:154-157 documents. A bare `from(): unknown` matches shallowly.
export function supabaseScreenQueries(client: { from(table: string): unknown }, now: Date): ScreenQueries {
  // ONE CAST HERE rather than one per caller, so screener, scout-ats and the worker scout
  // stay cast-free. What it costs: no compile-time proof that the real client fits the
  // port. What replaces it: the unit fakes, written to the same chain, and the live
  // screener run, which exercises the real supabase-js builder end to end.
  const db = client as unknown as SelectableClient;
  return {
    // The cascade's rules, thresholds and ORDER. `sort_order` is selected because the
    // cascade sorts on it; dropping it from the projection would silently reorder every
    // filter, which is a settings change nobody made.
    filterRules(): Promise<ScreenQueryResult<FilterRuleRow>> {
      return Promise.resolve(db.from("filter_rules").select("*")).then((response) =>
        toResult(response, (rows) => rows as FilterRuleRow[]),
      );
    },

    // Blocked slugs, with expiry applied here rather than in SQL so it is testable.
    blockedCompanies(): Promise<ScreenQueryResult<{ readonly company_slug: string }>> {
      return Promise.resolve(db.from("company_blocklist").select("company_slug, blocked_until")).then((response) =>
        toResult(response, (rows) =>
          (rows as BlocklistRow[])
            // Keep a block unless it has demonstrably expired.
            .filter((row) => isStillBlocked(row.blocked_until, now))
            // The cascade only ever tests the slug.
            .map((row) => ({ company_slug: row.company_slug })),
        ),
      );
    },

    // One join serving two rules. Selecting the job's fingerprint and slug alongside the
    // application's commit stamps means already_applied and the weekly cap are derived
    // from the same rows and cannot disagree with each other. Only COMMITTED rows are
    // read, and the status predicate is server-side so pipeline rows never eat into
    // max_rows. One exception: a pre-approval `failed` passes `.in()` and is dropped in
    // JS below, so it still costs a row of the cap (live count 0 today). Moving it
    // server-side needs `.or()` on the port, which re-triggers the TS2589 fixed above.
    // `created_at` is NOT read: it is discovery time, and the cap counts commitments.
    applicationHistory(): Promise<ScreenQueryResult<ApplicationHistoryRow>> {
      return Promise.resolve(
        // The join the cascade needs, narrowed by Postgres to committed statuses.
        // `status, approved_at` ride along so a pre-approval `failed` can be dropped below;
        // `applied_at, approved_at` are the commit stamps the weekly window runs on.
        // `count: "exact"` makes PostgREST report the TOTAL rows matching this filter, so
        // the one page can be proven complete (see `checkComplete`).
        db
          .from("applications")
          .select("status, approved_at, applied_at, jobs(fingerprint, company_slug)", { count: "exact" })
          .in("status", COMMITTED_STATUSES),
      ).then(
        (response) =>
          // A partial history is refused before any row is mapped: see `checkComplete`.
          checkComplete(response) ??
          toResult(response, (rows) =>
            (rows as HistoryRow[])
              // A failed row that was never approved was never sent: not an application.
              .filter((row) => !wasNeverApproved(row))
              // AN APPLICATION WHOSE JOB ROW IS MISSING CARRIES NOTHING TO MATCH ON.
              // Emitting it anyway would put `undefined` into the applied-set, which
              // `Set.has` answers false to — a member that matches nothing and hides the
              // gap. Skipping is safe: UNIQUE(user_id, job_id) is still the real
              // guarantee against applying twice, this set is only a cost-saving
              // pre-check.
              .filter((row): row is HistoryRow & { jobs: NonNullable<HistoryRow["jobs"]> } => row.jobs !== null)
              // Flatten the nested job onto the row the cascade's context is built from.
              .map((row) => ({
                fingerprint: row.jobs.fingerprint,
                company_slug: row.jobs.company_slug,
                // The coalesce lives HERE, beside the column names, so the loader's row
                // type says only "when committed". Applied is the later, precise event;
                // approved covers rows not yet submitted. `?? null` turns an absent
                // field into null, which the loader counts as this week (fail closed).
                committed_at: row.applied_at ?? row.approved_at ?? null,
              })),
          ),
      );
    },

    // Stage 0's config. RLS scopes this to the signed-in user, so a plain select returns
    // at most that user's own row — no filter is needed and none is applied.
    // us_work_authorized needs migration 20261024190000 applied FIRST: before it, this
    // select fails, and the loader stops the run with a named error (never a silent pass).
    searchPreferences(): Promise<ScreenQueryResult<SearchPreferencesRow>> {
      return Promise.resolve(db.from("search_preferences").select("titles, keywords, excluded_keywords, us_work_authorized")).then(
        (response) => toResult(response, (rows) => rows as SearchPreferencesRow[]),
      );
    },
  };
}

// Is this a `failed` row that provably never reached approval?
//
// `approved_at` is stamped ONLY by applyy_internal.guard_status_transition on entering
// `approved` (migration 20260909234900, lines 254-256), and nothing clears it. So
// `failed` + `approved_at === null` means it failed in the pipeline and was never sent.
//
// ONLY THAT EXACT SHAPE IS DROPPED. Any other shape (undefined, a string, a status we
// did not expect) answers false and KEEPS the row: an unknown answer counts as applied,
// which fails closed against a double application. A lenient `!row.approved_at` would
// let a missing column turn into "not applied" (CLAUDE.md §6).
function wasNeverApproved(row: HistoryRow): boolean {
  // Strict on both halves; `=== null` deliberately rejects undefined.
  return row.status === "failed" && row.approved_at === null;
}

// Is a block still in force?
//
// FAILS TOWARD KEEPING THE BLOCK, deliberately. The two error directions are not
// symmetric: keeping a block too long costs Teja a few jobs from one company he chose to
// block, while dropping it early silently resumes applying to a company he deliberately
// excluded. `Date.parse` is lenient enough to turn junk into a date, so the shape is
// validated rather than the parser asked whether it gave up.
function isStillBlocked(blockedUntil: string | null, now: Date): boolean {
  // No expiry means a permanent block.
  if (blockedUntil === null) return true;
  // The stored instant.
  const expiresAt = Date.parse(blockedUntil);
  // Unreadable: keep the block rather than invent an expiry.
  if (!Number.isFinite(expiresAt)) return true;
  // Otherwise the block stands until its moment passes.
  return expiresAt > now.getTime();
}
