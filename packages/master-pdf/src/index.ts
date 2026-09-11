/* @applyy/master-pdf - the FRONT half of the master-profile pipeline.
 *
 * WHAT THIS PACKAGE IS. It takes a resume PDF and produces a DRAFT
 * `MasterProfile` plus a report of what was extracted and what was lost. Its
 * sibling `@applyy/master-ingest` is the back half: it reconciles a freshly
 * parsed profile against the stored one and decides which node ids survive.
 * `master-ingest/README.md:4` says that package is "no PDF" by design; this is
 * the package that design was leaving room for.
 *
 * WHY IT MATTERS MORE THAN "A PARSER" SOUNDS. The product's trust model, from
 * `docs/PROGRESS.md`: the Tailor cannot express a lie, because it returns IDs
 * referencing master-profile items plus a reworded string for each, and typed
 * code rejects an id that does not exist. That makes THIS package the root of
 * the model - a fact that never escapes the PDF can never appear on any
 * tailored resume, and nothing downstream can notice its absence. Silent loss
 * here is permanent and invisible. That is why the report carries lists rather
 * than counts, and why `dropped` exists at all.
 *
 * THE NEGATIVE SPACE, which is a constraint and not an aspiration. Pure
 * functions over plain data: no database, no network, no clock, no randomness,
 * and NO PDF LIBRARY - see `load-pdf.ts`. Node builtins are used by the tests
 * only. The parse runs BROWSER-SIDE because Teja's resume must never leave his
 * machine before he accepts the draft, so everything here must import cleanly
 * in a browser, in a Deno Edge Function, and under `node --test`.
 *
 * START HERE: `extractProfile` in `extract.ts`.
 */

/* The input contract. A caller builds one of these with `loadPdfSnapshot`, or
   by hand in a test - which is the entire point of the seam. */
export type {
  LinkAnnotation,
  PageSnapshot,
  PdfSnapshot,
  TextItem,
} from './snapshot.ts';

/* The impure edge. Exported separately from everything else so a reader can see
   at a glance that exactly one function in this package touches a PDF library. */
export { loadPdfSnapshot } from './load-pdf.ts';
export type { PdfjsLike } from './load-pdf.ts';

/* Layout reconstruction. Exported because the extraction report's
   `readingOrderReconstructed` flag is only meaningful to a caller that can see
   what produced it. */
export { LINE_BAND_TOLERANCE_PT, measureDocument, measurePage } from './layout.ts';
export type { LayoutMeasurement, LineBand } from './layout.ts';

/* Link recovery - the part `getTextContent()` cannot do. */
export { linksOnLine, resolveLinks } from './links.ts';
export type { AnchoredLink, LinkResolution, UnanchoredLink } from './links.ts';

/* The report, and the review gate over it. `needsHumanReview` and
   `reviewableRows` are a derived pair on purpose: a UI that computes its own
   "is this clean" boolean will eventually disagree with the list it renders. */
export { needsHumanReview, reviewableRows } from './report.ts';
export type {
  DroppedText,
  ExtractedKind,
  ExtractedNode,
  ExtractionReport,
  ExtractionWarning,
  ReviewableRow,
  UnanchoredLinkRow,
} from './report.ts';
