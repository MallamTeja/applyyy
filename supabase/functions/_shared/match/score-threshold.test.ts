// Tests for the score threshold — the decision that turns a fit score into a status move.
//
// WHAT THESE PROTECT is the one place a low score stops a job from reaching the Tailor.
// Before this gate every scored row advanced to `scored`, so a 5/100 match would be
// tailored, audited and queued for Teja exactly like a 90. Three ways it can go wrong:
//
//   1. THE BOUNDARY OFF BY ONE. 45 is the floor of the human-review band, so 45 must
//      advance and 44 must drop. A `>` where `>=` belongs drops the first reviewable job.
//   2. GARBAGE BECOMING A VERDICT. NaN compares false against everything, so a naive
//      `score < 45` reads NaN as "not below" and advances it. Missing data must never
//      become an answer — it must stay put and be reported.
//   3. THE WRONG SCALE. The scorer emits integers 0-100. A 0-1 fraction like 0.82 would
//      read as a near-zero score and be dropped silently; it must be refused instead.
import { test } from "node:test";
// Strict, so 45 and "45" never compare equal.
import assert from "node:assert/strict";
// The unit under test, plus the threshold constant, imported so the drop-reason rows below
// compare against it instead of restating it.
import { decideScoreThreshold, MATCH_ADVANCE_FLOOR } from "./score-threshold.ts";

// The threshold is pinned here on purpose: changing it must be a visible, reviewed edit
// to this test, not something that drifts in with an unrelated rubric change.
test("the advance floor is 45, the floor of the rubric's moderate (human-review) band", () => {
  // If this fails, someone retuned the bands — re-read rubric.ts §P3 before updating.
  assert.equal(MATCH_ADVANCE_FLOOR, 45);
});

// Table-driven so each boundary reads as one row and a missing case is visible.
const ADVANCES: ReadonlyArray<[number, string]> = [
  // The exact floor: the first score the human-review band contains.
  [45, "moderate"],
  // Inside moderate.
  [59, "moderate"],
  // Good band floor.
  [60, "good"],
  // Strong band floor.
  [75, "strong"],
  // The top of the scale.
  [100, "strong"],
];

// Every score at or above the floor advances to `scored` and carries its band.
for (const [score, band] of ADVANCES) {
  test(`score ${score} advances to scored (${band})`, () => {
    // The whole decision is compared, so an extra or missing field also fails.
    assert.deepEqual(decideScoreThreshold(score), { kind: "advance", score, band });
  });
}

// Scores below the floor drop, with the score in the reason so the dashboard can show why.
const DROPS: ReadonlyArray<[number, string]> = [
  // One below the floor: the off-by-one this file exists to catch.
  [44, "weak"],
  // The weak band floor.
  [30, "weak"],
  // Just inside poor.
  [29, "poor"],
  // The bottom of the scale is a real score, not a missing one.
  [0, "poor"],
];

// Every score below the floor drops to `dropped_filter`.
for (const [score, band] of DROPS) {
  test(`score ${score} drops (${band})`, () => {
    // drop_reason is a BARE code like the screener's `tech_gate`; the score lives in p_detail.
    assert.deepEqual(decideScoreThreshold(score), { kind: "drop", score, band, reason: "match_below_threshold" });
  });
}

// Inputs that are not a 0-100 integer. Each must be refused, never advanced or dropped.
const INVALID: ReadonlyArray<[unknown, string]> = [
  // NaN: the case a bare `<` comparison silently advances.
  [Number.NaN, "NaN"],
  // Null: a score that was never produced.
  [null, "null"],
  // Undefined: a field that was never read.
  [undefined, "undefined"],
  // A numeric string: right value, wrong type, so something upstream is mis-parsing.
  ["70", "string"],
  // Infinity: finite-ness is part of the shape.
  [Number.POSITIVE_INFINITY, "Infinity"],
  // Below the scale.
  [-1, "negative"],
  // Above the scale; the DB CHECK would reject it later anyway.
  [101, "over 100"],
  // The wrong scale: a 0-1 fraction. The scorer only emits integers (weightedTotal rounds).
  [0.82, "0-1 fraction"],
  // A non-integer on the right scale is still not what the scorer emits.
  [44.5, "non-integer"],
];

// Every invalid input fails closed: no status move, and a reason for the failures list.
for (const [input, label] of INVALID) {
  test(`invalid score (${label}) fails closed`, () => {
    // Read the decision once, so the assertions below inspect the same value.
    const decision = decideScoreThreshold(input);
    // Must be the refusal variant: neither advance nor drop.
    assert.equal(decision.kind, "invalid");
    // The reason names the problem, so the per-row failure entry is actionable.
    assert.match((decision as { reason: string }).reason, /^invalid_match_score:/);
  });
}
