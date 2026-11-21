// THE SHARED REQUEST PACER (drift #2, 2026-11-21; D5: one implementation for both scouts).
//
// WHY IT EXISTS: every *.myworkdayjobs.com tenant answers through one Cloudflare zone, and the 429s hit one tenant
// after another (worker D1 design point 3, 2026-11-18). A paired probe on 2026-11-21 07:48 UTC got Cloudflare 429s on
// robots AND jobs from both a GitHub runner and a home IP, so it is rate- or UA-side, not an IP block: the cure is a
// gap between requests in the zone. The worker paces (worker/src/scout/board-pages.ts:105-125); the edge scout did not,
// so a Scan burst the zone while it was already answering 429. This file is that lane rule, made shareable:
// the edge transport (_shared/http/transport.ts) applies it to every request, and the worker can switch to it later.
//
// THE RULE (the worker's, unchanged): one lane per zone (Workday, iCIMS), 1 s between the STARTS of two requests in a
// lane, every other host undelayed.
//
// ONE DIFFERENCE, on purpose: the worker's pacer assumes one caller at a time. The edge has a concurrent client
// (_shared/http/index.ts runs requests through a semaphore), so this pacer RESERVES each request's slot before it
// waits: two callers arriving together get slots 1 s apart instead of both passing a check-then-set.
//
// PURE apart from the injected clock: no Deno API, so node --test runs it on a fake clock.

// The gap between two request starts in one lane (the worker's PACED_REQUEST_GAP_MS).
// ponytail: 1 s is the low end of the approved 1-2 s; raise it only if 429s continue at 1 s.
export const PACED_REQUEST_GAP_MS = 1_000;

// Which pacing lane a URL belongs to: the Workday zone, the iCIMS zone, or null for "never delayed".
export function paceLane(url: string): string | null {
  // The hostname alone; an unparseable URL is not paced (the fetch itself will fail on it).
  let host: string;
  // URL throws on garbage.
  try {
    // Lower-cased by the URL parser.
    host = new URL(url).hostname;
  } catch {
    // No lane for a URL that cannot be requested anyway.
    return null;
  }
  // Every Workday tenant shares the one lane (a suffix match on the dot, so "myworkdayjobs.com.evil.example" is not it).
  if (host === "myworkdayjobs.com" || host.endsWith(".myworkdayjobs.com")) return "myworkdayjobs.com";
  // Every iCIMS tenant shares another: a board read is one request per job on that zone.
  if (host === "icims.com" || host.endsWith(".icims.com")) return "icims.com";
  // Greenhouse, Lever, Ashby: never delayed.
  return null;
}

// The pacer seam: awaited before every request to a board's origin.
export interface RequestPacer {
  // Resolves when the URL may be requested.
  before(url: string): Promise<void>;
}

// A pacer that keeps `gapMs` between the starts of two requests in the same lane. `now` and `sleep` are injected so
// tests run on a fake clock; production uses the real ones.
export function createRequestPacer(
  // Minimum gap between two request starts in one lane.
  gapMs: number,
  // The clock.
  now: () => number = Date.now,
  // The wait, resolving setTimeout at call time (tests may replace the global).
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): RequestPacer {
  // The earliest start the NEXT request in each lane may have.
  const nextFreeByLane = new Map<string, number>();
  // The pacer itself.
  return {
    async before(url: string): Promise<void> {
      // Unpaced hosts go straight through.
      const lane = paceLane(url);
      // Greenhouse, Lever, Ashby: no delay.
      if (lane === null) return;
      // Now, read once.
      const at = now();
      // This request's slot: now, or the lane's next free start if that is later.
      const slot = Math.max(at, nextFreeByLane.get(lane) ?? at);
      // RESERVED before any wait, so a concurrent caller sees it and takes the slot after.
      nextFreeByLane.set(lane, slot + gapMs);
      // Only a future slot sleeps.
      if (slot > at) await sleep(slot - at);
    },
  };
}
