// Tests for the matcher's permanent-failure exit (wiring audit W2, 2026-11-01): a row the
// tailor is guaranteed to refuse is failed BEFORE any Gemini call, and a row whose model
// answer can never be read stops sitting at the head of the oldest-first queue.
//
// Stateful fake of one applications row plus the status RPC, the same approach as
// tech-pregate.test.ts's fakeRow(): like supabase-js it never throws, every failure is `{ error }`.
import { test } from "node:test";
// Strict, so null and undefined are not conflated.
import assert from "node:assert/strict";
// Units under test.
import { judgeUsableJob, settleModelFailures, withUsableJob, type UsableGateOutcome } from "./fail-exit.ts";
// The client shape the fake must satisfy.
import type { MatchScoreClient } from "./write-score.ts";

// One applications row plus the RPC. The write applies only when every .eq() matches,
// every write bumps the stamp, a stale stamp is PT409, and a move appends an event.
function fakeRow(opts: { status?: string } = {}) {
  // The row as the database holds it; the stamp is a counter so every write changes it.
  const row: Record<string, unknown> = {
    id: "a1",
    // Defaults to the matcher's input status; a test overrides it to model a row already moved.
    status: opts.status ?? "passed_filters",
    // A stale score from an overlapping run, so a test can see the failure write clear it.
    match_score: 61,
    failure_reason: null,
    updated_at: "t0",
  };
  // Monotonic stamp source, standing in for set_updated_at's now().
  let tick = 0;
  // Every update payload attempted, so "no write happened" is assertable.
  const updates: Array<Record<string, unknown>> = [];
  // The application_events the RPC appends.
  const events: Array<{ to: string; detail: Record<string, unknown> }> = [];
  // Every RPC call's args, so a test can check the agent and the stamp.
  const rpcArgs: Array<Record<string, unknown>> = [];
  const db: MatchScoreClient = {
    from(_table) {
      return {
        update(values) {
          // Recorded on attempt, before the WHERE is evaluated.
          updates.push(values);
          // Filters collected so the write applies only when ALL of them match, as SQL does.
          const filters: Array<[string, unknown]> = [];
          const builder = {
            eq(column: string, value: string) {
              // Evaluated when the chain ends.
              filters.push([column, value]);
              return builder;
            },
            select(columns: string) {
              // A WHERE that matches nothing updates nothing and returns no rows.
              if (!filters.every(([c, v]) => row[c] === v)) return Promise.resolve({ data: [], error: null });
              // Apply the payload, then bump the stamp as the trigger would.
              Object.assign(row, values, { updated_at: `t${++tick}` });
              // Only the asked-for columns, so a select that forgets updated_at shows up.
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
      // The stale-stamp gate runs first, as in the live function.
      if (args.p_expected_updated_at != null && args.p_expected_updated_at !== row.updated_at) {
        return Promise.resolve({ error: { code: "PT409", message: "changed since read" } });
      }
      // passed_filters -> failed is a live matcher edge; nothing else is modelled.
      if (row.status !== "passed_filters") return Promise.resolve({ error: { code: "42501", message: "illegal" } });
      // Move the row, bump the stamp, witness the move.
      Object.assign(row, { status: args.p_to_status, updated_at: `t${++tick}` });
      events.push({ to: String(args.p_to_status), detail: args.p_detail as Record<string, unknown> });
      return Promise.resolve({ error: null });
    },
  };
  return { db, row, updates, events, rpcArgs };
}

// A queue row as the matcher's select returns it: every job column the verdict reads present.
function queueRow(job: Record<string, unknown> | null, id = "a1") {
  // The embed is the caller's; null models a missing embed.
  return { id, jobs: job };
}

// A job the tailor would accept.
const GOOD_JOB = { title: "Software Engineer", company_name: "Acme", description_raw: "Build the payments API in TypeScript.", disappeared_at: null };

// Runs one row through the gate with a spy scorer; returns what reached each side.
async function gate(db: MatchScoreClient, row: ReturnType<typeof queueRow>) {
  // Rows the scorer (the only Gemini caller) received.
  const scored: string[] = [];
  // Outcomes the gate handled itself.
  const gated: UsableGateOutcome[] = [];
  // The wrapper under test, around a spy standing in for the pre-gate + scorer chain.
  const handler = withUsableJob<ReturnType<typeof queueRow>, string>(db, (_row, outcome) => gated.push(outcome), async (r) => {
    scored.push(r.id);
  });
  await handler(row, "call-1");
  return { scored, gated };
}

test("usable gate: a blank description is failed missing_description, and the scorer is never called", async () => {
  // The live case: 13 SmartRecruiters rows at passed_filters with no description (2026-11-01).
  // A fresh row at passed_filters, carrying a stale score from another run.
  const { db, row, events, rpcArgs } = fakeRow();
  // Whitespace only: blank by the tailor's rule, not merely short.
  const { scored, gated } = await gate(db, queueRow({ ...GOOD_JOB, description_raw: "   " }));
  // THE PROPERTY: no Gemini call for a row the tailor is guaranteed to refuse.
  assert.deepEqual(scored, []);
  // Moved off the queue, so it can no longer sit at its head.
  assert.equal(row.status, "failed");
  // The column and the event both name the reason.
  assert.equal(row.failure_reason, "missing_description");
  assert.equal(events[0]?.detail.reason, "missing_description");
  // A stale score from an overlapping run is cleared, not left on a failed row.
  assert.equal(row.match_score, null);
  // As the matcher, on the stamp of its own write (the race guard write-score.ts provides).
  assert.equal(rpcArgs[0]?.p_agent, "matcher");
  assert.equal(rpcArgs[0]?.p_expected_updated_at, "t1");
  // Reported to the caller as a failure it made, with the reason.
  assert.deepEqual(gated, [{ kind: "failed", reason: "missing_description" }]);
});

test("usable gate: a null description and a blank company are failed with their own reasons", () => {
  // The tailor's rule, field by field, so the reason IS the finding.
  assert.deepEqual(judgeUsableJob(queueRow({ ...GOOD_JOB, description_raw: null })), { kind: "unusable", reason: "missing_description" });
  assert.deepEqual(judgeUsableJob(queueRow({ ...GOOD_JOB, company_name: "" })), { kind: "unusable", reason: "missing_company" });
  assert.deepEqual(judgeUsableJob(queueRow({ ...GOOD_JOB, title: " " })), { kind: "unusable", reason: "missing_title" });
});

test("usable gate: a usable row reaches the scorer with no write and no rpc", async () => {
  // The control case: without it the gate could be a wall that fails everything.
  const { db, updates, rpcArgs } = fakeRow();
  // Every field present and non-blank.
  const { scored, gated } = await gate(db, queueRow(GOOD_JOB));
  // Handed on unchanged.
  assert.deepEqual(scored, ["a1"]);
  // The gate touched nothing.
  assert.deepEqual(gated, []);
  assert.equal(updates.length, 0);
  assert.equal(rpcArgs.length, 0);
});

test("usable gate: a description_raw column the select did not return is a defect, never a failure", async () => {
  // postgrest omits an unselected column: absence of the KEY is a query defect, not a blank job.
  const { description_raw: _omitted, ...withoutColumn } = GOOD_JOB;
  // A fresh row, so any write would show in `updates`.
  const { db, row, updates } = fakeRow();
  // The embed as a select without description_raw would return it.
  const { scored, gated } = await gate(db, queueRow(withoutColumn));
  // Neither scored nor failed: one dropped column must not fail every row in the queue.
  assert.deepEqual(scored, []);
  assert.equal(row.status, "passed_filters");
  assert.equal(updates.length, 0);
  // Reported, so the run's error_detail shows the defect.
  assert.equal(gated[0]?.kind, "error");
});

test("usable gate: a missing job embed is a defect, never a failure", async () => {
  // job_id is NOT NULL with ON DELETE CASCADE, so under jobs!inner a null embed cannot be a
  // deleted job. It can be a select that lost !inner, which nulls a DISAPPEARED job's embed;
  // failing it would turn a repostable job into a terminal row.
  const { db, row } = fakeRow();
  // The embed postgrest returns when the join matched nothing.
  const { scored, gated } = await gate(db, queueRow(null));
  // Not scored, and not failed either.
  assert.deepEqual(scored, []);
  assert.equal(row.status, "passed_filters");
  assert.equal(gated[0]?.kind, "error");
});

test("usable gate: a disappeared posting that slips past the select is left at passed_filters", async () => {
  // planReappearances clears disappeared_at on a repost, so this is not permanent.
  const { db, row } = fakeRow();
  // A job scout-ats saw drop off its board, which the select should have filtered out.
  const { scored, gated } = await gate(db, queueRow({ ...GOOD_JOB, disappeared_at: "2026-10-30T00:00:00Z" }));
  // No Gemini call on a closed posting.
  assert.deepEqual(scored, []);
  // Left where it is, so a repost brings it back.
  assert.equal(row.status, "passed_filters");
  // Reported: reaching here means the select lost its filter.
  assert.equal(gated[0]?.kind, "error");
});

test("usable gate: a row another run already moved is skipped_stale, with no rpc", async () => {
  // Another run scored it between our read and our write.
  const { db, rpcArgs } = fakeRow({ status: "scored" });
  // An unusable job, so the gate tries to fail it.
  const { gated } = await gate(db, queueRow({ ...GOOD_JOB, description_raw: null }));
  // The guarded write matched nothing: the race is lost, not an error.
  assert.deepEqual(gated, [{ kind: "skipped_stale" }]);
  // No move without a stamp of our own.
  assert.equal(rpcArgs.length, 0);
});

test("settleModelFailures: when another row was scored this run, an unreadable answer fails its row", async () => {
  // A row whose answer was held during the batch.
  const { db, row, events } = fakeRow();
  // proven = true: the model and the parser worked for some row in this run.
  const out = await settleModelFailures(db, [{ applicationId: "a1", reason: "unreadable_score", detail: "invalid_match_score:not_a_number(NaN)" }], true);
  // Terminal, with the named reason, so it stops being retried at the queue head.
  assert.equal(row.status, "failed");
  assert.equal(row.failure_reason, "unreadable_score");
  // The model's own words go to the event, not the reason column.
  assert.equal(events[0]?.detail.detail, "invalid_match_score:not_a_number(NaN)");
  // Counted as a failed row, not as a failure of the run.
  assert.deepEqual(out, { failed: ["unreadable_score"], skippedStale: 0, failures: [] });
});

test("settleModelFailures: when no row was scored this run, nothing is failed and the rows stay", async () => {
  // A model or parser regression makes EVERY answer unreadable; failing them all would empty
  // the queue into a status only a human can leave.
  const { db, row, updates } = fakeRow();
  // proven = false: nothing in this run was readable.
  const out = await settleModelFailures(db, [{ applicationId: "a1", reason: "gemini_returned_no_text", detail: "gemini_returned_no_text" }], false);
  // Untouched: no write, no move.
  assert.equal(row.status, "passed_filters");
  assert.equal(updates.length, 0);
  // Still reported as a failure of this run, so the run reads failed, not idle.
  assert.equal(out.failures.length, 1);
  // And no row counted as failed.
  assert.deepEqual(out.failed, []);
});

test("matcher wiring: the queue skips disappeared jobs and the usable gate runs before the pre-gate", async () => {
  // index.ts (Deno.serve, jsr: imports) cannot be imported under node; its wiring is read as source.
  const { readFileSync } = await import("node:fs");
  // Resolved relative to this test file, independent of the cwd.
  const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
  // !inner is what makes the disappeared_at filter drop the ROW, not just null its embed.
  assert.match(source, /\.select\("id, job_id, jobs!inner \([^)]*\bdescription_raw\b[^)]*\bdisappeared_at\b[^)]*\)"\)/);
  // The filter itself.
  assert.match(source, /\.is\("jobs\.disappeared_at", null\)/);
  // The usable gate wraps the tech pre-gate, so even a human-picked row is checked first.
  assert.match(source, /runBatchWithDeadline\(rows \?\? \[\], withUsableJob\(/);
  // Held answer failures are settled with the "some row scored" proof.
  assert.match(source, /settleModelFailures\(db, heldModelFailures, scoredCount \+ droppedCount > 0\)/);
});
