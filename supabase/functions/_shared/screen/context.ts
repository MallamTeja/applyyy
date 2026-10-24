// Loading the Screener's database context.
//
// WHY THIS IS A SEPARATE MODULE FROM THE CASCADE. `screenJob` is pure by design — no
// database, no clock, no network — which is exactly what makes the whole cascade
// table-driven testable. The price of that purity is that SOMETHING has to fetch the
// four things it cannot fetch itself. This is that something, and it is kept narrow so
// the impurity lives in one place both scouts share.
//
// THE FAILURE THAT MATTERS, and it is not a crash. Three of the nine rules —
// already_applied, company_blocklist, per_company_weekly_cap — read nothing from the job
// row; they read this context and nothing else. So if a query fails and this function
// hands back an empty context anyway, those three rules return drop:false for every job,
// forever, and the cascade reports a clean pass. No error, no warning, no log line. A
// third of the screener stops working and every observable signal says it is fine.
//
// Hence the rule this module is built around: AN ERROR AND AN EMPTY TABLE ARE DIFFERENT
// THINGS AND MUST NEVER COLLAPSE INTO EACH OTHER. An empty table is a legitimate and
// common state — a new user has applied to nothing — and must succeed. Only a genuine
// error is a failure, and a failure is reported rather than absorbed. This is the
// "never ask a lenient reader whether it gave up" rule applied to a database call.

// The cascade's context shape, so this module cannot drift from what it feeds.
import type { ScreenContext } from "../filter/cascade.ts";
// Row shapes from the schema owner. Never redefined.
import type { FilterRuleRow } from "../contracts/shared-types.ts";
// Stage 0's config shape, so the loader hands back something the gates can use directly.
import type { ScreenPreferences } from "./screen-batch.ts";

// One query's outcome, in the shape postgrest already returns.
//
// `rows: null` TOGETHER WITH `error: string` IS THE FAILURE SIGNAL, and both halves
// matter: an empty array with no error is success, and the two must stay
// distinguishable all the way through. Modelled explicitly rather than reusing the
// client's own type so this module stays runtime-agnostic and fakeable under
// `node --test`, where no Supabase client can be constructed.
export interface ScreenQueryResult<T> {
  readonly rows: readonly T[] | null;
  readonly error: string | null;
}

// One application already in the history, flattened across the jobs join.
export interface ApplicationHistoryRow {
  // Feeds already_applied.
  readonly fingerprint: string;
  // Feeds the per-company weekly cap.
  readonly company_slug: string;
  // WHEN TEJA COMMITTED: `applied_at ?? approved_at`, coalesced by the adapter that knows
  // the columns. Decides whether this one falls inside the trailing week. RENAMED from
  // `created_at` (2026-10-08): that column is DISCOVERY time, and windowing on it let a
  // job found last month and approved today escape this week's cap. Null when neither
  // stamp exists, which the loader counts as this week (fail closed).
  readonly committed_at: string | null;
}

// The four reads the Screener needs.
//
// A NARROW PORT RATHER THAN A `SupabaseClient`, matching the seam `_shared/agent/port.ts`
// already establishes for every other agent: a client cannot be built under
// `node --test`, so a module that reaches for one directly is a module whose failure
// handling is untestable — and the failure handling is the entire point here.
//
// FOUR CALLS SERVING FIVE NEEDS: applied fingerprints and weekly counts both come from
// the application history, so one round trip serves both rules. Two separate queries
// could also disagree with each other, which this cannot. The fourth call is stage 0's
// config, which is not part of the cascade at all.
export interface ScreenQueries {
  // The cascade's rules, thresholds and ORDER. Nothing is hardcoded — §8 says every row
  // is a settings field, and `sort_order` makes re-ordering a settings change.
  filterRules(): Promise<ScreenQueryResult<FilterRuleRow>>;
  // Slugs currently blocked.
  blockedCompanies(): Promise<ScreenQueryResult<{ readonly company_slug: string }>>;
  // Every application Teja has COMMITTED to (a committed status; a `failed` row only if
  // it was ever approved), with enough detail to serve both dependent rules.
  applicationHistory(): Promise<ScreenQueryResult<ApplicationHistoryRow>>;
  // Stage 0's config. Teja's decision of 2026-09-17 put the tech definition in these
  // existing columns rather than in a new FilterRuleType, so the gate reads them
  // directly and no enum, migration or cascade edit was needed.
  searchPreferences(): Promise<ScreenQueryResult<SearchPreferencesRow>>;
}

// One row of `search_preferences`, as far as stage 0 reads it. Array columns are typed
// nullable because a row written before the `'{}'` defaults existed can still carry
// nulls, and a null reaching the gate would throw rather than open it.
export interface SearchPreferencesRow {
  readonly titles: readonly string[] | null;
  readonly keywords: readonly string[] | null;
  readonly excluded_keywords: readonly string[] | null;
  // Teja's US work-authorisation answer for the work-auth gate. Optional in the TYPE
  // because a row read before migration 20261024190000 has no such key; absent and null
  // both mean "never answered", and the gate stays open for that.
  readonly us_work_authorized?: boolean | null;
}

// What a successful load hands the caller: the rules and the context, together, because
// the cascade needs both and fetching them apart invites one being refreshed without
// the other.
export interface LoadedScreenContext {
  readonly rules: readonly FilterRuleRow[];
  readonly context: ScreenContext;
  // Stage 0's config, carried alongside rather than fetched separately, so the gate and
  // the cascade can never be run against config loaded at two different moments.
  readonly preferences: ScreenPreferences;
}

// Success or an explained failure. Mirrors `PortResult` in `_shared/agent/port.ts` — a
// union rather than a thrown error, because "the query failed" is a normal operational
// state with a specific correct response, not an exception.
export type LoadResult =
  | { readonly ok: true; readonly value: LoadedScreenContext }
  | { readonly ok: false; readonly reason: string };

// Seven days, named so the window arithmetic reads as intent rather than as a magic
// number. §18.5's cap is explicitly per WEEK.
const TRAILING_WINDOW_MS = 7 * 86_400_000;

// The shape PostgREST serialises a timestamptz in: date, `T`, time, optional fraction,
// then `Z` or a ±hh:mm offset. Checked BEFORE `Date.parse` because that parser is
// lenient: `Date.parse("-5")` is year −5, which would read as "long ago" and quietly
// drop a row out of the cap's window. No strict ISO helper existed in `_shared`.
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/;

// Epoch ms for a well-formed timestamp, or null for anything else.
function strictTimestampMs(value: string | null): number | null {
  // Not a string, or not the expected shape: we don't know when it was.
  if (typeof value !== "string" || !ISO_TIMESTAMP.test(value)) return null;
  // The right shape can still be an impossible date (month 13); NaN catches that.
  const ms = Date.parse(value);
  // Only a finite instant is an answer.
  return Number.isFinite(ms) ? ms : null;
}

// Fetch everything the cascade needs that is not on the job row.
//
// The clock is INJECTED rather than read here, so the trailing-week boundary is
// assertable rather than flaky — the same reason the cascade takes `now` in its context.
export async function loadScreenContext(queries: ScreenQueries, now: Date): Promise<LoadResult> {
  // Four independent reads, issued together rather than in sequence: none depends on
  // another, and a scout polling forty boards should not pay four serial round trips
  // per board.
  const [rulesResult, blockedResult, historyResult, preferencesResult] = await Promise.all([
    queries.filterRules(),
    queries.blockedCompanies(),
    queries.applicationHistory(),
    queries.searchPreferences(),
  ]);

  // EACH FAILURE IS CHECKED AND NAMED SEPARATELY. A combined "context load failed" would
  // put "the blocklist is unreadable" and "Postgres is unreachable" on one code path, and
  // the operator would have to reconstruct the difference from a stack trace. The table
  // name in the message is what makes the health page's error_detail actionable.
  if (rulesResult.error !== null || rulesResult.rows === null) {
    return { ok: false, reason: `filter_rules query failed: ${rulesResult.error ?? "no rows returned"}` };
  }
  if (blockedResult.error !== null || blockedResult.rows === null) {
    return { ok: false, reason: `company_blocklist query failed: ${blockedResult.error ?? "no rows returned"}` };
  }
  if (historyResult.error !== null || historyResult.rows === null) {
    return { ok: false, reason: `applications history query failed: ${historyResult.error ?? "no rows returned"}` };
  }
  if (preferencesResult.error !== null || preferencesResult.rows === null) {
    return { ok: false, reason: `search_preferences query failed: ${preferencesResult.error ?? "no rows returned"}` };
  }

  // Past this point every read genuinely succeeded, so an empty collection below means
  // an empty table — a real state, correctly carried as emptiness.

  // Slugs, as a Set because the rule tests membership per job.
  const blockedCompanySlugs = new Set(blockedResult.rows.map((row) => row.company_slug));

  // Every fingerprint ever applied to. NOT windowed: already_applied must remember
  // forever, or the cascade would re-offer a posting Teja applied to last month.
  const appliedFingerprints = new Set<string>();
  // Only the trailing week, per company. Windowed, because the cap is a RATE.
  const applicationsThisWeekByCompany = new Map<string, number>();
  // The boundary, computed once from the injected clock.
  const windowStart = now.getTime() - TRAILING_WINDOW_MS;

  // One pass serves both structures.
  for (const row of historyResult.rows) {
    // Unconditional: applying is permanent regardless of when it happened.
    appliedFingerprints.add(row.fingerprint);
    // The commit instant, or null when it is missing or not a real timestamp.
    const committedAt = strictTimestampMs(row.committed_at);
    // A MISSING OR MALFORMED COMMIT TIME COUNTS AS THIS WEEK — fail closed. The two
    // errors are not symmetric: an unstamped row never ages out, so it over-counts that
    // company EVERY week (reachable only via a legacy or hand-edited row: the guard
    // stamps approved_at on the only road into a committed status); under-counting lets
    // the cap be blown past. So only a provably old
    // commitment leaves the window.
    // Outside the window: it still counts as applied, just not against this week.
    if (committedAt !== null && committedAt < windowStart) continue;
    // Inside the window: increment this company's tally.
    applicationsThisWeekByCompany.set(row.company_slug, (applicationsThisWeekByCompany.get(row.company_slug) ?? 0) + 1);
  }

  // NO PREFERENCES ROW IS A NORMAL STATE, NOT A FAILURE — the bootstrap that would
  // create one currently rolls back for every user on an unrelated column-name bug. An
  // absent row yields an OPEN gate: it passes everything and warns on each unclassified
  // title, which is the designed fail-open direction. Treating it as an error would stop
  // the scout entirely over a missing setting.
  const preferencesRow = preferencesResult.rows[0];

  return {
    ok: true,
    value: {
      // Mapped to the gate's own field names here, so no caller has to remember that the
      // column is `excluded_keywords` and the interface is `excludedKeywords`. `?? []`
      // guards both the missing row and a null array column.
      preferences: {
        titles: preferencesRow?.titles ?? [],
        keywords: preferencesRow?.keywords ?? [],
        excludedKeywords: preferencesRow?.excluded_keywords ?? [],
        // ONLY a real boolean is an answer. A missing row, a missing key, null, or any
        // non-boolean junk all collapse to null = unanswered, which opens the gate rather
        // than dropping on missing data (CLAUDE.md section 6).
        usWorkAuthorized: typeof preferencesRow?.us_work_authorized === "boolean" ? preferencesRow.us_work_authorized : null,
      },
      // Passed through untouched, `sort_order` included — the cascade sorts on it, so
      // re-deriving or reordering here would silently reshape the whole cascade.
      rules: rulesResult.rows,
      context: { now, appliedFingerprints, blockedCompanySlugs, applicationsThisWeekByCompany },
    },
  };
}
