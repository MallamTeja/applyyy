// THE TRANSITION GUARD IN TYPESCRIPT — `canTransition` before every status write.
//
// The database already refuses an illegal edge, so it is worth being precise about what
// this layer buys, because "the database checks it anyway" is the argument that deletes
// it: a trigger refusal arrives as an opaque `P0001` from inside a plpgsql function,
// AFTER the row was claimed and AFTER whatever Gemini call produced the value being
// written. Failing fast in TypeScript turns that into a named outcome the agent can
// count, log and release the claim for — and it costs one map lookup.
//
// The case that makes it more than a nicety is the AGENT check. `audit_flagged →
// tailored` is a real edge, so an agent asking "is this move legal?" without naming
// itself gets `true` — and the write then fails in Postgres because the edge is
// `['human']`-only. That is a genuinely easy mistake to make and impossible to see in
// review, which is why `guardedAdvance` requires the actor.
import { test } from "node:test";
// Strict, so a missing property never compares equal to a real one.
import assert from "node:assert/strict";
// Extension-suffixed specifier so this runs under Deno and `node --test` alike.
import { guardedAdvance } from "./status.ts";
// The shared recording double — the ABSENCE of an `advanceStatus` call is the assertion.
import { makeFakePort } from "./test-port.ts";

// NON-VACUITY TWIN, first: a guard that refuses every transition would pass every
// rejection test in this file while stalling the entire pipeline permanently.
test("a legal edge walked by its permitted agent reaches the database", async () => {
  // A recording double.
  const port = makeFakePort();
  // `tailored → audit_clean` is `['auditor']`, so this is exactly what the Auditor does.
  const outcome = await guardedAdvance(port, { id: "app-1", status: "tailored" }, "audit_clean", "auditor");
  // Accepted.
  assert.equal(outcome.ok, true);
  // And it actually reached the port — the half a rejection-only test cannot prove.
  assert.equal(port.callsTo("advanceStatus").length, 1);
  // With the right arguments, so the guard is not merely calling something.
  assert.deepEqual(port.callsTo("advanceStatus")[0]?.args.slice(0, 3), ["app-1", "audit_clean", "auditor"]);
});

test("a non-existent edge is refused WITHOUT touching the database", async () => {
  // A double that would happily accept the write if it were attempted.
  const port = makeFakePort();
  // `tailored → applying` skips the human approval gate. Constraint #15's exact shape.
  const outcome = await guardedAdvance(port, { id: "app-1", status: "tailored" }, "applying", "auditor");
  // Refused.
  assert.equal(outcome.ok, false);
  // Named, so the agent can count it as a bug rather than as a transient failure.
  assert.equal(outcome.ok === false && outcome.reason, "illegal_transition");
  // THE POINT: no write was attempted at all.
  assert.equal(port.callsTo("advanceStatus").length, 0);
});

test("a real edge walked by the WRONG agent is refused without touching the database", async () => {
  // The subtle case, and the reason the actor is a required argument.
  const port = makeFakePort();
  // `audit_flagged → tailored` EXISTS, but it is `['human']`-only: an automated retry
  // loop here would burn quota rewriting the same flagged bullet.
  const outcome = await guardedAdvance(port, { id: "app-1", status: "audit_flagged" }, "tailored", "auditor");
  // Refused on the actor, not on the edge.
  assert.equal(outcome.ok, false);
  // Same outcome name: from the agent's point of view both are "the graph says no".
  assert.equal(outcome.ok === false && outcome.reason, "illegal_transition");
  // And nothing reached Postgres, so no `42501` to decode from a log.
  assert.equal(port.callsTo("advanceStatus").length, 0);
});

// NON-VACUITY TWIN for the actor check: the SAME edge must be accepted for the agent
// that is allowed to walk it, or the check would be rejecting on the edge alone.
test("the same human-only edge is accepted when the actor really is the human", async () => {
  // A recording double.
  const port = makeFakePort();
  // A person in the dashboard asking for a re-tailor.
  const outcome = await guardedAdvance(port, { id: "app-1", status: "audit_flagged" }, "tailored", "human");
  // Accepted.
  assert.equal(outcome.ok, true);
  // And written.
  assert.equal(port.callsTo("advanceStatus").length, 1);
});

test("a database refusal is reported as a write failure, not as an illegal transition", async () => {
  // A legal edge whose write fails anyway — a dropped connection, or the trigger
  // refusing for a reason the TypeScript graph cannot see.
  const port = makeFakePort({ advanceError: "P0001 illegal status transition" });
  // Walk a legal edge.
  const outcome = await guardedAdvance(port, { id: "app-1", status: "tailored" }, "audit_clean", "auditor");
  // Refused.
  assert.equal(outcome.ok, false);
  // But distinctly: `illegal_transition` means OUR graph rejected it and the code has a
  // bug; `write_failed` means the database rejected it and the environment does.
  // Collapsing them would send someone to read the wrong file.
  assert.equal(outcome.ok === false && outcome.reason, "write_failed");
  // With the detail preserved for the log.
  assert.match(String(outcome.ok === false ? outcome.detail : ""), /P0001/);
});

test("the detail payload is forwarded so the event log records WHY", async () => {
  // A recording double.
  const port = makeFakePort();
  // Agents attach context — a drop reason, a score, a violation list.
  await guardedAdvance(port, { id: "app-1", status: "deduped" }, "dropped_filter", "screener", { rule: "staleness" });
  // Forwarded verbatim into `advance_application_status`'s `p_detail`.
  assert.deepEqual(port.callsTo("advanceStatus")[0]?.args[3], { rule: "staleness" });
});
