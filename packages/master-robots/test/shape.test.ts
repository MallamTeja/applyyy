// The soft-200 defence, tested before it is written.
//
// THE DISEASE THIS FILE EXISTS TO KILL: a misconfigured host answers /robots.txt
// with 200 and an HTML error page. That body parses to zero rules, and zero rules
// read as "nothing is disallowed" — so a broken server GRANTS permission it never
// gave. The guard must not ask "did the parser find rules?", because the parser is
// lenient and will happily find none in anything.
//
// THE DISCRIMINATOR IS SYNTACTIC SHAPE, NOT RULE COUNT. Measured against upstream
// (reference/ai-job-search-upstream/tools/robots_check.py) on 2026-09-17: its
// is_robots_body() scores a fully-commented robots.txt IDENTICALLY to an HTML error
// page — both False. That would refuse job-boards.greenhouse.io, which
// worker/scripts/capture-fixture.ts:31 records as human-verified permitted. Rule
// count cannot tell those apart; shape can.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyRobotsBody } from '../src/shape.ts';

// Every case below passes a content-type a well-behaved host would send, so that a
// test about BODY shape cannot accidentally pass because of the header check.
const PLAIN = 'text/plain';

describe('bodies that ARE a robots.txt and must be parsed', () => {
  test('an empty body is a valid allow-all under RFC 9309, not a failure', () => {
    // Over-correcting here is the mistake that breaks every site with an empty file.
    assert.equal(classifyRobotsBody('', PLAIN).kind, 'robots-txt');
  });

  test('a whitespace-only body is still a valid allow-all', () => {
    assert.equal(classifyRobotsBody('\n\n   \n', PLAIN).kind, 'robots-txt');
  });

  test('REGRESSION job-boards.greenhouse.io: an all-comments body is a valid allow-all', () => {
    // THE NAMED REGRESSION. This host is in capture-fixture.ts ALLOWED_HOSTS with the
    // note "robots.txt has every rule commented out, so nothing is disallowed.
    // Checked 2026-09-09". Porting upstream's rule-count guard verbatim turns a
    // human-verified permitted host into a refusal. If this test ever goes red,
    // someone has reverted the shape check to a rule count.
    const body = '# User-agent: *\n# Disallow: /\n';
    assert.equal(classifyRobotsBody(body, PLAIN).kind, 'robots-txt');
  });

  test('a real policy is recognised', () => {
    assert.equal(classifyRobotsBody('User-agent: *\nDisallow: /embed/\n', PLAIN).kind, 'robots-txt');
  });

  test('a sitemap-only file counts, having no rules but being unmistakably robots.txt', () => {
    const body = 'Sitemap: https://x.example/sitemap.xml\n';
    assert.equal(classifyRobotsBody(body, PLAIN).kind, 'robots-txt');
  });

  test('an unknown field is tolerated, because RFC 9309 says to ignore unrecognised fields', () => {
    // Tolerating unknown FIELDS while rejecting unknown SYNTAX is the whole trick: a
    // future directive must not be mistaken for an error page.
    const body = 'User-agent: *\nFuture-Directive: whatever\nDisallow: /x\n';
    assert.equal(classifyRobotsBody(body, PLAIN).kind, 'robots-txt');
  });

  test('a UTF-8 BOM does not stop a real policy being recognised', () => {
    // A BOM is invisible in an editor, so a BOM-induced refusal is near-impossible to
    // diagnose from the symptom.
    const body = '﻿User-agent: *\nDisallow: /x\n';
    assert.equal(classifyRobotsBody(body, PLAIN).kind, 'robots-txt');
  });

  test('a missing content-type does not by itself disqualify a well-formed body', () => {
    // Absent is not the same as wrong; refusing on absence would refuse real hosts.
    assert.equal(classifyRobotsBody('User-agent: *\nDisallow: /x\n', null).kind, 'robots-txt');
  });

  test('a text/plain content-type with a charset parameter is accepted', () => {
    const body = 'User-agent: *\nDisallow: /x\n';
    assert.equal(classifyRobotsBody(body, 'text/plain; charset=utf-8').kind, 'robots-txt');
  });
});

describe('bodies that are NOT a robots.txt and must refuse', () => {
  test('an HTML error page is refused even though it arrived with status 200', () => {
    // The canonical soft-200. Upstream caught this one; we must not lose it.
    const result = classifyRobotsBody('<html><body>404 Not Found</body></html>', PLAIN);
    assert.equal(result.kind, 'not-robots-txt');
  });

  test('a JSON error body is refused despite containing colons', () => {
    // A naive "does the line contain a colon?" check passes this, because
    // {"error":"not found"} has one. The field name must be a real token.
    const result = classifyRobotsBody('{"error":"not found"}', PLAIN);
    assert.equal(result.kind, 'not-robots-txt');
  });

  test('an HTML content-type refuses even when the body would otherwise parse', () => {
    // Content-type is checked independently of the body, so a page that happens to
    // contain a directive-shaped line cannot smuggle itself through.
    const body = 'User-agent: *\nDisallow: /x\n';
    const result = classifyRobotsBody(body, 'text/html');
    assert.equal(result.kind, 'not-robots-txt');
  });

  test('an XML content-type refuses, catching a sitemap served at the robots path', () => {
    const result = classifyRobotsBody('User-agent: *\n', 'application/xml');
    assert.equal(result.kind, 'not-robots-txt');
  });

  test('a body starting with < refuses even when the content-type lies about being plain', () => {
    // The second layer exists because the first is host-controlled. A host that
    // mislabels its error page must still be caught.
    const result = classifyRobotsBody('﻿  \n<!DOCTYPE html>\n', PLAIN);
    assert.equal(result.kind, 'not-robots-txt');
  });

  test('a body over the byte cap refuses rather than being parsed', () => {
    // An unbounded read is a denial-of-service surface: the gate runs before every
    // fetch, so a hostile 500MB /robots.txt would stall the pipeline.
    const body = `User-agent: *\nDisallow: /x\n${'#'.repeat(600_000)}`;
    const result = classifyRobotsBody(body, PLAIN);
    assert.equal(result.kind, 'not-robots-txt');
  });

  test('one non-directive line poisons an otherwise valid body', () => {
    // An error page appended to a real policy is still an error page. Requiring EVERY
    // line to be well-formed is what makes the check impossible to pass partially.
    const body = 'User-agent: *\nDisallow: /x\n<div>oops</div>\n';
    const result = classifyRobotsBody(body, PLAIN);
    assert.equal(result.kind, 'not-robots-txt');
  });
});

describe('the refusal carries a reason a human can act on', () => {
  test('a refusal names why, so an operator is not left guessing at 3am', () => {
    // A bare boolean refusal produces a support ticket; a named one produces a fix.
    const result = classifyRobotsBody('<html></html>', 'text/html');
    assert.equal(result.kind, 'not-robots-txt');
    // Narrowing proves the reason field exists only on the refusing arm of the union.
    if (result.kind === 'not-robots-txt') {
      assert.match(result.reason, /content-type/i);
    }
  });

  test('the accepting arm carries no reason field, so the union cannot be read wrongly', () => {
    // If both arms had the same shape, callers would branch on truthiness of reason
    // rather than on kind, and the discriminant would stop being load-bearing.
    const result = classifyRobotsBody('', PLAIN);
    assert.equal(Object.hasOwn(result, 'reason'), false);
  });
});
