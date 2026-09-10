// Tests for the intake shared secret. The interesting cases here are the two that
// look like edge cases and are actually the security properties: unset configuration
// must FAIL rather than allow, and a wrong secret must be indistinguishable from a
// missing one.
import { test } from "node:test";
// Strict equality so a 401 never compares equal to a truthy 500.
import assert from "node:assert/strict";
// Extension-suffixed specifier so this runs under Deno and `node --test` alike.
import { authenticateIntake, INTAKE_SECRET_ENV_VAR, timingSafeEqual } from "./auth.ts";

// The fixture secret.
//
// DELIBERATELY SELF-EVIDENTLY NOT A CREDENTIAL, and long enough to exercise the
// constant-time comparison across many bytes. A realistic-looking 32-character random
// string would test exactly the same code while being indistinguishable from a leaked
// key at a glance — so every future secret scan, reviewer and audit tool re-flags it,
// and the real danger arrives the day a genuine leak is dismissed as "probably the
// test fixture again". Alarm fatigue is a security failure, not a tidiness one.
const SECRET = "test-shared-secret-not-a-real-value-0123456789";

// The ordinary case: the script presents exactly what was configured.
test("a matching secret authenticates", () => {
  // Same value on both sides.
  const result = authenticateIntake(SECRET, SECRET);
  // Allowed.
  assert.equal(result.ok, true);
});

// THE FAIL-CLOSED PROPERTY. An unset variable must never read as "no authentication
// required" — that is exactly how a hardening step gets skipped in an environment
// nobody re-checked after deploying.
test("an unset secret refuses the request instead of allowing it", () => {
  // Configuration absent entirely.
  const result = authenticateIntake(SECRET, undefined);
  // Refused.
  assert.equal(result.ok, false);
  if (result.ok) return;
  // 500, not 401: the fault is ours, and the code is what tells Teja to go set it.
  assert.equal(result.status, 500);
  // And the reason names the variable, so the fix needs no source reading.
  assert.match(result.reason, new RegExp(INTAKE_SECRET_ENV_VAR));
});

// A variable set to whitespace is the same operational mistake as an unset one, and
// treating it as a real secret would authenticate a caller who sends a space.
test("a whitespace-only configured secret is treated as unset", () => {
  // Set, but empty of content.
  const result = authenticateIntake("   ", "   ");
  // Refused.
  assert.equal(result.ok, false);
  if (result.ok) return;
  // Misconfiguration, not a bad caller.
  assert.equal(result.status, 500);
});

// A wrong secret is a caller problem and must be told nothing beyond "no".
test("a mismatched secret is 401", () => {
  // Close but wrong — a single trailing character.
  const result = authenticateIntake(SECRET + "x", SECRET);
  // Refused.
  assert.equal(result.ok, false);
  if (result.ok) return;
  // Unauthorised, which instructs Apps Script not to retry.
  assert.equal(result.status, 401);
});

// The URL is public, so scanners will hit it. A missing header must produce the same
// answer as a wrong one: telling an attacker the header name was right is free recon.
test("an absent header is 401, the same code as a wrong secret", () => {
  // No header at all.
  const absent = authenticateIntake(null, SECRET);
  // A header with the wrong value.
  const wrong = authenticateIntake("nope", SECRET);
  // Both refused.
  assert.equal(absent.ok, false);
  assert.equal(wrong.ok, false);
  if (absent.ok || wrong.ok) return;
  // And refused identically, so the two are indistinguishable from outside.
  assert.equal(absent.status, wrong.status);
});

// An empty header value is absence, not a secret worth comparing.
test("an empty header value is 401", () => {
  // Present but empty.
  const result = authenticateIntake("", SECRET);
  // Refused.
  assert.equal(result.ok, false);
  if (result.ok) return;
  // Same code as absence.
  assert.equal(result.status, 401);
});

// --- the comparison primitive itself ---------------------------------------------

// Correctness first: constant time is worthless if the answer is wrong.
test("timingSafeEqual agrees with equality on identical strings", () => {
  // Identical inputs must match.
  assert.equal(timingSafeEqual(SECRET, SECRET), true);
});

// A difference anywhere must be caught, including in the very last byte — which is
// exactly the position a naive early-return implementation is slowest to reject.
test("timingSafeEqual rejects a difference in the final byte", () => {
  // Same length, last character changed.
  assert.equal(timingSafeEqual(SECRET.slice(0, -1) + "!", SECRET), false);
});

// A difference in the first byte must be caught too, and by the same code path.
test("timingSafeEqual rejects a difference in the first byte", () => {
  // Same length, first character changed.
  assert.equal(timingSafeEqual("!" + SECRET.slice(1), SECRET), false);
});

// Length differences must not be handled by an early return that leaks the length.
test("timingSafeEqual rejects a correct prefix that is too short", () => {
  // A genuine prefix of the secret — the input a per-character attack would produce.
  assert.equal(timingSafeEqual(SECRET.slice(0, 8), SECRET), false);
});

// And a value that merely extends the secret is not the secret.
test("timingSafeEqual rejects a correct prefix that is too long", () => {
  // The whole secret plus extra bytes.
  assert.equal(timingSafeEqual(SECRET + "extra", SECRET), false);
});

// Multi-byte input must be compared by encoded bytes, not UTF-16 code units, or two
// values of equal `.length` but different encoded size could be mishandled.
test("timingSafeEqual compares encoded bytes, not code units", () => {
  // Same code-unit length, different encoded byte length.
  assert.equal(timingSafeEqual("é", "e"), false);
});
