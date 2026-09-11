/* Fixtures for the PDF extractor.
 *
 * EVERY VALUE HERE IS INVENTED. No real personal data is in this repo, and the
 * one real resume this package was built against is gitignored. What IS copied
 * from the real document is its SHAPE, measured on 2026-09-11 with pdfjs 4.9.155
 * against `master-resume.pdf` (pdfTeX 1.40.29, LaTeX with hyperref).
 *
 * WHY SHAPE-REAL RATHER THAN HAND-INVENTED. A synthetic fixture proves the
 * parser handles fiction. Each geometric constant below is here because the
 * real file has it, and a parser that passes on invented geometry can fail on
 * the only document that matters. The measured facts encoded here:
 *
 *   1. Page is A4, 595.3 x 841.9 pt, single column, all content x 36 to 496.7.
 *   2. Body text renders at height 9, section headings at 8, the name at 23.9.
 *      Height is the ONLY structural signal a text layer carries.
 *   3. A bullet glyph sits about 0.2pt off the baseline of its own text, set in
 *      a different face. This is the offset that makes exact-equality y-grouping
 *      invert a bullet and its text.
 *   4. Inter-word spaces arrive as SEPARATE zero-width items, so naive
 *      item-joining without them welds words together.
 *   5. Dates are right-aligned near x 496 on the SAME baseline as the role they
 *      belong to - the only place this single-column document looks like two.
 *   6. Justified LaTeX hyphenates across line breaks, so a word can be split
 *      between two bands.
 *   7. A hyperref link rectangle sits about 3.5pt BELOW the baseline of the text
 *      it covers and extends above it - the baseline is inside the rect, but the
 *      rect is not centred on it.
 *   8. Link text such as "GitHub" carries NO url in the text layer at all.
 */

import type { LinkAnnotation, PageSnapshot, TextItem } from '../../src/snapshot.ts';

/* Body text face and size, per measured fact 2. */
const BODY = { height: 9, fontName: 'g_d0_f2' };
/* Section-heading face, per measured fact 2. Smaller than body, which is the
   counter-intuitive part: headings are distinguished by FACE, and only happen to
   differ in height. A parser keying purely on "bigger is a heading" fails here,
   which is why this fixture keeps the real relationship rather than an
   idealised one. */
const HEADING = { height: 8, fontName: 'g_d0_f3' };

/* Build a text item, defaulting width from the string length.
 *
 * Width matters to the link anchoring, which tests horizontal OVERLAP rather
 * than containment - so a fixture with zero widths would let containment-based
 * anchoring pass and hide the bug this package was built to avoid. The 4.6pt
 * per character is the measured average advance of the real document's body
 * face. */
export function item(
  str: string,
  x: number,
  y: number,
  overrides: Partial<TextItem> = {},
): TextItem {
  return {
    str,
    x,
    y,
    width: str.length * 4.6,
    height: BODY.height,
    fontName: BODY.fontName,
    ...overrides,
  };
}

/* The inter-word space as this producer emits it: its own item, zero width,
   zero height. Per measured fact 4. */
export function space(x: number, y: number): TextItem {
  return { str: ' ', x, y, width: 0, height: 0, fontName: BODY.fontName };
}

/* A section heading line, per measured fact 2. */
export function heading(str: string, y: number): TextItem {
  return { str, x: 41, y, width: str.length * 4.4, ...HEADING };
}

/* A link annotation rectangle around text on the given baseline.
 *
 * Per measured fact 7: the rect starts 3.5pt BELOW the baseline and ends 7.5pt
 * above it. Encoding the real asymmetry rather than a symmetric box is what
 * makes this fixture able to catch an anchoring test that assumes the baseline
 * is centred in the rectangle. */
export function linkRect(url: string, x1: number, x2: number, y: number): LinkAnnotation {
  return { url, rect: [x1, y - 3.5, x2, y + 7.5] };
}

/* A one-page snapshot from a list of items and links. */
export function page(
  items: readonly TextItem[],
  links: readonly LinkAnnotation[] = [],
): PageSnapshot {
  return { pageNumber: 1, height: 841.9, items, links };
}

/* THE SHAPE-REAL EXPERIENCE LINE, per measured facts 3 and 5.
 *
 * A bullet glyph 0.2pt off its own text's baseline, the role text, and a
 * right-aligned date at x 496.7 sharing that baseline. This single line is the
 * hardest thing in the document: it needs banding by tolerance (not equality),
 * x-ordering within the band, and it is the only place a single-column resume
 * presents two horizontally separated runs. */
export const EXPERIENCE_LINE: readonly TextItem[] = [
  /* The bullet, deliberately 0.2pt BELOW its text's baseline and in its own
     face - this is the measured offset, not an invented one. */
  { str: '•', x: 36.7, y: 680.9, width: 3.2, height: 9, fontName: 'g_d0_f4' },
  space(42.2, 681.1),
  item('Staff Engineer - Northwind Systems', 46.8, 681.1),
  /* Right-aligned date, same baseline, far right. */
  item('May 2026 - Present', 496.7, 681.1),
];

/* THE HYPHENATED WRAP, per measured fact 6: one word split across two bands. */
export const HYPHENATED_WRAP: readonly TextItem[] = [
  item('Built distributed systems with measurable relia-', 49.1, 741.5),
  item('bility improvements across three regions.', 49.1, 731),
];

/* THE PROJECT WITH TWO LINKS, per measured facts 7 and 8.
 *
 * The live URL is visible text; the GitHub link is the bare word "GitHub" whose
 * url exists ONLY in the annotation. This is the exact construction that made a
 * text-only parser drop half the links in the real document while appearing to
 * succeed. */
export const PROJECT_LINKS_ITEMS: readonly TextItem[] = [
  item('example-project.test', 36, 493.3, { height: 8 }),
  item(' | ', 128, 493.3, { height: 8 }),
  item('GitHub', 151, 493.3, { height: 8 }),
];

export const PROJECT_LINKS_ANNOTATIONS: readonly LinkAnnotation[] = [
  linkRect('https://example-project.test/', 35, 139.8, 493.3),
  linkRect('https://github.test/example/project', 151, 179.8, 493.3),
];

/* A link annotation covering no readable text - the unanchored case.
 *
 * Placed far from any item on purpose. Without a fixture like this the
 * unanchored branch is unreachable, and an unreachable branch is one a test
 * suite reports as covered while proving nothing about it. */
export const ORPHAN_ANNOTATION: LinkAnnotation = linkRect(
  'https://orphan.test/nothing-here',
  300,
  380,
  200,
);
