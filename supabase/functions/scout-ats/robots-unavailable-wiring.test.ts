// scout-ats skips, and does not count, a board whose robots.txt did not answer (D5 drift #1, 2026-11-21).
//
// WHY: on 11-18 Workday's Cloudflare answered robots.txt with 429, and every refusal went through
// failureMark, so 62 of 64 Workday boards reached consecutive_failures >= 5 while their policy was
// never read. The worker scout stopped counting these in eb56d28e; this edge scout still did, and
// at 5 the worker's rest rule polls a board once a day, so each Scan press starved the worker too.
//
// WHY A SOURCE-SHAPE TEST: index.ts runs Deno.serve on import, so node --test cannot call its handler
// (the workday-wiring.test.ts pattern). The BEHAVIOUR (429/5xx -> RobotsUnavailableError, board never
// fetched) is unit-tested in _shared/http/transport.test.ts; what can only be checked here is that the
// handler's catch branches on that type BEFORE it writes failureMark, and does not count the board.

// The node:test runner, matching every other suite in supabase/functions.
import { describe, it } from "node:test";
// Strict, so a missing match fails loudly.
import assert from "node:assert/strict";
// The handler's source, read as text.
import { readFileSync } from "node:fs";

// index.ts beside this file.
const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");

// The board loop's catch: from its opening to the end of the failed summary it pushes.
const catchStart = source.indexOf("} catch (fetchErr: unknown) {");
// The catch must exist, or every assertion below would read an empty slice and pass vacuously.
assert.ok(catchStart >= 0, "index.ts no longer has the board loop's `catch (fetchErr: unknown)`");
// The failure count this test guards; its first occurrence after the catch opens.
const markAt = source.indexOf("failureMark(board, now)", catchStart);
// Present, or the slice below means nothing.
assert.ok(markAt > catchStart, "the catch no longer writes failureMark");
// Everything the catch does before it counts a failure.
const beforeMark = source.slice(catchStart, markAt);

describe("scout-ats: a robots 429/5xx leaves consecutive_failures unchanged", () => {
  it("imports the shared RobotsUnavailableError (one class for both scouts, D5)", () => {
    // From the shared module, not a local copy that could drift from the worker's semantics.
    assert.match(source, /import \{[^}]*RobotsUnavailableError[^}]*\} from "\.\.\/_shared\/http\/robots-unavailable\.ts"/);
  });

  it("a robots 429 leaves consecutive_failures unchanged: the catch skips the board before failureMark", () => {
    // The type check comes before the failure write.
    assert.match(beforeMark, /if \(fetchErr instanceof RobotsUnavailableError\) \{/);
    // That branch leaves the loop iteration, so the failureMark below is never reached for it.
    const branch = beforeMark.slice(beforeMark.indexOf("if (fetchErr instanceof RobotsUnavailableError) {"));
    // `continue` ends the iteration; no watchlist write sits between the check and it.
    assert.match(branch, /continue;/);
    // No company_watchlist update inside the skip branch (not the count, not last_polled_at).
    assert.doesNotMatch(branch.slice(0, branch.indexOf("continue;")), /company_watchlist/);
  });

  it("the skipped board is reported as \"skipped\", so it is not an attempted (failed) board", () => {
    // gate.ts counts attempted = status !== "skipped"; a deferred board must not make the run "failed".
    const branch = beforeMark.slice(beforeMark.indexOf("if (fetchErr instanceof RobotsUnavailableError) {"));
    // The summary it pushes.
    assert.match(branch.slice(0, branch.indexOf("continue;")), /status: "skipped"/);
  });
});
