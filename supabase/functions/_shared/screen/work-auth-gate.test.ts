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
// SUPERSEDED IN PART (Teja, 2026-11-04 18:26 IST): "i dont need country lokced remote except
// indain remote jobs" and "i want remote jobs with no country lock too". So remote that names a
// country outside the list ("Remote - US", "Remote, EU") now DROPS under the new
// search_preferences.remote_location_policy 'unlocked_or_authorized' (the default). A bare
// "Remote" / "Anywhere" / "Remote, Global" and India remote are kept. The 10-24 behaviour (any
// remote kept) survives as policy 'any', and the tests that pinned it now run under 'any'.
// Unclear locations ("Hybrid", "In-Office", "2 Locations") stay KEPT (11-04 ruling) unless the
// JD's own "Location:" line names only places outside the list.
//
// THE PROPERTY PINNED IN BOTH DIRECTIONS (CLAUDE.md section 6): only a positive signal drops.
// An unset list, an unknown place, a missing location and a remote part all keep the job.
// Every location below is a real string from the 2535 live passed_filters rows (2026-10-24),
// except the Nepal ones, which pin the default list.
import { test } from "node:test";
// Strict, so `drop: false` never quietly compares equal to undefined.
import assert from "node:assert/strict";
// Extension-suffixed specifier so this runs under Deno and `node --test` alike.
import { screenWorkAuth, type RemoteLocationPolicy } from "./work-auth-gate.ts";

// Teja's list as the migration seeds it.
const TEJA = ["India", "Nepal", "Bhutan"] as const;
// Teja's live remote policy since 2026-11-04 (the column default): country-locked remote drops.
const UNLOCKED: RemoteLocationPolicy = "unlocked_or_authorized";
// The 2026-10-24 behaviour, still selectable in Settings: any remote is kept.
const ANY: RemoteLocationPolicy = "any";

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
  const verdict = screenWorkAuth(job("New York, NY"), null, UNLOCKED);
  // Not dropped.
  assert.equal(verdict.drop, false);
  // And the open gate is visible on the health page.
  assert.match("warning" in verdict ? verdict.warning : "", /work_authorized_countries/);
});

// A user authorised in the US loses nothing there, US-requirement text included.
test("a list containing the US keeps US on-site jobs and US-citizenship text", () => {
  // "USA" resolves through the same place table the jobs do.
  assert.equal(screenWorkAuth(job("San Francisco, CA", "Must be a U.S. citizen."), ["USA"], UNLOCKED).drop, false);
});

// An entry the place table cannot resolve is reported, so a typo is not silently ignored.
test("an unrecognised country entry warns", () => {
  // "Indai" is a typo; India still resolves, so the gate runs and warns about the rest.
  const verdict = screenWorkAuth(job("Bengaluru"), ["India", "Indai"], UNLOCKED);
  // Kept (Bengaluru is India).
  assert.equal(verdict.drop, false);
  // The typo is named.
  assert.match("warning" in verdict ? verdict.warning : "", /Indai/);
});

// A list where NOTHING resolves must not read as "authorised nowhere" (peer review, 2026-10-25:
// ["Indai"] alone dropped every on-site Indian job). The gate opens and warns, as for null.
test("a list with no recognised entry opens the gate: on-site India is kept, with a warning", () => {
  // The only entry is a typo.
  const verdict = screenWorkAuth(job("Bengaluru, India"), ["Indai"], UNLOCKED);
  // Kept: an unreadable list is missing data, never a rejection.
  assert.equal(verdict.drop, false);
  // And the open gate names the entry it could not read.
  assert.match("warning" in verdict ? verdict.warning : "", /gate open.*Indai/);
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
  // TN is ambiguous as a code, but the full state name still resolves to the US.
  "Memphis, Tennessee",
]) {
  // One named test per shape, so a failure says which one regressed.
  test(`Teja: "${location}" drops with code work_auth`, () => {
    // The verdict.
    const verdict = screenWorkAuth(job(location), TEJA, UNLOCKED);
    // Dropped under the gate's own code.
    assert.equal(verdict.drop && verdict.code, "work_auth");
  });
}

// --- location: kept ---------------------------------------------------------------------

// The 2026-10-24 remote shapes. Under policy 'any' they are still kept: Teja can switch back to
// "Any remote job" in Settings, and that choice must behave exactly as the old gate did.
for (const location of [
  // Remote in the US: Teja accepted US remote work on 10-24.
  "Remote, USA",
  // Same, other spelling.
  "Remote - United States",
  // Remote in a region.
  "Remote (EMEA)",
  // Mixed: a remote alternative exists.
  "SF or Remote (US/Canada)",
  // Mixed, remote stated alongside named offices in one part.
  "NYC, Toronto, Remote",
]) {
  // One named test per shape.
  test(`policy any: "${location}" with neutral text is kept`, () => {
    // Kept under the old behaviour.
    assert.equal(screenWorkAuth(job(location), TEJA, ANY).drop, false);
  });
  // And the same shape drops under Teja's 11-04 policy: every remote part names a place outside the list.
  test(`policy unlocked_or_authorized: "${location}" drops with code work_auth`, () => {
    // The verdict under the live default.
    const verdict = screenWorkAuth(job(location), TEJA, UNLOCKED);
    // Dropped under the gate's own code.
    assert.equal(verdict.drop && verdict.code, "work_auth");
  });
}

// The shapes that must keep for Teja.
for (const location of [
  // India, by city alone.
  "Bengaluru",
  // India, hybrid.
  "Hybrid in Bangalore, India",
  // Nepal: visa-free work by treaty.
  "Kathmandu, Nepal",
  // Mixed: an India office is one of the options.
  "New York, NY; Bengaluru, India",
  // Unknown place: not provably outside the list (section 6).
  "Cambridge",
  // Arrangement only, no place at all.
  "Hybrid",
  // Indian state codes that are also US ones: an ambiguous code alone is unknown, so kept (peer
  // review, 2026-10-25). India's own code, not Indiana.
  "Jaipur, IN",
  // Tamil Nadu, not Tennessee.
  "Coimbatore, TN",
  // Goa, not Georgia.
  "Panaji, GA",
  // Missing.
  "",
]) {
  // One named test per shape.
  test(`Teja: "${location}" with neutral text is kept`, () => {
    // Kept, with no drop code.
    assert.equal(screenWorkAuth(job(location), TEJA, UNLOCKED).drop, false);
  });
}

// A null location is missing data, never a drop.
test("Teja: null location and null description are kept", () => {
  // Nothing to judge by.
  assert.equal(screenWorkAuth(job(null, null), TEJA, UNLOCKED).drop, false);
});

// --- 2026-11-04: map gaps that leaked into the approval queue ----------------------------

// Each was measured live on 2026-11-04 18:30 IST as passing the gate it should have failed.
for (const location of [
  // Sweden listed only Stockholm (13 live rows).
  "Malmö",
  // Same city without the diacritic.
  "Malmo, Sweden",
  // No Thailand entry at all (7 live rows). Visa-free for tourists, not for work.
  "Bangkok",
  // Lower-case "sf" missed the case-sensitive \bSF\b (7 live rows).
  "sf",
  // Georgia is left out as ambiguous; the city resolves instead.
  "Alpharetta, Georgia",
  // No Chile entry (Thoughtworks).
  "Santiago, Chile",
  // No Ecuador entry (Thoughtworks, 2 rows).
  "Quito, Ecuador",
  // Regions the gate did not know: each is wholly outside India, Nepal and Bhutan.
  "EMEA",
  // A region named twice over.
  "Southern Europe",
  // Two regions, both outside the list.
  "Europe or US",
  // A region that used to be kept as unknown.
  "North America",
  // Cohere's stored location, an on-site/remote region with no remote word.
  "Middle East",
  // Tracium: arrangement says remote, the location text names only Berlin (location text decides).
  "Berlin",
]) {
  // One named test per shape.
  test(`11-04 gap: "${location}" drops with code work_auth`, () => {
    // The verdict under the live policy.
    const verdict = screenWorkAuth(job(location), TEJA, UNLOCKED);
    // Dropped under the gate's own code.
    assert.equal(verdict.drop && verdict.code, "work_auth");
  });
}

// --- 2026-11-04: remote locked to a country outside the list -----------------------------

// Live approval-queue strings that Teja ruled out on 11-04.
for (const location of [
  // The commonest lock.
  "Remote - US",
  // Two countries, both outside the list (1Password x9).
  "Remote (United States | Canada)",
  // The UK (Affirm).
  "Remote UK",
  // A region (Luma).
  "Remote, EU",
  // Several locked parts (GitLab).
  "Remote, Canada; Remote, Poland; Remote, United Kingdom",
  // A remote role pinned to a city (Supabase DevRel).
  "Remote, San Francisco, CA",
  // Remote written after the country (Harness).
  "U.S. (Remote)",
  // Two locked parts joined by "or" (slice).
  "Remote - UK or North Macedonia",
  // "Home based" is remote wording too.
  "Home based - EMEA",
]) {
  // Dropped under the live default.
  test(`unlocked_or_authorized: "${location}" drops with code work_auth`, () => {
    // The verdict.
    const verdict = screenWorkAuth(job(location), TEJA, UNLOCKED);
    // Dropped under the gate's own code.
    assert.equal(verdict.drop && verdict.code, "work_auth");
  });
  // And kept under 'any', where every remote part is kept as on 10-24.
  test(`any: "${location}" is kept`, () => {
    // Kept.
    assert.equal(screenWorkAuth(job(location), TEJA, ANY).drop, false);
  });
}

// Remote that is open to Teja: no lock, or locked to India (11-04 "i want remote jobs with no
// country lock too").
for (const location of [
  // Bare remote, the commonest open form.
  "Remote",
  // Tether's wording.
  "Remote job",
  // Canonical.
  "Anywhere",
  // Askable.
  "Worldwide Remote",
  // Supabase: "Global" is not a place, so no lock.
  "Remote, Global",
  // India-locked remote is wanted.
  "Remote - India",
  // India-locked by city.
  "Remote, Bangalore",
  // Quora: no place named.
  "Remote - Multiple Locations",
  // APAC contains India and is not a place the gate resolves, so one part stays open.
  "Home Based - Americas; Home Based - APAC; Home based - EMEA",
]) {
  // Kept under the live default.
  test(`unlocked_or_authorized: "${location}" is kept`, () => {
    // Kept, no drop code.
    assert.equal(screenWorkAuth(job(location), TEJA, UNLOCKED).drop, false);
  });
}

// The reason says which kind of lock matched, so a run summary is readable.
test("a remote-lock drop says remote in its reason", () => {
  // A locked remote row.
  const verdict = screenWorkAuth(job("Remote - US"), TEJA, UNLOCKED);
  // The prose names remote.
  assert.match(verdict.drop ? verdict.reason : "", /remote/i);
});

// --- 2026-11-04: an unclear board location falls back to the JD's own location line --------

// Live Cloudflare wording: the board says only "In-Office" or "Hybrid", the JD says where.
for (const [location, text] of [
  // Two cities, joined by ", or".
  ["In-Office", "You'll fit right in.\nAvailable Locations: Lisbon, or London (Hybrid)\nAbout the Department"],
  // A pipe between two offices.
  ["Hybrid", "<p>Position Location: Austin, TX | Lisbon, Portugal</p><p>About the Role</p>"],
  // No colon after the label.
  ["In-Office", "<p>Available Locations Austin, US</p><p>Available Terms Winter/Spring</p>"],
  // A missing board location is unclear too.
  [null, "<p>Location: London</p>"],
] as const) {
  // Dropped: the JD names only places outside the list.
  test(`JD location line: board "${location}" + "${text.slice(0, 40)}…" drops`, () => {
    // The verdict.
    const verdict = screenWorkAuth(job(location, text), TEJA, UNLOCKED);
    // Dropped under the gate's code.
    assert.equal(verdict.drop && verdict.code, "work_auth");
  });
}

// The fallback only ever drops on a positive, all-foreign line.
for (const [name, location, text] of [
  // An Indian office named in the JD.
  ["India line", "2 Locations", "<p>Location: Bengaluru, India</p>"],
  // No location line at all: unclear stays kept (Teja, 11-04).
  ["no line", "In-Office", "<p>Join our team in a fast-paced environment.</p>"],
  // A mixed line with an Indian option.
  ["mixed line", "Hybrid", "<p>Location: Austin, TX or Bangalore</p>"],
  // Bare remote is open; the JD is not read for remote.
  ["bare remote", "Remote", "<p>Location: Austin, TX</p>"],
  // A word that merely contains "location".
  ["relocation", "In-Office", "<p>Relocation: London support available</p>"],
  // A known location string is never second-guessed by the JD.
  ["board knows", "Bengaluru", "<p>Location: London</p>"],
  // Code review 2026-11-04: a labelled line that is NOT the job's location ("Headquarters location").
  ["headquarters line", "Coimbatore, TN", "<p>Headquarters location: San Francisco, CA</p><p>About the role</p>"],
  // Code review 2026-11-04: a long multi-city line with an Indian city near its end is judged whole.
  ["long line ending in India", "3 Locations", "<p>Available Locations: Austin, TX | Lisbon, Portugal | London, UK | Berlin, Germany | Amsterdam, Netherlands | Paris, France | Bengaluru, India</p>"],
  // A "line" that is really the whole JD (no breaks) is too long to be a location list: kept.
  ["run-on prose", "In-Office", `Location: London ${"we build tools for teams ".repeat(20)}`],
] as const) {
  // Kept.
  test(`JD location line: ${name} is kept`, () => {
    // No drop.
    assert.equal(screenWorkAuth(job(location, text), TEJA, UNLOCKED).drop, false);
  });
}

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
    const verdict = screenWorkAuth(job("Remote", text), TEJA, UNLOCKED);
    // Dropped under the gate's code.
    assert.equal(verdict.drop && verdict.code, "work_auth");
  });
}

// Teja's 2026-10-25 ruling ("Drop those 14"): "Remote, USA" is kept on its own, but dropped when
// the JD demands US work authorisation. Pinned as a pair so neither half can drift alone. Run
// under policy 'any', the only policy that still keeps "Remote, USA" on its own (11-04).
test("policy any: \"Remote, USA\" is kept, and dropped once the JD demands US work authorization", () => {
  // Neutral text: kept.
  assert.equal(screenWorkAuth(job("Remote, USA"), TEJA, ANY).drop, false);
  // The live wording: dropped under the gate's code.
  const verdict = screenWorkAuth(job("Remote, USA", "Must be authorized to work in the United States without sponsorship."), TEJA, ANY);
  // Dropped, code work_auth.
  assert.equal(verdict.drop && verdict.code, "work_auth");
});

// Text never overrides an authorised location: the footer is boilerplate there.
test("Teja: India location + US requirement text is kept (location outranks text)", () => {
  // Roblox copies US wording onto its Gurugram jobs.
  assert.equal(screenWorkAuth(job("Gurugram, India", "Must be authorized to work in the United States."), TEJA, UNLOCKED).drop, false);
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
    assert.equal(screenWorkAuth(job("Remote", text), TEJA, UNLOCKED).drop, false);
  });
}

// The reason names what matched, so a wrong drop is diagnosable from the run summary.
test("the drop reason names the matching signal", () => {
  // A location drop quotes the location.
  const byLocation = screenWorkAuth(job("Palo Alto, CA"), TEJA, UNLOCKED);
  // Mentions the location text it judged.
  assert.match(byLocation.drop ? byLocation.reason : "", /Palo Alto, CA/);
  // A text drop names the phrase family.
  const byText = screenWorkAuth(job("Remote", "Subject to ITAR."), TEJA, UNLOCKED);
  // Mentions it.
  assert.match(byText.drop ? byText.reason : "", /itar/i);
});

// 2026-11-05: an Indian state code that is also a US/UK one made an Indian job read as foreign.
// "Raipur, CT" (Chhattisgarh, not Connecticut), "Leh, LA" (Ladakh, not Louisiana) and "Dehradun, UK"
// (Uttarakhand, not the United Kingdom) dropped. The fix is the "known Indian city wins" rule: the
// India row now knows these cities and every state/UT name, and a part naming India is authorised.
// NOT the broader "Indian code + unknown city = unknown" rule: live data has no such Indian string,
// while it would have flipped real foreign rows to kept ("Cambridge, UK" x11, "New Haven, CT",
// "New Orleans, LA"), measured 2026-11-05. Those stay dropping below.
for (const location of ["Raipur, CT", "Leh, LA", "Dehradun, UK", "Bhilai, Chhattisgarh", "Kargil, Ladakh", "Haridwar, Uttarakhand"]) {
  // One named test per shape.
  test(`Teja: Indian "${location}" is kept, never read as US/UK`, () => {
    // Kept.
    assert.equal(screenWorkAuth(job(location), TEJA, UNLOCKED).drop, false);
  });
}

// The controls: genuine US/UK places with the same codes keep dropping.
for (const location of ["Palo Alto, CA", "Stamford, CT", "London, UK", "Cambridge, UK", "New Haven, CT", "New Orleans, LA"]) {
  // One named test per shape.
  test(`Teja: foreign "${location}" still drops`, () => {
    // Dropped for work authorisation.
    assert.equal(screenWorkAuth(job(location), TEJA, UNLOCKED).drop, true);
  });
}

// --- 2026-11-06: Gulf / Middle East rows the table lacked, and Arabic-script locations ---------

// Live leak: Scale AI 6adaddce "Kuwait City, Kuwait" passed because Kuwait had no row, so the part named
// no place and the unknown-place rule kept it. Each location below names a country the table now has,
// and none is on Teja's list (India, Nepal, Bhutan), so each must drop with the gate's own code.
for (const location of [
  // The live leak itself.
  "Kuwait City, Kuwait",
  // Bahrain: country and capital.
  "Manama, Bahrain",
  // Oman: the capital alone, without the country word.
  "Muscat",
  // Oman by name; "Roman" must not interfere (tested in the keep list below).
  "Salalah, Oman",
  // Jordan by its capital (bare "Jordan" is ambiguous with a US surname and left out on purpose).
  "Amman",
  // Lebanon.
  "Beirut, Lebanon",
  // Iraq.
  "Baghdad, Iraq",
  // Egypt: MENA, and EMEA boards list it.
  "Cairo, Egypt",
  // Turkey, in both spellings boards use.
  "Istanbul, Turkey",
  "Ankara, Türkiye",
]) {
  // One named test per location.
  test(`11-06 Gulf/ME row: "${location}" drops with code work_auth`, () => {
    // The verdict under the live policy.
    const verdict = screenWorkAuth(job(location), TEJA, UNLOCKED);
    // Dropped under the gate's own code.
    assert.equal(verdict.drop && verdict.code, "work_auth");
  });
}

// The region words now cover the new rows too: a "Remote, Middle East" or "MENA" job is wholly outside the list.
for (const location of ["Remote, Middle East", "MENA", "Kuwait or Bahrain"]) {
  // One named test per shape.
  test(`11-06 region: "${location}" drops with code work_auth`, () => {
    // The verdict.
    const verdict = screenWorkAuth(job(location), TEJA, UNLOCKED);
    // Dropped.
    assert.equal(verdict.drop && verdict.code, "work_auth");
  });
}

// Clean Arabic script, as a board writes it when it serves the Arabic page. \b is ASCII-only in JS, so
// these aliases are matched without it (a trailing "not another Arabic letter" check stands in).
for (const location of [
  // Dubai, the UAE: the first live Arabic row's clean form.
  "دبي, دبي دبي الإمارات العربية المتحدة",
  // Abu Dhabi.
  "أبوظبي",
  // Kuwait.
  "الكويت",
  // Riyadh, Saudi Arabia.
  "الرياض, المملكة العربية السعودية",
  // Doha, Qatar.
  "الدوحة, قطر",
  // Manama, Bahrain.
  "المنامة, البحرين",
  // Muscat, Oman.
  "مسقط, سلطنة عمان",
  // Cairo, Egypt.
  "القاهرة, مصر",
]) {
  // One named test per location.
  test(`11-06 Arabic: "${location}" drops with code work_auth`, () => {
    // The verdict.
    const verdict = screenWorkAuth(job(location), TEJA, UNLOCKED);
    // Dropped.
    assert.equal(verdict.drop && verdict.code, "work_auth");
  });
}

// KNOWN GAP, pinned on purpose: live row 0cccc73a stores the Arabic as UTF-8 bytes re-read as Latin-1
// (mojibake: "Ø¯Ø¨Ù, ..."). Peer 3 fixes the source (worker remote-feeds.ts); until then this
// text names no place and the unknown-place rule KEEPS the job. This test asserts that CURRENT behaviour,
// so when the source fix lands and nothing else changes, nobody mistakes "still kept" for a regression of
// the aliases above. If an alias for the mojibake form is ever added, flip this assertion to a drop.
test("11-06 KNOWN GAP: mojibake Arabic (UTF-8 read as Latin-1) is still kept as an unknown place", () => {
  // Built from the clean text, byte for byte what the live row holds.
  const mojibake = Buffer.from("دبي, دبي دبي الإمارات العربية المتحدة", "utf8").toString("latin1");
  // Positive control: this really is the garbled form, not the clean one.
  assert.notEqual(mojibake, "دبي, دبي دبي الإمارات العربية المتحدة");
  // Kept today.
  const verdict = screenWorkAuth(job(mojibake), TEJA, UNLOCKED);
  assert.equal(verdict.drop, false);
  // And kept for the RIGHT reason: the verdict is identical to that of a string naming no place at all
  // (the unknown-place path), so this is "no place found", not an accidental authorised match.
  assert.deepEqual(verdict, screenWorkAuth(job("Nowhere in particular"), TEJA, UNLOCKED));
});

// Negative set: the new aliases must not eat words or places that are fine.
for (const location of [
  // "Roman" contains "oman" but not at a word start. NO authorised place in the string: were "oman" to
  // match, this would DROP (Oman is outside the list), so keeping proves the word boundary holds.
  "Roman Forum Road",
  // A listed country alongside a new one is authorised by the list part.
  "Bengaluru, India",
  // Arabic letters inside a longer word: "مصرف" (bank) starts with the Egypt alias "مصر". Again no authorised
  // place: an over-match would drop it.
  "مصرف الراجحي",
  // The alias followed by a letter OUTSIDE U+0621-U+064A (alef wasla U+0671): still a longer word, not Egypt.
  "مصرٱ الجديدة",
]) {
  // One named test per location.
  test(`11-06 keeps "${location}" (new aliases do not over-match)`, () => {
    // The verdict.
    assert.equal(screenWorkAuth(job(location), TEJA, UNLOCKED).drop, false);
  });
}
