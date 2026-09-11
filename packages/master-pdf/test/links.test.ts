/* Link recovery from the annotation layer.
 *
 * THE CLAIM UNDER TEST IS THE PACKAGE'S REASON FOR EXISTING. Measured on the
 * real document: 15 URLs live in annotations and ZERO of them appear in the
 * text layer. A text-only extractor loses every one and reports success. These
 * tests are the standing proof that this implementation does not.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { linksOnLine, resolveLinks } from '../src/index.ts';
import {
  ORPHAN_ANNOTATION,
  PROJECT_LINKS_ANNOTATIONS,
  PROJECT_LINKS_ITEMS,
  item,
  linkRect,
} from './fixtures/snapshots.ts';

describe('anchoring a url to the text a reader sees', () => {
  it('recovers BOTH of a project two links, including the one with no url in the text', () => {
    /* THE MEASURED CASE, and the feature Teja actually asked for. The live URL
       is visible text; "GitHub" is a bare word whose url exists only in the
       annotation. A parser reading the text layer alone returns one link and
       looks correct. */
    const resolved = resolveLinks(PROJECT_LINKS_ANNOTATIONS, PROJECT_LINKS_ITEMS, 1);
    assert.equal(resolved.anchored.length, 2);
    assert.deepEqual(
      resolved.anchored.map((link) => link.label),
      ['example-project.test', 'GitHub'],
    );
    assert.deepEqual(
      resolved.anchored.map((link) => link.url),
      ['https://example-project.test/', 'https://github.test/example/project'],
    );
  });

  it('takes the label from the document rather than deriving it from the url', () => {
    /* A label invented from the host name reads plausibly and is not what the
       resume says. The reviewer is confirming the draft against the PDF, so a
       plausible-but-invented label is worse than an ugly true one. */
    const resolved = resolveLinks(PROJECT_LINKS_ANNOTATIONS, PROJECT_LINKS_ITEMS, 1);
    assert.equal(resolved.anchored[1]?.label, 'GitHub');
    assert.notEqual(resolved.anchored[1]?.label, 'github.test');
  });

  it('joins a label split across several text items', () => {
    /* A typesetter splits a url into several items and hyperref draws one
       rectangle across them. The pieces must come back as one label. */
    const items = [item('github', 131, 774), item('.com/', 158, 774), item('example', 180, 774)];
    const resolved = resolveLinks([linkRect('https://github.test/example', 131, 230, 774)], items, 1);
    assert.equal(resolved.anchored[0]?.label, 'github.com/example');
  });

  it('includes items whose edges poke outside the rectangle', () => {
    /* Containment is the plausible wrong test. The first and last items of a
       multi-item link routinely extend a fraction of a point past the
       rectangle, so requiring containment SHORTENS labels rather than failing -
       it drops the first and last fragment and returns a plausible middle. */
    const items = [item('abcdef', 130, 774)];
    /* Rectangle starts 1pt right of the item and ends before it does. */
    const resolved = resolveLinks([linkRect('https://x.test/', 131, 150, 774)], items, 1);
    assert.equal(resolved.anchored.length, 1);
    assert.equal(resolved.anchored[0]?.label, 'abcdef');
  });
});

describe('the unanchored case, which must be reported and never dropped', () => {
  it('reports a url whose rectangle covers no readable text', () => {
    /* Without this branch a link over an image, or over text the layer omitted,
       vanishes entirely. "There is a URL here and I could not label it" is
       actionable; silence is not. */
    const resolved = resolveLinks([ORPHAN_ANNOTATION], PROJECT_LINKS_ITEMS, 1);
    assert.equal(resolved.anchored.length, 0);
    assert.equal(resolved.unanchored.length, 1);
    assert.equal(resolved.unanchored[0]?.url, 'https://orphan.test/nothing-here');
  });

  it('treats a whitespace-only label as unanchored rather than anchored-and-blank', () => {
    /* An anchored link with an empty label renders as an invisible hyperlink on
       the tailored resume: present, clickable, and impossible to notice. */
    const resolved = resolveLinks(
      [linkRect('https://blank.test/', 40, 80, 700)],
      [{ str: '   ', x: 40, y: 700, width: 12, height: 9, fontName: 'g_d0_f2' }],
      1,
    );
    assert.equal(resolved.unanchored.length, 1);
    assert.equal(resolved.anchored.length, 0);
  });

  /* THE NON-VACUITY TWIN for both tests above. Without it, a `resolveLinks`
     that reported EVERY annotation as unanchored would pass them - and would
     also lose every link in the document while appearing to report diligently. */
  it('does NOT report an anchorable link as unanchored', () => {
    const resolved = resolveLinks(PROJECT_LINKS_ANNOTATIONS, PROJECT_LINKS_ITEMS, 1);
    assert.equal(resolved.unanchored.length, 0);
  });
});

describe('the asymmetric rectangle, which is how hyperref actually draws them', () => {
  it('anchors text whose baseline is near the bottom edge of the rectangle', () => {
    /* MEASURED: rect y 770.3-781.3 anchors a baseline at 773.8 - 3.5pt above the
       lower edge, 7.5pt below the upper. An implementation assuming the
       baseline is CENTRED in the rectangle, and testing against the midpoint
       with a tight tolerance, rejects every real link. */
    const resolved = resolveLinks(
      [{ url: 'https://x.test/', rect: [131.5, 770.3, 230.2, 781.3] }],
      [item('github.com/example', 132.5, 773.8)],
      1,
    );
    assert.equal(resolved.anchored.length, 1);
  });

  it('does NOT anchor text a whole line away', () => {
    /* TWIN for the above. A slack generous enough to absorb the asymmetry must
       still refuse the next line - otherwise a link claims the text below it,
       and because that text is also plausible the result is a WRONG label
       rather than a missing one. */
    const resolved = resolveLinks(
      [{ url: 'https://x.test/', rect: [131.5, 770.3, 230.2, 781.3] }],
      [item('the line below', 132.5, 760)],
      1,
    );
    assert.equal(resolved.anchored.length, 0);
    assert.equal(resolved.unanchored.length, 1);
  });
});

describe('attaching links to the line they belong to', () => {
  it('selects only links sharing a baseline with the given line', () => {
    const resolved = resolveLinks(PROJECT_LINKS_ANNOTATIONS, PROJECT_LINKS_ITEMS, 1);
    const onLine = linksOnLine(resolved.anchored, 493.3, 1, 3);
    assert.equal(onLine.length, 2);
  });

  it('excludes links on a different line', () => {
    /* TWIN. Without it, a `linksOnLine` returning everything would pass the
       test above, and every project would inherit every link in the document. */
    const resolved = resolveLinks(PROJECT_LINKS_ANNOTATIONS, PROJECT_LINKS_ITEMS, 1);
    assert.equal(linksOnLine(resolved.anchored, 300, 1, 3).length, 0);
  });

  it('excludes links on a different page', () => {
    /* Two pages of a resume have overlapping y ranges, so a page-blind
       comparison attaches page 2 links to page 1 lines. */
    const resolved = resolveLinks(PROJECT_LINKS_ANNOTATIONS, PROJECT_LINKS_ITEMS, 1);
    assert.equal(linksOnLine(resolved.anchored, 493.3, 2, 3).length, 0);
  });
});
