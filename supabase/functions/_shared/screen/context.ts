// Loading the Screener's database context.
//
// WHY THIS IS A SEPARATE MODULE FROM THE CASCADE. `screenJob` is pure by design — no
// database, no clock, no network — which is exactly what makes the whole cascade
// table-driven testable. The price of that purity is that SOMETHING has to fetch the
// four things it cannot fetch itself. This is that something, and it is kept narrow so
// the impurity lives in one place both scouts share.
//
// THE FAILURE THAT MATTERS, and it is not a crash. Two of the rules — already_applied and
// company_blocklist — read nothing from the job row; they read this context and nothing
// else. So if a query fails and this function hands back an empty context anyway, those
// rules return drop:false for every job, forever, and the cascade reports a clean pass. No
// error, no warning, no log line. Part of the screener stops working and every observable
// signal says it is fine. (A third such rule, per_company_weekly_cap, was retired on
// 2026-11-10 — Teja: "remove it" — so this context no longer carries a weekly count.)
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
// The remote policy's closed union and its literals, owned by the gate that reads them.
import { REMOTE_LOCATION_POLICIES, type RemoteLocationPolicy } from "./work-auth-gate.ts";

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
  // Fed the per-company weekly cap, retired 2026-11-10. Still in the row because the query
  // adapter (supabase-queries.ts) still selects it; the loader no longer reads it.
  readonly company_slug: string;
  // WHEN TEJA COMMITTED: `applied_at ?? approved_at`, coalesced by the adapter that knows
  // the columns. Decides whether this one falls inside the trailing week. RENAMED from
  // `created_at` (2026-10-08): that column is DISCOVERY time, and windowing on it let a
  // job found last month and approved today escape this week's cap. UNREAD since 2026-11-10:
  // the cap it windowed is retired, and already_applied is not windowed at all. Kept in the
  // type only because the query adapter still returns it.
  readonly committed_at: string | null;
}

// The four reads the Screener needs.
//
// A NARROW PORT RATHER THAN A `SupabaseClient`, matching the seam `_shared/agent/port.ts`
// already establishes for every other agent: a client cannot be built under
// `node --test`, so a module that reaches for one directly is a module whose failure
// handling is untestable — and the failure handling is the entire point here.
//
// FOUR CALLS: the application history now serves only applied fingerprints (it also fed
// the weekly counts until the cap was retired on 2026-11-10). The fourth call is stage 0's
// config, which is not part of the cascade at all.
export interface ScreenQueries {
  // The cascade's rules, thresholds and ORDER. Nothing is hardcoded — §8 says every row
  // is a settings field, and `sort_order` makes re-ordering a settings change.
  filterRules(): Promise<ScreenQueryResult<FilterRuleRow>>;
  // Slugs currently blocked.
  blockedCompanies(): Promise<ScreenQueryResult<{ readonly company_slug: string }>>;
  // Every application Teja has COMMITTED to (a committed status; a `failed` row only if
  // it was ever approved), with the fingerprint already_applied needs.
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
  // The countries the user may work in without a visa, for the work-auth gate. Optional in the
  // TYPE because a row read before migration 20261024190000 has no such key; absent and null
  // both mean "never set", and the gate stays open for that.
  readonly work_authorized_countries?: readonly string[] | null;
  // What a remote location part means (migration 20261104193000, Teja 2026-11-04). Optional in
  // the TYPE for the same reason as the list above: a row read before the migration has no key.
  readonly remote_location_policy?: string | null;
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

// (TRAILING_WINDOW_MS and the strict ISO timestamp check lived here. They existed only to
// window the per-company weekly count, removed 2026-11-10 with the cap — Teja: "remove it".)

// The usable entries of a stored country list, or null when there are none. An EMPTY list is
// read as "never set", not "nowhere": the Settings page saves null for an empty box, so an
// empty array can only come from a hand edit, and reading it as "authorised nowhere" would drop
// every on-site job on a single slip.
// EXPORTED 2026-11-04 so the matcher's pre-gate reads the column through this same shape check
// rather than a second, drifting copy.
export function countryList(value: unknown): readonly string[] | null {
  // Not a list at all: never set.
  if (!Array.isArray(value)) return null;
  // Real, non-blank strings only, trimmed.
  const entries = value.filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "").map((entry) => entry.trim());
  // Nothing usable left: never set.
  return entries.length > 0 ? entries : null;
}

// The stored remote policy by SHAPE: exactly one of the two literals, or 'any' for anything else.
// 'any' is the fail-open reading (it keeps every remote part, the 10-24 behaviour), because a
// missing or garbled setting must never become a rejection (CLAUDE.md section 6). After migration
// 20261104193000 the column is NOT NULL with a CHECK, so this fallback is reachable only by a row
// read without the column. Shared by the screener and the matcher.
export function remoteLocationPolicy(value: unknown): RemoteLocationPolicy {
  // Only a known literal is an answer; `includes` on the closed list is the shape check.
  return REMOTE_LOCATION_POLICIES.includes(value as RemoteLocationPolicy) ? (value as RemoteLocationPolicy) : "any";
}

// Fetch everything the cascade needs that is not on the job row.
//
// The clock is INJECTED rather than read here and passed straight into the context, for
// the same reason the cascade takes `now`: so any time-based rule is assertable rather
// than flaky.
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
  // NO PER-COMPANY WEEKLY COUNT IS BUILT HERE ANY MORE. The cap that read it was retired on
  // 2026-11-10 (Teja: "remove it"), and ScreenContext dropped the field, so counting would
  // be dead work. context.test.ts pins the exact key set so it cannot creep back.

  // One pass over the history.
  for (const row of historyResult.rows) {
    // Unconditional: applying is permanent regardless of when it happened.
    appliedFingerprints.add(row.fingerprint);
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
        // ONLY a non-empty list of non-blank strings is an answer. A missing row or key, null,
        // a non-array, or a list with nothing usable in it all collapse to null = never set,
        // which opens the gate rather than dropping every on-site job (CLAUDE.md section 6).
        workAuthorizedCountries: countryList(preferencesRow?.work_authorized_countries),
        // One of the two literals; anything else reads as 'any', the fail-open policy.
        remoteLocationPolicy: remoteLocationPolicy(preferencesRow?.remote_location_policy),
      },
      // Passed through untouched, `sort_order` included — the cascade sorts on it, so
      // re-deriving or reordering here would silently reshape the whole cascade.
      rules: rulesResult.rows,
      context: { now, appliedFingerprints, blockedCompanySlugs },
    },
  };
}
