// Shape tests for migration 20261121110000: the auditor may drop an awaiting_approval row for work_auth or
// already_applied, and for nothing else (experience_ceiling stays with Teja, orch ruling A 2026-11-21).
//
// WHY TEXT TESTS: no Postgres runs in CI, so the migration is checked as source, like _shared/db/failed-requires-reason-check.test.ts
// does. Each test asserts the POSITIVE shape of one statement (CLAUDE.md §6), never the absence of a word.
import { test } from "node:test";
// Strict asserts, so a near-miss fails.
import assert from "node:assert/strict";
// The migration is read as text.
import { readFileSync } from "node:fs";
// Path helpers, so the test is independent of the cwd.
import { dirname, join } from "node:path";
// import.meta.url to a path.
import { fileURLToPath } from "node:url";

// supabase/functions/auditor -> supabase/migrations.
const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "migrations");
// The migration under test, read as text. A missing file throws here, so the suite cannot pass vacuously.
const SQL = readFileSync(join(MIGRATIONS, "20261121110000_auditor_queue_regate_already_applied.sql"), "utf8");
// The executable part only: comment lines dropped (CRLF-safe), so a statement quoted in the header cannot satisfy a match.
const CODE = SQL.split(/\r?\n/).filter((line) => !line.trimStart().startsWith("--")).join("\n");

test("the guard allows exactly work_auth and already_applied for the auditor's queue drop", () => {
  // The closed list, in the one condition that raises.
  assert.match(CODE, /and coalesce\(new\.drop_reason, ''\) not in \('work_auth', 'already_applied'\) then/);
  // Narrowed to the auditor's move off the queue, read from the GUC advance_application_status sets.
  assert.match(CODE, /if old\.status = 'awaiting_approval'\s+and new\.status = 'dropped_filter'\s+and pg_catalog\.current_setting\('applyy\.acting_agent', true\) = 'auditor'/);
  // Refused with the "not allowed" code callers already handle.
  assert.match(CODE, /using errcode = '42501';/);
});

test("the old work_auth-only trigger and function are dropped before the renamed guard is created", () => {
  // The old trigger goes.
  const oldTrigger = CODE.indexOf("drop trigger if exists guard_auditor_queue_drop_work_auth_only on public.applications;");
  // Its function goes.
  const oldFunction = CODE.indexOf("drop function if exists public.guard_auditor_queue_drop_work_auth_only();");
  // The new trigger is created.
  const created = CODE.search(/create trigger guard_auditor_queue_drop_reason\s+before update of status on public\.applications\s+for each row execute function public\.guard_auditor_queue_drop_reason\(\);/);
  // All three present.
  assert.ok(oldTrigger >= 0 && oldFunction >= 0 && created >= 0, "a drop or the create is missing");
  // In that order: old out, then new in.
  assert.ok(oldTrigger < oldFunction && oldFunction < created, "the old guard must be dropped before the new one is created");
});

test("the guard function pins its search_path and is re-runnable", () => {
  // create or replace, with a fixed search_path.
  assert.match(CODE, /create or replace function public\.guard_auditor_queue_drop_reason\(\)\s+returns trigger\s+language plpgsql\s+set search_path = ''/);
  // The new trigger is dropped if present before it is created (bare create trigger has no if-not-exists).
  assert.match(CODE, /drop trigger if exists guard_auditor_queue_drop_reason on public\.applications;/);
});

test("the header records why it exists, why experience_ceiling stays out, and the deploy order", () => {
  // Why.
  assert.match(SQL, /^-- WHY THIS EXISTS:/m);
  // The 11-11 rule, quoted.
  assert.match(SQL, /^-- WHY IT STAYS INSIDE THE 11-11 RULE:.*for work$/m);
  // The migration before the auditor.
  assert.match(SQL, /^-- DEPLOY ORDER: this migration BEFORE the auditor/m);
});
