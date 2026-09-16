// A static guard: nothing in this module may bind itself to one runtime.
//
// WHY THIS EXISTS AND WHY IT IS CHEAP. `_shared/**` is imported by BOTH the Deno Edge
// Functions and the Node worker — `worker/src/cli/scout.ts` reaches directly across into
// `supabase/functions/_shared/`. So a `node:` import here does not fail at the desk of
// whoever wrote it, and it does not fail in `node --test` either. It fails later, inside a
// deployed Edge Function, which is the worst place to discover it: the symptom is a
// runtime import error in production for code that passed every local check.
//
// Reading the source text is a blunt instrument, and that is the point — it costs fifteen
// lines and converts a deploy-time failure into a test-time one. A type system cannot
// catch this because both runtimes typecheck the import fine in isolation.
//
// SCOPED TO SOURCE FILES ONLY, WHICH IS LOAD-BEARING. Every sibling `.test.ts` in this
// repo legitimately imports `node:test` and `node:assert/strict`, because the suite is run
// by `node --test` and `deno.json` deliberately excludes `**/*.test.ts` from `deno check`.
// An unscoped guard would fail on its own test suite and look like a real violation.
import { test } from "node:test";
// Strict, so an empty match list never quietly compares equal to a passing check.
import assert from "node:assert/strict";
// Read this module's own files. Legal here precisely because this is a test file.
import { readdirSync, readFileSync } from "node:fs";
// Resolve relative to this file rather than the working directory, so the guard holds
// wherever the suite is invoked from — the same reason `eval/gate.test.ts` does it.
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// This module's directory.
const MODULE_DIR = dirname(fileURLToPath(import.meta.url));

// Every source file in this module: `.ts`, excluding the tests that are allowed to be
// Node-bound. Computed rather than listed so a new file is covered the moment it exists,
// which is the difference between a guard and a checklist.
function sourceFiles(): readonly string[] {
  return readdirSync(MODULE_DIR)
    .filter((name) => name.endsWith(".ts"))
    .filter((name) => !name.endsWith(".test.ts"));
}

// NODE BUILT-INS ARE UNAVAILABLE IN A SUPABASE EDGE FUNCTION. An import of `node:fs` or
// `node:crypto` here would throw on cold start in production.
test("no source file in this module imports a node: builtin", () => {
  for (const name of sourceFiles()) {
    const contents = readFileSync(join(MODULE_DIR, name), "utf8");
    // Matches both a static import and a dynamic one.
    assert.equal(
      /["']node:/.test(contents),
      false,
      `${name} imports a node: builtin; _shared/** must run under both Deno and Node`,
    );
  }
});

// AND THE MIRROR FAILURE, which is the one more likely to be written here: `Deno.env`,
// `Deno.readTextFile` and friends are undefined under the Node worker. This module is
// pure arithmetic and comparison, so it needs neither runtime's globals at all.
test("no source file in this module touches the Deno global", () => {
  for (const name of sourceFiles()) {
    const contents = readFileSync(join(MODULE_DIR, name), "utf8");
    // Word-boundary anchored so a word merely containing "Deno" does not trip it.
    assert.equal(
      /\bDeno\./.test(contents),
      false,
      `${name} uses the Deno global; _shared/** must run under both Deno and Node`,
    );
  }
});

// A guard that silently checks nothing is worse than no guard, because it reports green.
// If a refactor moves these files, this fails rather than quietly passing over an empty
// list — the same reason `eval/gate.ts` carries an explicit `placeholder` flag.
test("the guard is actually looking at files", () => {
  assert.ok(sourceFiles().length > 0, "found no source files to check; the guard is vacuous");
});
