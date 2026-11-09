// The matcher's Gemini pacing (2026-11-09, docs/status/2026-11-09-matcher-stall.md). Red if the matcher
// goes back to bursting a page's calls faster than the free tier's ~15 RPM, which is what drew 429 on
// every key: pages that hit 429 ran at a median 18.3 calls/min, clean ones at 7.8.

// node:test, the runner this suite uses.
import { test } from "node:test";
// Strict asserts, so a near-miss is never treated as equal.
import assert from "node:assert/strict";
// The source of index.ts, to prove the pacer is actually passed to the Gemini call (not just defined).
import { readFileSync } from "node:fs";
// The pacer class, so the test drives the same queue logic with a virtual clock.
import { GeminiPacer, type PacerClock } from "../_shared/gemini/client.ts";
// The constant under test, and the instance index.ts uses.
import { MATCHER_MIN_CALL_GAP_MS, matcherPacer } from "./pacer.ts";

// The free-tier ceiling the gap must stay under, in calls per minute.
const FREE_TIER_RPM = 15;

/** A clock that never really waits: sleep advances virtual time, so a minute of spacing costs nothing. */
function virtualClock(): PacerClock {
  // The virtual "now", in ms.
  let now = 1_000;
  // now() reads it; sleep() moves it forward by exactly the requested wait.
  return { now: () => now, sleep: async (ms: number) => { now += ms; } };
}

test("the matcher's call gap keeps a burst under the free tier's ~15 RPM", () => {
  // The fastest sustained rate the gap allows.
  const maxRpm = 60_000 / MATCHER_MIN_CALL_GAP_MS;
  // Strictly under the ceiling, so other functions spending the same quota still have room.
  assert.ok(maxRpm < FREE_TIER_RPM, `gap ${MATCHER_MIN_CALL_GAP_MS} ms allows ${maxRpm} calls/min, not under ${FREE_TIER_RPM}`);
});

test("a 10-row page's calls are spread over at least 9 gaps, never fired back to back", async () => {
  // The same gap the matcher uses, on a virtual clock so the test is instant.
  const clock = virtualClock();
  // A pacer like matcherPacer, but on the virtual clock.
  const pacer = new GeminiPacer({ minIntervalMs: MATCHER_MIN_CALL_GAP_MS, clock });
  // The virtual time each call started at.
  const starts: number[] = [];
  // Ten sequential calls, as one 10-row matcher page makes.
  for (let i = 0; i < 10; i++) await pacer.pace(async () => { starts.push(clock.now()); });
  // First to last start spans at least 9 gaps: that is what keeps the page under the RPM ceiling.
  assert.ok(starts[9]! - starts[0]! >= 9 * MATCHER_MIN_CALL_GAP_MS, `10 calls spanned ${starts[9]! - starts[0]!} ms`);
});

test("index.ts passes matcherPacer to generateGeminiContent (the shared 500 ms default is not used)", () => {
  // The matcher's source.
  // CRLF normalised: Windows working copies are CRLF and the pattern below matches on \n.
  const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  // The option is actually passed in the Gemini call, not only imported.
  assert.match(source, /\n\s*pacer: matcherPacer,\n/);
  // And the instance it passes is the matcher's own, with the matcher's gap.
  assert.ok(matcherPacer instanceof GeminiPacer);
});
