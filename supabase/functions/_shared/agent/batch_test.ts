// Batch sizes are a SAFETY PROPERTY, not a tuning constant, which is why they get
// their own test file rather than being asserted incidentally somewhere else.
//
// The failure they prevent has a very specific shape: an agent written to "process all
// pending" passes every test anyone writes, because a test fixture has ten rows. It
// fails in production on four hundred, by exceeding the ~2s CPU limit — and a CPU-limit
// kill presents as an invocation that produced NOTHING, with no error attributable to
// any row. There is no partial progress to inspect, so the diagnosis is expensive
// exactly when the queue is deepest.
import { test } from "node:test";
// Strict, so a batch size of `undefined` never compares equal to a number.
import assert from "node:assert/strict";
// Extension-suffixed specifier so this runs under Deno and `node --test` alike.
import { AGENT_BATCH_SIZES, batchSizeFor } from "./batch.ts";
// The agent vocabulary, so the totality check below cannot go stale.
import { AGENT_NAMES } from "../contracts/shared-types.ts";

// The numbers from STREAM_NOTES §9, which derives them from the ~2s CPU limit rather
// than from the 150s wall clock — the CPU one is the binding limit, so CPU-bound and
// wall-clock-bound stages want OPPOSITE batch sizes and one number cannot serve both.
test("batch sizes match the CPU-limit derivation, stage by stage", () => {
  // One board: `content=true` returns every full HTML description at once, so the risk
  // is a multi-MB `JSON.parse`, not per-job work.
  assert.equal(AGENT_BATCH_SIZES.scout_ats, 1);
  // Light per-row work: a fingerprint recomputation and at most one lookup.
  assert.equal(AGENT_BATCH_SIZES.normalizer, 50);
  // The one stage that can afford volume AND needs it — no LLM, no I/O, pure set and
  // regex work. Most discovered jobs die here, which is what makes six free keys
  // sufficient rather than merely hopeful.
  assert.equal(AGENT_BATCH_SIZES.screener, 200);
  // Wall-clock bound, ~zero CPU: a 40s Gemini wait costs almost no CPU at all.
  assert.equal(AGENT_BATCH_SIZES.matcher, 5);
  assert.equal(AGENT_BATCH_SIZES.tailor, 5);
  assert.equal(AGENT_BATCH_SIZES.auditor, 5);
  // One Gemini call each, wall-clock bound.
  assert.equal(AGENT_BATCH_SIZES.tracker, 50);
});

// NON-VACUITY TWIN for the totality check below: this asserts the table ACCEPTS the
// agents that legitimately have no batch, rather than only that it rejects.
test("agents that do not claim a bounded batch are absent by design, not by omission", () => {
  // The Applier runs in GitHub Actions and deliberately drains the whole day's queue in
  // ONE run — per-run overhead plus GitHub's per-job minute rounding means 35 separate
  // runs cost ~35-70 billed minutes against ~2 for one batched run.
  assert.equal(AGENT_BATCH_SIZES.applier, undefined);
  // Push-driven, not claim-driven: Apps Script POSTs in, so there is no batch to size.
  assert.equal(AGENT_BATCH_SIZES.human, undefined);
});

// THE GUARD THAT ACTUALLY MATTERS: an unbounded stage must be impossible to express.
test("every claiming agent has a finite, positive, bounded batch size", () => {
  // Walk the shipped table rather than a hand-written list, so a new entry is covered
  // the moment it is added.
  for (const [agent, size] of Object.entries(AGENT_BATCH_SIZES)) {
    // An entry present at all must be a real number — `Infinity` is exactly the value
    // someone reaches for when they mean "process everything".
    assert.equal(Number.isFinite(size), true, `${agent} batch must be finite`);
    // Zero would silently stall the stage while looking configured.
    assert.equal(size > 0, true, `${agent} batch must be positive`);
    // 200 is the largest value the derivation supports (the Screener). Anything above
    // it is a stage that has stopped believing in the CPU limit.
    assert.equal(size <= 200, true, `${agent} batch must not exceed the Screener's 200`);
  }
});

// The lookup helper must refuse rather than invent a default.
test("batchSizeFor refuses an agent with no derived batch size", () => {
  // The Applier has no claim batch, so asking for one is a programming error, not a
  // situation to paper over with a fallback number.
  assert.throws(() => batchSizeFor("applier"), /no batch size/);
});

// NON-VACUITY TWIN: the same helper must return the real number for a real stage.
test("batchSizeFor returns the derived size for a claiming agent", () => {
  // If this failed while the throw above passed, the helper would be rejecting
  // everything — which a rejection test alone cannot distinguish from correctness.
  assert.equal(batchSizeFor("screener"), 200);
});

// Guards against the table naming an agent the database does not have. An
// `agent_runs.agent` value outside the enum fails at INSERT time, in production.
test("every key in the batch table is a real agent identity", () => {
  // The enum is the schema owner's; this table must be a subset of it.
  for (const agent of Object.keys(AGENT_BATCH_SIZES)) {
    assert.equal(AGENT_NAMES.includes(agent as never), true, `${agent} is not an agent_name`);
  }
});
