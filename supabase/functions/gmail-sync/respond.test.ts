// Node test runner, repo convention for pure-function tests.
import { test } from "node:test";
// Bare asserts, no framework.
import assert from "node:assert/strict";
// The pure shaping under test — the same functions index.ts calls.
import { configVerdict, upstreamVerdict } from "./respond.ts";

// A stand-in secret; tests assert it never survives into a response body.
const SECRET = "intake-secret-t3st";

test("gmail-sync refuses plainly while the Web App URL is not configured", () => {
  // Missing URL (the state until Teja deploys the Web App): 503 with a fixed body.
  const missing = configVerdict(null, SECRET);
  assert.equal(missing.ok, false);
  // Narrow for the verdict fields.
  if (!missing.ok) {
    assert.equal(missing.verdict.status, 503);
    assert.deepEqual(missing.verdict.body, { ok: false, error: "gmail sync not configured" });
  }
  // A blank secret is the same refusal — half a config is no config.
  assert.equal(configVerdict("https://script.google.com/macros/s/x/exec", "  ").ok, false);
  // Both present: concrete trimmed values come back.
  const ready = configVerdict(" https://script.google.com/macros/s/x/exec ", SECRET);
  assert.equal(ready.ok, true);
  if (ready.ok) assert.equal(ready.url, "https://script.google.com/macros/s/x/exec");
});

test("gmail-sync maps upstream failure shapes to a fixed 502, never upstream text", () => {
  // Non-200 (Google infra page): fixed error, no echo of the body.
  assert.deepEqual(upstreamVerdict(403, "<html>Forbidden /exec?secret=...</html>", SECRET), { status: 502, body: { ok: false, error: "upstream sync failed" } });
  // 200 but HTML (login redirect landed): the parse failure is an upstream failure.
  assert.equal(upstreamVerdict(200, "<html>sign in</html>", SECRET).status, 502);
  // 200 with JSON of the wrong shape (no boolean ok): fail closed, not "probably fine".
  assert.equal(upstreamVerdict(200, JSON.stringify({ status: "done" }), SECRET).status, 502);
  // The script's own failure: ok false passes through with the FIXED error string,
  // because upstream error text can quote the request (secret included).
  const failed = upstreamVerdict(200, JSON.stringify({ ok: false, error: `bad url ?secret=${SECRET}` }), SECRET);
  assert.deepEqual(failed.body, { ok: false, error: "upstream sync failed" });
});

test("gmail-sync passes a clean sync and an honest cooldown through", () => {
  // A real run: ok with the script's details carried for the drawer.
  const ran = upstreamVerdict(200, JSON.stringify({ ok: true, details: { messagesIngested: 3 } }), SECRET);
  assert.deepEqual(ran, { status: 200, body: { ok: true, details: { messagesIngested: 3 } } });
  // The 60s cooldown skip: ok AND cooldown true, so the dashboard can say "just synced".
  const cooled = upstreamVerdict(200, JSON.stringify({ ok: true, cooldown: true, skipped: true }), SECRET);
  assert.deepEqual(cooled, { status: 200, body: { ok: true, cooldown: true } });
});

test("the secret never reaches the browser, even inside passed-through details", () => {
  // A misconfigured script echoing its request would otherwise hand the browser the
  // secret through the details field — the one field forwarded verbatim.
  const leaked = upstreamVerdict(200, JSON.stringify({ ok: true, details: { echo: `GET /exec?secret=${SECRET}` } }), SECRET);
  // Withheld entirely, with a distinct fixed message.
  assert.deepEqual(leaked, { status: 502, body: { ok: false, error: "upstream response withheld" } });
  // Non-vacuous control: the same shape WITHOUT the secret passes through untouched.
  const clean = upstreamVerdict(200, JSON.stringify({ ok: true, details: { echo: "GET /exec" } }), SECRET);
  assert.equal(clean.status, 200);
});
