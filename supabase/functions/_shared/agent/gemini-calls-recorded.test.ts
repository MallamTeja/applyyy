// Every agent that spends Gemini calls must SAY so in agent_runs.gemini_calls (2026-11-09).
//
// WHY: the column defaults to 0, so an agent that calls Gemini but never writes it reports "0 calls"
// on every run. That fail-open (CLAUDE.md §6) hid the tailor's quota spend on all 203 runs since
// 2026-11-01, and scout-web had the same gap. Each was a per-agent omission in its own run-close
// write; the shared loop (loop.ts) has no production users. So the guard is a sweep over every
// function directory: if its code reaches generateGeminiContent and it writes agent_runs, it must
// also write gemini_calls. A new agent that forgets fails here before it ships.
// Source-level on purpose: every index.ts calls Deno.serve on import, so none can be run here.

// node:test, the runner this suite uses.
import { test } from "node:test";
// Strict asserts, so a near-miss is never treated as equal.
import assert from "node:assert/strict";
// The function sources are read from disk.
import { readdirSync, readFileSync, statSync } from "node:fs";
// Paths are joined, never concatenated, so Windows separators work.
import { join } from "node:path";
// This file's own location, so the walk does not depend on the runner's cwd.
import { fileURLToPath } from "node:url";

// supabase/functions, two levels above this file (_shared/agent/).
const FUNCTIONS_DIR = fileURLToPath(new URL("../../", import.meta.url));

/** `text` with block and line comments removed, so a comment that NAMES gemini_calls can never pass as code that writes it. */
function code(text: string): string {
  // Block comments first, then line comments; `[^:]` keeps the `//` inside "https://" from being read as a comment.
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/** Every non-test .ts file under `dir`, recursively, as [path, text]. */
function sources(dir: string): Array<[string, string]> {
  // Depth-first over the directory.
  return readdirSync(dir).flatMap((name) => {
    // The entry's full path.
    const path = join(dir, name);
    // Directories recurse; files are filtered below.
    if (statSync(path).isDirectory()) return sources(path);
    // Only production TypeScript: tests may mention anything.
    return path.endsWith(".ts") && !path.endsWith(".test.ts") ? [[path, readFileSync(path, "utf8")] as [string, string]] : [];
  });
}

// _shared files that call Gemini themselves (e.g. follow-up/nudge.ts), excluding the client that defines it.
const SHARED_GEMINI_CALLERS = sources(join(FUNCTIONS_DIR, "_shared"))
  // A real call site, not the definition or a type import.
  .filter(([path, text]) => code(text).includes("generateGeminiContent(") && !path.replace(/\\/g, "/").endsWith("_shared/gemini/client.ts"))
  // Kept as a path suffix like "follow-up/nudge", which is how importers name it.
  .map(([path]) => path.replace(/\\/g, "/").split("/_shared/")[1]!.replace(/\.ts$/, ""));

// The per-request Gemini meter (2026-11-09). A function that imports it writes its run row and
// gemini_calls THROUGH it, the way follow-up calls Gemini through _shared, so the importer inherits both.
const METER_PATH = "job-link-intake/gemini-meter";
// The meter's own code: the inheritance below is only sound while the meter really writes both.
const METER_CODE = code(readFileSync(join(FUNCTIONS_DIR, `${METER_PATH}.ts`), "utf8"));

/** Each function directory (not _shared) with whether it calls Gemini, writes agent_runs, writes gemini_calls. */
function functionDirs(): Array<{ name: string; gemini: boolean; runs: boolean; recorded: boolean }> {
  // Every top-level directory except the shared library.
  return readdirSync(FUNCTIONS_DIR)
    // Directories only; _shared is a library, not a deployed function.
    .filter((name) => name !== "_shared" && statSync(join(FUNCTIONS_DIR, name)).isDirectory())
    // One summary per function.
    .map((name) => {
      // All of the function's own production CODE (comments stripped), joined for the checks below.
      const text = sources(join(FUNCTIONS_DIR, name)).map(([, t]) => code(t)).join("\n");
      // Calls Gemini directly, or imports a _shared module that does.
      const gemini = text.includes("generateGeminiContent(") || SHARED_GEMINI_CALLERS.some((suffix) => text.includes(`_shared/${suffix}`));
      // Imports the meter, so it writes both through it.
      const metered = text.includes(METER_PATH);
      // Opens or closes an agent_runs row.
      const runs = metered || text.includes('"agent_runs"') || text.includes("'agent_runs'");
      // Writes the call count: `gemini_calls:` as an object key in code, the shape of an agent_runs write.
      const recorded = metered || /\bgemini_calls\s*:/.test(text);
      // The summary.
      return { name, gemini, runs, recorded };
    });
}

test("every function that calls Gemini and writes agent_runs also writes gemini_calls", () => {
  // Every function directory the walk found.
  const all = functionDirs();
  // Non-vacuity, part 1: the walk itself worked (there are 20+ functions; a broken path finds 0).
  assert.ok(all.length >= 10, `the walk found only ${all.length} function directories`);
  // The functions the rule applies to.
  const subject = all.filter((dir) => dir.gemini && dir.runs);
  // Non-vacuity, part 2: the MINIMUM set, i.e. every function known on 2026-11-09 to call Gemini and record runs.
  // A regex or detection miss drops one of these from scope and fails here, never passing over nothing.
  for (const known of ["matcher", "tailor", "scout-web", "referral", "cover-letter", "interview-prep", "follow-up"]) {
    // Each one is in scope, or the walk or the detection broke.
    assert.ok(subject.some((dir) => dir.name === known), `${known} was not detected as a Gemini-calling, run-recording function`);
  }
  // The rule: none may leave gemini_calls to the column default.
  assert.deepEqual(subject.filter((dir) => !dir.recorded).map((dir) => dir.name), []);
});

// Functions allowed to call Gemini with no agent_runs row, each with the reason it is exempt.
// Empty on purpose (2026-11-09): every Gemini caller is measured. An entry needs a reason a reviewer can argue with.
const UNMEASURED_ALLOWED: Readonly<Record<string, string>> = {};

test("every function that calls Gemini writes an agent_runs row at all", () => {
  // The hole the first test leaves: it only judges functions that already write agent_runs, so a
  // Gemini caller with NO run row (job-link-intake, resume-assist until 2026-11-09) was invisible to it.
  const all = functionDirs();
  // Non-vacuity: the two that were unmeasured must still be detected as Gemini callers; a detection
  // miss would otherwise pass this test over nothing.
  for (const known of ["job-link-intake", "resume-assist"]) {
    // Each is seen calling Gemini.
    assert.ok(all.some((dir) => dir.name === known && dir.gemini), `${known} was not detected as a Gemini-calling function`);
  }
  // The rule: a Gemini caller with no run row, unless allowlisted with a reason.
  assert.deepEqual(all.filter((dir) => dir.gemini && !dir.runs && !(dir.name in UNMEASURED_ALLOWED)).map((dir) => dir.name), []);
});

test("the Gemini meter writes agent_runs AND gemini_calls, so its importers may inherit both", () => {
  // Without this, a meter that stopped writing gemini_calls would still pass every importer above.
  assert.ok(METER_CODE.includes('"agent_runs"') && /\bgemini_calls\s*:/.test(METER_CODE), `${METER_PATH}.ts no longer writes agent_runs.gemini_calls`);
});

test("the shared-helper detection finds Gemini calls made outside a function's own directory", () => {
  // follow-up spends Gemini only through _shared/follow-up/nudge.ts; missing it would exempt follow-up.
  assert.ok(SHARED_GEMINI_CALLERS.includes("follow-up/nudge"), `shared Gemini callers: ${SHARED_GEMINI_CALLERS.join(", ")}`);
  // And follow-up is therefore in scope.
  assert.ok(functionDirs().some((dir) => dir.name === "follow-up" && dir.gemini && dir.runs));
});
