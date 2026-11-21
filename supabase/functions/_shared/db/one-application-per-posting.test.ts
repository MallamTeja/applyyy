// Shape tests for migration 20261121140000: the database refuses a second apply for one ATS posting (Canonical
// greenhouse 5150422 was applied twice, 11-11 and 11-18, through a retitled twin).
//
// WHY TEXT TESTS: no Postgres runs in CI, so the migration is checked as source, like the other tests in this folder.
// Each test asserts the POSITIVE shape of one statement (CLAUDE.md section 6), on CODE (comments stripped) so the
// header's prose can never satisfy a match.
import { test } from "node:test";
// Strict comparisons.
import assert from "node:assert/strict";
// The migration is read from disk.
import { readFileSync } from "node:fs";
// Path helpers.
import { dirname, join } from "node:path";
// This file's own location.
import { fileURLToPath } from "node:url";

// supabase/functions/_shared/db -> supabase/migrations.
const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "migrations");
// The migration under test, as text. A missing file throws here, so the suite cannot pass vacuously.
const SQL = readFileSync(join(MIGRATIONS, "20261121140000_guard_one_application_per_posting.sql"), "utf8");
// The executable part only: SQL comment lines dropped.
const CODE = SQL.split("\n").filter((line) => !line.trimStart().startsWith("--")).join("\n");

test("fires only on a real move INTO 'applying' (a re-save at 'applying' never blocks itself)", () => {
  // The early return for anything else, with the distinct-from guard.
  assert.match(CODE, /if new\.status::text <> 'applying' or old\.status is not distinct from new\.status then/);
});

test("the blocking statuses are exactly the submitted-or-submitting list; 'failed' and 'approved' do not block", () => {
  // The one IN list in the lookup.
  const list = /a\.status::text in \(([^)]*)\)/.exec(CODE)?.[1];
  // Present.
  assert.ok(list !== undefined, "status list missing");
  // Exactly these nine, in this order.
  assert.deepEqual(list.split(",").map((s) => s.trim().replace(/'/g, "")), ["applying", "blocked_needs_human", "needs_verification", "applied", "employer_screening", "oa_pending", "interview", "offer", "rejected"]);
});

test("same user, another row, same posting key normalised like atsJobKeyOf (lower+trim provider, trim id)", () => {
  // The key of the moved row.
  assert.match(CODE, /select lower\(btrim\(j\.ats_provider::text\)\), btrim\(j\.ats_job_id\), 'manual' = any\(j\.discovered_via::text\[\]\)/);
  // The twin lookup: same user, not itself, same normalised key.
  assert.match(CODE, /where a\.user_id = new\.user_id\s+and a\.id <> new\.id\s+and lower\(btrim\(j\.ats_provider::text\)\) = v_provider\s+and btrim\(j\.ats_job_id\) = v_ats_id/);
});

test("exempt: no usable key ('other' aggregator, blank) and Teja's pasted ('manual') jobs", () => {
  // The exemption, before the lock and the lookup.
  assert.match(CODE, /if v_ats_id is null or v_ats_id = '' or v_provider is null or v_provider in \('', 'other'\) or coalesce\(v_manual, false\) then\s+return new;/);
});

test("serialises same-posting moves with a transaction advisory lock taken BEFORE the lookup (concurrent claims)", () => {
  // The lock on user | provider | id.
  const lock = CODE.indexOf("perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(new.user_id::text || '|' || v_provider || '|' || v_ats_id, 0));");
  // The lookup.
  const lookup = CODE.indexOf("from public.applications a");
  // Both present, lock first.
  assert.ok(lock > 0 && lookup > lock, `lock ${lock}, lookup ${lookup}`);
});

test("a twin is refused with 23505 (a uniqueness rule), never a silent pass", () => {
  // The raise inside the twin branch.
  assert.match(CODE, /if v_twin is not null then\s+raise exception [\s\S]*?using errcode = '23505';/);
});

test("a BEFORE UPDATE OF status row trigger, re-runnable, with a fixed search_path", () => {
  // Fixed search_path on the function.
  assert.match(CODE, /create or replace function public\.guard_one_application_per_posting\(\)[\s\S]*?set search_path = ''/);
  // The trigger is dropped before it is created.
  const drop = CODE.indexOf("drop trigger if exists guard_one_application_per_posting on public.applications;");
  // The create.
  const create = CODE.search(/create trigger guard_one_application_per_posting\s+before update of status on public\.applications[\s\S]*?for each row execute function public\.guard_one_application_per_posting\(\);/);
  // Both, in order.
  assert.ok(drop > 0 && create > drop, `drop ${drop}, create ${create}`);
});

test("the header records why it exists, why not an index, the exemptions and the concurrency reason", () => {
  // The incident.
  assert.match(SQL, /5150422/);
  // Why a trigger.
  assert.match(SQL, /An\s+(?:--\s+)?index cannot span two tables/);
  // Human edges stay free.
  assert.match(SQL, /Human edges straight INTO 'applied'/);
  // The concurrency reason.
  assert.match(SQL, /cannot see another transaction's UNCOMMITTED 'applying' row/);
});
