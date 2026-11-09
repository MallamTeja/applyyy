// Shape tests for migration 20261109180000: a move to 'failed' must carry p_detail.reason, and
// advance_application_status writes it to applications.failure_reason in the same UPDATE as the status.
//
// WHY TEXT TESTS: no Postgres runs in CI, so the migration is checked as source, like jobs-tombstone.test.ts.
// The third test is the important one: the function is a copy of the live body (20261008160000) with two blocks
// added, and it proves NOTHING ELSE changed, so the agent-key check (fail-closed since 20261102210000), the
// stale-read gate and the double-submit gate cannot drift unnoticed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// supabase/functions/_shared/db -> supabase/migrations.
const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "migrations");
// The new migration, read as text.
const NEW = readFileSync(join(MIGRATIONS, "20261109180000_failed_requires_reason.sql"), "utf8");
// The migration whose function body is live (verified equal to pg_get_functiondef on 2026-11-09).
const BASE = readFileSync(join(MIGRATIONS, "20261008160000_agent_key_header_for_machine_agents.sql"), "utf8");

// The `create or replace function public.advance_application_status ... $$;` block of one migration.
function functionBlock(sql: string): string {
  // Where the definition starts; there is exactly one in each file.
  const start = sql.indexOf("create or replace function public.advance_application_status(");
  // A missing definition must fail loudly, not compare two empty strings (CLAUDE.md §6).
  assert.ok(start >= 0, "advance_application_status definition not found");
  // The body's closing delimiter after the start.
  const end = sql.indexOf("\n$$;", start);
  // Same: no end, no comparison.
  assert.ok(end > start, "end of the function body not found");
  // Up to and including the delimiter.
  return sql.slice(start, end + 4);
}

test("a move to failed without p_detail.reason is refused with 22023", () => {
  // The guard, exactly: missing, null, empty and whitespace-only all count as no reason.
  assert.match(NEW, /if p_to_status = 'failed' and coalesce\(pg_catalog\.btrim\(p_detail->>'reason'\), ''\) = '' then\n[^\n]*\n\s*raise exception 'p_detail\.reason is required when moving to failed[^']*'\n\s*using errcode = '22023';/);
});

test("the reason is written to failure_reason in the same UPDATE as the status", () => {
  // The function body only, so a comment elsewhere cannot satisfy the match.
  const body = functionBlock(NEW);
  // Inside the one UPDATE: failed takes the reason, every other move keeps the column.
  assert.match(body, /failure_reason = case\n\s*when p_to_status = 'failed' then p_detail->>'reason'\n\s*else a\.failure_reason\n\s*end\n\s*where a\.id = p_application_id/);
});

test("apart from the two NEW-FAILREASON blocks, the function is byte-identical to the live 20261008160000 body", () => {
  // Remove block 1 (the guard: its comment lines through `end if;` and the blank line after).
  const withoutGuard = functionBlock(NEW).replace(/  -- NEW-FAILREASON \(2026-11-09\)[\s\S]*?  end if;\n\n/, "");
  // Remove block 2 (the assignment), restoring block_detail's closing `end` without the comma.
  const withoutBoth = withoutGuard.replace(/         end,\n         -- NEW-FAILREASON:[\s\S]*?           else a\.failure_reason\n/, "");
  // Each removal must have happened, or the equality below could pass on a file that lost a block.
  assert.notEqual(withoutGuard, functionBlock(NEW), "guard block not found");
  // Same for the assignment block.
  assert.notEqual(withoutBoth, withoutGuard, "failure_reason block not found");
  // What remains is the live body, byte for byte.
  assert.equal(withoutBoth, functionBlock(BASE));
});
