// job-link-intake handler: the request gates, the ATS-vs-page decision, and the revive rule.
// Run with: node --test "supabase/functions/job-link-intake/*.test.ts"
import { test } from "node:test";
import assert from "node:assert/strict";
import { atsTarget, handleJobLinkIntake, needsChain, parseIntakeBody, persistManualJob, REVIVE_FROM, type IntakeDeps, type IntakeStore, type StoredApplication } from "./handler.ts";
import type { JobInsert } from "../_shared/contracts/shared-types.ts";
// Moved to fetch-page.ts (2026-10-31) so redirect hops share it; still pinned here for the pasted link.
import { isBlockedHost } from "./fetch-page.ts";

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
}

// A fake store honouring the real contract: values, never throws.
function fakeStore(spy: Spy, opts: { existing?: { discoveredVia: string[]; disappearedAt?: string | null; descriptionRaw?: string | null }; application?: StoredApplication; moveError?: string | null } = {}): IntakeStore {
  // Mirrors the real store's read-back.
  return {
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

// Deps with every seam faked; options flip the branch under test.
function makeDeps(opts: { killOn?: boolean; pageFails?: boolean; html?: string; extract?: unknown; store?: Parameters<typeof fakeStore>[1]; board?: unknown } = {}): { deps: IntakeDeps; spy: Spy; runs: string[] } {
  const spy: Spy = { jobs: [], tags: [], moves: [], pageFetches: 0, boardFetches: 0, extracts: 0 };
  // Every server pipeline run the handler started, in order (kept off Spy so its literals stay valid).
  const runs: string[] = [];
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
      // The default board, unless a test serves one with a different posting.
      return Promise.resolve({ ok: true as const, payload: opts.board ?? GH_BOARD });
    },
    fetchPage: () => {
      // Counted so the pasted-text path can prove it never fetched.
      spy.pageFetches += 1;
      return Promise.resolve(opts.pageFails ? { ok: false as const, reason: "the site does not allow automated reading" } : { ok: true as const, html: opts.html ?? `<html><body><p>${POST_TEXT}</p></body></html>` });
    },
    extract: () => {
      // Counted so the ATS path can prove it spent no Gemini call.
      spy.extracts += 1;
      return Promise.resolve((opts.extract ?? geminiAnswer(GOOD_FIELDS)) as Awaited<ReturnType<IntakeDeps["extract"]>>);
    },
    now: () => new Date("2026-10-31T10:00:00Z"),
  };
  return { deps, spy, runs };
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

test("REVIVE_FROM is exactly the three statuses the migration gives a human edge into passed_filters", () => {
  assert.deepEqual([...REVIVE_FROM].sort(), ["deduped", "discovered", "dropped_filter"]);
});

test("persistManualJob: a scouted row a filter dropped is tagged manual, then moved back as the human", async () => {
  const spy: Spy = { jobs: [], tags: [], moves: [], pageFetches: 0, boardFetches: 0, extracts: 0 };
  const store = fakeStore(spy, { existing: { discoveredVia: ["greenhouse"] }, application: { id: "app-9", status: "dropped_filter", created: false } });
  const saved = await persistManualJob(store, { fingerprint: "fp", title: "t", company_name: "c", company_slug: "c", apply_url: "https://x.example/j", posted_at: "2026-10-31T00:00:00Z", discovered_via: ["manual"] }, "https://x.example/j");
  assert.ok(saved.ok);
  assert.equal(saved.revivedFrom, "dropped_filter");
  assert.equal(saved.application.status, "passed_filters");
  assert.deepEqual(spy.tags, [["greenhouse", "manual"]]);
  assert.equal(spy.moves[0]?.detail["reason"], "pasted_link");
});

test("persistManualJob: a row already at the approval queue is left exactly where it is", async () => {
  const spy: Spy = { jobs: [], tags: [], moves: [], pageFetches: 0, boardFetches: 0, extracts: 0 };
  const store = fakeStore(spy, { existing: { discoveredVia: ["manual"] }, application: { id: "app-9", status: "awaiting_approval", created: false } });
  const saved = await persistManualJob(store, { fingerprint: "fp", title: "t", company_name: "c", company_slug: "c", apply_url: "https://x.example/j", posted_at: "2026-10-31T00:00:00Z" }, "https://x.example/j");
  assert.ok(saved.ok);
  assert.equal(saved.revivedFrom, null);
  assert.equal(spy.moves.length, 0);
  assert.equal(spy.tags.length, 0);
});

test("persistManualJob: a refused move is reported, never claimed as moved", async () => {
  const spy: Spy = { jobs: [], tags: [], moves: [], pageFetches: 0, boardFetches: 0, extracts: 0 };
  const store = fakeStore(spy, { existing: { discoveredVia: ["manual"] }, application: { id: "app-9", status: "dropped_filter", created: false }, moveError: "illegal transition" });
  const saved = await persistManualJob(store, { fingerprint: "fp", title: "t", company_name: "c", company_slug: "c", apply_url: "https://x.example/j", posted_at: "2026-10-31T00:00:00Z" }, "https://x.example/j");
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
  const saved = await persistManualJob(store, pastedRow(POST_TEXT.trim()), "https://x.example/j");
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
  const saved = await persistManualJob(store, pastedRow(POST_TEXT.trim()), "https://x.example/j");
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
  const saved = await persistManualJob(store, pastedRow(POST_TEXT.trim()), "https://x.example/j");
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
  const saved = await persistManualJob(store, pastedRow("   "), "https://x.example/j");
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
  assert.match(source, /\.\.\.\(descriptionRaw !== null \? \{ description_raw: descriptionRaw \} : \{\}\)/);
});
