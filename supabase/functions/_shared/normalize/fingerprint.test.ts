// Table-driven tests for the dedupe primitive (PROJECT_PLAN.md §9): one posting
// reachable through Naukri, LinkedIn and Greenhouse must collapse to ONE row.
import { test } from "node:test";
// Strict assert so `2` never equals `"2"` — a fingerprint that type-coerces is a
// fingerprint that silently merges two different jobs.
import assert from "node:assert/strict";
// `.ts` extension is mandatory: Deno requires it and Node 24 accepts it, so one
// specifier serves both runtimes (see stream-2 notes).
import { canonicalJobKey, crossSourceKey, jobFingerprint, normalizeCompany } from "./fingerprint.ts";

// Every case is a pair that MUST collapse. Table-driven per §19 so adding a new
// real-world spelling is one line, not a new test function.
const SAME: ReadonlyArray<
  readonly [name: string, a: Parameters<typeof canonicalJobKey>[0], b: Parameters<typeof canonicalJobKey>[0]]
> = [
  [
    // Board casing is cosmetic; Greenhouse title-cases, Naukri upper-cases.
    "case differences",
    { company: "Zomato", title: "Backend Engineer", location: "Hyderabad" },
    { company: "zomato", title: "BACKEND ENGINEER", location: "hyderabad" },
  ],
  [
    // Indian listings carry legal suffixes on aggregators but not on the ATS.
    "company legal suffixes",
    { company: "Zomato Pvt Ltd", title: "Backend Engineer", location: "Hyderabad" },
    { company: "Zomato", title: "Backend Engineer", location: "Hyderabad" },
  ],
  [
    // "Inc." with the trailing period is the American form of the same problem.
    "company incorporation suffix with punctuation",
    { company: "Ashby, Inc.", title: "Backend Engineer", location: "Remote" },
    { company: "Ashby", title: "Backend Engineer", location: "Remote" },
  ],
  [
    // Bengaluru is the legal name, Bangalore the one every job board still uses.
    "city aliases",
    { company: "Swiggy", title: "SDE 1", location: "Bengaluru" },
    { company: "Swiggy", title: "SDE 1", location: "Bangalore" },
  ],
  [
    // Aggregators append the country; ATS boards usually do not.
    "country suffix on location",
    { company: "Swiggy", title: "SDE 1", location: "Hyderabad, India" },
    { company: "Swiggy", title: "SDE 1", location: "Hyderabad" },
  ],
  [
    // Hyphenation of "back-end" varies by whoever wrote the requisition.
    "punctuation inside the title",
    { company: "Razorpay", title: "Back-End Engineer", location: "Remote" },
    { company: "Razorpay", title: "Back End Engineer", location: "Remote" },
  ],
  [
    // Boards pad titles with the location or a bracketed tag; the role is identical.
    "parenthetical noise in the title",
    { company: "Razorpay", title: "Backend Engineer (Remote)", location: "Remote" },
    { company: "Razorpay", title: "Backend Engineer", location: "Remote" },
  ],
  [
    // Copy-paste into an aggregator routinely doubles or pads whitespace.
    "collapsed whitespace",
    { company: "Razorpay", title: "  Backend   Engineer ", location: " Remote " },
    { company: "Razorpay", title: "Backend Engineer", location: "Remote" },
  ],
  [
    // The requisition id is per-board, so including it would defeat dedupe entirely.
    "differing requisition ids",
    { company: "Zomato", title: "Backend Engineer", location: "Hyderabad", reqId: "GH-4417" },
    { company: "Zomato", title: "Backend Engineer", location: "Hyderabad", reqId: "NAU-99" },
  ],
  [
    // Remote is written a dozen ways and they all mean the same hiring slot.
    "remote spellings",
    { company: "Vercel", title: "Support Engineer", location: "Remote - India" },
    { company: "Vercel", title: "Support Engineer", location: "remote (india)" },
  ],
];

// Pairs that must stay DISTINCT — the failure mode nobody notices, because an
// over-eager fingerprint drops a real job and there is no error to see.
const DIFFERENT: ReadonlyArray<
  readonly [name: string, a: Parameters<typeof canonicalJobKey>[0], b: Parameters<typeof canonicalJobKey>[0]]
> = [
  [
    // Two genuinely different seniorities at the same company.
    "different titles",
    { company: "Zomato", title: "Backend Engineer", location: "Hyderabad" },
    { company: "Zomato", title: "Frontend Engineer", location: "Hyderabad" },
  ],
  [
    // Same role posted in two cities is two applications, not one.
    "different cities",
    { company: "Zomato", title: "Backend Engineer", location: "Hyderabad" },
    { company: "Zomato", title: "Backend Engineer", location: "Bangalore" },
  ],
  [
    // Different employers that happen to hire for the same title.
    "different companies",
    { company: "Zomato", title: "Backend Engineer", location: "Hyderabad" },
    { company: "Swiggy", title: "Backend Engineer", location: "Hyderabad" },
  ],
  [
    // "Senior" is a real distinction the Screener later filters on.
    "seniority prefix is significant",
    { company: "Zomato", title: "Senior Backend Engineer", location: "Hyderabad" },
    { company: "Zomato", title: "Backend Engineer", location: "Hyderabad" },
  ],
];

// One test per collapse case so a failure names the exact spelling that broke.
for (const [name, a, b] of SAME) {
  test(`canonicalJobKey collapses ${name}`, () => {
    // Equal keys are what makes the UNIQUE index in §9 do the deduping for us.
    assert.equal(canonicalJobKey(a), canonicalJobKey(b));
  });
}

// Same shape for the must-not-collapse half of the table.
for (const [name, a, b] of DIFFERENT) {
  test(`canonicalJobKey separates ${name}`, () => {
    // An accidental merge here silently deletes a job we should have applied to.
    assert.notEqual(canonicalJobKey(a), canonicalJobKey(b));
  });
}

// Determinism is the whole contract: the fingerprint is computed on different
// days by different agents and must still match what is already in the table.
test("canonicalJobKey is stable across calls", () => {
  // Two calls with the same input in the same process.
  const input = { company: "Zomato", title: "Backend Engineer", location: "Hyderabad" };
  assert.equal(canonicalJobKey(input), canonicalJobKey(input));
});

// A missing location must not throw — aggregators frequently omit it entirely.
test("canonicalJobKey tolerates a missing location", () => {
  // `undefined` location is a normal input, not an error case.
  const key = canonicalJobKey({ company: "Zomato", title: "Backend Engineer" });
  // It still has to produce something usable as a unique key.
  assert.ok(key.length > 0);
});

// The stored column is a fixed-width digest so the UNIQUE index stays small.
test("jobFingerprint is a 64-char sha-256 hex digest of the canonical key", async () => {
  // Same input the collapse table uses, so the two layers stay in agreement.
  const fp = await jobFingerprint({ company: "Zomato", title: "Backend Engineer", location: "Hyderabad" });
  // 64 hex chars is exactly sha-256; anything else means the algorithm changed.
  assert.match(fp, /^[0-9a-f]{64}$/);
});

// The digest must inherit the canonical key's collapsing, not undo it.
test("jobFingerprint collapses the same pairs the canonical key does", async () => {
  // Legal-suffix case, promoted through the hashing layer.
  const a = await jobFingerprint({ company: "Zomato Pvt Ltd", title: "Backend Engineer", location: "Hyderabad" });
  // The bare-company spelling of the identical posting.
  const b = await jobFingerprint({ company: "Zomato", title: "Backend Engineer", location: "Hyderabad" });
  // Equal digests are what the database's UNIQUE constraint actually sees.
  assert.equal(a, b);
});

// crossSourceKey (2026-11-10, T12): the SAME posting reached through an aggregator (Jobicy, RemoteOK, Arbeitnow) and
// through the employer's ATS. The feeds report a feed region ("Anywhere") where the ATS reports the board location
// ("Remote, Global"), so the location-bearing fingerprint never matched them: 257 live pairs on 2026-11-10.
test("crossSourceKey ignores location: one key whatever region each source reports", () => {
  // The function takes no location at all, so a Jobicy "Anywhere" and a Greenhouse "Remote, Global" cannot differ.
  assert.equal(crossSourceKey("Canonical Ltd", "Python Engineer"), crossSourceKey("Canonical", "Python Engineer"));
});

// The company and title halves fold exactly as the fingerprint does, so the two keys can never drift apart.
test("crossSourceKey folds company and a bracket-free title exactly like canonicalJobKey", () => {
  // Same posting, no brackets: the cross key is the canonical key minus its (empty) location part.
  assert.equal(`${crossSourceKey("Zomato Pvt Ltd", "BACKEND Engineer")}|`, canonicalJobKey({ company: "Zomato Pvt Ltd", title: "BACKEND Engineer" }));
});

// A false twin DROPS a real job, so bracketed qualifiers stay (measured 2026-11-10: "(New Grad 2027)", "(L3)" and
// "(Spanish speaking)" variants are different roles at Sierra, Twilio and Databricks that the fingerprint fold merges).
test("crossSourceKey keeps a bracketed qualifier: a New Grad role is not the base role's twin", () => {
  // The fingerprint's title fold strips the parenthetical; the cross key must not.
  assert.notEqual(crossSourceKey("Sierra", "Software Engineer, Agent (New Grad 2027)"), crossSourceKey("Sierra", "Software Engineer, Agent"));
});

// Seniority is a different job, as in the fingerprint.
test("crossSourceKey separates a Senior role from the base role", () => {
  // "Senior" survives the fold.
  assert.notEqual(crossSourceKey("Zomato", "Senior Backend Engineer"), crossSourceKey("Zomato", "Backend Engineer"));
});

// normalizeCompany is exported for the scout's twin lookup (company_slug is a separate, dash-joined slug).
test("normalizeCompany peels stacked legal suffixes and folds punctuation", () => {
  // "Pvt" and "Ltd" both go; the dot in "Checkout.com" becomes a space.
  assert.deepEqual([normalizeCompany("Zomato Pvt Ltd"), normalizeCompany("Checkout.com")], ["zomato", "checkout com"]);
});
