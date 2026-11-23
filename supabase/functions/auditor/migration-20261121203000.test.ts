// Shape tests for migration 20261121203000: the auditor may now also drop an awaiting_approval row for a senior grade
// (drop_reason title_seniority, Teja 2026-11-21 20:12 "Drop AVP/VP/Director"), and still for nothing else.
//
// WHY TEXT TESTS: no Postgres runs in CI, so the migration is checked as source, as migration-20261121110000.test.ts
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
// The sweep's closed code list, so the migration and the code that writes the column cannot drift apart.
import type { RegateDropCode } from "./regate-queue.ts";

// supabase/functions/auditor -> supabase/migrations.
const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "migrations");
// The migration under test. A missing file throws here, so the suite cannot pass vacuously.
const SQL = readFileSync(join(MIGRATIONS, "20261121203000_auditor_queue_regate_title_seniority.sql"), "utf8");
// The executable part only (CRLF-safe), so a statement quoted in the header cannot satisfy a match.
const CODE = SQL.split(/\r?\n/).filter((line) => !line.trimStart().startsWith("--")).join("\n");

test("the guard allows exactly work_auth, already_applied and title_seniority for the auditor's queue drop", () => {
  // The closed list, in the one condition that raises.
  assert.match(CODE, /and coalesce\(new\.drop_reason, ''\) not in \('work_auth', 'already_applied', 'title_seniority'\) then/);
  // Narrowed to the auditor's move off the queue, as before.
  assert.match(CODE, /if old\.status = 'awaiting_approval'\s+and new\.status = 'dropped_filter'\s+and pg_catalog\.current_setting\('applyy\.acting_agent', true\) = 'auditor'/);
  // Refused with the "not allowed" code callers already handle.
  assert.match(CODE, /using errcode = '42501';/);
});

test("every code the sweep can write is in the migration's allowed list", () => {
  // The TypeScript union, spelled out; adding a code to RegateDropCode without the trigger fails to compile here.
  const codes: Record<RegateDropCode, true> = { work_auth: true, already_applied: true, title_seniority: true };
  // Each one appears quoted inside the allowed list.
  for (const code of Object.keys(codes)) assert.match(CODE, new RegExp(`not in \\([^)]*'${code}'[^)]*\\) then`), code);
});

test("the function keeps its name, search_path and the existing trigger (create or replace, no trigger churn)", () => {
  // Same function, fixed search_path.
  assert.match(CODE, /create or replace function public\.guard_auditor_queue_drop_reason\(\)\s+returns trigger\s+language plpgsql\s+set search_path = ''/);
});

test("the header records Teja's ruling, why experience_ceiling stays out, and the deploy order", () => {
  // Why, with the ruling quoted.
  assert.match(SQL, /^-- WHY THIS EXISTS: Teja ruled at 20:12 IST on 2026-11-21.*"Drop AVP\/VP\/Director"\.$/m);
  // experience_ceiling stays reported only.
  assert.match(SQL, /experience_ceiling stays OUT/);
  // The migration before the auditor.
  assert.match(SQL, /^-- DEPLOY ORDER: this migration BEFORE the auditor/m);
});
