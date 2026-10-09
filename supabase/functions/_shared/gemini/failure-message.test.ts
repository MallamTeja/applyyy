// Tests for the shared Gemini failure formatter.
//
// WHY THESE EXIST: Gemini callers kept only `outcome.reason`, so every failure read
// "gemini_call_failed: http_error". Three different causes (a 400 or other status; all keys
// rejected with 401/403; a 200 whose body was not JSON) were indistinguishable in
// agent_runs.error_detail, and the 2026-10-05 matcher failures needed a manual read of
// gemini_key_state to diagnose. These tests pin the exact line each failure renders as, and
// prove the untrusted detail can never leak an API key or spill over one line.
import { test } from "node:test";
// Strict, so "status=-" vs "status=undefined" mismatches are not papered over by coercion.
import assert from "node:assert/strict";
// Unit under test; relative path so node --test loads the .ts directly, no build step.
import { describeGeminiFailure, formatGeminiFailure, GEMINI_FAILURE_DETAIL_MAX } from "./failure-message.ts";

// A FAKE key with the real shape ("AIza" + 35 key chars). Built here, never a real key.
const FAKE_KEY = "AIza" + "x".repeat(35);

test("gemini failure: each real reason renders with its status", () => {
  // Each pair is [outcome, exact expected line]; exact strings so any format drift fails loudly.
  const cases: Array<[Parameters<typeof describeGeminiFailure>[0], string]> = [
    // A 400 (or other unclassified status) is now told apart from the other http_error sources.
    [{ reason: "http_error", status: 400 }, "http_error status=400"],
    // A 200 with a non-JSON body: same reason, but the status and detail disambiguate it.
    [{ reason: "http_error", status: 200, detail: "invalid JSON body" }, "http_error status=200 invalid JSON body"],
    // Google overloaded: the 503 says it is upstream, not us.
    [{ reason: "upstream_unavailable", status: 503 }, "upstream_unavailable status=503"],
    // A retired model name surfaces as 404.
    [{ reason: "model_not_found", status: 404 }, "model_not_found status=404"],
    // Quota exhaustion after every retry.
    [{ reason: "rate_limited_all_retries_exhausted", status: 429 }, "rate_limited_all_retries_exhausted status=429"],
    // Pool-level failure: no HTTP call was made, so there is no status.
    [{ reason: "all_keys_cooling" }, "all_keys_cooling status=-"],
    // A 200 with no candidates.
    [{ reason: "empty_response", status: 200 }, "empty_response status=200"],
    // Key claim failed before any request: no status.
    [{ reason: "claim_failed" }, "claim_failed status=-"],
  ];
  // One assertion per reason, with the reason in the message so a failure names its case.
  for (const [outcome, expected] of cases) {
    assert.equal(describeGeminiFailure(outcome), expected, outcome.reason);
  }
});

test("gemini failure: missing status renders status=-", () => {
  // "-" means "no status received", distinct from a lost or zero status.
  assert.equal(describeGeminiFailure({ reason: "claim_failed" }), "claim_failed status=-");
});

test("gemini failure: absent or blank detail adds no trailing space", () => {
  // Absent detail: line ends at the status.
  assert.equal(describeGeminiFailure({ reason: "http_error", status: 401 }), "http_error status=401");
  // Empty string: sanitizes to "", must not append a space.
  assert.equal(describeGeminiFailure({ reason: "http_error", status: 401, detail: "" }), "http_error status=401");
  // Whitespace and control chars only: trimmed to "", so still no trailing space.
  assert.equal(describeGeminiFailure({ reason: "http_error", status: 401, detail: " \n\t  " }), "http_error status=401");
});

test("gemini failure: long detail is capped at GEMINI_FAILURE_DETAIL_MAX with an ellipsis", () => {
  // Guard the constant itself, since the boundary cases below depend on it.
  assert.equal(GEMINI_FAILURE_DETAIL_MAX, 120);
  // Prefix length, so the detail can be sliced back out of the rendered line.
  const prefix = "http_error status=500 ";
  // Way over the cap: detail must be exactly 120 chars and end with the cut marker.
  const long = describeGeminiFailure({ reason: "http_error", status: 500, detail: "a".repeat(500) }).slice(prefix.length);
  // Total including the ellipsis is the cap, not cap + 1.
  assert.equal(long.length, 120);
  // The cut is marked so a reader knows text continued.
  assert.ok(long.endsWith("…"));
  // Boundary: exactly 120 chars is kept whole, no ellipsis.
  const exact = "b".repeat(120);
  // Equality proves nothing was cut or appended.
  assert.equal(describeGeminiFailure({ reason: "http_error", status: 500, detail: exact }), prefix + exact);
  // One over the boundary: 121 chars must be cut to 119 + "…".
  const over = describeGeminiFailure({ reason: "http_error", status: 500, detail: "c".repeat(121) }).slice(prefix.length);
  // Exact expected shape of the cut.
  assert.equal(over, "c".repeat(119) + "…");
});

test("gemini failure: an API key in the detail is redacted", () => {
  // Key mid-sentence, as Google's error text might echo it.
  const out = describeGeminiFailure({ reason: "http_error", status: 400, detail: `API key ${FAKE_KEY} not valid` });
  // The key must be gone entirely.
  assert.ok(!out.includes(FAKE_KEY));
  // And replaced by the marker, so a reader knows a key was there.
  assert.ok(out.includes("[redacted-key]"));
  // Key straddling the cut at ~position 110: redaction runs before the cut, so no partial key survives.
  const straddling = "y".repeat(110) + FAKE_KEY + " trailing text";
  // Render it through the real cap.
  const cut = describeGeminiFailure({ reason: "http_error", status: 400, detail: straddling });
  // Not even the "AIza" prefix may leak.
  assert.ok(!cut.includes("AIza"), cut);
});

test("gemini failure: a key= URL parameter is redacted", () => {
  // ?key= first in the query: value replaced, following params kept for context.
  const q = describeGeminiFailure({ reason: "http_error", status: 400, detail: "GET https://g.example/v1?key=SECRET&alt=json failed" });
  // Exact expected redacted URL fragment.
  assert.ok(q.includes("?key=[redacted]&alt=json"), q);
  // The secret value itself must be gone.
  assert.ok(!q.includes("SECRET"), q);
  // &key= later in the query is redacted too.
  const amp = describeGeminiFailure({ reason: "http_error", status: 400, detail: "GET https://g.example/v1?alt=json&key=SECRET2" });
  // Exact expected redacted fragment.
  assert.ok(amp.includes("&key=[redacted]"), amp);
  // Secret gone.
  assert.ok(!amp.includes("SECRET2"), amp);
});

test("gemini failure: newlines and tabs collapse to single spaces", () => {
  // Multi-line upstream body with tabs and CRLF, as a gateway page might return.
  const out = describeGeminiFailure({ reason: "http_error", status: 502, detail: "Bad\r\n\tGateway\n\n  nginx" });
  // One line, single spaces, so the run summary stays one row in Health.
  assert.equal(out, "http_error status=502 Bad Gateway nginx");
});

test("gemini failure: formatGeminiFailure is the prefixed describeGeminiFailure", () => {
  // A representative outcome with all three fields.
  const outcome = { reason: "http_error", status: 200, detail: "invalid JSON body" };
  // The prefix is kept so existing log searches for "gemini_call_failed:" still match.
  assert.equal(formatGeminiFailure(outcome), "gemini_call_failed: " + describeGeminiFailure(outcome));
  // And pin the literal line, so a change to both functions together still fails.
  assert.equal(formatGeminiFailure(outcome), "gemini_call_failed: http_error status=200 invalid JSON body");
});

// --- wiring: every Gemini caller records failures through this formatter -----------------
// The handlers (Deno.serve, jsr: imports) cannot be imported under node, so the wiring is
// checked on their source. POSITIVE shape (CLAUDE.md §6): each caller must CALL the shared
// formatter; a caller reverted to the bare `outcome.reason` line fails here by name.

// Node built-ins only; read-only.
import { readFileSync } from "node:fs";
// Resolves the callers relative to this test file, independent of the cwd.
import { fileURLToPath } from "node:url";

// Every place a failed generateGeminiContent outcome is recorded, as of 2026-10-09.
const CALLERS: ReadonlyArray<readonly [string, "formatGeminiFailure" | "describeGeminiFailure"]> = [
  // Throws into the scorer's per-row failure list.
  ["../../matcher/index.ts", "formatGeminiFailure"],
  // Throws into the tailoring runner.
  ["../../tailor/index.ts", "formatGeminiFailure"],
  // Throws into the scout-web handler's failed run.
  ["../../scout-web/index.ts", "formatGeminiFailure"],
  // Returns the error string to the follow-up runner.
  ["../follow-up/nudge.ts", "formatGeminiFailure"],
  // Seam whose runner (run.ts) adds the prefix itself.
  ["../../cover-letter/index.ts", "describeGeminiFailure"],
  // Warning lines, which carry their own wording around the description.
  ["../../interview-prep/index.ts", "describeGeminiFailure"],
  ["../../referral/index.ts", "describeGeminiFailure"],
];

for (const [relative, fn] of CALLERS) {
  test(`gemini failure wiring: ${relative} records failures through ${fn}`, () => {
    // The caller's source, as it would be deployed.
    const source = readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");
    // Imported from the shared module, so it is the one implementation...
    // String.raw keeps every backslash literal: in a plain template `\b` is a backspace.
    assert.match(source, new RegExp(String.raw`import \{[^}]*\b${fn}\b[^}]*\} from "[./]+(_shared/)?gemini/failure-message\.ts"`));
    // ...and actually called with an outcome (not merely imported).
    assert.match(source, new RegExp(String.raw`${fn}\((outcome|result)\)`));
  });
}
