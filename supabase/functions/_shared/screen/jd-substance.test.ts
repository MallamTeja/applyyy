/* A thin job description is missing data (round 4, 2026-11-21; peer 5's Fractal finding). Live fixtures, read-only
 * SELECT 2026-11-21: Fractal 002b1d10 (513 chars of a Workday tenant wrapper, no role text) PASSED the screener and
 * reached awaiting_approval, because "has any text" was the only test. CLAUDE.md section 6: a JD that is mostly
 * boilerplate must not become an answer. The other side is pinned just as hard: a real short JD (Zeta 4eb08982,
 * 128 chars, one genuine duty line) is never held. The threshold (100) came from the live length distribution:
 * after stripping, the held rows had 0 and 24 chars of role text, the shortest real ones 128 and 160.
 * Assertions are positive values (a length, a verdict, the exact pattern list), never "does not contain". */

import assert from "node:assert/strict";
import { test } from "node:test";
// The one place the rule lives (screen-batch and the web's hasNoDescription both call it).
import { BOILERPLATE_LINE_PATTERNS, isThinDescription, MIN_ROLE_TEXT_CHARS, roleTextLength } from "./jd-substance.ts";

// Fractal 002b1d10, verbatim: the tenant wrapper and nothing else. The row that passed.
const FRACTAL_WRAPPER_ONLY = "It's fun to work in a company where people truly BELIEVE in what they are doing!\n\nWe're committed to bringing passion and customer focus to the business.\n\nIf you like wild growth and working with happy, enthusiastic over-achievers, you'll enjoy your career with us!\n\nNot the right fit?  Let us know you're interested in a future opportunity by clicking Introduce Yourself in the top-right corner of the page or create an account to set up email alerts as new job postings become available that meet your interest!";
// Fractal 30b68d86, verbatim: the same wrapper around three real duty lines (applied). Must never be held.
const FRACTAL_WRAPPER_WITH_DUTIES = "It's fun to work in a company where people truly BELIEVE in what they are doing!\n\nWe're committed to bringing passion and customer focus to the business.\n\nDevelop and maintain AWS Lex based chatbot workflow.\nDevelop and maintain integration with the backend system (API based)\nDev ops practices, Jenkin pipeline, AWS.\n\nIf you like wild growth and working with happy, enthusiastic over-achievers, you'll enjoy your career with us!\n\nNot the right fit?  Let us know you're interested in a future opportunity by clicking Introduce Yourself in the top-right corner of the page or create an account to set up email alerts as new job postings become available that meet your interest!";
// Zeta 4eb08982, verbatim: a genuine one-line JD of 128 chars, the shortest real one live. Must never be held.
const ZETA_ONE_LINE = "Equity and SBC accounting and reporting for every quarter, preparing Cap Labor details and assisting in Direct Taxes calclations";
// Point72 9e026768, verbatim: the title repeated as the whole description (24 chars). Held.
const POINT72_TITLE_ONLY = "Administrative Assistant";

test("the threshold is 100 chars of role text, the gap the live distribution showed", () => {
  // Pinned by value so a change to it is a deliberate, reviewed edit.
  assert.equal(MIN_ROLE_TEXT_CHARS, 100);
});

test("Fractal 002b1d10: a JD that is only the tenant wrapper has 0 chars of role text and is thin", () => {
  // Every line is a pattern match.
  assert.equal(roleTextLength(FRACTAL_WRAPPER_ONLY), 0);
  // So it is held under "No description".
  assert.equal(isThinDescription(FRACTAL_WRAPPER_ONLY), true);
});

test("Fractal 30b68d86: the same wrapper around three real duty lines keeps 160 chars and is NOT thin", () => {
  // The three duty lines, trimmed, summed.
  assert.equal(roleTextLength(FRACTAL_WRAPPER_WITH_DUTIES), 160);
  // A real short JD: never held.
  assert.equal(isThinDescription(FRACTAL_WRAPPER_WITH_DUTIES), false);
});

test("Zeta 4eb08982: a genuine one-line JD of 128 chars is NOT thin", () => {
  // All of it is role text.
  assert.equal(roleTextLength(ZETA_ONE_LINE), 128);
  // Above the threshold: never held.
  assert.equal(isThinDescription(ZETA_ONE_LINE), false);
});

test("Point72 9e026768: the title repeated as the description (24 chars) is thin", () => {
  // Short, and no pattern needed.
  assert.equal(isThinDescription(POINT72_TITLE_ONLY), true);
});

test("a missing or blank description is thin, as before (null, absent, empty, whitespace, a non-string)", () => {
  // Each shape a column or a careless caller can hand over.
  for (const value of [null, undefined, "", "   \n\t", 42, {}]) {
    // Thin, whatever the shape: only a string can carry role text.
    assert.equal(isThinDescription(value), true, `${JSON.stringify(value)} must be thin`);
  }
});

test("CRLF line ends split like LF, so a Windows-authored JD is measured the same", () => {
  // The Fractal wrapper with CRLF.
  assert.equal(roleTextLength(FRACTAL_WRAPPER_ONLY.replaceAll("\n", "\r\n")), 0);
});

test("the boilerplate list is closed: exactly these named patterns, in this order", () => {
  // A new pattern (or a dropped one) must change this list on purpose, with its own named test below.
  assert.deepEqual(BOILERPLATE_LINE_PATTERNS.map((entry) => entry.name), [
    "equal_opportunity",
    "eeo",
    "affirmative_action",
    "cookie",
    "apply_now",
    "not_the_right_fit",
    "introduce_yourself",
    "email_alerts",
    "workday_fun_to_work",
    "workday_passion_customer_focus",
    "workday_wild_growth",
    "workday_over_achievers",
  ]);
});

// One line per pattern, each long enough (>100 chars) to count on its own if the pattern failed to strip it.
const PATTERN_LINES: Readonly<Record<string, string>> = {
  equal_opportunity: "Acme is an Equal Employment Opportunity employer and considers all qualified applicants for every open position.",
  eeo: "EEO statement: we do not discriminate on any protected characteristic in hiring, promotion or pay decisions here.",
  affirmative_action: "We are proud to be an affirmative action employer and we invite every qualified candidate to apply for this job.",
  cookie: "This site uses cookies to improve your experience; by continuing to browse the careers site you accept our policy.",
  apply_now: "Ready to make an impact on the future of the business? Apply now and our recruiting team will be in touch shortly.",
  not_the_right_fit: "Not the right fit? Let us know you are interested in a future opportunity and we will keep your profile on file.",
  introduce_yourself: "Click Introduce Yourself in the top-right corner of the page to share your profile with our recruiting team today.",
  email_alerts: "Create an account to set up email alerts as new job postings become available that meet your interest and skills.",
  workday_fun_to_work: "It's fun to work in a company where people truly BELIEVE in what they are doing, every single day of the week here!",
  workday_passion_customer_focus: "We're committed to bringing passion and customer focus to the business, across every team and every office we run.",
  workday_wild_growth: "If you like wild growth and working with happy colleagues, you will enjoy your career with us for many years to come.",
  workday_over_achievers: "Join a team of enthusiastic over-achievers who love solving hard problems for customers all around the wide world.",
};

// A named test per pattern: each one strips its own line, which alone would be over the threshold.
for (const { name } of BOILERPLATE_LINE_PATTERNS) {
  test(`boilerplate pattern ${name} strips its line`, () => {
    // The sample line for this pattern.
    const line = PATTERN_LINES[name];
    // Every listed pattern has a sample: a pattern with none is an untested pattern.
    assert.equal(typeof line, "string", `no sample line for ${name}`);
    // Long enough to pass on its own, so a 0 here proves the strip, not the shortness.
    assert.ok(line!.length >= MIN_ROLE_TEXT_CHARS, `${name} sample is too short to prove anything`);
    // Stripped to nothing.
    assert.equal(roleTextLength(line), 0);
  });
}
