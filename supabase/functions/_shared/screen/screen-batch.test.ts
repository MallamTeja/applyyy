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
import { toScreenableJob, planScreenedApplications } from "./screen-batch.ts";
// The cascade itself — the module under wiring.
import type { ScreenContext } from "../filter/cascade.ts";
// Row shapes from the schema owner.
// Stage 0, which now runs ahead of the cascade inside the planner.
import type { TechGatePreferences } from "./tech-gate.ts";
import type { FilterRuleRow, Json, JobInsert } from "../contracts/shared-types.ts";

// A fixed clock, so staleness assertions do not flake at midnight.
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

// Nothing applied to, nothing blocked, no weekly usage — so a test that wants one of
// those effects has to ask for it explicitly.
const BASE_CONTEXT: ScreenContext = {
  now: NOW,
  appliedFingerprints: new Set(),
  blockedCompanySlugs: new Set(),
  applicationsThisWeekByCompany: new Map(),
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
const OPEN_PREFS: TechGatePreferences = { titles: [], keywords: [], excludedKeywords: [] };

// A configured gate, for the stage-0 tests at the end of this file.
const TECH_PREFS: TechGatePreferences = {
  titles: ["engineer", "developer"],
  keywords: ["react"],
  excludedKeywords: ["sales", "recruiter"],
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
// degree_mismatch receive null and return drop:false for every job, WITHOUT a warning.
// They read as working rules. If a future change starts populating these columns, this
// test fails and whoever made that change learns the two rules just came alive.
test("experience and degree arrive as null because nothing populates them", () => {
  const job = toScreenableJob(BASE_ROW);
  assert.equal(job.minExperienceYears, null);
  assert.equal(job.requiresAdvancedDegree, null);
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

// THE INVERTED DEFAULT, asserted at the planner level rather than only in the gate's own
// unit tests — because this is the layer that decides whether the warning survives to
// somewhere an operator can see it.
test("an unclassified posting passes the gate and surfaces a warning", () => {
  const planned = planScreenedApplications(
    [{ jobId: "job-8", row: { ...BASE_ROW, title: "Site Reliability Specialist" } }],
    [],
    BASE_CONTEXT,
    TECH_PREFS,
  );
  assert.equal(planned.inserts[0]!.status, "passed_filters");
  assert.match(planned.warnings.join(" "), /matched no configured title or keyword/);
});
