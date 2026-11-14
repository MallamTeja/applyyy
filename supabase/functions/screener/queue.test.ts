// Tests for the screener's queue rules (2026-11-12, plan B: held rows).
//
// WHY THESE EXIST. A row with no description is HELD at `deduped` until a scout poll stores its text. The screener's
// queue is oldest-first with a page limit and no cursor (screener/index.ts), so a held row it fetched would sort first
// forever: past ~100 held rows, newer rows are never reached, and prescreen-drain.yml aborts red after 3 stalled pages.
// So the queue must not FETCH a row whose job has no text, and a held verdict must never be written as a status.
import { test } from "node:test";
// Strict equality.
import assert from "node:assert/strict";
// The screener's entry file, read as text: it calls Deno.serve on import, so its query cannot be run here.
import { readFileSync } from "node:fs";
// Units under test.
import { DEDUPED_QUEUE_SELECT, queueActionFor } from "./queue.ts";

test("queue: the deduped select INNER-joins the job, so a filter on the job removes the row itself", () => {
  // Without !inner, PostgREST filters the embedded job to null and still returns the application row.
  assert.match(DEDUPED_QUEUE_SELECT, /\bjobs!inner\s*\(/);
  // And it still reads the description, which the planner needs.
  assert.match(DEDUPED_QUEUE_SELECT, /\bdescription_raw\b/);
});

test("queue: the screener's deduped query skips jobs with a null or empty description (held rows never block it)", () => {
  // The entry file, line endings normalised so the shape match is EOL-proof.
  const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  // The ONE query that reads the deduped queue: from its select to its order, as written.
  const query = /\.select\(DEDUPED_QUEUE_SELECT\)[\s\S]*?\.order\("created_at"/.exec(source)?.[0];
  // Found, or the shape checks below would pass on nothing (CLAUDE.md section 6).
  assert.ok(query !== undefined, "the deduped query (select DEDUPED_QUEUE_SELECT ... order created_at) was not found in index.ts");
  // It reads the deduped status.
  assert.match(query, /\.eq\("status", "deduped"\)/);
  // Not null, on the joined job's column.
  assert.match(query, /\.not\("jobs\.description_raw", "is", null\)/);
  // And not empty.
  assert.match(query, /\.neq\("jobs\.description_raw", ""\)/);
});

test("queue: a held verdict is never written; pass and drop map to their persisted verdicts", () => {
  // Held: leave the row at deduped.
  assert.deepEqual(queueActionFor({ job_id: "j", status: "discovered", drop_reason: null }), { kind: "hold" });
  // Passed.
  assert.deepEqual(queueActionFor({ job_id: "j", status: "passed_filters", drop_reason: null }), { kind: "persist", verdict: { status: "passed_filters", reason: null } });
  // Dropped, with its reason.
  assert.deepEqual(queueActionFor({ job_id: "j", status: "dropped_filter", drop_reason: "tech_gate" }), { kind: "persist", verdict: { status: "dropped_filter", reason: "tech_gate" } });
});
