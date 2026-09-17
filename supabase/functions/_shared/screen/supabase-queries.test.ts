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
  return {
    from(table: string) {
      return {
        select: () => Promise.resolve(responses[table] ?? { data: [], error: null }),
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
        data: [{ created_at: "2026-09-16T00:00:00.000Z", jobs: { fingerprint: "fp-1", company_slug: "zomato" } }],
        error: null,
      },
    }),
    NOW,
  );
  assert.deepEqual((await queries.applicationHistory()).rows, [
    { fingerprint: "fp-1", company_slug: "zomato", created_at: "2026-09-16T00:00:00.000Z" },
  ]);
});

// An application whose job row is missing carries no fingerprint to match on. Emitting
// it with an undefined fingerprint would poison the applied-set with a junk member; it
// is skipped instead, and skipping is safe because the database's UNIQUE(user_id, job_id)
// remains the real guarantee against applying twice.
test("an application with no joined job is skipped rather than emitted undefined", async () => {
  const queries = supabaseScreenQueries(
    client({
      applications: { data: [{ created_at: "2026-09-16T00:00:00.000Z", jobs: null }], error: null },
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
