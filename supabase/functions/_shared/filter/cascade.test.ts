// Table-driven tests for the filter cascade (PROJECT_PLAN.md §8, §19).
//
// WHAT THESE ARE REALLY PROTECTING: every one of these filters can fail in two
// directions, and the two failures look nothing alike from outside. A filter that
// drops too much presents as "the system found nothing today" — no error, no log, just
// an empty queue that looks like a quiet job market. A filter that drops too little
// presents as a Gemini bill and a queue full of Senior roles. The first is far harder
// to notice, which is why most of the cases below are about NOT dropping.
import { test } from "node:test";
// Strict, so a `false` verdict never quietly compares equal to `undefined`.
import assert from "node:assert/strict";
// Extension-suffixed specifier so this runs under Deno and `node --test` alike.
import { screenJob, type ScreenableJob, type ScreenContext } from "./cascade.ts";
// Row shapes from the schema owner.
import type { FilterRuleRow, FilterRuleType, Json } from "../contracts/shared-types.ts";

// A fixed clock, so "posted 3 days ago" is assertable rather than flaky at midnight.
const NOW = new Date("2026-09-10T12:00:00.000Z");

// An ordinary job that passes everything, so each test can break exactly one thing.
const BASE_JOB: ScreenableJob = {
  title: "Backend Engineering Intern",
  companySlug: "zomato",
  locations: ["bangalore"],
  locationRaw: "Bengaluru, India",
  employmentType: "internship",
  minExperienceYears: "0",
  requiresAdvancedDegree: false,
  postedAt: "2026-09-09T12:00:00.000Z",
  postedAtSource: "exact",
  fingerprint: "fp-clean",
};

// An empty context: nothing applied to, nothing blocked.
const BASE_CONTEXT: ScreenContext = {
  now: NOW,
  appliedFingerprints: new Set(),
  blockedCompanySlugs: new Set(),
};

// Build one enabled rule row. `sort_order` defaults to 0 because most tests run a
// single rule and do not care about ordering.
function rule(ruleType: FilterRuleType, config: Json, sortOrder = 0, enabled = true): FilterRuleRow {
  return {
    // Ids are not read by the cascade, so a stable placeholder keeps the fixtures small.
    id: `rule-${ruleType}`,
    user_id: "user-1",
    rule_type: ruleType,
    enabled,
    config,
    sort_order: sortOrder,
    created_at: "2026-09-01T00:00:00.000Z",
    updated_at: "2026-09-01T00:00:00.000Z",
  };
}

// Run the cascade with overrides applied to the clean job and empty context.
function screen(rules: FilterRuleRow[], jobOverrides: Partial<ScreenableJob> = {}, contextOverrides: Partial<ScreenContext> = {}) {
  return screenJob({ ...BASE_JOB, ...jobOverrides }, rules, { ...BASE_CONTEXT, ...contextOverrides });
}

// --- the cascade mechanics ------------------------------------------------------

// The economic point of the whole module: a job rejected by the cheap title check
// never has its description examined and never reaches the Matcher.
test("the first matching rule short-circuits and later rules do not run", () => {
  // Title blocks first (sort_order 1); the experience ceiling would also drop it (sort_order 2). Was staleness until
  // that rule was retired (2026-11-10), when it stopped dropping anything.
  const result = screen(
    [
      rule("title_blocklist", { blocked_titles: ["senior"] }, 1),
      rule("experience_ceiling", { max_years: 1 }, 2),
    ],
    { title: "Senior Backend Engineer", minExperienceYears: "5" },
  );
  // Dropped.
  assert.equal(result.passed, false);
  if (result.passed) return;
  // BY THE TITLE RULE, not by the experience ceiling. If the cascade evaluated everything and
  // reported the last match, this would say `experience_ceiling` — and the saving the cascade
  // exists for would not be happening.
  assert.equal(result.ruleType, "title_blocklist");
});

// The evaluation order is a setting, so re-ordering the cheap tests ahead of the
// expensive ones is a settings change rather than a deploy.
test("evaluation order comes from sort_order, not from array position", () => {
  // The experience ceiling is listed FIRST in the array but ordered SECOND.
  const result = screen(
    [
      rule("experience_ceiling", { max_years: 1 }, 20),
      rule("title_blocklist", { blocked_titles: ["senior"] }, 10),
    ],
    { title: "Senior Backend Engineer", minExperienceYears: "5" },
  );
  // Dropped.
  assert.equal(result.passed, false);
  if (result.passed) return;
  // The lower sort_order won, so the database controls the cascade shape.
  assert.equal(result.ruleType, "title_blocklist");
});

// The caller's array must not be mutated — an in-place sort of a shared array is the
// kind of side effect that surfaces three modules away.
test("the caller's rule array is not reordered in place", () => {
  // Two rules in a deliberately non-sorted order.
  const rules = [rule("experience_ceiling", { max_years: 1 }, 20), rule("title_blocklist", { blocked_titles: ["senior"] }, 10)];
  // Remember the original first element.
  const firstBefore = rules[0];
  // Run.
  screen(rules);
  // Unchanged.
  assert.equal(rules[0], firstBefore);
});

// This is how the settings page turns a filter off, so it must be honoured before
// anything else about the rule is read.
test("a disabled rule is skipped entirely", () => {
  // A rule that would certainly drop this job, switched off.
  const result = screen([rule("title_blocklist", { blocked_titles: ["backend"] }, 0, false)]);
  // Passes, because the rule is off.
  assert.equal(result.passed, true);
});

// A job with no rules configured is not a job that should be dropped.
test("an empty rule set passes everything", () => {
  // Nothing configured at all.
  assert.equal(screen([]).passed, true);
});

// --- MISCONFIGURATION MUST FAIL TOWARD THE VISIBLE FAILURE ----------------------
//
// The direction this fails in IS the decision. Dropping on misconfiguration loses jobs
// invisibly and Teja experiences it as "the system found nothing", with no error
// anywhere. Passing costs at most a few Gemini calls and shows up as a warning.

test("a rule with no threshold configured warns and does NOT drop the job", () => {
  // `max_years` absent entirely.
  const result = screen([rule("experience_ceiling", {})], { minExperienceYears: "99" });
  // Passed despite the job clearly exceeding any sane ceiling.
  assert.equal(result.passed, true);
  // And the misconfiguration is reported so it can be fixed.
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0] ?? "", /max_years/);
});

// A misconfigured rule must not stop the other eight from protecting the quota.
test("a misconfigured rule does not prevent a later rule from dropping", () => {
  // Rule 1 is broken; rule 2 works.
  const result = screen(
    [rule("experience_ceiling", {}, 1), rule("title_blocklist", { blocked_titles: ["senior"] }, 2)],
    { title: "Senior Backend Engineer" },
  );
  // Still dropped, by the working rule.
  assert.equal(result.passed, false);
  if (result.passed) return;
  assert.equal(result.ruleType, "title_blocklist");
  // And the broken rule is still reported.
  assert.equal(result.warnings.length, 1);
});

// --- experience ceiling ----------------------------------------------------------

// §8's headline example: "5+ years required" against a candidate who wants ≤ 1.
test("experience ceiling drops a JD demanding more years than configured", () => {
  // JD wants 5, ceiling is 1.
  const result = screen([rule("experience_ceiling", { max_years: 1 })], { minExperienceYears: "5" });
  // Dropped, with the numbers in the reason so a surprising drop is diagnosable.
  assert.equal(result.passed, false);
  if (result.passed) return;
  assert.match(result.reason, /5 years.*ceiling is 1/);
});

// Exactly at the ceiling must pass, or the effective limit is off by one.
test("experience ceiling admits a JD exactly at the limit", () => {
  // JD wants 1, ceiling is 1.
  assert.equal(screen([rule("experience_ceiling", { max_years: 1 })], { minExperienceYears: "1" }).passed, true);
});

// Absence is not a demand for eight years. Dropping on a non-answer would silently
// discard every job whose JD the parser could not read.
test("experience ceiling does not drop a job whose requirement is unknown", () => {
  // The parser found nothing.
  const result = screen([rule("experience_ceiling", { max_years: 1 })], { minExperienceYears: null });
  assert.equal(result.passed, true);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0] ?? "", /min_experience_years/);
});

// `Number("abc")` is NaN and every NaN comparison is false, so this would pass
// anyway — asserted so the behaviour is intended rather than accidental.
test("experience ceiling does not drop a job with an unparseable requirement", () => {
  // Junk in the column.
  const result = screen([rule("experience_ceiling", { max_years: 1 })], { minExperienceYears: "not a number" });
  assert.equal(result.passed, true);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0] ?? "", /unparseable/);
});

// --- title blocklist -------------------------------------------------------------

// The §8 list, from config rather than hardcoded.
test("title blocklist drops a blocked seniority term", () => {
  // "Senior" is the canonical case.
  const result = screen([rule("title_blocklist", { blocked_titles: ["senior", "staff", "principal"] })], { title: "Senior Backend Engineer" });
  // Dropped, naming which word matched.
  assert.equal(result.passed, false);
  if (result.passed) return;
  assert.match(result.reason, /"senior"/);
});

// THE SUBSTRING TRAP, and it fails in the invisible direction. A bare
// `includes("lead")` drops "Team Lead" correctly and "Lead Generation Intern" and
// "Leadership Program" wrongly — presenting as thin supply rather than a filter bug.
test("title blocklist matches whole words, not substrings", () => {
  // The blocked word appears only as a prefix of a longer, legitimate word.
  const blocked = [rule("title_blocklist", { blocked_titles: ["lead"] })];
  // "Leadership" must NOT match.
  assert.equal(screen(blocked, { title: "Leadership Development Intern" }).passed, true);
  // Nor must "Leading".
  assert.equal(screen(blocked, { title: "Leading Edge Intern" }).passed, true);
  // But a genuine "Lead" must.
  assert.equal(screen(blocked, { title: "Team Lead" }).passed, false);
});

// Recruiters do not agree on casing, so matching must not depend on it.
test("title blocklist is case-insensitive", () => {
  // Shouted title, lower-case rule.
  assert.equal(screen([rule("title_blocklist", { blocked_titles: ["senior"] })], { title: "SENIOR BACKEND ENGINEER" }).passed, false);
});

// A configured term containing regex metacharacters must be matched literally, not
// compiled as a pattern — otherwise a stray "(" in the settings page throws.
//
// THIS TEST FOUND A REAL BUG. The first implementation wrapped every term in `` on
// both ends, and `` marks a WORD/NON-WORD TRANSITION — so `c\+\+` can never
// match "C++ Developer", because after "++" comes a space and two non-word characters
// in a row are not a boundary. Terms like "c++", ".net", "c#" and "node.js" would have
// been configured, displayed in the settings page, and silently matched nothing.
// That is the worse of the two failure directions: an over-broad filter shows up as a
// missing job, but an inert one shows up as nothing at all.
test("a blocked title ending in a non-word character still matches", () => {
  // A term whose last character is not a word character.
  const result = screen([rule("title_blocklist", { blocked_titles: ["c++"] })], { title: "C++ Developer" });
  // Matched as literal text, with no exception and no silently-dead rule.
  assert.equal(result.passed, false);
});

// The conditional boundary must not cost the over-matching protection it exists
// alongside: a term with word characters at both ends still gets both boundaries.
test("a blocked title with word characters at both ends keeps whole-word matching", () => {
  // "senior" must not match "seniority".
  assert.equal(screen([rule("title_blocklist", { blocked_titles: ["senior"] })], { title: "Seniority Analyst" }).passed, true);
  // But must still match the real thing.
  assert.equal(screen([rule("title_blocklist", { blocked_titles: ["senior"] })], { title: "Senior Analyst" }).passed, false);
});

// A term with a leading non-word character gets the mirror treatment, so ".net" is
// matched where it appears rather than being inert like "c++" was.
test("a blocked title starting with a non-word character still matches", () => {
  // A leading dot, which would have defeated an unconditional leading boundary.
  assert.equal(screen([rule("title_blocklist", { blocked_titles: [".net"] })], { title: "ASP.NET Developer" }).passed, false);
});

// --- location allowlist ----------------------------------------------------------

// Hyderabad, Bangalore, Remote — nothing else.
test("location allowlist drops a location that is not on the list", () => {
  // A city Teja does not want.
  const result = screen([rule("location_allowlist", { allowed_locations: ["bangalore", "hyderabad", "remote"] })], {
    locations: ["pune"],
    locationRaw: "Pune, India",
  });
  // Dropped.
  assert.equal(result.passed, false);
  if (result.passed) return;
  assert.match(result.reason, /Pune/);
});

// AN UNSET LIST AND AN EMPTY LIST MEAN OPPOSITE THINGS, and collapsing them turns a
// missing setting into a total blackout that looks like the pipeline stalling.
test("an unset allowlist warns and drops nothing, while an empty one drops everything", () => {
  // Unset: not configured.
  const unset = screen([rule("location_allowlist", {})]);
  assert.equal(unset.passed, true);
  assert.equal(unset.warnings.length, 1);
  // Explicitly empty: configured to permit nothing, and honoured as such.
  const empty = screen([rule("location_allowlist", { allowed_locations: [] })]);
  assert.equal(empty.passed, false);
});

// Dropping a genuinely remote job because the location parser missed "Remote" would
// be a parser bug presenting as a supply problem, so the raw string is a fallback.
test("the allowlist matches the raw location string when parsing produced nothing", () => {
  // Parser found no structured locations, but the prose says Remote.
  const result = screen([rule("location_allowlist", { allowed_locations: ["remote"] })], {
    locations: [],
    locationRaw: "Remote (India)",
  });
  // Kept.
  assert.equal(result.passed, true);
});

// --- employment type --------------------------------------------------------------

test("employment type drops a type that is not permitted", () => {
  // Only internships wanted; this is a contract role.
  assert.equal(screen([rule("employment_type", { allowed_types: ["internship"] })], { employmentType: "contract" }).passed, false);
});

// THE ADAPTERS DELIBERATELY DECLINE TO GUESS when a board says nothing, and dropping
// on that non-answer would punish honest parsing. The boards that report nothing are
// not the boards with worse jobs.
test("an unknown employment type is not dropped", () => {
  // The board said nothing and the adapter refused to invent an answer.
  assert.equal(screen([rule("employment_type", { allowed_types: ["internship"] })], { employmentType: "unknown" }).passed, true);
});

// --- already applied and company blocklist ---------------------------------------

// A cheap pre-check ahead of the UNIQUE constraint, so a Gemini call is not spent
// discovering something the database already knows.
test("a fingerprint already in history is dropped", () => {
  // This posting has been applied to.
  const result = screen([rule("already_applied", {})], {}, { appliedFingerprints: new Set(["fp-clean"]) });
  assert.equal(result.passed, false);
});

// Without this, a staffing firm posting 30 near-identical listings a week collects 30
// applications and you never notice, because each looked like a different job.
test("a blocklisted company is dropped", () => {
  // Blocked by slug, which is why the slug is normalised at insert time.
  const result = screen([rule("company_blocklist", {})], {}, { blockedCompanySlugs: new Set(["zomato"]) });
  assert.equal(result.passed, false);
  if (result.passed) return;
  assert.match(result.reason, /zomato/);
});

// --- degree mismatch ---------------------------------------------------------------

test("degree mismatch drops a JD requiring an advanced degree", () => {
  // The JD demands a Master's and the candidate has none.
  assert.equal(screen([rule("degree_mismatch", {})], { requiresAdvancedDegree: true }).passed, false);
});

// NULL means the parser could not tell, and declining to guess beats dropping.
test("degree mismatch does not drop when the requirement is unknown", () => {
  // Parser found nothing either way.
  const result = screen([rule("degree_mismatch", {})], { requiresAdvancedDegree: null });
  assert.equal(result.passed, true);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0] ?? "", /requires_advanced_degree/);
});

// Whether Teja holds an advanced degree is a setting, so the same code stays correct
// after he finishes a Master's rather than needing an edit.
test("degree mismatch stops dropping once the candidate has an advanced degree", () => {
  // Setting flipped.
  assert.equal(screen([rule("degree_mismatch", { candidate_has_advanced_degree: true })], { requiresAdvancedDegree: true }).passed, true);
});

// --- retired rules: staleness and the per-company weekly cap ----------------------
//
// Teja, 2026-11-10 11:31 IST: the weekly cap "remove it"; job age "dont ever skip even though they are 1 mon 2 mont old".
// The enum keys stay (Postgres cannot drop an enum value, and RULE_IMPLEMENTATIONS is keyed by the enum), so a live
// row of either type must be inert: never a drop, never a warning, whatever its config says.

test("retired rules (Teja 2026-11-10): a 60-day-old job and a 5th same-company job both PASS", () => {
  // Both retired rules ENABLED with the strictest thresholds the old code honoured, and a context carrying the old
  // weekly-count field (cast: the field is gone from ScreenContext), so a reverted evaluator drops for the real reason.
  const rules = [rule("staleness", { window_days: 3 }, 1), rule("per_company_weekly_cap", { max_per_week: 2 }, 2)];
  // Four already sent to zomato this week: this job would be the 5th.
  const oldContext = { applicationsThisWeekByCompany: new Map([["zomato", 4]]) } as unknown as Partial<ScreenContext>;
  // 60 days before NOW (2026-09-10), from a trusted date.
  const sixtyDaysOld = screen(rules, { postedAt: "2026-07-12T12:00:00.000Z" }, oldContext);
  // Passes, with nothing to report: the positive shape, so a drop OR a stray warning both fail here.
  assert.deepEqual([sixtyDaysOld.passed, sixtyDaysOld.warnings], [true, []]);
  // The cold-start case the old staleness rule dropped by default: an untrusted posting date.
  const unknownDate = screen(rules, { postedAtSource: "unknown" }, oldContext);
  // Also kept: age is never a reason to skip.
  assert.deepEqual([unknownDate.passed, unknownDate.warnings], [true, []]);
});

test("retired rules stay inert with no config or a junk date: no warning floods agent_runs", () => {
  // Unconfigured live rows (the 2 seeded rows today) used to warn on every job; junk dates used to warn too.
  const result = screen([rule("staleness", {}, 1), rule("per_company_weekly_cap", {}, 2)], { postedAt: "not-a-date" });
  // Kept, silently.
  assert.deepEqual([result.passed, result.warnings], [true, []]);
});

// --- the whole cascade together -----------------------------------------------------

// The §8 scenario end to end: a full, realistically-configured cascade admits a good
// job and rejects the canonical bad one. A suite of single-rule tests can all pass
// while the assembled cascade rejects everything, so this is the integration check.
test("a fully configured cascade admits a good job and rejects a Senior one", () => {
  // Every rule enabled, in cost order.
  const full = [
    rule("title_blocklist", { blocked_titles: ["senior", "staff", "principal", "lead", "manager", "architect"] }, 1),
    rule("employment_type", { allowed_types: ["internship", "full_time"] }, 2),
    rule("location_allowlist", { allowed_locations: ["bangalore", "hyderabad", "remote"] }, 3),
    rule("experience_ceiling", { max_years: 1 }, 4),
    rule("degree_mismatch", {}, 5),
    rule("company_blocklist", {}, 6),
    rule("already_applied", {}, 7),
    rule("staleness", { window_days: 3 }, 8),
    rule("per_company_weekly_cap", { max_per_week: 2 }, 9),
  ];
  // The good job survives everything, with no misconfiguration warnings.
  const good = screen(full);
  assert.equal(good.passed, true);
  assert.deepEqual(good.warnings, []);
  // The §8 example dies at the first test, having never had its description parsed.
  const bad = screen(full, { title: "Senior Backend Engineer", minExperienceYears: "5" });
  assert.equal(bad.passed, false);
  if (bad.passed) return;
  assert.equal(bad.ruleType, "title_blocklist");
});
