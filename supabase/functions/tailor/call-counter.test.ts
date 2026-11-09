// The tailor's Gemini call counter (2026-11-09). Red if the tailor goes back to writing nothing to
// agent_runs.gemini_calls, which left it at 0 on all 203 runs since 2026-11-01.

// node:test, the runner this suite uses.
import { test } from "node:test";
// Strict asserts, so a near-miss is never treated as equal.
import assert from "node:assert/strict";
// The tailor's source, to prove the counter is wired into the call AND into the run-close write.
import { readFileSync } from "node:fs";
// The unit under test.
import { countCalls } from "./call-counter.ts";

test("a run with 3 Gemini calls reports 3, including a call that failed", async () => {
  // A fake transport: the second call rejects, as a 429 or 503 does after the client gives up.
  let n = 0;
  // Wrapped exactly as tailor/index.ts wraps the real one.
  const gemini = countCalls(async (prompt: string) => {
    // Which call this is.
    n += 1;
    // The failing one.
    if (n === 2) throw new Error("gemini_call_failed: upstream_unavailable");
    // A normal answer.
    return `answer to ${prompt}`;
  });
  // Call 1 succeeds.
  assert.equal(await gemini.call("a"), "answer to a");
  // Call 2 rejects; the rejection passes through unchanged.
  await assert.rejects(gemini.call("b"), /upstream_unavailable/);
  // Call 3 succeeds.
  assert.equal(await gemini.call("c"), "answer to c");
  // All three counted: a failed call still spent quota, the matcher's definition.
  assert.equal(gemini.count(), 3);
});

test("a run that made no call reports 0, not undefined", () => {
  // Never called, e.g. an empty queue.
  const gemini = countCalls(async () => "unused");
  // A real 0, which the column accepts and the health page reads as "no calls".
  assert.equal(gemini.count(), 0);
});

test("tailor/index.ts routes callLlm through the counter and writes its total to gemini_calls", () => {
  // The handler's source, CRLF normalised for Windows working copies.
  const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  // The tailorer's transport is the counted one, not a bare closure.
  assert.match(source, /\n\s*callLlm: gemini\.call,\n/);
  // And the run-close update writes the count.
  assert.match(source, /\n\s*gemini_calls: gemini\.count\(\),\n/);
});
