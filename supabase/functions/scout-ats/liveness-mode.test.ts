// Tests for scout-ats `?mode=liveness` (2026-11-18, D4 of docs/audit/2026-11-18-discovery-channels.md).
// The pure decisions live in liveness-mode.ts; the wiring half (the branch returns before any scan
// work, and the sweep writes only liveness marks) is pinned by reading index.ts as text, the same
// style as queue-liveness-wiring.test.ts, because the handler is one Deno.serve closure.
import { describe, it } from "node:test";
// Strict, so a missing anchor never compares equal.
import assert from "node:assert/strict";
// The handler's source, read as text for the wiring half.
import { readFileSync } from "node:fs";
// The units under test.
import { queueBoards, queueReadComplete, resolveScoutMode, SWEEP_QUEUE_STATUSES } from "./liveness-mode.ts";
// The confirmation's own status filter, to pin the sweep's list against it.
import { queueApplicationIds } from "../_shared/scout/queue-liveness.ts";

describe("SWEEP_QUEUE_STATUSES", () => {
  it("equals the statuses queue liveness confirms, across every application status", () => {
    // Every status the applications table can hold (enums.sql application_status), in one job.
    const all = ["discovered", "deduped", "passed_filters", "dropped_filter", "scored", "tailored", "audit_clean", "audit_flagged", "awaiting_approval", "approved", "applying", "blocked_needs_human", "applied", "failed", "rejected"];
    // One application per status, its id the status.
    const job = { id: "j", fingerprint: "f", disappeared_at: null, ats_job_id: null, apply_url: null, applications: all.map((s) => ({ id: s, status: s })) };
    // What queue liveness would confirm, against what the sweep reads.
    assert.deepEqual(queueApplicationIds(job).sort(), [...SWEEP_QUEUE_STATUSES].sort());
  });
});

describe("resolveScoutMode", () => {
  it("no mode is the full scan the web Scan button has always asked for", () => {
    // The browser sends no query params (discoveryService.ts invokeEdge with an empty body).
    assert.equal(resolveScoutMode(null), "scan");
  });

  it("'liveness' is the liveness-only sweep", () => {
    // The daily workflow's value.
    assert.equal(resolveScoutMode("liveness"), "liveness");
  });

  it("an unknown or malformed mode is refused, never a silent full scan (CLAUDE.md §6)", () => {
    // A typo, a case variant, an empty value and the scan word itself are all refused: only absence means scan.
    for (const raw of ["livenes", "LIVENESS", "", " liveness", "scan", "full"]) assert.equal(resolveScoutMode(raw), null, raw);
  });
});

describe("queueReadComplete", () => {
  it("is true only when postgrest's exact count equals the rows it returned", () => {
    // The complete read.
    assert.equal(queueReadComplete(21, 21), true);
    // The 1000-row cap (or any page) cut it short: refuse rather than sweep a partial queue as if whole.
    assert.equal(queueReadComplete(1500, 1000), false);
    // No count at all is not evidence of completeness.
    assert.equal(queueReadComplete(null, 0), false);
  });
});

// Board rows, as the watchlist read selects them (only the fields the grouping reads matter here).
const board = (id: string, ats_provider: string, company_slug: string) => ({ id, ats_provider, company_slug, board_token: id });

describe("queueBoards", () => {
  it("returns each watchlist board holding a queue row once, in watchlist order", () => {
    // Two queue rows on one board, one on another, and an idle third board.
    const out = queueBoards(
      [{ ats_provider: "lever", company_slug: "netomi" }, { ats_provider: "greenhouse", company_slug: "acme" }, { ats_provider: "lever", company_slug: "netomi" }],
      [board("a", "greenhouse", "acme"), board("idle", "ashby", "zed"), board("n", "lever", "netomi")],
    );
    // The idle board is never read: liveness polls only where the queue is.
    assert.deepEqual(out.boards.map((b) => b.id), ["a", "n"]);
    // Nothing skipped.
    assert.deepEqual([out.unmatched, out.ambiguous], [0, 0]);
  });

  it("skips and counts a queue row with no watchlist board (a pasted link) or with two", () => {
    // One row off the watchlist, one row whose provider+slug names two boards.
    const out = queueBoards(
      [{ ats_provider: "greenhouse", company_slug: "pasted" }, { ats_provider: "greenhouse", company_slug: "twin" }],
      [board("t1", "greenhouse", "twin"), board("t2", "greenhouse", "twin")],
    );
    // An ambiguous board is never read: absence from one twin says nothing about the other.
    assert.deepEqual(out.boards, []);
    // Both are counted so the run report says what the sweep could not cover.
    assert.deepEqual([out.unmatched, out.ambiguous], [1, 1]);
  });

  it("matches on provider AND slug, not slug alone", () => {
    // Same slug, different provider: not this board.
    const out = queueBoards([{ ats_provider: "lever", company_slug: "acme" }], [board("a", "greenhouse", "acme")]);
    // Unmatched, not read.
    assert.deepEqual([out.boards.length, out.unmatched], [0, 1]);
  });
});

// THE WIRING HALF. index.ts as text.
const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");

// The offset of a literal anchor, or a named failure when it is gone.
function at(needle: string, from = 0): number {
  // indexOf, so the needle is literal text, not a regex.
  const index = source.indexOf(needle, from);
  // A missing anchor is a failure of its own, named.
  assert.ok(index >= 0, `index.ts no longer contains: ${needle}`);
  // Found.
  return index;
}

describe("scout-ats: mode=liveness wiring", () => {
  it("refuses an unknown mode with a 400 before the caller is authenticated or anything runs", () => {
    // The parse.
    const parse = at('const mode = resolveScoutMode(url.searchParams.get("mode"));');
    // The refusal.
    const refuse = at('if (mode === null) return jsonResponse(400, { error: "unknown_mode"');
    // The sign-in, which costs a password grant.
    const auth = at("const clientResult = await createAuthorizedAppUserClient(req);");
    // Parse, refuse, then auth.
    assert.ok(parse < refuse && refuse < auth, `order wrong: parse@${parse}, refuse@${refuse}, auth@${auth}`);
  });

  it("NAMED: mode=liveness does no board scan: it returns after the kill switch and before the screener, the watchlist poll and the board loop", () => {
    // The kill switch still halts it: liveness writes too.
    const killSwitch = at("if (haltedByKillSwitch(systemEnabled, force)) {");
    // The branch.
    const branch = at('if (mode === "liveness") return await runLivenessSweep(');
    // Everything the full scan does, each after the branch.
    const watchlistPoll = at('.order("last_polled_at", { ascending: true, nullsFirst: true }).limit(limitBoards)');
    const screener = at("const screenContext = await loadScreenContext(");
    const loop = at("for (const board of boards as WatchlistRow[]) {");
    // Kill switch, branch, then the scan.
    assert.ok(killSwitch < branch && branch < watchlistPoll && branch < screener && branch < loop, `order wrong: killSwitch@${killSwitch}, branch@${branch}, poll@${watchlistPoll}, screener@${screener}, loop@${loop}`);
  });

  it("the sweep writes only liveness marks: jobs.disappeared_at and application_events, never an upsert or a watchlist update", () => {
    // The sweep's body, from its declaration to the handler.
    const start = at("async function runLivenessSweep(");
    const end = at("Deno.serve(withCors(", start);
    const body = source.slice(start, end);
    // Every write call in the body, by method.
    const writes = [...body.matchAll(/\.(insert|update|upsert|delete)\(/g)].map((m) => m[1]);
    // The positive shape: the run row's close is found, so the scan below cannot pass on an empty body
    // (the queue and feed marks live in confirmQueueClosures and feedLivenessPass, the scan's own code).
    assert.ok(body.includes('.from("agent_runs").update({ status, error_count'), "sweep body not found or its run close moved");
    assert.ok(writes.length >= 1, `found no writes to judge: ${writes.join(",")}`);
    // No upsert (jobs/applications creation) and no delete, anywhere in the sweep.
    assert.deepEqual(writes.filter((w) => w === "upsert" || w === "delete"), []);
    // Every update targets jobs.disappeared_at or the run row: the watchlist's poll telemetry is never touched.
    for (const m of body.matchAll(/\.from\("([a-z_]+)"\)\s*\.update\(/g)) assert.ok(m[1] === "jobs" || m[1] === "agent_runs", `sweep updates ${m[1]}`);
    // The board listing is read through the robots-gated transport and confirmed through the shared helper.
    assert.ok(body.includes("collectBoardPages(adapter, board.board_token, readBoardPage)"), "sweep does not read the listing through readBoardPage");
    assert.ok(body.includes("await confirmQueueClosures("), "sweep does not confirm through confirmQueueClosures");
  });

  it("refuses a truncated queue read instead of sweeping part of it", () => {
    // The exact count is requested.
    const read = at('applications!inner(id, status)", { count: "exact" })');
    // And compared before any board is read.
    const guard = at("if (!queueReadComplete(queueCount, queueJobs.length))", read);
    // Read, then guard.
    assert.ok(read < guard);
  });
});
