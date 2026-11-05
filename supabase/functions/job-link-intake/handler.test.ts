// job-link-intake handler: the request gates, the ATS-vs-page decision, and the revive rule.
// Run with: node --test "supabase/functions/job-link-intake/*.test.ts"
import { test } from "node:test";
import assert from "node:assert/strict";
import { atsTarget, handleJobLinkIntake, needsChain, parseIntakeBody, persistManualJob, REVIVE_FROM, type IntakeDeps, type IntakeStore, type StoredApplication } from "./handler.ts";
import type { JobInsert } from "../_shared/contracts/shared-types.ts";
// Moved to fetch-page.ts (2026-10-31) so redirect hops share it; still pinned here for the pasted link.
import { isBlockedHost } from "./fetch-page.ts";
// The readers past a plain fetch (2026-11-01): pinned here through the handler and directly.
import { linkedInGuestUrl, parseOembed, RENDER_URL, xOembedUrl } from "./page-readers.ts";

// One live Greenhouse posting, the shape the greenhouse adapter parses.
const GH_BOARD = {
  jobs: [{ id: 111, title: "Senior Engineer", absolute_url: "https://job-boards.greenhouse.io/acme/jobs/111", location: { name: "Bengaluru, India" }, content: "&lt;p&gt;Build things&lt;/p&gt;" }],
};

// Long enough to pass MIN_JOB_TEXT_CHARS, so the pasted-text path skips the fetch.
const POST_TEXT = "We are hiring a Backend Engineer at Globex in Hyderabad. ".repeat(6);

// A valid JSON-mode answer, wrapped the way Gemini returns it.
function geminiAnswer(fields: Record<string, unknown>) {
  // ok outcome with one text part holding the JSON.
  return { ok: true as const, keyIndex: 0, attempts: 1, data: { candidates: [{ content: { parts: [{ text: JSON.stringify(fields) }] } }] } };
}

// A job the model extracted cleanly.
const GOOD_FIELDS = { is_job_posting: true, title: "Backend Engineer", company_name: "Globex", location: "Hyderabad, India", work_arrangement: "onsite", employment_type: "full_time" };

// Records every effect, so tests assert what was (and was not) called.
interface Spy {
  jobs: JobInsert[];
  tags: string[][];
  moves: { id: string; detail: Record<string, unknown> }[];
  pageFetches: number;
  boardFetches: number;
  extracts: number;
  // The description each tagManual call wrote (null = left untouched). Optional so the
  // existing Spy literals stay valid; created on the first tag write.
  fills?: Array<string | null>;
  // Every override note the handler recorded (work_auth confirms), created on the first write.
  notes?: Array<{ applicationId: string; detail: Record<string, unknown> }>;
}

// A fake store honouring the real contract: values, never throws.
function fakeStore(spy: Spy, opts: { existing?: { discoveredVia: string[]; disappearedAt?: string | null; descriptionRaw?: string | null }; application?: StoredApplication; moveError?: string | null; workAuth?: { countries: string[] | null; policy: "any" | "unlocked_or_authorized" | "authorized_only" } | { fail: string } } = {}): IntakeStore {
  // Mirrors the real store's read-back.
  return {
    // Default: the gate is OPEN (no countries set), so tests written before 2026-11-05 keep their meaning.
    workAuthConfig: () => Promise.resolve(opts.workAuth !== undefined && "fail" in opts.workAuth ? { ok: false as const, reason: opts.workAuth.fail } : { ok: true as const, countries: opts.workAuth?.countries ?? null, policy: opts.workAuth?.policy ?? "any" }),
    // Records the override note.
    recordOverrideNote: (applicationId, detail) => {
      // Kept for the assertions.
      (spy.notes ??= []).push({ applicationId, detail });
      return Promise.resolve(null);
    },
    watchlistName: () => Promise.resolve({ ok: true as const, name: null }),
    upsertJob: (row) => {
      // Records the row the handler built.
      spy.jobs.push(row);
      // An existing row keeps its own sources and description; a new one has the row's.
      return Promise.resolve({
        ok: true as const,
        job: {
          id: "job-1",
          discoveredVia: opts.existing?.discoveredVia ?? (row.discovered_via ?? []),
          disappearedAt: opts.existing?.disappearedAt ?? null,
          // An existing row without a stated description has none; an explicit null stays null.
          descriptionRaw: opts.existing ? (opts.existing.descriptionRaw ?? null) : (row.description_raw ?? null),
        },
      });
    },
    tagManual: (_id, via, descriptionRaw) => {
      // Records the tag write.
      spy.tags.push([...via]);
      // And the description it carried, so a test can tell "filled" from "left alone".
      (spy.fills ??= []).push(descriptionRaw);
      return Promise.resolve(null);
    },
    upsertApplication: () => Promise.resolve({ ok: true as const, application: opts.application ?? { id: "11111111-1111-4111-8111-111111111111", status: "passed_filters", created: true } }),
    moveToPassedFilters: (id, detail) => {
      // Records the human move.
      spy.moves.push({ id, detail });
      return Promise.resolve(opts.moveError ?? null);
    },
  };
}

// One fetchPage answer, as the real seam returns it.
type PageAnswer = { ok: true; html: string } | { ok: false; reason: string };

// Deps with every seam faked; options flip the branch under test.
// `pages` answers specific URLs (adapter endpoints, outbound links); every other URL gets the
// default page. `render` answers the browser service; by default it fails, so the ladder's
// earlier rungs decide. `extractSeq` answers the 1st, 2nd... Gemini call in turn.
function makeDeps(opts: { killOn?: boolean; pageFails?: boolean; html?: string; extract?: unknown; extractSeq?: unknown[]; store?: Parameters<typeof fakeStore>[1]; board?: unknown; boardFails?: boolean; pages?: Record<string, PageAnswer>; render?: { status: number; body: unknown } } = {}): { deps: IntakeDeps; spy: Spy; runs: string[]; fetched: string[]; renders: { url: string; init: RequestInit }[]; prompts: string[] } {
  const spy: Spy = { jobs: [], tags: [], moves: [], pageFetches: 0, boardFetches: 0, extracts: 0 };
  // Every server pipeline run the handler started, in order (kept off Spy so its literals stay valid).
  const runs: string[] = [];
  // Every URL fetchPage was asked for, in order: proves which rung read what.
  const fetched: string[] = [];
  // Every call to the render service, with the request it would have sent.
  const renders: { url: string; init: RequestInit }[] = [];
  // The untrusted text each Gemini call was given, so a retry can be shown to read the render.
  const prompts: string[] = [];
  const deps: IntakeDeps = {
    connect: () =>
      Promise.resolve({
        ok: true as const,
        userId: "app-user",
        db: {
          // "good" is the app user's token; anything else is refused.
          auth: { getUser: (jwt: string) => Promise.resolve(jwt === "good" ? { data: { user: { id: "app-user" } }, error: null } : { data: { user: null }, error: { message: "bad" } }) },
          // The kill-switch read.
          from: () => ({ select: () => Promise.resolve({ data: [{ system_enabled: opts.killOn ?? true }], error: null }) }),
        },
        store: fakeStore(spy, opts.store),
        // Records the start; the real one hands the run to EdgeRuntime.waitUntil.
        runPipeline: (id: string) => {
          runs.push(id);
        },
      }),
    fetchBoard: () => {
      // Counted so the page path can prove it never touched a board.
      spy.boardFetches += 1;
      // A dead board, when a test needs the fall-through to the page ladder.
      if (opts.boardFails) return Promise.resolve({ ok: false as const, reason: "HTTP 503" });
      // The default board, unless a test serves one with a different posting.
      return Promise.resolve({ ok: true as const, payload: opts.board ?? GH_BOARD });
    },
    fetchPage: (url) => {
      // Counted so the pasted-text path can prove it never fetched.
      spy.pageFetches += 1;
      // Recorded in order.
      fetched.push(url);
      // A URL the test answers itself.
      const listed = opts.pages?.[url];
      if (listed !== undefined) return Promise.resolve(listed);
      return Promise.resolve(opts.pageFails ? { ok: false as const, reason: "HTTP 403 Forbidden" } : { ok: true as const, html: opts.html ?? `<html><body><p>${POST_TEXT}</p></body></html>` });
    },
    renderFetch: (url, init) => {
      // Recorded so a test can read the request the handler built.
      renders.push({ url, init });
      // The test's answer, else a renderer that could not help.
      const answer = opts.render ?? { status: 502, body: { status: "error", message: "no browser in tests" } };
      return Promise.resolve(new Response(JSON.stringify(answer.body), { status: answer.status, headers: { "content-type": "application/json" } }));
    },
    extract: (_db, prompt) => {
      // Counted so the ATS path can prove it spent no Gemini call.
      spy.extracts += 1;
      // The fenced text the model was shown.
      prompts.push(prompt.userContent);
      // A sequence answers call by call; otherwise one answer for every call.
      const answer = opts.extractSeq !== undefined ? opts.extractSeq[spy.extracts - 1] : opts.extract;
      return Promise.resolve((answer ?? geminiAnswer(GOOD_FIELDS)) as Awaited<ReturnType<IntakeDeps["extract"]>>);
    },
    now: () => new Date("2026-10-31T10:00:00Z"),
  };
  return { deps, spy, runs, fetched, renders, prompts };
}

// A POST with the app user's token.
function post(body: unknown, token = "good"): Request {
  return new Request("https://fn.local/job-link-intake", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
}

test("isBlockedHost refuses IP literals, single-label and internal names, and allows real hosts", () => {
  for (const host of ["127.0.0.1", "169.254.169.254", "[::1]", "localhost", "intranet", "db.internal", "printer.local"]) assert.equal(isBlockedHost(host), true, host);
  for (const host of ["www.linkedin.com", "careers.example.com", "job-boards.greenhouse.io"]) assert.equal(isBlockedHost(host), false, host);
});

test("parseIntakeBody: https only, no userinfo or port, blank text is absence", () => {
  assert.equal(parseIntakeBody({ url: "http://example.com/job" }).ok, false);
  assert.equal(parseIntakeBody({ url: "https://user@example.com/job" }).ok, false);
  assert.equal(parseIntakeBody({ url: "https://example.com:8443/job" }).ok, false);
  assert.equal(parseIntakeBody({ url: "https://10.0.0.1/job" }).ok, false);
  assert.equal(parseIntakeBody({ url: "not a link" }).ok, false);
  assert.equal(parseIntakeBody({}).ok, false);
  const ok = parseIntakeBody({ url: "  https://www.linkedin.com/posts/x  ", text: "   " });
  assert.ok(ok.ok);
  assert.equal(ok.value.text, null);
});

test("atsTarget: the link itself, else exactly one ATS link in the text", () => {
  // Direct board link.
  assert.deepEqual(atsTarget(new URL("https://job-boards.greenhouse.io/acme/jobs/111"), null), { provider: "greenhouse", token: "acme", jobId: "111" });
  // A post whose only ATS link is a Lever posting (the /apply twin collapses into it).
  const lever = "https://jobs.lever.co/globex/0b1c2d3e-0000-4000-8000-000000000001";
  assert.equal(atsTarget(new URL("https://www.linkedin.com/posts/x"), `Apply: ${lever} or ${lever}/apply`)?.provider, "lever");
  // Two different postings: ambiguous, so no target.
  assert.equal(atsTarget(new URL("https://www.linkedin.com/posts/x"), "https://job-boards.greenhouse.io/a/jobs/1 https://job-boards.greenhouse.io/a/jobs/2"), null);
});

test("ATS link: built from the live board, tagged manual, no page fetch and no Gemini call", async () => {
  const { deps, spy } = makeDeps();
  const res = await handleJobLinkIntake(post({ url: "https://job-boards.greenhouse.io/acme/jobs/111" }), deps);
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.status, "ok");
  assert.equal(body.source, "ats_board");
  assert.equal(body.application_status, "passed_filters");
  assert.deepEqual(spy.jobs[0]?.discovered_via, ["manual"]);
  assert.equal(spy.jobs[0]?.ats_provider, "greenhouse");
  assert.equal(spy.pageFetches + spy.extracts, 0);
});

test("ATS link for a posting no longer on the board: posting_closed, nothing written", async () => {
  const { deps, spy } = makeDeps();
  const res = await handleJobLinkIntake(post({ url: "https://job-boards.greenhouse.io/acme/jobs/999" }), deps);
  assert.equal(res.status, 422);
  assert.equal((await res.json()).status, "posting_closed");
  assert.equal(spy.jobs.length, 0);
});

test("pasted text: no fetch; the row keeps the pasted text and claims no ATS adapter", async () => {
  const { deps, spy } = makeDeps();
  const res = await handleJobLinkIntake(post({ url: "https://www.linkedin.com/posts/globex-hiring", text: POST_TEXT }), deps);
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.source, "pasted_text");
  assert.equal(spy.pageFetches, 0);
  const row = spy.jobs[0];
  assert.equal(row?.title, "Backend Engineer");
  assert.equal(row?.company_name, "Globex");
  assert.equal(row?.ats_provider, "unknown");
  assert.equal(row?.description_raw, POST_TEXT.trim());
  assert.deepEqual(row?.discovered_via, ["manual"]);
  // No trusted ATS link in the post, so the pasted permalink is the apply target.
  assert.equal(row?.apply_url, "https://www.linkedin.com/posts/globex-hiring");
});

test("a page the site will not let us read, with no text: needs_text, no Gemini call", async () => {
  const { deps, spy } = makeDeps({ pageFails: true });
  const res = await handleJobLinkIntake(post({ url: "https://www.linkedin.com/jobs/view/123" }), deps);
  assert.equal(res.status, 422);
  assert.equal((await res.json()).status, "needs_text");
  assert.equal(spy.extracts, 0);
});

test("a JS shell page with almost no text: needs_text", async () => {
  const { deps } = makeDeps({ html: "<html><body><div id=root></div><script>var x = 1;</script></body></html>" });
  const res = await handleJobLinkIntake(post({ url: "https://careers.example.com/job/1" }), deps);
  assert.equal((await res.json()).status, "needs_text");
});

test("the model says it is not one job: not_a_job, nothing written", async () => {
  const { deps, spy } = makeDeps({ extract: geminiAnswer({ ...GOOD_FIELDS, is_job_posting: false }) });
  const res = await handleJobLinkIntake(post({ url: "https://careers.example.com/jobs", text: POST_TEXT }), deps);
  assert.equal((await res.json()).status, "not_a_job");
  assert.equal(spy.jobs.length, 0);
});

test("Gemini out of budget: 429 quota", async () => {
  const { deps } = makeDeps({ extract: { ok: false, reason: "all_keys_cooling", attempts: 0 } });
  const res = await handleJobLinkIntake(post({ url: "https://careers.example.com/job/1", text: POST_TEXT }), deps);
  assert.equal(res.status, 429);
  assert.equal((await res.json()).status, "quota");
});

test("gates: no token is 401; kill switch off is 409 and nothing is fetched", async () => {
  const anon = makeDeps();
  assert.equal((await handleJobLinkIntake(post({ url: "https://job-boards.greenhouse.io/acme/jobs/111" }, "bad"), anon.deps)).status, 401);
  const off = makeDeps({ killOn: false });
  const res = await handleJobLinkIntake(post({ url: "https://job-boards.greenhouse.io/acme/jobs/111" }), off.deps);
  assert.equal(res.status, 409);
  assert.equal(off.spy.boardFetches, 0);
});

test("a saved row starts the server pipeline exactly once, for that row, and says so", async () => {
  // A brand-new row at passed_filters (the fake store's default).
  const { deps, runs } = makeDeps();
  const res = await handleJobLinkIntake(post({ url: "https://job-boards.greenhouse.io/acme/jobs/111" }), deps);
  const body = await res.json();
  assert.equal(res.status, 200);
  // Teja's ask (2026-11-01): no button press; the server runs it.
  assert.deepEqual(runs, ["11111111-1111-4111-8111-111111111111"]);
  // The browser follows the run instead of starting its own.
  assert.equal(body.pipeline_started, true);
});

test("a re-pasted link for a row already at the approval queue starts nothing", async () => {
  // The row exists and is past every agent.
  const { deps, runs } = makeDeps({ store: { existing: { discoveredVia: ["manual"] }, application: { id: "22222222-2222-4222-8222-222222222222", status: "awaiting_approval", created: false } } });
  const body = await (await handleJobLinkIntake(post({ url: "https://job-boards.greenhouse.io/acme/jobs/111" }), deps)).json();
  // Re-running tailor here would overwrite a resume the human may already be reviewing.
  assert.deepEqual(runs, []);
  assert.equal(body.pipeline_started, false);
});

test("refusals start no pipeline: closed posting, unreadable page, not a job, no token", async () => {
  // Each case below stops before any row is saved, so nothing may run.
  const closed = makeDeps();
  await handleJobLinkIntake(post({ url: "https://job-boards.greenhouse.io/acme/jobs/999" }), closed.deps);
  const unreadable = makeDeps({ pageFails: true });
  await handleJobLinkIntake(post({ url: "https://www.linkedin.com/posts/x" }), unreadable.deps);
  const notJob = makeDeps({ extract: geminiAnswer({ ...GOOD_FIELDS, is_job_posting: false }) });
  await handleJobLinkIntake(post({ url: "https://careers.example.com/x", text: POST_TEXT }), notJob.deps);
  const anon = makeDeps();
  await handleJobLinkIntake(post({ url: "https://job-boards.greenhouse.io/acme/jobs/111" }, "bad"), anon.deps);
  assert.deepEqual([...closed.runs, ...unreadable.runs, ...notJob.runs, ...anon.runs], []);
});

test("needsChain: the matcher/tailor/auditor inputs need the chain; the queue and later do not", () => {
  for (const s of ["passed_filters", "scored", "tailored", "audit_clean", "audit_flagged"]) assert.equal(needsChain(s), true, s);
  for (const s of ["awaiting_approval", "approved", "applied", "dropped_filter", "failed", "discovered"]) assert.equal(needsChain(s), false, s);
});

test("REVIVE_FROM is exactly the four statuses the migrations give a human edge into passed_filters", () => {
  // 20261031200000 adds the first three; 20261102203000 adds failed (Teja, 2026-11-02).
  assert.deepEqual([...REVIVE_FROM].sort(), ["deduped", "discovered", "dropped_filter", "failed"]);
});

// --- A pasted link restarts a failed job (Teja, 2026-11-02); the trigger may refuse it ---

// guard_failed_rerun's exception text (migration 20261102203000), as supabase-js hands it back.
const TRIGGER_REFUSAL = "application 33333333-3333-4333-8333-333333333333 failed at or after approval (previous_status approved); it may not re-enter the pipeline";

test("persistManualJob: a row that failed before approval is moved back to passed_filters as the human", async () => {
  // The spy records the guarded move.
  const spy: Spy = { jobs: [], tags: [], moves: [], pageFetches: 0, boardFetches: 0, extracts: 0 };
  // A failed row; the fake advance succeeds, as the database does for a pre-approval failure.
  const store = fakeStore(spy, { existing: { discoveredVia: ["manual"] }, application: { id: "app-9", status: "failed", created: false } });
  // The paste.
  const saved = await persistManualJob(store, pastedRow(null), "https://x.example/j", new Set());
  // Revived, from failed.
  assert.ok(saved.ok);
  // Named, so the browser can say "restarted".
  assert.equal(saved.revivedFrom, "failed");
  // Where the server pipeline picks it up.
  assert.equal(saved.application.status, "passed_filters");
  // Through the guarded RPC, saying where it came from.
  assert.equal(spy.moves[0]?.detail["from"], "failed");
});

test("handler: a failed pre-approval row is restarted: 200, revived_from failed, and the server pipeline runs", async () => {
  // The scouted row failed before approval; the fake advance succeeds.
  const { deps, runs } = makeDeps({ store: { existing: { discoveredVia: ["greenhouse"] }, application: { id: "33333333-3333-4333-8333-333333333333", status: "failed", created: false } } });
  // The paste.
  const res = await handleJobLinkIntake(post({ url: "https://job-boards.greenhouse.io/acme/jobs/111" }), deps);
  // The envelope.
  const body = await res.json();
  // Accepted.
  assert.equal(res.status, 200);
  // Restarted from failed.
  assert.equal(body.revived_from, "failed");
  // The chain runs on it, server-side.
  assert.deepEqual(runs, ["33333333-3333-4333-8333-333333333333"]);
});

test("handler: a failed row the trigger refuses answers 409 cannot_restart, names 'failed after approval', keeps the description, runs nothing", async () => {
  // A scouted row with no description that failed AFTER approval; the trigger refuses the move.
  const { deps, runs, spy } = makeDeps({ store: { existing: { discoveredVia: ["greenhouse"], descriptionRaw: null }, application: { id: "33333333-3333-4333-8333-333333333333", status: "failed", created: false }, moveError: TRIGGER_REFUSAL } });
  // The paste.
  const res = await handleJobLinkIntake(post({ url: "https://job-boards.greenhouse.io/acme/jobs/111" }), deps);
  // The envelope.
  const body = await res.json();
  // A refusal, not a server error.
  assert.equal(res.status, 409);
  // Its own status, so the browser shows the message rather than "saving failed".
  assert.equal(body.status, "cannot_restart");
  // The cause in words.
  assert.match(body.message, /failed after approval/);
  // Nothing re-runs a row that may already have been submitted.
  assert.deepEqual(runs, []);
  // The board's description was still written to the job row before the move was refused.
  assert.ok(typeof spy.fills?.[0] === "string" && spy.fills[0].length > 0, "the description fill was not written");
});

test("handler: a failed row refused for another reason (restart edge not live yet) is still cannot_restart, and never claims 'after approval'", async () => {
  // The graph guard's refusal before migration 20261102203000 is applied.
  const { deps, runs } = makeDeps({ store: { existing: { discoveredVia: ["manual"] }, application: { id: "33333333-3333-4333-8333-333333333333", status: "failed", created: false }, moveError: "illegal status transition failed -> passed_filters (application x). No such edge in application_status_transitions." } });
  // The paste.
  const res = await handleJobLinkIntake(post({ url: "https://job-boards.greenhouse.io/acme/jobs/111" }), deps);
  // The envelope.
  const body = await res.json();
  // The same graceful path.
  assert.equal(res.status, 409);
  // Same status.
  assert.equal(body.status, "cannot_restart");
  // The database's own reason, not an invented one.
  assert.match(body.message, /No such edge/);
  // A cause the database did not state is never claimed.
  assert.doesNotMatch(body.message, /after approval/);
  // Nothing runs.
  assert.deepEqual(runs, []);
});

test("persistManualJob: a scouted row a filter dropped is tagged manual, then moved back as the human", async () => {
  const spy: Spy = { jobs: [], tags: [], moves: [], pageFetches: 0, boardFetches: 0, extracts: 0 };
  const store = fakeStore(spy, { existing: { discoveredVia: ["greenhouse"] }, application: { id: "app-9", status: "dropped_filter", created: false } });
  const saved = await persistManualJob(store, { fingerprint: "fp", title: "t", company_name: "c", company_slug: "c", apply_url: "https://x.example/j", posted_at: "2026-10-31T00:00:00Z", discovered_via: ["manual"] }, "https://x.example/j", new Set(["revive_dropped"]));
  assert.ok(saved.ok);
  assert.equal(saved.revivedFrom, "dropped_filter");
  assert.equal(saved.application.status, "passed_filters");
  assert.deepEqual(spy.tags, [["greenhouse", "manual"]]);
  assert.equal(spy.moves[0]?.detail["reason"], "pasted_link");
});

test("persistManualJob: a row already at the approval queue is left exactly where it is", async () => {
  const spy: Spy = { jobs: [], tags: [], moves: [], pageFetches: 0, boardFetches: 0, extracts: 0 };
  const store = fakeStore(spy, { existing: { discoveredVia: ["manual"] }, application: { id: "app-9", status: "awaiting_approval", created: false } });
  const saved = await persistManualJob(store, { fingerprint: "fp", title: "t", company_name: "c", company_slug: "c", apply_url: "https://x.example/j", posted_at: "2026-10-31T00:00:00Z" }, "https://x.example/j", new Set());
  assert.ok(saved.ok);
  assert.equal(saved.revivedFrom, null);
  assert.equal(spy.moves.length, 0);
  assert.equal(spy.tags.length, 0);
});

test("persistManualJob: a refused move is reported, never claimed as moved", async () => {
  const spy: Spy = { jobs: [], tags: [], moves: [], pageFetches: 0, boardFetches: 0, extracts: 0 };
  const store = fakeStore(spy, { existing: { discoveredVia: ["manual"] }, application: { id: "app-9", status: "dropped_filter", created: false }, moveError: "illegal transition" });
  const saved = await persistManualJob(store, { fingerprint: "fp", title: "t", company_name: "c", company_slug: "c", apply_url: "https://x.example/j", posted_at: "2026-10-31T00:00:00Z" }, "https://x.example/j", new Set(["revive_dropped"]));
  assert.equal(saved.ok, false);
});

// --- W3 (wiring audit, 2026-11-01): a pasted link can fill a description the scout missed ---

// A Greenhouse board whose one posting carries no description, the shape of the 13 live
// SmartRecruiters rows (the SR list endpoint has none) on the one adapter these tests serve.
const GH_BOARD_NO_DESCRIPTION = { jobs: [{ ...GH_BOARD.jobs[0], content: "" }] };

// A JobInsert carrying the pasted page's description, for the persistManualJob tests.
function pastedRow(description: string | null) {
  // Only the fields persistManualJob reads matter; the rest satisfy the type.
  return { fingerprint: "fp", title: "t", company_name: "c", company_slug: "c", apply_url: "https://x.example/j", posted_at: "2026-10-31T00:00:00Z", discovered_via: ["manual"], description_raw: description };
}

test("persistManualJob: a scouted row with no description takes the pasted description", async () => {
  const spy: Spy = { jobs: [], tags: [], moves: [], pageFetches: 0, boardFetches: 0, extracts: 0 };
  // The live SR case: scouted, no description, still at passed_filters.
  const store = fakeStore(spy, { existing: { discoveredVia: ["smartrecruiters"], descriptionRaw: null }, application: { id: "app-9", status: "passed_filters", created: false } });
  // The paste carries a real description.
  const saved = await persistManualJob(store, pastedRow(POST_TEXT.trim()), "https://x.example/j", new Set());
  // Saved, so the server pipeline can run on it.
  assert.ok(saved.ok);
  // THE PROPERTY: the tag write carries the pasted description, so the matcher and tailor read it.
  assert.deepEqual(spy.fills, [POST_TEXT.trim()]);
  // Every other scouted field is kept: only the sources gain 'manual'.
  assert.deepEqual(spy.tags, [["smartrecruiters", "manual"]]);
});

test("persistManualJob: a shorter stored description is replaced, even on a row already tagged manual", async () => {
  const spy: Spy = { jobs: [], tags: [], moves: [], pageFetches: 0, boardFetches: 0, extracts: 0 };
  // Already manual and live: the fill is the only reason to write.
  const store = fakeStore(spy, { existing: { discoveredVia: ["manual"], descriptionRaw: "Short JD." }, application: { id: "app-9", status: "passed_filters", created: false } });
  // Longer than the stored text.
  const saved = await persistManualJob(store, pastedRow(POST_TEXT.trim()), "https://x.example/j", new Set());
  // Saved.
  assert.ok(saved.ok);
  // The fill alone triggered the write (before W3 this row was never written).
  assert.deepEqual(spy.fills, [POST_TEXT.trim()]);
});

test("persistManualJob: a richer stored description is left untouched", async () => {
  const spy: Spy = { jobs: [], tags: [], moves: [], pageFetches: 0, boardFetches: 0, extracts: 0 };
  // The scouted board text is longer than what was pasted: the employer's own words win.
  const store = fakeStore(spy, { existing: { discoveredVia: ["greenhouse"], descriptionRaw: POST_TEXT.repeat(2) }, application: { id: "app-9", status: "passed_filters", created: false } });
  // Shorter than the stored text.
  const saved = await persistManualJob(store, pastedRow(POST_TEXT.trim()), "https://x.example/j", new Set());
  // Saved.
  assert.ok(saved.ok);
  // Tagged manual (it was scouted), but the description is not touched.
  assert.deepEqual(spy.tags, [["greenhouse", "manual"]]);
  assert.deepEqual(spy.fills, [null]);
});

test("persistManualJob: a blank pasted description never replaces anything", async () => {
  const spy: Spy = { jobs: [], tags: [], moves: [], pageFetches: 0, boardFetches: 0, extracts: 0 };
  // Already manual and live with no description; the paste has none either.
  const store = fakeStore(spy, { existing: { discoveredVia: ["manual"], descriptionRaw: null }, application: { id: "app-9", status: "passed_filters", created: false } });
  // Whitespace only: absence, which must never wipe or fill anything.
  const saved = await persistManualJob(store, pastedRow("   "), "https://x.example/j", new Set());
  // Saved.
  assert.ok(saved.ok);
  // Nothing to fill and nothing to tag: no write at all.
  assert.equal(spy.fills, undefined);
});

test("ATS link whose board has no description: the pasted text becomes the description", async () => {
  // The board lists the posting but says nothing about it.
  const { deps, spy } = makeDeps({ board: GH_BOARD_NO_DESCRIPTION });
  // The board link plus the human's copy of the job text.
  const res = await handleJobLinkIntake(post({ url: "https://job-boards.greenhouse.io/acme/jobs/111", text: POST_TEXT }), deps);
  // Accepted.
  assert.equal(res.status, 200);
  // Still the board's row (provider, apply link, id), with the human's text as its description.
  assert.equal(spy.jobs[0]?.ats_provider, "greenhouse");
  assert.equal(spy.jobs[0]?.description_raw, POST_TEXT.trim());
});

test("ATS link whose board has a description: the board's text wins over the paste", async () => {
  const { deps, spy } = makeDeps();
  // The same paste, against the default board whose posting has a description.
  const res = await handleJobLinkIntake(post({ url: "https://job-boards.greenhouse.io/acme/jobs/111", text: POST_TEXT }), deps);
  // Accepted.
  assert.equal(res.status, 200);
  // What the employer wrote, not the post around the link.
  assert.match(String(spy.jobs[0]?.description_raw), /Build things/);
});

test("job-link-intake wiring: the store reads description_raw back and writes it only when given", async () => {
  // index.ts runs Deno.serve on import, so its store is read as source (POSITIVE shape, §6).
  const { readFileSync } = await import("node:fs");
  // Resolved relative to this test file, independent of the cwd.
  const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
  // The read-back must carry the stored description, or every paste would look like a fill.
  assert.match(source, /\.select\("id, discovered_via, disappeared_at, description_raw"\)/);
  // The tag write sets description_raw only for a non-null fill; otherwise the column is not named.
  // A fill also clears tombstoned_at (jobs tombstone edge 4), or the trigger discards the text.
  assert.match(source, /\.\.\.\(descriptionRaw !== null \? \{ description_raw: descriptionRaw, tombstoned_at: null \} : \{\}\)/);
});

// --- Read from the link alone (Teja, 2026-11-01): no robots on the pasted page, LinkedIn/X
// public endpoints, the browser render, and the not_a_job re-read ---

// What the browser service sees once a page's scripts ran; distinct from POST_TEXT on purpose.
const RENDERED_TEXT = "Rendered: Platform Engineer at Initech in Pune. ".repeat(6);
// A JS shell: a plain fetch reads a few words, short of MIN_JOB_TEXT_CHARS but not nothing, so the
// tests pin "too short" and not merely "empty".
const SHELL = "<html><body><div id=root>Loading jobs…</div><script>var x = 1;</script></body></html>";
// The renderer's success answer, per the agreed contract.
const RENDER_OK = { status: 200, body: { status: "ok", text: RENDERED_TEXT, final_url: "https://careers.example.com/job/1" } };
// The model's "this is not one job" answer.
const NOT_A_JOB = geminiAnswer({ ...GOOD_FIELDS, is_job_posting: false });

test("robots: the pasted page's hops are pinned-IP GETs with no robots gate, and the ruling is cited", async () => {
  // index.ts runs Deno.serve on import, so its wiring is read as source (POSITIVE shape, §6).
  const { readFileSync } = await import("node:fs");
  const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
  // fetchHop IS the pinned hop, called directly, so no robots check can sit in front of it.
  // (Since 2026-11-02, audit W17: it replaced a robots-off httpFetch to close DNS rebinding.)
  assert.match(source, /fetchHop: \(hop, address\) => fetchPinnedHop\(hop, address, \{/);
  // The pinned hop imports only error classes and two constants: no robots gate, no httpFetch.
  const hop = readFileSync(new URL("./pinned-get.ts", import.meta.url), "utf8");
  // Every import line of pinned-get.ts, exactly.
  assert.deepEqual(hop.match(/^import .*$/gm), [
    'import { HttpError, NetworkError } from "../_shared/http/errors.ts";',
    'import { DEFAULT_TIMEOUT_MS, DEFAULT_USER_AGENT } from "../_shared/http/index.ts";',
  ]);
  // The comment that stops someone restoring the check names the ruling and its date.
  assert.match(source, /Teja's ruling, 2026-11-01/);
  // The ATS board path keeps scout-web's robots-gated fetcher.
  assert.match(source, /const fetchBoard = makeFetchBoard\(\);/);
});

test("LinkedIn job link: read through the public guest endpoint by its id, no plain fetch, no render", async () => {
  const guest = "https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/4012345678";
  // The plain page would fail; only the guest endpoint answers.
  const { deps, fetched, renders } = makeDeps({ pageFails: true, pages: { [guest]: { ok: true, html: `<section><h2>Backend Engineer</h2><div>${POST_TEXT}</div></section>` } } });
  // The slug form search engines show, with tracking junk.
  const res = await handleJobLinkIntake(post({ url: "https://in.linkedin.com/jobs/view/backend-engineer-at-globex-4012345678/?refId=abc" }), deps);
  const body = await res.json();
  assert.equal(res.status, 200);
  // The response contract's closed union is unchanged.
  assert.equal(body.source, "page");
  // The adapter's endpoint was the first and only fetch.
  assert.deepEqual(fetched, [guest]);
  assert.equal(renders.length, 0);
});

test("linkedInGuestUrl: /jobs/view ids and currentJobId, digits only, LinkedIn hosts only", () => {
  assert.equal(linkedInGuestUrl(new URL("https://www.linkedin.com/jobs/view/4012345678/")), "https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/4012345678");
  assert.equal(linkedInGuestUrl(new URL("https://www.linkedin.com/jobs/collections/recommended/?currentJobId=4099")), "https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/4099");
  // Non-digit ids, non-job pages and lookalike hosts are refused, never encoded into a URL.
  for (const bad of ["https://www.linkedin.com/jobs/search/?currentJobId=12a", "https://www.linkedin.com/jobs/search/?currentJobId=..%2F1", "https://www.linkedin.com/posts/globex-hiring", "https://evillinkedin.com/jobs/view/123", "https://linkedin.com.evil.io/jobs/view/123"]) {
    assert.equal(linkedInGuestUrl(new URL(bad)), null, bad);
  }
});

test("X post link: the oEmbed post text is read, and a short post follows its first outbound link once", async () => {
  const oembed = "https://publish.x.com/oembed?url=https%3A%2F%2Fx.com%2Fglobex%2Fstatus%2F1850000000000000000&omit_script=true&dnt=true";
  // The live oEmbed shape (curl, 2026-11-01): a hashtag link, a t.co link, then the permalink.
  const html = `<blockquote class="twitter-tweet"><p>We're hiring a Backend Engineer! <a href="https://twitter.com/hashtag/hiring">#hiring</a> <a href="https://t.co/AbC123">t.co/AbC123</a></p>&mdash; Globex (@globex) <a href="https://x.com/globex/status/1850000000000000000?ref_src=twsrc%5Etfw">November 1, 2026</a></blockquote>`;
  const { deps, fetched, renders, spy } = makeDeps({ pageFails: true, pages: { [oembed]: { ok: true, html: JSON.stringify({ html, author_name: "Globex" }) }, "https://t.co/AbC123": { ok: true, html: `<main>${POST_TEXT}</main>` } } });
  // The old host and a share-tracking query string.
  const res = await handleJobLinkIntake(post({ url: "https://twitter.com/globex/status/1850000000000000000?s=20" }), deps);
  assert.equal(res.status, 200);
  // oEmbed, then the first link leaving X (not the hashtag, not the permalink), and nothing else.
  assert.deepEqual(fetched, [oembed, "https://t.co/AbC123"]);
  assert.equal(renders.length, 0);
  // Post text first, then the linked page's.
  assert.match(String(spy.jobs[0]?.description_raw), /^We're hiring a Backend Engineer![\s\S]*Globex in Hyderabad/);
});

test("parseOembed: positive shape only; xOembedUrl: posts only, query string dropped", () => {
  // Not JSON, no html string, not an object: each a failure, never an empty post.
  assert.equal(parseOembed("<html>rate limited</html>").ok, false);
  assert.equal(parseOembed(JSON.stringify({ html: null })).ok, false);
  assert.equal(parseOembed(JSON.stringify([])).ok, false);
  // A post whose only link is its own permalink has no outbound link.
  const own = parseOembed(JSON.stringify({ html: '<p>Hello world</p><a href="https://x.com/a/status/1">d</a>' }));
  assert.ok(own.ok);
  assert.equal(own.link, null);
  assert.match(own.text, /Hello world/);
  // Rebuilt from handle + id.
  assert.equal(xOembedUrl(new URL("https://x.com/globex/status/123?s=20")), "https://publish.x.com/oembed?url=https%3A%2F%2Fx.com%2Fglobex%2Fstatus%2F123&omit_script=true&dnt=true");
  // A profile and a lookalike host are not posts.
  assert.equal(xOembedUrl(new URL("https://x.com/globex")), null);
  assert.equal(xOembedUrl(new URL("https://notx.com/globex/status/123")), null);
});

test("render: a page the plain fetch cannot read is opened by the browser service, as the caller", async () => {
  const { deps, renders, spy } = makeDeps({ pageFails: true, render: RENDER_OK });
  const res = await handleJobLinkIntake(post({ url: "https://careers.example.com/job/1" }), deps);
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.source, "page");
  // Exactly one call, to the agreed endpoint.
  assert.equal(renders.length, 1);
  assert.equal(renders[0]?.url, RENDER_URL);
  // The caller's own token, so the renderer can check who is asking.
  assert.equal((renders[0]?.init.headers as Record<string, string>)["authorization"], "Bearer good");
  assert.deepEqual(JSON.parse(String(renders[0]?.init.body)), { url: "https://careers.example.com/job/1" });
  // A timeout signal rides along: the renderer can never hold the request past its budget.
  assert.ok(renders[0]?.init.signal instanceof AbortSignal);
  // The request carries the JWT, so a redirect must fail rather than re-send it (security review 2026-11-01).
  assert.equal(renders[0]?.init.redirect, "error");
  // The rendered text is what the matcher and tailor read, and the row says how it was read.
  assert.equal(spy.jobs[0]?.description_raw, RENDERED_TEXT.trim());
  assert.equal(spy.jobs[0]?.source_refs?.[0]?.metadata?.["read_via"], "render");
});

test("render: a plain fetch that returns a JS shell is re-read by the browser", async () => {
  const { deps, renders, fetched, spy } = makeDeps({ html: SHELL, render: RENDER_OK });
  const res = await handleJobLinkIntake(post({ url: "https://careers.example.com/job/1" }), deps);
  assert.equal(res.status, 200);
  // One plain fetch, one render, no more.
  assert.equal(fetched.length, 1);
  assert.equal(renders.length, 1);
  assert.equal(spy.jobs[0]?.description_raw, RENDERED_TEXT.trim());
});

test("render: an answer that is not 200 + {status:'ok', text:string} is a failure (needs_text), never ok", async () => {
  // Wrong status word, missing text, non-string text, and a success body on an error status.
  const bad = [
    { status: 200, body: { status: "refused", text: RENDERED_TEXT } },
    { status: 200, body: { status: "ok", final_url: "https://careers.example.com/job/1" } },
    { status: 200, body: { status: "ok", text: 42 } },
    { status: 500, body: { status: "ok", text: RENDERED_TEXT } },
  ];
  for (const render of bad) {
    const { deps, spy } = makeDeps({ pageFails: true, render });
    const res = await handleJobLinkIntake(post({ url: "https://careers.example.com/job/1" }), deps);
    assert.equal(res.status, 422, JSON.stringify(render));
    assert.equal((await res.json()).status, "needs_text", JSON.stringify(render));
    // Nothing reached Gemini or the table.
    assert.equal(spy.extracts + spy.jobs.length, 0, JSON.stringify(render));
  }
});

test("not_a_job on plain-fetched text: the browser renders it once and Gemini reads it once more", async () => {
  // First read says "not a job" (a JS shell around the posting); the rendered read finds the job.
  const { deps, spy, renders, prompts } = makeDeps({ extractSeq: [NOT_A_JOB, geminiAnswer(GOOD_FIELDS)], render: RENDER_OK });
  const res = await handleJobLinkIntake(post({ url: "https://careers.example.com/job/1" }), deps);
  assert.equal(res.status, 200);
  assert.equal(renders.length, 1);
  assert.equal(spy.extracts, 2);
  // The second read is of the rendered page, and so is the stored description.
  assert.match(prompts[1] ?? "", /Initech/);
  assert.equal(spy.jobs[0]?.description_raw, RENDERED_TEXT.trim());
});

test("caps: still 'not a job' after its render is refused after one render and two extracts", async () => {
  const { deps, spy, renders } = makeDeps({ extract: NOT_A_JOB, render: RENDER_OK });
  const res = await handleJobLinkIntake(post({ url: "https://careers.example.com/job/1" }), deps);
  assert.equal(res.status, 422);
  assert.equal((await res.json()).status, "not_a_job");
  assert.equal(renders.length, 1);
  assert.equal(spy.extracts, 2);
  assert.equal(spy.jobs.length, 0);
});

test("caps: rendered or pasted text the model calls 'not a job' is never rendered again", async () => {
  // Already rendered (the plain fetch failed): no second render, no second extract.
  const rendered = makeDeps({ pageFails: true, extract: NOT_A_JOB, render: RENDER_OK });
  assert.equal((await handleJobLinkIntake(post({ url: "https://careers.example.com/job/1" }), rendered.deps)).status, 422);
  assert.equal(rendered.renders.length, 1);
  assert.equal(rendered.spy.extracts, 1);
  // The human's own text: no render at all.
  const pasted = makeDeps({ extract: NOT_A_JOB, render: RENDER_OK });
  assert.equal((await handleJobLinkIntake(post({ url: "https://careers.example.com/job/1", text: POST_TEXT }), pasted.deps)).status, 422);
  assert.equal(pasted.renders.length, 0);
  assert.equal(pasted.spy.extracts, 1);
});

test("refusal wording: needs_text and not_a_job say what failed and never ask for pasted text", async () => {
  // Unreadable page, JS shell (both with the default failing renderer), and a pasted non-job.
  const unreadable = await (await handleJobLinkIntake(post({ url: "https://careers.example.com/job/1" }), makeDeps({ pageFails: true }).deps)).json();
  const shell = await (await handleJobLinkIntake(post({ url: "https://careers.example.com/job/1" }), makeDeps({ html: SHELL }).deps)).json();
  const notJob = await (await handleJobLinkIntake(post({ url: "https://careers.example.com/jobs", text: POST_TEXT }), makeDeps({ extract: NOT_A_JOB }).deps)).json();
  // POSITIVE shape (§6): the new wording, with every rung's reason.
  assert.equal(unreadable.message, "Could not read that page, even with a browser (HTTP 403 Forbidden; the browser could not open it: no browser in tests).");
  assert.equal(shell.message, "Could not read that page, even with a browser (almost no readable text (it may need a login or JavaScript); the browser could not open it: no browser in tests).");
  assert.equal(notJob.message, "That does not look like a single job posting. Try the link to the job's own page instead.");
  // Status codes and field names unchanged: the web panel and ingest-links.yml parse them.
  assert.deepEqual([unreadable.status, shell.status, notJob.status], ["needs_text", "needs_text", "not_a_job"]);
  // And the UI has no paste box any more, so none of them asks for one.
  for (const m of [unreadable.message, shell.message, notJob.message]) assert.doesNotMatch(m, /paste/i);
});

test("ATS link whose board cannot be read: falls through to the page ladder instead of a 502", async () => {
  const { deps, spy, fetched } = makeDeps({ boardFails: true });
  const res = await handleJobLinkIntake(post({ url: "https://job-boards.greenhouse.io/acme/jobs/111" }), deps);
  const body = await res.json();
  assert.equal(res.status, 200);
  // Read as a page, so no board data and no adapter claimed.
  assert.equal(body.source, "page");
  assert.equal(spy.boardFetches, 1);
  assert.deepEqual(fetched, ["https://job-boards.greenhouse.io/acme/jobs/111"]);
  assert.equal(spy.jobs[0]?.ats_provider, "unknown");
});

// --- Confirms before adding (2026-11-05): leak 2, then Teja's ruling of 14:12 IST ---
// A pasted link used to (a) silently revive a row the screener had dropped (Scale AI 461f9f6b,
// dropped work_auth "San Francisco, CA", revived 11-01, approved 11-05) and (b) skip every filter
// for a NEW job (xAI 0c9fdc58, "Palo Alto, CA", reached the queue). Teja ruled "Warn, let me
// confirm": both now answer 409 needs_confirm with a reason from a closed union, nothing is
// written, and the browser re-sends with confirm: [reasons] only after an inline "Add anyway?".

// Teja's live work-auth config.
const TEJA_WORK_AUTH = { countries: ["India", "Nepal", "Bhutan"], policy: "unlocked_or_authorized" as const };
// A board whose one posting is xAI's internship in Palo Alto.
const PALO_ALTO_BOARD = { jobs: [{ ...GH_BOARD.jobs[0], title: "Summer 2027 Software Engineering Internship", location: { name: "Palo Alto, CA" } }] };

test("parseIntakeBody: confirm is a list from the closed union, and anything else is refused", () => {
  // Both reasons.
  const both = parseIntakeBody({ url: "https://job-boards.greenhouse.io/acme/jobs/111", confirm: ["work_auth", "revive_dropped"] });
  // Accepted as a set.
  assert.ok(both.ok && both.value.confirmed.has("work_auth") && both.value.confirmed.has("revive_dropped"));
  // Absent: the normal first paste, nothing confirmed.
  const none = parseIntakeBody({ url: "https://job-boards.greenhouse.io/acme/jobs/111" });
  // Empty.
  assert.ok(none.ok && none.value.confirmed.size === 0);
  // A reason outside the union, a string instead of a list, or a non-string entry: 400, never ignored.
  for (const confirm of [["tech"], "work_auth", [true]]) assert.equal(parseIntakeBody({ url: "https://job-boards.greenhouse.io/acme/jobs/111", confirm }).ok, false, JSON.stringify(confirm));
});

test("handler: a NEW Palo Alto paste answers 409 needs_confirm work_auth and writes nothing", async () => {
  // xAI's posting, Teja's config.
  const { deps, runs, spy } = makeDeps({ board: PALO_ALTO_BOARD, store: { workAuth: TEJA_WORK_AUTH } });
  // The first paste.
  const res = await handleJobLinkIntake(post({ url: "https://job-boards.greenhouse.io/acme/jobs/111" }), deps);
  // The envelope.
  const body = await res.json();
  // A question, not a failure.
  assert.deepEqual([res.status, body.status, body.reason], [409, "needs_confirm", "work_auth"]);
  // The gate's own words, then the question.
  assert.match(body.message, /Palo Alto, CA.*outside the work-authorised countries.*Add it anyway\?/s);
  // Nothing was written: no job row, no application, no run.
  assert.deepEqual([spy.jobs.length, runs.length], [0, 0]);
});

test("handler: the same paste confirmed adds the job and records the override as a human note", async () => {
  // Same posting and config.
  const { deps, runs, spy } = makeDeps({ board: PALO_ALTO_BOARD, store: { workAuth: TEJA_WORK_AUTH } });
  // Confirmed.
  const res = await handleJobLinkIntake(post({ url: "https://job-boards.greenhouse.io/acme/jobs/111", confirm: ["work_auth"] }), deps);
  // The envelope.
  const body = await res.json();
  // Added and running.
  assert.deepEqual([res.status, body.status, runs.length], [200, "ok", 1]);
  // The override is on the record: which gate, its code and its words.
  assert.equal(spy.notes?.[0]?.detail["overrode"], "work_auth");
  // The gate's code.
  assert.match(String(spy.notes?.[0]?.detail["code"]), /^work_auth/);
});

test("handler: an India location asks nothing", async () => {
  // The default board's posting is in Bengaluru.
  const { deps, spy } = makeDeps({ store: { workAuth: TEJA_WORK_AUTH } });
  // The paste.
  const res = await handleJobLinkIntake(post({ url: "https://job-boards.greenhouse.io/acme/jobs/111" }), deps);
  // Added straight away.
  assert.equal((await res.json()).status, "ok");
  // And no override was recorded, because none happened.
  assert.equal(spy.notes, undefined);
});

test("handler: an unreadable work-auth config refuses the paste (503) rather than skipping the gate", async () => {
  // The read fails.
  const { deps, spy } = makeDeps({ board: PALO_ALTO_BOARD, store: { workAuth: { fail: "db down" } } });
  // The paste.
  const res = await handleJobLinkIntake(post({ url: "https://job-boards.greenhouse.io/acme/jobs/111" }), deps);
  // Refused, nothing written.
  assert.deepEqual([res.status, spy.jobs.length], [503, 0]);
});

test("persistManualJob: Scale's dropped row is NOT revived without a confirm, and says why it was dropped", async () => {
  const spy: Spy = { jobs: [], tags: [], moves: [], pageFetches: 0, boardFetches: 0, extracts: 0 };
  // Scale's shape: scouted by greenhouse, dropped for work_auth.
  const store = fakeStore(spy, { existing: { discoveredVia: ["greenhouse"] }, application: { id: "461f9f6b-7102-4723-bac5-d3df17ac80c5", status: "dropped_filter", created: false, dropReason: "work_auth" } });
  // Nothing confirmed.
  const saved = await persistManualJob(store, { fingerprint: "fp", title: "t", company_name: "Scale AI", company_slug: "scaleai", apply_url: "https://x.example/j", location_raw: "San Francisco, CA", posted_at: "2026-10-31T00:00:00Z", discovered_via: ["manual"] }, "https://x.example/j", new Set());
  // Not revived: the caller must ask.
  assert.deepEqual(saved, { ok: false, confirmNeeded: true, dropReason: "work_auth" });
  // The status never moved.
  assert.deepEqual(spy.moves, []);
});

test("persistManualJob: with revive_dropped confirmed, the row is revived and the event records the overridden reason", async () => {
  const spy: Spy = { jobs: [], tags: [], moves: [], pageFetches: 0, boardFetches: 0, extracts: 0 };
  // Same row.
  const store = fakeStore(spy, { existing: { discoveredVia: ["greenhouse"] }, application: { id: "461f9f6b-7102-4723-bac5-d3df17ac80c5", status: "dropped_filter", created: false, dropReason: "work_auth" } });
  // Confirmed.
  const saved = await persistManualJob(store, { fingerprint: "fp", title: "t", company_name: "c", company_slug: "c", apply_url: "https://x.example/j", posted_at: "2026-10-31T00:00:00Z", discovered_via: ["manual"] }, "https://x.example/j", new Set(["revive_dropped"]));
  // Moved.
  assert.ok(saved.ok && saved.revivedFrom === "dropped_filter");
  // The override is on the record, beside the reason it overrode.
  assert.equal(spy.moves[0]?.detail["overrode_drop_reason"], "work_auth");
});

test("handler: pasting Scale's dropped link answers 409 needs_confirm revive_dropped with the reason, and runs nothing", async () => {
  // The dropped row behind the paste (the board's location is India, so the work-auth gate passes).
  const { deps, runs, spy } = makeDeps({ store: { existing: { discoveredVia: ["greenhouse"] }, application: { id: "461f9f6b-7102-4723-bac5-d3df17ac80c5", status: "dropped_filter", created: false, dropReason: "work_auth" } } });
  // No confirm.
  const res = await handleJobLinkIntake(post({ url: "https://job-boards.greenhouse.io/acme/jobs/111" }), deps);
  // The envelope.
  const body = await res.json();
  // Its own reason.
  assert.deepEqual([res.status, body.status, body.reason, body.drop_reason], [409, "needs_confirm", "revive_dropped", "work_auth"]);
  // In words too.
  assert.match(body.message, /dropped earlier \(work_auth\)/);
  // Nothing moved and nothing runs.
  assert.deepEqual([spy.moves, runs], [[], []]);
});

test("handler: a row dropped FOR work_auth asks once: confirming work_auth also confirms its revive", async () => {
  // Scale's real shape: San Francisco, dropped work_auth, Teja's config.
  const { deps, runs } = makeDeps({ board: { jobs: [{ ...GH_BOARD.jobs[0], location: { name: "San Francisco, CA" } }] }, store: { workAuth: TEJA_WORK_AUTH, existing: { discoveredVia: ["greenhouse"] }, application: { id: "461f9f6b-7102-4723-bac5-d3df17ac80c5", status: "dropped_filter", created: false, dropReason: "work_auth" } } });
  // Confirmed once, for the gate's question.
  const res = await handleJobLinkIntake(post({ url: "https://job-boards.greenhouse.io/acme/jobs/111", confirm: ["work_auth"] }), deps);
  // Revived without a second question.
  assert.deepEqual([res.status, (await res.json()).revived_from, runs.length], [200, "dropped_filter", 1]);
});
