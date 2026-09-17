// Tests for stage 0 — the tech-role gate that runs ahead of the cascade.
//
// THE DECISION THIS ENCODES (Teja, 2026-09-17, docs/design/2026-09-17-tech-only-discovery.md):
// drop non-tech postings BEFORE the Matcher rather than at discovery, using the
// `search_preferences` columns that already exist. No new FilterRuleType, no migration,
// and cascade.ts is not touched.
//
// THE ONE THING THESE TESTS EXIST TO PIN. The browser's `isTechRole()` classifies a
// title as NON-TECH when no positive pattern matches. Ported unchanged, that default
// would silently starve a pipeline that PROJECT_PLAN:149-152 already describes as
// yielding single digits per day — and starvation is indistinguishable from "no jobs
// today", with no error anywhere. Server-side the third branch must therefore INVERT:
// an unrecognised title is MISSING INFORMATION, not a negative verdict. It passes, and
// it warns. That mirrors the three-outcome RuleVerdict cascade.ts already uses, where a
// rule that cannot be evaluated warns rather than drops.
import { test } from "node:test";
// Strict, so `drop: false` never quietly compares equal to undefined.
import assert from "node:assert/strict";
// Extension-suffixed specifier so this runs under Deno and `node --test` alike.
import { screenTechRole, type TechGatePreferences } from "./tech-gate.ts";

// A realistic preference set, shaped like the `search_preferences` row it is read from.
const PREFS: TechGatePreferences = {
  titles: ["software engineer", "backend developer", "data scientist"],
  keywords: ["react", "typescript", "kubernetes"],
  excludedKeywords: ["sales", "marketing", "recruiter", "ops"],
};

// --- the inverted default, written first because it is the whole point --------------

// THE TEST THAT MATTERS MOST. A clearly technical title that matches none of the
// configured patterns must PASS and warn — never drop. Teja's configured titles cannot
// enumerate every real engineering role, and the ones they miss are exactly the ones a
// tightened default would silently delete.
test("an unrecognised but plausible title passes and warns rather than dropping", () => {
  const verdict = screenTechRole("Site Reliability Engineer II", null, PREFS);
  assert.equal(verdict.drop, false);
  // The warning is what makes the non-answer visible instead of silent.
  assert.equal("warning" in verdict, true);
});

// The same branch for a title nobody could classify. Still a pass — the gate has no
// opinion, and a non-answer is not a rejection.
test("a title matching nothing at all still passes", () => {
  assert.equal(screenTechRole("Zephyr Wrangler", null, PREFS).drop, false);
});

// A recognised title passes WITHOUT a warning, so the warning genuinely means
// "unclassified" rather than being background noise on every job.
test("a recognised title passes with no warning", () => {
  const verdict = screenTechRole("Senior Software Engineer", null, PREFS);
  assert.equal(verdict.drop, false);
  assert.equal("warning" in verdict, false);
});

// --- dropping ------------------------------------------------------------------------

// The positive case for the gate: an excluded keyword rejects the posting outright.
test("an excluded keyword drops the posting and names the term", () => {
  const verdict = screenTechRole("Enterprise Sales Executive", null, PREFS);
  assert.equal(verdict.drop, true);
  assert.match(verdict.drop ? verdict.reason : "", /sales/);
});

// Exclusion is tested FIRST, so a posting carrying both signals is still rejected.
// "Technical Recruiter" is the design doc's own example of how fine the line is: it
// contains a technical word and is not a technical job.
test("exclusion beats a target match, so Technical Recruiter is dropped", () => {
  const verdict = screenTechRole("Technical Recruiter", null, { ...PREFS, titles: ["technical"] });
  assert.equal(verdict.drop, true);
});

// --- word boundaries, and the false positive the prototype would have shipped --------

// THE BUG THIS GATE MUST NOT INHERIT. `scout-remote.ts:243` tests exclusions with
// `combinedText.includes(ex)`. With "ops" on the excluded list — an entirely reasonable
// entry for an operations role — a bare substring test drops "DevOps Engineer" and
// "MLOps Engineer", silently deleting the most in-demand roles Teja is hunting. Matching
// on word boundaries is what separates the operations job from the engineering one.
test("an excluded keyword does not match inside a longer word", () => {
  // "ops" is excluded; "DevOps" must survive it.
  assert.equal(screenTechRole("DevOps Engineer", null, PREFS).drop, false);
  assert.equal(screenTechRole("MLOps Platform Engineer", null, PREFS).drop, false);
});

// The same boundary rule must not go too far the other way: a genuine standalone use of
// the excluded term still drops.
test("an excluded keyword still matches as a standalone word", () => {
  assert.equal(screenTechRole("Business Ops Analyst", null, PREFS).drop, true);
});

// The counterpart trap, inherited from cascade.ts's own hard-won comment: an
// unconditional \b can NEVER match a term ending in punctuation, because two non-word
// characters in a row are not a boundary. A term like "c++" would look configured and
// silently match nothing — the worse failure, because it is invisible from the settings
// page.
test("a term ending in punctuation still matches", () => {
  const prefs: TechGatePreferences = { titles: ["c++"], keywords: [], excludedKeywords: [] };
  const verdict = screenTechRole("C++ Developer", null, prefs);
  assert.equal(verdict.drop, false);
  // Recognised, so no warning — proving the term actually matched rather than falling
  // through to the unclassified branch, which would also have passed.
  assert.equal("warning" in verdict, false);
});

// A term from a settings field is user input and must be matched as literal text, never
// compiled as a pattern. An unescaped metacharacter would either throw or match wildly.
test("a regex metacharacter in a configured term is treated literally", () => {
  const prefs: TechGatePreferences = { titles: [], keywords: [], excludedKeywords: ["c.."] };
  // Would match "cat" if the term were compiled as a pattern rather than escaped.
  assert.equal(screenTechRole("Cat Herder", null, prefs).drop, false);
});

// --- the description, and unconfigured preferences ------------------------------------

// A keyword may appear in the body rather than the title — "React" rarely makes the
// title of a generalist posting. The description is consulted for the positive match.
test("a keyword found only in the description counts as a match", () => {
  const verdict = screenTechRole("Product Engineer", "We build with React and TypeScript.", PREFS);
  assert.equal(verdict.drop, false);
  assert.equal("warning" in verdict, false);
});

// THE UNCONFIGURED CASE, and it fails open ON PURPOSE — the same direction every rule in
// cascade.ts fails. With `search_preferences` currently unseeded for every user (the
// bootstrap transaction rolls back on a bad column name), an unconfigured gate that
// dropped would take the entire pipeline to zero and look exactly like a dead cron.
test("unconfigured preferences pass everything and say so", () => {
  const empty: TechGatePreferences = { titles: [], keywords: [], excludedKeywords: [] };
  const verdict = screenTechRole("Enterprise Sales Executive", null, empty);
  assert.equal(verdict.drop, false);
  assert.equal("warning" in verdict, true);
});
