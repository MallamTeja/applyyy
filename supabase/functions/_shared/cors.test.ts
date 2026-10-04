// Tests for the error boundary every pipeline function is served through.
//
// The bug guarded: a thrown error used to reach the platform, whose 500 carries no CORS
// headers, so the browser surfaced a CORS failure instead of the real status.
import { test } from "node:test";
// Strict equality throughout.
import assert from "node:assert/strict";
// Extension-suffixed so this runs under Deno and `node --test` alike.
import { withErrorBoundary } from "./cors.ts";

test("a throwing handler becomes a JSON 500 that still carries CORS headers", async () => {
  // Silence the expected log line so the test output stays readable.
  const originalError = console.error;
  console.error = () => {};
  try {
    const handler = withErrorBoundary("test", () => Promise.reject(new Error("boom")));

    const res = await handler(new Request("https://example.test/"));

    assert.equal(res.status, 500);
    // The header the browser needs to let the page read the status at all.
    assert.equal(res.headers.get("access-control-allow-origin"), "*");
    // Generic body: the error message stays in the server log, not the response.
    assert.deepEqual(await res.json(), { success: false, error: "internal_error" });
  } finally {
    // Restore, so a later test's real error output is not swallowed.
    console.error = originalError;
  }
});

test("a successful handler's response passes through untouched", async () => {
  const ok = new Response("fine", { status: 202 });
  const handler = withErrorBoundary("test", () => Promise.resolve(ok));

  // Same object: the boundary must not rewrap or re-header a healthy response.
  assert.equal(await handler(new Request("https://example.test/")), ok);
});
