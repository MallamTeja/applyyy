// Unit tests for freshness priority scoring helper (_shared/scout/freshness.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  calculateFreshnessScore,
  HIGH_PRIORITY_SCORE,
  MEDIUM_PRIORITY_SCORE,
  LOW_PRIORITY_SCORE,
} from "./freshness.ts";

// Deterministic reference clock: 2026-09-18T12:00:00.000Z
const NOW = new Date("2026-09-18T12:00:00.000Z");

test("returns 100 for job postings created within the last 24 hours", () => {
  // Exactly at current reference time (0 hours old).
  assert.equal(
    calculateFreshnessScore("2026-09-18T12:00:00.000Z", NOW),
    HIGH_PRIORITY_SCORE
  );

  // 1 hour ago.
  assert.equal(
    calculateFreshnessScore("2026-09-18T11:00:00.000Z", NOW),
    HIGH_PRIORITY_SCORE
  );

  // 12 hours ago.
  assert.equal(
    calculateFreshnessScore("2026-09-18T00:00:00.000Z", NOW),
    HIGH_PRIORITY_SCORE
  );

  // 23 hours 59 minutes ago.
  assert.equal(
    calculateFreshnessScore("2026-09-17T12:01:00.000Z", NOW),
    HIGH_PRIORITY_SCORE
  );

  // Exactly 24 hours ago.
  assert.equal(
    calculateFreshnessScore("2026-09-17T12:00:00.000Z", NOW),
    HIGH_PRIORITY_SCORE
  );
});

test("returns 50 for job postings created between 24 and 72 hours ago", () => {
  // 24 hours and 1 minute ago.
  assert.equal(
    calculateFreshnessScore("2026-09-17T11:59:00.000Z", NOW),
    MEDIUM_PRIORITY_SCORE
  );

  // 48 hours ago (2 days old).
  assert.equal(
    calculateFreshnessScore("2026-09-16T12:00:00.000Z", NOW),
    MEDIUM_PRIORITY_SCORE
  );

  // Exactly 72 hours ago (3 days old).
  assert.equal(
    calculateFreshnessScore("2026-09-15T12:00:00.000Z", NOW),
    MEDIUM_PRIORITY_SCORE
  );
});

test("returns 10 for job postings older than 72 hours", () => {
  // 72 hours and 1 minute ago.
  assert.equal(
    calculateFreshnessScore("2026-09-15T11:59:00.000Z", NOW),
    LOW_PRIORITY_SCORE
  );

  // 5 days old.
  assert.equal(
    calculateFreshnessScore("2026-09-13T12:00:00.000Z", NOW),
    LOW_PRIORITY_SCORE
  );

  // 30 days old.
  assert.equal(
    calculateFreshnessScore("2026-08-19T12:00:00.000Z", NOW),
    LOW_PRIORITY_SCORE
  );
});

test("returns 10 for null, empty, whitespace, or invalid date strings", () => {
  // Null timestamp input.
  assert.equal(calculateFreshnessScore(null, NOW), LOW_PRIORITY_SCORE);

  // Empty string input.
  assert.equal(calculateFreshnessScore("", NOW), LOW_PRIORITY_SCORE);

  // Whitespace string input.
  assert.equal(calculateFreshnessScore("   ", NOW), LOW_PRIORITY_SCORE);

  // Unparseable non-date string.
  assert.equal(
    calculateFreshnessScore("invalid-iso-date", NOW),
    LOW_PRIORITY_SCORE
  );
});

test("uses current system clock when optional `now` parameter is omitted", () => {
  // ISO string for a job posted right now (within last few seconds).
  const currentIsoDate = new Date().toISOString();
  assert.equal(calculateFreshnessScore(currentIsoDate), HIGH_PRIORITY_SCORE);

  // ISO string for a job posted 10 days in the past.
  const oldIsoDate = new Date(Date.now() - 10 * 24 * 3600 * 1000).toISOString();
  assert.equal(calculateFreshnessScore(oldIsoDate), LOW_PRIORITY_SCORE);
});
