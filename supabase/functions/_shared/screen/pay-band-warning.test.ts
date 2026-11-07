// Tests for the "Pay band UK/US only" warning (finding N2).
//
// THE RULING (Teja, 2026-11-07 10:14 IST, option C): a remote job whose pay band is listed only for
// the UK/US is NEVER dropped; the approval card shows a chip so Teja decides per row. So the
// function under test returns a warning string or null, and never touches the drop verdict.
// The JD quotes are real, from live rows read 2026-11-07 (Circuithub, Quora, Prefect = real cases;
// Canonical, Supabase, Sourcegraph = the noise that a looser rule chipped).
import { test } from "node:test";
// Strict, so null never compares equal to undefined.
import assert from "node:assert/strict";
// The unit under test, and the gate it must not change.
import { PAY_BAND_UK_US_ONLY, payBandRegionWarning, screenWorkAuth } from "./work-auth-gate.ts";

// A remote job with the given JD; "Remote" is the board text these rows carry.
const remote = (description: string | null) => ({ locationRaw: "Remote", description });

test("pay band: Circuithub's UK £ / US $ bands on a remote job carry the warning", () => {
  // The live JD line: both bands, each led by its country.
  assert.equal(payBandRegionWarning(remote("Remote anywhere, or from our offices in London or Cambridge (UK). UK £80k–£125k · US $125k–$250k")), PAY_BAND_UK_US_ONLY);
});

test("pay band: Quora's 'US based applicants ... $97,600' carries the warning", () => {
  // The place word sits a clause before the amount, inside one sentence.
  assert.equal(payBandRegionWarning(remote("US candidates only: For US based applicants, the salary range is $97,600 - $139,000 USD")), PAY_BAND_UK_US_ONLY);
});

test("pay band: Prefect's metro-area band carries the warning", () => {
  // A US city name, not a country code, leads the band.
  assert.equal(payBandRegionWarning(remote("San Francisco Bay Area & NYC Metro: $149,000–$176,000")), PAY_BAND_UK_US_ONLY);
});

test("pay band: noise is not a pay band (learning budget, funding round, global zones)", () => {
  // Canonical: a small dollar budget with no place word; it chipped 10 rows under a looser rule.
  assert.equal(payBandRegionWarning({ locationRaw: "Home based - Worldwide", description: "A personal development budget of USD 2,000 per year." }), null);
  // Supabase: funding, not pay; "M" and "B" are not salary units.
  assert.equal(payBandRegionWarning(remote("Over $1B raised, including our $500M Series F.")), null);
  // Sourcegraph: a global zone scheme names no UK/US place.
  assert.equal(payBandRegionWarning(remote("Zone 2: $148,000 USD. Zone 4: $74,000 USD.")), null);
  // Lower-case "us" is the English word, never the country.
  assert.equal(payBandRegionWarning(remote("Join us: $120,000 base for everyone, wherever you live.")), null);
  // A place word with a small perk amount: not salary-sized, so not a pay band.
  assert.equal(payBandRegionWarning(remote("Our US team gets a $500 home-office stipend.")), null);
  // Place and salary in DIFFERENT sentences: the salary is not tied to that place.
  assert.equal(payBandRegionWarning(remote("Founded in the US in 2015. Salary: $120,000 for every hire, wherever you live.")), null);
});

test("pay band: an India pay line, a non-remote job or a missing JD carries no warning", () => {
  // The JD also pays India, so the band is not UK/US ONLY.
  assert.equal(payBandRegionWarning(remote("US $125k–$250k. India: ₹40L–₹60L.")), null);
  // Not remote: the location gate already judges on-site jobs; the chip is for remote only.
  assert.equal(payBandRegionWarning({ locationRaw: "London, UK", description: "UK £80k–£125k" }), null);
  // No JD, no board text: nothing to read, nothing claimed.
  assert.equal(payBandRegionWarning(remote(null)), null);
  assert.equal(payBandRegionWarning({ locationRaw: null, description: "US $125k–$250k" }), null);
});

test("pay band: HTML in the JD is read as text, entities decoded", () => {
  // Greenhouse-style markup with the pound sign as an entity: only the decoded text has a "£80k".
  // &#163; is £; stripHtml decodes numeric references (its named list is closed, so not &pound;).
  assert.equal(payBandRegionWarning(remote("<p><strong>UK</strong> base pay: <em>&#163;80k</em></p>")), PAY_BAND_UK_US_ONLY);
});

test("pay band: the warning never changes the gate's verdict (option C, no drop)", () => {
  // Circuithub's whole case through the real gate under the live policy and countries.
  const verdict = screenWorkAuth({ title: "Software Engineer", locationRaw: "Remote", description: "UK £80k–£125k · US $125k–$250k" }, ["India", "Nepal", "Bhutan"], "unlocked_or_authorized");
  // Kept, as before this change.
  assert.equal(verdict.drop, false);
});
