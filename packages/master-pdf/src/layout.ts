/* Turning a bag of positioned text items into lines, in reading order.
 *
 * WHY THIS IS NOT JUST `items.map(i => i.str).join('')`. A PDF text layer is an
 * unordered set of draw calls that happen to be stored in some sequence. That
 * sequence MAY equal reading order. Whether it does is a property of the tool
 * that produced the file, not a property of PDFs, and the advice in circulation
 * is contradictory because each piece of it was measured on a different
 * producer.
 *
 * WHAT WAS ACTUALLY MEASURED, 2026-09-11, on the real `master-resume.pdf`:
 * producer pdfTeX 1.40.29 (LaTeX with hyperref); 218 text items; 73 line-bands;
 * ZERO upward y-jumps; within-band emission order already left-to-right in 73
 * of 73 bands. So for THIS document the stored order is already correct and
 * reconstruction changes nothing.
 *
 * THIS CODE RECONSTRUCTS ANYWAY, AND THAT IS THE POINT. The measurement
 * licenses a claim about one file from one toolchain. Teja will re-upload after
 * editing in whatever tool is to hand. `docs/PROGRESS.md` records the sibling
 * mistake in the opposite direction - a Chromium measurement generalised into a
 * rule that did not hold - under the heading "advice inherited from a different
 * toolchain can be exactly correct there and exactly wrong here". Sorting costs
 * microseconds on 218 items and removes the assumption entirely, so the report
 * records WHETHER reconstruction changed anything rather than this module
 * quietly assuming it could not have.
 */

import type { PageSnapshot, TextItem } from './snapshot.ts';

/* Two items belong to one line when their baselines sit within this many points.
 *
 * NOT ZERO, AND THE REASON IS MEASURED. A bullet glyph is set in a different
 * face from the text it introduces and its baseline lands about 0.2pt off -
 * already recorded in master-ingest's README as the reason a naive
 * exact-equality y-grouping followed by an x-sort INVERTS the bullet and its own
 * text. Exact comparison on floating-point coordinates emitted by a typesetter
 * is the plausible wrong design: it works on most lines, fails only on lines
 * with mixed faces, and the failure reads like a parser bug rather than a
 * tolerance bug.
 *
 * 3pt is chosen against the real document's measured line spacing of about
 * 10.5pt: comfortably larger than the 0.2pt face offset, comfortably smaller
 * than the gap to the next line. Superscripts would need a different value; a
 * resume does not have any.
 */
export const LINE_BAND_TOLERANCE_PT = 3;

/* One visual line: the items sharing a baseline, in left-to-right order. */
export interface LineBand {
  /* Baseline y of the item that opened this band. Kept for reporting a location
     back to a human, not used for further comparison. */
  readonly y: number;
  /* Distance from the TOP of the page, which is the only vertical measure a
     human can act on - nobody thinks in upward-growing coordinates. Reported,
     never compared. */
  readonly fromTop: number;
  readonly pageNumber: number;
  readonly items: readonly TextItem[];
  /* The line's visible text, whitespace-collapsed. */
  readonly text: string;
  /* The tallest item in the band. Section headings are detected by height, and
     taking the max rather than the first item's height matters because a line
     can open with a small bullet glyph before its larger text. */
  readonly maxHeight: number;
}

/* Did stored order already equal reading order? Reported, never assumed. */
export interface LayoutMeasurement {
  readonly bands: readonly LineBand[];
  /* True when sorting actually moved something. When true, every downstream
     section boundary was derived from a CORRECTED order, and the human
     reviewing the draft must be told: a reordered text layer is the most likely
     cause of a parse that looks plausible and is wrong. */
  readonly readingOrderReconstructed: boolean;
}

/* Concatenate a band's items into its visible text.
 *
 * Raw concatenation, because the spaces between words are themselves separate
 * items in this producer's output and dropping them welds words together. The
 * whitespace collapse afterwards handles kerning emitted as repeated spaces,
 * which a reader cannot distinguish from a real double space.
 *
 * Line-break hyphens are NOT healed here - they join two BANDS, not two items
 * within one band, so that fold belongs to whoever joins bands into a paragraph.
 */
function joinBandText(items: readonly TextItem[]): string {
  if (items.length === 0) {
    return '';
  }

  let raw = items[0]!.str;
  for (let i = 1; i < items.length; i++) {
    const prev = items[i - 1]!;
    const curr = items[i]!;
    if (
      !/\s$/u.test(prev.str) &&
      !/^\s/u.test(curr.str) &&
      prev.x + prev.width < curr.x
    ) {
      raw += ' ';
    }
    raw += curr.str;
  }

  return raw.replace(/\s+/gu, ' ').trim();
}

/* Group one page's items into lines and put those lines in reading order. */
export function measurePage(page: PageSnapshot): LayoutMeasurement {
  /* Keep items carrying text or ink. In LaTeX/pdfTeX output, inter-word spaces
     arrive as separate zero-width items with str: ' ' and width: 0. Trimming
     them drops them and welds words together, so any item with non-empty string
     or positive width must be preserved. Empty strings with zero width are
     true no-ops and can be dropped. */
  const inked = page.items.filter((item) => item.str.length > 0 || item.width > 0);

  /* Build bands by SCANNING, not by sorting first. Scanning preserves the
     stored order inside each band, which is exactly the evidence needed to
     measure below whether that stored order was already correct. Sorting first
     would destroy the thing being measured - and would still produce a correct
     final answer, which is what makes it the tempting wrong move. */
  const bands: { y: number; items: TextItem[] }[] = [];
  for (const item of inked) {
    const existing = bands.find((band) => Math.abs(band.y - item.y) < LINE_BAND_TOLERANCE_PT);
    if (existing === undefined) {
      bands.push({ y: item.y, items: [item] });
    } else {
      existing.items.push(item);
    }
  }

  /* Measure BEFORE correcting. Two independent questions, because a producer
     can get either one wrong on its own: are the bands top-to-bottom, and is
     each band left-to-right? */
  const bandsWereOrdered = bands.every(
    (band, index) => index === 0 || (bands[index - 1] as { y: number }).y >= band.y,
  );
  const itemsWereOrdered = bands.every((band) =>
    band.items.every(
      (item, index) => index === 0 || (band.items[index - 1] as TextItem).x <= item.x,
    ),
  );

  /* Correct unconditionally. y DESCENDING because PDF user space grows upward
     while a resume is read downward; x ascending within a line. */
  bands.sort((a, b) => b.y - a.y);
  for (const band of bands) {
    band.items.sort((a, b) => a.x - b.x);
  }

  return {
    readingOrderReconstructed: !(bandsWereOrdered && itemsWereOrdered),
    bands: bands.map((band) => ({
      y: band.y,
      fromTop: page.height - band.y,
      pageNumber: page.pageNumber,
      items: band.items,
      text: joinBandText(band.items),
      maxHeight: band.items.reduce((tallest, item) => Math.max(tallest, item.height), 0),
    })),
  };
}

/* Measure every page and concatenate.
 *
 * Pages are processed in page order and never interleaved: a multi-page resume
 * reads page 1 fully before page 2, and no producer has been observed to
 * violate that.
 */
export function measureDocument(pages: readonly PageSnapshot[]): LayoutMeasurement {
  const measured = pages.map(measurePage);
  return {
    bands: measured.flatMap((m) => m.bands),
    /* ANY page needing reconstruction taints the whole document, because the
       human is being asked one question - "can I trust this parse?" - and the
       answer is no if any page was out of order. */
    readingOrderReconstructed: measured.some((m) => m.readingOrderReconstructed),
  };
}
