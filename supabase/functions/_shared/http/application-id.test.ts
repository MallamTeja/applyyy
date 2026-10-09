// Tests for the shared `?application_id=` parser, plus an ordering guard on all five handlers
// that use it: the refusal must happen BEFORE the agent_runs row is opened.
import { test } from "node:test";
// Strict, so a missing `id` is not loosely equal to anything.
import assert from "node:assert/strict";
// The handlers call Deno.serve and import jsr: modules, so node cannot import them; reading
// them as text is the only way this suite can see their statement order.
import { readFileSync } from "node:fs";
// Resolved from this file, so the suite reads the right handlers whatever the runner's cwd.
import { fileURLToPath } from "node:url";
// Unit under test.
import { parseApplicationIdParam, parseUuidParam } from "./application-id.ts";

// A real-shaped UUID, reused so the valid cases differ only in case.
const UUID = "3f2b8c1e-9a4d-4e6f-8b7a-0c1d2e3f4a5b";

// Builds the params a handler would see for a given query string.
const parse = (query: string) => parseApplicationIdParam(new URLSearchParams(query));

test("absent: no application_id key means no target", () => {
  // Missing key is the only path to "whole queue".
  assert.deepEqual(parse("limit=5"), { kind: "absent" });
});

test("valid: lowercase and uppercase UUIDs are accepted unchanged", () => {
  // The id is passed through as given, never normalised, so the DB filter sees what the caller sent.
  assert.deepEqual(parse(`application_id=${UUID}`), { kind: "valid", id: UUID });
  // Case-insensitive, matching the regex every handler used before the extraction.
  assert.deepEqual(parse(`application_id=${UUID.toUpperCase()}`), { kind: "valid", id: UUID.toUpperCase() });
});

test("invalid: garbage, empty, padded and extended ids are refused, never absent", () => {
  // Plain garbage.
  assert.deepEqual(parse("application_id=not-a-uuid"), { kind: "invalid" });
  // Empty value is present-but-malformed; treating it as absent would run the whole queue.
  assert.deepEqual(parse("application_id="), { kind: "invalid" });
  // Surrounding whitespace (`+` decodes to a space) must not be trimmed into a match.
  assert.deepEqual(parse(`application_id=+${UUID}+`), { kind: "invalid" });
  // Trailing junk proves the pattern is anchored at the end.
  assert.deepEqual(parse(`application_id=${UUID}x`), { kind: "invalid" });
  // Leading junk proves it is anchored at the start.
  assert.deepEqual(parse(`application_id=x${UUID}`), { kind: "invalid" });
  // Missing hyphens: right length of hex, wrong shape.
  assert.deepEqual(parse(`application_id=${UUID.replaceAll("-", "")}`), { kind: "invalid" });
});

// Asserts the positive shape: the parser IS called, and its call comes before the first
// agent_runs access. Both indexes must be found, so a renamed call cannot pass vacuously.
function assertValidatedBeforeRunOpened(handler: string): void {
  // The handler's source, located relative to this test file.
  const source = readFileSync(fileURLToPath(new URL(`../../${handler}/index.ts`, import.meta.url)), "utf8");
  // Where the handler calls the shared parser (the import line has no `(` after the name).
  const parseAt = source.indexOf("parseApplicationIdParam(");
  // Where the handler first touches agent_runs, i.e. opens its run row.
  const runAt = source.indexOf('.from("agent_runs")');
  // The call exists at all — otherwise the ordering check below would be meaningless.
  assert.ok(parseAt > 0, `${handler}: parseApplicationIdParam( call not found`);
  // The run row is opened somewhere — otherwise "before" proves nothing.
  assert.ok(runAt > 0, `${handler}: .from("agent_runs") not found`);
  // The ordering this whole change is about.
  assert.ok(parseAt < runAt, `${handler}: application_id validated at ${parseAt}, after agent_runs opened at ${runAt}`);
}

test("normalizer: application_id is validated before the agent_runs row is opened", () => {
  // The handler that already had the right order; guards it against regressing.
  assertValidatedBeforeRunOpened("normalizer");
});

test("screener: application_id is validated before the agent_runs row is opened", () => {
  // The handler this change moved; reverting the move must turn this red.
  assertValidatedBeforeRunOpened("screener");
});

test("matcher: application_id is validated before the agent_runs row is opened", () => {
  // Moved above the insert (it used to refuse via failRun); reverting the move must turn this red.
  assertValidatedBeforeRunOpened("matcher");
});

test("tailor: application_id is validated before the agent_runs row is opened", () => {
  // Moved above the insert (it used to refuse via failRun); reverting the move must turn this red.
  assertValidatedBeforeRunOpened("tailor");
});

test("auditor: application_id is validated before the agent_runs row is opened", () => {
  // Moved above the insert (it used to refuse via failRun); reverting the move must turn this red.
  assertValidatedBeforeRunOpened("auditor");
});

test("parseUuidParam applies the same rule to any parameter name (the sweep's after_id)", () => {
  // A second uuid parameter must not grow a second regex: same three answers, by name.
  const uuid = "2c7ae03e-1201-4379-be10-9446674821de";
  // Valid under the name asked for.
  assert.deepEqual(parseUuidParam(new URLSearchParams(`after_id=${uuid}`), "after_id"), { kind: "valid", id: uuid });
  // Absent only when THAT key is missing, even if another uuid param is present.
  assert.deepEqual(parseUuidParam(new URLSearchParams(`application_id=${uuid}`), "after_id"), { kind: "absent" });
  // Present but empty is invalid, never "start from the beginning".
  assert.deepEqual(parseUuidParam(new URLSearchParams("after_id="), "after_id"), { kind: "invalid" });
  // Junk is invalid.
  assert.deepEqual(parseUuidParam(new URLSearchParams("after_id=last"), "after_id"), { kind: "invalid" });
});
