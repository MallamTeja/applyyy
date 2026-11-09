// Tests for the matcher's score write: proves the status guard rides on the UPDATE and that a
// zero-row result is reported as a stale skip. Recording fake client — no network, no database.
import { test } from "node:test";
// Strict, so null and undefined are not conflated.
import assert from "node:assert/strict";
// Unit under test.
import { advanceScoredRow, writeMatchScore, type MatchScoreClient } from "./write-score.ts";

// Builds a fake that records every filter the write chains, and answers with the given result.
// updated_at is optional in the canned rows so a test can model an answer that lacks it.
function fakeClient(result: { data: Array<{ id: string; updated_at?: string }> | null; error: { message: string } | null }) {
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
    // Present only to satisfy the client shape; these tests exercise the write, never the RPC.
    rpc() {
      return Promise.resolve({ error: null });
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

test("write-score: one row updated is written, with the payload and an id + updated_at select", async () => {
  // The happy path, or the guard is just a wall.
  const { db, calls } = fakeClient({ data: [{ id: "a1", updated_at: "2026-10-08T11:00:00.123456+00:00" }], error: null });
  // The stamp is passed through verbatim: the RPC compares it for exact equality.
  assert.deepEqual(await writeMatchScore(db, "a1", PAYLOAD), {
    kind: "written",
    updatedAt: "2026-10-08T11:00:00.123456+00:00",
  });
  // Right table, payload passed through untouched.
  assert.equal(calls.table, "applications");
  assert.deepEqual(calls.values, PAYLOAD);
  // The select makes the row count observable AND returns the stamp step 2 guards with.
  assert.equal(calls.select, "id, updated_at");
});

test("write-score: a database error is reported as error with its message", async () => {
  // A failed write must stay a failure, never fold into skip.
  const { db } = fakeClient({ data: null, error: { message: "boom" } });
  assert.deepEqual(await writeMatchScore(db, "a1", PAYLOAD), { kind: "error", message: "boom" });
});

// ---------------------------------------------------------------------------------------------
// STEP 1 -> STEP 2 race. The status guard above closes "a loser writes AFTER the winner moved
// the row", but not "a loser writes BETWEEN the winner's write and the winner's status RPC":
// the row is still at passed_filters then, so the loser's score lands and the winner's RPC
// moves the row with the WINNER's detail on top of the LOSER's column. The fix carries the
// write's updated_at into the RPC as p_expected_updated_at, which refuses a stale stamp (PT409).
// ---------------------------------------------------------------------------------------------

// A stateful fake of ONE applications row plus the status RPC, modelling the live semantics
// that matter here (migration 20261008160000): set_updated_at bumps the stamp on every write,
// the stale-stamp gate (PT409) runs before the same-status no-op, and the RPC writes an event.
// Like supabase-js, it never throws: every failure comes back as `{ error }`.
function fakeRow() {
  // The row as the database holds it; the stamp is a counter so every write changes it.
  const row: Record<string, unknown> = {
    id: "a1",
    status: "passed_filters",
    match_score: null,
    drop_reason: null,
    updated_at: "t0",
  };
  // Monotonic stamp source, standing in for set_updated_at's now().
  let tick = 0;
  // The application_events the RPC appends, so a test can compare event detail to the column.
  const events: Array<{ to: string; detail: Record<string, unknown> }> = [];
  // Every RPC call's args, so a test can check the stamp was actually sent.
  const rpcArgs: Array<Record<string, unknown>> = [];
  const db: MatchScoreClient = {
    from(_table) {
      return {
        update(values) {
          // Filters collected so the write applies only when ALL of them match, as SQL does.
          const filters: Array<[string, unknown]> = [];
          const builder = {
            eq(column: string, value: string) {
              // Recorded; evaluated when the chain ends.
              filters.push([column, value]);
              return builder;
            },
            select(columns: string) {
              // A WHERE that matches nothing updates nothing and returns no rows.
              if (!filters.every(([c, v]) => row[c] === v)) return Promise.resolve({ data: [], error: null });
              // Apply the payload, then bump the stamp exactly as the trigger would.
              Object.assign(row, values, { updated_at: `t${++tick}` });
              // Return only the asked-for columns, so a select that forgets updated_at shows up.
              const out = Object.fromEntries(columns.split(",").map((c) => [c.trim(), row[c.trim()]]));
              return Promise.resolve({ data: [out], error: null });
            },
          };
          return builder;
        },
      };
    },
    rpc(_fn, args) {
      // Kept for assertions on what the caller sent.
      rpcArgs.push(args);
      // THE STALE-STAMP GATE, first, as in the live function.
      if (args.p_expected_updated_at != null && args.p_expected_updated_at !== row.updated_at) {
        return Promise.resolve({ error: { code: "PT409", message: "application a1 changed since it was read" } });
      }
      // Same-status call: a silent no-op in the live function, which is what hides the race.
      if (row.status === args.p_to_status) return Promise.resolve({ error: null });
      // Only the two matcher edges out of passed_filters exist; anything else is illegal.
      if (row.status !== "passed_filters") {
        return Promise.resolve({ error: { code: "42501", message: `illegal ${row.status} -> ${args.p_to_status}` } });
      }
      // Move the row, bump the stamp, witness the move with its detail.
      Object.assign(row, { status: args.p_to_status, updated_at: `t${++tick}` });
      // The event is what Health and the audit trail read, so it must agree with the column.
      events.push({ to: String(args.p_to_status), detail: args.p_detail as Record<string, unknown> });
      return Promise.resolve({ error: null });
    },
  };
  return { db, row, events, rpcArgs };
}

test("write-score: the written outcome carries the row's new updated_at", async () => {
  // The stamp is what step 2 checks against, so step 1 must hand it over.
  const { db, row } = fakeRow();
  const res = await writeMatchScore(db, "a1", PAYLOAD);
  // Exactly the stamp the write produced, not the one read before it.
  assert.deepEqual(res, { kind: "written", updatedAt: row.updated_at });
});

test("write-score: a written row with no updated_at in the answer is an error, never a stampless advance", async () => {
  // Without a stamp step 2 cannot guard the move; fail closed (the row stays at passed_filters).
  const { db } = fakeClient({ data: [{ id: "a1" }], error: null });
  const res = await writeMatchScore(db, "a1", PAYLOAD);
  // An error, so the caller records it and never calls the RPC unguarded.
  assert.equal(res.kind, "error");
});

test("advance-scored: sends the write's stamp as p_expected_updated_at", async () => {
  // A plain, unraced advance.
  const { db, rpcArgs } = fakeRow();
  await advanceScoredRow(db, "a1", "scored", { score: 80 }, "t0");
  // The stamp rides on the RPC; without it the gate never runs.
  assert.equal(rpcArgs[0].p_expected_updated_at, "t0");
  // And it is still the matcher acting, on the right row.
  assert.equal(rpcArgs[0].p_agent, "matcher");
  // The row targeted is the one passed in.
  assert.equal(rpcArgs[0].p_application_id, "a1");
});

test("advance-scored: PT409 is skipped_stale, any other error is error", async () => {
  // A stale stamp: someone wrote the row after us, so the move is theirs, not a failure.
  const { db } = fakeRow();
  assert.deepEqual(await advanceScoredRow(db, "a1", "scored", { score: 80 }, "t-old"), { kind: "skipped_stale" });
  // A real failure stays a failure: an illegal edge out of a row that is already further on.
  const later = fakeRow();
  // Put the row past the matcher, with the caller's stamp still current, so only the edge is wrong.
  later.row.status = "tailored";
  // Reported with its message so it lands in the run's error_detail.
  assert.deepEqual(await advanceScoredRow(later.db, "a1", "scored", { score: 80 }, "t0"), {
    kind: "error",
    message: "illegal tailored -> scored",
  });
});

test("matcher race: a write landing between another run's write and its RPC leaves column and event from ONE run", async () => {
  // Two overlapping runs scored the same passed_filters row with different results.
  const { db, row, events } = fakeRow();
  // Run A writes first, an advance-band score...
  const a = await writeMatchScore(db, "a1", { match_score: 80, match_reasoning: "A", drop_reason: null });
  // ...then run B writes before A's RPC: the row is still at passed_filters, so the guard lets it in.
  const b = await writeMatchScore(db, "a1", { match_score: 30, match_reasoning: "B", drop_reason: "below floor" });
  // Both landed; this is the window the status guard alone cannot close.
  assert.ok(a.kind === "written" && b.kind === "written");
  // A's RPC runs with A's stamp, then B's with B's.
  const aMove = await advanceScoredRow(db, "a1", "scored", { score: 80 }, a.updatedAt);
  const bMove = await advanceScoredRow(db, "a1", "dropped_filter", { score: 30 }, b.updatedAt);
  // A lost at step 2: its move is refused, not applied on top of B's column.
  assert.deepEqual(aMove, { kind: "skipped_stale" });
  // B, whose payload is the one in the row, is the one that moves it.
  assert.deepEqual(bMove, { kind: "advanced" });
  // Exactly one witnessed move, and its detail matches the column it sits on.
  assert.equal(events.length, 1);
  // The score the event reports is the score the row holds.
  assert.equal(events[0].detail.score, row.match_score);
  // A dropped row says why; it is at the status its own drop_reason describes.
  assert.equal(row.status, "dropped_filter");
  assert.equal(row.drop_reason, "below floor");
});

test("advance-scored: a move to failed with no non-blank reason is refused before the RPC", async () => {
  // Each shape a lenient caller could hand over: no reason key, empty, whitespace, a non-string.
  for (const detail of [{}, { reason: "" }, { reason: "  " }, { reason: 42 }]) {
    // A fresh fake per case, so one case's RPC never satisfies another's assert.
    const { db, rpcArgs } = fakeRow();
    // Cast: the overload already forbids these; this proves the runtime refuses what a cast sneaks past it.
    const res = await advanceScoredRow(db, "a1", "failed", detail as never, "t0");
    // Refused as an error the caller records against the row.
    assert.equal(res.kind, "error", `detail ${JSON.stringify(detail)} was accepted`);
    // The RPC never ran: the matcher does not lean on the database to name its own failure.
    assert.equal(rpcArgs.length, 0, `detail ${JSON.stringify(detail)} reached the RPC`);
  }
});
