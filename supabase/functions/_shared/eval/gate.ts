// The Matcher eval gate — PROJECT_PLAN.md §18.3.
//
// THE REQUIREMENT, AND WHY A TABLE ALONE DOES NOT SATISFY IT. §18.3 asks for a CI
// gate: "every prompt change must still classify all 20 correctly." `matcher_eval_cases`
// is the LABELLING SURFACE — where Teja records his verdicts — but **CI has no
// database.** So the item has three parts and is only done when all three exist:
//
//   1. the table (schema stream, done)
//   2. an EXPORT of those rows to a JSON fixture COMMITTED TO THE REPO (`export.ts`)
//   3. a gate that runs the Matcher against that fixture (this file)
//
// Fixtures in git are diffable and reviewable in a pull request; fixtures in a
// database are neither. A prompt change and the eval result it produces belong in the
// same diff, or the reviewer cannot see that one caused the other.
//
// WHY THIS MUST EXIST BEFORE THE PROMPT IS TUNED, which is the whole point of §18.3
// and the easiest step to skip: without it you tweak a prompt to fix one bad match
// and silently break scoring on everything else, with no way to notice. The eval set
// is not a quality nicety — it is the only instrument that can tell "I improved the
// prompt" apart from "I moved the error somewhere I am not looking".
//
// PURE AND SCORER-INJECTED. This module contains no Gemini call and no network. The
// scorer is passed in, which is what lets the whole gate be exercised with a stub —
// and, more importantly, lets the gate be built and tested BEFORE Teja has written a
// single real label. His ~20 hand-labels then become pure data entry into a pipeline
// that is already known to work end to end.

// The verdict vocabulary, mirroring the `eval_label` enum in SQL.
//
// `borderline` exists because forcing a genuine "I could argue either way" into
// good/bad manufactures a false label, and a false label in a regression suite is
// worse than a missing one — it will fail a correct future prompt and be believed.
export type EvalLabel = "good_fit" | "bad_fit" | "borderline";

// One labelled case as it lives in the committed JSON fixture.
export interface EvalCase {
  // Stable identity for the case, so a failure names something a human can look up.
  readonly id: string;
  // A FROZEN copy of the job at labelling time. Frozen because an eval case whose
  // input can change is not a regression test — if the posting is edited or pruned,
  // the label must still refer to exactly what was judged.
  readonly job_snapshot: {
    readonly title: string;
    readonly company_name: string;
    readonly location_raw: string | null;
    readonly description_raw: string | null;
    readonly min_experience_years: string | null;
    readonly employment_type: string;
  };
  // The human verdict.
  readonly label: EvalLabel;
  // Why. Read by whoever is debugging a prompt regression six weeks from now, and
  // worth more than the label itself when the two disagree.
  readonly rationale: string | null;
  // WHICH MASTER VERSION THE LABEL WAS JUDGED AGAINST. Fit is relative to a resume,
  // so a label taken against an old master may simply not hold against a new one.
  // Carrying it means a stale label can be detected rather than silently trusted.
  readonly master_version: number | null;
}

// The committed fixture's envelope.
export interface EvalFixture {
  // Bumped when the fixture's SHAPE changes, so an old fixture against new code
  // fails loudly instead of being half-read.
  readonly schema_version: 1;
  // When the export ran. Informational, and it is what makes a months-old fixture
  // visible as months-old in a pull request.
  readonly exported_at: string;
  // The master version the export was taken against, for the staleness check below.
  readonly master_version: number | null;
  // TRUE while this fixture holds invented placeholder cases rather than Teja's real
  // labels.
  //
  // A FLAG RATHER THAN A CONVENTION, because the failure it prevents is the worst one
  // available here: a green gate that proves nothing while looking exactly like a
  // green gate that proves everything. Placeholder cases exist so the pipeline can be
  // built and verified before any real labelling happens — and the moment they can be
  // mistaken for real data, the gate becomes actively misleading. The exporter always
  // writes `false`; only the hand-written starter fixture carries `true`.
  readonly placeholder: boolean;
  // The cases.
  readonly cases: readonly EvalCase[];
}

// What the Matcher produced for one case. Deliberately the shape a Gemini
// structured-output response would carry, so the stub and the real thing agree.
export interface MatchScore {
  // 0..100. The Matcher's own number.
  readonly score: number;
  // Why, for the failure report.
  readonly reasoning: string;
}

// A function that scores one case. THE INJECTION SEAM.
//
// In CI this wraps a real Gemini call; in tests it is a lookup table. That is what
// lets the gate's own logic — thresholds, staleness, reporting — be covered without
// spending quota, and lets the pipeline be proven end to end with dummy labels.
export type Scorer = (evalCase: EvalCase) => Promise<MatchScore>;

// Where the good/bad boundary sits.
//
// PASSED IN, NOT HARDCODED. The threshold is a tuning decision that belongs with the
// prompt, and a constant here would silently define the very thing the eval set exists
// to measure. Two numbers rather than one because `borderline` needs a band: a case
// Teja could argue either way must not be graded as a crisp pass or fail.
export interface GateThresholds {
  // At or above this, the Matcher is asserting a good fit.
  readonly goodFitAtOrAbove: number;
  // At or below this, it is asserting a bad fit. Between the two is `borderline`.
  readonly badFitAtOrBelow: number;
}

// One case's outcome.
export interface CaseResult {
  // Which case.
  readonly id: string;
  // What the human said.
  readonly expected: EvalLabel;
  // What the Matcher's score implies.
  readonly actual: EvalLabel;
  // The raw score, so a near-miss is distinguishable from a wild one — a case that
  // failed at 69 against a 70 threshold is a different problem from one that failed
  // at 12, and a boolean pass/fail hides that completely.
  readonly score: number;
  // Whether they agree.
  readonly passed: boolean;
  // The Matcher's reasoning, surfaced only on failure so a passing run stays readable.
  readonly reasoning: string | null;
  // Set when the label was judged against a different master version than the one
  // the gate is running against.
  readonly staleLabel: boolean;
}

// The whole run.
export interface GateReport {
  // Did every case agree?
  readonly passed: boolean;
  // Totals, so the headline does not require counting the array.
  readonly total: number;
  readonly agreed: number;
  // Every case, in fixture order.
  readonly results: readonly CaseResult[];
  // Cases whose label predates the current master. Reported separately because a
  // stale label failing is not the same event as the prompt regressing.
  readonly staleLabelCount: number;
  // Carried through from the fixture so the formatter can shout about it without
  // needing the fixture as a second argument.
  readonly placeholder: boolean;
}

// Turn a numeric score into the label it implies.
function labelForScore(score: number, thresholds: GateThresholds): EvalLabel {
  // Clearly good.
  if (score >= thresholds.goodFitAtOrAbove) return "good_fit";
  // Clearly bad.
  if (score <= thresholds.badFitAtOrBelow) return "bad_fit";
  // The band between them. Not a failure — an honest "could argue either way".
  return "borderline";
}

// Decide whether the Matcher's implied label is acceptable for a human label.
//
// THE ASYMMETRY HERE IS DELIBERATE AND IS THE INTERESTING DESIGN CHOICE.
// A human `borderline` accepts ANY machine answer: Teja said he could argue it either
// way, so the Matcher cannot be wrong about it, and grading it strictly would make the
// suite fail on cases that carry no information. But a human `good_fit` or `bad_fit`
// demands the SAME label from the machine — `borderline` is a miss there, because the
// case was clear to a human and the Matcher failed to see it.
//
// Grading borderline strictly in both directions is the tempting simplification, and
// it would make roughly a third of the suite noise — which is how a gate stops being
// believed and then stops being run.
function isAcceptable(expected: EvalLabel, actual: EvalLabel): boolean {
  // A human who could not decide cannot be contradicted.
  if (expected === "borderline") return true;
  // Otherwise the machine must agree exactly.
  return expected === actual;
}

// Run the gate.
//
// SEQUENTIAL, NOT PARALLEL, and that is on purpose: the scorer is a Gemini call
// behind a six-key pool, and firing twenty at once is the fastest way to 429 every
// key at the same moment. Twenty sequential calls take under a minute of wall clock
// and cost almost no CPU, which is the resource that is actually scarce here.
export async function runEvalGate(fixture: EvalFixture, scorer: Scorer, thresholds: GateThresholds, currentMasterVersion: number | null = null): Promise<GateReport> {
  // Accumulator.
  const results: CaseResult[] = [];
  // Walk in fixture order so the report is diffable run to run.
  for (const evalCase of fixture.cases) {
    // Score it.
    const score = await scorer(evalCase);
    // What that score implies.
    const actual = labelForScore(score.score, thresholds);
    // Agreement, under the asymmetric rule above.
    const passed = isAcceptable(evalCase.label, actual);
    // A label judged against a different master may simply no longer hold. Only
    // flagged when both versions are known — comparing against an unknown would
    // mark everything stale and make the signal useless.
    const staleLabel =
      currentMasterVersion !== null && evalCase.master_version !== null && evalCase.master_version !== currentMasterVersion;
    // Record. Reasoning only on failure, so a green run stays readable.
    results.push({
      id: evalCase.id,
      expected: evalCase.label,
      actual,
      score: score.score,
      passed,
      reasoning: passed ? null : score.reasoning,
      staleLabel,
    });
  }
  // How many agreed.
  const agreed = results.filter((entry) => entry.passed).length;
  // The verdict.
  return {
    // EVERY case must agree. §18.3 says "all 20", not "most of 20" — a gate with a
    // tolerance is a gate that drifts one case per change until it means nothing.
    passed: agreed === results.length,
    total: results.length,
    agreed,
    results,
    staleLabelCount: results.filter((entry) => entry.staleLabel).length,
    // Propagated so a placeholder run can never be reported as a real pass.
    placeholder: fixture.placeholder,
  };
}

// Render a report as text for a CI log.
//
// A SEPARATE FUNCTION FROM THE RUN so the gate can be asserted on in tests without
// parsing prose, and so the CI output can change without touching the logic.
export function formatGateReport(report: GateReport): string {
  // Lines, joined at the end.
  const lines: string[] = [];
  // The headline first, because a CI log is read from the top.
  lines.push(report.passed ? `EVAL GATE PASSED — ${report.agreed}/${report.total} cases agreed` : `EVAL GATE FAILED — ${report.agreed}/${report.total} cases agreed`);
  // An empty fixture is not a pass. Called out loudly because a gate that silently
  // passes on zero cases is the most dangerous possible state: fully green, testing
  // nothing, and indistinguishable from a working gate in every CI summary.
  if (report.total === 0) {
    lines.push("WARNING: the fixture is EMPTY. This gate proved nothing. Export labels before trusting it.");
  }
  // A placeholder fixture must never read as a real pass. Stated as loudly as the
  // empty case, and for the same reason — both are gates that prove nothing while
  // looking green.
  if (report.placeholder) {
    lines.push("WARNING: this fixture holds PLACEHOLDER cases, not real labels. The gate is wired up but proves nothing about match quality.");
  }
  // Stale labels are reported even on a pass, because a green run built on labels
  // judged against an old resume is green for the wrong reason.
  if (report.staleLabelCount > 0) {
    lines.push(`WARNING: ${report.staleLabelCount} label(s) were judged against a different master version and may no longer hold.`);
  }
  // Only failures get detail; listing twenty passes buries the two that matter.
  for (const entry of report.results) {
    // Skip the agreements.
    if (entry.passed) continue;
    // Case, expectation, outcome and the raw score — the score is what distinguishes
    // a near-miss from a wild one.
    lines.push(`  FAIL ${entry.id}: expected ${entry.expected}, scored ${entry.score} → ${entry.actual}`);
    // The Matcher's own reasoning, which is usually what shows why.
    if (entry.reasoning !== null) lines.push(`       reasoning: ${entry.reasoning}`);
  }
  // One block of text.
  return lines.join("\n");
}
