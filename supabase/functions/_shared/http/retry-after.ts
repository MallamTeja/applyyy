// Parsing the `Retry-After` response header.
//
// WHY THIS IS ITS OWN MODULE rather than ten lines inside the retry loop: it is the
// one piece of the transport with a pure, total signature — string in, number or null
// out — and pulling it out means the wire-format edge cases can be tested exhaustively
// without standing up a fake server or driving the loop. The loop's tests then only
// have to prove that the loop USES this, not that it re-derives date arithmetic.
//
// UPSTREAM DOES NOT DO THIS AT ALL. All four copies ignore the header and always sleep
// their own computed backoff. That is exactly wrong against a server that has just
// told you how long to wait: sleeping 500ms when the server said 30s earns a harder
// rate-limit and can escalate to a ban. Honouring the header is the single highest-
// value thing this module adds over the code it was ported from.
//
// This also matches a rule the repo already committed to elsewhere — packages/shared-
// types/src/tables.ts says of the Gemini key pool: "believe its retry_after, move on"
// and "Believe the server; do not invent a backoff." Same principle, different
// protocol, so the transport should not invent a second philosophy.

// Parse a `Retry-After` value into milliseconds from now.
//
// Returns null for absent, empty, or unparseable input — the caller then falls back to
// its computed backoff. Never throws: a malformed header from one board must not be
// able to crash a Scout run that is polling twenty others.
export function parseRetryAfterMs(raw: string | null | undefined, nowMs: number): number | null {
  // Absent header is the common case and is not an error — most 429s carry no hint.
  if (raw === null || raw === undefined) return null;
  // Header values arrive with surrounding whitespace often enough to be worth one
  // trim; a value of "  120  " is plainly meant to be 120 and rejecting it would push
  // us onto the computed backoff for no reason.
  const value = raw.trim();
  // An empty or whitespace-only header is malformed, not "zero seconds". Treating it
  // as 0 would turn a broken header into an immediate retry, which is the opposite of
  // what the header exists to prevent.
  if (value === '') return null;

  // FORM 1 — delta-seconds, e.g. `Retry-After: 120`.
  //
  // Tested with an explicit digits-only regex rather than Number()/parseInt, because
  // both of those are too permissive here: Number(" 12 ") is 12, parseInt("12abc") is
  // 12, and Number("0x10") is 16. A header reading "12abc" is malformed and should
  // fall back to computed backoff, not be silently read as 12 seconds.
  if (/^\d+$/.test(value)) {
    // Seconds on the wire, milliseconds internally. The multiplication is the only
    // conversion in this module, kept here so no caller has to remember the unit.
    const seconds = Number(value);
    // Number() on a long digit string can exceed the safe integer range and go
    // imprecise. A delay that large is rejected by the caller's cap anyway, but
    // returning a non-finite value would make the comparison itself meaningless.
    if (!Number.isFinite(seconds)) return null;
    return seconds * 1000;
  }

  // FORM 2 — an HTTP-date, e.g. `Retry-After: Wed, 16 Sep 2026 07:28:00 GMT`.
  //
  // WHY THIS BRANCH EXISTS AND WHY IT IS EASY TO GET WRONG: this is the case that
  // silently becomes 0 or NaN if you only implement form 1. Number("Wed, 16 Sep...")
  // is NaN, and code that does `Number(header) || 0` turns a "wait until Wednesday"
  // into "retry immediately" — a fail-open that looks like it handled the header.

  // SHAPE CHECK BEFORE Date.parse, and it is load-bearing. `Date.parse` is far more
  // permissive than RFC 9110's date grammar: `Date.parse("-5")` is NOT NaN, it
  // resolves to a date in the year -5, which then floors to a delay of 0 — turning a
  // malformed header into "retry immediately". That is the precise fail-open this
  // module exists to prevent, and it was caught by a test rather than by reading.
  //
  // Every HTTP-date form carries a weekday and a month NAME, so requiring at least
  // one ASCII letter rejects numeric junk (`-5`, `+5`, `1.5`) while admitting every
  // legitimate date. Cheaper and harder to get wrong than a full grammar regex.
  if (!/[A-Za-z]/.test(value)) return null;

  const parsedMs = Date.parse(value);
  // Date.parse returns NaN for anything it cannot read. That is our unparseable
  // signal; fall back to computed backoff rather than guessing.
  if (Number.isNaN(parsedMs)) return null;

  // Convert the absolute instant into a delta against the caller's clock. `nowMs` is
  // injected rather than read from Date.now() inside so the tests can pin a date-form
  // header to an exact expected delay instead of racing the real clock.
  const deltaMs = parsedMs - nowMs;
  // Floored at zero: a date in the past means "you may retry now", not "travel
  // backwards". A negative delay passed to setTimeout fires immediately anyway, but
  // returning a negative number would make the caller's cap comparison nonsense — it
  // would compare as safely under any positive cap while meaning something else.
  return deltaMs > 0 ? deltaMs : 0;
}
