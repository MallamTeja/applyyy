// Tests for the READER side of liveness: classifyJobLiveness, allLivenessUnknown and
// LIVENESS_UNKNOWN_DETAIL.
//
// THE RULE UNDER TEST: an embed that does not PROVE it is live is never called live
// (CLAUDE.md §5: missing data becoming an answer). Kept apart from liveness.test.ts, which
// covers the writer side (planDisappearances / planReappearances) and has another owner.
import { test } from "node:test";
// Strict, so a missing key never equals a key holding `undefined`.
import assert from "node:assert/strict";
// Extension-suffixed so this runs under node --test and Deno alike.
import { allLivenessUnknown, classifyJobLiveness, LIVENESS_UNKNOWN_DETAIL } from "./liveness.ts";

test("no object at all is unknown, never live", () => {
  // A null embed is what a non-!inner join hands back for a filtered-out job.
  assert.equal(classifyJobLiveness(null), "unknown");
  // Undefined: the row had no `jobs` key, i.e. the embed itself was not selected.
  assert.equal(classifyJobLiveness(undefined), "unknown");
  // An array is a to-many embed from a mis-declared relation; one job's liveness is unknowable.
  assert.equal(classifyJobLiveness([{ disappeared_at: null }]), "unknown");
  // A primitive is not an embed at all.
  assert.equal(classifyJobLiveness("job"), "unknown");
});

test("an object WITHOUT the disappeared_at key fails closed as unknown", () => {
  // THE TRAP: postgrest omits unselected columns, and `!= null` would read this as live.
  assert.equal(classifyJobLiveness({ title: "Backend Engineer" }), "unknown");
});

test("disappeared_at: null is live", () => {
  // Selected and null: scout-ats has not seen the posting leave its board.
  assert.equal(classifyJobLiveness({ title: "Backend Engineer", disappeared_at: null }), "live");
});

test("a timestamp is disappeared", () => {
  // The ordinary marked-gone shape scout-ats writes.
  assert.equal(classifyJobLiveness({ disappeared_at: "2026-10-05T00:00:00Z" }), "disappeared");
});

test("a present key holding undefined is disappeared, not live", () => {
  // postgrest never sends undefined for a live job; strict `=== null` keeps it off 'live'.
  assert.equal(classifyJobLiveness({ disappeared_at: undefined }), "disappeared");
});

test("allLivenessUnknown: true only for a non-empty all-unknown batch", () => {
  // The shape a select that lost the column produces: every row unknown.
  assert.equal(allLivenessUnknown(["unknown", "unknown"]), true);
  // Empty is an idle queue; `every` on [] is true, so this guards the length check.
  assert.equal(allLivenessUnknown([]), false);
  // One live row proves the column arrived, so the run is ordinary.
  assert.equal(allLivenessUnknown(["unknown", "live"]), false);
  // A disappeared row also proves the column arrived.
  assert.equal(allLivenessUnknown(["unknown", "disappeared"]), false);
});

test("LIVENESS_UNKNOWN_DETAIL is the exact shared wording, carrying the batch size", () => {
  // Pinned verbatim: a health-page search for this string is how the defect is found.
  assert.equal(LIVENESS_UNKNOWN_DETAIL(2), "all 2 rows lacked disappeared_at; is the select missing the column?");
  // The count is interpolated, not hard-coded, so a different batch reports its own size.
  assert.equal(LIVENESS_UNKNOWN_DETAIL(7), "all 7 rows lacked disappeared_at; is the select missing the column?");
});
