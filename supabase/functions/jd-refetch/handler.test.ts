// Tests for jd-refetch/handler.ts (S8, 2026-11-21): the no-description cron's decisions for one row.
// Teja 2026-11-21 14:41: "no-description jobs: Playwright confirm + read JD + tailor straight into the
// approval queue, on a cron." Each named test pins one branch the orch's done-criterion lists:
// live -> JD written -> pipeline call; 404 -> posting_closed; robots 429 -> untouched + counted;
// still thin -> counted. Fakes return values the way supabase-js and the transport do (no fake throws
// where the real dependency returns `{ error }`).
import { test } from "node:test";
import assert from "node:assert/strict";
// The units under test.
import { pickCandidate, readJobDescription, refetchOne, type Candidate, type JdRead, type RefetchDeps } from "./handler.ts";
// The real typed errors the transport throws, so the classification is tested on the real classes.
import { HttpError, RobotsDisallowedError } from "../_shared/http/index.ts";
import { RobotsUnavailableError } from "../_shared/http/robots-unavailable.ts";
// No Ashby hints: the gate's explicit "none".
import { NO_BOARD_HINTS } from "../_shared/screen/work-auth-gate.ts";
// The real gate, so the re-screen test uses the matcher's own verdicts.
import { firstPreGateDrop, type PreGateJob, type PreGateOutcome, type PreGatePreferences } from "../matcher/tech-pregate.ts";

// A real-looking job description: well over 200 characters of role text, not boilerplate.
const FULL_JD = [
  "About the role",
  "You will build and run backend services in TypeScript and Node.js for our payments platform.",
  "You will design REST APIs, write PostgreSQL queries, and own features from design to production.",
  "Requirements: experience with TypeScript, React, SQL and cloud deployments; 0-2 years is fine.",
  "You will work with product managers and designers in a small team that ships every week.",
].join("\n");

// The same JD asking 5+ hard years: the experience_ceiling (max 1) drops it.
const SENIOR_JD = FULL_JD.replace("0-2 years is fine.", "Minimum 5+ years of professional experience required.");

// One thin candidate; each test overrides what it is about.
function candidate(over: Partial<Candidate> = {}): Candidate {
  // The base row.
  return {
    applicationId: "app-1",
    jobId: "job-1",
    discoveredVia: ["scout_ats"],
    job: { title: "Software Engineer", descriptionRaw: "Apply now.", locationRaw: "Bengaluru, India", board: NO_BOARD_HINTS, minExperienceYears: null },
    atsProvider: "greenhouse",
    atsJobId: "123",
    applyUrl: "https://boards.greenhouse.io/acme/jobs/123",
    boardToken: "acme",
    ...over,
  };
}

// Gate preferences: open tech/work-auth lists, ceiling 1 year (the live rule).
const PREFS: PreGatePreferences = { titles: [], keywords: [], excludedKeywords: [], workAuthorizedCountries: null, remoteLocationPolicy: "any", experienceMaxYears: 1 } as unknown as PreGatePreferences;

// Recording deps: every call is logged, so a test can say what was NOT done.
function deps(over: Partial<RefetchDeps> & { read?: JdRead } = {}) {
  // The call log.
  const calls: string[] = [];
  // The fake.
  const d: RefetchDeps = {
    // Open unless the test says otherwise.
    liveness: async () => { calls.push("liveness"); return "open"; },
    // The test's read, or a full JD.
    readJd: async (url) => { calls.push(`read ${url}`); return over.read ?? { kind: "text", text: FULL_JD }; },
    // Moves land.
    closeRow: async (id, evidence) => { calls.push(`close ${id} ${evidence}`); return null; },
    // Writes land.
    writeDescription: async (id, text) => { calls.push(`write ${id} ${text.length}`); return null; },
    // The REAL gate verdict over the job it is handed; a drop is reported as the matcher's preGateRow would.
    preGate: async (id, job: PreGateJob): Promise<PreGateOutcome> => {
      // Logged with the description length, to prove the NEW text was judged.
      calls.push(`gate ${id} ${job.descriptionRaw?.length}`);
      // The matcher's own stages.
      const v = firstPreGateDrop(job, PREFS);
      // Same outcome shapes as preGateRow.
      return v === null ? { kind: "continue" } : { kind: "dropped", code: v.code, reason: v.reason };
    },
    // Started.
    runPipeline: (id) => { calls.push(`pipeline ${id}`); },
    ...over,
  };
  // Both, for the assertions.
  return { d, calls };
}

test("live posting: the JD is written, re-screened on the NEW text, then the pipeline starts", async () => {
  // A live row with a readable page.
  const { d, calls } = deps();
  // Run.
  const out = await refetchOne(candidate(), d);
  // Pipeline started.
  assert.deepEqual(out, { kind: "pipeline_started" });
  // In this order, with the gate judging the written text (its length), not "Apply now.".
  assert.deepEqual(calls, ["liveness", "read https://boards.greenhouse.io/acme/jobs/123", `write job-1 ${FULL_JD.length}`, `gate app-1 ${FULL_JD.length}`, "pipeline app-1"]);
});

test("re-screen: a new JD asking 5+ years drops at experience_ceiling and never reaches the pipeline", async () => {
  // The page now says 5+ years.
  const { d, calls } = deps({ read: { kind: "text", text: SENIOR_JD } });
  // Run.
  const out = await refetchOne(candidate(), d);
  // Dropped by the matcher's own gate under the rule's name.
  assert.equal(out.kind, "dropped");
  assert.equal((out as { code: string }).code, "experience_ceiling");
  // The JD was written (it is new information) but no pipeline ran.
  assert.ok(calls.includes(`write job-1 ${SENIOR_JD.length}`));
  assert.ok(!calls.some((c) => c.startsWith("pipeline")));
});

test("ATS API says closed: posting_closed via closeRow, no page read, no write", async () => {
  // The provider says gone.
  const { d, calls } = deps({ liveness: async () => "closed" });
  // Run.
  const out = await refetchOne(candidate(), d);
  // Closed with the API as evidence.
  assert.deepEqual(out, { kind: "closed", evidence: "ats_api_greenhouse" });
  // Only the close happened.
  assert.deepEqual(calls, ["close app-1 ats_api_greenhouse"]);
});

test("page 404 -> posting_closed (closeRow), nothing written", async () => {
  // The read sees the page's own 404.
  const read = await readJobDescription("https://x.example/job", { getPage: async () => { throw new HttpError("https://x.example/job", 404, "Not Found", 1); }, render: async () => ({ ok: false, reason: "unused" }) });
  // Classified as gone.
  assert.deepEqual(read, { kind: "closed", reason: "page_404" });
  // And the flow closes the row on it.
  const { d, calls } = deps({ liveness: async () => "unknown", read });
  // Run.
  const out = await refetchOne(candidate(), d);
  // Closed with the page as evidence.
  assert.deepEqual(out, { kind: "closed", evidence: "page_404" });
  // No write, no gate, no pipeline.
  assert.ok(!calls.some((c) => c.startsWith("write") || c.startsWith("gate") || c.startsWith("pipeline")));
});

test("robots.txt 429 -> retry_later: untouched and counted, the renderer is never called", async () => {
  // Did the render run?
  let rendered = false;
  // Cloudflare answers robots.txt with 429.
  const read = await readJobDescription("https://x.example/job", {
    getPage: async () => { throw new RobotsUnavailableError("https://x.example/job", "refuse", "robots.txt HTTP 429", null, 429); },
    render: async () => { rendered = true; return { ok: true, text: FULL_JD }; },
  });
  // Retry later, never a fail.
  assert.equal(read.kind, "retry_later");
  // The renderer has no robots check, so it must not be used to get around one.
  assert.equal(rendered, false);
  // The flow leaves the row alone.
  const { d, calls } = deps({ read });
  // Run.
  const out = await refetchOne(candidate(), d);
  // Counted as retry_later.
  assert.equal(out.kind, "retry_later");
  // Nothing written or moved.
  assert.ok(!calls.some((c) => c.startsWith("write") || c.startsWith("close") || c.startsWith("pipeline")));
});

test("robots.txt disallows: still thin, and the renderer is never called", async () => {
  // Did the render run?
  let rendered = false;
  // A Disallow rule for our agent.
  const read = await readJobDescription("https://x.example/job", {
    getPage: async () => { throw new RobotsDisallowedError("https://x.example/job", "refuse", "Disallow: /", null); },
    render: async () => { rendered = true; return { ok: true, text: FULL_JD }; },
  });
  // Counted as thin, never read around.
  assert.equal(read.kind, "thin");
  assert.equal(rendered, false);
});

test("still thin after plain page AND render -> still_thin: counted, nothing written", async () => {
  // A page with almost no text, and a render with almost none either.
  const read = await readJobDescription("https://x.example/job", { getPage: async () => "<html><body>Apply</body></html>", render: async () => ({ ok: true, text: "Apply now. Equal opportunity employer." }) });
  // Thin, naming both rungs.
  assert.equal(read.kind, "thin");
  assert.match((read as { reason: string }).reason, /plain_page_thin; render_thin/);
  // The flow leaves the row at passed_filters.
  const { d, calls } = deps({ read });
  // Run.
  const out = await refetchOne(candidate(), d);
  // Counted.
  assert.equal(out.kind, "still_thin");
  // Nothing written, gated or started.
  assert.ok(!calls.some((c) => c.startsWith("write") || c.startsWith("gate") || c.startsWith("pipeline")));
});

test("a client-rendered page: thin plain HTML falls back to ONE render, whose text is used", async () => {
  // Render calls.
  let renders = 0;
  // Workday-style shell page, full render.
  const read = await readJobDescription("https://x.example/job", { getPage: async () => "<html><body><div id=root></div></body></html>", render: async () => { renders += 1; return { ok: true, text: FULL_JD }; } });
  // The rendered text.
  assert.deepEqual(read, { kind: "text", text: FULL_JD });
  // Exactly one render.
  assert.equal(renders, 1);
});

// The live backlog's shape (measured 2026-11-21 ~20:45): 111 Workday rows, description_raw NULL, created 11-05..11-10.
// A null description must read as thin (a non-string is "no role text"), or the cron would skip exactly these rows.
test("pickCandidate: a real Workday row with a NULL description is picked (the live backlog's shape)", () => {
  // Workday, no ATS id, a myworkdayjobs apply link, description null.
  const workday = candidate({ applicationId: "wd-null", atsProvider: "workday", atsJobId: null, applyUrl: "https://barclays.wd3.myworkdayjobs.com/External_Career_Site_Barclays/job/Pune/Software-Engineer_JR-0000", boardToken: null, job: { ...candidate().job, descriptionRaw: null } });
  // Picked.
  assert.equal(pickCandidate([workday], new Set())?.applicationId, "wd-null");
});

test("pickCandidate: skips tried ids, human-pasted rows and rows no longer thin", () => {
  // Four rows, oldest first.
  const rows = [
    candidate({ applicationId: "tried" }),
    candidate({ applicationId: "manual", discoveredVia: ["manual"] }),
    candidate({ applicationId: "filled", job: { ...candidate().job, descriptionRaw: FULL_JD } }),
    candidate({ applicationId: "next" }),
  ];
  // The first that is thin, untried and not a human pick.
  assert.equal(pickCandidate(rows, new Set(["tried"]))?.applicationId, "next");
  // None left.
  assert.equal(pickCandidate(rows.slice(0, 3), new Set(["tried"])), null);
});
