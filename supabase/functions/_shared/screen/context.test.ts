// Tests for loading the Screener's database context.
//
// WHAT IS ACTUALLY AT RISK HERE, and it is not the happy path. Three of the nine
// cascade rules — already_applied, company_blocklist, per_company_weekly_cap — read
// nothing from the job row. They read this context. If a query fails and the loader
// hands back an EMPTY context anyway, all three return drop:false for every job and the
// cascade reports a clean pass. Nothing errors. Nothing warns. The screener appears to
// work and silently stops enforcing a third of its rules.
//
// That is the failure pattern this whole parcel exists to clean up — missing data
// becoming an answer — so the loader must distinguish "no rows" from "the query
// failed", and these tests exist mainly to pin that distinction.
import { test } from "node:test";
// Strict, so an empty Set never quietly compares equal to undefined.
import assert from "node:assert/strict";
// Extension-suffixed specifier so this runs under Deno and `node --test` alike.
import { loadScreenContext, type ScreenQueries } from "./context.ts";
// Row shapes from the schema owner.
import type { FilterRuleRow } from "../contracts/shared-types.ts";

// A fixed clock, so the trailing-week window is assertable rather than flaky.
const NOW = new Date("2026-09-17T12:00:00.000Z");

// One stored rule, to prove rules are passed through rather than re-derived.
const STORED_RULE: FilterRuleRow = {
  id: "rule-title",
  user_id: "user-1",
  rule_type: "title_blocklist",
  enabled: true,
  config: { blocked_titles: ["senior"] },
  sort_order: 1,
  created_at: "2026-09-01T00:00:00.000Z",
  updated_at: "2026-09-01T00:00:00.000Z",
};

// A queries double that succeeds, with per-call overrides so each test breaks one thing.
function queries(overrides: Partial<ScreenQueries> = {}): ScreenQueries {
  return {
    filterRules: () => Promise.resolve({ rows: [STORED_RULE], error: null }),
    blockedCompanies: () => Promise.resolve({ rows: [{ company_slug: "badcorp" }], error: null }),
    applicationHistory: () => Promise.resolve({ rows: [], error: null }),
    searchPreferences: () =>
      Promise.resolve({ rows: [{ titles: ["engineer"], keywords: ["react"], excluded_keywords: ["sales"] }], error: null }),
    ...overrides,
  };
}

// --- the happy path ---------------------------------------------------------------

// The rules reach the cascade unaltered, including `sort_order` — the cascade sorts on
// it, so losing it would silently reorder the whole cascade.
test("stored filter rules are passed through with their ordering intact", async () => {
  const result = await loadScreenContext(queries(), NOW);
  assert.equal(result.ok, true);
  assert.equal(result.ok && result.value.rules.length, 1);
  assert.equal(result.ok && result.value.rules[0]!.sort_order, 1);
});

// The blocklist is joined on the slug, so it has to arrive as a Set of slugs.
test("blocked company slugs arrive as a set the cascade can test membership against", async () => {
  const result = await loadScreenContext(queries(), NOW);
  assert.equal(result.ok && result.value.context.blockedCompanySlugs.has("badcorp"), true);
});

// One query serves two rules. Application history carries both the fingerprint (for
// already_applied) and the company slug plus a date (for the weekly cap), so deriving
// both from a single round trip is cheaper and cannot let the two disagree.
test("application history yields both applied fingerprints and weekly counts", async () => {
  const result = await loadScreenContext(
    queries({
      applicationHistory: () =>
        Promise.resolve({
          rows: [
            // Inside the trailing week, so it counts toward the cap.
            // committed_at = applied_at ?? approved_at (renamed from created_at, which is
            // discovery time). A null one now COUNTS: see application-history-status.test.ts.
            { fingerprint: "fp-old", company_slug: "zomato", committed_at: "2026-09-15T12:00:00.000Z" },
            { fingerprint: "fp-older", company_slug: "zomato", committed_at: "2026-09-16T12:00:00.000Z" },
          ],
          error: null,
        }),
    }),
    NOW,
  );
  assert.equal(result.ok && result.value.context.appliedFingerprints.has("fp-old"), true);
  assert.equal(result.ok && result.value.context.applicationsThisWeekByCompany.get("zomato"), 2);
});

// The cap is a TRAILING-WEEK count, so an older application must still block a repeat
// application (already_applied) without inflating this week's tally.
test("an application older than a week counts as applied but not toward the weekly cap", async () => {
  const result = await loadScreenContext(
    queries({
      applicationHistory: () =>
        Promise.resolve({
          rows: [{ fingerprint: "fp-ancient", company_slug: "zomato", committed_at: "2026-08-01T12:00:00.000Z" }],
          error: null,
        }),
    }),
    NOW,
  );
  // Still remembered, because we genuinely did apply to it.
  assert.equal(result.ok && result.value.context.appliedFingerprints.has("fp-ancient"), true);
  // But outside the window, so it must not consume this week's quota.
  assert.equal(result.ok && result.value.context.applicationsThisWeekByCompany.get("zomato"), undefined);
});

// --- the failures, which are the point --------------------------------------------

// If the rules cannot be read there is nothing to enforce, and screening anyway would
// pass every job while looking like a successful screen. The loader must refuse.
test("a failed filter_rules query is reported, never treated as zero rules", async () => {
  const result = await loadScreenContext(
    queries({ filterRules: () => Promise.resolve({ rows: null, error: "connection reset" }) }),
    NOW,
  );
  assert.equal(result.ok, false);
  assert.match(!result.ok ? result.reason : "", /filter_rules/);
});

// The subtler one. A blocklist query that fails and is read as "nothing is blocked"
// disables company_blocklist silently — the rule still runs, still returns drop:false,
// and nothing anywhere says it stopped working.
test("a failed blocklist query is reported, never treated as nothing blocked", async () => {
  const result = await loadScreenContext(
    queries({ blockedCompanies: () => Promise.resolve({ rows: null, error: "permission denied" }) }),
    NOW,
  );
  assert.equal(result.ok, false);
  assert.match(!result.ok ? result.reason : "", /company_blocklist/);
});

// Same shape again for the history query, which backs two rules rather than one.
test("a failed history query is reported, never treated as no history", async () => {
  const result = await loadScreenContext(
    queries({ applicationHistory: () => Promise.resolve({ rows: null, error: "timeout" }) }),
    NOW,
  );
  assert.equal(result.ok, false);
  assert.match(!result.ok ? result.reason : "", /applications/);
});

// THE DISTINCTION THE WHOLE FILE IS ABOUT. A genuinely empty table is a legitimate,
// common state — a new user has applied to nothing — and must succeed with an empty
// context. Only an ERROR is a failure. Collapsing the two in either direction is the
// bug: treat errors as empty and rules stop being enforced; treat empty as an error and
// a new user's first scout run never produces anything.
test("genuinely empty tables succeed with an empty context", async () => {
  const result = await loadScreenContext(
    queries({
      blockedCompanies: () => Promise.resolve({ rows: [], error: null }),
      applicationHistory: () => Promise.resolve({ rows: [], error: null }),
    }),
    NOW,
  );
  assert.equal(result.ok, true);
  assert.equal(result.ok && result.value.context.blockedCompanySlugs.size, 0);
  assert.equal(result.ok && result.value.context.appliedFingerprints.size, 0);
});

// The clock is injected rather than read inside, so the trailing-week boundary is
// assertable. This pins that the loader uses the clock it was given.
test("the injected clock is the one the context carries", async () => {
  const result = await loadScreenContext(queries(), NOW);
  assert.equal(result.ok && result.value.context.now.toISOString(), "2026-09-17T12:00:00.000Z");
});

// --- stage-0 preferences -------------------------------------------------------------

// The tech gate reads `search_preferences`, so the loader has to carry them alongside
// the cascade's own context. Mapped to the gate's field names here so no caller has to
// remember that the column is snake_case and the interface is not.
test("search preferences are loaded and mapped for the tech gate", async () => {
  const result = await loadScreenContext(queries(), NOW);
  assert.equal(result.ok && result.value.preferences.titles[0], "engineer");
  assert.equal(result.ok && result.value.preferences.excludedKeywords[0], "sales");
});

// A user with no preferences row is a NORMAL state — the bootstrap that would create one
// currently rolls back for every user — and it must produce an open gate rather than a
// failure. An open gate passes everything and warns, which is the designed fail-open
// direction; treating it as an error would stop the scout running at all.
test("a missing preferences row yields an open gate rather than an error", async () => {
  const result = await loadScreenContext(queries({ searchPreferences: () => Promise.resolve({ rows: [], error: null }) }), NOW);
  assert.equal(result.ok, true);
  assert.deepEqual(result.ok && result.value.preferences, { titles: [], keywords: [], excludedKeywords: [] });
});

// An ERROR is still an error, even though an empty result is not. The same distinction
// the rest of this file turns on, applied to the fourth read.
test("a failed preferences query is reported rather than silently opening the gate", async () => {
  const result = await loadScreenContext(
    queries({ searchPreferences: () => Promise.resolve({ rows: null, error: "timeout" }) }),
    NOW,
  );
  assert.equal(result.ok, false);
  assert.match(!result.ok ? result.reason : "", /search_preferences/);
});

// Null array columns must not crash the mapper. Postgres defaults them to '{}', but a
// row written before those defaults existed can still carry nulls.
test("null array columns map to empty lists", async () => {
  const result = await loadScreenContext(
    queries({
      searchPreferences: () => Promise.resolve({ rows: [{ titles: null, keywords: null, excluded_keywords: null }], error: null }),
    }),
    NOW,
  );
  assert.deepEqual(result.ok && result.value.preferences.titles, []);
});
