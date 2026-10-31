// Tests for the shared HTTP transport.
//
// THE TESTS THAT MATTER MOST IN THIS FILE are the four contract invariants — 7-attempt
// exhaustion, a plain 4xx not retrying, 429-then-200, and the per-attempt timeout
// signal. Everything else checks an addition we made on top of the port; those four
// check that the port itself is faithful, and they are the ones that would catch a
// future edit quietly changing the retry budget.
//
// A SECOND CLASS OF TEST HERE IS UNUSUAL AND DELIBERATE: several behaviours harvested
// from upstream arrive UNPINNED. Only `jobdanmark` has tests upstream; the 8000ms cap,
// the fail-fast-on-connection-error rule and the Cloudflare detection all come from
// `linkedin` / `freehire` / `jobbank`, which nobody has ever asserted. These are the
// first tests those behaviours have had, so they are written as claims to verify
// rather than as regression guards for something already known good.

import { afterEach, describe, test } from "node:test";
// Strict, so `undefined` never quietly compares equal to `null` — which matters a lot
// here, because `null` is a MEANINGFUL return (404 under the 'null' mode) and
// `undefined` would be a bug.
import assert from "node:assert/strict";

import {
  BotProtectionError,
  DEFAULT_USER_AGENT,
  HttpError,
  NetworkError,
  RetryAfterTooLongError,
  RobotsDisallowedError,
  httpFetch,
  httpJson,
  httpText,
} from "./index.ts";
// The gate's cache type, so each robots test can hold its own isolated verdict cache —
// the transport's module-level default cache outlives a test and would make later
// tests inherit earlier verdicts for the same origin.
import type { RobotsCache } from "../../../../packages/master-robots/src/index.ts";

// Captured at module load, before any test can replace them. Restoring from a variable
// captured inside a test would restore the previous test's stub, not the real global.
const originalFetch = globalThis.fetch;
const originalSetTimeout = globalThis.setTimeout;

// A leaked stub poisons every later test file, because `node --test` runs files in the
// same process by default. This is the single most important line in the harness.
afterEach(() => {
  globalThis.fetch = originalFetch;
  globalThis.setTimeout = originalSetTimeout;
});

// Replace setTimeout with an instant version that RECORDS what it was asked to wait.
//
// Two jobs in one helper. Firing instantly is what makes `calls === 7` affordable at
// all — without it the exhaustion test really sleeps through 500+1000+2000+4000+8000
// +8000ms of backoff, about 24 seconds plus jitter. Recording the delays is what lets
// us assert the SCHEDULE: a call counter alone cannot tell a 500ms sleep from a 30s
// one, so the Retry-After override and the 8000ms cap would both be invisible to it.
function instantTimers(): { delays: number[] } {
  // Returned by reference so the caller can read delays AFTER the awaited call has
  // finished populating them; a returned array copy would always read empty.
  const seen: { delays: number[] } = { delays: [] };
  globalThis.setTimeout = ((fn: () => void, ms?: number) => {
    // Recorded BEFORE firing, so a callback that throws still leaves evidence of what
    // the loop intended to wait.
    seen.delays.push(ms ?? 0);
    // Deferred rather than called synchronously: firing inline would re-enter the
    // retry loop inside its own await and change the ordering under test.
    return originalSetTimeout(fn, 0);
  }) as unknown as typeof setTimeout;
  return seen;
}

// Script `globalThis.fetch` from a list of response thunks, counting calls.
//
// The stub serves index `min(calls, len-1)`, so the LAST entry repeats forever. That
// is what lets a one-element script drive the exhaustion case: `[() => 500]` answers
// 500 to all seven attempts without listing it seven times.
function stubFetch(
  responses: Array<() => Response>,
  // How a request for /robots.txt is answered. The transport's gate (on by default)
  // asks for it before the first real attempt; the default 404 means "no policy
  // published", which RFC 9309 (and master-robots) reads as allow — so every pre-gate
  // test keeps its exact call script and counts. Gate tests pass their own thunk.
  robots: () => Response = () => new Response("", { status: 404 }),
): {
  calls: number;
  inits: Array<RequestInit | undefined>;
  robotsCalls: number;
} {
  // One mutable record shared with the caller, for the same by-reference reason as
  // instantTimers: the assertions run after the awaited call has mutated it.
  const state: { calls: number; inits: Array<RequestInit | undefined>; robotsCalls: number } = { calls: 0, inits: [], robotsCalls: 0 };
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    // GATE traffic is answered AND COUNTED SEPARATELY, never against the script:
    // mixing it in would shift every scripted index and make `calls` lie about the
    // target's attempts — the number all the retry assertions are written against.
    // Identified by the gate's own distinctive Accept header, NOT by the path alone:
    // the policy-seam tests below legitimately fetch a /robots.txt URL as their
    // TARGET (the transport treats no path specially), and a path-only check would
    // swallow their scripted responses.
    if (String(_url).endsWith("/robots.txt") && headerValue(init?.headers, "accept") === "text/plain, */*;q=0.1") {
      state.robotsCalls++;
      return robots();
    }
    // Clamped so the script never runs off its own end.
    const index = Math.min(state.calls, responses.length - 1);
    // Incremented before the thunk runs, so a thunk that throws is still counted as an
    // attempt — otherwise an exhaustion count would silently undercount.
    state.calls++;
    // Recorded so header/signal assertions can inspect what was actually sent rather
    // than trusting that the options object reached fetch intact.
    state.inits.push(init);
    const make = responses[index];
    // `noUncheckedIndexedAccess` makes this possibly-undefined; an empty script is a
    // bug in the test itself and should say so loudly rather than throw a TypeError.
    if (make === undefined) throw new Error("stubFetch: empty response script");
    // Called fresh each time rather than reusing a Response object: a Response body is
    // a one-shot stream, so a shared instance would fail on the second read with an
    // error that looks like a bug in the transport rather than in this harness.
    return make();
  }) as unknown as typeof fetch;
  return state;
}

// Make `fetch` throw, simulating DNS failure / connection refused / an abort.
//
// Separate from stubFetch because a THROWN fetch and a failing STATUS travel different
// paths through the loop, and conflating them in one helper would let a test intending
// to exercise one accidentally exercise the other.
function stubFetchThrowing(error: Error): { calls: number } {
  const state = { calls: 0 };
  globalThis.fetch = (async (_url: string | URL | Request) => {
    // The gate's robots fetch must still SUCCEED (404 = no policy = allow) so these
    // tests keep exercising the TARGET's network failure. Letting the robots fetch
    // throw too would turn every one of them into a robots 'indeterminate' refusal and
    // the network-error paths under test would never run.
    if (String(_url).endsWith("/robots.txt")) return new Response("", { status: 404 });
    // Counted so the fail-fast assertion can prove exactly one attempt was made.
    state.calls++;
    throw error;
  }) as unknown as typeof fetch;
  return state;
}

// `RequestInit["headers"]` is a union of three shapes, and a test that only handles the
// object literal silently passes against code that used a `Headers` instance. Stolen
// from upstream's user-agent test, where it is the genuinely reusable part.
function headerValue(headers: RequestInit["headers"], name: string): string | null {
  if (headers instanceof Headers) return headers.get(name);
  if (Array.isArray(headers)) {
    const found = headers.find(([key]) => key === name);
    return found ? String(found[1]) : null;
  }
  const value = (headers as Record<string, string> | undefined)?.[name];
  return typeof value === "string" ? value : null;
}

describe("the four contract invariants", () => {
  test("retries a 429 and succeeds on the next attempt (I2)", async () => {
    // Instant timers because this test sleeps once, for the real 500ms base delay.
    // Without the stub the suite pays that cost for no added confidence.
    instantTimers();
    // A two-entry script: refuse once, then succeed. This is the minimum shape that
    // distinguishes "retries" from "never retries" AND from "retries forever".
    const state = stubFetch([
      () => new Response("", { status: 429 }),
      () => new Response('{"ok":true}', { status: 200 }),
    ]);

    // Driven through httpJson rather than httpFetch so the body actually gets parsed —
    // a retry that returned a consumed or wrong response would pass a status-only check.
    const body = await httpJson<{ ok: boolean }>("https://example.test/x");
    // The success body reached the caller intact, proving the retry returned the SECOND
    // response rather than a stale handle on the first.
    assert.equal(body?.ok, true);
    // Exactly two: the 429 and the success. A third would mean we retried past a 200.
    assert.equal(state.calls, 2);
  });

  test("does not retry a plain 4xx (I3)", async () => {
    // Deliberately NO instantTimers here. If the implementation ever started retrying a
    // 400, this test would not merely fail — it would hang on the real backoff, which
    // is a louder signal than a wrong number.
    const state = stubFetch([() => new Response("", { status: 400 })]);

    // Matched on /400/ rather than on the error class, because the status reaching the
    // message is itself part of the contract — a caller reading a log needs it inline.
    await assert.rejects(httpFetch("https://example.test/x"), /400/);
    // Asserted AFTER the rejection settles: reading the counter first would sample a
    // half-finished loop.
    assert.equal(state.calls, 1);
  });

  test("gives up after the initial attempt plus six retries on a persistent 5xx (I1)", async () => {
    // Six real sleeps totalling ~24s without this. The instant stub is what makes
    // asserting the full budget affordable at all.
    instantTimers();
    // ONE entry, repeated forever by the stub's index clamp. Listing 500 seven times
    // would let a wrong budget hide behind a coincidentally matching script length.
    const state = stubFetch([() => new Response("", { status: 500 })]);

    await assert.rejects(httpFetch("https://example.test/x"), /500/);
    // SEVEN, not eight. 1 initial + 6 retries. This is the number most likely to drift
    // if someone "tidies" the loop bounds.
    assert.equal(state.calls, 7);
  });

  test("passes an AbortSignal to fetch on every attempt (I6)", async () => {
    instantTimers();
    // Two attempts so we can check the SECOND signal too — a signal hoisted out of the
    // loop would still satisfy a test that only inspected the first.
    const state = stubFetch([
      () => new Response("", { status: 503 }),
      () => new Response("{}", { status: 200 }),
    ]);

    await httpFetch("https://example.test/x");
    // Guards the assertions below: if only one call happened, the second index would be
    // undefined and `instanceof` would report a confusing failure instead of this one.
    assert.equal(state.calls, 2);
    assert.ok(state.inits[0]?.signal instanceof AbortSignal, "attempt 1 carries a signal");
    assert.ok(state.inits[1]?.signal instanceof AbortSignal, "attempt 2 carries a signal");
    // THE NON-VACUITY TWIN. A signal hoisted above the loop would pass both assertions
    // above while being the exact bug invariant I6 exists to prevent, because the same
    // object would be reused. Distinct instances prove a fresh timeout per attempt.
    assert.notEqual(state.inits[0]?.signal, state.inits[1]?.signal);
  });
});

describe("the backoff schedule (I4, I5)", () => {
  test("doubles from 500ms, adds jitter, and caps at 8000ms", async () => {
    const timers = instantTimers();
    stubFetch([() => new Response("", { status: 500 })]);

    await assert.rejects(httpFetch("https://example.test/x"), /500/);

    // Six sleeps for seven attempts — the last attempt does not sleep before giving up.
    assert.equal(timers.delays.length, 6);

    // Ranges rather than exact equality, because jitter is random. Each window is
    // [base, base + 500): its lower bound proves the doubling, its width proves the
    // jitter is ADDITIVE (I5) rather than multiplicative — a multiplied jitter would
    // scale the window with the delay and blow past these bounds at 8000.
    const expected: Array<[number, number]> = [
      [500, 1000],
      [1000, 1500],
      [2000, 2500],
      [4000, 4500],
      [8000, 8500],
      [8000, 8500],
    ];
    for (let i = 0; i < expected.length; i++) {
      const window = expected[i];
      const actual = timers.delays[i];
      // Both are possibly-undefined under noUncheckedIndexedAccess. Throwing rather
      // than asserting gives a clearer failure than a comparison against undefined,
      // which reports as `false !== true` and names neither side.
      if (window === undefined || actual === undefined) throw new Error("schedule length mismatch");
      // The message interpolates the actual value, because "expected true, got false"
      // on a range check tells a future reader nothing about which delay drifted.
      assert.ok(
        actual >= window[0] && actual < window[1],
        `delay ${i} was ${actual}, expected [${window[0]}, ${window[1]})`,
      );
    }
    // The last two windows being identical is the CAP assertion (I4): unbounded
    // doubling would have produced 16000 on the sixth sleep.
  });
});

describe("Retry-After handling — the highest-value addition over upstream", () => {
  test("a delta-seconds header overrides the computed 500ms backoff", async () => {
    // The recorded delays are the assertion surface here; the call count cannot
    // distinguish a 500ms sleep from a 2000ms one.
    const timers = instantTimers();
    // 2 seconds, chosen because it sits OUTSIDE the computed first window of
    // [500, 1000) — a value inside that window would prove nothing about which one won.
    stubFetch([
      () => new Response("", { status: 429, headers: { "retry-after": "2" } }),
      () => new Response("{}", { status: 200 }),
    ]);

    await httpFetch("https://example.test/x");
    // [2000, 2500) proves the header won: the computed first delay would have been in
    // [500, 1000), so any value in this window can only have come from the header.
    const first = timers.delays[0];
    assert.ok(first !== undefined && first >= 2000 && first < 2500, `got ${String(first)}`);
  });

  test("an HTTP-date header is converted to a delta rather than read as zero", async () => {
    const timers = instantTimers();
    // THE CASE THAT SILENTLY FAILS OPEN. `Number("Wed, 16 Sep...")` is NaN, and code
    // doing `Number(header) || 0` turns "wait until Wednesday" into "retry now".
    const threeSecondsOut = new Date(Date.now() + 3000).toUTCString();
    stubFetch([
      () => new Response("", { status: 503, headers: { "retry-after": threeSecondsOut } }),
      () => new Response("{}", { status: 200 }),
    ]);

    await httpFetch("https://example.test/x");
    const first = timers.delays[0];
    // Generous lower bound because toUTCString truncates to whole seconds and the
    // clock moves between constructing the header and parsing it.
    assert.ok(first !== undefined && first >= 2000 && first < 3600, `got ${String(first)}`);
  });

  test("refuses rather than clamps when the server asks for longer than the cap", async () => {
    const timers = instantTimers();
    const state = stubFetch([
      () => new Response("", { status: 429, headers: { "retry-after": "86400" } }),
    ]);

    // A typed error, not a generic one, so a scheduler can read `retryAfterMs` off it
    // and reschedule honestly instead of regexing the sentence.
    await assert.rejects(httpFetch("https://example.test/x"), RetryAfterTooLongError);
    // ONE call and ZERO sleeps. Clamping to the cap and trying again would be strictly
    // worse than giving up: waiting less than asked guarantees another 429.
    assert.equal(state.calls, 1);
    assert.equal(timers.delays.length, 0);
  });

  test("falls back to computed backoff on an unparseable header instead of crashing", async () => {
    const timers = instantTimers();
    stubFetch([
      () => new Response("", { status: 429, headers: { "retry-after": "soon-ish" } }),
      () => new Response("{}", { status: 200 }),
    ]);

    await httpFetch("https://example.test/x");
    // Back on the computed schedule. One malformed header from one board must not be
    // able to take down a run polling twenty others.
    const first = timers.delays[0];
    assert.ok(first !== undefined && first >= 500 && first < 1000, `got ${String(first)}`);
  });
});

describe("bot-protection detection — moved inside the loop", () => {
  test("a Cloudflare challenge served as 503 throws immediately instead of retrying", async () => {
    // Timers stubbed so that IF the implementation regressed into retrying, this test
    // fails fast on the count rather than hanging for 24 seconds first.
    const timers = instantTimers();
    // The realistic shape of a Cloudflare interstitial: the status is retryable, the
    // server header names the WAF, and the body carries upstream's signature phrase.
    const state = stubFetch([
      () =>
        new Response("<html><title>Just a moment...</title></html>", {
          status: 503,
          headers: { server: "cloudflare", "content-type": "text/html" },
        }),
    ]);

    // A distinct class, not a generic HttpError, so the Scout can route this to
    // "source unavailable" rather than treating it as a flaky board worth re-polling.
    await assert.rejects(httpFetch("https://example.test/x"), BotProtectionError);
    // THE WHOLE POINT OF THE IMPROVEMENT. 503 is retryable by status, so upstream —
    // which checked only 403 and only after its loop finished — would have made seven
    // requests here and reported a generic 503. One call, no sleeps.
    assert.equal(state.calls, 1);
    assert.equal(timers.delays.length, 0);
  });

  test("a genuine 503 with no challenge markers still retries normally", async () => {
    // THE NON-VACUITY TWIN. Without this, an implementation that treated EVERY 503 as
    // bot protection would pass the test above while destroying the retry behaviour
    // that is the module's main reason to exist.
    instantTimers();
    const state = stubFetch([
      () => new Response("upstream timeout", { status: 503, headers: { "content-type": "text/plain" } }),
      () => new Response("{}", { status: 200 }),
    ]);

    await httpFetch("https://example.test/x");
    assert.equal(state.calls, 2);
  });

  test("leaves the body readable for the caller after sniffing it", async () => {
    // The clone() discipline. Sniffing the original would hand the caller a consumed
    // stream, and the failure would appear as an unrelated "body already read" error
    // far from this code.
    const state = stubFetch([
      () =>
        new Response("not a challenge, just html", {
          status: 200,
          headers: { "content-type": "text/html" },
        }),
    ]);

    const text = await httpText("https://example.test/x");
    assert.equal(text, "not a challenge, just html");
    assert.equal(state.calls, 1);
  });
});

describe("404 handling is caller-chosen and never retried (I3)", () => {
  test("'throw' surfaces an HttpError", async () => {
    // The JSON-API callers' mode: a missing path means we built the wrong URL, which
    // is a bug the Scout should shout about rather than absorb.
    const state = stubFetch([() => new Response("", { status: 404 })]);
    // Asserted on the CLASS here rather than the message, because a caller branching on
    // 404-as-error will use `instanceof`, and that is the coupling worth pinning.
    await assert.rejects(httpFetch("https://example.test/x", { notFound: "throw" }), HttpError);
    // One call in every mode below too: whatever a 404 MEANS, it is never retryable.
    assert.equal(state.calls, 1);
  });

  test("'null' returns null so a deleted posting is a normal state", async () => {
    // The detail-lookup mode. A job that no longer exists is the system working, not
    // failing, and forcing that through a try/catch would be noise at every call site.
    const state = stubFetch([() => new Response("", { status: 404 })]);
    // Strict equality matters: `undefined` here would mean the loop fell out of its
    // bounds rather than deliberately returning the caller's chosen sentinel.
    assert.equal(await httpFetch("https://example.test/x", { notFound: "null" }), null);
    assert.equal(state.calls, 1);
  });

  test("'empty' returns an empty string so a text parser reads zero results", async () => {
    // linkedin's upstream shape. Driven through httpText because "" is a text-shaped
    // answer that has no meaning for a Response or for JSON — which is why this mode
    // resolves in the text wrapper rather than in the core loop.
    const state = stubFetch([() => new Response("", { status: 404 })]);
    assert.equal(await httpText("https://example.test/x", { notFound: "empty" }), "");
    assert.equal(state.calls, 1);
  });

  test("defaults to 'throw' when the caller has not thought about it", async () => {
    // The conservative default: an unconsidered 404 becomes an error the caller must
    // notice, not a silent null it may not handle.
    stubFetch([() => new Response("", { status: 404 })]);
    // No `notFound` passed at all — this is the whole point of the test.
    await assert.rejects(httpFetch("https://example.test/x"), HttpError);
  });
});

describe("network failure fails fast by default", () => {
  test("a thrown fetch is wrapped and not retried", async () => {
    // TypeError is what both runtimes actually throw for a DNS failure, so the test
    // exercises the real shape rather than a synthetic Error subclass.
    const state = stubFetchThrowing(new TypeError("dns lookup failed"));

    // Wrapped in NetworkError rather than propagated raw: a bare TypeError from deep
    // inside fetch tells a caller nothing about WHICH host failed, and the Scout polls
    // many.
    await assert.rejects(httpFetch("https://example.test/x"), NetworkError);
    // One attempt. An unreachable host should drop out of the run quickly rather than
    // hold a seven-attempt budget open — upstream freehire's graceful-degradation rule.
    assert.equal(state.calls, 1);
  });

  test("retries a thrown fetch only when explicitly opted in", async () => {
    // Needed because the opt-in path DOES sleep between attempts.
    instantTimers();
    const state = stubFetchThrowing(new TypeError("connection refused"));

    // maxRetries trimmed to 2 so the assertion below names a small, obviously-correct
    // number instead of restating the default budget in a test about a different flag.
    await assert.rejects(
      httpFetch("https://example.test/x", { retry: { retryOnNetworkError: true, maxRetries: 2 } }),
      NetworkError,
    );
    // 1 initial + 2 retries. Proves the flag is wired to the same budget the status
    // path uses rather than to a second, private one.
    assert.equal(state.calls, 3);
  });
});

describe("the retry policy is injectable — the seam master-robots needs", () => {
  test("a 429-only policy does NOT retry a 5xx", async () => {
    // THE ROBOTS GATE'S CASE, tested here rather than there because this is where the
    // mechanism lives. Under RFC 9309 a 5xx on robots.txt is a MEANINGFUL answer
    // ("unavailable", which a crawler may treat as complete disallow), not a transient
    // error to grind past — so the gate injects a predicate that excludes it.
    // No instantTimers on purpose: under the injected policy nothing should sleep, so
    // a regression that resumed retrying would hang instead of merely miscounting.
    const state = stubFetch([() => new Response("", { status: 500 })]);

    // The URL is a robots.txt to document the caller this seam exists for; the
    // transport itself does not treat that path specially.
    await assert.rejects(
      httpFetch("https://example.test/robots.txt", {
        retry: { isRetryableStatus: (status) => status === 429 },
      }),
      /500/,
    );
    // One call, where the default policy would have made seven.
    assert.equal(state.calls, 1);
  });

  test("the same policy still retries a 429", async () => {
    // The twin: proving the predicate narrowed the behaviour rather than disabling it.
    // Without this, an injected predicate that always returned false would pass the
    // test above while silently removing retries the robots gate still wants.
    instantTimers();
    const state = stubFetch([
      () => new Response("", { status: 429 }),
      () => new Response("{}", { status: 200 }),
    ]);

    // maxRetries 1 keeps the budget minimal — this test is about WHICH statuses
    // retry, not about how many times.
    await httpFetch("https://example.test/robots.txt", {
      retry: { isRetryableStatus: (status) => status === 429, maxRetries: 1 },
    });
    // Two: the 429 and the success that followed it.
    assert.equal(state.calls, 2);
  });
});

describe("identity", () => {
  test("sends the honest User-Agent on every request", async () => {
    // Identifying ourselves is a compliance obligation, not a nicety: constraint #5
    // forbids disguising the client, and a request with no UA at all gets a runtime
    // default that reads as an anonymous scraper to the board operator.
    const state = stubFetch([() => new Response("{}", { status: 200 })]);

    await httpFetch("https://example.test/x");
    // Asserted against the exported constant rather than a duplicated literal, so a
    // deliberate change to our identity updates one place and this test follows.
    assert.equal(headerValue(state.inits[0]?.headers, "User-Agent"), DEFAULT_USER_AGENT);
  });

  test("a caller's extra headers do not clobber the User-Agent", async () => {
    // The realistic failure: a caller adds linkedin's Accept-Language and, depending on
    // spread order, silently drops our identity along the way.
    const state = stubFetch([() => new Response("{}", { status: 200 })]);

    await httpFetch("https://example.test/x", { headers: { "Accept-Language": "en-IN" } });
    // The caller's header did arrive — without this the test could pass by ignoring
    // caller headers entirely, which would be a different bug.
    assert.equal(headerValue(state.inits[0]?.headers, "Accept-Language"), "en-IN");
    // The spread-ordering assertion. Our identity header is written last precisely so a
    // caller cannot remove it by accident.
    assert.equal(headerValue(state.inits[0]?.headers, "User-Agent"), DEFAULT_USER_AGENT);
  });
});

// --- THE ROBOTS GATE (on by default) -------------------------------------------------------
// Closes docs/robots/2026-09-17-robots-gate-first-caller.md §6.1: the Deno-side fetch paths
// were ungated — scout-web called checkRobots by convention, and a convention each caller
// must remember is a comment, not a control. The gate now lives inside httpFetch itself.
// Each test passes its own RobotsCache: the transport's module-level default cache outlives
// a test, and a verdict cached for an origin in one test would short-circuit the next.
describe("robots gate", () => {
  // A fresh, isolated verdict cache per test — see the describe comment.
  const freshCache = (): { robots: { cache: RobotsCache } } => ({ robots: { cache: new Map() } });

  // A real, well-formed policy that forbids /private and allows everything else, served
  // the way a live host would: 200 text/plain.
  const policy = () =>
    new Response("User-agent: *\nDisallow: /private", { status: 200, headers: { "content-type": "text/plain" } });

  test("REGRESSION: refuses a URL whose robots.txt disallows the path, without contacting the target", async () => {
    // Script would answer the target if it were ever asked; the point is that it is not.
    const state = stubFetch([() => new Response("{}", { status: 200 })], policy);
    // The typed refusal, so callers can branch on it rather than regex a message.
    await assert.rejects(
      httpFetch("https://example.test/private/page", freshCache()),
      RobotsDisallowedError,
    );
    // THE LOAD-BEARING ASSERTION: the disallowed target was never fetched at all.
    assert.equal(state.calls, 0);
    // Non-vacuity: the gate really did consult robots.txt (zero would mean the test
    // passed by some other refusal, not by the policy).
    assert.equal(state.robotsCalls, 1);
  });

  test("an allowed path under the same policy still goes through", async () => {
    const state = stubFetch([() => new Response("ok", { status: 200 })], policy);
    // /public is not matched by `Disallow: /private`, so the fetch proceeds normally.
    const response = await httpFetch("https://example.test/public/page", freshCache());
    // The target answered: the gate blocks only what the policy forbids, nothing else.
    assert.equal(response?.status, 200);
    assert.equal(state.calls, 1);
  });

  test("a malformed robots response (soft-200 HTML error page) fails CLOSED", async () => {
    // The canonical fail-open (CLAUDE.md §6): a host that serves an HTML error shell
    // with status 200. A lenient reader parses it as "zero rules" and allows everything.
    const state = stubFetch(
      [() => new Response("{}", { status: 200 })],
      () => new Response("<html><body>Oops, something went wrong</body></html>", { status: 200, headers: { "content-type": "text/html" } }),
    );
    const outcome = await httpFetch("https://example.test/anything", freshCache()).then(
      () => null,
      // Caught rather than assert.rejects so the error's FIELDS can be asserted below.
      (err: unknown) => err,
    );
    // Refused, with the machine-readable source naming the soft-200 specifically.
    assert.ok(outcome instanceof RobotsDisallowedError);
    assert.equal(outcome.verdict, "refuse");
    assert.equal(outcome.source, "not-robots-txt");
    // And the target was never contacted.
    assert.equal(state.calls, 0);
  });

  test("a User-Agent no product token can be derived from fails closed, before any network call", async () => {
    // A garbage UA would otherwise silently match robots groups as "*" — the exact
    // fail-open tokenFromUserAgentHeader exists to refuse.
    const state = stubFetch([() => new Response("{}", { status: 200 })], policy);
    await assert.rejects(
      httpFetch("https://example.test/x", { userAgent: "???", ...freshCache() }),
      RobotsDisallowedError,
    );
    // Neither the target NOR robots.txt was fetched: the refusal is pre-network.
    assert.equal(state.calls, 0);
    assert.equal(state.robotsCalls, 0);
  });

  test("robots: false opts out — no robots fetch is made", async () => {
    // The documented escape hatch for a non-crawl caller; today only tests use it.
    const state = stubFetch([() => new Response("ok", { status: 200 })], policy);
    const response = await httpFetch("https://example.test/private/page", { robots: false });
    // The otherwise-disallowed path went through, and robots.txt was never asked.
    assert.equal(response?.status, 200);
    assert.equal(state.robotsCalls, 0);
  });

  test("the verdict is cached per origin: two calls, one robots fetch", async () => {
    const state = stubFetch([() => new Response("ok", { status: 200 })], policy);
    // One cache shared across both calls, as the module-level default would be.
    const shared = freshCache();
    await httpFetch("https://example.test/public/a", shared);
    await httpFetch("https://example.test/public/b", shared);
    // Two target fetches, but the policy was fetched once and the verdict reused.
    assert.equal(state.calls, 2);
    assert.equal(state.robotsCalls, 1);
  });
});

// The redirect branch: a caller that asks for `redirect: "manual"` must get the 3xx back
// to read Location itself (job-link-intake re-checks every hop against its SSRF guard).
// Both directions are pinned: manual returns the 3xx, the default still throws on it.
describe("redirect: 'manual' returns a 3xx instead of throwing", () => {
  test("manual mode hands the 302 and its Location back to the caller", async () => {
    // The hop the caller must re-check; a fixed value so the header read can be compared exactly.
    const next = "https://example.test/next";
    // One scripted 302 carrying Location: the shape a real server sends for a moved page.
    const state = stubFetch([() => new Response(null, { status: 302, headers: { location: next } })]);
    // Called with manual mode, which is the only switch that should turn a 3xx into an answer.
    const response = await httpFetch("https://example.test/start", { redirect: "manual" });
    // The 3xx itself came back, not a thrown HttpError and not a followed 200.
    assert.equal(response?.status, 302);
    // Location survived the trip: it is the whole reason the caller asked for manual mode.
    assert.equal(response?.headers.get("location"), next);
    // Exactly one target attempt: a 3xx is an answer, so it must never enter the retry loop.
    assert.equal(state.calls, 1);
    // The option reached fetch itself; otherwise a real runtime would follow the hop unseen.
    assert.equal(state.inits[0]?.redirect, "manual");
  });

  test("the default (follow) mode still throws HttpError on a 302 that reaches it", async () => {
    // A stubbed fetch does not follow redirects, so this 302 stands in for a hop the runtime
    // could not resolve; the new branch must not have widened what counts as success.
    stubFetch([() => new Response(null, { status: 302, headers: { location: "https://example.test/next" } })]);
    // No `redirect` option at all: the default path is exactly what is under test.
    await assert.rejects(httpFetch("https://example.test/start"), (err: unknown) => {
      // Class check first, because callers branch on `instanceof HttpError`.
      assert.ok(err instanceof HttpError);
      // The status is carried through, so a caller can tell a redirect failure from a 4xx/5xx.
      assert.equal(err.status, 302);
      // A validator must return true for assert.rejects to accept the rejection.
      return true;
    });
  });
});
