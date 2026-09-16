// Tests for the fit rubric — the weighted dimensions and the band boundaries.
//
// WHAT THESE PROTECT is a number a human will trust without re-deriving it. A fit score
// is read as a judgement, so every way it can be quietly wrong is a way to mislead Teja
// into skipping a good job or applying to a bad one. The three failure modes covered
// here, in order of how silently they fail:
//
//   1. A MISSING DIMENSION DEFAULTING TO ZERO. A silent zero on the 30% technical weight
//      drags a Strong Fit (75+) to Weak (30-44). It reads as "the model judged this
//      harshly", not "the model never answered", and nothing in the output distinguishes
//      them. It must raise instead.
//   2. WEIGHTS DRIFTING OFF 100. Any future edit that changes one weight without
//      rebalancing silently rescales every score ever produced, including stored ones.
//   3. BAND BOUNDARIES OFF BY ONE. The bands drive a routing decision, so 75 landing in
//      the wrong band changes what happens to the job, not just what it is called.
import { test } from "node:test";
// Strict, so a score of 0 never quietly compares equal to a missing one.
import assert from "node:assert/strict";
// The unit under test.
import { DIMENSION_WEIGHTS, bandForScore, weightedTotal, type DimensionScores } from "./rubric.ts";

// A complete, uncontroversial set of dimension scores. Tests override one field at a
// time so each reads as the single thing it is about.
const COMPLETE: DimensionScores = { technical: 80, experience: 80, behavioral: 80, career: 80 };

// --- the weights themselves ---

// The four weights are adopted verbatim from upstream's tested rubric: Technical 30,
// Experience 25, Behavioral 15, Career 30. Location is the fifth dimension and is
// deliberately unweighted because it is a gate — which is the same shape the salary gate
// takes. Pinning them here means a future edit has to state its intent rather than drift.
test("the four weights are the adopted 30/25/15/30", () => {
  assert.equal(DIMENSION_WEIGHTS.technical, 30);
  assert.equal(DIMENSION_WEIGHTS.experience, 25);
  assert.equal(DIMENSION_WEIGHTS.behavioral, 15);
  assert.equal(DIMENSION_WEIGHTS.career, 30);
});

// THE GUARD THAT CATCHES A REBALANCE NOBODY MEANT. If a weight is edited without
// adjusting the others, every score silently changes scale — including scores already
// stored in applications.match_score, which would then be incomparable with new ones.
test("the weights sum to exactly 100", () => {
  const sum = Object.values(DIMENSION_WEIGHTS).reduce((a, b) => a + b, 0);
  assert.equal(sum, 100);
});

// --- the weighted total ---

// The trivial case: all dimensions equal means the total equals them, whatever the
// weights are. This is the test that fails loudly if the weighting maths is inverted.
test("a uniform set of scores totals to that same score", () => {
  assert.equal(weightedTotal(COMPLETE), 80);
});

// A worked asymmetric case, computed by hand so the test does not simply restate the
// implementation: 90*30 + 60*25 + 40*15 + 70*30 = 2700 + 1500 + 600 + 2100 = 6900, /100.
test("an asymmetric set of scores is weighted, not averaged", () => {
  const scores: DimensionScores = { technical: 90, experience: 60, behavioral: 40, career: 70 };
  // A plain mean would be 65. The weighted answer is 69, and the difference is the point.
  assert.equal(weightedTotal(scores), 69);
});

// HALF-UP, NOT FLOOR. 70*30 + 72*25 + 70*15 + 70*30 = 7050, so the exact total is 70.5.
// Floor gives 70 and half-up gives 71, so this case distinguishes them. Chosen because a
// truncating implementation passes every other test in this file.
test("a total landing exactly on .5 rounds half-up, not down", () => {
  const scores: DimensionScores = { technical: 70, experience: 72, behavioral: 70, career: 70 };
  assert.equal(weightedTotal(scores), 71);
});

// --- refusing to invent a score ---

// THE MOST IMPORTANT TEST IN THIS FILE. A dimension the model failed to return must stop
// the calculation, never contribute zero. Defaulting would turn an incomplete answer into
// a confident-looking bad one, and there is no field in the output that would reveal it.
test("a missing dimension raises rather than defaulting to zero", () => {
  // Cast through unknown because the whole point is a value the type system forbids but
  // a JSON response from an LLM can still produce.
  const incomplete = { technical: 80, experience: 80, behavioral: 80 } as unknown as DimensionScores;
  assert.throws(() => weightedTotal(incomplete), /career/);
});

// A null arriving from a JSON response is absence wearing a different hat, and must fail
// the same way rather than coercing to 0.
test("a null dimension raises rather than coercing to zero", () => {
  const nulled = { ...COMPLETE, behavioral: null } as unknown as DimensionScores;
  assert.throws(() => weightedTotal(nulled), /behavioral/);
});

// A score outside 0-100 means the model ignored the scale, and silently clamping it would
// hide that. applications.match_score has a CHECK constraint for 0-100, so an out-of-range
// value would be rejected by the database anyway — better to fail where it is diagnosable.
test("a dimension outside 0-100 raises rather than being clamped", () => {
  const tooHigh = { ...COMPLETE, technical: 120 } as unknown as DimensionScores;
  assert.throws(() => weightedTotal(tooHigh), /technical/);
});

// --- the bands, which drive routing rather than description ---

// Boundaries are tested at the exact edge rather than in the middle of each range,
// because an off-by-one is the only realistic way these get written wrong.
test("75 is the bottom of Strong Fit", () => {
  assert.equal(bandForScore(75), "strong");
  assert.equal(bandForScore(74), "good");
});

test("60 is the bottom of Good Fit", () => {
  assert.equal(bandForScore(60), "good");
  assert.equal(bandForScore(59), "moderate");
});

// The human-review band. §P3 routes Moderate to the human bucket, so this boundary is
// the one that decides whether Teja is asked or not.
test("45 is the bottom of Moderate Fit, the human-review band", () => {
  assert.equal(bandForScore(45), "moderate");
  assert.equal(bandForScore(44), "weak");
});

test("30 is the bottom of Weak Fit and below it is Poor", () => {
  assert.equal(bandForScore(30), "weak");
  assert.equal(bandForScore(29), "poor");
});

// The extremes, so the ends of the scale are covered rather than assumed.
test("the ends of the scale land in the expected bands", () => {
  assert.equal(bandForScore(100), "strong");
  assert.equal(bandForScore(0), "poor");
});
