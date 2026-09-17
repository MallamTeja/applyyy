// Parsing a robots.txt into groups, selecting the group that applies to us, and
// deciding whether a path is permitted.
//
// EVERY FAIL-OPEN IN THIS FILE HAS THE SAME SHAPE: a rule that should have matched
// did not, so the path fell through to "no rule applies" and was permitted. A
// matcher that silently fails to match IS a permission grant. That is why several
// tests below assert a REFUSAL — and why each of those has a paired test proving the
// refusal is not simply constant.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRobotsTxt } from '../src/parse.ts';
import { isPathAllowed, selectGroup, tokenFromUserAgentHeader } from '../src/match.ts';

// Evaluate a body the way the gate will: parse, select our group, test the path.
// A path with no applicable group is permitted, which is RFC 9309's rule and is safe
// ONLY because the caller has already proven the body is a real robots.txt.
function allows(body: string, productToken: string, path: string): boolean {
  const selection = selectGroup(parseRobotsTxt(body), productToken);
  return selection === null ? true : isPathAllowed(selection.group, path);
}

describe('parsing groups out of a robots.txt', () => {
  test('a blank line inside a record does not end the record', () => {
    // Python's robotparser drops rules here and fails open; upstream documents the
    // bug and works around it. Ported deliberately rather than rediscovered.
    const body = 'User-agent: *\n\nDisallow: /x\n';
    assert.equal(allows(body, 'anybot', '/x'), false);
  });

  test('several user-agent lines in a row share one ruleset', () => {
    // A common real-world shape. Attaching the rule to only the LAST agent silently
    // unrestricts the first, which is a fail-open with no symptom.
    const body = 'User-agent: a-bot\nUser-agent: b-bot\nDisallow: /z\n';
    // Both agents asserted, because attaching to only one is the exact bug.
    assert.equal(allows(body, 'a-bot', '/z'), false);
    assert.equal(allows(body, 'b-bot', '/z'), false);
  });

  test('a new user-agent after a rule starts a new group', () => {
    // Without this the second group's rules leak onto the first agent.
    const body = 'User-agent: a-bot\nDisallow: /a\nUser-agent: b-bot\nDisallow: /b\n';
    // Each agent must be unaffected by the OTHER's rule — asserted both ways so a
    // parser that merged the groups cannot pass on one direction alone.
    assert.equal(allows(body, 'a-bot', '/b'), true);
    assert.equal(allows(body, 'b-bot', '/a'), true);
  });

  test('comments are stripped from the end of a directive', () => {
    // If the comment stayed in the pattern, the rule would match nothing and the
    // path would read as unrestricted — a trailing comment becoming permission.
    const body = 'User-agent: *\nDisallow: /x  # nope\n';
    assert.equal(allows(body, 'anybot', '/x'), false);
  });

  test('an empty Disallow is not a rule and forbids nothing', () => {
    // `Disallow:` with no value is RFC 9309's explicit way to say "allow everything".
    // Treating it as a rule matching the empty prefix would block the entire site.
    assert.equal(allows('User-agent: *\nDisallow:\n', 'anybot', '/anything'), true);
  });

  test('a crawl-delay is captured per group in milliseconds', () => {
    // Published in SECONDS, stored in MILLISECONDS. Getting the unit wrong by 1000x
    // produces a politeness window that looks honoured and is not.
    const selection = selectGroup(parseRobotsTxt('User-agent: *\nCrawl-delay: 2\n'), 'anybot');
    // A group with only a crawl-delay and no rules must still exist to be selected.
    assert.notEqual(selection, null);
    assert.equal(selection?.group.crawlDelayMs, 2000);
  });

  test('an unparseable crawl-delay is null, meaning unknown, never zero', () => {
    // Zero would read as "no delay required" — a malformed header becoming a
    // permission to hammer the host. Same disease, different field.
    const selection = selectGroup(parseRobotsTxt('User-agent: *\nCrawl-delay: soon\n'), 'anybot');
    assert.equal(selection?.group.crawlDelayMs, null);
  });

  test('a negative crawl-delay is rejected rather than accepted as haste', () => {
    const selection = selectGroup(parseRobotsTxt('User-agent: *\nCrawl-delay: -5\n'), 'anybot');
    assert.equal(selection?.group.crawlDelayMs, null);
  });
});

describe('selecting the group that applies to our product token', () => {
  test('a named group is matched case-insensitively', () => {
    // RFC 9309 folds case on tokens. A case-sensitive comparison would miss the
    // group entirely and fall through to *, which is a silent permission grant.
    assert.equal(allows('User-agent: CLAUDEBOT\nDisallow: /x\n', 'claudebot', '/x'), false);
  });

  test('a named group beats the wildcard group even when the wildcard is laxer', () => {
    // RFC 9309: the most specific group wins outright — the wildcard is not merged in.
    const body = 'User-agent: mybot\nDisallow: /\n\nUser-agent: *\nAllow: /\n';
    assert.equal(allows(body, 'mybot', '/a'), false);
  });

  test('an unlisted agent falls back to the wildcard group', () => {
    const body = 'User-agent: someone-else\nDisallow: /\n\nUser-agent: *\nDisallow: /api\n';
    // We get the WILDCARD's restriction, not the other agent's blanket Disallow.
    assert.equal(allows(body, 'mybot', '/api'), false);
    // And the paired non-vacuity check: the other agent's `Disallow: /` must NOT
    // reach us, or this would pass for entirely the wrong reason.
    assert.equal(allows(body, 'mybot', '/jobs'), true);
  });

  test('selection reports which group matched, so a refusal can name its cause', () => {
    // A verdict that cannot say WHICH rule refused is unauditable, and the Lever
    // test depends on this field to prove it did not pass for the wrong reason.
    const body = 'User-agent: ClaudeBot\nDisallow: /\n';
    assert.equal(selectGroup(parseRobotsTxt(body), 'claudebot')?.matchedToken, 'claudebot');
  });

  test('a wildcard fallback reports * rather than the token we asked about', () => {
    const body = 'User-agent: *\nDisallow: /x\n';
    assert.equal(selectGroup(parseRobotsTxt(body), 'mybot')?.matchedToken, '*');
  });

  test('no applicable group at all reports null rather than an empty group', () => {
    // An empty group and no group are different facts; collapsing them would let
    // "nobody addressed us" be mistaken for "we were addressed and permitted".
    assert.equal(selectGroup(parseRobotsTxt('User-agent: other\nDisallow: /x\n'), 'mybot'), null);
  });
});

describe('the product token is not the User-Agent header — the silent fail-open', () => {
  test('a full header passed where a token belongs does NOT silently match the group', () => {
    // THE DISEASE IN ITS PUREST FORM. RFC 9309 matches the product token, not the
    // header. Pass 'applyy-scout/1.0 (+https://…)' where 'applyy-scout' is expected
    // and the group comparison fails, selection falls through to *, and NOTHING
    // THROWS. The caller gets a permissive answer and no test would catch it unless
    // someone thought to write this one. The parameter is named productToken for
    // exactly this reason.
    const body = 'User-agent: applyy-scout\nDisallow: /\n\nUser-agent: *\nAllow: /\n';
    const header = 'applyy-scout/1.0 (+https://github.com/MallamTeja/applyyy)';
    // The header does NOT match the named group — it lands on the wildcard instead.
    assert.equal(selectGroup(parseRobotsTxt(body), header)?.matchedToken, '*');
    // Whereas the real token matches the group that was written for us.
    assert.equal(selectGroup(parseRobotsTxt(body), 'applyy-scout')?.matchedToken, 'applyy-scout');
  });

  test('the header-to-token helper extracts the product token', () => {
    const header = 'applyy-scout/1.0 (+https://github.com/MallamTeja/applyyy)';
    assert.equal(tokenFromUserAgentHeader(header), 'applyy-scout');
  });

  test('the helper handles a header with no version', () => {
    assert.equal(tokenFromUserAgentHeader('applyy-browser'), 'applyy-browser');
  });

  test('the helper refuses input it cannot tokenise rather than guessing', () => {
    // Returning a guess here would reintroduce the fail-open the helper exists to
    // close, so an untokenisable header is null and the caller must decide.
    assert.equal(tokenFromUserAgentHeader('   '), null);
    assert.equal(tokenFromUserAgentHeader('/1.0'), null);
  });
});

describe('deciding whether a path is permitted', () => {
  test('the longest matching rule wins regardless of the order rules appear in', () => {
    // A broad Disallow with a narrower Allow carved out of it — the commonest real
    // policy shape, and the one a first-match-wins parser gets exactly backwards.
    const body = 'User-agent: *\nDisallow: /a\nAllow: /a/b\n';
    // The carve-out wins here, because /a/b is longer than /a.
    assert.equal(allows(body, 'anybot', '/a/b/c'), true);
    // And the broad rule still applies outside it, which proves the Allow did not
    // simply override everything.
    assert.equal(allows(body, 'anybot', '/a/x'), false);
  });

  test('the longest match still wins when the laxer rule is written first', () => {
    // Order-dependence here would make a correct policy depend on line numbers.
    const body = 'User-agent: *\nAllow: /a/b\nDisallow: /a\n';
    assert.equal(allows(body, 'anybot', '/a/b/c'), true);
  });

  test('an equal-length tie resolves to Disallow', () => {
    // DELIBERATELY STRICTER THAN RFC 9309, which resolves a tie to the least
    // restrictive rule. Ported from upstream as the cautious reading: when a site
    // has written two rules of equal specificity that disagree, guessing in our own
    // favour is the wrong way to be wrong.
    // Both orderings asserted, because a tie-break that depended on line order would
    // pass one and fail the other — and would make a policy mean two things.
    assert.equal(allows('User-agent: *\nAllow: /x\nDisallow: /x\n', 'anybot', '/x'), false);
    assert.equal(allows('User-agent: *\nDisallow: /x\nAllow: /x\n', 'anybot', '/x'), false);
  });

  test('a path no rule matches is permitted', () => {
    // The non-vacuity anchor for this whole describe block: without it, a matcher
    // that refused everything would pass every refusal test above.
    assert.equal(allows('User-agent: *\nDisallow: /api\n', 'anybot', '/jobs/1'), true);
  });

  test('a percent-encoded rule matches the decoded path', () => {
    // FAIL-OPEN REGRESSION ported from upstream: without decoding, a site that
    // encodes its own Disallow patterns has them silently skipped — the rule simply
    // never fires and the path reads as unrestricted.
    assert.equal(allows('User-agent: *\nDisallow: /foo%20bar\n', 'anybot', '/foo bar'), false);
  });

  test('a percent-encoded rule does not over-match a similar path', () => {
    // The paired non-vacuity test: decoding must not turn one rule into a broader one.
    assert.equal(allows('User-agent: *\nDisallow: /foo%20bar\n', 'anybot', '/foobar'), true);
  });

  test('a * wildcard matches any run of characters', () => {
    // The wildcard must expand...
    assert.equal(allows('User-agent: *\nDisallow: /*/private\n', 'anybot', '/a/private'), false);
    // ...but not swallow the literal text after it, which is the over-match twin.
    assert.equal(allows('User-agent: *\nDisallow: /*/private\n', 'anybot', '/a/public'), true);
  });

  test('a trailing $ anchors the rule to the end of the path', () => {
    // The idiom sites use to block file types without blocking paths containing them.
    const body = 'User-agent: *\nDisallow: /*.pdf$\n';
    // Anchored, so a genuine PDF is blocked...
    assert.equal(allows(body, 'anybot', '/cv.pdf'), false);
    // ...and a path that merely CONTAINS .pdf is not. Ignoring $ would block both.
    assert.equal(allows(body, 'anybot', '/cv.pdf.html'), true);
  });

  test('a regex metacharacter in a rule is matched literally, not as a pattern', () => {
    // A rule containing `.` or `+` must not become a wildcard. Leaving these
    // unescaped would make rules match MORE than the site wrote — over-blocking is
    // survivable, but the same bug with `(` throws and would crash the gate.
    assert.equal(allows('User-agent: *\nDisallow: /a.b\n', 'anybot', '/axb'), true);
    assert.equal(allows('User-agent: *\nDisallow: /a+b\n', 'anybot', '/a+b'), false);
  });

  test('a rule disallowing the site root blocks every path', () => {
    // The case the Lever restriction actually uses.
    assert.equal(allows('User-agent: *\nDisallow: /\n', 'anybot', '/anything/at/all'), false);
  });
});
