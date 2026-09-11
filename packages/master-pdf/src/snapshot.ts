/* The PDF snapshot: plain data describing what a PDF's text layer contains.
 *
 * WHY THIS TYPE EXISTS AT ALL, WHICH IS THE CENTRAL DESIGN DECISION OF THIS
 * PACKAGE. Everything downstream of here is a pure function over plain data —
 * no pdfjs, no Node builtins, no browser globals. The only code that touches a
 * PDF library lives in `load-pdf.ts`, and it produces one of these. That split
 * is a DEPENDENCY SEAM, and it buys three things that are each hard to get any
 * other way:
 *
 *   1. The extractor is testable without a PDF. A fixture is an object literal,
 *      so a test can express "two items on the same line 0.2pt apart" directly
 *      instead of hand-crafting a PDF that produces that.
 *   2. This package declares NO dependency on pdfjs-dist. That is not
 *      fastidiousness — `pnpm-lock.yaml` is a single-owner file in this repo
 *      and adding a dependency here would rewrite it from a session that does
 *      not own it. The caller passes its own already-loaded pdfjs in.
 *   3. The parse runs browser-side by product requirement (Teja's resume must
 *      never leave his machine before he accepts it), and a browser, a Deno
 *      Edge Function and the Node test runner each load pdfjs differently.
 *      Only the seam differs; the extraction logic is identical in all three.
 *
 * MEASURED AGAINST THE REAL DOCUMENT, 2026-09-11. Every field here exists
 * because the actual `master-resume.pdf` needed it: pdfTeX 1.40.29 (LaTeX with
 * hyperref), 1 page, 218 text items across 73 line-bands, and 15 link
 * annotations. */

/* One piece of text as the PDF's text layer reports it.
 *
 * The coordinate convention is PDF user space: y grows UPWARD from the bottom
 * of the page, so the TOP line of a resume has the LARGEST y. Every comparison
 * in `layout.ts` is written against that direction, and getting it backwards
 * silently reverses the whole document rather than erroring. */
export interface TextItem {
  /* The literal string. Never trimmed here — leading and trailing spaces are
     real signal when joining items into a line, and a normaliser downstream
     cannot recover a space this layer threw away. */
  readonly str: string;
  /* Horizontal position of the item's left edge, in points. */
  readonly x: number;
  /* Vertical position of the item's baseline, in points, growing upward. */
  readonly y: number;
  /* Rendered width in points. Used to decide whether two items on one line are
     adjacent or separated by a real gap. */
  readonly width: number;
  /* Rendered height in points. THIS IS THE SECTION-HEADING SIGNAL in the real
     document: headings render at 8pt in a different face while body text is
     9pt, and the name is 23.9pt. Height is the only structural cue a text
     layer carries, because a PDF has no notion of a heading. */
  readonly height: number;
  /* The font resource name, e.g. `g_d0_f3`. Opaque and producer-specific — it
     is a grouping key, never something to match on by name. Two items sharing
     one font name were set in one face; that is all it means. */
  readonly fontName: string;
}

/* A hyperlink as the PDF stores it — a rectangle on the page plus a target.
 *
 * THIS IS THE FINDING THAT RESHAPED THE PACKAGE. `getTextContent()` does not
 * return URLs. LaTeX's hyperref (and Word, and every design tool) writes links
 * as ANNOTATIONS in a separate object layer, keyed only by the region of the
 * page they cover. In the real resume that is 15 URLs — both project links,
 * three certification credentials, and every contact link — none of which
 * appear anywhere in the text stream.
 *
 * A text-only extractor drops all 15, produces a profile that looks complete,
 * and reports no error. That is the exact silent-loss failure this package is
 * built to prevent, and it was hiding in the shape of the PDF API rather than
 * in the layout of the document. Links are therefore a first-class input here,
 * not an enrichment pass bolted on later. */
export interface LinkAnnotation {
  /* Target URL, already resolved by the loader. */
  readonly url: string;
  /* The clickable rectangle: [x1, y1, x2, y2] in the same user space as
     TextItem, with y growing upward. The link carries NO text of its own, so
     the only way to know what it links is to intersect this rectangle with the
     text items sitting inside it — see `links.ts`. */
  readonly rect: readonly [number, number, number, number];
}

/* One page's worth of extracted content. */
export interface PageSnapshot {
  /* 1-based, matching how a human refers to pages and how pdfjs numbers them. */
  readonly pageNumber: number;
  /* Page height in points, needed to convert a y into "distance from the top"
     when reporting a location to a human — nobody thinks in upward-growing
     coordinates. */
  readonly height: number;
  /* Text items in the order the PDF emitted them. NOT pre-sorted: whether that
     order is already reading order is a MEASURED property of the producer, and
     `layout.ts` re-derives it rather than trusting it. */
  readonly items: DocumentOrderedItems;
  readonly links: readonly LinkAnnotation[];
}

/* Named alias so the "this order came from the file, and may be a lie" caveat
   has somewhere to live that a reader cannot miss. */
export type DocumentOrderedItems = readonly TextItem[];

/* A whole PDF, reduced to the only things this package needs. */
export interface PdfSnapshot {
  /* The producer string, e.g. `pdfTeX-1.40.29`. Carried into the report because
     it is the single best predictor of layout risk: a Chromium-produced PDF
     emits text in DOM order, a LaTeX one in visual order, and a design tool may
     emit neither. A human triaging a bad extraction wants this first. */
  readonly producer: string | null;
  readonly pages: readonly PageSnapshot[];
}
