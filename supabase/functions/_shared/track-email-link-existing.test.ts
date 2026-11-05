// Tests for migration 20261105220000_track_email_as_applied_link_existing.sql.
//
// WHAT THE MIGRATION DOES, in one line: Add to Applied on the Emails page REUSES the one existing job
// with the same company and title (case- and space-insensitive) instead of creating a second one.
//
// WHY THESE READ THE MIGRATION AS TEXT. The logic is plpgsql and this repo has no disposable Postgres in
// its test run, so the honest options are "assert the SQL's shape" or "test nothing" (the same call as
// screen/jobs-tombstone.test.ts). Each assertion names the POSITIVE shape that does the work (CLAUDE.md
// §6), with `--` comments stripped first, so a comment that merely mentions the right words cannot pass.
//
// RED-ON-REVERT, checked by hand when this was written: deleting the lookup's `select count(*) ...`
// statement from the migration turns "the lookup matches company AND title case-insensitively, scoped
// to the email's user" red.
import { test } from "node:test";
// Strict, so a near-miss never compares equal.
import assert from "node:assert/strict";
// Read the migration from disk; no network, no database.
import { readFileSync } from "node:fs";
// Resolve from this file, so the suite behaves the same from any cwd.
import { dirname, join } from "node:path";
// ESM has no __dirname; derive it from the module URL.
import { fileURLToPath } from "node:url";

// This file's directory, for a cwd-independent path to the migration.
const HERE = dirname(fileURLToPath(import.meta.url));
// supabase/functions/_shared -> supabase/migrations.
const MIGRATION = join(HERE, "..", "..", "migrations", "20261105220000_track_email_as_applied_link_existing.sql");

// The migration with `--` comments removed, whitespace collapsed and lower-cased, so the assertions
// below match executable SQL only. A missing file throws here, which is the red-first state.
const sql = readFileSync(MIGRATION, "utf8")
  // Strip line comments; the migration has no `--` inside a string literal.
  .replace(/--[^\n]*/g, " ")
  // One space between tokens, so line breaks in the SQL do not matter.
  .replace(/\s+/g, " ")
  // SQL keywords are case-insensitive; compare that way.
  .toLowerCase();

// The function's body (between `as $$` and the closing `$$`), so the grants below cannot satisfy a body
// assertion, nor the body a grant assertion.
function body(): string {
  // Where the definition starts; the same signature as 20261105124600.
  const start = sql.indexOf("create or replace function public.track_email_as_applied( p_email_event_id uuid, p_company text, p_company_slug text, p_title text ) returns uuid");
  // A missing or re-shaped signature is a failure, never an empty body that matches nothing.
  assert.notEqual(start, -1, "migration must create or replace track_email_as_applied with the same signature");
  // The dollar-quoted body opens after the header...
  const open = sql.indexOf("$$", start);
  // ...and closes at the next dollar-quote.
  const close = sql.indexOf("$$", open + 2);
  // Both delimiters must exist, or the slice below would be garbage.
  assert.ok(open !== -1 && close !== -1, "the function must have a $$ body");
  // Just the code between them.
  return sql.slice(open + 2, close);
}

// The fix itself: one lookup, both columns compared trimmed and lower-cased, only the email owner's jobs.
test("the lookup matches company AND title case-insensitively, scoped to the email's user", () => {
  // Count and the first id in ONE statement, so the single-match test below reads the same snapshot.
  assert.match(
    body(),
    /select count\(\*\), \(array_agg\(j\.id\)\)\[1\] into v_matches, v_job from public\.jobs j where j\.user_id = v_email\.user_id and lower\(btrim\(j\.company_name\)\) = lower\(btrim\(p_company\)\) and lower\(btrim\(j\.title\)\) = lower\(btrim\(p_title\)\);/,
  );
});

// Exactly one match is reused; zero or several fall through to the create path (never a guess).
test("only a single match is reused; zero or several still create a job", () => {
  // The branch condition is equality with 1, not "> 0" (which would pick one of several at random).
  assert.match(body(), /if v_matches <> 1 then insert into public\.jobs \(/);
});

// Today's path survives unchanged: the email-fingerprinted job, idempotent on a re-run.
test("the original insert path is still present: fingerprint email:<id>, on conflict do nothing", () => {
  // The fingerprint that makes one email create at most one job.
  assert.match(body(), /v_fingerprint := 'email:' \|\| v_email\.id::text;/);
  // The insert's idempotency clause.
  assert.match(body(), /on conflict \(user_id, fingerprint\) do nothing;/);
  // The created job's id is read back by that fingerprint.
  assert.match(body(), /select j\.id into v_job from public\.jobs j where j\.user_id = v_email\.user_id and j\.fingerprint = v_fingerprint;/);
});

// A reused job's application is reused too, and the status still moves only through the one writer.
test("the application is reused per job, and only an unapplied one is advanced via advance_application_status", () => {
  // Born at discovered (guard_status_insert's legal birth) only when the job has none.
  assert.match(body(), /insert into public\.applications \(user_id, job_id\) values \(v_email\.user_id, v_job\) on conflict \(user_id, job_id\) do nothing;/);
  // An application already applied (applied_at stamped by the guard trigger) is linked, never moved.
  assert.match(body(), /if v_applied_at is null then perform public\.advance_application_status\( v_app, 'applied'::public\.application_status, 'human'::public\.agent_name,/);
});

// A retry after a lost answer must stay safe when the email was linked to a REUSED job.
test("a re-run returns the email's own link when the linked job is the same company and title", () => {
  // The linked application's job is this email's job, or this user's job with the typed company and title.
  assert.match(
    body(),
    /\(j\.fingerprint = v_fingerprint or \(lower\(btrim\(j\.company_name\)\) = lower\(btrim\(p_company\)\) and lower\(btrim\(j\.title\)\) = lower\(btrim\(p_title\)\)\)\)/,
  );
});

// Same rights as before: invoker (RLS scopes every row), empty search_path, authenticated only.
test("security, search_path and grants are unchanged", () => {
  // The caller's rights.
  assert.match(sql, /returns uuid language plpgsql security invoker set search_path = '' as \$\$/);
  // Nobody but the browser's role.
  assert.match(sql, /revoke all on function public\.track_email_as_applied\(uuid, text, text, text\) from public, anon;/);
  // The browser's role.
  assert.match(sql, /grant execute on function public\.track_email_as_applied\(uuid, text, text, text\) to authenticated;/);
});
