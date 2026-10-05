// Coupling guard: tailor/index.ts must SELECT the column tailor-batch.ts fails closed on.
//
// WHY THIS EXISTS: planTailorBatch skips any row whose joined job has no `disappeared_at`
// key as liveness_unknown. That is right per row, but it couples two files: ship the
// planner without the select change and the Tailor skips 100% of rows. No typecheck sees
// it (postgrest select strings are untyped here), so this test reads the entrypoint.
//
// SHAPE, NOT SUBSTRING (CLAUDE.md §3): the column name also appears in comments explaining
// this very coupling, so a bare `includes("disappeared_at")` would pass on a file whose
// select had lost it. We parse the select string, then its jobs( ... ) embed, then the
// comma-separated column list, and look for an exact column.
import { test } from "node:test";
// Strict, so a mismatch is never papered over by coercion.
import assert from "node:assert/strict";
// Read as text; works under node --test and Deno's node compat alike.
import { readFileSync } from "node:fs";

// Resolved from this file, so the test does not depend on the caller's cwd.
const source = readFileSync(new URL("../../tailor/index.ts", import.meta.url), "utf8");

test("tailor/index.ts selects disappeared_at inside the applications jobs( ) embed", () => {
  // The .from("applications") call, then its first .select("...") string literal.
  const select = /\.from\("applications"\)\s*(?:\/\/[^\n]*\n\s*)*\.select\("([^"]*)"\)/.exec(source);
  // A missing match is a failure in its own right: the guard must not pass vacuously.
  assert.ok(select, "could not find .from(\"applications\").select(\"...\") in tailor/index.ts");
  // The jobs embed's column list, inside the select string only.
  const embed = /\bjobs\s*\(([^)]*)\)/.exec(select[1]);
  assert.ok(embed, `select has no jobs( ) embed: ${select[1]}`);
  // Exact column names, so `disappeared_at_old` or a comment cannot satisfy it.
  const columns = embed[1].split(",").map((c) => c.trim());
  assert.ok(columns.includes("disappeared_at"), `jobs embed columns: ${columns.join(", ")}`);
});
