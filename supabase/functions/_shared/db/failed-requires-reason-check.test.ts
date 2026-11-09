// Shape tests for migration 20261109211000: the table itself refuses a failed row without a failure_reason.
//
// WHY TEXT TESTS: no Postgres runs in CI, so the migration is checked as source, like failed-requires-reason.test.ts
// next to this file. Each test asserts the POSITIVE shape of one statement (CLAUDE.md §6), never the absence of a word.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// supabase/functions/_shared/db -> supabase/migrations.
const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "migrations");
// The migration under test, read as text. A missing file throws here, so the suite cannot pass vacuously.
const SQL = readFileSync(join(MIGRATIONS, "20261109211000_failed_requires_reason_check.sql"), "utf8");
// The executable part only: comment lines dropped, so a statement quoted in the header cannot satisfy a match.
const CODE = SQL.split("\n").filter((line) => !line.trimStart().startsWith("--")).join("\n");

test("the CHECK refuses failed with a null OR blank failure_reason, added NOT VALID", () => {
  // The exact predicate: non-failed rows pass; a failed row needs a non-blank reason (a null-check alone passes '').
  // The coalesce is load-bearing: without it a null reason makes the predicate NULL, and a CHECK passes on NULL.
  assert.match(
    CODE,
    /alter table public\.applications\s+add constraint applications_failed_has_reason\s+check \(status <> 'failed' or pg_catalog\.btrim\(coalesce\(failure_reason, ''\)\) <> ''\)\s+not valid;/,
  );
});

test("the constraint is validated in the same migration, after it is added", () => {
  // Where the ADD sits; the ADD test above proves it exists.
  const add = CODE.indexOf("add constraint applications_failed_has_reason");
  // Where the VALIDATE sits.
  const validate = CODE.search(/alter table public\.applications\s+validate constraint applications_failed_has_reason;/);
  // VALIDATE must exist, or the old rows would never be checked and a missed back-fill would go unnoticed.
  assert.ok(validate >= 0, "VALIDATE CONSTRAINT statement not found");
  // And it must come after the ADD, or it would name a constraint that does not exist yet.
  assert.ok(validate > add, "VALIDATE must follow the ADD");
});

test("the header records why it exists and that it ships after the back-fill", () => {
  // The reason someone must not "simplify" it away (CLAUDE.md §7: every migration says why it exists).
  assert.match(SQL, /^-- WHY THIS EXISTS:/m);
  // The deploy order: applied before the back-fill, VALIDATE fails and the push rolls back.
  assert.match(SQL, /^-- DEPLOY ORDER: .*AFTER the failure_reason back-fill/m);
});
