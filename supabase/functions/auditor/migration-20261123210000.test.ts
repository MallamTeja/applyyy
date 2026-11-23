// Shape tests for migration 20261123210000: search_preferences.spoken_languages (the language gate's list, seeded
// {English}, nullable = gate open) and the auditor's queue drop opened to language_required (2026-11-23, BBHT 5e108a32).
//
// WHY TEXT TESTS: no Postgres runs in CI, so the migration is checked as source, like migration-20261121203000.test.ts.
// Each test asserts the POSITIVE shape of one statement (CLAUDE.md section 6), never the absence of a word.
// WHY THE UNION IS READ FROM SOURCE: node strips types and deno check skips test files, so a typed Record<Union, true>
// literal never fails anywhere. Parsing regate-queue.ts at run time makes "a sweep code the trigger refuses" a red test.
import { test } from "node:test";
// Strict asserts, so a near-miss fails.
import assert from "node:assert/strict";
// The migration and the sweep source are read as text.
import { readFileSync } from "node:fs";
// Path helpers, so the test is independent of the cwd.
import { dirname, join } from "node:path";
// import.meta.url to a path.
import { fileURLToPath } from "node:url";

// This folder (supabase/functions/auditor).
const HERE = dirname(fileURLToPath(import.meta.url));
// The migration under test. A missing file throws here, so the suite cannot pass vacuously.
const SQL = readFileSync(join(HERE, "..", "..", "migrations", "20261123210000_search_preferences_spoken_languages.sql"), "utf8");
// The executable part only (CRLF-safe), so a statement quoted in the header cannot satisfy a match.
const CODE = SQL.split(/\r?\n/).filter((line) => !line.trimStart().startsWith("--")).join("\n");
// The sweep's source, for its RegateDropCode union.
const SWEEP = readFileSync(join(HERE, "regate-queue.ts"), "utf8");

test("the column is nullable text[], added re-runnably, and only null rows are seeded with English", () => {
  // Added if missing, no default, no NOT NULL: null is "never set".
  assert.match(CODE, /alter table public\.search_preferences\s+add column if not exists spoken_languages text\[\];/);
  // The seed touches only rows never set, so a re-run never overwrites a saved list.
  assert.match(CODE, /update public\.search_preferences\s+set spoken_languages = array\['English'\]\s+where spoken_languages is null;/);
});

test("the guard's allowed list equals the sweep's RegateDropCode union, read from source", () => {
  // The union declaration in regate-queue.ts.
  const union = /export type RegateDropCode = ([^;]+);/.exec(SWEEP);
  // Found, or the parse below would compare nothing.
  assert.ok(union !== null, "RegateDropCode declaration not found");
  // Its string literals.
  const codes = [...union[1]!.matchAll(/"([a-z_]+)"/g)].map((match) => match[1]!).sort();
  // The four codes this migration is for (guards against a parse that found too few).
  assert.deepEqual(codes, ["already_applied", "language_required", "title_seniority", "work_auth"]);
  // The SQL closed list, in the one condition that raises.
  const list = /and coalesce\(new\.drop_reason, ''\) not in \(([^)]*)\) then/.exec(CODE);
  // Found.
  assert.ok(list !== null, "allowed list not found");
  // Its quoted codes.
  const allowed = [...list[1]!.matchAll(/'([a-z_]+)'/g)].map((match) => match[1]!).sort();
  // Exactly the union: a sweep code the trigger refuses, or a trigger code no sweep writes, is red.
  assert.deepEqual(allowed, codes);
});

test("the guard keeps its name, search_path, auditor narrowing and 42501", () => {
  // Same function, fixed search_path.
  assert.match(CODE, /create or replace function public\.guard_auditor_queue_drop_reason\(\)\s+returns trigger\s+language plpgsql\s+set search_path = ''/);
  // Narrowed to the auditor's move off the queue, as before.
  assert.match(CODE, /if old\.status = 'awaiting_approval'\s+and new\.status = 'dropped_filter'\s+and pg_catalog\.current_setting\('applyy\.acting_agent', true\) = 'auditor'/);
  // Refused with the "not allowed" code callers already handle.
  assert.match(CODE, /using errcode = '42501';/);
});

test("the header records why, the fail-open null, and the deploy order", () => {
  // Why, with the live case.
  assert.match(SQL, /^-- WHY THIS EXISTS \(Teja, 2026-11-23 20:00 IST\)/m);
  // Null means open, never "speaks nothing".
  assert.match(SQL, /^-- WHY NULLABLE WITH NO DEFAULT\. null = never set/m);
  // The migration before the auditor that writes the new code.
  assert.match(SQL, /^-- DEPLOY ORDER: this migration BEFORE the auditor that writes language_required\.$/m);
});
