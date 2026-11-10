// Tests for the screener glue — the seam that finally gives `screenJob` a caller.
//
// WHAT THIS MODULE IS FOR: the cascade has been built and tested since 2026-09-10 and
// has never run. `screenJob` is imported by exactly one file, its own test. These tests
// cover the adapter that sits between the Scout's in-memory `JobInsert` batch and that
// cascade, plus the decision about what status the resulting `applications` row is born
// carrying.
//
// WHY THE RULES ARE BUILT HERE RATHER THAN READ FROM `filter_rules`: the bootstrap that
// seeds that table is currently broken two independent ways (a wrong column name in the
// seeding function, and a wrong column name in the dashboard's write path), so every
// user has zero rules. A test that read the real table would pass against an empty table
// by dropping nothing — the vacuous pass, and the exact disease this parcel is cleaning
// up. Injecting rules keeps these assertions honest today AND after those fixes land.
import { test } from "node:test";
// Strict, so a missing field never quietly compares equal to null.
import assert from "node:assert/strict";
// Extension-suffixed specifier so this runs under Deno and `node --test` alike.
import { toScreenableJob, planScreenedApplications, type ScreenPreferences } from "./screen-batch.ts";
// The cascade itself — the module under wiring.
import type { ScreenContext } from "../filter/cascade.ts";
// Row shapes from the schema owner.
import type { FilterRuleRow, Json, JobInsert } from "../contracts/shared-types.ts";

// A fixed clock, so the context's `now` is deterministic (it fed the staleness rule until that rule was retired, 2026-11-10).
const NOW = new Date("2026-09-17T12:00:00.000Z");

// An ordinary row as `toJobInsert` emits it, so each test can break exactly one thing.
const BASE_ROW: JobInsert = {
  fingerprint: "fp-base",
  title: "Backend Engineering Intern",
  company_name: "Zomato",
  company_slug: "zomato",
  location_raw: "Bengaluru, India",
  locations: [],
  work_arrangement: "onsite",
  employment_type: "internship",
  description_raw: "Work on the ordering service.",
  apply_url: "https://boards.greenhouse.io/zomato/jobs/1",
  ats_provider: "greenhouse",
  ats_job_id: "1",
  discovered_via: ["career_page"],
  source_refs: [],
  posted_at: "2026-09-16T12:00:00.000Z",
  posted_at_source: "exact",
  raw_payload: { id: 1 },
};

// Nothing applied to, nothing blocked — so a test that wants one of those effects has to
// ask for it explicitly. (The weekly-usage Map left with the retired cap, 2026-11-10.)
const BASE_CONTEXT: ScreenContext = {
  now: NOW,
  appliedFingerprints: new Set(),
  blockedCompanySlugs: new Set(),
};

// Build one enabled rule row with real config. `sort_order` defaults to 0 because most
// of these tests run a single rule and do not care about ordering.
function rule(ruleType: FilterRuleRow["rule_type"], config: Json, sortOrder = 0): FilterRuleRow {
  return {
    id: `rule-${ruleType}`,
    user_id: "user-1",
    rule_type: ruleType,
    enabled: true,
    config,
    sort_order: sortOrder,
    created_at: "2026-09-01T00:00:00.000Z",
    updated_at: "2026-09-01T00:00:00.000Z",
  };
}

// The blocklist Teja's "I keep getting non-IT jobs" complaint actually needs.
const TITLE_RULE = rule("title_blocklist", { blocked_titles: ["senior", "staff", "principal", "manager"] });

// Stage-0 preferences that classify nothing, so the cascade tests above exercise the
// cascade rather than the tech gate. Every job reaches the nine rules, which is the
// behaviour the unconfigured-preferences branch guarantees.
// workAuthorizedCountries: null leaves stage 0b (the work-auth gate) open, so these tests see
// exactly the verdicts they saw before that gate existed (plus its one "gate open" warning).
// remoteLocationPolicy 'any' keeps the 10-24 remote reading these tests were written against; the
// 11-04 policy has its own tests at the end of the file.
const OPEN_PREFS: ScreenPreferences = { titles: [], keywords: [], excludedKeywords: [], workAuthorizedCountries: null, remoteLocationPolicy: "any" };

// A configured gate, for the stage-0 tests at the end of this file.
const TECH_PREFS: ScreenPreferences = {
  titles: ["engineer", "developer"],
  keywords: ["react"],
  excludedKeywords: ["sales", "recruiter"],
  // Open, for the same reason as OPEN_PREFS: these tests are about the tech gate.
  workAuthorizedCountries: null,
  // Irrelevant with the list open; stated because the field is required.
  remoteLocationPolicy: "any",
};

// --- the JobInsert -> ScreenableJob adapter ---------------------------------------

// The cascade reads a deliberately narrow interface rather than the full row, so
// something has to bridge the two. Getting a field name wrong here would not fail — it
// would silently feed the rule `undefined` and make it pass everything.
test("the adapter carries across the fields every rule reads", () => {
  const job = toScreenableJob(BASE_ROW);
  assert.equal(job.title, "Backend Engineering Intern");
  assert.equal(job.companySlug, "zomato");
  assert.equal(job.locationRaw, "Bengaluru, India");
  assert.equal(job.employmentType, "internship");
  assert.equal(job.postedAt, "2026-09-16T12:00:00.000Z");
  assert.equal(job.postedAtSource, "exact");
  assert.equal(job.fingerprint, "fp-base");
});

// THE TWO INERT RULES, pinned as a test so the gap is visible rather than folklore.
// `toJobInsert` never populates min_experience_years or requires_advanced_degree — no
// producer in the repo parses either out of a JD — so experience_ceiling and
// degree_mismatch receive null and return drop:false for every job. (Since B1, ruled
// 2026-10-08, the null path DOES warn, and run-summary.ts persists the warning to
// agent_runs.error_detail — the rules are loud about being skipped, but still inert.)
// If a future change starts populating these columns, this
// test fails and whoever made that change learns the two rules just came alive.
// 2026-11-04: experience_ceiling CAME ALIVE on purpose. toScreenableJob now reads the JD's
// required years (required-experience.ts) when the column is null, after Axiad's "6-8 years"
// reached manual apply. BASE_ROW's JD states no years, so it still arrives as null here; the
// degree half is still inert.
test("experience and degree arrive as null when the JD states no years and nothing populates them", () => {
  const job = toScreenableJob(BASE_ROW);
  assert.equal(job.minExperienceYears, null);
  assert.equal(job.requiresAdvancedDegree, null);
});

// The producer the rule lacked: the JD's hard minimum, as the string the cascade expects.
test("experience: a JD's '6-8 years of ... experience' arrives as minExperienceYears '6'", () => {
  // The Axiad wording, on a non-intern title (BASE_ROW is an intern, which is exempt).
  const job = toScreenableJob({ ...BASE_ROW, title: "AI-First Golang Developer", description_raw: "6-8 years of hands-on software development experience" });
  // The lower bound, as a string.
  assert.equal(job.minExperienceYears, "6");
});

// A stored column still wins over the parser, so a future producer's value is never overwritten.
test("experience: a stored min_experience_years wins over the JD text", () => {
  // Stored 0, JD says 5.
  const job = toScreenableJob({ ...BASE_ROW, min_experience_years: 0, description_raw: "5+ years of experience" } as typeof BASE_ROW);
  // The stored value.
  assert.equal(job.minExperienceYears, "0");
});

// End to end through the real cascade rule, with the ceiling migration 20261104193000 sets.
test("experience: the cascade's experience_ceiling drops a '5+ years' JD at max_years 1", () => {
  const planned = planScreenedApplications(
    // A JD with a hard 5-year minimum, on a non-intern title.
    [{ jobId: "exp-1", row: { ...BASE_ROW, title: "Backend Engineer", description_raw: "5+ years of backend engineering experience" } }],
    // Only the experience rule, configured as Teja ruled.
    [rule("experience_ceiling", { max_years: 1 })],
    BASE_CONTEXT,
    OPEN_PREFS,
  );
  // Born dropped under the cascade rule's own name.
  assert.deepEqual(planned.inserts, [{ job_id: "exp-1", status: "dropped_filter", drop_reason: "experience_ceiling" }]);
});

// And the same JD on an intern title is kept (Teja's 11-01 ruling).
test("experience: an intern title with a '5+ years' JD passes the ceiling", () => {
  const planned = planScreenedApplications(
    // An intern title.
    [{ jobId: "exp-2", row: { ...BASE_ROW, title: "Software Engineering Intern", description_raw: "5+ years of experience" } }],
    // The same ceiling.
    [rule("experience_ceiling", { max_years: 1 })],
    BASE_CONTEXT,
    OPEN_PREFS,
  );
  // Passed.
  assert.equal(planned.inserts[0]!.status, "passed_filters");
});

// --- the verdict -> applications row decision --------------------------------------

// The passing path. A job that survives every enabled rule is born at 'passed_filters',
// which is the status the Matcher selects on.
test("a job that survives every rule is born at passed_filters with no drop reason", () => {
  const planned = planScreenedApplications(
    [{ jobId: "job-1", row: BASE_ROW }],
    [TITLE_RULE],
    BASE_CONTEXT,
    OPEN_PREFS,
  );
  assert.equal(planned.inserts.length, 1);
  assert.equal(planned.inserts[0]!.status, "passed_filters");
  assert.equal(planned.inserts[0]!.drop_reason, null);
  assert.equal(planned.inserts[0]!.job_id, "job-1");
});

// The dropping path, and the one Teja's complaint depends on. A Senior role is rejected
// by the title blocklist before it ever costs a Gemini call.
test("a blocked title is born at dropped_filter naming the rule that rejected it", () => {
  const planned = planScreenedApplications(
    [{ jobId: "job-2", row: { ...BASE_ROW, title: "Senior Backend Engineer" } }],
    [TITLE_RULE],
    BASE_CONTEXT,
    OPEN_PREFS,
  );
  assert.equal(planned.inserts[0]!.status, "dropped_filter");
  // `drop_reason` NAMES THE RULE, per the contract stated at cascade.ts:78 and
  // status-flow.ts:81 — not the prose explanation, so the dashboard can group by it.
  assert.equal(planned.inserts[0]!.drop_reason, "title_blocklist");
});

// The prose reason is genuinely useful for diagnosing a surprising drop, so it must
// survive somewhere even though `drop_reason` carries the rule name instead.
test("the human-readable reason is kept alongside the row for the run summary", () => {
  const planned = planScreenedApplications(
    [{ jobId: "job-3", row: { ...BASE_ROW, title: "Staff Engineer" } }],
    [TITLE_RULE],
    BASE_CONTEXT,
    OPEN_PREFS,
  );
  assert.match(planned.dropped[0]!.reason, /blocked term "staff"/);
});

// A mixed batch is the realistic case, and the counters are what the operator reads to
// know the screener ran at all. A screener that drops nothing and one that was never
// called look identical without them.
test("a mixed batch is split and counted", () => {
  const planned = planScreenedApplications(
    [
      { jobId: "keep-1", row: BASE_ROW },
      { jobId: "drop-1", row: { ...BASE_ROW, fingerprint: "fp-2", title: "Senior Data Scientist" } },
      { jobId: "keep-2", row: { ...BASE_ROW, fingerprint: "fp-3", title: "Frontend Intern" } },
    ],
    [TITLE_RULE],
    BASE_CONTEXT,
    OPEN_PREFS,
  );
  assert.equal(planned.passedCount, 2);
  assert.equal(planned.droppedCount, 1);
  // Every job still gets a row: a drop is recorded, never omitted, or the dashboard
  // could not show Teja WHY a posting he can see in `jobs` never reached his queue.
  assert.equal(planned.inserts.length, 3);
});

// Misconfiguration must be visible without stopping the cascade. An unconfigured rule
// passes the job — cascade.ts fails toward the visible failure on purpose — and the
// warning is what tells the operator the filter is not actually protecting anything.
test("warnings from unconfigured rules are surfaced rather than swallowed", () => {
  const planned = planScreenedApplications(
    [{ jobId: "job-4", row: BASE_ROW }],
    // A title rule with no blocked_titles: the exact state every user is in today.
    [rule("title_blocklist", {})],
    BASE_CONTEXT,
    OPEN_PREFS,
  );
  assert.equal(planned.inserts[0]!.status, "passed_filters");
  assert.match(planned.warnings.join(" "), /no blocked_titles configured/);
});

// THE VACUOUS-PASS GUARD, and the most important test in this file. With zero rules the
// cascade drops nothing — which is indistinguishable from a screener that was never
// wired in. This pins that behaviour so it is a known, asserted state rather than a
// discovery someone makes in production, and it is why the completion report must say
// end-to-end filtering is still gated on the filter_rules fixes.
test("an empty rule set passes every job, which is why counters are not proof of wiring", () => {
  const planned = planScreenedApplications(
    [{ jobId: "job-5", row: { ...BASE_ROW, title: "Senior Principal Staff Manager" } }],
    [],
    BASE_CONTEXT,
    OPEN_PREFS,
  );
  assert.equal(planned.inserts[0]!.status, "passed_filters");
  assert.equal(planned.droppedCount, 0);
});

// An empty batch must not produce an insert. The applications upsert rejects an empty
// body, and a board with nothing new is the common path.
test("an empty batch produces no application rows", () => {
  const planned = planScreenedApplications([], [TITLE_RULE], BASE_CONTEXT, OPEN_PREFS);
  assert.deepEqual(planned.inserts, []);
  assert.equal(planned.passedCount, 0);
});

// --- stage 0: the tech gate, ahead of the cascade -----------------------------------

// The gate runs BEFORE the nine rules, so a non-tech posting is rejected by the cheapest
// possible test and never has its dates parsed or its blocklists consulted.
test("a posting excluded by the tech gate is dropped before the cascade runs", () => {
  const planned = planScreenedApplications(
    [{ jobId: "job-6", row: { ...BASE_ROW, title: "Enterprise Sales Executive" } }],
    [TITLE_RULE],
    BASE_CONTEXT,
    TECH_PREFS,
  );
  assert.equal(planned.inserts[0]!.status, "dropped_filter");
  // NAMES THE STAGE, not a FilterRuleType — stage 0 is deliberately outside the cascade,
  // so attributing its drop to one of the nine rules would be a lie the dashboard would
  // then repeat.
  assert.equal(planned.inserts[0]!.drop_reason, "tech_gate");
});

// A recognised technical posting passes stage 0 and goes on to be judged by the cascade,
// which is what makes the gate a filter rather than a replacement.
test("a technical posting passes the gate and is still screened by the cascade", () => {
  const planned = planScreenedApplications(
    [{ jobId: "job-7", row: { ...BASE_ROW, title: "Senior Backend Developer" } }],
    [TITLE_RULE],
    BASE_CONTEXT,
    TECH_PREFS,
  );
  // Survived stage 0 (it is a developer role) but the title blocklist still rejects it.
  assert.equal(planned.inserts[0]!.status, "dropped_filter");
  assert.equal(planned.inserts[0]!.drop_reason, "title_blocklist");
});

// FLIPPED per Teja's 2026-10-09 ruling (option (d)) amending the 2026-09-17 design: with
// titles or keywords configured, a non-match is a drop (tech_gate_unclassified); pass+warn
// only when both are empty. This test used to pin the pass+warn branch under TECH_PREFS.
// Asserted at the planner level because this is the layer that turns the verdict's code
// into the drop_reason column and the run summary's ruleType.
test("an unclassified posting under a configured gate is born dropped as tech_gate_unclassified", () => {
  const planned = planScreenedApplications(
    // Matches none of TECH_PREFS' titles or keywords, and none of its exclusions.
    [{ jobId: "job-8", row: { ...BASE_ROW, title: "Site Reliability Specialist", description_raw: null } }],
    // No cascade rules, so stage 0 is the only thing that can drop it.
    [],
    BASE_CONTEXT,
    TECH_PREFS,
  );
  // One row, recorded rather than omitted, carrying the gate's own code.
  assert.deepEqual(planned.inserts, [{ job_id: "job-8", status: "dropped_filter", drop_reason: "tech_gate_unclassified" }]);
  // The run summary attributes it to the same code, so the two can be counted together.
  assert.equal(planned.dropped.length, 1);
  // ruleType mirrors drop_reason; a mismatch would split one drop across two names.
  assert.equal(planned.dropped[0]!.ruleType, "tech_gate_unclassified");
  // Dropped, so no "passed unclassified" warning should claim otherwise.
  assert.doesNotMatch(planned.warnings.join(" "), /passed unclassified/);
});

// The surviving half of the old branch: with NOTHING configured the gate has no opinion,
// so the posting passes and the empty config is reported as a warning.
test("an unclassified posting under an empty gate passes and surfaces a warning", () => {
  const planned = planScreenedApplications(
    // Same title as above; only the preferences differ.
    [{ jobId: "job-9", row: { ...BASE_ROW, title: "Site Reliability Specialist" } }],
    // No cascade rules, so the status is stage 0's alone.
    [],
    BASE_CONTEXT,
    OPEN_PREFS,
  );
  // Passed through to the matcher.
  assert.equal(planned.inserts[0]!.status, "passed_filters");
  // The warning survives to the run summary, where an operator can see the empty config.
  assert.match(planned.warnings.join(" "), /passed unclassified/);
});

// --- single-row targeting (?application_id=) parity ---------------------------------

// The screener's targeted mode narrows the queue read to one row and then calls this
// planner with `[entry]`, exactly as the batch loop already does per row. These pin that a
// one-entry plan equals that entry's slot in a batch plan over the same context snapshot,
// i.e. the planner carries no batch-accumulated state. Parity over the pure planner because
// screener/index.ts imports jsr: and has no seam; the `?application_id=bad` -> 400 path is
// left to a live smoke test.
// The second drop used to be the weekly cap; that rule was retired 2026-11-10, so a
// company-blocklist drop (also read from the context snapshot, never the row) stands in.
test("a one-entry plan equals that entry's verdict inside a batch, including a context-driven drop", () => {
  // The blocklist comes from the loaded context (context.ts), never from the batch.
  const blockContext: ScreenContext = { ...BASE_CONTEXT, blockedCompanySlugs: new Set(["acme"]) };
  // Title blocklist first, then the company blocklist, so the two drops are attributable to different rules.
  const rules = [TITLE_RULE, rule("company_blocklist", {}, 10)];
  // One pass, one title-rule drop, one blocklist drop.
  const entries = [
    // Survives both rules.
    { jobId: "pass-1", row: BASE_ROW },
    // Dropped by the title blocklist.
    { jobId: "title-1", row: { ...BASE_ROW, fingerprint: "fp-t", title: "Senior Backend Engineer" } },
    // Dropped by the company blocklist: acme is blocked in the context snapshot.
    { jobId: "cap-1", row: { ...BASE_ROW, fingerprint: "fp-c", company_slug: "acme", company_name: "Acme" } },
  ];
  // The batch plan.
  const batch = planScreenedApplications(entries, rules, blockContext, OPEN_PREFS);
  // Sanity: the fixture really exercises a pass, a rule drop and a context-driven drop.
  assert.deepEqual(
    batch.inserts.map((i) => i.drop_reason),
    [null, "title_blocklist", "company_blocklist"],
  );
  // Each entry alone, against the same context and rules.
  for (const [index, entry] of entries.entries()) {
    // The targeted mode's call shape.
    const single = planScreenedApplications([entry], rules, blockContext, OPEN_PREFS);
    // The persisted verdict (status + drop_reason) is identical.
    assert.deepEqual(single.inserts[0], batch.inserts[index]);
    // The run-summary prose is identical too, matched by job id.
    assert.deepEqual(single.dropped, batch.dropped.filter((d) => d.jobId === entry.jobId));
  }
});

// --- stage 0b: the work-authorisation gate (Teja, 2026-10-24) ------------------------

// Teja's list as the migration seeds it: the gate is live.
const TEJA_PREFS: ScreenPreferences = { ...OPEN_PREFS, workAuthorizedCountries: ["India", "Nepal", "Bhutan"] };

// A US on-site posting is born dropped under the gate's own code, BEFORE the cascade runs: the
// title rule below would also drop it, and the gate's code winning proves the order.
test("work auth: a US on-site posting drops as work_auth ahead of the cascade", () => {
  const planned = planScreenedApplications(
    // US location, and a title the blocklist would also reject.
    [{ jobId: "us-1", row: { ...BASE_ROW, title: "Senior Backend Engineer", location_raw: "San Francisco, CA" } }],
    // The title blocklist is the cascade rule that loses the race.
    [TITLE_RULE],
    BASE_CONTEXT,
    TEJA_PREFS,
  );
  // Recorded under the gate's code, not title_blocklist.
  assert.deepEqual(planned.inserts, [{ job_id: "us-1", status: "dropped_filter", drop_reason: "work_auth" }]);
  // The run summary names the same code.
  assert.equal(planned.dropped[0]!.ruleType, "work_auth");
  // The prose quotes the location that decided it.
  assert.match(planned.dropped[0]!.reason, /San Francisco, CA/);
});

// The tech gate still runs first: a non-tech US posting is attributed to the cheaper gate.
test("work auth: the tech gate still runs first", () => {
  const planned = planScreenedApplications(
    // An excluded title on a US location: both gates object.
    [{ jobId: "us-2", row: { ...BASE_ROW, title: "Sales Engineer", location_raw: "New York, NY" } }],
    // No cascade rules; only the two gates decide.
    [],
    BASE_CONTEXT,
    // Tech config plus Teja's list.
    { ...TECH_PREFS, workAuthorizedCountries: ["India"] },
  );
  // The tech gate's code wins, because it ran first.
  assert.equal(planned.inserts[0]!.drop_reason, "tech_gate");
});

// India and US-remote postings are untouched, and go on to the cascade.
test("work auth: India and US-remote postings pass through to the cascade", () => {
  const planned = planScreenedApplications(
    // BASE_ROW is Bengaluru; the second is remote in the US, which Teja accepts.
    [{ jobId: "in-1", row: BASE_ROW }, { jobId: "us-r", row: { ...BASE_ROW, fingerprint: "fp-r", location_raw: "Remote, USA" } }],
    [TITLE_RULE],
    BASE_CONTEXT,
    TEJA_PREFS,
  );
  // Both passed.
  assert.deepEqual(planned.inserts.map((i) => i.status), ["passed_filters", "passed_filters"]);
});

// Teja's 11-04 policy reaches the gate: the same US-remote posting now drops, India still passes.
test("work auth: under unlocked_or_authorized, US-remote drops and India passes", () => {
  const planned = planScreenedApplications(
    // BASE_ROW is Bengaluru; the second is remote locked to the US.
    [{ jobId: "in-2", row: BASE_ROW }, { jobId: "us-r2", row: { ...BASE_ROW, fingerprint: "fp-r2", location_raw: "Remote, USA" } }],
    [TITLE_RULE],
    BASE_CONTEXT,
    // Teja's list with the live policy.
    { ...TEJA_PREFS, remoteLocationPolicy: "unlocked_or_authorized" },
  );
  // India passes; the locked remote row drops under the gate's code.
  assert.deepEqual(planned.inserts.map((i) => i.drop_reason), [null, "work_auth"]);
});

// Never set: nothing drops, and the open gate is reported.
test("work auth: an unset list passes a US on-site posting and warns", () => {
  const planned = planScreenedApplications(
    // A US on-site posting.
    [{ jobId: "us-3", row: { ...BASE_ROW, location_raw: "Seattle, WA" } }],
    // No cascade rules.
    [],
    BASE_CONTEXT,
    // null = never set.
    OPEN_PREFS,
  );
  // Passed, because a missing list is not "nowhere".
  assert.equal(planned.inserts[0]!.status, "passed_filters");
  // The warning names the unset column.
  assert.match(planned.warnings.join(" "), /work_authorized_countries/);
});

// --- missing description (2026-11-05) ----------------------------------------------

// THE INCIDENT: the Workday adapter declares `descriptionRaw: null` for every posting (its list
// endpoint carries none), so 5612 of 5612 Workday jobs were saved with no description. The
// screener passed 459 of them, judging the experience and JD-text work-auth stages on nothing,
// and the matcher then failed 391 as `missing_description`. That was a wasted queue slot each,
// and a sweep log that never said so. A job with no text to judge is now refused at birth.
test("a job with no description is born dropped_filter missing_description, never passed_filters", () => {
  const planned = planScreenedApplications(
    // A technical title, so the tech gate passes it and only the description can decide.
    [{ jobId: "wd-1", row: { ...BASE_ROW, title: "Software Engineer", description_raw: null } }],
    // No cascade rules: nothing else could drop it.
    [],
    BASE_CONTEXT,
    // A configured gate, so "passed the tech gate" is a real verdict and not an open gate.
    TECH_PREFS,
  );
  // Born dropped, under its own code.
  assert.deepEqual(planned.inserts, [{ job_id: "wd-1", status: "dropped_filter", drop_reason: "missing_description" }]);
  // The run summary names the same code, so the scout's log can count it.
  assert.equal(planned.dropped[0]!.ruleType, "missing_description");
  // Counters agree with the rows.
  assert.equal(planned.passedCount, 0);
});

// The shape that passes is a non-empty string after trimming. A lenient truthiness read would
// let "   " through, and an absent key (a select that lost the column) is no text either.
test("an empty, whitespace-only or absent description is blank too", () => {
  // Each blank form, built from the base row.
  const blanks: JobInsert[] = [
    // The empty string.
    { ...BASE_ROW, fingerprint: "fp-empty", description_raw: "" },
    // Whitespace only: spaces, a tab, a newline.
    { ...BASE_ROW, fingerprint: "fp-space", description_raw: " \t\n " },
    // The key missing altogether.
    (({ description_raw: _omitted, ...rest }) => ({ ...rest, fingerprint: "fp-absent" }))(BASE_ROW) as JobInsert,
  ];
  // One batch, so a per-entry bug cannot hide behind a single-entry test.
  const planned = planScreenedApplications(blanks.map((row, i) => ({ jobId: `blank-${i}`, row })), [], BASE_CONTEXT, OPEN_PREFS);
  // Every one dropped for the description.
  assert.deepEqual(planned.inserts.map((row) => row.drop_reason), ["missing_description", "missing_description", "missing_description"]);
});

// Order matters for two reasons. The tech gate is cheaper, and its code keeps the dashboard's
// title-junk count honest (3203 Workday rows were tech_gate drops). And the Workday detail
// fetch runs only for title survivors, so a title drop must never become a description drop.
test("missing description: the tech gate still runs first", () => {
  const planned = planScreenedApplications(
    // A title the gate excludes, and no description.
    [{ jobId: "wd-2", row: { ...BASE_ROW, title: "Enterprise Sales Executive", description_raw: null } }],
    [],
    BASE_CONTEXT,
    TECH_PREFS,
  );
  // The title verdict wins.
  assert.equal(planned.inserts[0]!.drop_reason, "tech_gate");
});
