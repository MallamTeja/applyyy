// Tests for the Matcher eval gate.
//
// WHAT IS BEING TESTED HERE IS THE GATE, NOT THE MATCHER. The scorer is injected, so
// none of this spends Gemini quota — and that separation is the point: the gate's own
// logic (thresholds, the borderline asymmetry, staleness, the empty and placeholder
// warnings) has to be correct BEFORE any real label exists, or Teja's ~20 hand-labels
// would be data entry into a pipeline nobody had verified.
import { test } from "node:test";
// Strict, so a `false` verdict never compares equal to a count of zero.
import assert from "node:assert/strict";
// Node's file reader, used to prove the committed fixture actually parses.
import { readFileSync } from "node:fs";
// Resolve the fixture relative to this file rather than to the working directory,
// so the test passes wherever it is invoked from.
import { fileURLToPath } from "node:url";
// Extension-suffixed specifier for Deno/Node convergence.
import { formatGateReport, runEvalGate, type EvalCase, type EvalFixture, type GateThresholds, type Scorer } from "./gate.ts";

// The thresholds these tests grade against. Explicit rather than imported from a
// default, because a default threshold would make the tests agree with the
// implementation by construction rather than by assertion.
const THRESHOLDS: GateThresholds = { goodFitAtOrAbove: 70, badFitAtOrBelow: 40 };

// Build one case. Only the fields the gate actually reads need to vary.
function evalCase(id: string, label: EvalCase["label"], masterVersion: number | null = null): EvalCase {
  return {
    id,
    // The snapshot is inert as far as the gate is concerned — it is the scorer's input.
    job_snapshot: {
      title: "Backend Engineering Intern",
      company_name: "Test Co",
      location_raw: "Bengaluru, India",
      description_raw: "Node.js REST APIs.",
      min_experience_years: "0",
      employment_type: "internship",
    },
    label,
    rationale: null,
    master_version: masterVersion,
  };
}

// Wrap cases in a fixture envelope.
function fixture(cases: EvalCase[], placeholder = false, masterVersion: number | null = null): EvalFixture {
  return { schema_version: 1, exported_at: "2026-09-10T00:00:00.000Z", master_version: masterVersion, placeholder, cases };
}

// A scorer that returns a fixed score per case id. A lookup table rather than a mock
// framework, so what the fake does is visible in the test that uses it.
function scorerFor(scores: Readonly<Record<string, number>>): Scorer {
  return (entry) => Promise.resolve({ score: scores[entry.id] ?? 0, reasoning: `stub reasoning for ${entry.id}` });
}

// --- threshold mapping -----------------------------------------------------------

// The straightforward case: the machine agrees with the human on both clear labels.
test("scores above and below the thresholds map to the matching labels", async () => {
  // One clear positive and one clear negative.
  const report = await runEvalGate(
    fixture([evalCase("good", "good_fit"), evalCase("bad", "bad_fit")]),
    scorerFor({ good: 85, bad: 10 }),
    THRESHOLDS,
  );
  // Both agreed.
  assert.equal(report.passed, true);
  assert.equal(report.agreed, 2);
});

// The boundaries are INCLUSIVE on both ends, and this is worth pinning: an off-by-one
// here would silently reclassify every case sitting exactly on a threshold, which is
// where a tuned prompt tends to cluster its outputs.
test("the thresholds are inclusive at both boundaries", async () => {
  // Exactly at each edge.
  const report = await runEvalGate(
    fixture([evalCase("at-good", "good_fit"), evalCase("at-bad", "bad_fit")]),
    scorerFor({ "at-good": 70, "at-bad": 40 }),
    THRESHOLDS,
  );
  // Both counted as their clear label rather than as borderline.
  assert.equal(report.passed, true);
});

// The band between the thresholds is a real third answer, not a rounding artefact.
test("a score between the thresholds implies borderline", async () => {
  // A human said good; the machine landed in the middle.
  const report = await runEvalGate(fixture([evalCase("mid", "good_fit")]), scorerFor({ mid: 55 }), THRESHOLDS);
  // Disagreement, because the human was clear and the machine was not.
  assert.equal(report.passed, false);
  assert.equal(report.results[0]?.actual, "borderline");
});

// --- THE BORDERLINE ASYMMETRY, which is the interesting design decision ------------

// A human who could not decide cannot be contradicted. Grading these strictly would
// make roughly a third of a real suite into noise, and a noisy gate is one that stops
// being believed and then stops being run.
test("a human borderline label accepts ANY machine answer", async () => {
  // The same borderline case scored three very different ways.
  for (const score of [95, 55, 5]) {
    // Run.
    const report = await runEvalGate(fixture([evalCase("b", "borderline")]), scorerFor({ b: score }), THRESHOLDS);
    // Always acceptable.
    assert.equal(report.passed, true, `score ${score} should be acceptable against a borderline label`);
  }
});

// The asymmetry must not run the other way. A case that was CLEAR to a human and
// merely uncertain to the machine is a miss — the Matcher failed to see something
// obvious, which is precisely what the eval set exists to catch.
test("a clear human label is NOT satisfied by a machine borderline", async () => {
  // Human said bad_fit; machine hedged.
  const report = await runEvalGate(fixture([evalCase("clear", "bad_fit")]), scorerFor({ clear: 55 }), THRESHOLDS);
  // Counted as a failure.
  assert.equal(report.passed, false);
});

// --- the all-or-nothing rule -------------------------------------------------------

// §18.3 says "all 20", not "most of 20". A gate with a tolerance drifts one case per
// change until it means nothing — and it drifts silently, because each individual
// step stays inside the tolerance.
test("a single disagreement fails the whole gate", async () => {
  // Nineteen right, one wrong.
  const cases = Array.from({ length: 20 }, (_unused, index) => evalCase(`case-${index}`, "good_fit"));
  // Every case scores well except one.
  const scores = Object.fromEntries(cases.map((entry, index) => [entry.id, index === 7 ? 12 : 90]));
  // Run.
  const report = await runEvalGate(fixture(cases), scorerFor(scores), THRESHOLDS);
  // Failed, despite 19/20.
  assert.equal(report.passed, false);
  assert.equal(report.agreed, 19);
});

// --- reporting ----------------------------------------------------------------------

// The raw score distinguishes a near-miss from a wild one. A case that failed at 69
// against a 70 threshold is a threshold-tuning question; one that failed at 12 is a
// prompt problem. A boolean pass/fail hides that completely.
test("a failing case reports its raw score and the matcher's reasoning", async () => {
  // A near-miss.
  const report = await runEvalGate(fixture([evalCase("near", "good_fit")]), scorerFor({ near: 69 }), THRESHOLDS);
  // The score survived into the result.
  assert.equal(report.results[0]?.score, 69);
  // And the reasoning is present, because this one failed.
  assert.match(report.results[0]?.reasoning ?? "", /stub reasoning/);
});

// Reasoning is withheld on a pass so a green run stays readable — twenty passing
// explanations would bury the two failures that matter.
test("a passing case carries no reasoning in the report", async () => {
  // A clear pass.
  const report = await runEvalGate(fixture([evalCase("ok", "good_fit")]), scorerFor({ ok: 90 }), THRESHOLDS);
  // Deliberately null.
  assert.equal(report.results[0]?.reasoning, null);
});

// --- THE TWO WAYS A GREEN GATE CAN PROVE NOTHING ------------------------------------
//
// Both of these are the same shape as the type-only bundling probe: fully green,
// testing nothing, and indistinguishable in a CI summary from a gate that works.

// An empty fixture agrees with itself trivially.
test("an empty fixture is called out as proving nothing", async () => {
  // No cases at all.
  const report = await runEvalGate(fixture([]), scorerFor({}), THRESHOLDS);
  // Vacuously in agreement.
  assert.equal(report.total, 0);
  // But the formatted output says so in as many words, so a CI reader cannot miss it.
  assert.match(formatGateReport(report), /EMPTY/);
});

// A placeholder fixture is worse than an empty one, because it looks populated.
test("a placeholder fixture is called out even when every case agrees", async () => {
  // Three cases, all agreeing, but flagged as placeholders.
  const report = await runEvalGate(
    fixture([evalCase("a", "good_fit"), evalCase("b", "bad_fit")], true),
    scorerFor({ a: 90, b: 5 }),
    THRESHOLDS,
  );
  // Genuinely in agreement.
  assert.equal(report.passed, true);
  // And the flag survived into the report rather than being dropped.
  assert.equal(report.placeholder, true);
  // The formatted output refuses to let that read as a real pass.
  assert.match(formatGateReport(report), /PLACEHOLDER/);
});

// --- stale labels --------------------------------------------------------------------

// Fit is relative to a resume, so a label judged against an old master may simply no
// longer hold. Reported separately because a stale label failing is not the same
// event as the prompt regressing, and conflating them sends the debugging in the
// wrong direction.
test("a label judged against a different master version is flagged as stale", async () => {
  // Labelled against version 3; the gate is running against version 7.
  const report = await runEvalGate(fixture([evalCase("old", "good_fit", 3)]), scorerFor({ old: 90 }), THRESHOLDS, 7);
  // Still agreed.
  assert.equal(report.passed, true);
  // But flagged.
  assert.equal(report.staleLabelCount, 1);
  // And surfaced even on a pass, because a green run built on stale labels is green
  // for the wrong reason.
  assert.match(formatGateReport(report), /may no longer hold/);
});

// An unknown version on either side must not mark everything stale — a signal that
// fires on every case carries no information and trains the reader to ignore it.
test("an unknown master version on either side does not mark a label stale", async () => {
  // Case has no version.
  const noCaseVersion = await runEvalGate(fixture([evalCase("x", "good_fit", null)]), scorerFor({ x: 90 }), THRESHOLDS, 7);
  assert.equal(noCaseVersion.staleLabelCount, 0);
  // Gate has no current version.
  const noCurrent = await runEvalGate(fixture([evalCase("y", "good_fit", 3)]), scorerFor({ y: 90 }), THRESHOLDS, null);
  assert.equal(noCurrent.staleLabelCount, 0);
});

// Matching versions are not stale, which is the case that proves the check is
// conditional rather than always-on.
test("a label judged against the current master is not stale", async () => {
  // Same version on both sides.
  const report = await runEvalGate(fixture([evalCase("same", "good_fit", 7)]), scorerFor({ same: 90 }), THRESHOLDS, 7);
  // Nothing flagged.
  assert.equal(report.staleLabelCount, 0);
});

// --- the committed fixture itself ------------------------------------------------------

// THE PIPELINE IS ONLY PROVEN IF THE REAL COMMITTED FILE PARSES AND RUNS. Testing the
// gate against hand-built objects proves the logic; testing it against the file on
// disk proves the FORMAT — which is the half that breaks when the exporter changes
// shape and nobody re-runs it.
test("the committed fixture parses and runs through the gate", async () => {
  // Resolve next to this test file.
  const path = fileURLToPath(new URL("./fixtures/matcher-eval-set.json", import.meta.url));
  // Parse it exactly as CI would.
  const parsed = JSON.parse(readFileSync(path, "utf8")) as EvalFixture;
  // The shape marker must match what this code understands.
  assert.equal(parsed.schema_version, 1);
  // The starter fixture must declare itself a placeholder, or it could be mistaken
  // for real labels the first time someone reads a green CI run.
  assert.equal(parsed.placeholder, true);
  // It must contain cases, or it proves nothing about the format either.
  assert.equal(parsed.cases.length > 0, true);
  // And it must actually run: a fixture the gate cannot consume is not a fixture.
  const report = await runEvalGate(parsed, () => Promise.resolve({ score: 50, reasoning: "stub" }), THRESHOLDS);
  // Every case was scored.
  assert.equal(report.total, parsed.cases.length);
});

// The placeholder set must contain all three labels, so it exercises every branch of
// the grading rule — including the borderline asymmetry, which is the one a
// good-fit-only fixture would leave completely untested.
test("the committed fixture exercises all three label kinds", () => {
  // Read it.
  const path = fileURLToPath(new URL("./fixtures/matcher-eval-set.json", import.meta.url));
  const parsed = JSON.parse(readFileSync(path, "utf8")) as EvalFixture;
  // The distinct labels present.
  const labels = new Set(parsed.cases.map((entry) => entry.label));
  // All three.
  assert.equal(labels.has("good_fit"), true);
  assert.equal(labels.has("bad_fit"), true);
  assert.equal(labels.has("borderline"), true);
});
