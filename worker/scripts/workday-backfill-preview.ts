// Back-fill PREVIEW for the Workday jobs saved with no description (2026-11-05).
//
// WHY: the Workday list endpoint carries no description, so every Workday job before the detail
// read (supabase/functions/_shared/scout/workday-detail.ts) was saved with description_raw NULL.
// 391 of them passed the screener and failed in the matcher as missing_description. Teja ruled
// (00:10 IST 11-05) that they are back-filled from the detail endpoint, with the orchestrator
// running the writes after he sees the count.
//
// WHAT IT DOES, and what it never does:
//   - Reads an input JSON file of rows (exported by the orchestrator with a read-only SELECT).
//   - For each row, reads the posting's detail page through scout-ats's own robots-gated GET
//     (poll-fetch.ts fetchBoard, robots policy 'scouting'), under the same cap and pacing code the
//     scouts use (fillWorkdayDescriptions). A site whose robots.txt disallows it is never read.
//   - Writes an output JSON: per row, the description or null, plus the counts.
//   - NO DATABASE ACCESS AND NO SECRETS. It cannot write a row. The writes (jobs.description_raw,
//     then the human failed -> passed_filters edge) are the orchestrator's, from the output file.
//
// Input: a JSON array of { application_id, job_id, title, apply_url }, e.g. from
//   select a.id application_id, j.id job_id, j.title, j.apply_url
//   from applications a join jobs j on j.id = a.job_id
//   where j.ats_provider = 'workday' and a.failure_reason = 'missing_description'
//     and (j.description_raw is null or btrim(j.description_raw) = '');
//
// Usage: node worker/scripts/workday-backfill-preview.ts <rows.json> <preview.json> [cap]

// Node's promise-based fs: one read, one write.
import { readFile, writeFile } from 'node:fs/promises';
// The same cap/pacing/parse code the scouts run, so the preview is what a scout would get.
import { fillWorkdayDescriptions, newWorkdayDetailRun } from '../../supabase/functions/_shared/scout/workday-detail.ts';
// scout-ats's robots-gated GET (policy 'scouting'): the same gate the scout's detail reads use.
import { fetchBoard } from '../../supabase/functions/scout-ats/poll-fetch.ts';
// The countdown the scouts use for their budgets.
import { createDeadline } from '../../supabase/functions/_shared/agent/deadline.ts';
// Row shape from the schema owner.
import type { JobInsert } from '../../supabase/functions/_shared/contracts/shared-types.ts';

// One input row, as the SELECT above returns it.
interface BackfillRow {
  // The failed application, for the orchestrator's status move.
  readonly application_id: string;
  // The job whose description_raw gets the text.
  readonly job_id: string;
  // For the log only.
  readonly title: string;
  // The detail URL is derived from this; any other shape is refused, never repaired.
  readonly apply_url: string;
}

// A UUID, anchored: ids go back into the orchestrator's SQL, so nothing else may pass.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The input, shape-checked row by row (CLAUDE.md §6): a malformed file stops the run whole.
function readRows(raw: unknown): BackfillRow[] {
  // Must be an array.
  if (!Array.isArray(raw)) throw new Error('input is not a JSON array');
  // Each row checked; the first bad one names its index.
  return raw.map((row: unknown, index) => {
    // An object with the four fields, ids as UUIDs, text as strings.
    const r = row as Record<string, unknown>;
    // One condition per field, so the error can say which.
    if (typeof r !== 'object' || r === null) throw new Error(`row ${index} is not an object`);
    // The two ids.
    if (typeof r['application_id'] !== 'string' || !UUID.test(r['application_id'])) throw new Error(`row ${index}: application_id is not a UUID`);
    // Same.
    if (typeof r['job_id'] !== 'string' || !UUID.test(r['job_id'])) throw new Error(`row ${index}: job_id is not a UUID`);
    // The two strings.
    if (typeof r['title'] !== 'string' || typeof r['apply_url'] !== 'string') throw new Error(`row ${index}: title or apply_url is not a string`);
    // Narrowed by the checks above.
    return { application_id: r['application_id'], job_id: r['job_id'], title: r['title'], apply_url: r['apply_url'] };
  });
}

// Arguments: input, output, optional cap.
const [inputPath, outputPath, capText] = process.argv.slice(2);
// Both paths are required; a missing one is a usage error, not a default.
if (inputPath === undefined || outputPath === undefined) {
  // Usage on stderr.
  console.error('usage: node worker/scripts/workday-backfill-preview.ts <rows.json> <preview.json> [cap]');
  // Red.
  process.exit(2);
}
// The cap defaults to every row; a given cap must be a positive integer.
const rows = readRows(JSON.parse(await readFile(inputPath, 'utf8')));
// Parsed only when given.
const cap = capText === undefined ? rows.length : Number(capText);
// Refuse NaN, floats, zero and negatives.
if (!Number.isInteger(cap) || cap <= 0) throw new Error(`cap must be a positive integer, got ${capText}`);

// Minimal JobInsert-shaped rows: the fill reads ats_provider, description_raw, title, apply_url.
const jobs = rows.map((row) => ({ ats_provider: 'workday', description_raw: null, title: row.title, apply_url: row.apply_url }) as unknown as JobInsert);
// One run: the real robots-gated GET; every row already passed the title gate when it was screened.
const run = newWorkdayDetailRun({
  // scout-ats's GET, sharing one robots cache across the run.
  get: (url) => fetchBoard(url),
  // These rows reached passed_filters, so the title gate already passed them.
  passesTitleGate: () => true,
  // An hour is far more than 391 reads at 500 ms apart need; it only bounds a hung run.
  deadline: createDeadline({ budgetMs: 3_600_000 }),
  // A real pause between reads.
  pause: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}, cap);
// Read every row's detail page, filling description_raw in place.
await fillWorkdayDescriptions(jobs, run);

// Per row: the ids, and the description or null.
const results = rows.map((row, index) => ({ application_id: row.application_id, job_id: row.job_id, title: row.title, description: jobs[index]!.description_raw ?? null }));
// The counts the orchestrator shows Teja.
const summary = { rows: rows.length, fetched: run.fetched, with_description: run.filled, still_empty: rows.length - run.filled, skipped_by_cap: run.skipped };
// The preview file: summary first, then rows.
await writeFile(outputPath, JSON.stringify({ summary, results }, null, 2));
// The summary on stdout too.
console.log(JSON.stringify(summary));
