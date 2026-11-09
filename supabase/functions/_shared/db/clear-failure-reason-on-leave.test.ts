// Shape tests for migration 20261109233000: every status move to a non-failed status clears applications.failure_reason.
//
// WHY TEXT TESTS: no Postgres runs in CI, so the migration is checked as source, like failed-requires-reason-check.test.ts
// next to this file. The migration RE-CREATES advance_application_status, so besides the new clear these tests pin every
// guard the live function carried on 2026-11-09 23:20 IST: re-creating it from an older file would silently drop them.
import { test } from "node:test";
// Strict asserts: deepEqual/equal compare without coercion.
import assert from "node:assert/strict";
// The migration is read as text from disk.
import { readFileSync } from "node:fs";
// Path helpers to locate supabase/migrations from this file.
import { dirname, join } from "node:path";
// ESM has no __dirname; derive it from import.meta.url.
import { fileURLToPath } from "node:url";

// supabase/functions/_shared/db -> supabase/migrations.
const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "migrations");
// The migration under test, read as text. A missing file throws here, so the suite cannot pass vacuously.
const SQL = readFileSync(join(MIGRATIONS, "20261109233000_clear_failure_reason_on_leave.sql"), "utf8");
// The executable part only: comment lines dropped, so a statement quoted in a comment cannot satisfy a match.
const CODE = SQL.split(/\r?\n/).filter((line) => !line.trimStart().startsWith("--")).join("\n");

test("it replaces the ONE existing function: same 5-argument signature, so no second overload appears", () => {
  // A changed signature would CREATE a new overload beside the old one, and PostgREST refuses ambiguous calls.
  assert.match(
    CODE,
    /create or replace function public\.advance_application_status\(p_application_id uuid, p_to_status application_status, p_agent agent_name, p_detail jsonb default '\{\}'::jsonb, p_expected_updated_at timestamp with time zone default null::timestamp with time zone\)/i,
  );
  // Same pinned search_path as live, so unqualified names cannot be hijacked.
  assert.match(CODE, /set search_path to ''/i);
});

test("failure_reason is the reason on a move to failed and NULL on every other move", () => {
  // The new rule, in the same UPDATE as the status (one statement, so the CHECK never sees a half-written row).
  assert.match(
    CODE,
    /failure_reason = case\s+when p_to_status = 'failed' then p_detail->>'reason'\s+else null\s+end/,
  );
  // Exactly one assignment to the column in the function: a second one could re-copy the old value.
  assert.equal(CODE.match(/\bfailure_reason\s*=/g)?.length, 1);
});

test("the live guards survive the re-create", () => {
  // Each entry: a guard the live definition had, and the text that proves it is still there.
  const guards: [string, RegExp][] = [
    // Declares the acting agent for the status_transition_guard trigger (which enforces the transition graph).
    ["acting agent for the transition trigger", /pg_catalog\.set_config\('applyy\.acting_agent', p_agent::text, true\)/],
    // The machine-agent key check (fail-closed since 20261102210000).
    ["agent key check", /v_key_state := applyy_internal\.agent_key_state\(\);/],
    // A wrong or missing key is refused with 42501.
    ["agent key refusal", /elsif v_key_state <> 'valid' then[\s\S]*?errcode = '42501'/],
    // blocked_needs_human needs a valid block_reason.
    ["block_reason validation", /v_block_reason := \(p_detail->>'block_reason'\)::public\.block_reason;/],
    // failed needs a non-blank p_detail.reason (20261109180000).
    ["failed needs a reason", /if p_to_status = 'failed' and coalesce\(pg_catalog\.btrim\(p_detail->>'reason'\), ''\) = '' then/],
    // The row lock that serialises racing submitters.
    ["row lock", /from public\.applications a\s+where a\.id = p_application_id\s+for update;/],
    // The stale-read CAS on updated_at.
    ["updated_at CAS", /v_updated_at is distinct from p_expected_updated_at[\s\S]*?errcode = 'PT409'/],
    // The double-submit gate.
    ["applying gate", /if v_current = 'applying' and p_to_status = 'applying' then[\s\S]*?errcode = '55000'/],
    // The lease is released in the same statement as the move.
    ["lease release", /claimed_at = null,\s+claimed_by = null,\s+claim_expires_at = null,/],
    // block_reason is still kept on exit (unchanged design, only failure_reason changes).
    ["block_reason kept", /else a\.block_reason/],
    // Not-yours/missing row still raises P0002.
    ["not found", /errcode = 'P0002'/],
    // The note event that keeps the reason in the append-only history.
    ["note event", /insert into public\.application_events \(user_id, application_id, event_type, agent, detail\)/],
  ];
  // Collect every missing guard, so one run names them all.
  const missing = guards.filter(([, pattern]) => !pattern.test(CODE)).map(([name]) => name);
  // An empty list is the pass; the 12 patterns themselves are the non-vacuity (each must match something).
  assert.deepEqual(missing, []);
});

test("the header says why it exists and where the history of a cleared reason lives", () => {
  // CLAUDE.md §7: every migration says why it exists, so nobody "simplifies" it back.
  assert.match(SQL, /^-- WHY THIS EXISTS:/m);
  // The reason is not lost: the →failed move's note event still holds it.
  assert.match(SQL, /application_events/);
});
