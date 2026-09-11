/* Line banding and reading-order reconstruction.
 *
 * WHAT THESE TESTS ARE ACTUALLY DEFENDING. The geometry in the fixtures is
 * copied from the real document, so each test names a way a plausible
 * implementation loses information on a file we actually have - not a way an
 * imagined PDF could be awkward.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { LINE_BAND_TOLERANCE_PT, measurePage } from '../src/index.ts';
import {
  EXPERIENCE_LINE,
  HYPHENATED_WRAP,
  heading,
  item,
  page,
  space,
} from './fixtures/snapshots.ts';

describe('banding by tolerance rather than equality', () => {
  it('keeps a bullet glyph on the same line as its own text despite a 0.2pt offset', () => {
    /* THE MEASURED CASE. The bullet sits at y 680.9 and its text at 681.1. An
       implementation grouping by exact y equality puts them on two lines, then
       x-sorts each - which inverts the bullet below its own text and makes the
       role line read as a stray glyph followed by an orphan. */
    const measured = measurePage(page(EXPERIENCE_LINE));
    assert.equal(measured.bands.length, 1);
    assert.equal(
      measured.bands[0]?.text,
      '• Staff Engineer - Northwind Systems May 2026 - Present',
    );
  });

  it('puts the right-aligned date after the role it shares a baseline with', () => {
    /* The only place this single-column document looks like two columns. The
       date is 450pt to the right of the role and on the same baseline, so it
       must follow the role in the band, not lead it. */
    const measured = measurePage(page(EXPERIENCE_LINE));
    const text = measured.bands[0]?.text ?? '';
    assert.ok(
      text.indexOf('Northwind') < text.indexOf('May 2026'),
      'date must follow role, got: ' + text,
    );
  });

  /* THE NON-VACUITY TWIN. Without this, a `measurePage` that collapsed EVERY
     item into one band would satisfy both tests above - and would also destroy
     every line boundary in the document. The twin is what distinguishes
     tolerance from indifference. */
  it('does NOT merge lines that are a real line-height apart', () => {
    const measured = measurePage(page(HYPHENATED_WRAP));
    assert.equal(measured.bands.length, 2);
  });

  it('separates lines exactly at the tolerance boundary', () => {
    /* Pins the boundary rather than trusting a comfortable margin: two items
       exactly LINE_BAND_TOLERANCE_PT apart are different lines, because the
       comparison is strict less-than. A test using a 10pt gap would pass
       against a tolerance of 9 and hide a widened constant. */
    const measured = measurePage(
      page([item('first', 40, 700), item('second', 40, 700 - LINE_BAND_TOLERANCE_PT)]),
    );
    assert.equal(measured.bands.length, 2);
  });
});

describe('reading-order reconstruction, reported rather than assumed', () => {
  it('reports false when the stored order was already reading order', () => {
    /* This is the REAL document's case: measured at 73 of 73 bands already
       correct. The flag existing is only useful if it can be false. */
    const measured = measurePage(page([heading('EXPERIENCE', 700), item('body text', 49, 690)]));
    assert.equal(measured.readingOrderReconstructed, false);
  });

  it('reports true when bands arrived bottom-to-top', () => {
    const measured = measurePage(page([item('lower', 40, 100), item('upper', 40, 700)]));
    assert.equal(measured.readingOrderReconstructed, true);
    /* And still returns them corrected - detecting the problem is not enough,
       the output has to be usable. */
    assert.equal(measured.bands[0]?.text, 'upper');
  });

  it('reports true when items within one line arrived right-to-left', () => {
    /* The second of the two independent failure modes. A producer can get
       band order right and within-line order wrong; checking only the first
       would report a clean parse on a scrambled line. */
    const measured = measurePage(page([item('second', 300, 700), item('first', 40, 700)]));
    assert.equal(measured.readingOrderReconstructed, true);
    assert.equal(measured.bands[0]?.text, 'first second');
  });
});

describe('text joining', () => {
  it('preserves the producer-emitted spaces that separate words', () => {
    /* Measured fact: inter-word spaces are their own zero-width items. An
       implementation filtering items by `width > 0` welds every word in the
       document together, producing text that is wrong everywhere and errors
       nowhere. */
    const measured = measurePage(page([item('alpha', 40, 700), space(63, 700), item('beta', 66, 700)]));
    assert.equal(measured.bands[0]?.text, 'alpha beta');
  });

  it('takes the tallest item as the band height, not the first', () => {
    /* Section headings are detected by height, and a line can open with a small
       bullet glyph. Taking the first item's height would classify a bulleted
       heading as body text. */
    const measured = measurePage(
      page([
        { str: '•', x: 36, y: 700, width: 3.2, height: 4, fontName: 'g_d0_f4' },
        item('TECHNICAL SKILLS', 46, 700, { height: 8 }),
      ]),
    );
    assert.equal(measured.bands[0]?.maxHeight, 8);
  });

  it('reports each band distance from the top of the page', () => {
    /* Upward-growing PDF coordinates are unusable by a reviewer looking at a
       page. A sign error here is invisible on a square page and wrong on every
       real one, so the assertion uses the real A4 height. */
    const measured = measurePage(page([item('near the top', 40, 800)]));
    assert.ok(Math.abs((measured.bands[0]?.fromTop ?? 0) - 41.9) < 0.01);
  });
});
