// Tests for the referral queue query. The fake client applies each filter to a row list
// the way PostgREST would, so the test proves which rows come back, not only which
// arguments were passed.
import { test } from "node:test";
// Strict, so a reordered or widened status list never compares equal.
import assert from "node:assert/strict";
// Reads index.ts as text, to prove the entrypoint routes through the tested query.
import { readFileSync } from "node:fs";
// Unit under test; extension-suffixed so this runs under Deno and node --test alike.
import { REFERRAL_ELIGIBLE_STATUSES, selectReferralQueue } from "./eligible-queue.ts";
// The client type the function takes; type-only, so node strips it.
import type { SupabaseClient } from "jsr:@supabase/supabase-js@2.58.0";

// One row per pipeline status, so any status that leaks into the result is visible.
const ALL_STATUSES = [
  "discovered", "deduped", "dropped_filter", "passed_filters", "scored", "tailored",
  "audit_clean", "audit_flagged", "awaiting_approval", "approved", "applying",
  "blocked_needs_human", "applied", "failed",
];

// The minimal row shape the fake filters on.
type FakeRow = { id: string; status: string; created_at: string };

// A fake supabase client over `rows` that records every filter call it receives.
function fakeClient(rows: FakeRow[]) {
  // Every builder call, in order, for assertions on the exact query shape.
  const calls: { method: string; args: unknown[] }[] = [];
  // The rows still matching after each filter; starts as a copy so the input is untouched.
  let current = [...rows];
  // One builder object; each method records, narrows `current`, and returns the builder.
  const builder = {
    // Table and column list are recorded only; the fake has a single table.
    select: (...args: unknown[]) => (calls.push({ method: "select", args }), builder),
    // `.in(column, values)` keeps rows whose column is one of the values.
    in: (column: string, values: readonly string[]) => {
      // Recorded as a plain array copy so a later mutation cannot change the evidence.
      calls.push({ method: "in", args: [column, [...values]] });
      // PostgREST semantics: membership test on the named column.
      current = current.filter((r) => values.includes(r[column as keyof FakeRow]));
      // Chainable, like the real builder.
      return builder;
    },
    // `.not(column, "in", "(a,b)")` drops rows whose column is in the list.
    not: (column: string, op: string, list: string) => {
      // Recorded verbatim, including the parenthesised list.
      calls.push({ method: "not", args: [column, op, list] });
      // Strip the parentheses and split, as PostgREST parses the value.
      const ids = list.slice(1, -1).split(",");
      // Only the `in` operator is used by the unit under test.
      current = current.filter((r) => !ids.includes(r[column as keyof FakeRow]));
      // Chainable, like the real builder.
      return builder;
    },
    // Ascending sort by the named column; the only direction the unit uses.
    order: (column: string, opts: unknown) => {
      // Recorded so a dropped FIFO order fails the shape assertion.
      calls.push({ method: "order", args: [column, opts] });
      // ISO timestamps sort correctly as strings.
      current.sort((a, b) => a[column as keyof FakeRow].localeCompare(b[column as keyof FakeRow]));
      // Chainable, like the real builder.
      return builder;
    },
    // Keeps the first `n` rows.
    limit: (n: number) => {
      // Recorded so the batch cap is asserted, not assumed.
      calls.push({ method: "limit", args: [n] });
      // Truncate after filtering, as the database does.
      current = current.slice(0, n);
      // Chainable, like the real builder.
      return builder;
    },
    // Awaiting the builder resolves the way supabase-js does: `{ data, error }`, never a throw.
    then: (resolve: (v: { data: FakeRow[]; error: null }) => unknown) => resolve({ data: current, error: null }),
  };
  // `from` records the table and hands back the builder.
  const db = { from: (table: string) => (calls.push({ method: "from", args: [table] }), builder) };
  // Cast at the boundary: the fake covers only the methods the unit calls.
  return { db: db as unknown as SupabaseClient, calls };
}

// Two rows per status, created in status order, so FIFO and the limit are both observable.
const rows: FakeRow[] = ALL_STATUSES.flatMap((status, i) => [
  // First row of this status.
  { id: `${status}-a`, status, created_at: `2026-11-01T00:${String(i).padStart(2, "0")}:00Z` },
  // Second row of this status, one second later.
  { id: `${status}-b`, status, created_at: `2026-11-01T00:${String(i).padStart(2, "0")}:01Z` },
]);

test("drafts only for awaiting_approval and approved rows", async () => {
  // The ruling itself, as the exported list.
  assert.deepEqual([...REFERRAL_ELIGIBLE_STATUSES], ["awaiting_approval", "approved"]);
  // No exclusions and a cap above the row count, so only the status filter narrows.
  const { db, calls } = fakeClient(rows);
  // Await the builder exactly as index.ts does.
  const { data } = await selectReferralQueue(db, [], 25);
  // Every returned row is at one of the two statuses, and all four such rows came back.
  assert.deepEqual(new Set(data!.map((r) => r.status)), new Set(["awaiting_approval", "approved"]));
  // Two rows each; a status that leaked in would raise this count.
  assert.equal(data!.length, 4);
  // The database is asked for exactly these statuses (filtering after `.limit` would starve the batch).
  assert.deepEqual(calls.find((c) => c.method === "in")?.args, ["status", ["awaiting_approval", "approved"]]);
});

test("the batch cap, FIFO order and already-drafted exclusion are unchanged", async () => {
  // Draft already exists for one approved row.
  const { db, calls } = fakeClient(rows);
  // Cap of 2 with one drafted id excluded.
  const { data } = await selectReferralQueue(db, ["awaiting_approval-a"], 2);
  // The drafted row is skipped; the next two oldest eligible rows fill the batch.
  assert.deepEqual(data!.map((r) => r.id), ["awaiting_approval-b", "approved-a"]);
  // The exclusion is pushed to the database as a parenthesised id list.
  assert.deepEqual(calls.find((c) => c.method === "not")?.args, ["id", "in", "(awaiting_approval-a)"]);
  // Oldest first.
  assert.deepEqual(calls.find((c) => c.method === "order")?.args, ["created_at", { ascending: true }]);
  // The caller's cap reaches the database.
  assert.deepEqual(calls.find((c) => c.method === "limit")?.args, [2]);
});

test("an empty drafted list excludes nothing (PostgREST rejects an empty `in`)", async () => {
  // Fresh fake, nothing drafted.
  const { db, calls } = fakeClient(rows);
  // Await the query with no exclusions.
  await selectReferralQueue(db, [], 5);
  // The all-zero placeholder, never `()`.
  assert.deepEqual(calls.find((c) => c.method === "not")?.args, ["id", "in", "(00000000-0000-0000-0000-000000000000)"]);
});

test("index.ts queries the queue through selectReferralQueue, not an inline status filter", () => {
  // The entrypoint's source; index.ts itself cannot be imported (Deno.serve at load).
  const src = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
  // Positive shape: the tested function is what the handler awaits.
  // A substring check with a short message, so a failure does not dump the whole file.
  assert.ok(src.includes("await selectReferralQueue(db, draftedIds, batchSize)"), "index.ts must await selectReferralQueue");
});
