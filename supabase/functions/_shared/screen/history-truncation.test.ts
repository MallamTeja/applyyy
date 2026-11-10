// Tests that the Screener's committed-application history is never a silent partial set.
//
// THE BUG THESE PIN. PostgREST caps every response at max_rows (1000) and says nothing
// about it. A user with more than 1000 committed applications got the first 1000 back as
// if that were all of them, so already_applied missed the rest (and the per-company weekly
// cap, retired 2026-11-10 by Teja's "remove it", UNDERCOUNTED): the fail-open of repo
// CLAUDE.md §6 (missing data becoming an answer). already_applied still depends on this.
// The fix asks the server for `{ count: "exact" }` and refuses any read whose count is
// absent or disagrees with the rows it actually received.
import { test } from "node:test";
// Strict, so a null and an undefined never compare equal.
import assert from "node:assert/strict";
// The loader, so the refusal is proven to stop the cascade and not just the adapter.
import { loadScreenContext } from "./context.ts";
// The adapter under test, by its extension-suffixed path so Deno and node agree.
import { supabaseScreenQueries } from "./supabase-queries.ts";

// A fixed clock, so nothing here depends on when the suite runs.
const NOW = new Date("2026-09-17T12:00:00.000Z");
// PostgREST's default max_rows: the most rows one response can ever carry.
const MAX_ROWS = 1000;

// N distinct committed rows, so a dropped row is a real, distinct missing application.
function appliedRows(n: number): Array<Record<string, unknown>> {
  // One `applied` row per index, each stamped, each on its own fingerprint.
  return Array.from({ length: n }, (_, i) => ({
    // Committed, so it passes the server-side status predicate.
    status: "applied",
    // Stamped, so the row is a well-formed commitment and only the count is under test.
    approved_at: "2026-09-16T00:00:00.000Z",
    // Applied stamp present, so committed_at is unambiguous.
    applied_at: "2026-09-16T00:00:00.000Z",
    // A unique job, so 1001 rows means 1001 distinct already-applied fingerprints.
    jobs: { fingerprint: `fp-${i}`, company_slug: "acme" },
  }));
}

// What the fake answers for `applications`: canned rows, or a canned error.
type Canned =
  // A successful read of these rows, BEFORE the page cap is applied.
  | { readonly rows: Array<Record<string, unknown>>; readonly ignoreCount?: boolean }
  // A failed read: supabase-js gives data null, count null, and the error.
  | { readonly error: string };

// A client double that behaves like supabase-js over PostgREST, and nothing kinder:
//  - it never throws; every outcome is a resolved `{ data, error, count }`;
//  - a page holds AT MOST 1000 rows, even when more are canned (the max_rows cut);
//  - `count` is the full server-side total ONLY when `{ count: "exact" }` was requested,
//    else null, as supabase-js returns when no count was asked for;
//  - `ignoreCount` models a server that drops the count anyway (null regardless).
function fakeClient(canned: Canned) {
  // Every `select` options argument, so a test can assert what was requested.
  const selectOptions: unknown[] = [];
  // The client itself; the other three tables answer empty so only history is under test.
  const client = {
    from(table: string) {
      // Shape one response from a set of rows already narrowed by the predicate.
      const respond = (rows: Array<Record<string, unknown>>, options?: { count?: string }) => {
        // A failed read carries no data and no count, only the message.
        if ("error" in canned) return { data: null, error: { message: canned.error }, count: null };
        // Count is reported only when asked for, and never when the server drops it.
        const counted = options?.count === "exact" && canned.ignoreCount !== true;
        // The page is cut at max_rows; the count still reports the true total.
        return { data: rows.slice(0, MAX_ROWS), error: null, count: counted ? rows.length : null };
      };
      // Only `applications` carries rows here; the other reads are legitimately empty.
      const rows = table === "applications" && "rows" in canned ? canned.rows : [];
      // The non-history tables never error, so the loader's only failure path is history.
      const isHistory = table === "applications";
      return {
        // Record options before answering, so the assertion sees exactly what was sent.
        select(_columns: string, options?: { count?: string }) {
          // Only the history read's options matter; recording others would blur the test.
          if (isHistory) selectOptions.push(options);
          // Awaitable directly (the three unfiltered tables), like the real builder.
          return Object.assign(Promise.resolve(isHistory ? respond(rows, options) : { data: [], error: null, count: null }), {
            // The server-side status predicate, then the page cap, then the count.
            in(column: string, values: readonly string[]) {
              // Filter as Postgres would, so the count is the post-predicate total.
              const kept = rows.filter((row) => values.includes(row[column] as string));
              // Same response shape as the direct await, from the filtered set.
              return Promise.resolve(respond(kept, options));
            },
          });
        },
      };
    },
  };
  // The client for the code, the recorder for the assertions.
  return { client, selectOptions };
}

// 1. More rows than one page: the read must refuse rather than return the first 1000.
test("history refuses a truncated read: 1001 committed rows across two pages' worth", async () => {
  // 1001 real commitments; the fake returns 1000 of them with count 1001.
  const { client } = fakeClient({ rows: appliedRows(MAX_ROWS + 1) });
  // The adapter alone first, so the refusal is pinned at its source.
  const result = await supabaseScreenQueries(client, NOW).applicationHistory();
  // No partial set reaches the cascade: rows must be null, not 1000 of 1001.
  assert.equal(result.rows, null);
  // The error names the cause, so agent_runs.error_detail says why the run stopped.
  assert.match(result.error ?? "", /^history_truncated/);
  // Both numbers are in it, so the operator sees the size of the gap.
  assert.match(result.error ?? "", /1001/);
  // And 1000, the page that actually arrived.
  assert.match(result.error ?? "", /1000/);
  // Through the loader, the refusal must stop the whole screen run (fail closed).
  const loaded = await loadScreenContext(supabaseScreenQueries(fakeClient({ rows: appliedRows(MAX_ROWS + 1) }).client, NOW), NOW);
  // ok:false, so no job is screened against a history known to be incomplete.
  assert.equal(loaded.ok, false);
});

// 2. A server that never returns a count gives no way to prove completeness.
test("history fails closed when the server returns no count", async () => {
  // Five rows, but the count is dropped even though it was requested.
  const { client } = fakeClient({ rows: appliedRows(5), ignoreCount: true });
  // The adapter is asked directly.
  const result = await supabaseScreenQueries(client, NOW).applicationHistory();
  // Unprovable completeness is treated as incompleteness: no rows.
  assert.equal(result.rows, null);
  // A distinct prefix, so "no count" is not confused with "count disagreed".
  assert.match(result.error ?? "", /^history_count_unavailable/);
});

// 2b. postgrest-js parseInt()s Content-Range, so a "0-4/*" header yields count NaN.
// NaN is typeof "number", so a typeof guard would let it through and blame truncation.
test("a NaN count is reported as unavailable, not as truncation", async () => {
  // Five real rows; only the count is malformed.
  const rows = appliedRows(5);
  // An inline fake: the shared one models counts that are honest or absent, not garbage.
  const client = {
    // Every table resolves the same way; only the history read is exercised here.
    from: () => ({
      // The exact-count option is accepted and ignored, as a misbehaving server would.
      select: () => ({
        // Like supabase-js: resolves, never throws, carries the parsed (NaN) count.
        in: () => Promise.resolve({ data: rows, error: null, count: Number.NaN }),
      }),
    }),
  };
  // The adapter is asked directly.
  const result = await supabaseScreenQueries(client, NOW).applicationHistory();
  // Still no rows: an unreadable count proves nothing.
  assert.equal(result.rows, null);
  // And the right guard is named, so error_detail points at the count, not max_rows.
  assert.match(result.error ?? "", /^history_count_unavailable/);
});

// 3. The boundary: exactly one full page is complete, so the guard must not be off by one.
test("exactly 1000 committed rows is complete, not truncated", async () => {
  // 1000 rows, count 1000: everything that exists arrived.
  const { client } = fakeClient({ rows: appliedRows(MAX_ROWS) });
  // The adapter is asked directly.
  const result = await supabaseScreenQueries(client, NOW).applicationHistory();
  // No error, so a `>=` guard (refusing a full but complete page) would fail here.
  assert.equal(result.error, null);
  // Every row came through, flattened, none dropped.
  assert.equal(result.rows?.length, MAX_ROWS);
});

// 4. The count must be requested, or the guard has nothing to compare against.
test("history requests an exact count", async () => {
  // A small, complete history; only the request shape is under test.
  const { client, selectOptions } = fakeClient({ rows: appliedRows(3) });
  // Issue the read.
  await supabaseScreenQueries(client, NOW).applicationHistory();
  // Exactly one history select, with the exact-count option: the positive shape.
  assert.deepEqual(selectOptions, [{ count: "exact" }]);
});

// 5. A real error keeps its own message; the count check must not overwrite it.
test("a history query error surfaces its original message, not a count complaint", async () => {
  // data null, count null, error set: what supabase-js returns on a failed read.
  const { client } = fakeClient({ error: "permission denied for table applications" });
  // The adapter is asked directly.
  const result = await supabaseScreenQueries(client, NOW).applicationHistory();
  // No rows on an error.
  assert.equal(result.rows, null);
  // The original message, verbatim: count null here must NOT become history_count_unavailable.
  assert.equal(result.error, "permission denied for table applications");
});
