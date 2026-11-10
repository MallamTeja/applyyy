// Tests for the Supabase adapter behind the Screener's three reads.
//
// WHAT IS WORTH TESTING IN GLUE, and what is not. Issuing a select is not worth a test.
// Two things here genuinely decide whether a rule enforces anything:
//   1. `blocked_until` — a time-limited block must EXPIRE without anyone remembering to
//      delete the row, and an expired block must stop dropping jobs.
//   2. the jobs join — application history arrives nested, and a flattening bug would
//      hand the cascade `undefined` fingerprints, which `Set.has` answers `false` to.
//      already_applied would then silently stop recognising anything.
// Both are cases where a mistake produces a working-looking screener that enforces less
// than it claims, which is the failure this parcel exists to remove.
import { test } from "node:test";
// Strict, so an undefined field never compares equal to null.
import assert from "node:assert/strict";
// Extension-suffixed specifier so this runs under Deno and `node --test` alike.
import { supabaseScreenQueries } from "./supabase-queries.ts";

// A fixed clock, so block expiry is assertable rather than flaky.
const NOW = new Date("2026-09-17T12:00:00.000Z");

// A client double: one canned response per table, recorded by name.
function client(responses: Record<string, { data: unknown[] | null; error: { message: string } | null }>) {
  // What supabase-js puts in `count`: the server total when `{ count: "exact" }` was asked
  // (these fixtures are tiny, so the total is data.length), else null as the real client does.
  // An error response carries no count, so a count check can never mask its message.
  const countOf = (data: unknown[] | null, options?: { count?: string }) =>
    options?.count === "exact" && data !== null ? data.length : null;
  return {
    from(table: string) {
      // This table's canned response, or a legitimately empty one.
      const response = responses[table] ?? { data: [], error: null };
      return {
        // Awaitable directly (unfiltered tables), and offering `.in()` like the
        // supabase-js builder so the status-filtered history read can run.
        // `options` is read because the history read now requests an exact count.
        select: (_columns: string, options?: { count?: string }) =>
          // The unfiltered await gets the count too, matching the real builder.
          Object.assign(Promise.resolve({ ...response, count: countOf(response.data, options) }), {
            // Applies the predicate as Postgres would; rows without the column drop out,
            // so canned history rows must carry a committed `status`.
            in: (column: string, values: readonly string[]) =>
              Promise.resolve(
                response.data === null
                  ? // No data: count null, exactly as supabase-js reports a failed read.
                    { ...response, count: null }
                  : (() => {
                      // Filter first: the server counts rows AFTER the predicate.
                      const kept = response.data.filter((row) => values.includes((row as Record<string, string>)[column]!));
                      // Complete read, so count matches what was returned.
                      return { ...response, data: kept, count: countOf(kept, options) };
                    })(),
              ),
          }),
      };
    },
  };
}

// --- blocked_until ------------------------------------------------------------------

// A null `blocked_until` is a permanent block and must always apply.
test("a block with no expiry is always active", async () => {
  const queries = supabaseScreenQueries(
    client({ company_blocklist: { data: [{ company_slug: "badcorp", blocked_until: null }], error: null } }),
    NOW,
  );
  const result = await queries.blockedCompanies();
  assert.deepEqual(result.rows, [{ company_slug: "badcorp" }]);
});

// A future expiry is still in force.
test("a block whose expiry is in the future is still active", async () => {
  const queries = supabaseScreenQueries(
    client({
      company_blocklist: { data: [{ company_slug: "badcorp", blocked_until: "2026-10-01T00:00:00.000Z" }], error: null },
    }),
    NOW,
  );
  assert.deepEqual((await queries.blockedCompanies()).rows, [{ company_slug: "badcorp" }]);
});

// THE ONE THAT MATTERS. An expired block must stop applying on its own — that is the
// entire reason the column exists. Leaving it active would silently keep dropping a
// company Teja deliberately un-blocked by letting the timer run out.
test("a block whose expiry has passed is dropped", async () => {
  const queries = supabaseScreenQueries(
    client({
      company_blocklist: { data: [{ company_slug: "oldcorp", blocked_until: "2026-09-01T00:00:00.000Z" }], error: null },
    }),
    NOW,
  );
  assert.deepEqual((await queries.blockedCompanies()).rows, []);
});

// An unparseable timestamp must not silently un-block a company. `Date.parse` is lenient
// enough to turn junk into a date, so the shape is validated rather than trusted — if we
// cannot tell when a block expires, the block stands.
test("an unparseable expiry keeps the block rather than dropping it", async () => {
  const queries = supabaseScreenQueries(
    client({ company_blocklist: { data: [{ company_slug: "oddcorp", blocked_until: "not-a-date" }], error: null } }),
    NOW,
  );
  assert.deepEqual((await queries.blockedCompanies()).rows, [{ company_slug: "oddcorp" }]);
});

// --- the jobs join -------------------------------------------------------------------

// PostgREST returns the joined job nested. Flattening it wrong would hand the cascade
// undefined fingerprints, and already_applied would quietly match nothing.
test("nested job rows are flattened into fingerprint and company slug", async () => {
  const queries = supabaseScreenQueries(
    client({
      applications: {
        // `applied`, so the row survives the committed-status filter and the test stays
        // about flattening. `applied_at` set, so the commit stamp is flattened too.
        data: [
          {
            status: "applied",
            approved_at: "2026-09-15T00:00:00.000Z",
            applied_at: "2026-09-16T00:00:00.000Z",
            // company_name and title feed the cross-source set (T12, 2026-11-10), so the input carries them too.
            jobs: { fingerprint: "fp-1", company_slug: "zomato", company_name: "Zomato", title: "Backend Engineer", ats_provider: "greenhouse" },
          },
        ],
        error: null,
      },
    }),
    NOW,
  );
  assert.deepEqual((await queries.applicationHistory()).rows, [
    // applied_at wins over approved_at: submission is the later, precise commit event.
    // The job's company and title pass through unchanged (T12): the context folds them, the adapter does not.
    { fingerprint: "fp-1", company_slug: "zomato", company_name: "Zomato", title: "Backend Engineer", ats_provider: "greenhouse", committed_at: "2026-09-16T00:00:00.000Z" },
  ]);
});

// An application whose job row is missing carries no fingerprint to match on. Emitting
// it with an undefined fingerprint would poison the applied-set with a junk member; it
// is skipped instead, and skipping is safe because the database's UNIQUE(user_id, job_id)
// remains the real guarantee against applying twice.
test("an application with no joined job is skipped rather than emitted undefined", async () => {
  const queries = supabaseScreenQueries(
    client({
      // `applied`, so the null-job skip — not the status filter — is what removes it.
      applications: { data: [{ status: "applied", created_at: "2026-09-16T00:00:00.000Z", jobs: null }], error: null },
    }),
    NOW,
  );
  assert.deepEqual((await queries.applicationHistory()).rows, []);
});

// --- errors ---------------------------------------------------------------------------

// The adapter must carry an error through as an error. Absorbing it here would defeat
// the whole point of the loader's failure handling one layer up.
test("a query error is carried through with its message and null rows", async () => {
  const queries = supabaseScreenQueries(
    client({ filter_rules: { data: null, error: { message: "permission denied" } } }),
    NOW,
  );
  const result = await queries.filterRules();
  assert.equal(result.rows, null);
  assert.equal(result.error, "permission denied");
});
