// Tests for the per-invocation deadline planner.
// node:test so the file runs under Deno and `node --test` alike.
import { test } from "node:test";
// Strict, so number/undefined never compare loosely equal.
import assert from "node:assert/strict";
// Read-only access to the Gemini client's source for the tripwire test below.
import { readFileSync } from "node:fs";
// Turns import.meta.url into a path on both Windows and POSIX.
import { fileURLToPath } from "node:url";
// Extension-suffixed specifier, matching the other _shared tests.
import {
  createDeadline,
  DEFAULT_MAX_RETRIES,
  DEFAULT_TIMEOUT_MS,
  deadlineNote,
  planCall,
  runBatchWithDeadline,
  shortenedBudgetNote,
  worstCaseCallMs,
} from "./deadline.ts";

// The client whose retry behaviour this planner models. A constant so a scratch copy can be
// swapped in to prove the tripwire goes red.
const CLIENT_SOURCE_PATH = fileURLToPath(new URL("../gemini/client.ts", import.meta.url));

// THE TRIPWIRE. deadline.ts duplicates the client's backoff table and defaults because the
// client does not export them; this test reads the client's SOURCE so a change there fails
// here instead of silently making the planner under-estimate a call's worst case.
test("client.ts still matches the backoff table and defaults deadline.ts assumes", () => {
  // Source text, not an import: the table is a module-private const.
  const src = readFileSync(CLIENT_SOURCE_PATH, "utf8");
  // Asserting on the declaration shape, so a mention in a comment cannot satisfy it.
  const table = /const BACKOFF_BASE_MS: readonly number\[\] = \[([\d,\s]+)\];/.exec(src);
  // A missing declaration means the client was refactored and this model needs a re-read.
  assert.ok(table, "BACKOFF_BASE_MS declaration not found in client.ts");
  // The client's real table, parsed to numbers.
  const clientTable = table[1]!.split(",").map((n) => Number(n.trim()));
  // Expected worst case per retry count, computed from the CLIENT's table with 25% jitter.
  for (let retries = 0; retries <= 3; retries++) {
    // Same formula as worstCaseCallMs but fed by the client's numbers, not our copy.
    let expected = (retries + 1) * DEFAULT_TIMEOUT_MS;
    for (let i = 0; i < retries; i++) expected += clientTable[Math.min(i, clientTable.length - 1)]! * 1.25;
    // Fails if our copy of the table drifted from the client's.
    assert.equal(worstCaseCallMs({ timeoutMs: DEFAULT_TIMEOUT_MS, maxRetries: retries }), expected, `retries=${retries}`);
  }
  // The default per-attempt timeout, as written in the client's option handling.
  assert.match(src, new RegExp(`const timeoutMs = options\\.timeoutMs \\?\\? ${DEFAULT_TIMEOUT_MS};`));
  // The default retry count, as written in the client's option handling.
  assert.match(src, new RegExp(`options\\.maxRetries \\?\\? ${DEFAULT_MAX_RETRIES}\\)`));
});

// Table: the formula, including the documented defaults figure.
test("worstCaseCallMs follows (retries+1)*timeout + max-jitter backoffs", () => {
  // Rows are [timeout, retries, expected ms], worked by hand from the formula.
  const cases: Array<[number, number, number]> = [
    [25000, 3, 113750], // defaults: 100000 + 1250 + 3750 + 8750
    [25000, 0, 25000], // no retries means no backoff
    [25000, 1, 51250], // one backoff: 1250
    [25000, 2, 80000], // 75000 + 1250 + 3750
    [15000, 3, 73750], // smaller timeout, same backoffs
  ];
  for (const [timeoutMs, maxRetries, expected] of cases) {
    // The message names the case so a red row identifies itself.
    assert.equal(worstCaseCallMs({ timeoutMs, maxRetries }), expected, `t=${timeoutMs} r=${maxRetries}`);
  }
});

// Table: the planner at each regime. Margin is 10000, floor 15000.
test("planCall trades retries first, then timeout, then stops", () => {
  // Rows are [remaining ms, expected plan]; boundaries sit exactly on the sums.
  const cases: Array<[number, unknown]> = [
    // plenty: 113750 + 10000 = 123750 needed for full retries
    [200000, { kind: "call", timeoutMs: 25000, maxRetries: 3 }],
    [123750, { kind: "call", timeoutMs: 25000, maxRetries: 3 }],
    // medium: one ms short of full retries drops to 2, and so on down
    [123749, { kind: "call", timeoutMs: 25000, maxRetries: 2 }],
    [61250, { kind: "call", timeoutMs: 25000, maxRetries: 1 }],
    [61249, { kind: "call", timeoutMs: 25000, maxRetries: 0 }],
    [35000, { kind: "call", timeoutMs: 25000, maxRetries: 0 }],
    // tight: the timeout shrinks to remaining minus margin
    [34000, { kind: "call", timeoutMs: 24000, maxRetries: 0 }],
    [25000, { kind: "call", timeoutMs: 15000, maxRetries: 0 }],
    // below the floor, and already past the deadline
    [24999, { kind: "stop" }],
    [-5000, { kind: "stop" }],
  ];
  for (const [remaining, expected] of cases) {
    // deepEqual because the plan is an object; the message names the row.
    assert.deepEqual(planCall(remaining), expected, `remaining=${remaining}`);
  }
});

// A clock that only moves when a test says so, so no test depends on real elapsed time.
function fakeClock(start = 0) {
  // The current fake time in ms.
  let now = start;
  return { clock: () => now, advance: (ms: number) => { now += ms; } };
}

test("3 rows at 50 s each under a 120 s budget: 2 processed, 1 skipped", async () => {
  // Fresh clock per test so tests cannot leak time into each other.
  const t = fakeClock();
  const deadline = createDeadline({ budgetMs: 120000, clock: t.clock });
  // What each row was told, to prove the budget shrinks as time passes.
  const seen: unknown[] = [];
  const outcome = await runBatchWithDeadline(["a", "b", "c"], async (_item, call) => {
    // Record the plan this row received.
    seen.push(call);
    // Each row costs 50 s, simulating a saturated model.
    t.advance(50000);
  }, { deadline, targeted: false });
  // Row 1: 120000 left -> 110000 usable -> 2 retries (80000). Row 2: 70000 -> 60000 -> 1 retry.
  // Row 3: 20000 left is under the 25000 floor-plus-margin, so it stops.
  assert.deepEqual(seen, [
    { timeoutMs: 25000, maxRetries: 2 },
    { timeoutMs: 25000, maxRetries: 1 },
  ]);
  // Two rows attempted, one left for the next run, and the stop is flagged.
  assert.deepEqual(outcome, { processed: 2, skippedForDeadline: 1, stoppedEarly: true });
});

test("a batch with time to spare processes everything and is not stoppedEarly", async () => {
  // Cheap rows (1 s each) against the full budget: the clock never forces a stop.
  const t = fakeClock();
  const outcome = await runBatchWithDeadline([1, 2], async () => { t.advance(1000); }, {
    deadline: createDeadline({ budgetMs: 120000, clock: t.clock }),
    targeted: false,
  });
  // Nothing skipped and no stop flag: the queue, not the clock, ended the batch.
  assert.deepEqual(outcome, { processed: 2, skippedForDeadline: 0, stoppedEarly: false });
});

test("targeted mode gets the full default budget even with no time left", async () => {
  const t = fakeClock();
  // Budget already overdrawn at creation: an untargeted run would stop at once.
  const deadline = createDeadline({ budgetMs: -1000, clock: t.clock });
  // Captured inside the callback to inspect what the runner passed.
  let seen: unknown;
  const outcome = await runBatchWithDeadline(["only"], async (_i, call) => { seen = call; }, {
    deadline,
    targeted: true,
  });
  // A direct request for one row keeps the full retry budget.
  assert.deepEqual(seen, { timeoutMs: 25000, maxRetries: 3 });
  // And the row is processed, not skipped.
  assert.deepEqual(outcome, { processed: 1, skippedForDeadline: 0, stoppedEarly: false });
});

test("an item that throws propagates; index.ts keeps its own per-row try/catch", async () => {
  // A frozen clock: the throw, not time, is what is under test.
  const deadline = createDeadline({ budgetMs: 120000, clock: () => 0 });
  // Documented behaviour: the helper does not swallow, so a real bug is not hidden.
  await assert.rejects(
    runBatchWithDeadline(["x"], async () => { throw new Error("boom"); }, { deadline, targeted: false }),
    /boom/,
  );
});

test("never stops mid-item: each item finishes before the next deadline check", async () => {
  const t = fakeClock();
  // Ordered log of start/end events to prove no interleaving.
  const log: string[] = [];
  await runBatchWithDeadline(["a", "b"], async (item) => {
    log.push(`start ${item}`);
    // The deadline passes while this item is still running.
    t.advance(200000);
    // One microtask yield is enough to give a (hypothetical) mid-item stop a chance to run.
    await Promise.resolve();
    log.push(`end ${item}`);
  }, { deadline: createDeadline({ budgetMs: 120000, clock: t.clock }), targeted: false });
  // Item a ran to its end despite the expired clock; b was never started.
  assert.deepEqual(log, ["start a", "end a"]);
});

test("deadlineNote is null on a clean run and says attempted, not processed, on a stop", () => {
  // No stop, no note: a clean run must not carry a deadline line.
  assert.equal(deadlineNote({ processed: 3, skippedForDeadline: 0, stoppedEarly: false }), null);
  // "attempted" because the count includes rows that ran and failed.
  assert.equal(
    deadlineNote({ processed: 2, skippedForDeadline: 1, stoppedEarly: true }),
    "deadline: attempted 2 of 3; 1 left for next run",
  );
});

test("shortenedBudgetNote is empty at the full budget and names a reduced one", () => {
  // Full budget: a failure there is the model's, so no suffix.
  assert.equal(shortenedBudgetNote({ timeoutMs: 25000, maxRetries: 3 }), "");
  // Fewer retries: the deadline reduced it, so the failure says so.
  assert.equal(shortenedBudgetNote({ timeoutMs: 25000, maxRetries: 1 }), " (deadline-shortened budget: 25000ms, 1 retries)");
  // A shortened timeout counts too.
  assert.equal(shortenedBudgetNote({ timeoutMs: 18000, maxRetries: 0 }), " (deadline-shortened budget: 18000ms, 0 retries)");
});
