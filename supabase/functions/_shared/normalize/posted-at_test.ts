// PROJECT_PLAN.md §13: `posted_at` is the least reliable field in the system, so
// every job carries a CONFIDENCE alongside the date and the freshness rule reads
// both. These tests pin the per-source behaviour and the cold-start guard.
import { test } from "node:test";
// Strict equality so a `null` date never quietly compares equal to an empty string.
import assert from "node:assert/strict";
// Extension-suffixed specifier so the same file runs under Deno and Node.
import { extractPostedAt } from "./posted-at.ts";

// A fixed clock. Relative-date parsing is a function of "now", so injecting it is
// what makes "3 days ago" assertable instead of flaky at midnight.
const NOW = new Date("2026-09-09T18:00:00.000Z");
// The moment our scout first observed the posting, the steady-state fallback.
const FIRST_SEEN = new Date("2026-09-08T06:00:00.000Z");
// The normal case: this board has been polled before, so first_seen_at is meaningful.
const ESTABLISHED_BOARD = { now: NOW, firstSeenAt: FIRST_SEEN, isFirstPollOfBoard: false };
// A genuine Lever timestamp reused across cases, kept as a constant so the
// expected ISO string and the input can never drift apart.
const LEVER_EPOCH_MS = 1788350400000;

// Lever exposes a real creation timestamp, so it earns the highest confidence.
test("lever createdAt epoch milliseconds is exact", () => {
  // Epoch milliseconds is exactly how Lever ships the field.
  const result = extractPostedAt({ source: "lever", createdAt: LEVER_EPOCH_MS }, ESTABLISHED_BOARD);
  // Genuine posted date per the §13 table.
  assert.equal(result.postedAtSource, "exact");
  // Round-tripped to ISO because that is what a Postgres timestamptz column takes.
  assert.equal(result.postedAt, new Date(LEVER_EPOCH_MS).toISOString());
});

// Ashby publishedDate is likewise a genuine publication timestamp.
test("ashby publishedDate is exact", () => {
  // ISO-8601 string, the shape the Ashby posting API returns.
  const result = extractPostedAt(
    { source: "ashby", publishedDate: "2026-09-08T09:30:00.000Z" },
    ESTABLISHED_BOARD,
  );
  // No derivation happened, so confidence is full.
  assert.equal(result.postedAtSource, "exact");
  // Preserved exactly rather than re-derived.
  assert.equal(result.postedAt, "2026-09-08T09:30:00.000Z");
});

// The Adzuna `created` field is a genuine posting date per the §13 table.
test("adzuna created is exact", () => {
  // Adzuna ships a compact ISO timestamp.
  const result = extractPostedAt({ source: "adzuna", created: "2026-09-07T10:00:00Z" }, ESTABLISHED_BOARD);
  // Third genuine source.
  assert.equal(result.postedAtSource, "exact");
});

// THE GREENHOUSE TRAP. `updated_at` moves whenever anyone edits the description,
// so treating it as a posted date would make a six-month-old job look fresh.
test("greenhouse updated_at is derived, never exact", () => {
  // A perfectly well-formed timestamp: the problem is its meaning, not its format.
  const result = extractPostedAt(
    { source: "greenhouse", updatedAt: "2026-09-09T08:00:00.000Z" },
    ESTABLISHED_BOARD,
  );
  // Downgraded confidence is the entire point of this test.
  assert.equal(result.postedAtSource, "derived");
  // The timestamp is still kept, because it is an upper bound on the true date.
  assert.equal(result.postedAt, "2026-09-09T08:00:00.000Z");
});

// Aggregators hand us prose instead of a timestamp.
test("aggregator relative text is parsed into a derived date", () => {
  // The most common Naukri and LinkedIn phrasing.
  const result = extractPostedAt({ source: "aggregator", relativeText: "3 days ago" }, ESTABLISHED_BOARD);
  // Parsed rather than observed, so confidence drops one notch.
  assert.equal(result.postedAtSource, "derived");
  // Exactly three days before the injected clock.
  assert.equal(result.postedAt, new Date("2026-09-06T18:00:00.000Z").toISOString());
});

// The word forms carry the same information without a digit.
test("aggregator word-form relative dates are parsed", () => {
  // "yesterday" must mean exactly one day back from the injected clock.
  const yesterday = extractPostedAt({ source: "aggregator", relativeText: "Posted yesterday" }, ESTABLISHED_BOARD);
  // One day before NOW.
  assert.equal(yesterday.postedAt, new Date("2026-09-08T18:00:00.000Z").toISOString());
  // "today" means zero days back, i.e. the clock itself.
  const today = extractPostedAt({ source: "aggregator", relativeText: "today" }, ESTABLISHED_BOARD);
  // Same instant as NOW.
  assert.equal(today.postedAt, NOW.toISOString());
});

// Steady state: no date at all, but we have polled this board before, so anything
// newly appearing really is new.
test("a missing date on an established board falls back to first_seen_at as derived", () => {
  // Naukri frequently ships no date field whatsoever.
  const result = extractPostedAt({ source: "aggregator", relativeText: null }, ESTABLISHED_BOARD);
  // Inferred from our own observation, so derived rather than exact.
  assert.equal(result.postedAtSource, "derived");
  // The observation timestamp is the best evidence available.
  assert.equal(result.postedAt, FIRST_SEEN.toISOString());
});

// Unparseable prose is the same situation as no date at all.
test("unrecognised relative text falls back to first_seen_at", () => {
  // "Posted recently" carries no extractable quantity.
  const result = extractPostedAt({ source: "aggregator", relativeText: "Posted recently" }, ESTABLISHED_BOARD);
  // Still derived, because first_seen_at remains a real observation.
  assert.equal(result.postedAtSource, "derived");
  // Falls through to that observation.
  assert.equal(result.postedAt, FIRST_SEEN.toISOString());
});

// THE COLD-START GUARD (§13). Adding a company to the watchlist delivers its whole
// back catalogue with first_seen_at = today. Marking the first poll `unknown` is
// what stops a day of Gemini quota going to postings open since March.
test("the first poll of a new board marks a dateless job unknown", () => {
  // Same dateless aggregator job, but this board has never been polled.
  const result = extractPostedAt(
    { source: "aggregator", relativeText: null },
    { now: NOW, firstSeenAt: FIRST_SEEN, isFirstPollOfBoard: true },
  );
  // `unknown` is what the staleness filter keys off to refuse to guess.
  assert.equal(result.postedAtSource, "unknown");
});

// Literal compliance with the §13 wording "marks everything unknown": the cost is a
// one-poll delay for genuinely fresh jobs, strictly cheaper than a false-fresh batch.
test("the first poll of a new board downgrades even a genuine lever date", () => {
  // The Lever createdAt is genuine, but the board itself is not yet trusted.
  const result = extractPostedAt(
    { source: "lever", createdAt: LEVER_EPOCH_MS },
    { now: NOW, firstSeenAt: FIRST_SEEN, isFirstPollOfBoard: true },
  );
  // Confidence is suppressed board-wide on poll one.
  assert.equal(result.postedAtSource, "unknown");
  // The timestamp itself is retained so the dashboard can still display it.
  assert.equal(result.postedAt, new Date(LEVER_EPOCH_MS).toISOString());
});

// A malformed timestamp must degrade, never throw: one bad row cannot kill a scout
// run. It is treated as ABSENCE, identically to a null, because a garbage string and
// a missing field carry exactly the same amount of information — zero. Giving them
// different outcomes would be an inconsistency, not a safety feature.
test("a malformed timestamp is treated as absence, not as an error", () => {
  // Boards occasionally ship a placeholder string rather than omitting the field.
  const result = extractPostedAt({ source: "ashby", publishedDate: "not-a-date" }, ESTABLISHED_BOARD);
  // Same fallback path as a null: our own observation is still real evidence.
  assert.equal(result.postedAtSource, "derived");
  // And that observation is the timestamp kept.
  assert.equal(result.postedAt, FIRST_SEEN.toISOString());
});

// Epoch 0 is the classic "field exists but was never set" sentinel.
test("a zero lever epoch is treated as absent rather than as 1970", () => {
  // Zero would otherwise render as 1970, which no freshness rule handles sensibly.
  const result = extractPostedAt({ source: "lever", createdAt: 0 }, ESTABLISHED_BOARD);
  // The sentinel is refused, so the confidence can never be `exact`.
  assert.notEqual(result.postedAtSource, "exact");
  // The critical assertion: 1970 must never reach the database as a posting date.
  assert.equal(result.postedAt, FIRST_SEEN.toISOString());
});

// With first_seen_at always available, `unknown` has exactly ONE cause: the
// cold-start guard. Pinning that keeps the meaning of the column unambiguous —
// "unknown" reads as "this board was not yet trusted", never as "parse failure".
test("unknown is reachable only through the cold-start guard", () => {
  // Every degraded input on an established board still resolves to derived.
  for (const input of [
    { source: "ashby", publishedDate: "not-a-date" },
    { source: "lever", createdAt: 0 },
    { source: "greenhouse", updatedAt: null },
    { source: "aggregator", relativeText: "Posted recently" },
  ] as const) {
    // None of these may produce `unknown` once the board has been polled before.
    assert.notEqual(extractPostedAt(input, ESTABLISHED_BOARD).postedAtSource, "unknown");
  }
});

// A null on a genuine source is absence, not corruption, so the fallback applies.
test("a null greenhouse updated_at falls back to first_seen_at on an established board", () => {
  // Greenhouse omits updated_at on a small number of postings.
  const result = extractPostedAt({ source: "greenhouse", updatedAt: null }, ESTABLISHED_BOARD);
  // Our own observation is still evidence.
  assert.equal(result.postedAtSource, "derived");
  // And it is the timestamp we keep.
  assert.equal(result.postedAt, FIRST_SEEN.toISOString());
});
