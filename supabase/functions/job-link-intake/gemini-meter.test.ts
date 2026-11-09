// Tests for the per-request Gemini meter (gemini-meter.ts): the agent_runs row it writes for
// job-link-intake and resume-assist, which spent Gemini quota unmeasured until 2026-11-09.

// node:test, the runner this suite uses.
import { test } from "node:test";
// Strict asserts, so a near-miss is never equal.
import assert from "node:assert/strict";
// The unit under test.
import { geminiMeter } from "./gemini-meter.ts";

// A fake client shaped like supabase-js: insert REPORTS a refusal as { error }, it does not throw (CLAUDE.md §5).
function fakeDb(error: { message: string } | null = null) {
  // Every row inserted, by table.
  const rows: Array<{ table: string; row: Record<string, unknown> }> = [];
  // The fake and its record.
  return { rows, db: { from: (table: string) => ({ insert: async (row: Record<string, unknown>) => { rows.push({ table, row }); return { error }; } }) } };
}

// A fixed clock that advances 1 s per read, so started_at and finished_at differ.
function clock() {
  // Reads so far.
  let tick = 0;
  // Each read is one second after the last.
  return () => new Date(Date.UTC(2026, 10, 9, 15, 0, tick++));
}

// Outcomes in the client's shape.
const OK = { ok: true, data: {}, keyIndex: 0, attempts: 1 } as const;
// A 503 that outlasted the retries.
const UNAVAILABLE = { ok: false, reason: "upstream_unavailable", attempts: 3 } as const;
// Every key cooling: quota, not failure.
const COOLING = { ok: false, reason: "all_keys_cooling", attempts: 0 } as const;

test("no Gemini call: record() resolves with no client to write through", async () => {
  // A request that never reached Gemini (a board link, a refusal) never handed the meter a client,
  // so record() must return quietly rather than dereference a missing one.
  await geminiMeter("job_link_intake", clock()).record();
});

test("two calls, last ok: one succeeded row with gemini_calls 2 for the named agent", async () => {
  // The client and its record.
  const { rows, db } = fakeDb();
  // One meter per request.
  const meter = geminiMeter("job_link_intake", clock());
  // The plain-fetch extract, then the render retry (job-link-intake's two-call cap).
  await meter.call(db, async () => UNAVAILABLE);
  // The second call succeeds.
  const second = await meter.call(db, async () => OK);
  // The outcome passes through untouched.
  assert.equal(second, OK);
  // Written once.
  await meter.record();
  // Exactly one row, into agent_runs.
  assert.equal(rows.length, 1);
  // The row's fields.
  const { table, row } = rows[0]!;
  // The right table.
  assert.equal(table, "agent_runs");
  // The row: the LAST outcome decides, the count covers both calls, timestamps from the clock.
  assert.deepEqual(row, { agent: "job_link_intake", status: "succeeded", started_at: "2026-11-09T15:00:00.000Z", finished_at: "2026-11-09T15:00:01.000Z", gemini_calls: 2, error_count: 0, error_detail: null });
});

test("a 503 is failed with its reason, so 429 vs 503 can be split from agent_runs", async () => {
  // The client and its record.
  const { rows, db } = fakeDb();
  // One meter.
  const meter = geminiMeter("resume_assist", clock());
  // The only call fails upstream.
  await meter.call(db, async () => UNAVAILABLE);
  // Written.
  await meter.record();
  // Failed, counted as an error, and the reason verbatim.
  assert.deepEqual([rows[0]!.row.status, rows[0]!.row.error_count, rows[0]!.row.error_detail, rows[0]!.row.gemini_calls], ["failed", 1, "upstream_unavailable", 1]);
});

test("every key cooling is skipped_quota, not a failure", async () => {
  // The client and its record.
  const { rows, db } = fakeDb();
  // One meter.
  const meter = geminiMeter("resume_assist", clock());
  // The budget is spent.
  await meter.call(db, async () => COOLING);
  // Written.
  await meter.record();
  // Quota is normal behaviour: no error counted.
  assert.deepEqual([rows[0]!.row.status, rows[0]!.row.error_count], ["skipped_quota", 0]);
});

test("a call that throws is still counted, rethrown, and recorded as failed", async () => {
  // The client and its record.
  const { rows, db } = fakeDb();
  // One meter.
  const meter = geminiMeter("job_link_intake", clock());
  // A succeeded call first, so a stale outcome would wrongly read "succeeded".
  await meter.call(db, async () => OK);
  // The throw reaches the caller unchanged.
  await assert.rejects(meter.call(db, async () => { throw new Error("boom"); }), /boom/);
  // Written.
  await meter.record();
  // Two calls, and the throw (not the earlier ok) decides the status.
  assert.deepEqual([rows[0]!.row.gemini_calls, rows[0]!.row.status, rows[0]!.row.error_detail], [2, "failed", "gemini call threw"]);
});

test("a refused or throwing insert never rejects record()", async () => {
  // A refusal reported as { error }.
  const refused = fakeDb({ message: "permission denied" });
  // One meter with one call.
  const meter = geminiMeter("job_link_intake", clock());
  // A call, so there is a row to write.
  await meter.call(refused.db, async () => OK);
  // Resolves: telemetry must not change an answer.
  await meter.record();
  // A client whose insert throws (a network drop).
  const throwing = { from: () => ({ insert: async () => { throw new Error("socket closed"); } }) };
  // A second meter over it.
  const second = geminiMeter("resume_assist", clock());
  // A call.
  await second.call(throwing, async () => OK);
  // Still resolves.
  await second.record();
});
