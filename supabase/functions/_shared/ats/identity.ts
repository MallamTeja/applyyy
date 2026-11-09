// Board-identity verification — the guard against the watchlist fail-open found on
// 2026-10-23: greenhouse board token 'tcs' answers 200 with 92 real postings that
// belong to Thornbury Community Services (a UK healthcare firm), not Tata Consultancy
// Services. A mistyped or stale token silently harvests a STRANGER'S jobs, and every
// downstream stage (screener, matcher, tailor) then works on data that was never the
// company Teja asked for. The fix is to compare the identity the provider itself
// reports against the watchlist row's `company_name` BEFORE anything is persisted.
//
// WHY THIS LIVES IN `_shared/ats/` AND NOT IN THE SCOUT: three callers poll boards
// (scout-ats, the scheduled worker CLI, scout-web) and all of them route through
// these adapters. Identity extraction belongs beside parse so every caller gets the
// same answer from the same payload; each caller only has to act on the verdict.
//
// WHAT EACH PROVIDER CAN ACTUALLY TELL US (live probes, 2026-10-24):
//   greenhouse  `.jobs[].company_name` arrives in the SAME jobs response — free check
//   lever       NO company field exists anywhere in the postings payload — no check
//   ashby       top-level keys are only `jobs` + `apiVersion` — no check
// A provider with no signal gets `no_signal`, never a faked pass or fail: a guard
// that fires on healthy boards is worse than none (CLAUDE.md §6), and inventing an
// identity from a token echo (lever's hostedUrl just repeats the token back) would
// certify exactly the case the guard exists to catch.

// The adapter contract: `readReportedIdentity` is a REQUIRED method on it, so every
// future adapter is forced to declare its identity stance at compile time instead of
// silently landing in an unchecked default (same philosophy as `postedAtInput`).
import type { AtsAdapter } from "./types.ts";

// Legal/corporate suffix tokens that are presentation, not identity. "DoorDash, Inc."
// and "DoorDash" are the same employer; failing that board would be a false alarm.
// Deliberately SHORT: over-stripping ("technologies", "group") would collapse real
// distinct names into each other, which re-opens the hole in the other direction.
const LEGAL_SUFFIX_TOKENS: ReadonlySet<string> = new Set([
  // US corporate forms.
  "inc", "incorporated", "llc", "corp", "corporation", "co",
  // Commonwealth / EU forms.
  "ltd", "limited", "plc", "gmbh", "pvt", "pte",
]);

// Reduce a company name to comparable tokens: lowercase, punctuation out, legal
// suffixes out. Returns the token list — the comparison below needs tokens, not a
// joined string, so that containment respects token boundaries ("Ramp" must not
// match inside "Grampian").
function nameTokens(name: string): string[] {
  return name
    // One case for everything; identity is not case-sensitive.
    .toLowerCase()
    // Every non-alphanumeric run becomes one separator, so "DoorDash, Inc." and
    // "doordash inc" tokenize identically.
    .split(/[^a-z0-9]+/)
    // Splitting leaves empty fragments at punctuation edges; drop them.
    .filter((token) => token.length > 0)
    // Drop the legal-form noise words declared above.
    .filter((token) => !LEGAL_SUFFIX_TOKENS.has(token));
}

// True when every token of `subset` appears in `superset`. Multiplicity is ignored
// on purpose: names do not repeat meaningful tokens, and counting would add states
// without adding safety.
function tokensContained(subset: readonly string[], superset: readonly string[]): boolean {
  // Set membership gives token-BOUNDARY containment — the property that keeps a
  // short name from matching inside an unrelated longer word.
  const have = new Set(superset);
  // Every subset token must be present; one miss is a different company.
  return subset.every((token) => have.has(token));
}

// The lenient comparator. PASS: identical names, case/punctuation drift, a legal
// suffix, a qualifier one side adds ("DoorDash USA", "Notion Labs"), spacing drift
// ("Door Dash"). FAIL: any name whose tokens are not a subset either way — including
// the incident pair, where the only shared token is the generic word "services".
export function companyIdentityMatches(watchlistName: string, reportedName: string): boolean {
  // Tokenize both sides once.
  const watchlist = nameTokens(watchlistName);
  const reported = nameTokens(reportedName);
  // No tokens on either side means no evidence of identity — and no evidence can
  // never be a PASS, or blank garbage would wave every board through.
  if (watchlist.length === 0 || reported.length === 0) return false;
  // Spacing drift: "Door Dash" and "DoorDash" join to the same string. Checked on
  // the joined form because token sets alone cannot see it.
  if (watchlist.join("") === reported.join("")) return true;
  // Qualifier leniency, symmetric: the shorter spelling may live on EITHER side —
  // the watchlist may say "DoorDash USA" while the board says "DoorDash", or the
  // reverse — so containment is tested both ways.
  return tokensContained(watchlist, reported) || tokensContained(reported, watchlist);
}

// The per-board verdict, as a CLOSED UNION rather than a boolean-plus-string: a
// caller must switch on `verdict`, and there is no convenient flag that collapses
// "the provider could not say" into either pass or fail (CLAUDE.md §6).
export type BoardIdentityVerdict =
  // The provider reported a name and it agrees with the watchlist row.
  | { readonly verdict: "match"; readonly reported: string }
  // The provider reported a name and it is a DIFFERENT company. The caller must not
  // persist anything from this response.
  | { readonly verdict: "mismatch"; readonly reported: string }
  // The provider's payload carries no identity (lever, ashby, or an empty board).
  // The check is inapplicable — this is NOT a failure and must not count as one.
  | { readonly verdict: "no_signal"; readonly reason: string };

// Boards whose provider reports a name the comparator cannot link to the watchlist row, verified by hand to be
// the SAME board. Keyed by BOARD (provider + token + watchlist name), never by name alone: a name-only alias
// would let any other board claiming that name through, which is the wrong-board case this guard exists for.
// xai: greenhouse token "xai" reports "SpaceXSI" since the xAI/SpaceX merger; 253 of the 291 stored job ids were
// live on it (probe 2026-11-09). The watchlist name stays "xAI" because the fingerprint is built from it.
const BOARD_IDENTITY_ALIASES: readonly { readonly provider: string; readonly boardToken: string; readonly watchlistName: string; readonly reportedName: string }[] = [
  // The one verified case; add a row only with the same evidence (stored ids live on the board).
  { provider: "greenhouse", boardToken: "xai", watchlistName: "xAI", reportedName: "SpaceXSI" },
];

// Evaluate one board's response against its watchlist row. Pure and synchronous,
// like `parse`: no network, no clock, so it is testable against saved fixtures.
export function evaluateBoardIdentity(
  adapter: AtsAdapter,
  payload: unknown,
  watchlistCompanyName: string,
  // The watchlist row's token, which the board aliases need. Optional so a caller that does not pass it
  // (worker/src/cli/scout.ts until updated) gets no alias: it fails closed, exactly as before.
  boardToken?: string,
): BoardIdentityVerdict {
  // Ask the adapter what its provider says this board is. Null is the adapter's
  // declared "my provider offers no identity signal" (or "none in this payload").
  const reported = adapter.readReportedIdentity(payload);
  // No signal: the check cannot run. Say so, with the provider named, so a run
  // summary can show WHICH boards went unverified rather than implying all did.
  if (reported === null) {
    return { verdict: "no_signal", reason: `${adapter.provider}: payload carries no reported identity` };
  }
  // Signal present: the lenient comparison decides, and its two outcomes map onto
  // the two actionable verdicts.
  if (companyIdentityMatches(watchlistCompanyName, reported)) return { verdict: "match", reported };
  // A verified board alias: every field must match exactly, so one board and one reported name, nothing wider.
  const aliased = BOARD_IDENTITY_ALIASES.some((alias) =>
    // Same provider, same token, same watchlist row, and the exact name the board was verified to report.
    alias.provider === adapter.provider && alias.boardToken === boardToken && alias.watchlistName === watchlistCompanyName && alias.reportedName === reported);
  // The reported name is kept in the verdict either way, so a log shows what the board actually said.
  return aliased ? { verdict: "match", reported } : { verdict: "mismatch", reported };
}
