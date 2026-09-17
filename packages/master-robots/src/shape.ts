// THE SOFT-200 DEFENCE. This module answers exactly one question — "is this body a
// robots.txt at all?" — and it answers it BEFORE any parsing happens.
//
// WHY IT IS A SEPARATE MODULE RATHER THAN A CHECK INSIDE THE PARSER. A parser is
// lenient by construction: it skips what it does not recognise and returns what it
// found. Ask a lenient parser whether it failed and it will say no, because finding
// nothing is not failing. So the guard cannot live downstream of parsing — by then
// an HTML error page and a permissive policy are the same value: zero rules.
//
// DELIBERATE DIVERGENCE FROM UPSTREAM, and the reason is measured rather than
// argued. reference/ai-job-search-upstream/tools/robots_check.py defends the same
// hole with is_robots_body(), which asks "does any line look like a directive?".
// Run on 2026-09-17 against five bodies, it returned:
//     comments only  -> False
//     HTML error page -> False
// Those two must not share a verdict. A robots.txt whose rules are all commented out
// is a VALID file that permits everything, and worker/scripts/capture-fixture.ts:31
// records exactly such a host — job-boards.greenhouse.io — as human-verified
// permitted on 2026-09-09. Porting upstream's rule verbatim would refuse a host we
// have already confirmed allows us. That is not caution; it is a false negative on a
// published, permissive policy.
//
// SO THE DISCRIMINATOR IS SYNTAX, NOT RULE COUNT: every non-blank, non-comment line
// must be a well-formed `field: value` directive. A commented-out file has no such
// lines and passes vacuously, which is correct and is the ONE vacuous pass in this
// package — RFC 9309 genuinely says an empty ruleset permits everything. An HTML
// page has many lines that are not directives and fails on the first.
//
// Upstream also contradicts itself here and we should not inherit the bug: its own
// allowed() treats a comments-only body as allow-all, while is_robots_body() rejects
// that same body before allowed() is ever consulted, so its gate() only ever sees
// the strict half. Recorded in docs/robots/2026-09-17-robots-gate-design.md.

// The verdict this module produces. TWO ARMS WITH DIFFERENT SHAPES, on purpose: the
// accepting arm carries no `reason`, so a caller cannot branch on the truthiness of a
// field that exists on both and quietly stop reading the discriminant.
export type BodyShape =
  // The body is robots.txt syntax and may be handed to the parser. It may still
  // contain zero rules — legitimately, which is why this arm exists at all.
  | { readonly kind: 'robots-txt' }
  // The body is not robots.txt. It must NEVER become a ruleset, empty or otherwise.
  | { readonly kind: 'not-robots-txt'; readonly reason: string };

// Hard ceiling on a body we are willing to look at. The gate runs before every
// outbound fetch, so an unbounded read hands any host a cheap way to stall the whole
// pipeline. Google enforces 500 KiB on robots.txt, so this is generous rather than
// strict, and a real policy is three orders of magnitude smaller.
export const MAX_ROBOTS_BYTES = 512 * 1024;

// Content types that prove the body is not a robots.txt whatever it contains. Kept
// as prefixes because a real header arrives as `text/html; charset=utf-8` and
// comparing the whole string would miss every host that sends parameters.
const DISQUALIFYING_TYPE_PREFIXES = ['text/html', 'application/xhtml', 'application/xml', 'text/xml'];

// A robots.txt field name: a letter followed by letters, digits, hyphen or
// underscore, then a colon. ANCHORED AT LINE START, which is what rejects
// `{"error":"not found"}` — that line has a colon, but `{"error"` is not a token, so
// a naive "contains a colon" check would have admitted a JSON error page.
const DIRECTIVE_LINE = /^[A-Za-z][A-Za-z0-9_-]*[ \t]*:/;

// The byte length of a string as it travelled the wire. `.length` counts UTF-16 code
// units, which under-counts multi-byte characters and would let a body several times
// over the cap slip past a naive check.
function byteLength(text: string): number {
  // TextEncoder is present in Node 24, Deno and every browser, so no polyfill.
  return new TextEncoder().encode(text).length;
}

// Strip a leading UTF-8 byte order mark. A BOM is invisible in an editor, so a
// BOM-induced refusal is close to undiagnosable from the symptom alone — and hosts
// serving a BOM'd robots.txt are common enough to matter.
function stripBom(text: string): string {
  return text.startsWith('﻿') ? text.slice(1) : text;
}

/**
 * Decide whether `body` may be parsed as robots.txt.
 *
 * `contentType` is the raw response header, or null when the host sent none. Absent
 * is NOT treated as disqualifying: refusing on absence would refuse real hosts, and
 * the body checks below already catch what a missing header would have caught.
 */
export function classifyRobotsBody(body: string, contentType: string | null): BodyShape {
  // Size first, because every later step walks the string and a hostile body should
  // cost us one length check rather than a full scan.
  if (byteLength(body) > MAX_ROBOTS_BYTES) {
    return { kind: 'not-robots-txt', reason: `body exceeds ${MAX_ROBOTS_BYTES} bytes` };
  }

  // LAYER ONE — what the host SAYS it sent. Cheap, and decisive when present.
  if (contentType !== null) {
    // Normalise before comparing: headers arrive with arbitrary case and parameters.
    const normalised = contentType.trim().toLowerCase();
    // A markup content-type on /robots.txt is a misconfiguration or an error page in
    // every case we can construct, and in neither case is the body a policy.
    if (DISQUALIFYING_TYPE_PREFIXES.some((prefix) => normalised.startsWith(prefix))) {
      return { kind: 'not-robots-txt', reason: `content-type is ${normalised}, not a robots.txt` };
    }
  }

  // The BOM would otherwise defeat both the `<` probe and the directive regex.
  const text = stripBom(body);

  // LAYER TWO — what the body actually IS, independent of what the host claimed.
  // This layer exists because layer one is host-controlled: a server that mislabels
  // its error page as text/plain must still be caught.
  if (text.trimStart().startsWith('<')) {
    return { kind: 'not-robots-txt', reason: 'body begins with markup' };
  }

  // LAYER THREE — every line must be robots.txt syntax. This is the layer that
  // separates "no rules" from "not a robots file", which is the whole point.
  for (const rawLine of text.split(/\r?\n/)) {
    // Comments are stripped before judging the line, because a fully-commented file
    // is valid and must survive this loop. `#` is the only comment marker RFC 9309
    // defines, and it may begin a line or follow a directive.
    const line = rawLine.split('#', 1)[0]?.trim() ?? '';
    // A blank line — original, or left behind by a stripped comment — carries no
    // claim either way, so it neither qualifies nor disqualifies the body.
    if (line === '') continue;
    // A surviving line that is not a directive is the signal we are looking for: it
    // is content from some other format that happened to be served at this path.
    if (!DIRECTIVE_LINE.test(line)) {
      // The reason quotes the offending line, truncated, so an operator reading a log
      // can see WHAT arrived rather than only that something did.
      return { kind: 'not-robots-txt', reason: `line is not a directive: ${line.slice(0, 60)}` };
    }
    // An unrecognised FIELD is deliberately allowed through: RFC 9309 says to ignore
    // fields you do not know, and a future directive must not read as an error page.
  }

  // Every surviving line was a directive, or there were none. Both are robots.txt.
  return { kind: 'robots-txt' };
}
