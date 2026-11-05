// Tests for _shared/pregate-config-loader.ts, the ONE loader of the pre-gate's config that the
// matcher and the auditor both call (W1, 2026-11-05: the auditor held a copy of the matcher's
// two reads, and a column added to one copy would let the two stages judge a row differently).
//
// Two halves:
// (1) Behaviour, against a supabase-js-shaped fake. supabase-js RETURNS `{ data, error }` and
//     never throws on a failed read, so the fake returns errors too; a throwing fake would
//     certify a path that never runs (CLAUDE.md §5).
// (2) Wiring, by source shape: both functions import the shared loader and neither defines its
//     own. Comments are stripped first, so a comment that names the import cannot pass.
//
// RED-ON-REVERT, checked by hand when this was written: restoring
// `export async function loadPreGatePreferences` in auditor/pregate.ts turns
// "matcher and auditor both load config through the one shared loader" red.
import { describe, test } from "node:test";
// Strict deep equality, so a changed result shape fails here.
import assert from "node:assert/strict";
// Read the two callers' sources from disk for the wiring half.
import { readFileSync } from "node:fs";
// Resolve from this file, so the suite behaves the same from any cwd.
import { dirname, join } from "node:path";
// ESM has no __dirname; derive it from the module URL.
import { fileURLToPath } from "node:url";
// The loader under test.
import { loadPreGatePreferences } from "./pregate-config-loader.ts";

// One supabase-js terminal answer: data or error, never a throw.
type Answer = { data: unknown; error: { message: string } | null };

/** A fake client answering the two config reads by table, and recording what was asked. */
function fakeDb(answers: { prefs: Answer; ceiling: Answer }) {
  // Every call, in order, so a test can pin the tables, columns and filters.
  const calls: string[] = [];
  // The client.
  const db = {
    // supabase-js's entry point.
    from(table: string) {
      // Recorded so the column list and filter order are pinned.
      calls.push(`from:${table}`);
      // The answer for this table.
      const answer = table === "search_preferences" ? answers.prefs : answers.ceiling;
      // Chainable filters, then the terminal read; none of them throws.
      const chain = {
        // Records the column list.
        select: (columns: string) => (calls.push(`select:${columns}`), chain),
        // Records each equality filter.
        eq: (column: string, value: unknown) => (calls.push(`eq:${column}=${String(value)}`), chain),
        // Resolves the table's answer, as supabase-js resolves `{ data, error }`.
        maybeSingle: async () => answer,
      };
      // Returned for chaining.
      return chain;
    },
  };
  // Both, so a test can read the calls after the load.
  return { db, calls };
}

describe("loadPreGatePreferences", () => {
  test("maps Teja's live rows to the gate's preferences, reading the matcher's exact columns", async () => {
    // The live rows' shapes, column names as stored (SELECTed 2026-11-05).
    const { db, calls } = fakeDb({
      // search_preferences.
      prefs: { data: { titles: ["Software Engineer"], keywords: ["React"], excluded_keywords: ["Senior"], work_authorized_countries: ["India", "Nepal", "Bhutan"], remote_location_policy: "unlocked_or_authorized" }, error: null },
      // filter_rules experience_ceiling.
      ceiling: { data: { config: { max_years: 1 } }, error: null },
    });
    // Load.
    const result = await loadPreGatePreferences(db);
    // Loaded.
    assert.equal(result.kind, "ok");
    // The work-auth inputs and the ceiling arrive.
    assert.deepEqual(result.kind === "ok" && [result.preferences.workAuthorizedCountries, result.preferences.remoteLocationPolicy, result.preferences.experienceMaxYears], [["India", "Nepal", "Bhutan"], "unlocked_or_authorized", 1]);
    // The reads, in order: the five gate columns, then only the ENABLED experience_ceiling rule.
    assert.deepEqual(calls, [
      // Preferences table.
      "from:search_preferences",
      // The five columns the three gates read.
      "select:titles, keywords, excluded_keywords, work_authorized_countries, remote_location_policy",
      // Rules table.
      "from:filter_rules",
      // Only the config.
      "select:config",
      // The one rule.
      "eq:rule_type=experience_ceiling",
      // A disabled rule does not run.
      "eq:enabled=true",
    ]);
  });

  test("missing rows (no preferences, no ceiling rule) are an open config, not an error", async () => {
    // maybeSingle() over zero rows: data null, error null.
    const { db } = fakeDb({ prefs: { data: null, error: null }, ceiling: { data: null, error: null } });
    // Load.
    const result = await loadPreGatePreferences(db);
    // Loaded, with every gate stated open: null work-auth list, 'any' policy, null ceiling.
    assert.deepEqual(result.kind === "ok" && [result.preferences.workAuthorizedCountries, result.preferences.remoteLocationPolicy, result.preferences.experienceMaxYears], [null, "any", null]);
  });

  test("a failed preferences read is an error, never an empty (pass-everything) config", async () => {
    // The read fails, as supabase-js reports it.
    const { db, calls } = fakeDb({ prefs: { data: null, error: { message: "boom" } }, ceiling: { data: null, error: null } });
    // Load.
    const result = await loadPreGatePreferences(db);
    // Named, so the run can 503 with it.
    assert.deepEqual(result, { kind: "error", code: "preferences_unreadable", message: "boom" });
    // Stopped at the first failure: the ceiling was never read.
    assert.equal(calls.includes("from:filter_rules"), false);
  });

  test("a failed ceiling read is an error too", async () => {
    // Preferences fine, ceiling fails.
    const { db } = fakeDb({ prefs: { data: null, error: null }, ceiling: { data: null, error: { message: "nope" } } });
    // Named.
    assert.deepEqual(await loadPreGatePreferences(db), { kind: "error", code: "filter_rules_unreadable", message: "nope" });
  });
});

// This file's directory, for cwd-independent paths to the callers.
const HERE = dirname(fileURLToPath(import.meta.url));

/** A caller's source with block and line comments removed, so only code can match. */
function codeOf(relative: string): string {
  // Read from supabase/functions/<relative>.
  const text = readFileSync(join(HERE, "..", relative), "utf8");
  // Strip /* */ first, then // to end of line; these files hold no `//` inside a string the
  // assertions below read (URLs live in other files).
  return text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

// The import every caller must carry, as a pattern over comment-free code.
const SHARED_IMPORT = /import\s*\{[^}]*\bloadPreGatePreferences\b[^}]*\}\s*from\s*"\.\.\/_shared\/pregate-config-loader\.ts"/;
// A local definition of the loader, the shape of the duplicate this file replaced.
const OWN_COPY = /\bfunction\s+loadPreGatePreferences\b/;

test("matcher and auditor both load config through the one shared loader", () => {
  // The two callers, and the auditor's helper file that held the copy.
  const matcher = codeOf("matcher/index.ts");
  // The auditor's handler.
  const auditor = codeOf("auditor/index.ts");
  // Where the auditor's copy lived.
  const auditorPregate = codeOf("auditor/pregate.ts");
  // Anchors: the files are the real handlers, so an empty or moved file cannot pass vacuously.
  assert.match(matcher, /Deno\.serve\(/, "matcher/index.ts anchor");
  // Same for the auditor.
  assert.match(auditor, /Deno\.serve\(/, "auditor/index.ts anchor");
  // The helper still exports the verdict the auditor uses.
  assert.match(auditorPregate, /export function auditorPreGateDrop\b/, "auditor/pregate.ts anchor");
  // Both handlers import the shared loader.
  assert.match(matcher, SHARED_IMPORT, "matcher imports the shared loader");
  // And the auditor.
  assert.match(auditor, SHARED_IMPORT, "auditor imports the shared loader");
  // Both handlers call it.
  assert.match(matcher, /await loadPreGatePreferences\(/, "matcher calls it");
  // And the auditor.
  assert.match(auditor, /await loadPreGatePreferences\(/, "auditor calls it");
  // No file keeps its own copy.
  for (const [name, code] of [["matcher/index.ts", matcher], ["auditor/index.ts", auditor], ["auditor/pregate.ts", auditorPregate]] as const) {
    // A local definition is the duplicate coming back.
    assert.doesNotMatch(code, OWN_COPY, `${name} defines its own loadPreGatePreferences`);
  }
  // The matcher no longer reads search_preferences itself (its inline copy had no function name).
  assert.doesNotMatch(matcher, /\.from\("search_preferences"\)/, "matcher reads search_preferences inline");
});
