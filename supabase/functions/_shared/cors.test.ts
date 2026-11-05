// Tests for _shared/cors.ts: the origin allowlist (P2 #3, 2026-11-05) and the error boundary
// every pipeline function is served through.
//
// The bugs guarded:
//   1. Wildcard CORS: every function answered `Access-Control-Allow-Origin: *`, so any web
//      origin holding a token could read responses from a browser.
//   2. A thrown error reached the platform, whose 500 carries no CORS headers, so the browser
//      surfaced a CORS failure instead of the real status.
//   3. (The trap in fixing 1) refusing a request with NO Origin would block every server caller,
//      Teja's Apps Script included. CORS is a browser control; a server call must still work.
import { test } from "node:test";
// Strict equality throughout.
import assert from "node:assert/strict";
// Extension-suffixed so this runs under Deno and `node --test` alike.
import { allowOriginFor, withCors, withErrorBoundary } from "./cors.ts";

// A request as a browser on `origin` would send it; `null` means a server call (no Origin).
function requestFrom(origin: string | null): Request {
  // Only set the header when there is one: servers send none at all.
  return new Request("https://example.test/", origin === null ? {} : { headers: { origin } });
}

// The production web app gets its own origin echoed back.
test("cors: the production origin is echoed with Vary: Origin", async () => {
  // A trivial handler; the wrapper decides the CORS headers.
  const handler = withCors(() => Promise.resolve(new Response("fine", { status: 200 })));
  // As the deployed web app would call it.
  const res = await handler(requestFrom("https://applyyy.vercel.app"));
  // Exactly the caller's origin, never "*".
  assert.equal(res.headers.get("access-control-allow-origin"), "https://applyyy.vercel.app");
  // Caches must key on Origin, or one origin's answer could be replayed to another.
  assert.equal(res.headers.get("vary"), "Origin");
});

// `vite dev` is the second allowed origin.
test("cors: the local dev origin is allowed", () => {
  // The default vite port.
  assert.deepEqual(allowOriginFor("http://localhost:5173"), { "Access-Control-Allow-Origin": "http://localhost:5173" });
});

// The hardening itself: an unknown browser origin gets no allow header, so its page can't read it.
test("cors: an unlisted origin gets no allow header (and never a wildcard)", async () => {
  // A handler that even tries to set the old wildcard itself.
  const handler = withCors(() => Promise.resolve(new Response("fine", { headers: { "Access-Control-Allow-Origin": "*" } })));
  // Another site, and a look-alike of ours: exact match only.
  for (const origin of ["https://evil.example", "https://applyyy-git-branch.vercel.app", "https://applyyy.vercel.app.evil.example"]) {
    // Each one asks.
    const res = await handler(requestFrom(origin));
    // No allow header at all: the browser blocks the read.
    assert.equal(res.headers.get("access-control-allow-origin"), null, origin);
  }
});

// THE SERVER-CALL CASE: no Origin header (Apps Script, Actions, curl) is answered normally.
test("cors: a server call with no Origin still gets its normal response", async () => {
  // The handler's own answer, e.g. a 200 with a JSON body.
  const handler = withCors(() => Promise.resolve(new Response('{"ok":true}', { status: 200 })));
  // No Origin header, as a server sends it.
  const res = await handler(requestFrom(null));
  // Same status and body: CORS never blocks a server-to-server call.
  assert.equal(res.status, 200);
  // The body reaches the server caller untouched.
  assert.deepEqual(await res.json(), { ok: true });
  // And no allow header, which a server ignores anyway.
  assert.equal(res.headers.get("access-control-allow-origin"), null);
});

// The boundary's 500 is CORS-wrapped too, so the browser can show the real status.
test("a throwing handler becomes a JSON 500 that still carries CORS headers", async () => {
  // Silence the expected log line so the test output stays readable.
  const originalError = console.error;
  // Replaced for the duration of this test only.
  console.error = () => {};
  try {
    // A handler that always throws.
    const handler = withErrorBoundary("test", () => Promise.reject(new Error("boom")));
    // Called from the real web app.
    const res = await handler(requestFrom("https://applyyy.vercel.app"));
    // The boundary's own status.
    assert.equal(res.status, 500);
    // The header the browser needs to let the page read the status at all.
    assert.equal(res.headers.get("access-control-allow-origin"), "https://applyyy.vercel.app");
    // Generic body: the error message stays in the server log, not the response.
    assert.deepEqual(await res.json(), { success: false, error: "internal_error" });
  } finally {
    // Restore, so a later test's real error output is not swallowed.
    console.error = originalError;
  }
});

// A healthy response keeps its status, body and own headers through both wrappers.
test("a successful handler's response passes through with status, body and headers intact", async () => {
  // A response with a header of its own.
  const handler = withErrorBoundary("test", () => Promise.resolve(new Response("fine", { status: 202, headers: { "x-own": "1" } })));
  // From the web app.
  const res = await handler(requestFrom("https://applyyy.vercel.app"));
  // Status kept.
  assert.equal(res.status, 202);
  // The handler's own header kept.
  assert.equal(res.headers.get("x-own"), "1");
  // Body kept.
  assert.equal(await res.text(), "fine");
});
