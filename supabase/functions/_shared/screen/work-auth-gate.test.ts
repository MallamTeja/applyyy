// Tests for stage 0b — the US work-authorisation gate.
//
// THE RULING THIS ENCODES (Teja, 2026-10-24 18:44 IST): "drop everything which need this us
// auth and set this option in system like yes or no". Teja is in India with no US work
// authorisation, so a posting that NEEDS it can only park on "are you authorized to work in
// the US?" later. The gate drops it at the screener instead.
//
// THE PROPERTY THESE TESTS PIN, in both directions (CLAUDE.md section 6):
//   - a positive US signal drops (location provably US-only, or US-specific requirement text);
//   - missing data never drops: an unanswered setting, an empty or placeless location with no
//     text signal, and a location that ALSO names a non-US place all keep the job.
// The phrase and location lists were measured on the live passed_filters rows (2535 jobs,
// 2026-10-24) before this file was written; each false-positive case below is a real one.
import { test } from "node:test";
// Strict, so `drop: false` never quietly compares equal to undefined.
import assert from "node:assert/strict";
// Extension-suffixed specifier so this runs under Deno and `node --test` alike.
import { screenUsWorkAuth } from "./work-auth-gate.ts";

// A job with neutral text, so each test changes only the one field it is about.
const job = (locationRaw: string | null, description: string | null = "We build developer tools.") => ({
  // The title never decides anything here; it only appears in the reason prose.
  title: "Software Engineer",
  // The field under test in the location cases.
  locationRaw,
  // The field under test in the text cases.
  description,
});

// --- the setting -------------------------------------------------------------------

// Authorised users lose nothing, even on the most US-only posting there is.
test("authorised (true): a US-only posting passes with no warning", () => {
  // Plain pass: nothing to drop and nothing to report.
  assert.deepEqual(screenUsWorkAuth(job("San Francisco, CA", "Must be a U.S. citizen."), true), { drop: false });
});

// Never answered is NOT "No": the gate opens and says so (section 6).
test("unanswered (null): a US-only posting passes, and the gate warns that it is open", () => {
  // The verdict for an unanswered setting.
  const verdict = screenUsWorkAuth(job("New York, NY"), null);
  // Not dropped.
  assert.equal(verdict.drop, false);
  // And the open gate is visible on the health page.
  assert.match("warning" in verdict ? verdict.warning : "", /us_work_authorized/);
});

// --- location: the main signal (1462 of 2535 live rows were US-only) ------------------

// The common live shapes, each of which must drop for a user who said No.
for (const location of [
  // Bare city: 327 live rows read exactly this.
  "San Francisco",
  // City + state code.
  "New York, NY",
  // City + state + country.
  "San Mateo, CA, United States",
  // US-remote is still US-only: the employer needs US work authorisation for it.
  "Remote - United States",
  // Short form.
  "Remote - US",
  // Country alone.
  "United States",
  // Several US offices, all of them in the US.
  "Seattle, WA; Austin, TX",
  // The capital, with its dotted abbreviation.
  "Washington, D.C.",
]) {
  // One named test per shape, so a failure says which one regressed.
  test(`not authorised: US-only location "${location}" drops with code us_work_auth`, () => {
    // The verdict.
    const verdict = screenUsWorkAuth(job(location), false);
    // Dropped under the gate's own code.
    assert.equal(verdict.drop && verdict.code, "us_work_auth");
  });
}

// Locations the user CAN work in, or that do not tie the job to the US, keep it.
for (const location of [
  // India.
  "Bengaluru, India",
  // Hyderabad.
  "Hyderabad",
  // Europe.
  "London, United Kingdom",
  // Worldwide remote.
  "Remote, Global",
  // Placeless remote: no country named, so no location signal.
  "Remote",
  // Placeless arrangement.
  "Hybrid",
  // US offices MIXED with a non-US one: the India office does not need US authorisation.
  "New York, NY; Bengaluru, India",
  // Mixed with a place the gate does not know: an unknown part is not proven US, so keep.
  "San Francisco; Bucharest",
  // US or Canada: Canada is a non-US option, so the job does not NEED US authorisation.
  "Remote (United States | Canada)",
  // Toronto written with ", CA": the Canada city makes it non-US despite the state-like code.
  "Toronto, CA",
]) {
  // One named test per shape.
  test(`not authorised: "${location}" with neutral text is kept`, () => {
    // Kept, with no drop code.
    assert.equal(screenUsWorkAuth(job(location), false).drop, false);
  });
}

// --- text: the secondary signal, used ONLY when the location names no place ----------

// US-specific requirement phrases from the live sample, on a placeless location.
for (const text of [
  // The commonest wording.
  "You must be authorized to work in the United States.",
  // Abbreviated country.
  "Candidates must be legally authorized to work in the U.S. without sponsorship.",
  // Citizenship.
  "U.S. citizenship is required for this role.",
  // ITAR US-person rule (muon-space, xai).
  "This role requires access to export controlled information; applicant must be a U.S. person.",
  // ITAR named.
  "Subject to ITAR.",
  // Green card.
  "Must be a US citizen or green card holder.",
  // Security clearance (databricks, openai).
  "Eligibility for a security clearance is required.",
]) {
  // Named by the phrase.
  test(`not authorised: placeless "Remote" + "${text.slice(0, 40)}…" drops`, () => {
    // The verdict.
    const verdict = screenUsWorkAuth(job("Remote", text), false);
    // Dropped under the gate's code.
    assert.equal(verdict.drop && verdict.code, "us_work_auth");
  });
}

// UNKNOWN location + no text signal = KEEP. The section-6 case the orchestrator named.
test("not authorised: empty location and no text signal is kept (missing data never drops)", () => {
  // Null location, neutral text.
  assert.equal(screenUsWorkAuth(job(null), false).drop, false);
  // Null location AND null description: still nothing to judge by.
  assert.equal(screenUsWorkAuth(job("", null), false).drop, false);
});

// An UNRECOGNISED place is still a place: its footer text never drops it (live: "Zug",
// "PL-Warsaw-Lixa C", "Ho Chi Minh City" are not in the gate's lists).
for (const location of ["Zug", "PL-Warsaw-Lixa C", "Remote, East Coast"]) {
  // One named test per shape.
  test(`not authorised: unrecognised place "${location}" + US text is kept`, () => {
    // US-citizenship text that WOULD drop a placeless "Remote" job.
    assert.equal(screenUsWorkAuth(job(location, "U.S. citizenship is required."), false).drop, false);
  });
}

// Arrangement-only locations count as placeless, so the text decides.
for (const location of ["Hybrid", "N/A", "Remote - Multiple Locations", "In-Office"]) {
  // One named test per shape.
  test(`not authorised: arrangement-only "${location}" + US text drops`, () => {
    // The text is the only signal, and it is US-specific.
    const verdict = screenUsWorkAuth(job(location, "U.S. citizenship is required."), false);
    // Dropped under the gate's code.
    assert.equal(verdict.drop && verdict.code, "us_work_auth");
  });
}

// Live false positives the phrase list must NOT fire on.
for (const [name, text] of [
  // Anthropic x51: a POSITIVE statement about sponsorship.
  ["we do sponsor visas", "Visa sponsorship: We do sponsor visas!"],
  // Graphcore x26: no-sponsorship for the UK, country-neutral wording.
  ["UK no-sponsorship", "You must have the right to work in the UK; we are unable to sponsor work visas."],
  // Cloudflare x39: an export LICENSE, not a person's status.
  ["export licence sponsorship", "Applicants who can be employed without sponsorship for an export license."],
  // Roblox x31: US boilerplate on India and remote jobs.
  ["Roblox boilerplate", "We may not be able to employ candidates who have United States work authorization related to certain U.S. visa categories."],
  // Astera: hardware clearance.
  ["mechanical clearance", "Verify mechanical fit, alignment, clearance and airflow."],
  // Singapore permanent resident.
  ["Singapore PR", "Singapore Citizen or Singapore Permanent Resident only."],
] as const) {
  // Named by the case.
  test(`not authorised: placeless "Remote" + ${name} is kept`, () => {
    // Kept: none of these says the job needs US authorisation.
    assert.equal(screenUsWorkAuth(job("Remote", text), false).drop, false);
  });
}

// Text on a NAMED non-US location never drops: the location is the stronger statement.
test("not authorised: India location + US requirement text is kept (location outranks text)", () => {
  // A Gurugram job that copied US boilerplate.
  assert.equal(screenUsWorkAuth(job("Gurugram, India", "Must be authorized to work in the United States."), false).drop, false);
});

// The reason names what matched, so a wrong drop is diagnosable from the run summary.
test("the drop reason names the matching signal", () => {
  // A location drop says it was the location.
  const byLocation = screenUsWorkAuth(job("Palo Alto, CA"), false);
  // Mentions the location text it judged.
  assert.match(byLocation.drop ? byLocation.reason : "", /Palo Alto, CA/);
  // A text drop says which phrase.
  const byText = screenUsWorkAuth(job("Remote", "Subject to ITAR."), false);
  // Mentions the phrase family.
  assert.match(byText.drop ? byText.reason : "", /itar/i);
});
