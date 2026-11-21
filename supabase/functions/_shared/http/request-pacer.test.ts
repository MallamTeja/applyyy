// The shared request pacer (drift #2, 2026-11-21): the edge scout gets the worker's per-lane Workday/iCIMS gap, from
// ONE implementation both scouts can import (D5). Fake clock throughout: no test really sleeps.
import { describe, test } from "node:test";
// Strict comparisons.
import assert from "node:assert/strict";
// The unit under test.
import { createRequestPacer, PACED_REQUEST_GAP_MS, paceLane } from "./request-pacer.ts";

// A fake clock: `sleep` advances time instead of waiting, and records every wait.
function fakeClock(start = 1_000_000): { now: () => number; sleep: (ms: number) => Promise<void>; waits: number[] } {
  // The current fake time.
  let time = start;
  // Every wait asked for, in order.
  const waits: number[] = [];
  // The clock.
  return {
    // Read the fake time.
    now: () => time,
    // "Sleep" by moving time forward.
    sleep: async (ms) => { waits.push(ms); time += ms; },
    // The record.
    waits,
  };
}

describe("paceLane: the worker's lane rule (worker/src/scout/board-pages.ts:105-125)", () => {
  test("every Workday tenant shares one lane, every iCIMS tenant another; other boards and garbage are unpaced", () => {
    // Two different tenants, one Cloudflare zone.
    assert.equal(paceLane("https://ghr.wd1.myworkdayjobs.com/wday/cxs/ghr/Lateral-APAC/jobs"), "myworkdayjobs.com");
    // Same lane, different tenant.
    assert.equal(paceLane("https://lilly.wd115.myworkdayjobs.com/robots.txt"), "myworkdayjobs.com");
    // The iCIMS zone.
    assert.equal(paceLane("https://careers-apac-atlassian.icims.com/sitemap.xml"), "icims.com");
    // Never delayed.
    assert.equal(paceLane("https://boards-api.greenhouse.io/v1/boards/x/jobs"), null);
    // A look-alike host is not the zone.
    assert.equal(paceLane("https://myworkdayjobs.com.evil.example/jobs"), null);
    // Unparseable: no lane (the fetch itself fails on it).
    assert.equal(paceLane("not a url"), null);
  });

  test("the gap is the worker's 1 s", () => {
    // One number for both scouts.
    assert.equal(PACED_REQUEST_GAP_MS, 1_000);
  });
});

describe("createRequestPacer", () => {
  test("keeps the gap between two starts in one lane; the first request and unpaced hosts never wait", async () => {
    // Fake time.
    const clock = fakeClock();
    // The pacer under test.
    const pacer = createRequestPacer(1_000, clock.now, clock.sleep);
    // First Workday request: no wait.
    await pacer.before("https://a.wd1.myworkdayjobs.com/x");
    // A Greenhouse request in between: never paced.
    await pacer.before("https://boards-api.greenhouse.io/v1/boards/x/jobs");
    // 300 ms pass.
    await clock.sleep(300);
    // Second Workday request, another tenant: waits the remaining 700 ms.
    await pacer.before("https://b.wd5.myworkdayjobs.com/y");
    // Exactly one paced wait (the 300 is the test's own).
    assert.deepEqual(clock.waits, [300, 700]);
  });

  test("lanes are independent: a Workday request does not delay an iCIMS one", async () => {
    // Fake time.
    const clock = fakeClock();
    // The pacer.
    const pacer = createRequestPacer(1_000, clock.now, clock.sleep);
    // One of each, back to back.
    await pacer.before("https://a.wd1.myworkdayjobs.com/x");
    // Different lane.
    await pacer.before("https://x.icims.com/sitemap.xml");
    // No waits at all.
    assert.deepEqual(clock.waits, []);
  });

  test("concurrent callers are spaced too: each reserves its slot before it waits (the edge client may run requests in parallel)", async () => {
    // A FROZEN clock: all three callers arrive at the same instant (an advancing fake sleep would move "now" between
    // them, which is not what simultaneous arrival means).
    const waits: number[] = [];
    // Time never moves; sleeps are only recorded.
    const clock = { now: () => 5_000, sleep: async (ms: number) => { waits.push(ms); }, waits };
    // The pacer.
    const pacer = createRequestPacer(1_000, clock.now, clock.sleep);
    // Three requests started together.
    await Promise.all([pacer.before("https://a.wd1.myworkdayjobs.com/1"), pacer.before("https://a.wd1.myworkdayjobs.com/2"), pacer.before("https://a.wd1.myworkdayjobs.com/3")]);
    // Slots at +0, +1000, +2000: the 2nd and 3rd wait their own distance (a check-then-set pacer would let all three through).
    assert.deepEqual(clock.waits, [1_000, 2_000]);
  });

  test("a gap that has already passed costs nothing", async () => {
    // Fake time.
    const clock = fakeClock();
    // The pacer.
    const pacer = createRequestPacer(1_000, clock.now, clock.sleep);
    // First request.
    await pacer.before("https://a.wd1.myworkdayjobs.com/x");
    // A slow response: 2.5 s pass.
    await clock.sleep(2_500);
    // Next request: no extra wait.
    await pacer.before("https://a.wd1.myworkdayjobs.com/y");
    // Only the test's own sleep.
    assert.deepEqual(clock.waits, [2_500]);
  });
});
