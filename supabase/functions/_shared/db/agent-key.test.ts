// Tests for the agent-key header: the proof a machine agent sends so the database lets it
// claim a machine identity (migration 20261008160000). Two halves:
//   1. the pure builder, agentKeyHeaders;
//   2. the WIRING: every client that advances status as a machine agent must use it.
// The wiring half reads source, because client.ts imports `jsr:` (unresolvable under
// node --test, see gates.ts:4) and the worker CLIs build clients inline with no seam. It
// asserts the code SHAPE of the options line, never a bare word (CLAUDE.md §3).
// Run from the repo root: node --test "supabase/functions/_shared/db/*.test.ts"
// node:test, as every test in this tree (deno.json excludes *.test.ts).
import { test } from "node:test";
// Strict asserts.
import assert from "node:assert/strict";
// Reads the client sources for the wiring checks.
import { readFileSync } from "node:fs";
// The builder under test, written after these tests (red first).
import { AGENT_KEY_ENV_VAR, AGENT_KEY_HEADER, agentKeyHeaders } from "./agent-key.ts";

// Resolves a repo path from this file, so the test works from any cwd.
const source = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");

test("a set key becomes exactly one lowercase x-applyy-agent-key header", () => {
  // Lowercase, because PostgREST lowercases names in request.headers and the SQL reads that.
  assert.deepEqual(agentKeyHeaders("s3cret"), { "x-applyy-agent-key": "s3cret" });
  // The exported name is the one the migration reads; a rename must break this test.
  assert.equal(AGENT_KEY_HEADER, "x-applyy-agent-key");
  // And the env var both runtimes and the runbook use.
  assert.equal(AGENT_KEY_ENV_VAR, "APPLYY_AGENT_KEY");
});

test("an unset or blank key sends NO header rather than an empty one", () => {
  // Unset: before Teja sets the secret, clients must behave exactly as today.
  assert.deepEqual(agentKeyHeaders(undefined), {});
  // Null, for callers that normalise absence that way.
  assert.deepEqual(agentKeyHeaders(null), {});
  // Whitespace is the realistic copy-paste mistake; it is absence, not a key.
  assert.deepEqual(agentKeyHeaders("   "), {});
});

test("surrounding whitespace is trimmed, so a pasted secret still hashes to the seeded value", () => {
  // A trailing newline from `echo` or a dashboard paste would otherwise change the hash.
  assert.deepEqual(agentKeyHeaders("  s3cret\n"), { "x-applyy-agent-key": "s3cret" });
});

test("the edge client (createAppUserClient) attaches the agent key header", () => {
  // Every edge function that advances status builds its client here (recon 2026-10-08).
  const src = source("./client.ts");
  // The options object must carry the builder's output as global headers.
  assert.match(src, /global:\s*\{\s*headers:\s*agentKeyHeaders\(readEnv\(AGENT_KEY_ENV_VAR\)\)\s*\}/);
});

test("the worker applier and assist CLIs attach the agent key header", () => {
  // The only two worker clients that call advance_application_status as a machine agent.
  for (const rel of ["../../../../worker/src/cli/apply.ts", "../../../../worker/src/cli/assist.ts"]) {
    // Each builds its own client inline, so each is checked.
    const src = source(rel);
    // Same shape: the builder fed from process.env, inside global headers.
    assert.match(src, /global:\s*\{\s*headers:\s*agentKeyHeaders\(process\.env\[AGENT_KEY_ENV_VAR\]\)\s*\}/, rel);
  }
});
