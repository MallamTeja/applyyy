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

// --- Leak 3 (2026-11-05): a dead backlog blocked marking forever ---
// GitLab's board stored 505 live rows: 242 re-sighted every poll, 249 never seen again since
// September (posting 267dcfcd closed, still approved). Overlap 242/505 = 0.48 < 0.5, so every
// poll refused as identity_drift, and the backlog only grew. The guards now judge the poll
// against the rows the PREVIOUS poll saw; the stale backlog is marked once they pass.

// The previous poll, as company_watchlist records it.
const PREV_AT = "2026-11-05T06:56:24.653Z";
// 10 minutes earlier than the previous poll: inside the sighting tolerance.
const JUST_BEFORE_PREV = "2026-11-05T06:50:00.000Z";
// A September sighting: long stale.
const SEPTEMBER = "2026-09-12T14:36:59.282Z";

// GitLab's shape: `live` rows seen at the previous poll, `stale` rows not seen since September.
function gitlab(live: number, stale: number) {
  // The re-sighted rows, ids live-i.
  const recent = Array.from({ length: live }, (_, i) => ({ id: `live-${i}`, fingerprint: `fp-live-${i}`, lastSeenAt: PREV_AT }));
  // The dead backlog, ids stale-i.
  const old = Array.from({ length: stale }, (_, i) => ({ id: `stale-${i}`, fingerprint: `fp-stale-${i}`, lastSeenAt: SEPTEMBER }));
  // Both, as the snapshot reads them.
  return [...recent, ...old];
}
// Every live fingerprint, i.e. a healthy poll of GitLab today.
const gitlabPoll = (live: number) => Array.from({ length: live }, (_, i) => `fp-live-${i}`);

test("GitLab: 242 live + 249 stale, healthy poll: the stale backlog is marked, nothing live is", () => {
  // The previous poll listed the same 242.
  const plan = planDisappearances({ ...OK, storedLive: gitlab(242, 249), polledFingerprints: gitlabPoll(242), previousPoll: { at: PREV_AT, jobCount: 242 } });
  // Marked, not refused as identity_drift.
  assert.equal(plan.kind, "mark", JSON.stringify(plan));
  // Exactly the 249 stale rows.
  assert.deepEqual(plan.kind === "mark" && [...plan.ids].sort(), gitlab(0, 249).map((j) => j.id).sort());
});

test("GitLab today, before the fix's input exists (no previous poll): still refused as before", () => {
  // No previous poll recorded: the old whole-set guards apply.
  const plan = planDisappearances({ ...OK, storedLive: gitlab(242, 249), polledFingerprints: gitlabPoll(242), previousPoll: null });
  // The old verdict.
  assert.equal(plan.kind === "refuse" && plan.reason, "identity_drift");
});

test("a broken poll is still refused: it lists only 100 of the 242 the previous poll saw", () => {
  // A truncated page that still parsed.
  const plan = planDisappearances({ ...OK, storedLive: gitlab(242, 249), polledFingerprints: gitlabPoll(100), previousPoll: { at: PREV_AT, jobCount: 242 } });
  // 142 of 242 recent rows absent: drift, judged on the recent rows.
  assert.equal(plan.kind, "refuse");
});

test("a few absent recent rows plus the backlog: normal churn is marked with the backlog", () => {
  // 240 of the 242 listed again.
  const plan = planDisappearances({ ...OK, storedLive: gitlab(242, 249), polledFingerprints: gitlabPoll(240), previousPoll: { at: PREV_AT, jobCount: 242 } });
  // Two closed since the last poll, plus the 249 stale.
  assert.equal(plan.kind === "mark" && plan.ids.length, 251);
});

test("a sighting a few minutes before the recorded poll time still counts as that poll's", () => {
  // The worker writes last_seen_at and last_polled_at with separate clocks reads.
  const rows = gitlab(242, 249).map((j) => (j.lastSeenAt === PREV_AT ? { ...j, lastSeenAt: JUST_BEFORE_PREV } : j));
  // Same healthy poll.
  const plan = planDisappearances({ ...OK, storedLive: rows, polledFingerprints: gitlabPoll(242), previousPoll: { at: PREV_AT, jobCount: 242 } });
  // Still the recent basis.
  assert.equal(plan.kind === "mark" && plan.ids.length, 249);
});

test("timestamps that cannot explain the previous poll are not trusted: whole-set guards apply", () => {
  // THE HOLE THIS CLOSES: only 5 rows look recent although the previous poll listed 242, and a
  // broken poll lists exactly those 5. A 5-row basis would pass and mark 486 live jobs dead.
  const rows = gitlab(5, 486);
  // The broken poll.
  const plan = planDisappearances({ ...OK, storedLive: rows, polledFingerprints: gitlabPoll(5), previousPoll: { at: PREV_AT, jobCount: 242 } });
  // Refused, as it was before this change.
  assert.equal(plan.kind, "refuse");
});

test("a persistently truncated board cannot wipe itself on its second poll (security review, 2026-11-05)", () => {
  // Poll N listed only 30 of 240 and was refused, but scout-ats still recorded last_poll_job_count
  // 30 and re-sighted those 30 at PREV_AT. The other 210 were last seen at the poll before, 12 h earlier.
  const twelveHoursBefore = "2026-11-04T18:56:24.653Z";
  // The 30 the truncated poll listed, then the 210 it dropped.
  const rows = [
    ...Array.from({ length: 30 }, (_, i) => ({ id: `kept-${i}`, fingerprint: `fp-kept-${i}`, lastSeenAt: PREV_AT })),
    ...Array.from({ length: 210 }, (_, i) => ({ id: `lost-${i}`, fingerprint: `fp-lost-${i}`, lastSeenAt: twelveHoursBefore })),
  ];
  // Poll N+1 truncates the same way.
  const plan = planDisappearances({ ...OK, storedLive: rows, polledFingerprints: rows.slice(0, 30).map((j) => j.fingerprint), previousPoll: { at: PREV_AT, jobCount: 30 } });
  // The 210 live jobs were seen half a day ago: not a dead backlog, so none is marked.
  assert.deepEqual(plan.kind === "mark" ? plan.ids : [], []);
});
