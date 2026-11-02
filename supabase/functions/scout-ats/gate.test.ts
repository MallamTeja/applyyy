// Node test runner, same as every other pure-function test in supabase/functions.
import { test } from "node:test";
// Bare asserts; no framework (repo convention).
import assert from "node:assert/strict";
// W12 wiring check: reads index.ts as text, because it runs Deno.serve on import.
import { readFileSync } from "node:fs";
// The gates under test.
import { haltedByKillSwitch, planScoutRunClose } from "./gate.ts";

test("force=true does not bypass the kill switch", () => {
  // The whole point: a disabled system halts even a forced manual run.
  assert.equal(haltedByKillSwitch(false, true), true);
  // The ordinary scheduled run halts too.
  assert.equal(haltedByKillSwitch(false, false), true);
  // An enabled system runs, forced or not — the switch halts, it never blocks.
  assert.equal(haltedByKillSwitch(true, true), false);
  assert.equal(haltedByKillSwitch(true, false), false);
});

// A context load that worked. Only `ok` matters to the close.
const SCREENED = { ok: true } as const;

test("W12: a run whose screener never ran is flagged on the run row and answered non-2xx", () => {
  // Every board polled fine, but filter_rules could not be read, so rows went in at 'discovered'.
  const close = planScoutRunClose({
    // Four boards polled.
    attemptedBoards: 4,
    // None failed.
    failedBoardDetails: [],
    // No liveness refusals.
    livenessRefusals: [],
    // The screener's context load failed.
    screenContext: { ok: false, reason: "filter_rules query failed: timeout" },
  });

  // The run still did its polling job (rows are kept), so it is not `failed`, but it
  // carries an error the health page shows as "succeeded with 1 error".
  assert.equal(close.status, "succeeded");
  // Non-zero: the old close said 0 and the health page stayed green.
  assert.equal(close.errorCount, 1);
  // The labelled reason, first, so the 200-char cap can never cut it.
  assert.equal(close.errorDetail, "screener_not_run: filter_rules query failed: timeout");
  // The caller sees it: a non-2xx with a named error, not a 200 with success:true.
  assert.deepEqual(close.httpError, { status: 500, error: "screener_not_run", detail: "filter_rules query failed: timeout" });
});

test("W12: board failures keep their count and detail, behind the screener_not_run segment", () => {
  // Two of three boards failed AND the screener did not run.
  const close = planScoutRunClose({
    // Three attempted.
    attemptedBoards: 3,
    // Two failed.
    failedBoardDetails: ["greenhouse/acme: boom", "lever/beta: 404"],
    // One refusal, in its own labelled segment.
    livenessRefusals: ["ashby/gamma: empty_listing"],
    // The context load failed.
    screenContext: { ok: false, reason: "search_preferences query failed: no rows returned" },
  });

  // One board polled, so the run is still a success with errors.
  assert.equal(close.status, "succeeded");
  // Two board failures plus the unscreened insert.
  assert.equal(close.errorCount, 3);
  // Screener first, then boards, then the liveness segment, exactly as before for the last two.
  assert.equal(
    close.errorDetail,
    "screener_not_run: search_preferences query failed: no rows returned; greenhouse/acme: boom; lever/beta: 404; liveness_refused: ashby/gamma: empty_listing",
  );
});

test("a clean, screened run closes succeeded with no detail and a 200", () => {
  // The ordinary healthy run.
  const close = planScoutRunClose({ attemptedBoards: 5, failedBoardDetails: [], livenessRefusals: [], screenContext: SCREENED });

  // Unchanged from before W12: succeeded, zero errors, null detail, 200.
  assert.deepEqual(close, { status: "succeeded", errorCount: 0, errorDetail: null, httpError: null });
});

test("every attempted board failing is still a failed run; at most five board reasons are kept", () => {
  // Six boards, all failed.
  const details = ["a", "b", "c", "d", "e", "f"].map((b) => `greenhouse/${b}: down`);
  // Screened fine (the context load does not depend on the boards).
  const close = planScoutRunClose({ attemptedBoards: 6, failedBoardDetails: details, livenessRefusals: [], screenContext: SCREENED });

  // The honest close from 2026-10-04: nothing polled, so the run failed.
  assert.equal(close.status, "failed");
  // Every failure counted.
  assert.equal(close.errorCount, 6);
  // Only the first five reasons, so the column stays bounded.
  assert.equal(close.errorDetail, details.slice(0, 5).join("; "));
  // The screener ran, so no W12 flag; the all-failed reading is the run row's job.
  assert.equal(close.httpError, null);
});

test("W12: scout-ats/index.ts closes its run and answers from planScoutRunClose", () => {
  // The entry point, as text.
  const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
  // The run row takes its status and error count from the plan.
  assert.match(source, /status: close\.status/);
  // Same for the count.
  assert.match(source, /error_count: close\.errorCount/);
  // And the response status from the plan's httpError.
  assert.match(source, /jsonResponse\(close\.httpError\.status/);
});
