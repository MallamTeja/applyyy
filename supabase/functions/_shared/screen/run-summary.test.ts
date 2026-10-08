// Tests for withRuleWarnings: the one formatter every screening run close uses to persist
// "rule skipped" warnings into agent_runs.error_detail.
//
// WHY: the cascade's warnings (cascade.ts:155,157,315) were returned only in HTTP responses
// or console logs, so two enabled-but-dead rules read as healthy. Teja ruled 2026-10-08 to
// make them loud. Run with: node --test "supabase/functions/_shared/screen/*.test.ts"
// node:test, matching every other test in this tree (deno.json excludes *.test.ts).
import { test } from "node:test";
// Strict asserts, so 0 vs "0" style slips fail.
import assert from "node:assert/strict";
// The formatter under test; written after these tests (red first).
import { withRuleWarnings } from "./run-summary.ts";

test("no warnings leaves the existing detail exactly as it was, including null", () => {
  // A clean run must keep error_detail null, or the column stops meaning anything.
  assert.equal(withRuleWarnings(null, []), null);
  // A failure summary passes through untouched when there is nothing to add.
  assert.equal(withRuleWarnings("2 of 5 rows errored", new Set()), "2 of 5 rows errored");
});

test("warnings become one labelled, deduped, sorted segment", () => {
  // Duplicates collapse (one fact, many rows) and sorting makes the text deterministic.
  const out = withRuleWarnings(null, ["b skipped", "a unconfigured", "b skipped"]);
  // Labelled so nobody reads a warning as one of the error_count failures.
  assert.equal(out, "rule_warnings: a unconfigured | b skipped");
});

test("an existing failure summary comes first and is never displaced by warnings", () => {
  // Failures are the more urgent fact, so they lead and the warnings follow after "; ".
  const out = withRuleWarnings("1 of 3 rows errored", ["x skipped"]);
  // Same separator scout-ats already uses between its labelled segments.
  assert.equal(out, "1 of 3 rows errored; rule_warnings: x skipped");
});

test("the result is capped so one run cannot write an unbounded blob", () => {
  // 50 long distinct warnings, far past any sane column size.
  const many = Array.from({ length: 50 }, (_, i) => `warning number ${i} `.repeat(10));
  // Formatted with a failure summary in front.
  const out = withRuleWarnings("failed rows", many);
  // Bounded, and non-null so the warnings are still visible.
  assert.ok(out !== null && out.length <= 1000);
  // The failure summary survives the cap, because it is written first.
  assert.ok(out.startsWith("failed rows; rule_warnings: "));
});

test("a long failure summary cannot push the warnings past the cap", () => {
  // The worker joins up to 20 db errors; 2000 chars models that worst case.
  const summary = "E".repeat(2000);
  // Two short warnings that the old whole-string slice dropped entirely.
  const out = withRuleWarnings(summary, ["a skipped", "b skipped"]);
  // Still bounded by the column budget.
  assert.ok(out !== null && out.length <= 1000, `length ${out?.length}`);
  // The failure summary still leads, because it is the more urgent fact.
  assert.ok(out.startsWith("EEEE"));
  // The warnings segment survives with BOTH warnings: the reason this module exists.
  assert.ok(out.includes("rule_warnings: "));
  // Each warning individually, so a half-kept segment would fail.
  assert.ok(out.includes("a skipped") && out.includes("b skipped"));
});

test("a cut failure summary carries an ellipsis so a reader knows text is missing", () => {
  // Long enough that its reserved share must be truncated.
  const out = withRuleWarnings("E".repeat(2000), ["a skipped"]);
  // The marker sits right where the summary was cut, before the separator.
  assert.ok(out?.includes("E…; rule_warnings: "), out ?? "null");
});

test("no warnings keeps the full 1000-char budget for the detail, as before", () => {
  // The reserve only applies when there is a segment to reserve it for.
  const summary = "E".repeat(900);
  // Unchanged: a 900-char detail is not cut to make room for nothing.
  assert.equal(withRuleWarnings(summary, []), summary);
});

test("an over-long warnings segment is cut to its own budget, marked with an ellipsis", () => {
  // 50 long warnings: the segment alone is far over its reserved slice.
  const many = Array.from({ length: 50 }, (_, i) => `warning number ${i} `.repeat(10));
  // A short summary, so only the segment can be the cut one.
  const out = withRuleWarnings("failed rows", many);
  // Bounded overall.
  assert.ok(out !== null && out.length <= 1000);
  // Marked as cut at its end.
  assert.ok(out.endsWith("…"));
});
