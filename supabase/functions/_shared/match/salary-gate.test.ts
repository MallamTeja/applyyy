// Tests for the salary gate — docs/harvest/2026-09-16-ai-job-search-harvest-plan.md §Q3.
//
// THE TEST THAT MATTERS MOST IN THIS FILE is "a posting with no salary PASSES".
// Every other row of the ruled table is a filter, so the reflex while reading them is
// "absent data is suspicious, drop it". §Q3 rules the exact opposite and says so
// explicitly: "the no-salary case is the one most likely to be implemented backwards".
// Indian postings overwhelmingly omit a range, so getting this backwards would not fail
// loudly — it would quietly discard most of the supply and present as a thin market.
//
// THE SECOND THEME is that this gate only ever FAILS when it can compare HONESTLY.
// An unknown period, an unknown currency, or a cross-currency comparison all resolve to
// PASS, because inventing an exchange rate or assuming "probably per year" is a
// constraint #2 fabrication. A gate that guesses is worse than no gate: it discards real
// jobs and leaves no evidence that a guess ever happened.
import { test } from "node:test";
// Strict, so a `false` verdict never quietly compares equal to a missing one.
import assert from "node:assert/strict";
// The unit under test.
import { evaluateSalaryGate, type PostingSalary, type SalaryPreference } from "./salary-gate.ts";

// Teja's configured band, as `search_preferences` actually stores it: numerics arrive
// from PostgREST as STRINGS, not numbers, the same convention `cascade.ts` documents for
// `minExperienceYears`. Encoding that here keeps the tests honest about the shape the
// real caller will hand over, rather than testing a friendlier type than exists.
const PREFERENCE: SalaryPreference = {
  min: "1200000",
  max: "2400000",
  currency: "INR",
  // Stated rather than assumed. `search_preferences` has no period column, so the caller
  // must declare what its own numbers mean; this gate refuses to infer it.
  period: "year",
};

// Build a posting salary, overriding only what a given test varies. A helper rather than
// a literal per test, so each test reads as the one field it is actually about.
function posting(overrides: Partial<PostingSalary> = {}): PostingSalary {
  return { min: null, max: null, currency: null, period: null, ...overrides };
}

// --- the four ruled cases, verbatim from the §Q3 table ---

// ROW 1, AND THE ONE MOST LIKELY TO BE WRITTEN BACKWARDS. "Absence of data is not a
// reason to skip, and must not score as a negative." If this ever flips, discovery
// silently collapses and presents as a supply problem rather than a filter bug.
test("a posting that states no salary at all PASSES", () => {
  const result = evaluateSalaryGate(posting(), PREFERENCE);
  assert.equal(result.verdict, "pass");
});

// ROW 2. Inside the band is the uncontroversial accept.
test("a range inside the configured band PASSES", () => {
  const result = evaluateSalaryGate(posting({ min: "1500000", max: "1800000", currency: "INR", period: "year" }), PREFERENCE);
  assert.equal(result.verdict, "pass");
});

// ROW 3. Below the band is the reason the gate exists at all.
test("a range below the configured band FAILS", () => {
  const result = evaluateSalaryGate(posting({ min: "400000", max: "600000", currency: "INR", period: "year" }), PREFERENCE);
  assert.equal(result.verdict, "fail");
});

// ROW 4. Above the band is a SENIORITY MISMATCH, not a windfall — a role paying triple
// the target is asking for someone else. This is the row Teja may later soften to FLAG.
test("a range above the configured band FAILS", () => {
  const result = evaluateSalaryGate(posting({ min: "6000000", max: "9000000", currency: "INR", period: "year" }), PREFERENCE);
  assert.equal(result.verdict, "fail");
});

// --- evidence, because a verdict with no quotable cause cannot be reviewed ---

// The plan requires the verbatim triggering line beside the verdict. Without it the
// dashboard can say a job was dropped but not why, and a wrong threshold becomes
// undebuggable — which is how a filter quietly eats a month of supply.
test("a FAIL carries evidence naming both the posting range and the configured band", () => {
  const result = evaluateSalaryGate(posting({ min: "400000", max: "600000", currency: "INR", period: "year" }), PREFERENCE);
  assert.equal(result.verdict, "fail");
  // Narrowing idiom used throughout this repo, so the union access below is checked.
  if (result.verdict !== "fail") return;
  // The posting's own numbers must appear, so the evidence stands alone in a log.
  assert.match(result.evidence, /400000/);
  // And the band it was judged against, so a misconfigured preference is visible too.
  assert.match(result.evidence, /1200000/);
});

// --- the confidence rules: this gate refuses to guess ---

// A number with no period is not a comparable number. 50,000 per month clears the band;
// 50,000 per year does not. Assuming either one invents the answer.
test("a range whose period is unknown is treated as no salary and PASSES", () => {
  const result = evaluateSalaryGate(posting({ min: "400000", max: "600000", currency: "INR", period: null }), PREFERENCE);
  assert.equal(result.verdict, "pass");
});

// We hold no FX table and must not invent one. A USD posting against an INR preference
// is not comparable, so it goes on to the Matcher rather than being dropped on a guess.
test("a range in a different currency PASSES rather than being converted", () => {
  const result = evaluateSalaryGate(posting({ min: "40000", max: "60000", currency: "USD", period: "year" }), PREFERENCE);
  assert.equal(result.verdict, "pass");
});

// Garbage in the column must not read as zero. `Number("")` is 0, and a silent zero here
// would FAIL every unparseable posting as "below band" — the exact backwards failure §Q3
// warns about, arriving through a different door.
test("an unparseable amount is treated as no salary and PASSES", () => {
  const result = evaluateSalaryGate(posting({ min: "negotiable", max: null, currency: "INR", period: "year" }), PREFERENCE);
  assert.equal(result.verdict, "pass");
});

// --- period normalisation, which is what makes a comparison legitimate ---

// A monthly figure that annualises INTO the band must pass. This is the case that proves
// normalisation runs before comparison rather than after it.
test("a monthly range is annualised before comparison and PASSES when it clears the band", () => {
  // 125000/month is 1,500,000/year, inside the 1.2M-2.4M band.
  const result = evaluateSalaryGate(posting({ min: "125000", max: "150000", currency: "INR", period: "month" }), PREFERENCE);
  assert.equal(result.verdict, "pass");
});

// The same numbers read as annual fall below the band, which is precisely why the period
// cannot be assumed. Two tests over one pair of numbers, isolating the period alone.
test("the same numbers read as annual FAIL, proving the period changes the verdict", () => {
  const result = evaluateSalaryGate(posting({ min: "125000", max: "150000", currency: "INR", period: "year" }), PREFERENCE);
  assert.equal(result.verdict, "fail");
});

// --- partial ranges, which are what real boards actually publish ---

// A posting stating only a floor is still comparable: if the most it advertises is below
// the band's floor, it is below the band.
test("a posting with only a minimum below the band FAILS", () => {
  const result = evaluateSalaryGate(posting({ min: "300000", max: null, currency: "INR", period: "year" }), PREFERENCE);
  assert.equal(result.verdict, "fail");
});

// An open-ended floor inside the band is not evidence of anything wrong.
test("a posting with only a minimum inside the band PASSES", () => {
  const result = evaluateSalaryGate(posting({ min: "1500000", max: null, currency: "INR", period: "year" }), PREFERENCE);
  assert.equal(result.verdict, "pass");
});

// --- an unconfigured preference must not become a filter ---

// A user who has set no band has expressed no preference. Dropping jobs against an empty
// configuration would filter on a setting nobody chose, which is the misconfiguration
// direction `cascade.ts` already rules on: fail toward the visible failure, not the
// silent one.
test("a preference with no configured band PASSES everything", () => {
  const unset: SalaryPreference = { min: null, max: null, currency: "INR", period: "year" };
  const result = evaluateSalaryGate(posting({ min: "100", max: "200", currency: "INR", period: "year" }), unset);
  assert.equal(result.verdict, "pass");
});
