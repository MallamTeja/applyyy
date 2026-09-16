// A counting semaphore, written by hand because the lockfile is single-owner.
//
// WHY THIS EXISTS AT ALL — the Scout polls many boards. An unbounded `Promise.all`
// over a watchlist opens as many sockets as there are rows, which gets us rate-limited
// by exactly the servers whose 429s the retry loop exists to survive. Without a cap
// the two features actively fight each other: more parallelism produces more 429s,
// which produces more backoff, which produces a slower run than the capped version
// would have managed. Upstream never needed this because each of its CLIs polled one
// portal at a time.
//
// WHY NOT `p-limit` — it is fifteen lines of logic and `pnpm-lock.yaml` is owned by a
// single session in a tree five sessions share. A dependency added from here rewrites
// a file that is not ours. Fifteen lines is cheaper than that coordination.

// Bounds how many operations may be in flight at once.
export interface Semaphore {
  // Run `fn` once a slot is free, releasing the slot when it settles either way.
  run<T>(fn: () => Promise<T>): Promise<T>;
  // How many slots are currently held. Exposed ONLY so tests can assert the cap is
  // never exceeded — production code branching on this would be racing itself, since
  // the value can change between the read and whatever it decided to do about it.
  readonly inFlight: number;
}

// Build a semaphore admitting at most `maxConcurrent` simultaneous operations.
//
// WHY A FACTORY RATHER THAN A MODULE-LEVEL GLOBAL: a module global would make two
// independent callers throttle each other invisibly — a robots.txt check and a board
// poll would contend for the same slots despite having nothing to do with one another.
// It would also make the tests order-dependent, because leftover in-flight counts
// would leak between test files that `node --test` runs in one process.
export function createSemaphore(maxConcurrent: number): Semaphore {
  // A cap below 1 can never admit anyone, which would deadlock every caller rather
  // than failing visibly. Rejecting it here turns a silent hang into a loud error at
  // construction time, where the stack trace still points at the misconfiguration.
  if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1) {
    throw new RangeError(`maxConcurrent must be a positive integer, got ${maxConcurrent}`);
  }

  // Slots currently held. The single piece of mutable state in this module.
  let held = 0;
  // Callers parked waiting for a slot, in arrival order. Each entry is the `resolve`
  // of the promise that caller is awaiting; calling it hands that caller the slot.
  // FIFO rather than LIFO so a request that arrived first is not starved by a burst
  // arriving behind it — under load LIFO produces unbounded latency for the unlucky.
  const waiting: Array<() => void> = [];

  // Take a slot, waiting if all are held.
  function acquire(): Promise<void> {
    // Fast path: a slot is free, so take it without ever constructing a queue entry.
    if (held < maxConcurrent) {
      held++;
      return Promise.resolve();
    }
    // Slow path: park. The promise resolves when `release` pulls this entry off the
    // queue, at which point the slot has ALREADY been transferred to us — see release.
    return new Promise<void>((resolve) => {
      waiting.push(resolve);
    });
  }

  // Give a slot back, handing it directly to the next waiter if there is one.
  function release(): void {
    // Hand the slot straight across rather than decrementing and letting the waiter
    // re-check. Decrementing first would open a window in which a brand-new caller
    // hitting the fast path could steal the slot from someone who has been queued
    // since before it arrived — a fairness bug that only shows up under load.
    const next = waiting.shift();
    // `noUncheckedIndexedAccess` makes shift() possibly-undefined, which is exactly
    // right here: an empty queue is the normal case and must not be treated as a
    // callable.
    if (next !== undefined) {
      next();
      return;
    }
    // Nobody waiting, so the slot genuinely goes back to the pool.
    held--;
  }

  return {
    // Exposed as a getter so a test reads the CURRENT value rather than a number
    // captured when the semaphore was built.
    get inFlight(): number {
      return held;
    },

    async run<T>(fn: () => Promise<T>): Promise<T> {
      await acquire();
      try {
        // The awaited call is inside the try so that a rejection still reaches the
        // finally below. Returning the promise unawaited would release the slot
        // immediately and defeat the entire cap.
        return await fn();
      } finally {
        // RELEASE IN `finally`, NOT AFTER THE AWAIT. One thrown request would
        // otherwise leak its slot permanently, and the client would deadlock after
        // exactly `maxConcurrent` failures — a bug that looks like a hang under
        // intermittent network trouble and is close to undiagnosable from a log.
        release();
      }
    },
  };
}
