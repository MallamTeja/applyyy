// Tests for stage 0b — the work-authorisation gate.
//
// THE RULINGS THIS ENCODES (Teja, 2026-10-24):
//   18:44 IST: "drop everything which need this us auth and set this option in system".
//   19:13 IST, refining it: "i am ok with us jobs where i can work remotly, the jobs which needs
//   visa and all, like i need to do on side or hybrid with us based in us office is not ok" and
//   allowed = "indian + remote + india visa free countrys".
// So: remote anywhere is KEPT; on-site / hybrid / unstated-arrangement jobs located only in
// countries outside search_preferences.work_authorized_countries are DROPPED; a JD that
// requires US citizenship / ITAR / clearance is DROPPED even when remote. "Visa-free" means
// visa-free WORK, which for an Indian citizen is Nepal and Bhutan (treaty), hence the default.
//
// THE PROPERTY PINNED IN BOTH DIRECTIONS (CLAUDE.md section 6): only a positive signal drops.
// An unset list, an unknown place, a missing location and a remote part all keep the job.
// Every location below is a real string from the 2535 live passed_filters rows (2026-10-24),
// except the Nepal ones, which pin the default list.
import { test } from "node:test";
// Strict, so `drop: false` never quietly compares equal to undefined.
import assert from "node:assert/strict";
// Extension-suffixed specifier so this runs under Deno and `node --test` alike.
import { screenWorkAuth } from "./work-auth-gate.ts";

// Teja's list as the migration seeds it.
const TEJA = ["India", "Nepal", "Bhutan"] as const;

// A job with neutral text, so each test changes only the one field it is about.
const job = (locationRaw: string | null, description: string | null = "We build developer tools.") => ({
  // The title never decides anything here; it only appears in the reason prose.
  title: "Software Engineer",
  // The field under test in the location cases.
  locationRaw,
  // The field under test in the text cases.
  description,
});

// --- the setting ---------------------------------------------------------------------

// Never answered is NOT "nowhere": the gate opens and says so (section 6).
test("unset list (null): an on-site US posting passes, and the gate warns that it is open", () => {
  // The verdict for an unanswered setting.
  const verdict = screenWorkAuth(job("New York, NY"), null);
  // Not dropped.
  assert.equal(verdict.drop, false);
  // And the open gate is visible on the health page.
  assert.match("warning" in verdict ? verdict.warning : "", /work_authorized_countries/);
});

// A user authorised in the US loses nothing there, US-requirement text included.
test("a list containing the US keeps US on-site jobs and US-citizenship text", () => {
  // "USA" resolves through the same place table the jobs do.
  assert.equal(screenWorkAuth(job("San Francisco, CA", "Must be a U.S. citizen."), ["USA"]).drop, false);
});

// An entry the place table cannot resolve is reported, so a typo is not silently ignored.
test("an unrecognised country entry warns", () => {
  // "Indai" is a typo; India still resolves, so the gate runs and warns about the rest.
  const verdict = screenWorkAuth(job("Bengaluru"), ["India", "Indai"]);
  // Kept (Bengaluru is India).
  assert.equal(verdict.drop, false);
  // The typo is named.
  assert.match("warning" in verdict ? verdict.warning : "", /Indai/);
});

// --- location: dropped (every part is a named place outside the list, none remote) -----

// The shapes that must drop for Teja.
for (const location of [
  // Hybrid in a US office: the exact case Teja named.
  "Hybrid - New York, NY",
  // A named US city with no arrangement stated (327 live rows read exactly "San Francisco").
  "San Francisco, CA",
  // Aiven: on-site in Finland, outside the visa-free set.
  "Helsinki, Uusimaa, Finland",
  // Several cities, none authorised; "Tor" (Toronto) is not even needed to decide.
  "NYC, Sea, SF, Tor",
  // Several offices across countries, none authorised.
  "Amsterdam; Chicago; London; New York",
  // US + Canada, both outside the list.
  "United States & Canada",
  // A US city spelled with Ireland's capital (Dublin, CA): both readings are outside the list.
  "US-CA-Dublin",
]) {
  // One named test per shape, so a failure says which one regressed.
  test(`Teja: "${location}" drops with code work_auth`, () => {
    // The verdict.
    const verdict = screenWorkAuth(job(location), TEJA);
    // Dropped under the gate's own code.
    assert.equal(verdict.drop && verdict.code, "work_auth");
  });
}

// --- location: kept ---------------------------------------------------------------------

// The shapes that must keep for Teja.
for (const location of [
  // Remote in the US: Teja accepts US remote work.
  "Remote, USA",
  // Same, other spelling.
  "Remote - United States",
  // Remote in a region.
  "Remote (EMEA)",
  // India, by city alone.
  "Bengaluru",
  // India, hybrid.
  "Hybrid in Bangalore, India",
  // Nepal: visa-free work by treaty.
  "Kathmandu, Nepal",
  // Mixed: a remote alternative exists.
  "SF or Remote (US/Canada)",
  // Mixed, remote stated alongside named offices in one part.
  "NYC, Toronto, Remote",
  // Mixed: an India office is one of the options.
  "New York, NY; Bengaluru, India",
  // Unknown place: not provably outside the list (section 6).
  "Cambridge",
  // A region, not a country.
  "North America",
  // Arrangement only, no place at all.
  "Hybrid",
  // Missing.
  "",
]) {
  // One named test per shape.
  test(`Teja: "${location}" with neutral text is kept`, () => {
    // Kept, with no drop code.
    assert.equal(screenWorkAuth(job(location), TEJA).drop, false);
  });
}

// A null location is missing data, never a drop.
test("Teja: null location and null description are kept", () => {
  // Nothing to judge by.
  assert.equal(screenWorkAuth(job(null, null), TEJA).drop, false);
});

// --- text: a JD that legally needs US status drops, even when remote ---------------------

// US-specific requirement phrases from the live sample.
for (const text of [
  // The commonest wording.
  "You must be authorized to work in the United States.",
  // Citizenship.
  "U.S. citizenship is required for this role.",
  // ITAR US-person rule (muon-space, xai; the live "Legal Intern" row).
  "This role requires access to export controlled information; applicant must be a U.S. person.",
  // ITAR named.
  "Subject to ITAR.",
  // Green card.
  "Must be a US citizen or green card holder.",
  // Security clearance (databricks, openai).
  "Eligibility for a security clearance is required.",
]) {
  // Named by the phrase.
  test(`Teja: "Remote" + "${text.slice(0, 40)}…" drops`, () => {
    // The verdict on a remote job that still needs US status.
    const verdict = screenWorkAuth(job("Remote", text), TEJA);
    // Dropped under the gate's code.
    assert.equal(verdict.drop && verdict.code, "work_auth");
  });
}

// Text never overrides an authorised location: the footer is boilerplate there.
test("Teja: India location + US requirement text is kept (location outranks text)", () => {
  // Roblox copies US wording onto its Gurugram jobs.
  assert.equal(screenWorkAuth(job("Gurugram, India", "Must be authorized to work in the United States."), TEJA).drop, false);
});

// Live false positives the phrase list must NOT fire on.
for (const [name, text] of [
  // Anthropic x51: a POSITIVE statement about sponsorship.
  ["we do sponsor visas", "Visa sponsorship: We do sponsor visas!"],
  // Graphcore x26: no-sponsorship for the UK, country-neutral wording.
  ["UK no-sponsorship", "You must have the right to work in the UK; we are unable to sponsor work visas."],
  // Cloudflare x39: an export LICENSE, not a person's status.
  ["export licence sponsorship", "Applicants who can be employed without sponsorship for an export license."],
  // Roblox x31: US boilerplate.
  ["Roblox boilerplate", "We may not be able to employ candidates who have United States work authorization related to certain U.S. visa categories."],
  // Astera: hardware clearance.
  ["mechanical clearance", "Verify mechanical fit, alignment, clearance and airflow."],
  // EEO boilerplate on most Cloudflare/Cadence rows.
  ["EEO citizenship", "without regard to race, national origin, country of citizenship, or any other person's status"],
] as const) {
  // Named by the case.
  test(`Teja: "Remote" + ${name} is kept`, () => {
    // Kept: none of these says the job needs US status.
    assert.equal(screenWorkAuth(job("Remote", text), TEJA).drop, false);
  });
}

// The reason names what matched, so a wrong drop is diagnosable from the run summary.
test("the drop reason names the matching signal", () => {
  // A location drop quotes the location.
  const byLocation = screenWorkAuth(job("Palo Alto, CA"), TEJA);
  // Mentions the location text it judged.
  assert.match(byLocation.drop ? byLocation.reason : "", /Palo Alto, CA/);
  // A text drop names the phrase family.
  const byText = screenWorkAuth(job("Remote", "Subject to ITAR."), TEJA);
  // Mentions it.
  assert.match(byText.drop ? byText.reason : "", /itar/i);
});
