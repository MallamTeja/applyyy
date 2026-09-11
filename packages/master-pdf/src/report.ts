/* What the extraction did, in a form a human can act on.
 *
 * LISTS, NEVER COUNTS - AND `dropped` IS THE ONE THAT PROVES IT. This package
 * inherits the rule stated at `master-ingest/src/report.ts:10-17`, and inherits
 * it for the same reason: "a count field is an invitation to render the count
 * and skip the list, and rendering the count is how this package silently stops
 * working." There are deliberately NO count fields anywhere in this file. A
 * caller that wants a number takes `.length` and therefore must already be
 * holding the rows.
 *
 * It matters more here than it does downstream. Reconciliation loses an id;
 * extraction loses a FACT, and a fact that never escapes the PDF can never
 * appear on any tailored resume. There is no later stage that notices - the
 * Tailor selects from what the master profile contains, so a dropped bullet is
 * not a bullet that fails to be selected, it is a bullet that never existed.
 * `dropped` is the only place that loss becomes visible to anyone.
 */

import type { NodeId } from '@applyy/shared-types';

/* Which part of the profile a row concerns. Mirrors `ReconciledKind` in
   master-ingest so a reviewer sees one vocabulary across both screens, plus
   `identity` and `unknown`, which exist here because extraction can encounter
   text before it has decided what section it is in - a state reconciliation
   never sees.

   A plain union rather than an enum: `tsconfig.base.json` sets
   `erasableSyntaxOnly`, under which a TypeScript enum throws at parse time on
   Node 24. */
export type ExtractedKind =
  | 'identity'
  | 'summary'
  | 'experience'
  | 'education'
  | 'project'
  | 'skill'
  | 'achievement'
  | 'certification'
  | 'link'
  | 'bullet'
  | 'unknown';

/* Text present in the PDF that became no node.
 *
 * Every field here answers a question the reviewer will ask in order: what was
 * it, where is it on the page, and why did the parser give up? A row missing
 * `reason` is a row that turns into a bug report instead of a fix. */
export interface DroppedText {
  /* The text itself, verbatim. Never normalised - the reviewer is comparing it
     against the PDF on screen, so it has to read the same. */
  readonly text: string;
  /* Distance from the top of the page in points, and the page it is on. Enough
     to find it by eye in a one-page document without a coordinate system. */
  readonly fromTop: number;
  readonly pageNumber: number;
  /* Why it was dropped, as a sentence a UI renders as-is. */
  readonly reason: string;
  /* The section being parsed when it was dropped, when that is known. */
  readonly section: ExtractedKind;
}

/* A URL that is in the document but could not be tied to visible text.
 *
 * Kept SEPARATE from `dropped` even though both are losses, because the two
 * need different actions. Dropped text means the parser could not read
 * something a human can see. An unanchored link means the parser read a URL
 * that a human probably CANNOT see - it may sit under an image or a glyph the
 * text layer omitted. "Check this text" and "there is an invisible link here"
 * are different instructions and merging them produces a list nobody can
 * triage. */
export interface UnanchoredLinkRow {
  readonly url: string;
  readonly fromTop: number;
  readonly pageNumber: number;
}

/* Something that DID become a node but is suspect.
 *
 * The distinction from `dropped` is the whole reason both exist: dropped is
 * "we lost this, look for it"; a warning is "we kept this, verify it". A UI
 * that merges them makes the reviewer re-derive which is which for every row. */
export interface ExtractionWarning {
  /* Stable machine-readable code, e.g. `placeholder_url`. Stable so a UI can
     style or group by it without parsing prose. */
  readonly code: string;
  /* One sentence, rendered as-is. */
  readonly message: string;
  /* The node it concerns, when the warning is about a specific node. Throwaway
     at this stage - see the id discussion in `extract.ts` - but it lets a UI
     scroll the reviewer to the right row. */
  readonly nodeId: NodeId | null;
}

/* A node this extraction produced.
 *
 * THIS IS THE LIST THAT REPLACES A COUNT. Rather than "3 achievements", the
 * report carries the three rows with their labels, so the sentence a reviewer
 * reads is "we found these three" and the check is a comparison against the
 * document rather than an act of faith in a number. */
export interface ExtractedNode {
  readonly kind: ExtractedKind;
  readonly nodeId: NodeId;
  /* A pre-rendered human label, e.g. the role-and-company string. Pre-rendered
     rather than composed by the UI, so the same node reads identically in the
     extraction screen and in the reconciliation screen - two renderings of one
     node that differ is a bug report waiting to happen. */
  readonly label: string;
  /* Where it came from, so a reviewer can find it in the PDF. */
  readonly fromTop: number;
  readonly pageNumber: number;
}

/* The whole outcome of one extraction. */
export interface ExtractionReport {
  /* Producer string from the PDF, e.g. `pdfTeX-1.40.29`, or null when absent.
     The single best predictor of layout risk, and the first thing anyone
     triaging a bad parse wants: a Chromium-produced PDF emits text in DOM
     order, a LaTeX one in visual order, a design tool may do neither. Recording
     it means a future parse against a DIFFERENT producer is detectable rather
     than silently degraded. */
  readonly producer: string | null;
  /* True when sorting actually moved text. See `layout.ts`. */
  readonly readingOrderReconstructed: boolean;
  /* The section headings that were matched, in document order. A reviewer
     checks this against the PDF first: a missing heading explains every
     downstream drop at once, which is a far better first question than working
     through the dropped rows one at a time. */
  readonly sectionsFound: readonly string[];
  readonly extracted: readonly ExtractedNode[];
  readonly dropped: readonly DroppedText[];
  readonly unanchoredLinks: readonly UnanchoredLinkRow[];
  readonly warnings: readonly ExtractionWarning[];
}

/* A row a human must look at before accepting the draft.
 *
 * Discriminated union rather than a flattened row, so the UI keeps the full
 * typed detail of whichever kind it is instead of collapsing everything to a
 * lowest common denominator of `{ message: string }`. */
export type ReviewableRow =
  | { readonly reviewKind: 'dropped'; readonly dropped: DroppedText }
  | { readonly reviewKind: 'unanchored_link'; readonly link: UnanchoredLinkRow }
  | { readonly reviewKind: 'warning'; readonly warning: ExtractionWarning };

/* Everything needing human attention, in the order a reviewer should see it.
 *
 * A FUNCTION, NOT A FIELD, for the reason master-ingest gives: a field is a
 * value a UI can render a `.length` of and move on from. Deriving it also makes
 * it impossible for the list and the boolean below to disagree.
 *
 * Order is deliberate: drops first because a lost fact is unrecoverable
 * downstream, unanchored links second because they are invisible in the
 * rendered document, warnings last because the data is at least present. */
export function reviewableRows(report: ExtractionReport): readonly ReviewableRow[] {
  return [
    ...report.dropped.map(
      (dropped): ReviewableRow => ({ reviewKind: 'dropped', dropped }),
    ),
    ...report.unanchoredLinks.map(
      (link): ReviewableRow => ({ reviewKind: 'unanchored_link', link }),
    ),
    ...report.warnings.map(
      (warning): ReviewableRow => ({ reviewKind: 'warning', warning }),
    ),
  ];
}

/* Does this extraction need a human before it can be trusted?
 *
 * Derived from `reviewableRows` rather than computed independently, so the
 * boolean and the list can never disagree. Two implementations of "is this
 * clean" is how a UI ends up showing a green tick above a list of problems. */
export function needsHumanReview(report: ExtractionReport): boolean {
  return reviewableRows(report).length > 0;
}
