// The Scan's paced-board budget (drift #2, 2026-11-21): with Workday and iCIMS now paced 1 s per request, a Scan must
// not start a paced board it cannot finish inside the function's budget. Such a board is SKIPPED (named, never
// silently dropped, last_polled_at untouched), so it is first in line next Scan.
import { describe, test } from "node:test";
// Strict comparisons.
import assert from "node:assert/strict";
// Read the handler source for the wiring test (index.ts runs Deno.serve on import).
import { readFileSync } from "node:fs";
// The unit under test.
import { PACED_BOARD_RESERVE_MS, pacedBoardSkip, pacedRequestEstimate } from "./paced-budget.ts";

describe("pacedRequestEstimate", () => {
  test("Workday: one request per 20 postings plus robots.txt, capped at the board's page cap", () => {
    // 101 postings (ghr Lateral-APAC, live 11-21): 6 pages + robots.
    assert.equal(pacedRequestEstimate("workday", 101, 20), 7);
    // An empty board still reads page one.
    assert.equal(pacedRequestEstimate("workday", 0, 20), 2);
    // A huge board stops at the cap.
    assert.equal(pacedRequestEstimate("workday", 5_000, 20), 21);
  });

  test("iCIMS: the sitemap plus one page per job plus robots.txt, capped at the board's page cap", () => {
    // 34 jobs (Atlassian APAC): sitemap + 34 + robots.
    assert.equal(pacedRequestEstimate("icims", 34, 60), 36);
    // Capped.
    assert.equal(pacedRequestEstimate("icims", 500, 60), 61);
  });

  test("an unknown count (never polled) assumes the cap, never zero (missing data is not a small board)", () => {
    // Workday, never polled.
    assert.equal(pacedRequestEstimate("workday", null, 20), 21);
    // iCIMS, never polled.
    assert.equal(pacedRequestEstimate("icims", null, 60), 61);
  });

  test("unpaced providers cost no pacing", () => {
    // Greenhouse, Lever, Ashby: zero.
    for (const provider of ["greenhouse", "lever", "ashby"]) assert.equal(pacedRequestEstimate(provider, 400, 20), 0);
  });
});

describe("pacedBoardSkip", () => {
  test("a paced board that fits runs; one that does not is skipped with the seconds it needs", () => {
    // 7 requests = 7 s + the 15 s reserve = 22 s needed; 60 s left: runs.
    assert.equal(pacedBoardSkip("workday", 101, 20, 60_000), null);
    // 20 s left: skipped, naming the need.
    assert.deepEqual(pacedBoardSkip("workday", 101, 20, 20_000), { needMs: 7_000 + PACED_BOARD_RESERVE_MS, remainingMs: 20_000 });
  });

  test("an unpaced board is never skipped by this guard, however little time is left (today's behaviour)", () => {
    // Greenhouse at 1 s left: not this guard's call.
    assert.equal(pacedBoardSkip("greenhouse", 400, 20, 1_000), null);
  });
});

describe("scout-ats wiring", () => {
  test("the Scan loop asks pacedBoardSkip before reading a board, and a skip is a 'skipped' summary that writes nothing", () => {
    // The handler source.
    const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    // The scan loop, from its header to the board read.
    const start = source.indexOf("// 3. Poll each board");
    // The end marker searched FROM the loop (the liveness sweep above reads boards through the same call).
    const loop = source.slice(start, source.indexOf("const parseResult = await collectBoardPages(adapter, board.board_token, readBoardPage);", start));
    // Non-vacuous: the slice really is the loop.
    assert.ok(start > 0 && loop.length > 200, `loop slice ${loop.length}`);
    // The guard is asked with the board's provider, last count, page cap and the deadline.
    assert.ok(loop.includes("pacedBoardSkip(board.ats_provider, board.last_poll_job_count,"), "guard call");
    // A skip is reported as skipped (not failed, so gate.ts does not count it) and continues before any write.
    assert.ok(/if \(paceSkip !== null\) \{[\s\S]*status: "skipped"[\s\S]*continue;/.test(loop), "skip branch");
    // No watchlist write in the skip branch: last_polled_at stays oldest, so the board is first next Scan.
    assert.ok(!/if \(paceSkip !== null\) \{[^}]*company_watchlist/.test(loop), "skip writes nothing");
  });
});
