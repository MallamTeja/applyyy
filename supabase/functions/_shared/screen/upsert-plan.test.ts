// Tests for the jobs-upsert blanking guard.
//
// THE RULE UNDER TEST, in one line: ABSENCE IS NOT A CORRECTION. A re-poll that simply
// did not carry a field must not overwrite what is already stored; a re-poll that
// carries a DIFFERENT value must overwrite. Those two have to be distinguishable, and
// today they are not — `ignoreDuplicates: false` makes every upsert a full-row
// overwrite, so a thin listing response silently erases a full job description that an
// earlier, richer poll captured.
//
// WHY THE FIX IS "GROUP THE BATCH" AND NOT "STRIP THE NULLS", which is the part a
// reader will get wrong: postgrest-js 1.17.7 builds its `columns=` parameter from the
// UNION of keys across the whole batch —
//     const columns = values.reduce((acc, x) => acc.concat(Object.keys(x)), []);
// — so dropping a null key from ONE row changes nothing. The column is still named by
// a sibling row, still lands in the ON CONFLICT DO UPDATE SET list, and the row that
// omitted it is sent as NULL anyway. A key is only genuinely absent when it is absent
// from EVERY row in the request. Hence groups, one request each.
import { test } from "node:test";
// Strict, so a removed key never compares equal to a key holding `undefined`.
import assert from "node:assert/strict";
// Extension-suffixed specifier so this runs under Deno and `node --test` alike.
import { planJobUpsertGroups } from "./upsert-plan.ts";
// Row shape from the schema owner. Never redefined here — a redefined type drifts.
import type { JobInsert } from "../contracts/shared-types.ts";

// A complete row that omits nothing, so each test can blank exactly one field.
// Mirrors what `toJobInsert` actually emits (ats/registry.ts:144-199).
const FULL_ROW: JobInsert = {
  fingerprint: "fp-full",
  title: "Backend Engineering Intern",
  company_name: "Zomato",
  company_slug: "zomato",
  location_raw: "Bengaluru, India",
  locations: [],
  work_arrangement: "onsite",
  employment_type: "internship",
  description_raw: "We are hiring an intern to work on the ordering service.",
  apply_url: "https://boards.greenhouse.io/zomato/jobs/1",
  ats_provider: "greenhouse",
  ats_job_id: "1",
  discovered_via: ["career_page"],
  source_refs: [],
  posted_at: "2026-09-09T12:00:00.000Z",
  posted_at_source: "exact",
  raw_payload: { id: 1 },
};

// Collapse the groups back into one flat list, for the conservation checks below.
function allRows(groups: readonly (readonly Partial<JobInsert>[])[]): Partial<JobInsert>[] {
  return groups.flatMap((group) => [...group]);
}

// --- the core rule ---------------------------------------------------------------

// The headline case, and the one the whole guard exists for. A board's list endpoint
// returns the posting without its body; `toJobInsert` faithfully emits
// `description_raw: null`; today that null overwrites a full JD captured yesterday.
test("a null description_raw is removed from the payload so the stored value survives", () => {
  // One thin row, exactly as a body-less re-poll produces it.
  const groups = planJobUpsertGroups([{ ...FULL_ROW, description_raw: null }]);
  // The key must be GONE, not present-and-null: present-and-null is what clobbers.
  assert.equal(groups.length, 1);
  assert.equal("description_raw" in groups[0]![0]!, false);
});

// The other half of the rule, and the half a careless fix breaks. Stripping nulls is
// only correct because a real value is still sent — otherwise a job whose description
// genuinely changed would freeze at its first-ever text.
test("a populated description_raw is kept so a genuine change still overwrites", () => {
  // A re-poll that did carry a body, and a different one.
  const groups = planJobUpsertGroups([{ ...FULL_ROW, description_raw: "Updated body." }]);
  // The key survives, carrying the new value.
  assert.equal(groups[0]![0]!.description_raw, "Updated body.");
});

// THE DECISIVE TEST, and the reason this function returns groups rather than rows.
// Two rows in one batch, one thin and one full: if they travel in a single request,
// postgrest's union puts `description_raw` in `columns=` and the thin row blanks its
// own stored description regardless of any per-row stripping. A uniform batch would
// pass this suite for the wrong reason, so the batch here is deliberately mixed.
test("a thin row and a full row are split into separate requests", () => {
  const groups = planJobUpsertGroups([
    // Carries a body.
    { ...FULL_ROW, fingerprint: "fp-has-body" },
    // Does not.
    { ...FULL_ROW, fingerprint: "fp-no-body", description_raw: null },
  ]);
  // Two distinct key-sets means two requests. One request cannot express both.
  assert.equal(groups.length, 2);
  // And no group may mix the two shapes.
  for (const group of groups) {
    const shapes = new Set(group.map((row) => Object.keys(row).sort().join(",")));
    assert.equal(shapes.size, 1);
  }
});

// The counterweight to the test above: grouping must not degenerate into one request
// per row. A board returning fifty uniform postings must still cost one round trip,
// or the guard trades a data bug for a rate-limit problem.
test("rows sharing a key-set stay in a single request", () => {
  // Three rows, all thin in exactly the same way.
  const groups = planJobUpsertGroups([
    { ...FULL_ROW, fingerprint: "fp-1", description_raw: null },
    { ...FULL_ROW, fingerprint: "fp-2", description_raw: null },
    { ...FULL_ROW, fingerprint: "fp-3", description_raw: null },
  ]);
  // One shape, therefore one request.
  assert.equal(groups.length, 1);
  assert.equal(groups[0]!.length, 3);
});

// A guard that silently loses rows is worse than the bug it replaces: the blanking at
// least left a row behind. This asserts the transform is total — every posting that
// went in comes out exactly once, so no job is dropped by the fix.
test("every input row appears exactly once across the groups", () => {
  const input: JobInsert[] = [
    { ...FULL_ROW, fingerprint: "fp-a" },
    { ...FULL_ROW, fingerprint: "fp-b", description_raw: null },
    { ...FULL_ROW, fingerprint: "fp-c", location_raw: null },
  ];
  // Flatten and compare by the dedupe key.
  const out = allRows(planJobUpsertGroups(input)).map((row) => row.fingerprint).sort();
  assert.deepEqual(out, ["fp-a", "fp-b", "fp-c"]);
});

// --- which columns the rule covers ------------------------------------------------

// `locations` is the quiet one, and it blanks on EVERY poll rather than only thin ones.
// `toJobInsert` hard-codes `locations: []` because splitting them is the Normalizer's
// job — so once the Normalizer fills them, the next scout run wipes them again. The
// location_allowlist filter reads that column, so this bug feeds the screener bad data.
test("an empty locations array is removed so parsed locations are not wiped", () => {
  const groups = planJobUpsertGroups([{ ...FULL_ROW }]);
  assert.equal("locations" in groups[0]![0]!, false);
});

// Same rule, other nullable columns a sparse board leaves out.
test("null location_raw, ats_job_id and raw_payload are all removed", () => {
  const groups = planJobUpsertGroups([
    { ...FULL_ROW, location_raw: null, ats_job_id: null, raw_payload: null },
  ]);
  const row = groups[0]![0]!;
  assert.equal("location_raw" in row, false);
  assert.equal("ats_job_id" in row, false);
  assert.equal("raw_payload" in row, false);
});

// THE GUARD ON THE GUARD. Stripping is restricted to an explicit allowlist of columns
// precisely so it can never remove a NOT NULL column and turn a working insert into a
// constraint violation. If a blanket "remove every falsy value" rule ever replaced the
// allowlist, this test is what fails.
test("a required column is never stripped, even when its value is blank", () => {
  // An empty string is falsy, but `title` is NOT NULL and not on the preservable list.
  const groups = planJobUpsertGroups([{ ...FULL_ROW, title: "" }]);
  const row = groups[0]![0]!;
  assert.equal("title" in row, true);
  assert.equal(row.title, "");
});

// An empty batch must produce no requests at all, not one empty request. postgrest
// rejects an empty body, and a board with nothing new is the common case, not the rare
// one — so this is the path most runs actually take.
test("an empty batch produces no requests", () => {
  assert.deepEqual(planJobUpsertGroups([]), []);
});
