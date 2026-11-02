// job-link-intake import graph (audit W26, 2026-11-02): this function must load nothing from apps/web.
// WHY: the web auto-deploys on every push while this function is deployed by hand, so a web file in
// its graph can change under it with no redeploy (silent drift). Shared code lives in
// supabase/functions/_shared/ or packages/, where a change reads as "redeploy the functions".
// The test asserts the POSITIVE shape (every file is inside supabase/ or packages/, and the walk
// reached the shared pipeline engine), not merely the absence of "apps/web" (repo CLAUDE.md §6).
// Run with: node --test "supabase/functions/job-link-intake/*.test.ts"
import { test } from "node:test";
// Strict asserts, so a near-miss path is a failure rather than a coerced pass.
import assert from "node:assert/strict";
// Sync reads keep the walk a plain loop; the graph is a few dozen small files.
import { existsSync, readdirSync, readFileSync } from "node:fs";
// Paths are resolved and compared by the OS-aware helpers, never by string surgery.
import { dirname, relative, resolve, sep } from "node:path";
// This file's own directory, from its module URL (no __dirname in ESM).
import { fileURLToPath } from "node:url";

// The function's own directory: every non-test source here is an entry point of the deployed bundle.
const FUNCTION_DIR = dirname(fileURLToPath(import.meta.url));
// The repo root, three levels up (supabase/functions/job-link-intake), so paths can be named from it.
const REPO_ROOT = resolve(FUNCTION_DIR, "..", "..", "..");
// The engine the server-run pipeline shares with the browser; the walk must reach it here.
const SHARED_PIPELINE = "supabase/functions/_shared/pipeline/row-pipeline.ts";

// Static `import ... from` / `export ... from`, across lines (the repo ends statements with `;`).
const FROM_IMPORT = /^\s*(?:import|export)\b[^;]*?\bfrom\s*["']([^"']+)["']/gm;
// Side-effect `import "x";`.
const BARE_IMPORT = /^\s*import\s*["']([^"']+)["']/gm;
// Dynamic `import("x")`, which a bundler also follows.
const DYNAMIC_IMPORT = /\bimport\(\s*["']([^"']+)["']\s*\)/g;

// Every specifier one source file names, in any of the three forms.
function specifiersOf(source: string): string[] {
  // All three patterns, flattened; capture group 1 is the specifier in each.
  return [FROM_IMPORT, BARE_IMPORT, DYNAMIC_IMPORT].flatMap((pattern) => [...source.matchAll(pattern)].map((m) => m[1] as string));
}

// The repo-relative, forward-slash path of every LOCAL file reachable from the entry points.
// Remote specifiers (npm:, jsr:, https:) are not files in this repo and are left to deno check.
function localImportGraph(entries: string[]): string[] {
  // Absolute paths already visited, so a cycle cannot loop forever.
  const seen = new Set<string>();
  // Files still to read.
  const queue = [...entries];
  // Breadth-first over the queue.
  while (queue.length > 0) {
    // The next file.
    const file = queue.shift() as string;
    // Each file is read once.
    if (seen.has(file)) continue;
    // A specifier that points at nothing is a broken import, never a silent skip.
    assert.ok(existsSync(file), `import target does not exist: ${relative(REPO_ROOT, file)}`);
    // Marked before its children are queued.
    seen.add(file);
    // Only relative specifiers are files in this repo.
    for (const spec of specifiersOf(readFileSync(file, "utf8"))) {
      // ./x and ../x resolve against the importing file's directory.
      if (spec.startsWith("./") || spec.startsWith("../")) queue.push(resolve(dirname(file), spec));
    }
  }
  // Named from the repo root with forward slashes, so assertions read the same on Windows.
  return [...seen].map((file) => relative(REPO_ROOT, file).split(sep).join("/"));
}

// The entry points: every source file the function ships (tests are not deployed).
const ENTRIES = readdirSync(FUNCTION_DIR)
  // .ts sources only, test files excluded.
  .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
  // Absolute, for the walk.
  .map((name) => resolve(FUNCTION_DIR, name));

test("W26: job-link-intake's import graph resolves only inside supabase/ and packages/", () => {
  // The whole local graph of the deployed function.
  const graph = localImportGraph(ENTRIES);
  // Non-vacuous: index.ts and handler.ts were found as entries (an empty readdir would pass anything).
  assert.ok(graph.includes("supabase/functions/job-link-intake/index.ts") && graph.includes("supabase/functions/job-link-intake/handler.ts"), "entry points not found");
  // Non-vacuous: the walk followed the pipeline import to its shared home (a graph that never left
  // the function's own directory would also be "inside supabase/").
  assert.ok(graph.includes(SHARED_PIPELINE), `the graph does not reach ${SHARED_PIPELINE}`);
  // The positive shape: every reachable file lives under one of the two shared roots.
  const outside = graph.filter((file) => !file.startsWith("supabase/") && !file.startsWith("packages/"));
  // Named, so a red run says which file leaked in.
  assert.deepEqual(outside, [], `job-link-intake loads files outside supabase/ and packages/: ${outside.join(", ")}`);
});
