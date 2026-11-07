// matcherRunReason: the top-level `reason` a reader of the matcher's response can show (2026-11-07).
// Red on revert: return null from matcherRunReason and every non-null case below goes red.

// Node's built-in runner, so the suite runs under `node --test` with no install.
import { test } from "node:test";
// Strict assertions.
import assert from "node:assert/strict";
// The unit under test.
import { matcherRunReason } from "./run-reason.ts";

// A Gemini rate-limit failure as the matcher records it (formatGeminiFailure's shape).
const RATE_LIMIT = "gemini_call_failed: rate_limited_all_retries_exhausted status=429 Resource has been exhausted";

test("a targeted run that found nothing says why: the row is at another status", () => {
  // The row exists, at scored.
  assert.deepEqual(matcherRunReason({ targeted: true, found: 0, target: { status: "scored", disappeared: false }, failures: [] }), {
    code: "target_not_at_input_status",
    message: "The application is at scored, not passed_filters, so the matcher has nothing to score.",
    status: "scored",
  });
});

test("a targeted run that found nothing says why: the posting is gone", () => {
  // At passed_filters, but its job left the board (the select skips disappeared jobs).
  assert.deepEqual(matcherRunReason({ targeted: true, found: 0, target: { status: "passed_filters", disappeared: true }, failures: [] })?.code, "target_posting_gone");
});

test("a targeted run that found nothing says why: no such application", () => {
  // The lookup found no row.
  assert.deepEqual(matcherRunReason({ targeted: true, found: 0, target: null, failures: [] })?.code, "target_not_found");
});

test("a rate-limited run names it at the top level, with the failure text verbatim", () => {
  // One ordinary failure and one rate limit.
  const reason = matcherRunReason({ targeted: false, found: 3, target: undefined, failures: [{ error: "write failed" }, { error: RATE_LIMIT }] });
  // The rate limit, quoted exactly as failures[].error carries it.
  assert.deepEqual(reason, { code: "rate_limited", message: RATE_LIMIT });
});

// The controls: nothing to explain means null, and an unknown target (lookup failed) is not "not found".
test("controls: a normal run, or a target the lookup could not read, gives no reason", () => {
  // A run that scored rows with no rate limit.
  assert.equal(matcherRunReason({ targeted: false, found: 5, target: undefined, failures: [{ error: "write failed" }] }), null);
  // A targeted run that found its row.
  assert.equal(matcherRunReason({ targeted: true, found: 1, target: undefined, failures: [] }), null);
  // The lookup errored (undefined): unknown is never reported as "not found" (CLAUDE.md §6).
  assert.equal(matcherRunReason({ targeted: true, found: 0, target: undefined, failures: [] }), null);
});
