// scout-ats wires the Workday detail read (2026-11-05, P1-3).
//
// WHY A SOURCE-SHAPE TEST: index.ts runs Deno.serve on import, so node --test cannot call its
// handler (the gate.ts / poll-fetch.ts pattern). The fill's BEHAVIOUR is unit-tested in
// _shared/scout/workday-detail.test.ts; what can only be checked here is that the handler calls it
// at the one place it works: after `newRows` is known and BEFORE the jobs upsert, so the text is
// stored in jobs.description_raw and the screener (planScreenedApplications, later in the loop)
// reads it. Filled after the upsert, the row would be stored blank and dropped as
// missing_description; filled on every row, re-sighted postings would be re-read each run.

// The node:test runner, matching every other suite in supabase/functions.
import { describe, it } from "node:test";
// Strict, so a missing match fails loudly.
import assert from "node:assert/strict";
// The handler's source, read as text.
import { readFileSync } from "node:fs";

// index.ts beside this file.
const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");

// The first offset of `needle`, asserting it exists so a renamed anchor fails here, not silently.
function at(needle: string): number {
  // indexOf, so the needle is literal text, not a regex.
  const index = source.indexOf(needle);
  // A missing anchor is a failure of its own, named.
  assert.ok(index >= 0, `index.ts no longer contains: ${needle}`);
  // Found.
  return index;
}

describe("scout-ats: Workday detail read wiring", () => {
  it("imports the run and the fill from the shared module", () => {
    // Both names, from the one module that owns the cap, pacing and parse.
    assert.match(source, /import \{[^}]*fillWorkdayDescriptions[^}]*newWorkdayDetailRun[^}]*\} from "\.\.\/_shared\/scout\/workday-detail\.ts"/);
  });

  it("fills the NEW rows after they are known and before the jobs upsert", () => {
    // Where the batch's new rows are decided.
    const known = at("const newRows = ");
    // The fill call on exactly those rows.
    const fill = at("await fillWorkdayDescriptions(newRows, workdayRun)");
    // The jobs insert of those rows.
    const upsert = at("planJobUpsertGroups(newRows)");
    // Order: new rows known, then filled, then stored.
    assert.ok(known < fill && fill < upsert, `order wrong: newRows@${known}, fill@${fill}, upsert@${upsert}`);
  });

  it("reads only postings the title-only tech gate keeps", () => {
    // The title-only verdict (description null), negated: a dropped title is never read.
    assert.match(source, /passesTitleGate: \(title\) => !screenTechRole\(title, null, [\w.]+\)\.drop/);
  });

  it("starts the read budget at handler entry, before the screen context loads", () => {
    // The handler's first line.
    const entry = at("Deno.serve(async");
    // The run's countdown.
    const deadline = at("createDeadline({ budgetMs: SCOUT_ATS_BUDGET_MS })");
    // The context load, which is where the run is built.
    const context = at("await loadScreenContext(");
    // Counted from entry, so time spent before the board loop is not missed.
    assert.ok(entry < deadline && deadline < context, `budget not started at entry: serve@${entry}, deadline@${deadline}, context@${context}`);
  });

  it("reports fetched / filled / skipped in the run report", () => {
    // The three counters, from the run, under one key.
    assert.match(source, /workday_detail: \{ fetched: workdayRun\?\.fetched \?\? 0, filled: workdayRun\?\.filled \?\? 0, skipped: workdayRun\?\.skipped \?\? 0 \}/);
  });
});
