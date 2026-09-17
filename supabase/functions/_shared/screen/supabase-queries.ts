// The Supabase adapter behind the Screener's three reads.
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
// Row shape from the schema owner. Never redefined.
import type { FilterRuleRow } from "../contracts/shared-types.ts";

// The minimum a client must offer to serve these three reads.
//
// NO FILTER METHODS ON PURPOSE. Every one of these tables is already scoped to the
// signed-in user by RLS, so a `.eq('user_id', …)` would be redundant, and the one
// genuine predicate — has this block expired? — is applied here where it can be tested
// against a fixed clock rather than against a live database.
export interface SelectableClient {
  from(table: string): {
    select(columns: string): PromiseLike<{ data: unknown[] | null; error: { message: string } | null }>;
  };
}

// One row of `company_blocklist`, as far as this module reads it.
interface BlocklistRow {
  readonly company_slug: string;
  readonly blocked_until: string | null;
}

// One row of the applications-with-job join, before flattening.
interface HistoryRow {
  readonly created_at: string;
  readonly jobs: { readonly fingerprint: string; readonly company_slug: string } | null;
}

// Normalise one postgrest response into the loader's result shape.
//
// THE ERROR IS CARRIED THROUGH RATHER THAN ABSORBED, and that is the whole contract:
// `context.ts` distinguishes "the query failed" from "the table is empty" and can only
// do so if this layer refuses to flatten the two. Returning `[]` on an error here would
// silently disable three cascade rules one layer up.
function toResult<T>(response: { data: unknown[] | null; error: { message: string } | null }, map: (rows: unknown[]) => readonly T[]): ScreenQueryResult<T> {
  // A genuine error wins, and keeps its message for `agent_runs.error_detail`.
  if (response.error !== null) return { rows: null, error: response.error.message };
  // Null data without an error should not happen, but treating it as an empty table
  // would be inventing a fact — it is reported as the anomaly it is.
  if (response.data === null) return { rows: null, error: "query returned no data and no error" };
  // A real result, including a legitimately empty one.
  return { rows: map(response.data), error: null };
}

// Build the three reads against a live client.
//
// `now` is injected rather than read inside, so block expiry is assertable — the same
// discipline the cascade and the loader follow.
export function supabaseScreenQueries(client: SelectableClient, now: Date): ScreenQueries {
  return {
    // The cascade's rules, thresholds and ORDER. `sort_order` is selected because the
    // cascade sorts on it; dropping it from the projection would silently reorder every
    // filter, which is a settings change nobody made.
    filterRules(): Promise<ScreenQueryResult<FilterRuleRow>> {
      return Promise.resolve(client.from("filter_rules").select("*")).then((response) =>
        toResult(response, (rows) => rows as FilterRuleRow[]),
      );
    },

    // Blocked slugs, with expiry applied here rather than in SQL so it is testable.
    blockedCompanies(): Promise<ScreenQueryResult<{ readonly company_slug: string }>> {
      return Promise.resolve(client.from("company_blocklist").select("company_slug, blocked_until")).then((response) =>
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
    // application's date means already_applied and the weekly cap are derived from the
    // same rows and cannot disagree with each other.
    applicationHistory(): Promise<ScreenQueryResult<ApplicationHistoryRow>> {
      return Promise.resolve(client.from("applications").select("created_at, jobs(fingerprint, company_slug)")).then(
        (response) =>
          toResult(response, (rows) =>
            (rows as HistoryRow[])
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
                created_at: row.created_at,
              })),
          ),
      );
    },

    // Stage 0's config. RLS scopes this to the signed-in user, so a plain select returns
    // at most that user's own row — no filter is needed and none is applied.
    searchPreferences(): Promise<ScreenQueryResult<SearchPreferencesRow>> {
      return Promise.resolve(client.from("search_preferences").select("titles, keywords, excluded_keywords")).then(
        (response) => toResult(response, (rows) => rows as SearchPreferencesRow[]),
      );
    },
  };
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
