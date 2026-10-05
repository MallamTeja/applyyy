// Tests for deciding which stored jobs have dropped off a board.
//
// THE RULE UNDER TEST: a poll marks jobs dead only when it is evidence that they are.
// Each refusal case is a poll that LOOKS like "jobs closed" but means "the poll, or our
// identity for these jobs, is broken". Asserted on the union's `kind` and `reason`, never
// on detail prose, so rewording a log line cannot turn a test red.
import { test } from "node:test";
// Strict, so a missing key never equals a key holding `undefined`.
import assert from "node:assert/strict";
// Extension-suffixed so this runs under node --test and Deno alike.
import { firstPerFingerprint, planDisappearances, planReappearances } from "./liveness.ts";

// N stored jobs with ids job-i and fingerprints fp-i, so overlap is easy to dial.
function stored(n: number) {
  return Array.from({ length: n }, (_, i) => ({ id: `job-${i}`, fingerprint: `fp-${i}` }));
}
// A healthy poll's other fields; each test overrides exactly one.
const OK = { pollOk: true, batchErrors: 0 };

test("a failed poll refuses", () => {
  const plan = planDisappearances({ ...OK, storedLive: stored(10), polledFingerprints: [], pollOk: false });
  assert.equal(plan.kind, "refuse");
  // Narrowed so the reason is readable; the cause must be the poll, not emptiness.
  assert.equal(plan.kind === "refuse" && plan.reason, "poll_not_ok");
});

test("a batch error refuses even when the poll fetched fine", () => {
  const plan = planDisappearances({ ...OK, storedLive: stored(10), polledFingerprints: ["fp-0"], batchErrors: 1 });
  assert.equal(plan.kind === "refuse" && plan.reason, "batch_errors");
});

test("a 200 with zero postings refuses rather than marking the whole board", () => {
  // THE CASE THAT WIPES THE INVENTORY if unguarded: every stored job is absent.
  const plan = planDisappearances({ ...OK, storedLive: stored(10), polledFingerprints: [] });
  assert.equal(plan.kind === "refuse" && plan.reason, "empty_poll");
});

test("a first poll refuses: nothing stored to compare", () => {
  const plan = planDisappearances({ ...OK, storedLive: [], polledFingerprints: ["fp-0"] });
  assert.equal(plan.kind === "refuse" && plan.reason, "no_stored_jobs");
});

test("zero fingerprint overlap is identity drift, not 10 closures", () => {
  // The live seen_count=1 symptom: the poll's fingerprints match nothing stored.
  const plan = planDisappearances({ ...OK, storedLive: stored(10), polledFingerprints: ["new-a", "new-b"] });
  assert.equal(plan.kind === "refuse" && plan.reason, "identity_drift");
});

test("40% absent with healthy overlap is a mass disappearance", () => {
  // 6 of 10 still listed: overlap 0.6 passes drift, absent 0.4 exceeds the cap.
  const polled = stored(6).map((j) => j.fingerprint);
  const plan = planDisappearances({ ...OK, storedLive: stored(10), polledFingerprints: polled });
  assert.equal(plan.kind === "refuse" && plan.reason, "mass_disappearance");
});

test("normal churn (10 stored, 9 polled) marks exactly the one absent job", () => {
  const polled = stored(9).map((j) => j.fingerprint);
  const plan = planDisappearances({ ...OK, storedLive: stored(10), polledFingerprints: polled });
  // The exact id, so marking an extra or a wrong job fails.
  assert.deepEqual(plan, { kind: "mark", ids: ["job-9"] });
});

test("a reappeared posting is returned for clearing; an absent one is not", () => {
  const disappeared = [
    { id: "job-a", fingerprint: "fp-a", repost_count: 0 },
    { id: "job-b", fingerprint: "fp-b", repost_count: 2 },
  ];
  const back = planReappearances({ storedDisappeared: disappeared, polledFingerprints: ["fp-b", "fp-x"], pollOk: true });
  // Only job-b is listed again, with its count carried for the + 1 write.
  assert.deepEqual(back, [{ id: "job-b", fingerprint: "fp-b", repost_count: 2 }]);
  // A failed poll clears nothing.
  assert.deepEqual(planReappearances({ storedDisappeared: disappeared, polledFingerprints: ["fp-b"], pollOk: false }), []);
});

test("two postings sharing a fingerprint collapse to the first, in order", () => {
  // Fingerprint is company+title+location, so two live postings can share one; a
  // DO UPDATE batch holding both fails with "cannot affect row a second time".
  const postings = [
    { atsId: "1", fingerprint: "fp-a" },
    { atsId: "2", fingerprint: "fp-b" },
    { atsId: "3", fingerprint: "fp-a" },
  ];
  // The first fp-a (atsId 1) survives; order of the rest is kept.
  assert.deepEqual(firstPerFingerprint(postings, (p) => p.fingerprint).map((p) => p.atsId), ["1", "2"]);
});
