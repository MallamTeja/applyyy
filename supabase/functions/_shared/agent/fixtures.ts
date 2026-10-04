// ROW BUILDERS for the agent test suites.
//
// WHY BUILDERS AND NOT LITERALS IN EACH TEST: `ApplicationRow` has 29 fields and
// `JobRow` has 33. A test that spells all of them out buries the ONE field it is
// actually about, and — worse — the next schema change breaks forty test literals at
// once, which is the pressure that makes people loosen the type instead of fixing the
// fixture. One builder per row means a new column is one edit.
//
// THE TYPES ARE STILL THE SCHEMA OWNER'S. These builders construct real `ApplicationRow`
// and `JobRow` values, so a column that changes type breaks the fixture at COMPILE time
// rather than letting a test agree with a shape production does not have. A fixture that
// declares its own loose row shape is how a suite ends up testing itself.

// The row shapes. Imported, never redefined.
import type { ApplicationRow, JobRow } from "../contracts/shared-types.ts";

// A fixed clock for every fixture, so "posted 3 days ago" is arithmetic rather than a
// test that changes behaviour at midnight.
export const FIXTURE_NOW = "2026-09-10T12:00:00.000Z";

// A claimed queue row in whatever status the caller needs.
//
// Defaults describe a freshly discovered row: nothing scored, nothing tailored, no
// findings — so any test asserting that an agent WROTE something starts from a state
// where the value is provably absent.
export function makeApplicationRow(overrides: Partial<ApplicationRow> = {}): ApplicationRow {
  return {
    // Ids are short and readable so a failed assertion names something recognisable.
    id: "app-1",
    user_id: "user-1",
    job_id: "job-1",
    // The queue position. Overridden by nearly every test.
    status: "discovered",
    // Maintained by a trigger, never by an agent.
    previous_status: null,
    status_changed_at: FIXTURE_NOW,
    // The resume pin. Null until the Tailor sets it.
    master_version: null,
    // Nothing tailored yet.
    tailored_profile: null,
    tailor_refs: null,
    tailored_hash: null,
    // Nothing selected yet.
    selected_jd_keywords: [],
    // Nothing scored yet.
    match_score: null,
    match_reasoning: null,
    // No findings yet. An EMPTY ARRAY, not null: an empty findings list is the Bucket A
    // signal, so the distinction between "clean" and "not audited" lives in `status`.
    audit_findings: [],
    ats_keyword_coverage: null,
    // Nothing rendered or screenshotted.
    resume_storage_path: null,
    screenshot_storage_path: null,
    // No terminal explanation.
    drop_reason: null,
    failure_reason: null,
    block_reason: null,
    block_detail: {},
    // Never retried.
    retry_count: 0,
    // Claimed, because these fixtures represent rows a stage has just claimed. The
    // lease values are what the sweeper would compare against.
    claimed_at: FIXTURE_NOW,
    claimed_by: "test",
    claim_expires_at: "2026-09-10T12:05:00.000Z",
    // Not yet approved or applied.
    approved_at: null,
    applied_at: null,
    // No letter yet: the CHECK keeps these two null together, and null is the queue predicate.
    cover_letter: null,
    cover_letter_generated_at: null,
    created_at: FIXTURE_NOW,
    updated_at: FIXTURE_NOW,
    // The caller's overrides win, so a test changes exactly the field it is about.
    ...overrides,
  };
}

// A posting. Defaults describe an ordinary fresh internship that would survive the
// whole cascade, so each Screener test can break exactly one thing.
export function makeJobRow(overrides: Partial<JobRow> = {}): JobRow {
  return {
    // Matches `makeApplicationRow`'s `job_id`, so the two line up without ceremony.
    id: "job-1",
    user_id: "user-1",
    // A canonical-looking digest. Tests that care about dedupe override it.
    fingerprint: "fp-clean",
    // UNTRUSTED — scraped from the board. Every test that fences input starts here.
    title: "Backend Engineering Intern",
    company_name: "Zomato",
    // Derived by the Scout, so it is trusted enough to key a blocklist on.
    company_slug: "zomato",
    // UNTRUSTED.
    location_raw: "Bengaluru, India",
    // Parsed by the Scout.
    locations: ["bangalore"],
    work_arrangement: "onsite",
    employment_type: "internship",
    // UNTRUSTED, and the single highest-risk value in the database.
    description_raw: "Build REST APIs in Node.js and Express. 0-1 years experience.",
    description_hash: "hash-1",
    // UNTRUSTED, and also the canonical submit target — which is why a LinkedIn
    // sighting can never become a submit path.
    apply_url: "https://boards.greenhouse.io/zomato/jobs/1",
    ats_provider: "greenhouse",
    ats_job_id: "1",
    discovered_via: ["greenhouse"],
    source_refs: [],
    // One day old, so the 3-day staleness rule passes with room to spare.
    posted_at: "2026-09-09T12:00:00.000Z",
    // `exact` rather than `unknown`, so a staleness test is testing staleness and not
    // the cold-start guard by accident.
    posted_at_source: "exact",
    first_seen_at: "2026-09-09T12:00:00.000Z",
    last_seen_at: FIXTURE_NOW,
    seen_count: 1,
    // Never vanished, so no repost signal.
    disappeared_at: null,
    repost_count: 0,
    // Junior-friendly, so the experience ceiling passes.
    min_experience_years: 0,
    max_experience_years: 1,
    requires_advanced_degree: false,
    // No salary data, which is the common case on ATS boards.
    salary_min: null,
    salary_max: null,
    salary_currency: null,
    raw_payload: null,
    created_at: "2026-09-09T12:00:00.000Z",
    updated_at: FIXTURE_NOW,
    // Caller's overrides win.
    ...overrides,
  };
}
