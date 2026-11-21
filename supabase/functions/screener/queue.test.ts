// Tests for the screener's queue rules.
//
// HISTORY. 2026-11-12 (plan B) held a no-description row at `deduped` and filtered such rows out of the query.
// 2026-11-18 (Teja 21:46 IST: "no jd jobs also need to be in ready to tailor") ended the hold: screen-batch.ts now
// screens a blank row and passes it to passed_filters, so the query must FETCH it again. A filter left behind would
// strand every blank deduped row at `deduped` forever, invisible on every lane. And the plain embed comes back, so a
// row whose job is missing is fetched and failed as missing_job_record instead of hiding behind an inner join.
import { test } from "node:test";
// Strict equality.
import assert from "node:assert/strict";
// The screener's entry file, read as text: it calls Deno.serve on import, so its query cannot be run here.
import { readFileSync } from "node:fs";
// Units under test.
import { DEDUPED_QUEUE_SELECT, screenVerdictFor } from "./queue.ts";

test("queue: the deduped select embeds the job PLAINLY, so a row with no job is fetched and failed, never hidden", () => {
  // A plain embed (no !inner, which would drop the application row when its job is missing).
  assert.match(DEDUPED_QUEUE_SELECT, /\bjobs \(/);
  // And it still reads the description, which the planner needs.
  assert.match(DEDUPED_QUEUE_SELECT, /\bdescription_raw\b/);
});

test("queue: the screener's deduped query fetches no-description rows too (2026-11-18: they are screened, not held)", () => {
  // The entry file, line endings normalised so the shape match is EOL-proof.
  const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  // The ONE query that reads the deduped queue: from its select to its order, as written.
  const query = /\.select\(DEDUPED_QUEUE_SELECT\)[\s\S]*?\.order\("created_at"/.exec(source)?.[0];
  // Found, or the shape checks below would pass on nothing (CLAUDE.md section 6).
  assert.ok(query !== undefined, "the deduped query (select DEDUPED_QUEUE_SELECT ... order created_at) was not found in index.ts");
  // It reads the deduped status.
  assert.match(query, /\.eq\("status", "deduped"\)/);
  // The whole filter chain, exactly: status, then the optional one-row match (comment lines allowed between). A
  // description filter between them would strand blank rows at deduped, so the positive shape is pinned.
  assert.match(query, /\.eq\("status", "deduped"\)\s*(?:\/\/[^\n]*\n\s*)*\.match\(/);
});

// Round 7 (2026-11-21): the planner's type cannot hold 'discovered' (screen-batch.ts PlannedInsertStatus, proven at compile
// time there), so the "hold" branch is gone and every planned row maps straight to a verdict.
test("queue: a planned pass and a planned drop map to their verdicts, the drop carrying its rule", () => {
  // Passed: no reason.
  assert.deepEqual(screenVerdictFor({ job_id: "j", status: "passed_filters", drop_reason: null }), { status: "passed_filters", reason: null });
  // Dropped, with its reason.
  assert.deepEqual(screenVerdictFor({ job_id: "j", status: "dropped_filter", drop_reason: "tech_gate" }), { status: "dropped_filter", reason: "tech_gate" });
});

test("queue: the screener writes every planned row, with no hold branch left in its loop", () => {
  // The entry file, EOL-normalised.
  const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  // The planned row goes straight to a verdict and on to the one write path.
  assert.match(source, /const verdict = screenVerdictFor\(insertResult\);\s*(?:\/\/[^\n]*\n\s*)*const written = await persistScreenVerdict\(db, app\.id, verdict\);/);
});
