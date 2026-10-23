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
