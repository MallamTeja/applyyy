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
  assert.deepEqual(verdict, { drop: true, code: "tech_gate", reason: 'title matches excluded term "ops"' });
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
    reason: 'title matches excluded term "Sr"',
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

// WHITESPACE IS NOT SIGNAL (2026-10-09, §6 fail-open found live). A board title arrived as
// "Staff  Software Engineer" (two spaces) and slipped past the exclusion "Staff Software",
// because the term's space was escaped literally and matched exactly one space. Every
// whitespace run — doubled spaces, tabs, NBSP — now collapses to one space on BOTH sides.
const SENIORITY: TechGatePreferences = { titles: ["software engineer"], keywords: [], excludedKeywords: ["Staff Software"] };

test("a double-spaced title still hits a single-spaced exclusion phrase", () => {
  // The live title shape that slipped through.
  const verdict = screenTechRole("Staff  Software Engineer - Database Engineering", null, SENIORITY);
  // Dropped by the exclusion, naming the configured term as written.
  assert.deepEqual(verdict, { drop: true, code: "tech_gate", reason: 'title matches excluded term "Staff Software"' });
});

test("an NBSP or a tab in the title still hits a single-spaced exclusion phrase", () => {
  // U+00A0 arrives from HTML-scraped boards; JS \s covers it, and it must not hide a term.
  assert.equal(screenTechRole("Staff Software Engineer", null, SENIORITY).drop, true);
  // A tab between the words is the same failure.
  assert.equal(screenTechRole("Staff\tSoftware Engineer", null, SENIORITY).drop, true);
});

test("a double-spaced configured term still matches a single-spaced title", () => {
  // The other side: a term typed with two spaces in the settings field must still match.
  const prefs: TechGatePreferences = { titles: ["Software  Engineer"], keywords: [], excludedKeywords: [] };
  // Recognised, no warning.
  assert.deepEqual(screenTechRole("Software Engineer, Payments", null, prefs), { drop: false });
});

// EXCLUSIONS MATCH THE TITLE ONLY (Teja, 2026-10-09 15:07, reversing the 09-17 rule).
// Live: "Cloud Operations Engineer" — a configured title — was dropped by the exclusion
// "Head" found in its description: "…MongoDB is at the head of its disruption…". Bare
// seniority words (Head, Lead, Staff, Manager) occur in ordinary company prose.
const HEAD: TechGatePreferences = { titles: ["Cloud Operations Engineer"], keywords: [], excludedKeywords: ["Head"] };

test("an excluded word found only in the description does not drop the row", () => {
  // The live shape: the excluded word is company prose, not the role.
  const verdict = screenTechRole("Cloud Operations Engineer", "MongoDB is at the head of its disruption.", HEAD);
  // Recognised by its title and NOT dropped by the body's "head".
  assert.deepEqual(verdict, { drop: false });
});

test("an excluded word in the title still drops", () => {
  // The positive half: a seniority word in the title is exactly what exclusions are for.
  const verdict = screenTechRole("Head of Cloud Operations Engineering", null, HEAD);
  // Dropped by the exclusion, naming the term.
  assert.deepEqual(verdict, { drop: true, code: "tech_gate", reason: 'title matches excluded term "Head"' });
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

// --- P3 #6 (2026-11-05): level words and campus-only programmes --------------------------

// The shape of Teja's live config that let the leak through: a bare level word ("Intern")
// beside discipline titles and keywords. Titles match the TITLE only.
const LIVE_LIKE: TechGatePreferences = {
  // A discipline title, and the two level words that matched any discipline.
  titles: ["Software Engineer", "Intern", "Graduate"],
  // Keywords read title + description head.
  keywords: ["Python"],
  // Nothing excluded, so only the new rules can drop.
  excludedKeywords: [],
};

// THE LEAK: "Intern" alone recognised a legal role, which then reached awaiting_approval.
test("level word: 'Intern, Company Secretary' is dropped as tech_gate_unclassified", () => {
  // The live title, with a non-technical description head.
  const verdict = screenTechRole("Intern, Company Secretary", "Department Name: Legal", LIVE_LIKE);
  // Dropped with the existing closed code, and the reason names the level term.
  assert.deepEqual(verdict, {
    drop: true,
    code: "tech_gate_unclassified",
    reason: `"Intern, Company Secretary" matched only the level term "Intern" and no technical word`,
  });
});

// The guard against over-dropping, measured live: the stricter first draft dropped these.
test("level word: technical intern titles still pass on the level term", () => {
  // "Software Engineering" does not match the title term "Software Engineer"; "Intern" carries it.
  assert.deepEqual(screenTechRole("2027 - Software Engineering Intern, AMER", null, LIVE_LIKE), { drop: false });
  // Same: a discipline the config does not spell out.
  assert.deepEqual(screenTechRole("Machine Learning Intern", null, LIVE_LIKE), { drop: false });
  // The approved row the vocabulary first missed.
  assert.deepEqual(screenTechRole("Artificial Intelligence Intern", null, LIVE_LIKE), { drop: false });
  // A level word other than Intern behaves the same way.
  assert.deepEqual(screenTechRole("Graduate Engineering Trainee", null, LIVE_LIKE), { drop: false });
});

// A keyword in the description head still recognises a level-word title, as before.
test("level word: a configured keyword still recognises a non-technical-looking title", () => {
  // "Intern" alone would drop; the keyword in the body head is a real match.
  assert.deepEqual(screenTechRole("Summer Intern", "You will build Python services.", LIVE_LIKE), { drop: false });
});

// Point72: a role that matches perfectly but recruits only from one institute.
test("campus: 'Campus Graduate Program - IIT BHU' is dropped as campus_restricted", () => {
  // The live title; it matches the "Software Engineer" title term.
  const verdict = screenTechRole("2027 Software Engineer - Campus Graduate Program - IIT BHU", null, LIVE_LIKE);
  // Its own closed code, naming the institute.
  assert.deepEqual(verdict, {
    drop: true,
    code: "campus_restricted",
    reason: `"2027 Software Engineer - Campus Graduate Program - IIT BHU" is a campus programme restricted to IIT`,
  });
});

// Both signals are required: "campus" alone, or an acronym alone, is not a restriction.
test("campus: 'campus' without an institute, or an institute without 'campus', is untouched", () => {
  // A campus-networking role with no institute: whatever the usual rules decide, never this code.
  assert.notEqual((screenTechRole("Software Engineer, Campus Fabric", null, LIVE_LIKE) as { code?: string }).code, "campus_restricted");
  // An institute named without a campus programme (e.g. a lab collaboration): not this rule.
  assert.deepEqual(screenTechRole("Software Engineer - IIT Madras Research Park", null, LIVE_LIKE), { drop: false });
  // An ordinary word spelled like an acronym ("Bits") is not the institute: case matters.
  assert.deepEqual(screenTechRole("Software Engineer, Campus Bits Team", null, LIVE_LIKE), { drop: false });
});

// ---------------------------------------------------------------------------------------------
// TITLE RULES, Teja 2026-11-06 23:33 IST ("this is a big problem"): four rules, each with its own
// closed drop code so each set can be counted and recovered apart. They run BEFORE the positive
// match, so a configured title term ("Software Engineer", "Intern") can never rescue a title they reject.
// Live leaks they pin (passed_filters on 2026-11-06): Barclays "Mobile AVP Software Engineer", State
// Street "... - Assistant Vice President", GitLab "Intermediate Data Engineer", Marvell "Research Intern
// (PhD), ...", Micron "Graduate Engineering Technician", Nasdaq "... Technical Writer", GE HealthCare
// "Graduate Engineering Trainee" whose job is field service / manufacturing.
// ---------------------------------------------------------------------------------------------

// The terms Teja hunts, with NO exclusions, so a verdict here comes from the title rules alone and never
// from his live "VP" / "Senior" exclusions (which would answer first and hide the rule under test).
const TITLE_RULE_PREFS: TechGatePreferences = {
  // Broad enough that every negative below is positively recognised, which makes the negatives real.
  titles: ["Software Engineer", "Engineer", "Intern", "Graduate", "Data Scientist", "AI Engineer", "SDE", "Backend", "Frontend", "Developer", "Analyst", "Trainee", "Technician", "Writer", "Design"],
  // None: the rules must not lean on a keyword.
  keywords: [],
  // None, for the reason above.
  excludedKeywords: [],
};

// The code a title lands on, or "pass". Kept as a helper so each case is one line.
function titleVerdict(title: string, description: string | null = null): string {
  // The gate's answer for this title under the rule-only preferences.
  const verdict = screenTechRole(title, description, TITLE_RULE_PREFS);
  // A drop names its code; anything else is a pass.
  return verdict.drop ? verdict.code : "pass";
}

test("title rule 1, seniority: AVP, VP, Vice President and GitLab's Intermediate are dropped as title_seniority", () => {
  // Every live leak plus the plain VP forms, each of which the old gate passed.
  for (const title of [
    "Software Engineer - AVP",
    "Mobile AVP Software Engineer",
    "Application Security Engineer, ADR - Assistant Vice President",
    "VP, Software Engineering",
    "Vice President - Backend Platform",
    "SVP Engineering Systems",
    "Intermediate Data Engineer",
    "Intermediate Backend Engineer , Security Factory",
  ]) {
    // One code for the whole family, so the set is countable and revertible together.
    assert.equal(titleVerdict(title), "title_seniority", title);
  }
});

test("title rule 1, seniority: words that merely contain the letters are untouched", () => {
  // VPN is a technology, not a grade; "Interview" and "Intermediary" are not "Intermediate".
  for (const title of ["VPN Software Engineer", "Software Engineer, Interview Platform", "Intermediary Services Developer"]) {
    // Whole-word matching only.
    assert.equal(titleVerdict(title), "pass", title);
  }
});

test("title rule 2, PhD: a PhD in the title is dropped as title_phd, in every live spelling", () => {
  // Marvell and NVIDIA live titles, plus the dotted and spaced spellings.
  for (const title of [
    "Research Intern (PhD), Storage Systems for AI",
    "Research Intern, Physical AI and GPU (PhD)",
    "PhD Intern, AI ML in Wireless L1/L2 - Fall 2026",
    "Research Engineer, Ph.D. Graduate",
    "Applied Scientist Intern (Ph D)",
  ]) {
    // Its own code.
    assert.equal(titleVerdict(title), "title_phd", title);
  }
});

test("title rule 3, non-software: a technician, technical writer or physical-design title is dropped as title_non_software", () => {
  // Micron, Nasdaq and Broadcom live titles. "Backend Physical Design Engineer" carries "Backend", a
  // software-looking word, so these three phrases are NOT rescued by one.
  for (const title of [
    "Graduate Engineering Technician",
    "PDE CEM Graduate Engineering Technician",
    "Analyst—Information Developer / Technical Writer",
    "Backend Physical Design Engineer",
  ]) {
    // Its own code.
    assert.equal(titleVerdict(title), "title_non_software", title);
  }
});

test("title rule 3, non-software: manufacturing / supplier quality / field service in a title drops unless the title is clearly software", () => {
  // A manufacturing job with an engineer title: dropped.
  assert.equal(titleVerdict("Graduate Manufacturing Engineer"), "title_non_software");
  // Supplier quality and field service, likewise.
  assert.equal(titleVerdict("Supplier Quality Engineer Trainee"), "title_non_software");
  // Field service.
  assert.equal(titleVerdict("Field Service Engineer"), "title_non_software");
  // A software role FOR a manufacturing domain stays: its title says software, which these three phrases do not override.
  assert.equal(titleVerdict("Software Engineer, Manufacturing Systems"), "pass");
});

test("title rule 3, non-software: a generic engineer title is judged by the head of its description", () => {
  // GE HealthCare 9e2c0803 and 23961e8a: the title says nothing, the first lines say field service / manufacturing.
  assert.equal(titleVerdict("Graduate Engineering Trainee", "Job Description Summary All resources required to perform services and maintenance activities on the customer site, and field services engineering."), "title_non_software");
  // Manufacturing in the head.
  assert.equal(titleVerdict("Graduate Engineering Trainee", "Job Description Summary As a Graduate Manufacturing Engineer, you will support New Product Introduction."), "title_non_software");
  // The same generic title with a software JD passes: the rule needs a non-software function, not just a generic title.
  assert.equal(titleVerdict("Graduate Engineering Trainee", "You will build backend services in Python and ship APIs."), "pass");
  // Only the HEAD counts: a manufacturing company blurb deep in the body does not drop a generic title.
  assert.equal(titleVerdict("Graduate Engineering Trainee", "You will build backend services in Python. ".repeat(30) + "Our company runs manufacturing plants."), "pass");
  // A clearly-software title never reads its description for this rule, whatever the company does.
  assert.equal(titleVerdict("Graduate Software Engineer", "We are a manufacturing and field service leader."), "pass");
});

test("negative set: the titles Teja hunts all still pass the title rules", () => {
  // Each is a title the old gate passed and Teja wants; none may trip any of the four rules.
  for (const title of [
    "Software Engineer",
    "Data Scientist",
    "Backend Intern",
    "AI Engineer",
    "SDE Intern",
    "Graduate Software Engineer",
    // "Design" alone is not "physical design": a frontend design engineer is software (decision, 2026-11-06).
    "Design Engineer — Frontend",
    "Software Engineer Intern, Summer 2027",
    "Full-Stack Software Engineer, (Forward Deployed), GPS",
  ]) {
    // Positive recognition by the usual terms, with no title-rule code.
    assert.equal(titleVerdict(title), "pass", title);
  }
});

// Review (2026-11-07): near-misses a naive word list would drop, each of which must keep passing.
test("title rules: software roles beside a non-software domain word still pass", () => {
  // EDA software: "physical design" with an unmistakable software word.
  assert.equal(titleVerdict("Physical Design Automation Software Engineer"), "pass");
  // A platform / analytics engineer in a manufacturing domain is software.
  assert.equal(titleVerdict("Platform Engineer - Manufacturing Execution Systems"), "pass");
  assert.equal(titleVerdict("Manufacturing Analytics Engineer"), "pass");
  // "Technical Program Manager" is not a technical writer; "VPC" is not a VP.
  assert.equal(titleVerdict("VPC Network Engineer"), "pass");
  // PhD as a preference is not a PhD-only role.
  assert.equal(titleVerdict("ML Intern (PhD preferred)"), "pass");
  // The same word in the doctoral-only form still drops (positive control for the lookahead).
  assert.equal(titleVerdict("ML Intern (PhD)"), "title_phd");
});

test("title rules answer before the exclusion list, and a drop carries its own code", () => {
  // With Teja's "VP" exclusion configured, "VP, ..." is still the seniority code, not tech_gate: one family, one code.
  const withVp: TechGatePreferences = { ...TITLE_RULE_PREFS, excludedKeywords: ["VP"] };
  // The verdict.
  const verdict = screenTechRole("VP, Software Engineering", null, withVp);
  // Code from the new rule, reason naming the matched word.
  assert.equal(verdict.drop && verdict.code, "title_seniority");
});

// N1 (2026-11-07): stored rows can be raw HTML (live row 76280e87). The gate reads only the first 300
// characters of the body, and on an HTML row those are mostly tags and inline styles, so a keyword in the
// first lines of the TEXT fell outside the window. Its siblings (required-experience.ts, work-auth-gate.ts)
// already read stripHtml's text. Red on revert of the stripHtml line in screenTechRole.
test("N1: an HTML body is read as text, so a keyword early in the prose is inside the 300-character head", () => {
  // Eight styled empty paragraphs (about 300 characters of markup), then a short paragraph naming React.
  const html = '<p style="min-height:1.5em"></p>'.repeat(8) + '<h2>About the role</h2><p style="min-height:1.5em">We build the product in <strong>React</strong> and TypeScript.</p>';
  // "React" sits past character 300 of the stored text but near the start of the posting's words.
  assert.ok(html.indexOf("React") > 300, "fixture must place the keyword past the raw window");
  // An unlisted title, so only the keyword can classify it.
  const verdict = screenTechRole("Product Builder", html, PREFS);
  // Kept: the keyword is found in the text.
  assert.equal(verdict.drop, false, JSON.stringify(verdict));
});

// The control: a body that was already text is read exactly as before.
test("N1 control: a plain-text body is matched exactly as before", () => {
  // The same words with no markup.
  const verdict = screenTechRole("Product Builder", "We build the product in React and TypeScript.", PREFS);
  // Kept, as it always was.
  assert.equal(verdict.drop, false, JSON.stringify(verdict));
});

// --- T4 (2026-11-10): software-role spellings the configured list does not literally contain -------------
// MEASURED: a stratified random sample of 230 of the 11,149 live tech_gate_unclassified rows held 10 clear
// software roles (4.3%, Wilson 95% [2.4%, 7.8%]). Each was dropped because its title spells a configured role
// differently: "Software Development Engineer" is not "Software Developer", "SW" is not "Software", "AI Field
// Engineer" is not "AI Engineer". These tests run against Teja's LIVE config (search_preferences, 2026-11-04),
// so they fail for the reason the live rows failed, not for a toy list's gaps.
const LIVE_PREFS: TechGatePreferences = {
  // Copied from the live row; the order does not matter to the gate.
  titles: ["Software Engineer Intern", "Junior Developer", "Graduate Engineer", "Software Engineer", "Software Developer", "Backend", "Back-end", "Frontend", "Front-end", "Full Stack", "Full-Stack", "Fullstack", "SDE", "Developer", "Junior", "Graduate", "New Grad", "Associate Software", "Forward Deployed", "FDE", "AI Engineer", "ML Engineer", "Machine Learning Engineer", "Data Engineer", "Data Analyst", "Data Scientist", "Analytics Engineer", "Web Developer", "Web Engineer", "Cloud Engineer", "DevOps", "Site Reliability", "SRE", "Platform Engineer", "Infrastructure Engineer", "AI Support Engineer", "AI Solutions Engineer", "AI Systems Engineer", "AI Reliability Engineer", "Cloud Support Engineer", "Cloud Security Engineer", "Cloud Operations Engineer", "Security Engineer", "AI Applied Scientist", "AI Research Engineer", "AI Security Research", "Distributed Systems Engineer", "Data Infrastructure", "Technical Services Engineer", "Generative AI", "Intern", "MERN", "Internship", "GenAI"],
  // The five live keywords.
  keywords: ["Node.js", "React", "TypeScript", "Python", "REST APIs"],
  // The live exclusions; they still run first, so a variant cannot rescue a senior title.
  excludedKeywords: ["Senior", "Lead", "Principal", "5+ years", "Staff Engineer", "Staff Software", "Staff Security", "Staff ML", "Staff UI", "Staff Data", "Staff Backend", "Staff Frontend", "Staff Full Stack", "Sr", "Head", "Director", "VP", "Manager", "Android", "Research Scientist", "Staff", "Designer", "II", "III", "IV", "Architect"],
};

// Pattern 1: "software"/"SW" plus an engineering role word, in any order (live: Zscaler, Parallel Wireless).
test("T4 spelling: 'Software Development Engineer' passes (not literally 'Software Developer')", () => {
  // The live title, description absent as it is on most dropped rows.
  const verdict = screenTechRole("Software Development Engineer - Java + Distributed Systems", null, LIVE_PREFS);
  // Kept, with no warning: a recognised software role.
  assert.deepEqual(verdict, { drop: false });
});

// The abbreviation recruiters use for software.
test("T4 spelling: 'SW Engineer' passes as a software engineer", () => {
  // The live title.
  const verdict = screenTechRole("AI-Driven 4G PHY SW Engineer", null, LIVE_PREFS);
  // Kept.
  assert.deepEqual(verdict, { drop: false });
});

// Pattern 2: an AI/ML word directly qualifying "Engineer", with at most one word between (live: Fireworks AI).
test("T4 spelling: 'AI Field Engineer' passes as an AI engineer", () => {
  // The live title.
  const verdict = screenTechRole("AI Field Engineer - Enterprise", null, LIVE_PREFS);
  // Kept.
  assert.deepEqual(verdict, { drop: false });
});

// Pattern 3: the four engineer kinds seen live, each of them software work (Canonical, xAI, Mistral, LangChain).
test("T4 spelling: kernel, model, research and deployed engineers pass", () => {
  // One live title per kind.
  for (const title of ["PC Platforms Kernel Engineer - Ubuntu Linux", "Model Engineer, Post-Training & RL", "Applied Scientist - Research Engineer (Optimisation), EMEA", "Deployed Engineer (Atlanta)"]) {
    // Each one kept, named in the failure message.
    assert.deepEqual(screenTechRole(title, null, LIVE_PREFS), { drop: false }, title);
  }
});

// OVER-ADMIT GUARD: true out-of-scope titles from the same live sample, chosen because each carries a word a
// spelling rule reads ("AI", "Engineer", "Engineering", "Software", "Systems"). Every one must still drop.
test("T4 guard: out-of-scope titles carrying AI/engineer/software words still drop", () => {
  // Sales, pre-sales, hardware, ops and AI-adjacent non-engineering titles, all from the 2026-11-10 sample.
  const outOfScope = [
    "AI Tutor - Finnish", "Strategic Account Executive, AI - San Francisco", "CPGR Growth Leader, AI Engineering, Strategic Accounts",
    "Machine Learning Fellow - Human Frontier Collective (Canada)", "AI & Process Automation Specialist", "Specialist Seller - Enterprise Select - AI",
    "Solution Engineer", "Solutions Engineer", "Partner Engineer", "Delivery Engineer", "Financial Systems Engineer",
    "OT Systems Engineer, Physical Infrastructure - Memphis", "OSP Engineer - Memphis", "Hardware Engineer", "Memory Design Engineer",
    "Emulation Engineer", "Customer Quality Engineer", "UTM Engineer - DoorDash Air", "Tech Sourcer (Contract)", "Product Marketing, Postgres",
  ];
  // Each one dropped; the message names the title that slipped through.
  for (const title of outOfScope) assert.equal(screenTechRole(title, null, LIVE_PREFS).drop, true, title);
});

// The exclusions still run before any spelling rule: a senior software title is not rescued.
test("T4 guard: an excluded seniority term still drops a software-spelled title", () => {
  // "II" is a live exclusion; the title also matches spelling pattern 1.
  const verdict = screenTechRole("Enterprise Software Test Engineer II", null, LIVE_PREFS);
  // Dropped by the exclusion, with its own code.
  assert.equal(verdict.drop && verdict.code, "tech_gate");
});

// T4 follow-up (orch, 2026-11-10): the live title "Software Engineering Manager__Electronic Trading_Java _AI" passed
// once spelling pattern 1 recognised it, because `\bManager\b` cannot match before "_" (a regex word character).
// An underscore separates words in a scraped title as a space does, so the exclusion must see "Manager" as a word.
test("T4 guard: an underscore-joined title still meets its exclusion ('Manager__Electronic Trading')", () => {
  // The exact live title.
  const verdict = screenTechRole("Software Engineering Manager__Electronic Trading_Java _AI", null, LIVE_PREFS);
  // Dropped by the live "Manager" exclusion, with the exclusion's code.
  assert.equal(verdict.drop && verdict.code, "tech_gate", JSON.stringify(verdict));
});
