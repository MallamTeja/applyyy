/* Tests for jdPlainText (features/discovery/jdText.ts, 2026-11-07).
 *
 * WHY. jobs.description_raw is often HTML, sometimes entity-escaped HTML ("&lt;p&gt;..."), and the
 * Discovered page printed it raw (Teja's Circuithub sample). Every case asserts the EXACT output string
 * (repo CLAUDE.md §6: the positive shape, never merely "contains no '<'"). */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
// A static import is safe: jdText.ts has no imports of its own, so no resolve hook is needed.
import { jdPlainText } from '../src/features/discovery/jdText.ts';

describe('jdPlainText', () => {
  it('leaves plain text unchanged', () => {
    // A row that was already plain must come back byte-identical.
    assert.equal(jdPlainText('Build robots. Ship fast.'), 'Build robots. Ship fast.');
  });

  it('turns <p> blocks into paragraph breaks', () => {
    // Two paragraphs become two lines separated by one blank line.
    assert.equal(jdPlainText('<p>a</p><p>b</p>'), 'a\n\nb');
  });

  it('turns <br> and <li> into line breaks', () => {
    // A list keeps one item per line instead of running the items together.
    assert.equal(jdPlainText('Line one<br/>Line two<ul><li>x</li><li>y</li></ul>'), 'Line one\nLine two\n\nx\ny');
  });

  it('strips entity-escaped markup (the double-escaped case)', () => {
    // "&lt;p&gt;x&lt;/p&gt;" decodes to "<p>x</p>"; the second pass strips that markup.
    assert.equal(jdPlainText('&lt;p&gt;x&lt;/p&gt;'), 'x');
  });

  it('decodes named and numeric entities', () => {
    // &amp; &nbsp; &#39; and &#x2019; are the entities seen in scraped postings.
    assert.equal(jdPlainText('R&amp;D&nbsp;team &#39;now&#x2019;'), 'R&D team \'now’');
  });

  it('keeps a literal "&lt;" that a single decode produced only once', () => {
    // "&amp;lt;3" is text that MEANS "&lt;3"; decoding twice would wrongly turn it into "<3".
    assert.equal(jdPlainText('I &amp;lt;3 Rust'), 'I &lt;3 Rust');
  });

  it('drops a <script> body entirely, escaped or not', () => {
    // Neither the tag nor its code may survive; the surrounding text must.
    assert.equal(jdPlainText('<p>Hi</p><script>alert(1)</script>&lt;script&gt;alert(2)&lt;/script&gt;'), 'Hi');
  });

  it('collapses whitespace runs but keeps paragraph breaks', () => {
    // Source indentation and newlines inside a paragraph are noise; the block break is structure.
    assert.equal(jdPlainText('<div>\n   alpha    beta\n</div>\n\n\n<div>gamma</div>'), 'alpha beta\n\ngamma');
  });

  it('returns "" for null', () => {
    // A row without a description renders nothing rather than "null".
    assert.equal(jdPlainText(null), '');
  });
});
