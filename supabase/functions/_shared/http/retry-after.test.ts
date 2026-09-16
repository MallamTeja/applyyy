// Tests for `Retry-After` parsing.
//
// WHY THIS FILE IS SEPARATE FROM transport.test.ts: the parser is the one piece of the
// transport with a pure, total signature, so its edge cases can be enumerated here
// without driving the retry loop at all. The loop's own tests then only have to prove
// it USES this parser, not that it re-derives date arithmetic — which is what keeps
// the loop's test file about the loop.
//
// THE CASE THIS FILE EXISTS FOR is the HTTP-date form. It is the one that silently
// fails open: `Number("Wed, 16 Sep 2026 07:28:00 GMT")` is NaN, and the very natural
// `Number(header) || 0` turns "wait until Wednesday" into "retry immediately" while
// looking like it handled the header.

import { describe, test } from "node:test";
// Strict, because `null` is a meaningful return here (unparseable → fall back to the
// computed backoff) and must never compare equal to a `0` that means "retry now".
import assert from "node:assert/strict";

import { parseRetryAfterMs } from "./retry-after.ts";

// A fixed clock. Injected rather than read inside the parser precisely so the date
// cases below assert an exact number instead of racing the real clock.
const NOW = Date.parse("2026-09-16T12:00:00.000Z");

describe("absent or malformed input falls back rather than crashing", () => {
  test("null returns null", () => {
    // The common case: most 429s carry no hint at all, and that is not an error.
    assert.equal(parseRetryAfterMs(null, NOW), null);
  });

  test("undefined returns null", () => {
    // `headers.get()` returns null, but a caller passing an optional property through
    // hands us undefined. Both are "absent".
    assert.equal(parseRetryAfterMs(undefined, NOW), null);
  });

  test("an empty header returns null rather than zero", () => {
    // Treating "" as 0 would turn a broken header into an immediate retry — the exact
    // fail-open this module exists to avoid.
    assert.equal(parseRetryAfterMs("", NOW), null);
  });

  test("a whitespace-only header returns null", () => {
    assert.equal(parseRetryAfterMs("   ", NOW), null);
  });

  test("a non-numeric, non-date header returns null", () => {
    assert.equal(parseRetryAfterMs("soon-ish", NOW), null);
  });
});

describe("delta-seconds form", () => {
  test("parses whole seconds into milliseconds", () => {
    assert.equal(parseRetryAfterMs("120", NOW), 120_000);
  });

  test("accepts zero as a real instruction to retry now", () => {
    // Distinct from null: the server explicitly said zero, which is not the same as
    // saying nothing. Strict equality is what keeps these two apart.
    assert.equal(parseRetryAfterMs("0", NOW), 0);
  });

  test("tolerates surrounding whitespace", () => {
    // "  120  " is plainly meant to be 120; rejecting it would push us onto the
    // computed backoff for no reason.
    assert.equal(parseRetryAfterMs("  120  ", NOW), 120_000);
  });

  test("rejects a trailing-garbage value instead of silently truncating it", () => {
    // THE REASON THIS USES A REGEX RATHER THAN parseInt. `parseInt("12abc")` is 12,
    // which would read a malformed header as a confident instruction. A header we
    // cannot fully understand should fall back, not be half-believed.
    assert.equal(parseRetryAfterMs("12abc", NOW), null);
  });

  test("rejects hex notation that Number() would happily accept", () => {
    // `Number("0x10")` is 16. A server sending that is broken, and guessing at 16
    // seconds would be inventing an instruction it never gave.
    assert.equal(parseRetryAfterMs("0x10", NOW), null);
  });

  test("rejects a negative delta rather than reading it as a past date", () => {
    // The digits-only regex excludes the minus sign, so this lands in the date branch
    // and fails there too. Asserted explicitly because "negative seconds" is the kind
    // of input a fuzzer finds and a reviewer does not.
    assert.equal(parseRetryAfterMs("-5", NOW), null);
  });
});

describe("HTTP-date form — the case that silently fails open", () => {
  test("converts a future date into a delta against the injected clock", () => {
    // 90 seconds after NOW, expressed the way a real server would.
    const future = new Date(NOW + 90_000).toUTCString();
    // toUTCString truncates to whole seconds, so the delta is exact here only because
    // NOW sits on a second boundary — which is why NOW was chosen that way.
    assert.equal(parseRetryAfterMs(future, NOW), 90_000);
  });

  test("floors a past date at zero rather than returning a negative", () => {
    // A negative delay fires immediately from setTimeout anyway, but returning one
    // would make the caller's cap comparison nonsense: it would compare as safely
    // under any positive cap while meaning something entirely different.
    const past = new Date(NOW - 60_000).toUTCString();
    assert.equal(parseRetryAfterMs(past, NOW), 0);
  });

  test("returns null for a date-shaped string that is not a date", () => {
    // `Date.parse` returns NaN, which is our unparseable signal. Without this branch
    // the NaN would propagate into a setTimeout and become an immediate retry.
    assert.equal(parseRetryAfterMs("Wed, 99 Xxx 2026 07:28:00 GMT", NOW), null);
  });
});
