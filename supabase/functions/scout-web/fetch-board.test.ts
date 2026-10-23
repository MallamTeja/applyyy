// fetch-board.test.ts — proves the TRANSPORT's robots gate is the control that refuses
// a disallowed board URL through scout-web's fetch path, now that fetch-board.ts no
// longer runs its own pre-check.
//
// RED-ON-REVERT TARGET: these tests are written against DISABLING the transport gate
// for this call (`robots: false` in fetch-board.ts), not against the pre-check's
// deletion. With the gate off, the disallowed test's board call count goes 0 -> 1 and
// its ok:false becomes ok:true — both named assertions go red.

import { afterEach, test } from "node:test";
// Strict, so undefined never quietly compares equal to null.
import assert from "node:assert/strict";

import { makeFetchBoard } from "./fetch-board.ts";

// Captured at module load, so afterEach restores the real global, not a stub.
const originalFetch = globalThis.fetch;

// node --test runs files in one process; a leaked stub would poison later files.
afterEach(() => {
  globalThis.fetch = originalFetch;
});

// Script globalThis.fetch: robots.txt requests get `robots`, everything else is a
// board-API call, counted and answered with `board`. Both the gate's own fetcher
// (master-robots defaultFetcher) and the transport use the bare global fetch, so one
// stub covers the whole path. Path-suffix identification is enough here: no board API
// URL this test drives ever ends in /robots.txt.
function stubFetch(
  robots: () => Response,
  board: () => Response,
): { boardCalls: number; robotsCalls: number } {
  // Shared by reference so assertions read the counts after the awaited call.
  const state = { boardCalls: 0, robotsCalls: 0 };
  globalThis.fetch = (async (url: string | URL | Request) => {
    // The gate's robots fetch, counted separately from target traffic.
    if (String(url).endsWith("/robots.txt")) {
      state.robotsCalls++;
      return robots();
    }
    // Anything else is the board API — the request the gate must be able to stop.
    state.boardCalls++;
    return board();
  }) as unknown as typeof fetch;
  return state;
}

// A policy that names our product token and disallows everything.
const DISALLOW_ALL = "User-agent: applyy-scout\nDisallow: /";

test("a robots-disallowed board URL is refused end-to-end: the transport gate stops it before the board is contacted", async () => {
  // Lever's API origin publishes a policy disallowing applyy-scout entirely.
  const state = stubFetch(
    () => new Response(DISALLOW_ALL, { status: 200, headers: { "content-type": "text/plain" } }),
    () => new Response(JSON.stringify([]), { status: 200, headers: { "content-type": "application/json" } }),
  );
  // Fresh cache per test, so verdicts cannot leak between tests.
  const fetchBoard = makeFetchBoard(new Map());
  const outcome = await fetchBoard("lever", "acme");
  // Refused, with the robots reason taxonomy intact (robots_refuse, not fetch_failed).
  assert.equal(outcome.ok, false);
  assert.match((outcome as { ok: false; reason: string }).reason, /^robots_refuse: /);
  // THE CONTROL: the board itself was never contacted.
  assert.equal(state.boardCalls, 0);
  // Non-vacuity: the gate really consulted robots.txt (0 would mean a vacuous pass).
  assert.equal(state.robotsCalls, 1);
});

test("an allowed board still fetches: no policy published (404) is permission", async () => {
  // The payload the stub serves, echoed back through the seam untouched.
  const payload = { postings: [] };
  const state = stubFetch(
    () => new Response("", { status: 404 }),
    () => new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } }),
  );
  const fetchBoard = makeFetchBoard(new Map());
  const outcome = await fetchBoard("lever", "acme");
  // The normal path survives the pre-check's removal: one board call, payload through.
  assert.deepEqual(outcome, { ok: true, payload });
  assert.equal(state.boardCalls, 1);
});

test("the verdict cache is wired: two boards on one origin ask robots.txt once", async () => {
  const state = stubFetch(
    () => new Response("", { status: 404 }),
    () => new Response("[]", { status: 200, headers: { "content-type": "application/json" } }),
  );
  // One cache across both calls, as index.ts wires it for the whole isolate — the old
  // pre-check passed no cache and so refetched robots.txt once per board per run.
  const fetchBoard = makeFetchBoard(new Map());
  await fetchBoard("lever", "acme");
  await fetchBoard("lever", "globex");
  // Two board fetches, ONE robots fetch: the per-URL refetch is gone.
  assert.equal(state.boardCalls, 2);
  assert.equal(state.robotsCalls, 1);
});
