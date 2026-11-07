// Tests for feed liveness: an in-flight row with NO ATS (a remote-feed mirror like Arbeitnow or
// Jobicy, or a pasted/manual page like EA or L&T) is retired when its own posting page says gone,
// so a dead posting never reaches approval or the bot (2026-11-07, orchestrator brief, peer 2).
// THE RULE (CLAUDE.md §6): only an explicit 404 or 410 from the posting page is "closed". A 200, a
// 403, a 5xx, a bot challenge, a robots refusal or a network drop changes nothing. The feeds fetch
// only their ~100 newest rows, so absence from a feed is never evidence and is not used.
import { test } from "node:test";
// Strict, so a missing field never compares equal.
import assert from "node:assert/strict";
// The unit under test.
import { checkPage, feedCandidates, feedApplicationIds, probeFeedRows, FEED_LIVENESS_CAP, type FeedLivenessRow } from "./feed-liveness.ts";
// The transport's real error types, so the doubles fail the way httpFetch does (it THROWS).
import { BotProtectionError, HttpError, NetworkError, RobotsDisallowedError } from "../http/errors.ts";

// One in-flight feed row as the scout selects it; tests override what they exercise.
function row(over: Partial<FeedLivenessRow> = {}): FeedLivenessRow {
  return {
    // The job to mark.
    id: "job-1",
    // A real live shape: the Tether Arbeitnow mirror (04d5c6e4).
    apply_url: "https://www.arbeitnow.co.uk/jobs/companies/tether/ai-engineer-376995",
    // Live in storage.
    disappeared_at: null,
    // Approved, the case that matters most: the bot would submit it.
    applications: [{ id: "app-1", status: "approved" }],
    // The test's own fields win.
    ...over,
  };
}

// A get that throws the transport's typed HttpError for this status, as httpFetch does on non-2xx.
const status = (code: number) => async (url: string): Promise<Response | null> => {
  // The real error type, so checkPage's instanceof branch is the one production runs.
  throw new HttpError(url, code, "", 1);
};
// A get that answers 200 with an HTML body.
const ok = async (): Promise<Response | null> => new Response("<html>a posting</html>", { status: 200 });

test("checkPage: only an explicit 404 or 410 is closed", async () => {
  // Jobicy, EA and Revature answered 404 for a bogus id on 2026-11-07.
  assert.equal(await checkPage(status(404), "https://jobicy.com/jobs/1"), "closed");
  // Arbeitnow answered 410 Gone for a bogus id on 2026-11-07.
  assert.equal(await checkPage(status(410), "https://www.arbeitnow.co.uk/jobs/x"), "closed");
  // A page that loads is open.
  assert.equal(await checkPage(ok, "https://jobicy.com/jobs/1"), "open");
});

test("checkPage: every other failure is unknown, never closed (CLAUDE.md §6)", async () => {
  // A WAF answers 403 for live postings too.
  assert.equal(await checkPage(status(403), "https://x/jobs/1"), "unknown");
  // A server error says nothing about the posting.
  assert.equal(await checkPage(status(503), "https://x/jobs/1"), "unknown");
  // A bot challenge carrying a 404 is the site refusing us, not the posting closing.
  assert.equal(await checkPage(async (u) => { throw new BotProtectionError(u, 404, "", 1); }, "https://x"), "unknown");
  // robots.txt said no: the posting was never asked about.
  assert.equal(await checkPage(async (u) => { throw new RobotsDisallowedError(u, "refuse", "Disallow: /jobs", "robots-txt"); }, "https://x"), "unknown");
  // A network drop.
  assert.equal(await checkPage(async (u) => { throw new NetworkError(u, 1, new Error("reset")); }, "https://x"), "unknown");
  // A null response (only under a notFound override this caller does not use).
  assert.equal(await checkPage(async () => null, "https://x"), "unknown");
});

test("feedCandidates: live, http(s), with an in-flight application only", () => {
  // The base row qualifies.
  assert.deepEqual(feedCandidates([row()]).map((r) => r.id), ["job-1"]);
  // Already retired: never re-probed.
  assert.deepEqual(feedCandidates([row({ disappeared_at: "2026-11-01T00:00:00Z" })]), []);
  // No link to read.
  assert.deepEqual(feedCandidates([row({ apply_url: null })]), []);
  // Not an http(s) link: never fetched.
  assert.deepEqual(feedCandidates([row({ apply_url: "javascript:alert(1)" })]), []);
  // Applied or dropped rows are done; probing them buys nothing.
  assert.deepEqual(feedCandidates([row({ applications: [{ id: "a", status: "applied" }] })]), []);
  // A row whose select lost the applications is not a candidate (fails closed to "no probe").
  assert.deepEqual(feedCandidates([row({ applications: null })]), []);
  // Every in-flight status from passed_filters to approved qualifies.
  for (const s of ["passed_filters", "scored", "tailored", "audit_clean", "audit_flagged", "awaiting_approval", "approved"]) {
    // One assertion per status, so a dropped status names itself.
    assert.equal(feedCandidates([row({ applications: [{ id: "a", status: s }] })]).length, 1, s);
  }
});

test("feedApplicationIds: only the in-flight applications get a reason event", () => {
  // The applied one is history; the approved one is what the note explains.
  assert.deepEqual(feedApplicationIds(row({ applications: [{ id: "a", status: "applied" }, { id: "b", status: "approved" }] })), ["b"]);
});

test("probeFeedRows: a SINGLE-row host that answers 404 is retired (EA, L&T, Revature, MongoDB)", async () => {
  // EA 3f87ad01 is the only row on jobs.ea.com; the restructure guard must not swallow it.
  const ea = row({ id: "ea", apply_url: "https://jobs.ea.com/en_US/careers/JobDetail/Data-Science-Intern/215937" });
  // Its page is gone.
  const result = await probeFeedRows([ea], status(404), FEED_LIVENESS_CAP);
  // Retired.
  assert.deepEqual(result.closedIds, ["ea"]);
});

test("probeFeedRows: a host where EVERY one of >= 2 rows 404s is unknown (site restructure guard)", async () => {
  // Two Jobicy rows both 404: a moved URL scheme looks exactly like this, so neither is retired.
  const rows = [row({ id: "j1", apply_url: "https://jobicy.com/jobs/1-a" }), row({ id: "j2", apply_url: "https://jobicy.com/jobs/2-b" })];
  // Both gone.
  const result = await probeFeedRows(rows, status(404), FEED_LIVENESS_CAP);
  // Nothing retired.
  assert.deepEqual(result.closedIds, []);
  // But the refusal is reported, so it is visible on the run row.
  assert.deepEqual(result.refusedHosts, ["jobicy.com"]);
});

test("probeFeedRows: a multi-row host with one 404 and one 200 retires only the 404", async () => {
  // One closed posting among live ones is the normal case.
  const rows = [row({ id: "gone", apply_url: "https://jobicy.com/jobs/1-a" }), row({ id: "live", apply_url: "https://jobicy.com/jobs/2-b" })];
  // The first 404s, the second loads.
  const get = async (url: string) => (url.endsWith("1-a") ? status(404)(url) : ok());
  // Only the dead one.
  assert.deepEqual((await probeFeedRows(rows, get, FEED_LIVENESS_CAP)).closedIds, ["gone"]);
});

test("probeFeedRows: an unknown answer keeps a multi-row host out of the all-404 guard's reach", async () => {
  // One 404 and one 403: not every probe said gone, so the 404 stands.
  const rows = [row({ id: "gone", apply_url: "https://x.test/jobs/1" }), row({ id: "waf", apply_url: "https://x.test/jobs/2" })];
  // 404 then 403.
  const get = async (url: string) => (url.endsWith("/1") ? status(404)(url) : status(403)(url));
  // The 404 is retired; the 403 is not.
  assert.deepEqual((await probeFeedRows(rows, get, FEED_LIVENESS_CAP)).closedIds, ["gone"]);
});

test("probeFeedRows: the cap bounds requests per run", async () => {
  // Count every request the probe makes.
  let calls = 0;
  // Three rows, a cap of two.
  const rows = [row({ id: "a", apply_url: "https://a.test/1" }), row({ id: "b", apply_url: "https://b.test/1" }), row({ id: "c", apply_url: "https://c.test/1" })];
  // Each request counted, all live.
  const result = await probeFeedRows(rows, async () => { calls += 1; return ok(); }, 2);
  // Two requests, two probed.
  assert.equal(calls, 2);
  // Reported, so a run that hit the cap says so.
  assert.equal(result.probed, 2);
});
