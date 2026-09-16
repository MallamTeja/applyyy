// Tests for the counting semaphore and the concurrency-capped client.
//
// THE TEST THAT MATTERS MOST HERE is "a rejected operation still releases its slot".
// The cap itself is easy to get right and easy to see; the leak is neither. One thrown
// request that never releases leaves the client permanently one slot poorer, and after
// exactly `maxConcurrent` failures it deadlocks — which presents as a hang under
// intermittent network trouble, with no error anywhere and nothing in a log to point
// at this file.

import { afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";

import { createHttpClient, createSemaphore } from "./index.ts";

// Restored after every test for the same reason as the transport suite: `node --test`
// shares one process across files, so a leaked stub poisons unrelated tests.
const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

// A promise plus the handle to settle it from outside.
//
// This is what lets a test hold operations open deliberately instead of racing timers
// to observe concurrency — a sleep-based version of these tests would be flaky on a
// loaded machine and would prove nothing on a fast one.
function deferred(): { promise: Promise<void>; resolve: () => void; reject: (e: Error) => void } {
  // Definite-assignment assertions because the executor runs synchronously, so both
  // are assigned before the constructor returns — TypeScript cannot prove that, and
  // initialising them to no-ops would hide a genuine bug if it ever stopped being true.
  let resolve!: () => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  // All three handed back together so a test can hold an operation open and then
  // settle it either way, which is what makes these tests deterministic rather than
  // timing-dependent.
  return { promise, resolve, reject };
}

describe("the semaphore bounds what is in flight", () => {
  test("rejects a cap below one instead of deadlocking silently", () => {
    // A cap of zero can never admit anyone. Failing at construction turns a silent
    // hang into a loud error whose stack still points at the misconfiguration.
    assert.throws(() => createSemaphore(0), RangeError);
    assert.throws(() => createSemaphore(-1), RangeError);
    // Non-integers are rejected too: `createSemaphore(2.5)` would otherwise admit
    // either 2 or 3 depending on comparison order, which is a coin-flip cap.
    assert.throws(() => createSemaphore(1.5), RangeError);
  });

  test("never exceeds the cap and admits the queue as slots free up", async () => {
    // Cap of 2 against 4 operations: the smallest setup where a queue actually forms
    // and then drains, which is what distinguishes a cap from a hard limit that drops.
    const semaphore = createSemaphore(2);
    // Gates for four operations, each held open until this test says otherwise.
    const gates = [deferred(), deferred(), deferred(), deferred()];
    // The high-water mark is the real assertion surface: checking `inFlight` once at
    // the end would read zero and prove nothing.
    let peak = 0;

    // Started all at once, the way an unbounded Promise.all over a watchlist would.
    const running = gates.map((gate) =>
      semaphore.run(async () => {
        // Sampled INSIDE the operation, because that is the only moment the slot is
        // genuinely held; sampling outside races the scheduler.
        peak = Math.max(peak, semaphore.inFlight);
        await gate.promise;
      }),
    );

    // Let the first two start and park. A microtask turn is enough because nothing
    // here awaits a real timer.
    await Promise.resolve();
    await Promise.resolve();
    // TWO, not four. Without the cap all four would have entered immediately.
    assert.equal(semaphore.inFlight, 2);

    // Release the first two; the queued pair should take their slots.
    gates[0]?.resolve();
    gates[1]?.resolve();
    // Three turns rather than one: the release, the queued caller's resumption, and
    // its own first await each cost a microtask, and collapsing them makes the test
    // pass or fail on scheduler details rather than on the cap.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // Release the pair that was queued, so nothing is left holding a slot.
    gates[2]?.resolve();
    gates[3]?.resolve();
    await Promise.all(running);

    // The cap held for the whole run — 3 here would mean a slot was double-issued.
    assert.equal(peak, 2);
    // And everything drained: a non-zero count would be the leak the next test isolates.
    assert.equal(semaphore.inFlight, 0);
  });

  test("a rejected operation still releases its slot", async () => {
    // THE LEAK TEST. Release happens in a `finally`; a release placed after the await
    // would pass every test above and fail only here.
    const semaphore = createSemaphore(1);

    await assert.rejects(
      semaphore.run(async () => {
        throw new Error("boom");
      }),
      /boom/,
    );
    // Back to zero. If the slot had leaked this would read 1, and the next acquire
    // would park forever.
    assert.equal(semaphore.inFlight, 0);

    // Proving the semaphore is still usable is the part that matters — a leaked slot
    // is only visible as a hang on the NEXT caller, not on the one that threw.
    await semaphore.run(async () => {});
    assert.equal(semaphore.inFlight, 0);
  });
});

describe("the client shares one cap across its own requests", () => {
  test("holds concurrency at the configured maximum", async () => {
    // Gate every response so requests pile up rather than completing instantly.
    // A stub that returned immediately would never let more than one be in flight,
    // and the test would pass against a client with no cap at all.
    const gates: Array<{ promise: Promise<void>; resolve: () => void }> = [];
    globalThis.fetch = (async () => {
      const gate = deferred();
      // Pushed before awaiting, so the test can count how many requests actually
      // reached the network layer rather than how many were merely started.
      gates.push(gate);
      await gate.promise;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    // Four URLs against a cap of two — the shape of a watchlist poll.
    const client = createHttpClient({ maxConcurrent: 2 });
    const running = [1, 2, 3, 4].map((n) => client.fetch(`https://example.test/${n}`));

    // Yield enough turns for the admitted requests to reach the stubbed fetch.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // TWO sockets open, not four — the failure this prevents is opening one socket per
    // watchlist row and being rate-limited by the very hosts whose 429s the retry loop
    // exists to survive.
    assert.equal(client.inFlight, 2);
    assert.equal(gates.length, 2);

    // Drain: release whatever is open until everything has been served.
    //
    // Written as a loop rather than resolving a known four gates, because releasing
    // the first two ADMITS the queued two, which push new gates onto this same array
    // as they reach the stub. A fixed-count drain would leave the last pair hanging
    // and the test would time out rather than fail with a useful message.
    while (gates.length > 0) {
      const gate = gates.shift();
      gate?.resolve();
      // Same three-turn yield as above, for the same reason: release, resumption, and
      // the newly-admitted request's own first await.
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    }
    // Everything settled, so nothing was dropped by the cap — a semaphore that lost a
    // queued caller would hang here instead of resolving.
    await Promise.all(running);
    // Fully drained: no slot leaked across four requests and two queue transfers.
    assert.equal(client.inFlight, 0);
  });

  test("two clients do not throttle each other", async () => {
    // WHY THE FACTORY EXISTS. A module-level cap would make the robots gate and a
    // board poll contend for the same slots despite having nothing to do with one
    // another, and would make these very tests order-dependent.
    const gates: Array<{ promise: Promise<void>; resolve: () => void }> = [];
    globalThis.fetch = (async () => {
      const gate = deferred();
      gates.push(gate);
      await gate.promise;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    const first = createHttpClient({ maxConcurrent: 1 });
    const second = createHttpClient({ maxConcurrent: 1 });
    const running = [first.fetch("https://a.test/"), second.fetch("https://b.test/")];

    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // Both are in flight simultaneously: one slot each, independently owned.
    assert.equal(first.inFlight, 1);
    assert.equal(second.inFlight, 1);
    assert.equal(gates.length, 2);

    for (const gate of gates) gate.resolve();
    await Promise.all(running);
  });
});
