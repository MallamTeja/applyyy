/* Recovering hyperlinks, which the text layer does not contain.
 *
 * THE FINDING THIS MODULE EXISTS FOR, measured 2026-09-11 on the real
 * `master-resume.pdf`. `getTextContent()` returns text and ONLY text. Every URL
 * in the document lives in a separate annotation layer, keyed to a rectangle on
 * the page and carrying no text of its own. In the real resume that is 15 URLs:
 * both project links, three certification credential links, a certificates
 * folder, and six contact links.
 *
 * An extractor built on the text layer alone drops all 15, produces a profile
 * that looks complete, and reports no error of any kind. That matters more than
 * a normal bug because of what the feature is FOR: `MasterProject` had its
 * `url: string | null` scalar replaced by a `links` array on 2026-09-11
 * precisely so a project could carry both a live URL and a GitHub URL. A field
 * that is representable in the contract and invisible to the parser is
 * indistinguishable from a field nobody asked for.
 *
 * THE GENERAL LESSON, which outlives this file: the hazard was in the API
 * SURFACE, not in the data. Everyone was braced for a layout problem, because
 * that is what the inherited advice warned about. `getTextContent()` behaves
 * correctly and as documented. The failure mode is not a function that errors -
 * it is a function that faithfully answers a NARROWER QUESTION than the one you
 * thought you asked.
 */

import type { LinkAnnotation, TextItem } from './snapshot.ts';

/* Vertical slack when deciding whether a text baseline sits inside a link's
   rectangle.
 *
 * A hyperref rectangle is drawn around the glyph BOX while a TextItem reports
 * its BASELINE, so the baseline sits above the rectangle's lower edge by the
 * font's descender and below its upper edge by most of the ascender. Measured
 * on the real document: rect y 770.3-781.3 anchors a baseline at 773.8, which
 * is 3.5pt above the lower edge. Testing baseline-inside-rect directly is
 * therefore already correct and this slack only absorbs rounding - which is why
 * it is small. A large value here would let a link on one line claim the text
 * of the line below it, and because both lines usually contain plausible text
 * the result would be a wrong label rather than a visible failure. */
const BASELINE_SLACK_PT = 1;

/* A URL successfully tied to the text a reader sees. */
export interface AnchoredLink {
  readonly url: string;
  /* The visible text the URL sits under, e.g. "GitHub". This becomes
     `MasterLink.label`, and it is what a reviewer reads when confirming the
     draft - so it is taken from the document rather than derived from the URL.
     A label invented from the host name would read plausibly and would not be
     what the resume says. */
  readonly label: string;
  /* Baseline y of the anchoring text, so a caller can attach the link to the
     same line band the text came from. */
  readonly y: number;
  readonly pageNumber: number;
}

/* A URL that exists in the PDF but could not be tied to any visible text.
 *
 * REPORTED, NEVER SILENTLY DROPPED. This is the condition where a link is
 * genuinely present and the extractor cannot say what it belongs to - an
 * annotation over an image, a rectangle whose text was filtered as inkless, or
 * a producer that positions annotations differently from pdfTeX. A human can
 * act on "there is a URL here and I could not label it"; they can do nothing at
 * all with silence. */
export interface UnanchoredLink {
  readonly url: string;
  readonly rect: readonly [number, number, number, number];
  readonly pageNumber: number;
}

export interface LinkResolution {
  readonly anchored: readonly AnchoredLink[];
  readonly unanchored: readonly UnanchoredLink[];
}

/* Does this text item sit inside this link rectangle?
 *
 * Horizontal test uses the item's full extent (x to x+width) against the rect,
 * accepting any OVERLAP rather than requiring containment. Containment is the
 * plausible wrong test: a typesetter splits "github.com/MallamTeja" into several
 * items and hyperref draws one rectangle across them, so the first and last
 * items routinely poke a fraction of a point outside it. Requiring containment
 * silently drops the edges of every multi-item link, which shortens labels
 * rather than failing - the worst kind of wrong.
 */
function itemIsInsideRect(item: TextItem, rect: readonly [number, number, number, number]): boolean {
  const [x1, y1, x2, y2] = rect;
  const overlapsHorizontally = item.x < x2 && item.x + item.width > x1;
  const baselineIsInside = item.y >= y1 - BASELINE_SLACK_PT && item.y <= y2 + BASELINE_SLACK_PT;
  return overlapsHorizontally && baselineIsInside;
}

/* Tie every annotation on a page to the text it covers. */
export function resolveLinks(
  annotations: readonly LinkAnnotation[],
  items: readonly TextItem[],
  pageNumber: number,
): LinkResolution {
  const anchored: AnchoredLink[] = [];
  const unanchored: UnanchoredLink[] = [];

  for (const annotation of annotations) {
    /* Collect every item under the rectangle, then order them left-to-right.
       The annotation layer imposes no order of its own, and the stored text
       order cannot be relied on here for the same reason it cannot be relied on
       in `layout.ts`. */
    const covered = items
      .filter((item) => itemIsInsideRect(item, annotation.rect))
      .sort((a, b) => a.x - b.x);

    const label = covered
      .map((item) => item.str)
      .join('')
      .replace(/\s+/gu, ' ')
      .trim();

    /* An empty label means the rectangle covered nothing readable. Treating
       that as an anchored link with an empty label would put a blank-labelled
       link into the profile, which renders as an invisible hyperlink on the
       tailored resume - present, clickable, and impossible to notice. */
    if (label === '') {
      unanchored.push({ url: annotation.url, rect: annotation.rect, pageNumber });
      continue;
    }

    anchored.push({
      url: annotation.url,
      label,
      /* Baseline of the leftmost covered item. Any covered item would do since
         they share a line, and taking the first keeps this deterministic. */
      y: (covered[0] as TextItem).y,
      pageNumber,
    });
  }

  return { anchored, unanchored };
}

/* Find the links belonging to one line, by baseline proximity.
 *
 * Used to attach a project's links to the project it sits under. The tolerance
 * matches `LINE_BAND_TOLERANCE_PT` in spirit but is passed in rather than
 * imported, so a caller that bands differently cannot end up with two different
 * notions of "same line" - the kind of quiet disagreement that produces a link
 * attached to the wrong project.
 */
export function linksOnLine(
  links: readonly AnchoredLink[],
  y: number,
  pageNumber: number,
  tolerance: number,
): readonly AnchoredLink[] {
  return links.filter(
    (link) => link.pageNumber === pageNumber && Math.abs(link.y - y) < tolerance,
  );
}
