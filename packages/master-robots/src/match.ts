// Selecting the group that addresses us, and deciding whether a path is permitted.
//
// EVERY BUG IN THIS FILE IS A PERMISSION GRANT. A rule that fails to match does not
// produce an error — it produces "no rule applies", which is allow. So a matcher
// that silently under-matches IS the fail-open, and nothing throws to warn you. That
// is why the tests around this module assert refusals in pairs: one proving the
// refusal happens, one proving it is not simply constant.
import type { GroupSelection, RobotsGroup, Ruleset } from './types.ts';

// The wildcard group's key, as written in robots.txt.
const WILDCARD = '*';

/**
 * Extract the RFC 9309 product token from a full User-Agent header.
 *
 * WHY THIS EXISTS AT ALL. RFC 9309 matches the PRODUCT TOKEN (`applyy-scout`), not
 * the header (`applyy-scout/1.0 (+https://github.com/MallamTeja/applyyy)`). Hand the
 * header to selectGroup() and every named-group comparison fails, selection falls
 * through to the wildcard, and NOTHING THROWS — a silent fail-open that no test
 * catches unless someone writes it deliberately. This helper exists so a caller
 * holding only a header has a correct way down to a token.
 *
 * Returns null rather than a guess: a guessed token would reintroduce the exact
 * fail-open this function was written to close.
 */
export function tokenFromUserAgentHeader(header: string): string | null {
  // The token is everything before the first `/` or whitespace.
  const candidate = header.trim().split(/[/\s]/, 1)[0] ?? '';
  // An empty result means the header began with a separator or was blank, and there
  // is no honest token to report.
  if (candidate === '') return null;
  // A token is a product name; anything else is not something we can match a group
  // against, so the caller is told rather than handed a plausible-looking string.
  if (!/^[A-Za-z][A-Za-z0-9._-]*$/.test(candidate)) return null;
  return candidate.toLowerCase();
}

/**
 * Find the group that applies to `productToken`.
 *
 * Returns null when the file addresses neither this token nor `*` — which is a
 * DIFFERENT FACT from an empty group, and is kept distinct so "nobody addressed us"
 * cannot be mistaken for "we were addressed and permitted".
 */
export function selectGroup(ruleset: Ruleset, productToken: string): GroupSelection | null {
  // Tokens are stored lowercased by the parser, so the lookup folds to match.
  const token = productToken.trim().toLowerCase();
  // A group written for us specifically.
  const exact = ruleset.groups.get(token);
  // RFC 9309: the most specific group wins OUTRIGHT and the wildcard is not merged
  // in. Merging would let a permissive `*` block soften a restriction written for us
  // by name, which inverts the site's clear intent.
  if (exact !== undefined) return { matchedToken: token, group: exact };
  // Falling back to the wildcard is correct only after the specific lookup failed.
  const wildcard = ruleset.groups.get(WILDCARD);
  if (wildcard !== undefined) return { matchedToken: WILDCARD, group: wildcard };
  // No applicable group. The caller decides what that means; this module will not
  // invent an empty group, because an empty group asserts something this file did
  // not observe.
  return null;
}

// Compile one robots.txt pattern to a regular expression anchored at the path start.
//
// ESCAPING IS LOAD-BEARING IN BOTH DIRECTIONS. Leaving a metacharacter unescaped
// makes a rule match MORE than the site wrote — over-blocking, survivable — but an
// unescaped `(` or `[` throws at construction and would crash the gate on a
// perfectly legal robots.txt. Only `*` and a trailing `$` carry meaning.
function patternToRegExp(pattern: string): RegExp {
  // Built character by character because the two wildcards must survive escaping
  // while everything around them is neutralised.
  let source = '^';
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i] ?? '';
    // `*` means any run of characters, including none.
    if (char === '*') {
      source += '.*';
      continue;
    }
    // `$` anchors ONLY as the final character. Elsewhere it is a literal dollar in a
    // path, and treating it as an anchor mid-pattern would truncate the rule and
    // make it match far more than intended.
    if (char === '$' && i === pattern.length - 1) {
      source += '$';
      continue;
    }
    // Everything else is literal. The class covers every RegExp metacharacter, so a
    // pattern containing one cannot change the shape of the expression or throw.
    source += char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(source);
}

// Percent-decode a pattern or path, falling back to the original on malformed input.
//
// WHY DECODE: without it, a site that percent-encodes its own Disallow patterns has
// them silently skipped — `Disallow: /foo%20bar` never matches `/foo bar`, the rule
// simply never fires, and the path reads as unrestricted. A fail-open on any site
// careful enough to encode its rules, which is the wrong population to punish.
//
// WHY THE FALLBACK: decodeURIComponent throws on a lone `%`, and a throw here would
// take down the gate on malformed input — which would be a crash, not a refusal.
function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    // Undecodable input is compared as written; matching too little here is caught
    // by the rule below that an unmatched path is only allowed after a real parse.
    return value;
  }
}

/**
 * Decide whether `path` is permitted by `group`.
 *
 * `path` should be the URL path plus query, already percent-decoded or not — it is
 * normalised here either way.
 */
export function isPathAllowed(group: RobotsGroup, path: string): boolean {
  // Both sides are decoded so an encoded rule and a decoded path meet in one space.
  const target = safeDecode(path);
  // Length of the longest pattern matched so far; -1 means nothing has matched.
  let bestLength = -1;
  // The verdict carried by that longest match. Irrelevant while bestLength is -1.
  let bestAllow = true;

  for (const rule of group.rules) {
    // The pattern as the site meant it, in the same space as `target`.
    const pattern = safeDecode(rule.pattern);
    // An empty pattern is not a rule; the parser drops these, and this is belt and
    // braces against a future caller constructing a group by hand.
    if (pattern === '') continue;
    // A non-matching rule says nothing about this path.
    if (!patternToRegExp(pattern).test(target)) continue;
    // Specificity is pattern length, which is RFC 9309's rule.
    const length = pattern.length;
    // A strictly longer match is more specific and wins outright.
    if (length > bestLength) {
      bestLength = length;
      bestAllow = rule.allow;
      continue;
    }
    // AN EQUAL-LENGTH TIE RESOLVES TO DISALLOW. DELIBERATELY STRICTER THAN RFC 9309,
    // which resolves a tie to the least restrictive rule. Kept from upstream as the
    // cautious reading: when a site has written two equally specific rules that
    // contradict each other, its intent is genuinely ambiguous, and resolving an
    // ambiguity in our own favour is the wrong way to be wrong. Costs us access to
    // a path the site may not have meant to block; the alternative costs the site a
    // crawl it explicitly tried to prevent.
    if (length === bestLength && !rule.allow) bestAllow = false;
  }

  // No rule matched, so the site placed no restriction on this path. Safe ONLY
  // because reaching this function at all required a shape-validated robots.txt —
  // an unparsed or unreadable file never produces a group to pass in here.
  if (bestLength === -1) return true;
  return bestAllow;
}
