// ============================================================================
// PINNED-MASTER RESOLUTION TESTS
// ============================================================================
//
// Why this file exists: the Auditor judges fabrication by comparing a tailored
// resume against the master profile. It used to compare against the LATEST
// master version, but every application records the version the Tailor was
// pinned to (`applications.master_version`). Upload a newer master after
// tailoring and the audit was checking against the wrong ground truth.
//
// `resolvePinnedMaster` resolves each row's master by its pin. These tests hold
// the two properties that matter:
//   1. the pinned version wins, never the latest (the regression);
//   2. a missing or malformed pin FAILS CLOSED with a distinct verdict, never
//      falls back to the latest master — that fallback IS the bug (CLAUDE.md §5:
//      missing data becoming an answer).
//
// Run from the repo root: node --test supabase/functions/_shared/audit/pinned-master.test.ts
// ============================================================================

// Node's built-in runner, matching audit.test.ts so one glob runs the whole dir.
import { test } from "node:test";

// Strict mode so deepEqual cannot pass on loose (==) coercion — "2" vs 2 matters here.
import assert from "node:assert/strict";

// The functions under test; .ts extension because Deno and Node type-stripping both require it.
import { collectPins, resolvePinnedMaster } from "./pinned-master.ts";

// Type-only import so the fixture is typed against the real contract, not a guess.
import type { MasterProfile } from "../contracts/shared-types.ts";

// Builds a distinguishable stand-in master. Cast through `unknown` because these
// tests assert on object IDENTITY, not on profile content — a full valid
// MasterProfile would be noise that hides what each test is checking.
function fakeMaster(version: number): MasterProfile {
  // The `version` tag only helps a human read a failure diff; identity is the real check.
  return { schema_version: 1, __fixture_version: version } as unknown as MasterProfile;
}

// v1 is the master the Tailor pinned to in the regression scenario.
const MASTER_V1 = fakeMaster(1);

// v2 is the "newer upload" — the object the old code would wrongly have used.
const MASTER_V2 = fakeMaster(2);

// Map shape mirrors what the caller builds after loading exactly collectPins()' versions.
const MASTERS: ReadonlyMap<number, MasterProfile> = new Map([
  // Older, pinned version.
  [1, MASTER_V1],
  // Newer, latest version — must never be chosen for a v1 pin.
  [2, MASTER_V2],
]);

// THE regression test: with v2 present and newer, a v1 pin must still resolve to v1.
test("pinned version present resolves to THAT version's master, not the latest", () => {
  // Pin 1 while 2 is the latest — exactly the post-reupload scenario that was broken.
  const result = resolvePinnedMaster(1, MASTERS);
  // Kind first, so a wrong variant fails with a readable message rather than a property error.
  assert.equal(result.kind, "pinned");
  // Narrow the union so the property reads below type-check.
  if (result.kind !== "pinned") return;
  // The version echoed back lets the caller record which ground truth it audited against.
  assert.equal(result.version, 1);
  // Reference identity: proves the v1 OBJECT was returned, not a lookalike copy.
  assert.equal(result.master, MASTER_V1);
  // Explicitly not the latest — states the bug being fixed in the assertion itself.
  assert.notEqual(result.master, MASTER_V2);
});

// Null is the real DB value for rows tailored before pinning existed.
test("null pin is unpinned and does not fall back to any loaded master", () => {
  // The map holds masters on purpose: a fallback would have something to grab.
  const result = resolvePinnedMaster(null, MASTERS);
  // deepEqual on the whole verdict proves no `master` field leaked into it.
  assert.deepEqual(result, { kind: "unpinned" });
});

// Undefined arises when the select list omits the column — must fail closed the same way.
test("undefined pin is unpinned and does not fall back to any loaded master", () => {
  // Same populated map, same reason: give a fallback the chance to misbehave.
  const result = resolvePinnedMaster(undefined, MASTERS);
  // Whole-object equality again, so a smuggled `master` property fails the test.
  assert.deepEqual(result, { kind: "unpinned" });
});

// Each value is something a lenient reader would turn into a version (§5: validate shape).
test("invalid pins (0, -1, 1.5, '2', NaN, {}) are invalid_pin carrying the original value", () => {
  // 0/-1: not a real version; 1.5: not an integer; "2": no string coercion; NaN, {}: garbage.
  const invalid: unknown[] = [0, -1, 1.5, "2", NaN, {}];
  // One assertion per value so a failure names the exact pin that slipped through.
  for (const pin of invalid) {
    // Map contains 1 and 2, so a coerced "2" would wrongly resolve — that is the trap.
    const result = resolvePinnedMaster(pin, MASTERS);
    // The verdict must be the invalid variant, not pinned/unpinned/missing.
    assert.equal(result.kind, "invalid_pin", `pin ${String(pin)} should be invalid_pin`);
    // Narrow the union for the property read below.
    if (result.kind !== "invalid_pin") continue;
    // Object.is so NaN compares equal to itself and {} is checked by identity.
    assert.ok(Object.is(result.pin, pin), `invalid_pin must carry the original value for ${String(pin)}`);
  }
});

// A well-formed pin whose master was never loaded must say so, not pick something else.
test("valid pin absent from the map is pinned_version_missing with that version", () => {
  // Pin 3 against a map of {1,2}: the nearest/latest (2) must not be substituted.
  const result = resolvePinnedMaster(3, MASTERS);
  // Whole-object equality proves no `master` was attached as a fallback.
  assert.deepEqual(result, { kind: "pinned_version_missing", version: 3 });
});

// collectPins feeds the single `in (...)` query, so it must be deduped, valid-only, sorted.
test("collectPins returns distinct valid pins sorted ascending, ignoring null and invalid", () => {
  // Duplicate 2, out of order, plus null, a string "3" and 0 — each must be handled.
  const rows = [
    // First 2 — kept.
    { master_version: 2 },
    // 1 arrives after 2, so sorting is actually exercised.
    { master_version: 1 },
    // Duplicate 2 — must collapse.
    { master_version: 2 },
    // Unpinned row — contributes nothing to the query.
    { master_version: null },
    // String "3" — no coercion, so 3 must NOT appear.
    { master_version: "3" },
    // 0 is not a valid version.
    { master_version: 0 },
  ];
  // Exact array: order, dedupe and filtering are all asserted in one line.
  assert.deepEqual(collectPins(rows), [1, 2]);
});

// An empty batch must not produce a malformed query input.
test("collectPins on an empty batch returns an empty array", () => {
  // Empty in, empty out — the caller can then skip the query entirely.
  assert.deepEqual(collectPins([]), []);
});
