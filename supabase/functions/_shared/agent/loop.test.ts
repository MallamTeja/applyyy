// THE SHARED STAGE LOOP — where the ORDER of operations is the safety property.
//
// Every assertion in this file is about a sequence or about the presence/absence of a
// call, because that is where all four of the rules the loop exists to enforce live:
//
//   rule 1  the kill switch is checked FIRST, before any other work
//   rule 4  `sweep_stale_claims` is unpacked as an ARRAY, once, in the adapter
//   rule 6  no rollback: an agent with no key RELEASES the claim, status untouched
//   rule 7  the batch is BOUNDED and `pg_cron` re-fires
//
// None of those is observable in a return value, which is why the double records the
// transcript and these tests read it.
import { test } from "node:test";
// Strict, so a missing call never compares equal to a present one.
import assert from "node:assert/strict";
// Extension-suffixed specifier so this runs under Deno and `node --test` alike.
import { runStage } from "./loop.ts";
// The shared recording double.
import { makeFakePort } from "./test-port.ts";
// Row builder.
import { makeApplicationRow } from "./fixtures.ts";
// The settings projection.
import type { SettingsSnapshot } from "./port.ts";

// The switch on, everything else ordinary.
const ENABLED: SettingsSnapshot = {
  systemEnabled: true,
  dryRun: true,
  geminiDailyCallBudget: null,
  maxApplicationsPerCompanyPerWeek: 2,
  freshnessWindowDays: 3,
};

// Three claimable rows, so "the loop stopped early" is distinguishable from "the loop
// finished". One row cannot tell those apart.
const THREE_ROWS = [
  makeApplicationRow({ id: "app-1", status: "passed_filters" }),
  makeApplicationRow({ id: "app-2", status: "passed_filters" }),
  makeApplicationRow({ id: "app-3", status: "passed_filters" }),
];

// A stage that advances every row it is given. The baseline every scenario deviates from.
function advancingStage(port: ReturnType<typeof makeFakePort>) {
  return {
    agent: "matcher" as const,
    inputStatus: "passed_filters" as const,
    run: port,
    queue: port,
    // Nothing to load.
    prepare: () => Promise.resolve({ ok: true as const, context: undefined }),
    // Every row succeeds.
    handleRow: () => Promise.resolve({ kind: "advanced" as const }),
  };
}

// ── RULE 1: THE KILL SWITCH IS FIRST ────────────────────────────────────────────────

test("kill switch off: nothing is swept and nothing is claimed", async () => {
  // The deliberate stop, with rows sitting in the queue that a running agent would claim.
  const port = makeFakePort({ settings: { ...ENABLED, systemEnabled: false }, claims: { passed_filters: THREE_ROWS } });
  // Run the stage.
  const outcome = await runStage(advancingStage(port));
  // THE ASSERTION THAT IS RULE 1: the transcript contains no sweep and no claim, and it
  // is an exact comparison rather than a "does not include" — a loop that claimed first
  // and checked second would still satisfy a negative-only assertion on the last call.
  assert.deepEqual(port.names(), ["readSettings", "openRun", "closeRun"]);
  // Halted, so the caller returns a 200 saying nothing was done rather than an error.
  assert.equal(outcome.halted, true);
  // Recorded as `skipped_disabled` rather than `failed`, because a flipped switch is not
  // an incident and a health page that reports one is a page Teja stops reading.
  assert.equal(outcome.status, "skipped_disabled");
  // The run row carries the same value, which is what the health page actually reads.
  assert.equal(port.closed[0]?.status, "skipped_disabled");
});

test("a missing settings row halts the stage exactly like an off switch", async () => {
  // NO LONGER the live state (CORRECTED 2026-10-24: signup trigger `20261008180000`
  // seeds defaults); kept as the regression guard for a mis-provisioned account.
  const port = makeFakePort({ settings: null, claims: { passed_filters: THREE_ROWS } });
  // Run.
  const outcome = await runStage(advancingStage(port));
  // Halted, and again with no claim attempted.
  assert.equal(outcome.halted, true);
  // The reason survives into the run row, so the difference between "Teja paused it" and
  // "the account was never set up" is visible without reading the function log.
  assert.match(String(port.closed[0]?.errorDetail), /no_settings_row/);
  // And nothing was claimed.
  assert.equal(port.callsTo("claimApplications").length, 0);
});

// NON-VACUITY TWIN for rule 1: an ENABLED system must reach the queue. A loop that
// halted unconditionally would pass both tests above while stopping the whole pipeline.
test("kill switch on: the stage sweeps, then claims, then works", async () => {
  // The switch on, with a full batch waiting.
  const port = makeFakePort({ settings: ENABLED, claims: { passed_filters: THREE_ROWS } });
  // Run.
  const outcome = await runStage(advancingStage(port));
  // The ordering, asserted as a prefix so later per-row calls do not make it brittle.
  assert.deepEqual(port.names().slice(0, 4), ["readSettings", "openRun", "sweepStaleClaims", "claimApplications"]);
  // Not halted.
  assert.equal(outcome.halted, false);
  // All three rows advanced.
  assert.equal(outcome.rowsOut, 3);
  // And it succeeded.
  assert.equal(outcome.status, "succeeded");
});

// ── RULE 7: THE BATCH IS BOUNDED ────────────────────────────────────────────────────

test("the claim limit comes from the batch table, never from the queue depth", async () => {
  // The switch on.
  const port = makeFakePort({ settings: ENABLED, claims: { passed_filters: THREE_ROWS } });
  // Run the Matcher, whose derived batch is 5.
  await runStage(advancingStage(port));
  // The limit argument is the derived size — not 3, not the number of rows available,
  // and above all not absent. An agent written to "process all pending" passes on ten
  // rows and fails on four hundred.
  assert.equal(port.callsTo("claimApplications")[0]?.args[2], 5);
});

test("claimed_by identifies the agent AND the run, per §6", async () => {
  // The switch on.
  const port = makeFakePort({ settings: ENABLED, claims: { passed_filters: THREE_ROWS } });
  // Run.
  await runStage(advancingStage(port));
  // `agent:runId`. Without the run id, a stuck lease cannot be traced to the invocation
  // that took it, which is the one thing the health page needs from this field.
  assert.equal(port.callsTo("claimApplications")[0]?.args[1], "matcher:run-1");
});

test("an empty queue is a successful run, not a failure, and costs no preparation", async () => {
  // The switch on and nothing to do — the ordinary state of a cron-fired stage.
  const port = makeFakePort({ settings: ENABLED, claims: {} });
  // A prepare that would fail the test if it ran, since loading context for zero rows is
  // pure waste repeated on every tick.
  const outcome = await runStage({
    ...advancingStage(port),
    prepare: () => Promise.reject(new Error("prepare must not run for an empty batch")),
  });
  // Succeeded with zeros.
  assert.equal(outcome.status, "succeeded");
  assert.equal(outcome.rowsIn, 0);
  // And the run was still recorded, because "the stage ran and found nothing" and "the
  // stage never ran" must be distinguishable — that is the §14 silent death.
  assert.equal(port.closed.length, 1);
});

// ── RULE 6: NO ROLLBACK. RELEASE THE CLAIM. ─────────────────────────────────────────

test("quota exhaustion releases the current row AND every row not yet processed", async () => {
  // The switch on, three rows claimed.
  const port = makeFakePort({ settings: ENABLED, claims: { passed_filters: THREE_ROWS } });
  // Row 1 succeeds; row 2 finds every key cooling.
  let seen = 0;
  const outcome = await runStage({
    ...advancingStage(port),
    handleRow: () => {
      // Count the rows offered.
      seen += 1;
      // First row works.
      if (seen === 1) return Promise.resolve({ kind: "advanced" as const });
      // Second row hits the empty pool — and so would the third, so trying it is a
      // wasted round trip against a pool we already know is cooling.
      return Promise.resolve({ kind: "quota_exhausted" as const });
    },
  });
  // The loop stopped rather than hammering a pool it knows is empty.
  assert.equal(seen, 2);
  // Both unfinished rows were given back — app-2, which hit the wall, and app-3, which
  // was never offered at all. A row left claimed sits out its whole lease for nothing.
  assert.deepEqual(
    port.callsTo("releaseClaim").map((call) => call.args[0]),
    ["app-2", "app-3"],
  );
  // NO STATUS WRITE AT ALL FROM THE LOOP ITSELF, and that is rule 6 stated exactly.
  // Advancing is the handler's business (this stub does not do it), so every
  // `advanceStatus` call recorded here would be a ROLLBACK the loop had invented. There
  // is no backward edge on the automated forward path and none is needed: claiming took
  // a lease and never moved `status`, so an agent that gives up has nothing to undo.
  assert.equal(port.callsTo("advanceStatus").length, 0);
  // Recorded as `skipped_quota`, which is NOT a failure — §14: quota exhaustion is not
  // an error, and labelling it one trains Teja to ignore the health page.
  assert.equal(outcome.status, "skipped_quota");
  // The one row that did work still counted.
  assert.equal(outcome.rowsOut, 1);
  // And it is not counted as an error either.
  assert.equal(outcome.errorCount, 0);
});

test("an empty key POOL is reported as needing a human, unlike ordinary cooling", async () => {
  // The switch on.
  const port = makeFakePort({ settings: ENABLED, claims: { passed_filters: THREE_ROWS } });
  // `gemini_key_state` has no rows at all, because nothing ever seeded it.
  const outcome = await runStage({
    ...advancingStage(port),
    handleRow: () => Promise.resolve({ kind: "needs_human" as const, detail: "no_keys_configured" }),
  });
  // Rows are still released — the work is not lost.
  assert.equal(port.callsTo("releaseClaim").length, 3);
  // But this is a FAILED run, not a skipped one. Same SQL NULL as cooling, opposite
  // response: cooling self-heals and this never will until a person acts.
  assert.equal(outcome.status, "failed");
  // And the reason is on the run row.
  assert.match(String(outcome.errorDetail), /no_keys_configured/);
});

test("a per-row error releases that row and counts it, without stopping the batch", async () => {
  // The switch on, three rows.
  const port = makeFakePort({ settings: ENABLED, claims: { passed_filters: THREE_ROWS } });
  // Middle row fails; the others must still be processed.
  let seen = 0;
  const outcome = await runStage({
    ...advancingStage(port),
    handleRow: () => {
      seen += 1;
      // One bad row must not cost the other four their turn.
      if (seen === 2) return Promise.resolve({ kind: "errored" as const, detail: "model returned 87 fields" });
      return Promise.resolve({ kind: "advanced" as const });
    },
  });
  // Every row was offered.
  assert.equal(seen, 3);
  // Two advanced.
  assert.equal(outcome.rowsOut, 2);
  // One counted as an error.
  assert.equal(outcome.errorCount, 1);
  // The failed row was released so the next cron tick can retry it immediately rather
  // than waiting out the lease.
  assert.deepEqual(port.callsTo("releaseClaim").map((call) => call.args[0]), ["app-2"]);
  // Partial progress is still a successful run: some rows moved. A run marked `failed`
  // because one row of five was bad would make the health page useless.
  assert.equal(outcome.status, "succeeded");
  // But the detail is preserved.
  assert.match(String(outcome.errorDetail), /87 fields/);
});

test("a batch where EVERY row errored is a failed run", async () => {
  // The switch on.
  const port = makeFakePort({ settings: ENABLED, claims: { passed_filters: THREE_ROWS } });
  // Nothing works.
  const outcome = await runStage({
    ...advancingStage(port),
    handleRow: () => Promise.resolve({ kind: "errored" as const, detail: "boom" }),
  });
  // No progress at all is a failure, which is the signal a systematic bug produces.
  assert.equal(outcome.status, "failed");
  assert.equal(outcome.rowsOut, 0);
});

test("a failed preparation releases the whole batch instead of stranding it", async () => {
  // The switch on, three rows claimed.
  const port = makeFakePort({ settings: ENABLED, claims: { passed_filters: THREE_ROWS } });
  // The context load fails — e.g. the filter rules could not be read.
  const outcome = await runStage({
    ...advancingStage(port),
    prepare: () => Promise.resolve({ ok: false as const, reason: "filter_rules unreadable" }),
  });
  // Failed.
  assert.equal(outcome.status, "failed");
  // But every claimed row was handed back. Rows claimed and then abandoned are invisible
  // for a full lease period, which reads as a slow pipeline rather than as a broken one.
  assert.equal(port.callsTo("releaseClaim").length, 3);
  // And nothing was advanced on a context we could not build.
  assert.equal(port.callsTo("advanceStatus").length, 0);
});

test("a failed claim is a failed run, not a silently empty one", async () => {
  // The switch on, but the claim RPC itself fails.
  const port = makeFakePort({ settings: ENABLED, claimError: "statement timeout" });
  // Run.
  const outcome = await runStage(advancingStage(port));
  // Failed. An empty batch and an unreachable queue must never produce the same run row:
  // the first is a quiet day and the second is an outage.
  assert.equal(outcome.status, "failed");
  assert.match(String(outcome.errorDetail), /statement timeout/);
});

test("losing the run row does not lose the work", async () => {
  // The switch on, but the `agent_runs` insert fails.
  const port = makeFakePort({ settings: ENABLED, claims: { passed_filters: THREE_ROWS }, openRunError: "insert denied" });
  // Run.
  const outcome = await runStage(advancingStage(port));
  // The batch was still processed: observability is not a prerequisite for work.
  assert.equal(outcome.rowsOut, 3);
  // And the claim still identified the agent, falling back to a marker rather than to
  // the string "null", which would be indistinguishable from a real run id.
  assert.equal(port.callsTo("claimApplications")[0]?.args[1], "matcher:unrecorded");
});

test("the sweeper runs before the claim, and its counts reach the run detail", async () => {
  // A sweep that actually reclaimed something, including a safety-critical routing.
  const port = makeFakePort({
    settings: ENABLED,
    claims: { passed_filters: THREE_ROWS },
    sweep: { releasedCount: 4, needsVerificationCount: 1 },
  });
  // Run.
  const outcome = await runStage(advancingStage(port));
  // The sweep precedes the claim, so a crashed peer's rows are available to THIS run
  // rather than to the next one.
  assert.equal(port.names().indexOf("sweepStaleClaims") < port.names().indexOf("claimApplications"), true);
  // A stale `applying` row routed to `needs_verification` is safety-critical and must be
  // visible: it means a worker died mid-submit and a human has to check the employer's
  // portal before anything touches that row again.
  assert.match(String(outcome.errorDetail), /needs_verification=1/);
});
