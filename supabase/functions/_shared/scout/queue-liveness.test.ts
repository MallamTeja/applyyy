// Tests for the queue liveness check: a posting Teja is about to approve, or has approved, is
// confirmed closed EARLY, so he never approves or applies to a dead job (2026-11-07, orchestrator
// brief after the 10:50 IST sweep found Thoughtworks 98c4d344 closed while awaiting approval).
// THE RULE (CLAUDE.md §6): closed = absent from a complete 200 listing AND an explicit "gone" from
// the provider's own posting endpoint (a 404, or Workday's canApply:false). A timeout, a 403, a 5xx,
// a robots refusal or an odd body is "unknown", never "closed".
import { test } from "node:test";
// Strict, so a missing field never compares equal.
import assert from "node:assert/strict";
// The unit under test.
import { checkPosting, postingCheckUrl, queueCandidates, QUEUE_LIVENESS_CAP, type QueueSnapshotJob } from "./queue-liveness.ts";
// The transport's real error types, so the doubles fail the way fetchBoard does (it THROWS).
import { BotProtectionError, HttpError, NetworkError, RobotsDisallowedError } from "../http/errors.ts";
// The real robots-gated GET, for the robots test.
import { fetchBoard } from "../../scout-ats/poll-fetch.ts";

// A Greenhouse row as the board snapshot reads it.
function ghJob(over: Partial<QueueSnapshotJob> = {}): QueueSnapshotJob {
  return {
    // Ids and identity.
    id: "job-1",
    fingerprint: "fp-1",
    disappeared_at: null,
    // The posting's own id on its board.
    ats_job_id: "8280700",
    apply_url: "https://www.thoughtworks.com/careers/jobs/8280700?gh_jid=8280700",
    // One application, in the approval queue.
    applications: [{ id: "app-1", status: "awaiting_approval" }],
    ...over,
  };
}

// A GET that throws the transport's HttpError for one status.
const status = (code: number) => async (url: string): Promise<Response | null> => { throw new HttpError(url, code, "", 1); };
// A GET that answers 200 with the given JSON.
const ok = (body: unknown) => async (): Promise<Response | null> => new Response(JSON.stringify(body), { status: 200 });

test("queue liveness: only queue rows absent from the listing and not already marked are candidates", () => {
  // Four rows on one board.
  const rows = [
    // Absent, in the queue, not marked: the one candidate.
    ghJob(),
    // Still listed: alive by the listing itself.
    ghJob({ id: "job-2", fingerprint: "fp-2" }),
    // Absent but not in the queue (a scored row): the 14-day path handles it, no extra request.
    ghJob({ id: "job-3", fingerprint: "fp-3", applications: [{ id: "app-3", status: "scored" }] }),
    // Absent and in the queue, but the planner already marked it this poll.
    ghJob({ id: "job-4", fingerprint: "fp-4" }),
  ];
  // fp-2 is on the board; job-4 was marked by planDisappearances.
  assert.deepEqual(queueCandidates(rows, ["fp-2"], ["job-4"]).map((job) => job.id), ["job-1"]);
  // An already-gone row is never a candidate.
  assert.deepEqual(queueCandidates([ghJob({ disappeared_at: "2026-11-01T00:00:00Z" })], [], []), []);
});

test("queue liveness: the posting endpoint per provider, refusing ids of the wrong shape", () => {
  // Greenhouse: the board's own job endpoint, numeric id only.
  assert.equal(postingCheckUrl("greenhouse", "thoughtworks", ghJob()), "https://boards-api.greenhouse.io/v1/boards/thoughtworks/jobs/8280700");
  // A non-numeric Greenhouse id could point anywhere on the API: refused.
  assert.equal(postingCheckUrl("greenhouse", "thoughtworks", ghJob({ ats_job_id: "../../x" })), null);
  // Lever: the postings endpoint, uuid only.
  assert.equal(postingCheckUrl("lever", "netomi", ghJob({ ats_job_id: "ffe81537-5d1b-437e-a5e8-43546aa8c655" })), "https://api.lever.co/v0/postings/netomi/ffe81537-5d1b-437e-a5e8-43546aa8c655");
  // Workday: the detail endpoint, from the apply link.
  assert.equal(
    postingCheckUrl("workday", "wf.wd1/WellsFargoJobs", ghJob({ apply_url: "https://wf.wd1.myworkdayjobs.com/WellsFargoJobs/job/Bengaluru-India/Intern_R-557386" })),
    "https://wf.wd1.myworkdayjobs.com/wday/cxs/wf/WellsFargoJobs/job/Bengaluru-India/Intern_R-557386",
  );
  // Ashby has no per-posting endpoint: the board listing itself, the adapter's own URL.
  assert.equal(postingCheckUrl("ashby", "cursor", ghJob({ ats_job_id: "166c3951-1d2a-4e61-b79b-bedefe96073b" })), "https://api.ashbyhq.com/posting-api/job-board/cursor");
  // A non-uuid Ashby id cannot be matched against the listing: no check.
  assert.equal(postingCheckUrl("ashby", "cursor", ghJob({ ats_job_id: "8280700" })), null);
});

test("queue liveness: an explicit 404 or Workday canApply:false is closed; 200 is open", async () => {
  // The Thoughtworks case: the job endpoint says 404.
  assert.equal(await checkPosting(status(404), "greenhouse", "https://x/jobs/1", null), "closed");
  // A live posting.
  assert.equal(await checkPosting(ok({ id: 1, title: "SDE" }), "greenhouse", "https://x/jobs/1", null), "open");
  // Workday's own flag.
  assert.equal(await checkPosting(ok({ jobPostingInfo: { canApply: false } }), "workday", "https://x", null), "closed");
  // Workday open.
  assert.equal(await checkPosting(ok({ jobPostingInfo: { canApply: true } }), "workday", "https://x", null), "open");
});

test("queue liveness: every other failure is unknown, never closed (CLAUDE.md §6)", async () => {
  // FIS answered 403 for a closed posting, and a WAF answers 403 for a live one: not evidence.
  assert.equal(await checkPosting(status(403), "workday", "https://x", null), "unknown");
  // A server error.
  assert.equal(await checkPosting(status(503), "greenhouse", "https://x", null), "unknown");
  // A bot challenge, even on a 404, is the site refusing us, not the posting closing.
  assert.equal(await checkPosting(async (url) => { throw new BotProtectionError(url, 404, "", 1); }, "greenhouse", "https://x"), "unknown");
  // A network drop or timeout.
  assert.equal(await checkPosting(async (url) => { throw new NetworkError(url, 1, new Error("timeout")); }, "lever", "https://x"), "unknown");
  // A robots refusal.
  assert.equal(await checkPosting(async (url) => { throw new RobotsDisallowedError(url, "refuse", "disallow", null); }, "lever", "https://x"), "unknown");
  // No response at all.
  assert.equal(await checkPosting(async () => null, "lever", "https://x", null), "unknown");
  // Workday 200 with no flag, or a soft-200 HTML page: unknown, never closed.
  assert.equal(await checkPosting(ok({ jobPostingInfo: {} }), "workday", "https://x", null), "unknown");
  assert.equal(await checkPosting(async () => new Response("<html>Sign in</html>", { status: 200 }), "workday", "https://x", null), "unknown");
});

test("queue liveness: a robots-disallowed posting endpoint is never requested", async () => {
  // Every URL the transport asked for.
  const requested: string[] = [];
  // The real global, restored after.
  const realFetch = globalThis.fetch;
  // robots.txt disallows everything; any other request is the bug.
  globalThis.fetch = (async (input: string | URL | Request) => {
    // The URL, whatever form the transport passed.
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    // Recorded.
    requested.push(url);
    // A published Disallow.
    if (url.endsWith("/robots.txt")) return new Response("User-agent: *\nDisallow: /\n", { status: 200, headers: { "content-type": "text/plain" } });
    // Reaching the posting is the bug: and a 404 here would wrongly read as closed.
    return new Response("gone", { status: 404 });
  }) as typeof fetch;
  try {
    // The production GET with a private robots cache.
    const verdict = await checkPosting((url) => fetchBoard(url, new Map()), "greenhouse", "https://boards-api.greenhouse.io/v1/boards/x/jobs/1", null);
    // Refused, so unknown.
    assert.equal(verdict, "unknown");
    // Only robots.txt was read, and it really was read.
    assert.deepEqual(requested.filter((url) => !url.endsWith("/robots.txt")), []);
    assert.ok(requested.some((url) => url.endsWith("/robots.txt")));
  } finally {
    // Never leak the stub.
    globalThis.fetch = realFetch;
  }
});

test("queue liveness: the per-run cap is small and positive", () => {
  // A whole queue fits (21 rows on 2026-11-07), and a board-wide burst cannot happen.
  assert.ok(QUEUE_LIVENESS_CAP >= 10 && QUEUE_LIVENESS_CAP <= 50);
});

// ---- Ashby (2026-11-07): no per-posting endpoint, so the proof is a SECOND, independent read of the
// whole board, matched on the raw jobs[].id. Independent of the poll's parse: the adapter skips
// entries (no title, unlisted), and a skipped entry would otherwise look "absent".
const CURSOR_ID = "166c3951-1d2a-4e61-b79b-bedefe96073b";

test("queue liveness, Ashby: absent from a complete, well-formed listing is closed; present is open", async () => {
  // The board still holds two other postings, not this one.
  assert.equal(await checkPosting(ok({ jobs: [{ id: "aaaaaaaa-0000-0000-0000-000000000001" }, { id: "aaaaaaaa-0000-0000-0000-000000000002" }] }), "ashby", "https://x", CURSOR_ID), "closed");
  // Present, even unlisted: the posting exists, so it is not closed.
  assert.equal(await checkPosting(ok({ jobs: [{ id: CURSOR_ID, isListed: false }] }), "ashby", "https://x", CURSOR_ID), "open");
});

test("queue liveness, Ashby: an empty, malformed or missing listing is unknown, never closed", async () => {
  // An empty board is what a truncated or broken answer looks like: never evidence.
  assert.equal(await checkPosting(ok({ jobs: [] }), "ashby", "https://x", CURSOR_ID), "unknown");
  // No jobs array.
  assert.equal(await checkPosting(ok({ apiVersion: "1" }), "ashby", "https://x", CURSOR_ID), "unknown");
  // One entry without a string id: the listing cannot be trusted to be complete.
  assert.equal(await checkPosting(ok({ jobs: [{ id: "aaaaaaaa-0000-0000-0000-000000000001" }, { title: "no id" }] }), "ashby", "https://x", CURSOR_ID), "unknown");
  // A 404 for the BOARD says the board moved, not that this posting closed.
  assert.equal(await checkPosting(status(404), "ashby", "https://x", CURSOR_ID), "unknown");
  // No id to look for.
  assert.equal(await checkPosting(ok({ jobs: [{ id: "aaaaaaaa-0000-0000-0000-000000000001" }] }), "ashby", "https://x", null), "unknown");
});
