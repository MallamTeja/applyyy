// Tests for the jobs TOMBSTONE space policy (migration 20261105200000_jobs_tombstone.sql).
//
// WHAT THE POLICY IS, in one line: old `dropped_filter` jobs keep a slim row (so the
// fingerprint still dedupes tomorrow's scan) and lose their heavy payload
// (description_raw + raw_payload), marked by `jobs.tombstoned_at`.
//
// WHY MOST OF THESE READ THE MIGRATION AS TEXT. The guards are SQL — a trigger, a CHECK
// and a plpgsql function — and this repo has no disposable Postgres in its test run (no
// pglite, no local stack in CI), so the honest options were "assert the SQL's shape" or
// "test nothing". Each assertion names the POSITIVE shape that does the work (CLAUDE.md §6:
// never the absence of a substring), with comments stripped first so a comment that
// merely mentions the right words cannot satisfy it. The live proof is the post-apply
// SELECT in docs/db/2026-11-05-jobs-tombstone-policy.md, run by the orchestrator.
//
// RED-ON-REVERT, checked by hand when this was written: deleting the trigger turns the
// edge-1 tests red; changing `description_raw = null` to `''` in the function turns the
// edge-3 shape test red; dropping the `a.status = 'dropped_filter'` filter turns the
// non-dropped test red.
import { test } from "node:test";
// Strict, so a near-miss never compares equal.
import assert from "node:assert/strict";
// Read the migration from disk; no network, no database.
import { readFileSync } from "node:fs";
// Resolve from this file, so the suite behaves the same from any cwd.
import { dirname, join } from "node:path";
// ESM has no __dirname; derive it from the module URL.
import { fileURLToPath } from "node:url";
// The matcher's usable-job gate (fail-exit.ts -> planTailorBatch), the gate every revived
// row reaches first, because the only edge out of dropped_filter lands at passed_filters.
import { planTailorBatch } from "../tailor/tailor-batch.ts";

// This file's directory, for a cwd-independent path to the migration.
const HERE = dirname(fileURLToPath(import.meta.url));
// supabase/functions/_shared/screen -> supabase/migrations.
const MIGRATION = join(HERE, "..", "..", "..", "migrations", "20261105200000_jobs_tombstone.sql");

// The migration with `--` comments removed, whitespace collapsed and lower-cased, so the
// assertions below match the executable SQL only — never a comment describing it.
const sql = readFileSync(MIGRATION, "utf8")
  // Strip line comments; the migration has no `--` inside a string literal.
  .replace(/--[^\n]*/g, " ")
  // One space between tokens, so line breaks in the SQL do not matter.
  .replace(/\s+/g, " ")
  // SQL keywords are case-insensitive; compare that way.
  .toLowerCase();

// One function's body (between its `as $$` and the closing `$$;`), so an assertion about
// the trigger cannot be satisfied by text in the tombstoning function, or vice versa.
function functionBody(name: string): string {
  // Where this function's definition starts.
  const start = sql.indexOf(`create or replace function public.${name}(`);
  // A missing function is a failure, never an empty body that matches nothing.
  assert.notEqual(start, -1, `migration must define public.${name}()`);
  // The dollar-quoted body opens after the header...
  const open = sql.indexOf("$$", start);
  // ...and closes at the next dollar-quote.
  const close = sql.indexOf("$$", open + 2);
  // Both delimiters must exist, or the slice below would be garbage.
  assert.ok(open !== -1 && close !== -1, `public.${name}() must have a $$ body`);
  // Just the code between them.
  return sql.slice(open + 2, close);
}

// EDGE CASE 1, part a: the trigger exists, fires BEFORE every UPDATE, row by row, on jobs.
test("edge 1: a BEFORE UPDATE row trigger on public.jobs runs jobs_keep_tombstone_slim", () => {
  // BEFORE (so the slimmed row is what gets written) and FOR EACH ROW (per-row decision).
  assert.match(
    sql,
    /create trigger jobs_keep_tombstone_slim before update on public\.jobs for each row execute function public\.jobs_keep_tombstone_slim\(\)/,
  );
});

// EDGE CASE 1, part b: re-discovery cannot re-fill. While the marker stays set, BOTH heavy
// columns are forced back to NULL, whatever the writer (a scout re-sighting) sent.
test("edge 1: while tombstoned_at stays set, the trigger nulls raw_payload and description_raw", () => {
  // The trigger's body only.
  const body = functionBody("jobs_keep_tombstone_slim");
  // The condition is on NEW, so it covers both "was a tombstone and the writer did not
  // clear it" (re-sighting) and "is being tombstoned now".
  assert.match(
    body,
    /if new\.tombstoned_at is not null then new\.raw_payload := null; new\.description_raw := null; end if;/,
  );
  // The trigger must hand the row on, or the UPDATE would write nothing.
  assert.match(body, /return new;/);
});

// EDGE CASE 1, part c: the invariant is a constraint, so even a path around the trigger
// (an INSERT carrying a tombstone and a payload) is refused rather than stored.
test("edge 1: CHECK jobs_tombstone_is_slim makes a fat tombstone unrepresentable", () => {
  // The exact predicate: marker unset, or both heavy columns empty.
  assert.match(
    sql,
    /add constraint jobs_tombstone_is_slim check \(tombstoned_at is null or \(raw_payload is null and description_raw is null\)\)/,
  );
});

// EDGE CASE 3, part a: the tombstone writes NULL — never '' — and sets the explicit
// needs_refetch marker in the same statement.
test("edge 3: tombstone_dropped_jobs purges to NULL and sets the tombstoned_at marker", () => {
  // The tombstoning function's body only.
  const body = functionBody("tombstone_dropped_jobs");
  // NULL, so every shape-checking gate reads it as absent; '' would be a blank "JD".
  assert.match(body, /description_raw = null,/);
  // Same for the raw board JSON.
  assert.match(body, /raw_payload = null,/);
  // The explicit state readers can test for, instead of guessing from a blank.
  assert.match(body, /tombstoned_at = now\(\)/);
});

// EDGE CASE 3, part b: a tombstoned row that is revived (the human paste edge lands it at
// passed_filters) reaches the matcher's usable-job gate, which must refuse it, never score
// a blank JD. This pins the gate's verdict for exactly the row shape a tombstone produces.
test("edge 3: the matcher's usable-job gate refuses a tombstoned row as missing_description", () => {
  // The joined row a revived tombstone would arrive as: live, titled, but text purged.
  const revivedTombstone = {
    // The application id the gate reports against.
    id: "app-1",
    // The joined job, shaped like the post-tombstone row.
    jobs: {
      // Title and company survive a tombstone; they are part of the slim row.
      title: "Software Engineer",
      // Same.
      company_name: "Acme",
      // Purged by tombstone_dropped_jobs.
      description_raw: null,
      // The marker that says why.
      tombstoned_at: "2026-11-05T14:00:00Z",
      // Live (selected and null), so liveness does not pre-empt the description check.
      disappeared_at: null,
    },
  };
  // Run the real gate.
  const plan = planTailorBatch([revivedTombstone]);
  // Nothing tailorable: a blank JD is never work.
  assert.equal(plan.tailorable.length, 0);
  // Refused for the right reason, against the right row.
  assert.deepEqual(plan.skipped, [{ applicationId: "app-1", reason: "missing_description" }]);
});

// Teja 15:31: the cleanup NEVER touches non-dropped rows. The rule must be in the WHERE
// clause of the batch pick (one application per job, so this filter is the whole rule).
test("only jobs whose application is dropped_filter are picked", () => {
  // The tombstoning function's body only.
  const body = functionBody("tombstone_dropped_jobs");
  // The application must be a rejection.
  assert.match(body, /where a\.status = 'dropped_filter'/);
  // Aged by the VERDICT's timestamp, with the caller's grace window.
  assert.match(body, /a\.status_changed_at < now\(\) - make_interval\(days => p_min_age_days\)/);
  // Already-tombstoned rows are skipped, so every call makes progress.
  assert.match(body, /j\.tombstoned_at is null/);
  // Bounded and non-blocking.
  assert.match(body, /limit p_batch_size for update of j, a skip locked/);
});

// The bounds that keep one call from becoming an unbounded rewrite or a silent no-op.
test("bad arguments raise instead of tombstoning everything or nothing", () => {
  // The tombstoning function's body only.
  const body = functionBody("tombstone_dropped_jobs");
  // Age: null or < 1 day refused.
  assert.match(body, /if p_min_age_days is null or p_min_age_days < 1 then raise exception/);
  // Batch: null, < 1 or > 5000 refused.
  assert.match(body, /if p_batch_size is null or p_batch_size < 1 or p_batch_size > 5000 then raise exception/);
});

// Callable by the signed-in app user (the weekly workflow), never anonymously.
test("execute is granted to authenticated and revoked from anon", () => {
  // Anonymous callers lose the default PUBLIC execute.
  assert.match(sql, /revoke all on function public\.tombstone_dropped_jobs\(integer, integer\) from public, anon;/);
  // The workflow's app user can call it.
  assert.match(sql, /grant execute on function public\.tombstone_dropped_jobs\(integer, integer\) to authenticated;/);
});

// EDGE CASE 4: a pasted link of a tombstoned job revives it with the re-fetched text. The
// jobs_keep_tombstone_slim trigger discards that text unless the SAME update clears the
// marker, so job-link-intake's fill must carry `tombstoned_at: null` next to description_raw.
// Read as source text because `makeStore` is a private adapter over a live client; the
// assertion pins the exact spread, with comments stripped so prose cannot satisfy it.
test("edge 4: job-link-intake's description fill also clears tombstoned_at", () => {
  // The intake adapter, from this file's directory: _shared/screen -> job-link-intake.
  const intake = readFileSync(join(HERE, "..", "..", "job-link-intake", "index.ts"), "utf8")
    // Strip line comments, so only code can match.
    .replace(/\/\/[^\n]*/g, " ")
    // Collapse whitespace, so formatting does not matter.
    .replace(/\s+/g, " ");
  // The fill spread names both columns together: text back AND marker cleared.
  assert.match(
    intake,
    /\.\.\.\(descriptionRaw !== null \? \{ description_raw: descriptionRaw, tombstoned_at: null \} : \{\}\)/,
  );
});

// --- The weekly runner, scripts/jobs-tombstone.mjs (driven with fakes; no network) -------

// The loop and the input parser, imported from the script the workflow runs.
import { runBatches, positiveInt } from "../../../../scripts/jobs-tombstone.mjs";
// The identity list the Health page derives its roster from.
import { AGENT_NAMES } from "../../../../packages/shared-types/src/enums.ts";

// The loop stops on 0 only: under SKIP LOCKED a short batch does not mean "drained".
test("runner: keeps calling after a short batch and stops only on 0", async () => {
  // Batches as the database might return them: full, short (locked rows skipped), empty.
  const answers = [1000, 37, 0];
  // Each call takes the next answer.
  const result = await runBatches(async () => answers.shift(), 50);
  // All three calls made, every row counted, and the run reports it drained the backlog.
  assert.deepEqual(result, { total: 1037, calls: 3, drained: true });
});

// The cap is a hard stop, reported as "not drained" rather than as a clean finish.
test("runner: stops at the batch cap and reports more may remain", async () => {
  // A backlog that never empties within the cap.
  const result = await runBatches(async () => 1000, 3);
  // Exactly the cap, and the run says it did not finish.
  assert.deepEqual(result, { total: 3000, calls: 3, drained: false });
});

// A malformed RPC answer is a broken contract, never a "0 rows, done" (CLAUDE.md §6).
test("runner: a non-integer RPC answer throws instead of ending the run as drained", async () => {
  // null is what a lenient reader would turn into 0.
  await assert.rejects(runBatches(async () => null, 5), /not a row count/);
  // A string that looks numeric is still not the integer the function returns.
  await assert.rejects(runBatches(async () => "5", 5), /not a row count/);
});

// Workflow inputs: blank uses the default; anything that is not plain digits >= 1 is refused.
test("runner: positiveInt defaults on blank and refuses what Number() would accept", () => {
  // A scheduled run passes empty inputs: the default applies.
  assert.equal(positiveInt("MIN_AGE_DAYS", "", 7), 7);
  // Unset behaves the same.
  assert.equal(positiveInt("MIN_AGE_DAYS", undefined, 7), 7);
  // A real value is read.
  assert.equal(positiveInt("BATCH_SIZE", "500", 1000), 500);
  // Number(" 7 ") is 7 and Number("1e3") is 1000; both are refused here.
  assert.throws(() => positiveInt("MIN_AGE_DAYS", " 7 ", 7), /positive integer/);
  // Exponent notation is refused too.
  assert.throws(() => positiveInt("BATCH_SIZE", "1e3", 1000), /positive integer/);
  // Zero would tombstone nothing (or, for days, everything just dropped): refused.
  assert.throws(() => positiveInt("MIN_AGE_DAYS", "0", 7), />= 1/);
});

// The script logs under its own identity, which must exist in the shared enum (and so, via
// enum-parity.test.ts, in migration 20261105201000), or every run's agent_runs insert fails.
test("runner: logs as 'jobs_tombstone', a declared agent identity", () => {
  // The script's source, to read the identity it actually sends.
  const script = readFileSync(join(HERE, "..", "..", "..", "..", "scripts", "jobs-tombstone.mjs"), "utf8");
  // The insert names this identity.
  assert.match(script, /agent: "jobs_tombstone", status: "running"/);
  // And the identity is declared.
  assert.ok((AGENT_NAMES as readonly string[]).includes("jobs_tombstone"));
});
