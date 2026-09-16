// DUAL-RUNTIME GUARD. Converts a deploy-time failure into a test-time failure.
//
// THIS FILE IS INTENDED TO BE COPIED, not imported. A sibling copy belongs in any
// other directory under `supabase/functions/_shared/**` that ships code into both
// runtimes. It is deliberately self-contained — it imports nothing from this package
// and hardcodes no path outside its own directory — so copying it is a one-file
// operation with no follow-up edits.
//
// WHY COPY RATHER THAN SHARE: a shared helper would be a third file with two writers,
// living in the very tree both write partitions already point at, to save about
// fifteen lines. In a tree several sessions edit concurrently, duplicating something
// small is cheaper than coupling to it — the duplication is visible and harmless,
// while the coupling is invisible until two sessions stage the same file. If the two
// copies ever drift, they drift toward whichever is stricter, which is the safe
// direction for a guard.
//
// WHAT IT DEFENDS. Everything under `_shared/**` is imported by BOTH the Deno Edge
// Functions and the Node worker (`worker/src/cli/scout.ts` reaches across into this
// tree). A single `node:` import therefore does not fail at the author's desk, where
// `node --test` runs the tests perfectly happily — it fails in a DEPLOYED EDGE
// FUNCTION, which is the worst possible place to discover it. The constraint is
// otherwise enforced only by everyone remembering it.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
// Reading our own sources is the whole mechanism; these three are the only Node APIs
// this file needs, and they are legitimate here — see the scoping rule below.
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// This file's own directory, resolved from import.meta.url so the guard works no
// matter where the runner is invoked from — a relative path would silently scan the
// wrong directory (or nothing) depending on the caller's cwd.
const HERE = dirname(fileURLToPath(import.meta.url));

// SCOPED TO SOURCE FILES ONLY. Test files legitimately import `node:test` and
// `node:assert/strict` — that is this repo's mandated convention, and
// `supabase/functions/deno.json` excludes `**/*.test.ts` from `deno check` precisely
// because of it. An unscoped guard would fail on its own suite and, far worse, would
// look like a genuine dual-runtime violation rather than a bug in the guard.
function sourceFiles(): string[] {
  return readdirSync(HERE)
    .filter((name) => name.endsWith(".ts"))
    .filter((name) => !name.endsWith(".test.ts"));
}

// Strip comments before scanning.
//
// THIS IS NOT COSMETIC — without it the guard is useless here. transport.ts carries a
// comment reading "an import from `node:timers`" explaining why NOT to write one, and
// a naive substring scan would flag that comment as the very violation it warns
// against. A guard that cannot survive its own documentation gets deleted by the first
// person it inconveniences, which is worse than not having it.
//
// Block comments first, then line comments. This also truncates any string containing
// `//` (the User-Agent URL, for instance), which is harmless: removing text can hide a
// violation but can never invent one, and an import statement cannot occur inside a
// string literal.
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

describe("the shipped module stays runnable in both Deno and Node", () => {
  test("the guard actually sees files — non-vacuity", () => {
    // Without this, a glob or filter bug makes every assertion below pass over an
    // empty list, and the guard reports green while checking nothing. This is the
    // failure mode that makes a bad guard worse than no guard: it manufactures
    // confidence.
    const files = sourceFiles();
    assert.ok(files.length > 0, "found no source files to scan — the filter is broken");
    // The core module must be among them, so a rename cannot quietly empty the scan.
    assert.ok(files.includes("transport.ts"), `transport.ts missing from scan: ${files.join(", ")}`);
  });

  test("no source file imports a node: specifier", () => {
    for (const name of sourceFiles()) {
      const code = stripComments(readFileSync(join(HERE, name), "utf8"));
      // Matches both the static form and a dynamic import(). Node builtins are the
      // most common way this constraint gets broken, usually by reaching for
      // `node:crypto` or `node:timers` out of habit.
      assert.ok(
        !/["']node:[a-z/]+["']/.test(code),
        `${name} imports a node: builtin, which cannot resolve in a Deno Edge Function`,
      );
    }
  });

  test("no source file touches a Deno global", () => {
    for (const name of sourceFiles()) {
      const code = stripComments(readFileSync(join(HERE, name), "utf8"));
      // The mirror-image failure: `Deno.env` runs fine in the Edge Function and throws
      // a ReferenceError in the worker. `db/client.ts` elsewhere in this tree does use
      // `Deno.env` legitimately — it is Deno-only by design — which is exactly why
      // this guard is scoped to its own directory rather than run repo-wide.
      assert.ok(
        !/\bDeno\s*\./.test(code),
        `${name} uses a Deno global, which is a ReferenceError in the Node worker`,
      );
    }
  });

  test("no source file touches process.*", () => {
    for (const name of sourceFiles()) {
      const code = stripComments(readFileSync(join(HERE, name), "utf8"));
      // Upstream's `writeError` helper used `process.stderr.write`; it was deliberately
      // not ported. Diagnostics leave this module as typed errors so the Edge Function
      // and the worker can log them each in their own way.
      assert.ok(
        !/\bprocess\s*\.\s*(env|stderr|stdout|argv|exit)\b/.test(code),
        `${name} uses process.*, which does not exist in a Deno Edge Function`,
      );
    }
  });

  test("every relative import carries an explicit .ts extension", () => {
    for (const name of sourceFiles()) {
      const code = stripComments(readFileSync(join(HERE, name), "utf8"));
      // Deno requires the extension and Node's type stripper requires it; extensionless
      // relative specifiers are the one spelling neither accepts. Catching it here is
      // cheaper than catching it as a module-resolution error at deploy.
      const specifiers = code.match(/from\s+["']\.[^"']*["']/g) ?? [];
      for (const specifier of specifiers) {
        assert.ok(
          specifier.endsWith('.ts"') || specifier.endsWith(".ts'"),
          `${name} has a relative import without a .ts extension: ${specifier}`,
        );
      }
    }
  });
});
