// Tests for fetchPage (feed liveness, 2026-11-07). The apply_url comes from a third-party feed, so the
// probe is an SSRF surface. These pin the guard: every hop, redirects included, is shape-, DNS- and
// address-checked before ANY request (robots.txt included), robots.txt is read from the checked
// address and never followed through a redirect, and a 404 surfaces as a typed HttpError.
import { test } from "node:test";
// Strict, so a missing field never compares equal.
import assert from "node:assert/strict";
// The unit under test.
import { fetchPage, type PageProbeDeps } from "./page-fetch.ts";
// The typed errors the probe must surface.
import { HttpError, RobotsDisallowedError } from "../_shared/http/index.ts";
// A fresh verdict cache per test, so one test's robots answer never leaks into another.
import type { RobotsCache } from "../../../packages/master-robots/src/index.ts";

// Fake deps: a public address for every name, no robots.txt (404 = no rules), a 200 page, every
// request recorded. Tests override what they exercise.
function deps(calls: string[], over: Partial<PageProbeDeps> = {}): PageProbeDeps {
  return {
    // 93.184.216.34 is a public address (example.com's historic one).
    resolve: async () => ["93.184.216.34"],
    // robots.txt absent (pinned-get's null = 404), any page a 200; both recorded.
    hop: async (url) => { calls.push(url); return url.endsWith("/robots.txt") ? null : new Response("<html>posting</html>", { status: 200 }); },
    // Isolated from every other test.
    robotsCache: new Map() as RobotsCache,
    // The test's own overrides win.
    ...over,
  };
}

test("fetchPage: a host resolving to a private address is never contacted, robots.txt included (SSRF)", async () => {
  // Every request made.
  const calls: string[] = [];
  // evil.test points at the cloud metadata address.
  const res = await fetchPage("https://evil.test/jobs/1", deps(calls, { resolve: async () => ["169.254.169.254"] }));
  // Unknown: neither gone nor live.
  assert.equal(res, null);
  // Not even robots.txt was fetched.
  assert.deepEqual(calls, []);
});

test("fetchPage: a redirect to a private host is refused before the second hop (SSRF)", async () => {
  // Every request made.
  const calls: string[] = [];
  // The page redirects to localhost; robots.txt is absent.
  const hop = async (url: string) => { calls.push(url); return url.endsWith("/robots.txt") ? null : new Response(null, { status: 302, headers: { location: "https://localhost/admin" } }); };
  // Refused: unknown.
  assert.equal(await fetchPage("https://jobs.example.com/1", deps(calls, { hop })), null);
  // Only the public host was contacted: its robots.txt, then its page.
  assert.deepEqual(calls, ["https://jobs.example.com/robots.txt", "https://jobs.example.com/1"]);
});

test("fetchPage: a robots.txt redirect is refused, never followed (SSRF via robots)", async () => {
  // Every request made.
  const calls: string[] = [];
  // robots.txt redirects to the metadata address.
  const hop = async (url: string) => { calls.push(url); return new Response(null, { status: 301, headers: { location: "http://169.254.169.254/latest/meta-data/" } }); };
  // Refused by robots (indeterminate refuses), so the page is never asked for.
  await assert.rejects(fetchPage("https://jobs.example.com/1", deps(calls, { hop })), RobotsDisallowedError);
  // Only the robots.txt request; the redirect target was never contacted.
  assert.deepEqual(calls, ["https://jobs.example.com/robots.txt"]);
});

test("fetchPage: a robots Disallow is thrown before the page is requested", async () => {
  // Every request made.
  const calls: string[] = [];
  // robots.txt disallows everything.
  const hop = async (url: string) => { calls.push(url); return new Response("User-agent: *\nDisallow: /\n", { status: 200, headers: { "content-type": "text/plain" } }); };
  // Refused.
  await assert.rejects(fetchPage("https://jobs.example.com/1", deps(calls, { hop })), RobotsDisallowedError);
  // The page itself was never asked for.
  assert.deepEqual(calls, ["https://jobs.example.com/robots.txt"]);
});

test("fetchPage: a 404 page surfaces as HttpError 404, the signal feed liveness retires on", async () => {
  // Both robots.txt and the page answer 404 (pinned-get's null).
  await assert.rejects(fetchPage("https://jobicy.com/jobs/1", deps([], { hop: async () => null })), (e: unknown) => e instanceof HttpError && e.status === 404);
});

test("fetchPage: a public 200 page is a 200 response", async () => {
  // The live case.
  assert.equal((await fetchPage("https://jobicy.com/jobs/1", deps([])))?.status, 200);
});
