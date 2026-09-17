// The vocabulary of the gate. Everything load-bearing about this package's safety is
// a decision about which states are REPRESENTABLE, so the types live in one file
// where that set can be read at a glance.
//
// THE GOVERNING RULE: a wrong answer should be impossible to construct, not merely
// detected once constructed. Eight of the failures this package exists to prevent
// were missing or malformed data becoming an answer, and in every one of them the
// wrong value was trivially expressible. So the types below are deliberately
// awkward in the places where being casual would be dangerous.

// One Allow or Disallow line. `allow` rather than a string discriminant because
// there are exactly two kinds and there will never be a third.
export interface Rule {
  readonly allow: boolean;
  // The raw pattern as written by the site, still percent-encoded. Decoding happens
  // at match time so the original stays available for diagnostics.
  readonly pattern: string;
}

// The rules addressed to one user-agent token, plus that group's politeness window.
export interface RobotsGroup {
  readonly rules: readonly Rule[];
  // MILLISECONDS, or null meaning the site published none we could read. NEVER zero
  // for "unknown": zero reads as "no delay required", which would turn an
  // unparseable header into permission to hammer the host.
  readonly crawlDelayMs: number | null;
}

// A parsed robots.txt. Reachable ONLY from a body that passed the shape check in
// shape.ts — there is no other constructor — which is what makes an empty `groups`
// map safely mean "this site published a policy that restricts nobody" rather than
// "we could not read anything".
export interface Ruleset {
  // Keyed by lowercased product token, or '*' for the wildcard group.
  readonly groups: ReadonlyMap<string, RobotsGroup>;
}

// Which group applies to us, and which token selected it. The token is carried so a
// refusal can name its cause: a verdict that cannot say WHICH group refused is
// unauditable, and a test asserting only "not allowed" cannot tell a correct refusal
// from a refusal for the wrong reason.
export interface GroupSelection {
  readonly matchedToken: string;
  readonly group: RobotsGroup;
}

// WHAT THE HOST TOLD US when we asked for /robots.txt.
//
// THIS UNION IS THE HEART OF THE PACKAGE. Every arm is a DIFFERENT FACT, and several
// arms that share a verdict are still kept apart on purpose — collapsing two facts
// into one state is precisely how a later "simplification" flips a verdict without
// anyone noticing the semantics moved.
//
// Note especially that there is NO arm meaning "we got nothing, treat as empty". A
// body that failed the shape check becomes `not-robots-txt`; it never becomes a
// Ruleset, empty or otherwise. That is what makes the soft-200 unrepresentable
// rather than merely guarded against.
export type RobotsSource =
  // A real, shape-validated policy. May contain zero groups, legitimately.
  | { readonly kind: 'policy'; readonly ruleset: Ruleset }
  // 404 or 410. The host SUCCESSFULLY told us it publishes no policy. This is the
  // one arm that permits, and it is a definitive answer, not an absence of one.
  | { readonly kind: 'definitively-absent'; readonly status: number }
  // The host is actively refusing us: 401, 403, or a WAF challenge. Kept apart from
  // `indeterminate` because "you may not" and "I do not know" are opposite facts
  // that happen to share a verdict.
  | { readonly kind: 'refused-by-host'; readonly status: number }
  // We never learned the policy: timeout, DNS failure, connection reset, 5xx, or a
  // redirect we would not follow. Distinct from `definitively-absent` so nobody can
  // later merge the two into a single NOT_FETCHED and silently flip 404 to refuse.
  | { readonly kind: 'indeterminate'; readonly reason: string }
  // 200, but the body is not a robots.txt. The soft-200. Distinct from
  // `indeterminate` because a broken host and a dead host need different fixes.
  | { readonly kind: 'not-robots-txt'; readonly reason: string }
  // 429 with a Retry-After we could read and that is short enough to honour.
  | { readonly kind: 'rate-limited'; readonly retryAfterMs: number };

// THE ANSWER THE CALLER ACTS ON. A discriminated union, NOT a boolean, and
// deliberately carrying no convenience `allowed` field: the moment one exists every
// caller branches on it, the discriminant stops being read, and the distinctions
// above stop protecting anyone.
export type RobotsVerdict =
  // Proceed. `crawlDelayMs` is the politeness window the site asked for, or null if
  // it published none — the caller decides its own floor, this package does not
  // invent one.
  | { readonly kind: 'allow'; readonly reason: string; readonly crawlDelayMs: number | null }
  // Do not fetch. `reason` is for humans; `source` is the machine-readable fact.
  | { readonly kind: 'refuse'; readonly reason: string; readonly source: RobotsSource['kind'] }
  // Do not fetch YET. The host asked us to come back, and the wait is short enough
  // to be worth honouring rather than abandoning.
  | { readonly kind: 'wait'; readonly reason: string; readonly waitMs: number };
