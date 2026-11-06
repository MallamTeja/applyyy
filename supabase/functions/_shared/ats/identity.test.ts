// Tests for the board-identity comparator — the guard against the fail-open found
// 2026-10-23: greenhouse token 'tcs' answers 200 with 92 postings that belong to
// Thornbury Community Services, not Tata Consultancy Services. A wrong token must
// FAIL this comparison; an alternate spelling of the right company must PASS it.
// (CLAUDE.md §6: a guard that fires on healthy boards is worse than none, so the
// lenient-match cases here are as load-bearing as the mismatch case.)

// node:test runner — this tree runs `node --test "supabase/functions/**/*.test.ts"`.
import { test } from "node:test";
// Bare asserts, matching the style of the sibling adapter tests.
import assert from "node:assert/strict";
// The units under test: pure string comparison plus the per-board verdict function.
import { companyIdentityMatches, evaluateBoardIdentity } from "./identity.ts";
// The real adapters: the verdict function is only as good as what each adapter can
// actually read out of its provider's payload, so these tests run against them.
import { greenhouseAdapter } from "./greenhouse.ts";
import { leverAdapter } from "./lever.ts";
import { ashbyAdapter } from "./ashby.ts";
// Workable lives beside the aggregators. It declares a real identity read, and until
// this file imported it that read had no test (7501a95 said so).
import { workableAdapter } from "../scout/adapters/workable.ts";

// The real incident: the watchlist row says Tata, the board says Thornbury. The only
// shared token is the generic word "Services", which must not be enough to pass.
test("a board whose reported identity names a different company does not match", () => {
  assert.equal(companyIdentityMatches("Tata Consultancy Services", "Thornbury Community Services"), false);
});

// Identical spelling is the trivial happy path.
test("an identical company name matches", () => {
  assert.equal(companyIdentityMatches("DoorDash", "DoorDash"), true);
});

// Case and legal-suffix punctuation are presentation, not identity.
test("case and legal-suffix differences still match", () => {
  assert.equal(companyIdentityMatches("DoorDash", "doordash, Inc."), true);
});

// A geographic qualifier on one side is the brief's named must-pass variant.
test("a geographic qualifier variant still matches", () => {
  assert.equal(companyIdentityMatches("DoorDash", "DoorDash USA"), true);
});

// A corporate-entity qualifier ("Labs") is the same leniency in the other direction.
test("a corporate qualifier variant still matches", () => {
  assert.equal(companyIdentityMatches("Notion", "Notion Labs"), true);
});

// Spacing-only drift ("Door Dash" vs "DoorDash") is a rendering choice, not a
// different company — the joined forms are equal.
test("a spacing-only difference still matches", () => {
  assert.equal(companyIdentityMatches("Door Dash", "DoorDash"), true);
});

// Substring-inside-a-token must NOT count: "Ramp" appears inside "Grampian", and a
// substring comparator would wave the wrong company through.
test("a name embedded inside another token does not match", () => {
  assert.equal(companyIdentityMatches("Ramp", "Grampian Health"), false);
});

// Sharing one generic word is not identity — neither token set contains the other.
test("a single shared generic token does not match", () => {
  assert.equal(companyIdentityMatches("Sigma Computing", "Sierra Computing"), false);
});

// A blank reported name carries no evidence of identity, so it cannot match. The
// CALLER distinguishes "provider sent nothing" (skip the check) from "provider sent
// blank garbage" (this case); the comparator itself never passes on no evidence.
test("a blank reported identity does not match", () => {
  assert.equal(companyIdentityMatches("DoorDash", "   "), false);
});

// Symmetry: the lenient containment must work whichever side is longer, because the
// watchlist spelling may be the qualified one ("DoorDash USA" row, "DoorDash" board).
test("containment is symmetric across watchlist and reported sides", () => {
  assert.equal(companyIdentityMatches("DoorDash USA", "DoorDash"), true);
});

// --- evaluateBoardIdentity: the per-board verdict the scout acts on ---------------

// A greenhouse payload as the live API ships it (probed 2026-10-24): each job entry
// carries `company_name`, so identity arrives FREE with the jobs fetch.
function greenhousePayload(companyName: string) {
  return {
    // One listed job is enough — the verdict reads identity, not postings.
    jobs: [
      {
        id: 4567890,
        title: "Healthcare Assistant",
        updated_at: "2026-10-01T08:00:00-04:00",
        location: { name: "Bristol, UK" },
        absolute_url: "https://boards.greenhouse.io/tcs/jobs/4567890",
        content: "&lt;p&gt;Role.&lt;/p&gt;",
        // The identity field the guard exists to read.
        company_name: companyName,
      },
    ],
  };
}

// THE INCIDENT, END TO END: watchlist row says Tata, board payload says Thornbury.
// The verdict must be mismatch — the scout treats mismatch as a failed board and
// persists nothing from it. This is the brief's first named gate.
test("a board whose reported identity names a different company persists nothing", () => {
  const verdict = evaluateBoardIdentity(greenhouseAdapter, greenhousePayload("Thornbury Community Services"), "Tata Consultancy Services");
  assert.deepEqual(verdict, { verdict: "mismatch", reported: "Thornbury Community Services" });
});

// The brief's second named gate: leniency on healthy boards. A qualifier the board
// adds to its own name must not take the board down.
test("minor name variants still pass", () => {
  const verdict = evaluateBoardIdentity(greenhouseAdapter, greenhousePayload("DoorDash USA"), "DoorDash");
  assert.deepEqual(verdict, { verdict: "match", reported: "DoorDash USA" });
});

// Lever's postings API carries NO company-name field (live probe 2026-10-24
// enumerated every posting key). The honest verdict is no_signal — never a fake
// match, never a mismatch that would fail every healthy lever board.
test("a lever payload yields no identity signal", () => {
  // The minimal lever shape: a top-level array of postings.
  const payload = [{ id: "a1b2c3d4", text: "Engineer, Spotify", hostedUrl: "https://jobs.lever.co/spotify/a1b2c3d4", applyUrl: "https://jobs.lever.co/spotify/a1b2c3d4/apply" }];
  const verdict = evaluateBoardIdentity(leverAdapter, payload, "Spotify");
  assert.equal(verdict.verdict, "no_signal");
});

// Ashby's posting API is the same story: top-level keys are only `jobs` and
// `apiVersion` (live probe 2026-10-24), so no identity check is possible.
test("an ashby payload yields no identity signal", () => {
  // The minimal ashby shape: an object envelope with a jobs array.
  const payload = { apiVersion: "1", jobs: [{ id: "ash-1", title: "Engineer", isListed: true, jobUrl: "https://jobs.ashbyhq.com/notion/ash-1", applyUrl: "https://jobs.ashbyhq.com/notion/ash-1/application" }] };
  const verdict = evaluateBoardIdentity(ashbyAdapter, payload, "Notion");
  assert.equal(verdict.verdict, "no_signal");
});

// An empty greenhouse board has no job entries to read identity from. That is
// no_signal, not mismatch: there is also nothing to persist, so nothing is at risk,
// and failing the board would punish a quiet hiring quarter (CLAUDE.md §6).
test("an empty greenhouse board yields no identity signal", () => {
  const verdict = evaluateBoardIdentity(greenhouseAdapter, { jobs: [] }, "DoorDash");
  assert.equal(verdict.verdict, "no_signal");
});

// --- workable: identity arrives with the postings ------------------------------------

// The SmartRecruiters adapter and its three identity tests were deleted on 2026-11-06 (SR
// is fully off by the 2026-11-01 robots ruling). The one thing they pinned that no other
// test does is the legal suffix "LIMITED" being presentation, not identity: the live
// PhonePe watchlist row vs SR's "PHONEPE LIMITED". Indian boards on any provider report
// that suffix, so the comparator rule stays pinned here without the adapter.
test("an upper-case LIMITED legal-entity name matches the plain watchlist name", () => {
  // The real pair seen 2026-10-24; a mismatch here would fail a healthy board.
  assert.equal(companyIdentityMatches("PhonePe", "PHONEPE LIMITED"), true);
});

// Workable's widget endpoint names the account at the top level beside `jobs`
// (probed 2026-10-24: account 'printful' -> "Printful").
test("a workable board reporting its own name matches", () => {
  const verdict = evaluateBoardIdentity(workableAdapter, { name: "Printful", jobs: [] }, "Printful");
  assert.deepEqual(verdict, { verdict: "match", reported: "Printful" });
});

// And bites when the account belongs to someone else.
test("a workable board reporting a different company is a mismatch", () => {
  const verdict = evaluateBoardIdentity(workableAdapter, { name: "Thornbury Community Services", jobs: [] }, "Printful");
  assert.deepEqual(verdict, { verdict: "mismatch", reported: "Thornbury Community Services" });
});
