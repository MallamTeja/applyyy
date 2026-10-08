// Tests for the matcher's score write: proves the status guard rides on the UPDATE and that a
// zero-row result is reported as a stale skip. Recording fake client — no network, no database.
import { test } from "node:test";
// Strict, so null and undefined are not conflated.
import assert from "node:assert/strict";
// Unit under test.
import { writeMatchScore, type MatchScoreClient } from "./write-score.ts";

// Builds a fake that records every filter the write chains, and answers with the given result.
function fakeClient(result: { data: Array<{ id: string }> | null; error: { message: string } | null }) {
  // Each (column, value) pair passed to .eq(), in call order, so a test can assert the filters.
  const eqs: Array<[string, unknown]> = [];
  // The table and payload, so a test can check the write targets the right place.
  const calls: { table?: string; values?: Record<string, unknown>; select?: string } = {};
  // The chain mirrors supabase-js: from().update().eq().eq().select().
  const db: MatchScoreClient = {
    from(table) {
      // Recorded so the target table is assertable.
      calls.table = table;
      return {
        update(values) {
          // Recorded so the payload is assertable.
          calls.values = values;
          // One builder object that every .eq() returns, so any number of filters chain.
          const builder = {
            eq(column: string, value: string) {
              // Recorded: the status filter is the whole point of this unit.
              eqs.push([column, value]);
              return builder;
            },
            select(columns: string) {
              // Recorded: without .select() supabase-js returns no rows, so a 0 would be invisible.
              calls.select = columns;
              // The canned result, as a thenable the unit can await.
              return Promise.resolve(result);
            },
          };
          return builder;
        },
      };
    },
  };
  return { db, eqs, calls };
}

// A representative payload; the unit must pass it through untouched.
const PAYLOAD = { match_score: 72, match_reasoning: "fits", drop_reason: null };

test("write-score: the update carries the status filter [status, passed_filters]", async () => {
  // A normal one-row answer; the assertion is on the filters, not the outcome.
  const { db, eqs } = fakeClient({ data: [{ id: "a1" }], error: null });
  await writeMatchScore(db, "a1", PAYLOAD);
  // Without this filter a losing duplicate run overwrites a row the winner already moved.
  assert.deepEqual(eqs.find(([c]) => c === "status"), ["status", "passed_filters"]);
  // And the row is still targeted by id, or the guard would widen the write.
  assert.deepEqual(eqs.find(([c]) => c === "id"), ["id", "a1"]);
});

test("write-score: zero rows updated is skipped_stale, not written and not an error", async () => {
  // The race: the row left passed_filters between our read and our write.
  const { db } = fakeClient({ data: [], error: null });
  // Skip is its own outcome so the caller neither counts it a success nor fails the row.
  assert.deepEqual(await writeMatchScore(db, "a1", PAYLOAD), { kind: "skipped_stale" });
});

test("write-score: one row updated is written, with the payload and an id select", async () => {
  // The happy path, or the guard is just a wall.
  const { db, calls } = fakeClient({ data: [{ id: "a1" }], error: null });
  assert.deepEqual(await writeMatchScore(db, "a1", PAYLOAD), { kind: "written" });
  // Right table, payload passed through untouched.
  assert.equal(calls.table, "applications");
  assert.deepEqual(calls.values, PAYLOAD);
  // The select is what makes the row count observable at all.
  assert.equal(calls.select, "id");
});

test("write-score: a database error is reported as error with its message", async () => {
  // A failed write must stay a failure, never fold into skip.
  const { db } = fakeClient({ data: null, error: { message: "boom" } });
  assert.deepEqual(await writeMatchScore(db, "a1", PAYLOAD), { kind: "error", message: "boom" });
});
