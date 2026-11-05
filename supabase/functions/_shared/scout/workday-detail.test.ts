// Tests for the Workday detail read: the step that gives a new, title-passing Workday posting
// the description its list endpoint never carries (2026-11-05, Teja: "fetch for title-passing
// jobs"). Without it, 5612 of 5612 Workday jobs had no description and none was ever scored.
import { test } from "node:test";
// Strict, so a missing field never quietly compares equal to null.
import assert from "node:assert/strict";
// The unit under test and its run state.
import { fillWorkdayDescriptions, newWorkdayDetailRun, WORKDAY_DETAIL_PAUSE_MS, type WorkdayDetailDeps } from "./workday-detail.ts";
// The real robots-gated GET scout-ats uses, for the robots test.
import { fetchBoard } from "../../scout-ats/poll-fetch.ts";
// Row shape from the schema owner.
import type { JobInsert } from "../contracts/shared-types.ts";

// A new Workday row as the scout builds it: apply link from the adapter, no description.
function workdayRow(title: string, slug = "R-1"): JobInsert {
  return {
    // Unique per row, so a batch can hold several.
    fingerprint: `fp-${slug}`,
    // The title the gate judges.
    title,
    // Untouched by the detail read.
    company_name: "Mastercard",
    company_slug: "mastercard",
    location_raw: "Pune, India",
    locations: [],
    work_arrangement: "onsite",
    employment_type: "full_time",
    // What the list endpoint gives: nothing.
    description_raw: null,
    // The link the adapter builds; the detail URL is derived from it.
    apply_url: `https://mastercard.wd1.myworkdayjobs.com/CorporateCareers/job/Pune-India/SDE_${slug}`,
    ats_provider: "workday",
    ats_job_id: `/job/Pune-India/SDE_${slug}`,
    discovered_via: ["company_career_page"],
    source_refs: [],
    posted_at: "2026-11-04T00:00:00.000Z",
    posted_at_source: "aggregator",
    raw_payload: {},
  };
}

// The detail URL workdayRow("…", "R-1") must produce.
const DETAIL_R1 = "https://mastercard.wd1.myworkdayjobs.com/wday/cxs/mastercard/CorporateCareers/job/Pune-India/SDE_R-1";

// A detail response body with the given description HTML.
function detailBody(html: string): string {
  // The real envelope, trimmed to what the parser reads.
  return JSON.stringify({ jobPostingInfo: { title: "SDE", jobDescription: html } });
}

// Deps whose GET answers every URL with `answer`, recording each URL asked for.
function deps(answer: () => Response | null, overrides: Partial<WorkdayDetailDeps> = {}): WorkdayDetailDeps & { urls: string[]; pauses: number[] } {
  // Every URL the GET was asked for, in order.
  const urls: string[] = [];
  // Every pause requested, in order.
  const pauses: number[] = [];
  return {
    urls,
    pauses,
    // Records the URL and answers.
    get: async (url) => { urls.push(url); return answer(); },
    // A technical title passes; anything with "Sales" is dropped, like the real gate's exclusions.
    passesTitleGate: (title) => !/sales/i.test(title),
    // Plenty of time unless a test says otherwise.
    deadline: { remainingMs: () => 600_000 },
    // Recorded, not slept, so the test is instant.
    pause: async (ms) => { pauses.push(ms); },
    ...overrides,
  };
}

test("a tech-gate survivor gets descriptionRaw from the detail endpoint", async () => {
  // One new title-passing row.
  const row = workdayRow("Software Engineer");
  // A GET that answers the real detail shape.
  const d = deps(() => new Response(detailBody("<p>Build <b>APIs</b>.</p>"), { status: 200 }));
  // One run, cap 5.
  const run = newWorkdayDetailRun(d, 5);
  // Fill in place.
  await fillWorkdayDescriptions([row], run);
  // The detail endpoint, derived from the apply link, was asked exactly once.
  assert.deepEqual(d.urls, [DETAIL_R1]);
  // The row now carries the text, which planScreenedApplications reads.
  assert.equal(row.description_raw, "Build APIs.");
  // Counted.
  assert.deepEqual({ fetched: run.fetched, filled: run.filled, skipped: run.skipped }, { fetched: 1, filled: 1, skipped: 0 });
});

test("a title-gate drop never triggers a fetch", async () => {
  // A title the gate drops.
  const row = workdayRow("Area Sales Manager");
  // Any GET would be a bug.
  const d = deps(() => new Response(detailBody("<p>x</p>"), { status: 200 }));
  // One run.
  const run = newWorkdayDetailRun(d, 5);
  // Fill.
  await fillWorkdayDescriptions([row], run);
  // The stub was never called.
  assert.equal(d.urls.length, 0);
  // Still no description, so the tech gate (not missing_description) drops it.
  assert.equal(row.description_raw, null);
});

test("a soft-200 HTML page, a missing field or a non-2xx leaves the description null, never empty", async () => {
  // Three rows, three bad answers, in order.
  const rows = [workdayRow("Software Engineer", "R-1"), workdayRow("Software Engineer", "R-2"), workdayRow("Software Engineer", "R-3")];
  // The answers, handed out one per GET.
  const answers = [
    // A sign-in page served with 200.
    new Response("<html><body>Sign in</body></html>", { status: 200, headers: { "content-type": "text/html" } }),
    // JSON without jobPostingInfo.jobDescription.
    new Response(JSON.stringify({ jobPostingInfo: { title: "SDE" } }), { status: 200 }),
    // A server error.
    new Response("oops", { status: 503 }),
  ];
  // The next answer to hand out.
  let next = 0;
  // A GET that hands them out in order.
  const d = deps(() => answers[next++]!);
  // One run, cap 5.
  const run = newWorkdayDetailRun(d, 5);
  // Fill.
  await fillWorkdayDescriptions(rows, run);
  // All three were asked.
  assert.equal(d.urls.length, 3);
  // Every description stayed null; "" would be a second spelling of "nothing".
  assert.deepEqual(rows.map((row) => row.description_raw), [null, null, null]);
  // Fetched, not filled.
  assert.deepEqual({ fetched: run.fetched, filled: run.filled }, { fetched: 3, filled: 0 });
});

test("a robots-disallowed site gets no detail fetch", async () => {
  // Every request the transport made, robots.txt included.
  const requested: string[] = [];
  // The real global, restored after.
  const realFetch = globalThis.fetch;
  // robots.txt disallows the cxs API; any other request answers a valid detail page.
  globalThis.fetch = (async (input: string | URL | Request) => {
    // The URL, whatever form the transport passed.
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    // Recorded.
    requested.push(url);
    // The site's robots.txt, published with a Disallow covering the detail path.
    if (url.endsWith("/robots.txt")) return new Response("User-agent: *\nDisallow: /wday/cxs/\n", { status: 200, headers: { "content-type": "text/plain" } });
    // Reaching here at all is the bug under test.
    return new Response(detailBody("<p>should never be read</p>"), { status: 200 });
  }) as typeof fetch;
  try {
    // One title-passing row.
    const row = workdayRow("Software Engineer");
    // The production GET: scout-ats's own robots-gated fetchBoard, with a private cache.
    const cache = new Map();
    // Same deps otherwise.
    const run = newWorkdayDetailRun(deps(() => null, { get: (url) => fetchBoard(url, cache) }), 5);
    // Fill.
    await fillWorkdayDescriptions([row], run);
    // Only robots.txt was requested; the /job/ detail URL never was.
    assert.deepEqual(requested.filter((url) => url.includes("/job/")), []);
    // And robots.txt really was consulted, so the absence above is not vacuous.
    assert.ok(requested.some((url) => url.endsWith("/robots.txt")), `requests were: ${requested.join(", ")}`);
    // A refused read leaves no description.
    assert.equal(row.description_raw, null);
  } finally {
    // Never leak the stub into other tests.
    globalThis.fetch = realFetch;
  }
});

test("the per-run cap, the deadline and the pacing bound the reads", async () => {
  // Three title-passing rows.
  const rows = [workdayRow("Software Engineer", "R-1"), workdayRow("Backend Developer", "R-2"), workdayRow("Data Engineer", "R-3")];
  // Every GET succeeds.
  const d = deps(() => new Response(detailBody("<p>JD</p>"), { status: 200 }));
  // A cap of 2 for the whole run.
  const run = newWorkdayDetailRun(d, 2);
  // Fill.
  await fillWorkdayDescriptions(rows, run);
  // Two reads, then the cap; the third row is skipped, not fetched.
  assert.deepEqual({ fetched: run.fetched, filled: run.filled, skipped: run.skipped }, { fetched: 2, filled: 2, skipped: 1 });
  // The third row keeps no description, so the screener drops it as missing_description.
  assert.equal(rows[2]!.description_raw, null);
  // One pause, between the two reads, never before the first.
  assert.deepEqual(d.pauses, [WORKDAY_DETAIL_PAUSE_MS]);

  // A run out of time reads nothing, even with cap left.
  const late = deps(() => new Response(detailBody("<p>JD</p>"), { status: 200 }), { deadline: { remainingMs: () => 1_000 } });
  // A fresh run.
  const lateRun = newWorkdayDetailRun(late, 5);
  // A fresh row.
  await fillWorkdayDescriptions([workdayRow("Software Engineer", "R-9")], lateRun);
  // No GET, one skip.
  assert.deepEqual({ urls: late.urls.length, skipped: lateRun.skipped }, { urls: 0, skipped: 1 });
});

test("only Workday rows without text are read", async () => {
  // A Greenhouse row and a Workday row that already has text.
  const greenhouse = { ...workdayRow("Software Engineer", "G-1"), ats_provider: "greenhouse" as const };
  // Text already present, e.g. from a pasted link.
  const described = { ...workdayRow("Software Engineer", "R-2"), description_raw: "Existing JD." };
  // Any GET is a bug.
  const d = deps(() => new Response(detailBody("<p>x</p>"), { status: 200 }));
  // Fill both.
  await fillWorkdayDescriptions([greenhouse, described], newWorkdayDetailRun(d, 5));
  // Neither was read.
  assert.equal(d.urls.length, 0);
  // The existing text is untouched.
  assert.equal(described.description_raw, "Existing JD.");
});
