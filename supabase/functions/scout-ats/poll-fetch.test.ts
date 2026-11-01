// Node test runner, repo convention for pure/stub-level function tests.
import { afterEach, test } from "node:test";
// Bare asserts, no framework.
import assert from "node:assert/strict";
// The LIVE poll fetch (the same function index.ts calls), not a re-spelled copy.
import { fetchBoard } from "./poll-fetch.ts";
// The typed refusal the robots gate throws pre-contact.
import { RobotsDisallowedError } from "../_shared/http/index.ts";
// Isolated verdict cache per test; the transport's module-level cache outlives a test.
import type { RobotsCache } from "../../../packages/master-robots/src/index.ts";

// Captured at module load so afterEach restores the REAL global, not a prior stub.
const originalFetch = globalThis.fetch;
// A leaked stub poisons later test files in the same node process: always restore.
afterEach(() => {
  globalThis.fetch = originalFetch;
});

// Script globalThis.fetch: /robots.txt answers with the given body, anything else is
// "the target" and is counted — the count is what makes the refusal test non-vacuous.
function scriptedFetch(robotsBody: string): { targetCalls: number; robotsCalls: number } {
  // Mutated by the stub, read by the test after the awaited call settles.
  const state = { targetCalls: 0, robotsCalls: 0 };
  // The gate fetches robots.txt through the bare global fetch, so one stub serves both.
  globalThis.fetch = (async (url: string | URL | Request) => {
    // The gate's own fetch, answered with the scripted policy.
    if (String(url).endsWith("/robots.txt")) {
      state.robotsCalls++;
      return new Response(robotsBody, { status: 200, headers: { "content-type": "text/plain" } });
    }
    // Everything else is the board endpoint the poll wants.
    state.targetCalls++;
    return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return state;
}

test("the ATS poll fetch refuses a robots-disallowed path without contacting the target", async () => {
  // A policy that forbids everything to every agent.
  const state = scriptedFetch("User-agent: *\nDisallow: /");
  // Own cache: verdicts must not leak in from other tests or out to them.
  const cache: RobotsCache = new Map();
  // The refusal is typed and thrown BEFORE any board contact.
  await assert.rejects(() => fetchBoard("https://boards.example.com/v1/boards/acme/jobs", cache), RobotsDisallowedError);
  // The whole point: the disallowed target was never contacted.
  assert.equal(state.targetCalls, 0);
  // Non-vacuous: the gate really did fetch and read the policy (a dead gate would
  // show robotsCalls 0 and this line is what catches that).
  assert.equal(state.robotsCalls, 1);
});

test("an allowing robots answer lets the poll proceed", async () => {
  // The inverse control: an explicit allow-everything policy.
  const state = scriptedFetch("User-agent: *\nAllow: /");
  // Own cache again, same isolation reason.
  const cache: RobotsCache = new Map();
  // The poll goes through and hands back the board's response.
  const response = await fetchBoard("https://boards.example.com/v1/boards/acme/jobs", cache);
  // A real, ok response — not null (that shape needs a notFound override we don't use).
  assert.ok(response !== null && response.ok);
  // Exactly one board contact.
  assert.equal(state.targetCalls, 1);
});

// --- POST boards (Workday, 2026-11-01): a body means POST JSON, no body means GET ---

// Like scriptedFetch, but keeps every request init the BOARD endpoint received, so a
// test can assert the method, headers and body the transport actually sent.
function capturingFetch(robotsBody: string): { targetInits: RequestInit[]; robotsCalls: number } {
  // Mutated by the stub, read after the awaited call settles.
  const state = { targetInits: [] as RequestInit[], robotsCalls: 0 };
  // One stub serves the gate's robots fetch and the board fetch, as above.
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    // The gate's own policy fetch.
    if (String(url).endsWith("/robots.txt")) {
      // Counted, so a dead gate shows up as 0.
      state.robotsCalls++;
      // The scripted policy.
      return new Response(robotsBody, { status: 200, headers: { "content-type": "text/plain" } });
    }
    // The board request: keep exactly what was sent.
    state.targetInits.push(init ?? {});
    // A minimal JSON body.
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  // Handed back for the assertions.
  return state;
}

test("a page with a body is POSTed as JSON through the gated transport", async () => {
  // Allow-all policy, so the request reaches the board.
  const state = capturingFetch("User-agent: *\nAllow: /");
  // The body a Workday page sends.
  const body = JSON.stringify({ appliedFacets: {}, limit: 20, offset: 0, searchText: "" });
  // Through the same function index.ts calls.
  await fetchBoard("https://acme.wd1.myworkdayjobs.com/wday/cxs/acme/Careers/jobs#offset=0", new Map(), body);
  // One board request, POSTed, typed as JSON, carrying the body unchanged.
  assert.equal(state.targetInits.length, 1);
  // The method.
  assert.equal(state.targetInits[0]!.method, "POST");
  // The content type Workday requires.
  assert.equal((state.targetInits[0]!.headers as Record<string, string>)["Content-Type"], "application/json");
  // The body, byte for byte.
  assert.equal(state.targetInits[0]!.body, body);
});

test("a page without a body is the same plain GET as before", async () => {
  // Allow-all policy again.
  const state = capturingFetch("User-agent: *\nAllow: /");
  // No body: every pre-Workday board.
  await fetchBoard("https://boards.example.com/v1/boards/acme/jobs", new Map());
  // One board request.
  assert.equal(state.targetInits.length, 1);
  // A GET, no body key at all, and exactly today's two headers.
  const init = state.targetInits[0]!;
  // The method.
  assert.equal(init.method, "GET");
  // No body property, not even an undefined one.
  assert.equal("body" in init, false);
  // Headers unchanged: no Content-Type crept onto the GET path.
  assert.deepEqual(Object.keys(init.headers as Record<string, string>).sort(), ["Accept", "User-Agent"]);
});

test("a disallowed URL with a body is refused before the board is contacted", async () => {
  // A policy that forbids everything.
  const state = capturingFetch("User-agent: *\nDisallow: /");
  // The POST path must cross the same robots gate as GET.
  await assert.rejects(() => fetchBoard("https://acme.wd1.myworkdayjobs.com/wday/cxs/acme/Careers/jobs#offset=0", new Map(), "{}"), RobotsDisallowedError);
  // Never contacted.
  assert.equal(state.targetInits.length, 0);
  // Non-vacuous: the gate really read the policy.
  assert.equal(state.robotsCalls, 1);
});
