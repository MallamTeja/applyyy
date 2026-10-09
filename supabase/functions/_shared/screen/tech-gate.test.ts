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
//
// AMENDED: Teja's 2026-10-09 ruling (option (d)) amending the 2026-09-17 design: with
// titles or keywords configured, a non-match is a drop (tech_gate_unclassified); pass+warn
// only when both are empty. Measured live, 99.6% of passed_filters rows had reached the
// matcher through the old pass branch, so it was the rule, not the exception. The tests
// that pinned the old branch are FLIPPED below, deliberately, not deleted.
import { test } from "node:test";
// Strict, so `drop: false` never quietly compares equal to undefined.
import assert from "node:assert/strict";
// Extension-suffixed specifier so this runs under Deno and `node --test` alike.
import { screenTechRole, toTechGatePreferences, type TechGatePreferences } from "./tech-gate.ts";

// A realistic preference set, shaped like the `search_preferences` row it is read from.
const PREFS: TechGatePreferences = {
  titles: ["software engineer", "backend developer", "data scientist"],
  keywords: ["react", "typescript", "kubernetes"],
  excludedKeywords: ["sales", "marketing", "recruiter", "ops"],
};

// No titles, no keywords, no exclusions: the one config under which the old pass+warn
// branch survives the 2026-10-09 amendment.
const EMPTY: TechGatePreferences = { titles: [], keywords: [], excludedKeywords: [] };

// --- the unclassified branch, written first because it is the whole point ------------

// FLIPPED per Teja's 2026-10-09 ruling (option (d)) amending the 2026-09-17 design: with
// titles or keywords configured, a non-match is a drop (tech_gate_unclassified); pass+warn
// only when both are empty. This test used to assert a pass; a plausible-but-unlisted
// title is now dropped, because the user's lists ARE the answer once they exist.
test("an unrecognised title under a configured gate is dropped as tech_gate_unclassified", () => {
  // "Site Reliability Engineer II" matches no PREFS title or keyword.
  const verdict = screenTechRole("Site Reliability Engineer II", null, PREFS);
  // Exact shape, so a wrong code or a leaked warning field both fail here.
  assert.deepEqual(verdict, {
    drop: true,
    // Its own code, so these drops are countable and recoverable apart from exclusions.
    code: "tech_gate_unclassified",
    // The reason names the title, so a wrong drop is diagnosable from the log alone.
    reason: '"Site Reliability Engineer II" matched no configured title or keyword',
  });
});

// FLIPPED, same ruling: the old pinned test ("a title matching nothing at all still
// passes") now asserts the only case that still passes — an EMPTY config, where the gate
// has nothing to judge by — and that it says so in a warning.
test("a title matching nothing at all still passes, but only under an empty config, with a warning", () => {
  // Nothing configured, so the classifier has no opinion; a non-answer is not a rejection.
  const verdict = screenTechRole("Zephyr Wrangler", null, EMPTY);
  // Exact shape: drop false AND the warning text that makes the gap visible.
  assert.deepEqual(verdict, {
    drop: false,
    // The warning names the title and the reason it was not judged.
    warning: '"Zephyr Wrangler" passed unclassified: no titles or keywords are configured',
  });
});

// The counterpart of the test above: the same title under a configured gate drops.
test("a title matching nothing at all is dropped once titles are configured", () => {
  // Titles only, so the drop cannot be credited to keywords.
  const prefs: TechGatePreferences = { titles: ["software engineer"], keywords: [], excludedKeywords: [] };
  const verdict = screenTechRole("Zephyr Wrangler", null, prefs);
  // Dropped, with the unclassified code rather than the exclusion code.
  assert.equal(verdict.drop, true);
  // Narrowed so the code is readable; the drop assertion above already failed otherwise.
  assert.equal(verdict.drop && verdict.code, "tech_gate_unclassified");
});

// Keywords alone are a configuration too: hasTerms checks EITHER list.
test("a non-match is dropped when only keywords are configured", () => {
  // Keywords only, titles empty, so the titles list cannot be what triggered the drop.
  const prefs: TechGatePreferences = { titles: [], keywords: ["react"], excludedKeywords: [] };
  const verdict = screenTechRole("Zephyr Wrangler", "Herd zephyrs across the plains.", prefs);
  // Dropped as unclassified.
  assert.equal(verdict.drop && verdict.code, "tech_gate_unclassified");
});

// A list of only blank strings configures nothing, matching firstMatch, which skips
// blanks. Otherwise a stray empty settings row would silently flip the gate to dropping.
test("blank-only title and keyword lists count as empty, so a non-match passes and warns", () => {
  // Whitespace entries only — what an un-trimmed settings field can save.
  const prefs: TechGatePreferences = { titles: ["  "], keywords: ["  "], excludedKeywords: [] };
  const verdict = screenTechRole("Zephyr Wrangler", null, prefs);
  // Passes, because nothing usable was configured.
  assert.equal(verdict.drop, false);
  // And warns, because that empty config is the gap worth seeing.
  assert.equal("warning" in verdict, true);
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
  // The EXCLUSION code, not the unclassified one: the title did match, so only the
  // exclusion can be why it dropped. Pins exclusions-first after the 2026-10-09 amendment.
  assert.equal(verdict.drop && verdict.code, "tech_gate");
});

// Exclusions do not depend on titles/keywords being configured: an empty positive config
// changes only the no-match branch, never the exclusion branch.
test("exclusion still drops with empty titles and keywords", () => {
  // Only exclusions configured.
  const prefs: TechGatePreferences = { titles: [], keywords: [], excludedKeywords: ["sales"] };
  const verdict = screenTechRole("Enterprise Sales Executive", null, prefs);
  // Dropped as an exclusion, not passed with a warning.
  assert.equal(verdict.drop && verdict.code, "tech_gate");
});

// --- word boundaries, and the false positive the prototype would have shipped --------

// THE BUG THIS GATE MUST NOT INHERIT. `scout-remote.ts:243` tests exclusions with
// `combinedText.includes(ex)`. With "ops" on the excluded list — an entirely reasonable
// entry for an operations role — a bare substring test drops "DevOps Engineer" and
// "MLOps Engineer", silently deleting the most in-demand roles Teja is hunting. Matching
// on word boundaries is what separates the operations job from the engineering one.
test("an excluded keyword does not match inside a longer word", () => {
  // "engineer" added as a title so these titles are RECOGNISED: since 2026-10-09 an
  // unrecognised title drops anyway, which would hide whether "ops" fired. A pass proves
  // the exclusion did not match inside the word.
  const prefs: TechGatePreferences = { ...PREFS, titles: ["engineer"] };
  // "ops" is excluded; "DevOps" must survive it.
  assert.equal(screenTechRole("DevOps Engineer", null, prefs).drop, false);
  // Same for the other in-demand -Ops role.
  assert.equal(screenTechRole("MLOps Platform Engineer", null, prefs).drop, false);
});

// The same boundary rule must not go too far the other way: a genuine standalone use of
// the excluded term still drops.
test("an excluded keyword still matches as a standalone word", () => {
  // Full shape asserted, not just drop: this title also matches no PREFS title, so a bare
  // drop:true would pass even if the exclusion never fired. The reason names the term.
  const verdict = screenTechRole("Business Ops Analyst", null, PREFS);
  // Exclusion code and the term in the reason.
  assert.deepEqual(verdict, { drop: true, code: "tech_gate", reason: 'title or description matches excluded term "ops"' });
});

// Whole-word boundaries for a short abbreviation, the case a substring test gets most
// wrong. Excluding "Sr" (seniority) must not delete a person's name or an unrelated word
// that merely starts with those letters.
test('excluded "Sr" drops Sr / Sr. titles but not Srinivas or Src', () => {
  // "engineer" configured so the survivors pass as RECOGNISED rather than drop unclassified.
  const prefs: TechGatePreferences = { titles: ["engineer"], keywords: [], excludedKeywords: ["Sr"] };
  // "Srinivas" starts with Sr but continues with a word char: no trailing boundary.
  assert.deepEqual(screenTechRole("Srinivas Software Engineer", null, prefs), { drop: false });
  // Same for "Src".
  assert.deepEqual(screenTechRole("Src Platform Engineer", null, prefs), { drop: false });
  // "Sr." — the "." after "Sr" is a non-word char, so \b holds and the exclusion fires.
  // Full shape, so the drop is the exclusion and not something else.
  assert.deepEqual(screenTechRole("Sr. Software Engineer", null, prefs), {
    drop: true,
    // Exclusion wins over the "engineer" title match.
    code: "tech_gate",
    // The configured term, verbatim.
    reason: 'title or description matches excluded term "Sr"',
  });
  // "Sr" followed by a space: the plain case.
  const plain = screenTechRole("Sr Software Engineer", null, prefs);
  // Exclusion code, despite the "engineer" title match.
  assert.equal(plain.drop && plain.code, "tech_gate");
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

// TITLE TERMS MATCH THE TITLE ONLY (Teja, 2026-10-09, handoff §4.1). Measured live: 111
// passed_filters rows passed only because a TITLE term ("Developer", "Software Engineer")
// appeared in the description head — "you'll work with our software engineers" — 74 of
// them non-engineering (Account Executive, Finance, Business Development). A title term
// describes the role's title, so the body no longer counts for it; keywords (above) still do.
test("a configured title term found only in the description does not count as a match", () => {
  // A sales role whose body names the team it sells alongside.
  const verdict = screenTechRole("Enterprise Account Executive", "Partner closely with our software engineer team.", PREFS);
  // Not recognised by the title, and no keyword in the body: dropped as unclassified.
  assert.deepEqual(verdict, {
    drop: true,
    code: "tech_gate_unclassified",
    reason: '"Enterprise Account Executive" matched no configured title or keyword',
  });
});

test("a configured title term in the title still matches, whatever the body says", () => {
  // The positive half: moving title terms to the title must not lose real titles.
  const verdict = screenTechRole("Software Engineer, Payments", "We sell to banks.", PREFS);
  // Recognised by the title alone; no warning.
  assert.deepEqual(verdict, { drop: false });
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

// --- toTechGatePreferences: the one mapping every caller shares ------------------------

// A user with no search_preferences row is a normal state, not a read failure: it maps to
// an empty config (which then passes+warns), never to a throw.
test("toTechGatePreferences maps a missing row (undefined or null) to empty lists", () => {
  // What a PostgREST maybeSingle() gives for no row.
  assert.deepEqual(toTechGatePreferences(null), EMPTY);
  // What an optional chain upstream can give.
  assert.deepEqual(toTechGatePreferences(undefined), EMPTY);
});

// Nullable columns are read like a missing row, and the snake_case column name is mapped
// to the camelCase field here, once.
test("toTechGatePreferences maps null columns to [] and renames excluded_keywords", () => {
  // All three columns null: same as no row.
  assert.deepEqual(toTechGatePreferences({ titles: null, keywords: null, excluded_keywords: null }), EMPTY);
  // Populated columns pass through, excluded_keywords landing in excludedKeywords.
  assert.deepEqual(toTechGatePreferences({ titles: ["a"], keywords: null, excluded_keywords: ["b"] }), {
    // Carried verbatim.
    titles: ["a"],
    // Null became [].
    keywords: [],
    // Renamed field.
    excludedKeywords: ["b"],
  });
});
