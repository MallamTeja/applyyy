/* Turning a reconciliation report into the list of things a person must look at.
 *
 * WHY THIS EXISTS AS A PURE MODULE. The reconciler in `@applyy/master-ingest`
 * decides which node ids carry across a re-upload. Its own header says the
 * similarity threshold cannot be set safely in either direction: the same
 * bullet reworded scores 0.667, while two genuinely different bullets score
 * 0.75. The false pair scores HIGHER than the true pair, so no cut point
 * separates them. That means the reconciler's output is never self-certifying
 * and the human review is not a nicety over a mostly-correct matcher - it is
 * the only actual defence. This module decides what goes in front of the human,
 * so it is the safety property, and it is pure so it can be tested directly.
 *
 * THE FAILURE BEING DEFENDED AGAINST is `misattributed_bullet`: a true bullet
 * appearing under the wrong employer. Every individual claim survives a
 * fact-check and the resume is still a lie. That is why a review row is
 * useless without its PARENT - "Cut p95 latency 40% - reworded" reads fine and
 * hides that the bullet moved from Northwind to Helios.
 *
 * THE CONSTRAINT THAT SHAPES EVERYTHING HERE: he will stop proof-reading by the
 * third re-upload. So a clean re-upload has to be a five-second glance and a
 * suspicious one has to be loud. Every choice below trades against that one
 * sentence - in particular, nothing that needs a decision is ever collapsed,
 * counted, or mixed in with something that does not.
 *
 * WHY THIS SITS BETWEEN THE REPORT AND THE COMPONENT rather than the component
 * reading the report directly. `ReviewRow` is an anti-corruption layer: the
 * reconciler's contract is young and still moving, and while it moved this
 * week only this file changed. It has already paid for itself once - the first
 * version of this module reconstructed each row's parent by walking the
 * profile, because the report did not carry one; when `NodePlacement` landed,
 * that derivation was deleted and the component did not move a line.
 */

/* The review POLICY - which rows are risky - is imported, never restated. See
   the note above `toReviewRow` for why this import is load-bearing rather than
   a convenience. */
import { reviewableRows } from '@applyy/master-ingest';
import type {
  AmbiguousMatch,
  CarriedNode,
  DroppedNode,
  MintedNode,
  ReconciliationReport,
  ReviewableRow,
} from '@applyy/master-ingest';

/* --- Line reflow ------------------------------------------------------- */

/* Whether two texts differ only by where lines were broken.
 *
 * WHY THIS IS A UI CONCERN AND NOT A PARSER BUG. The resume is justified
 * LaTeX, which hyphenates across line breaks ("Post-\ngreSQL"). Where LaTeX
 * chooses to break depends on every word before it, so adding a sentence early
 * in the document moves a hyphen inside a bullet nobody edited - changing its
 * tokens, dropping its similarity score, and flagging it as changed.
 *
 * The parser de-hyphenates, so most of these never arrive. This exists for the
 * ones that do, because of what happens if they arrive unexplained: he sees
 * the diff flag bullets he did not touch and cannot see any difference in,
 * learns the diff is noisy, and starts clicking accept without reading. A diff
 * a user has learned to distrust is worse than no diff at all - it is the
 * theatre outcome wearing the costume of a safeguard. Saying "probably just
 * line reflow" keeps the flag honest and keeps the loud ones loud. */
export function looksLikeReflow(previous: string, incoming: string): boolean {
  return foldReflow(previous) === foldReflow(incoming);
}

function foldReflow(value: string): string {
  return (
    value
      /* A hyphen immediately before whitespace is LaTeX's line-break hyphen,
         never a real one - a real hyphen ("state-of-the-art") has a letter on
         both sides. Removing the hyphen AND the break rejoins the word. */
      .replace(/-\s+/g, '')
      /* Any remaining run of whitespace, including the newlines a PDF extract
         is full of, is not a difference a reader would see. */
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase()
  );
}

/* --- The review model -------------------------------------------------- */

/* Why one row is in front of the human. Four causes, kept apart because the
 * remedy differs and a merged "needs attention" flag would hide that: a fuzzy
 * carry needs the pair read side by side, an ambiguity needs him to pick, a
 * drop needs him to know a pinned application now dangles, and an uncertain
 * mint needs him to notice a rewording the threshold could not see. */
export type ReviewCause = 'fuzzy_carry' | 'ambiguous' | 'dropped' | 'uncertain_mint';

export interface ReviewRow {
  /* Stable across renders: the node id plus the cause, because one node can in
     principle appear under two causes and an index-based key would reorder
     wrongly as rows resolve. */
  readonly key: string;
  readonly cause: ReviewCause;
  /* The job or project this sits under, when it is a bullet. THE FIELD THAT
     CATCHES MISATTRIBUTION - a row without it cannot show the only error that
     really matters. Comes from the report's own `NodePlacement`. */
  readonly parentLabel: string | null;
  /* What the node says now. */
  readonly label: string;
  /* What the matched previous node said, for a fuzzy carry. Null when there is
     no counterpart - a mint has nothing to compare against, and a drop has no
     incoming side. */
  readonly previousLabel: string | null;
  /* The score, when one was computed. Rendered next to the pair rather than
     alone: a number with nothing to compare is something to nod at. */
  readonly similarity: number | null;
  /* True when previous and incoming differ only by line breaking. Keeps a
     reflow from reading as an edit. */
  readonly reflowSuspected: boolean;
  /* One sentence saying what happened and what it means, in the interface's
     voice, ready to render. */
  readonly detail: string;
}

export interface MasterReview {
  /* Everything that needs a decision, in the order it should be read. */
  readonly rows: readonly ReviewRow[];
  /* Ids that carried on an exact match. Nothing to check - a normalised string
     was equal. Safe to collapse, and the only part of this screen that is. */
  readonly settled: readonly CarriedNode[];
  /* Fresh ids for an unsurprising reason: first upload, a new parent, or
     nothing remotely similar. Also nothing to check. */
  readonly plainlyNew: readonly MintedNode[];
}

/* Sort order for the review list. Not alphabetical and not source order:
 * ambiguity first because the reconciler refused outright, then fuzzy carries
 * because those are decisions it MADE by score and could have made wrongly,
 * then drops, then near-miss mints. Reading order is risk order. */
const CAUSE_ORDER: readonly ReviewCause[] = [
  'ambiguous',
  'fuzzy_carry',
  'dropped',
  'uncertain_mint',
];

/* Render one policy row as one screen row.
 *
 * WHY THIS FUNCTION IS THE WHOLE POINT OF THE REFACTOR THAT INTRODUCED IT.
 * `report.ts:288` states the rule it is obeying: "THE POLICY LIVES HERE AND
 * NOWHERE ELSE. A consumer that reimplements 'which rows are risky' will drift
 * from this one, and the two will disagree about the only question that
 * matters." This module used to do exactly that - it kept its own
 * `MINT_REASONS_NEEDING_REVIEW = ['below_threshold', 'candidate_taken']`, a
 * literal copy of `REVIEWABLE_MINT_REASONS`, and rebuilt the row set from the
 * four report arrays by hand. The two agreed, but only by coincidence: nothing
 * connected them, so the first change to the package's policy would have
 * silently stopped reaching this screen. A row that quietly leaves this list is
 * a `misattributed_bullet` nobody is asked about.
 *
 * WHAT THIS MODULE STILL LEGITIMATELY OWNS, because the distinction matters:
 * the package decides WHICH rows a human must see; this file decides HOW one
 * reads. `ReviewRow` stays an anti-corruption layer over a young contract - the
 * argument in this file's header is unchanged and still correct. What is gone
 * is the second opinion about risk.
 *
 * A SWITCH OVER THE DISCRIMINATED UNION rather than four filters, and that is
 * the payoff `report.ts:266` promises: "forgetting one of four lists is silent;
 * forgetting to handle a variant of this union is a compile error." With
 * `noFallthroughCasesInSwitch` and no default branch, a fifth `reviewKind` added
 * upstream fails the typecheck here instead of vanishing from the screen. */
function toReviewRow(row: ReviewableRow): ReviewRow {
  switch (row.reviewKind) {
    /* The dangerous case: an id carried by SCORE, where a wrong decision was
       made silently and looks like a right one. */
    case 'fuzzy_carry':
      return fuzzyCarryRow(row.carried);
    /* The reconciler refused and named the candidates, so the richer row wins -
       which is also why the package deliberately keeps `ambiguous` out of its
       reviewable MINT reasons rather than this file filtering it out again. */
    case 'ambiguous':
      return ambiguousRow(row.ambiguous);
    case 'uncertain_mint':
      return uncertainMintRow(row.minted);
    case 'dropped':
      return droppedRow(row.dropped);
  }
}

export function buildMasterReview(report: ReconciliationReport): MasterReview {
  /* ONE call, and it is the single source of what counts as risky. Everything
     below is derived from this array rather than re-filtered off the report. */
  const reviewable = reviewableRows(report);

  const rows: ReviewRow[] = reviewable.map(toReviewRow);

  /* Sort by risk. `CAUSE_ORDER.indexOf` rather than a comparator chain because
     the order IS that named constant - stated once, changed in one place.
     Sorting HERE rather than trusting `reviewableRows`' own order is
     deliberate: that function's order is an implementation detail of the
     package, and reading order is a decision this screen owns. */
  rows.sort((a, b) => CAUSE_ORDER.indexOf(a.cause) - CAUSE_ORDER.indexOf(b.cause));

  /* The ids the policy actually flagged, so the two collapsible lists below are
     the exact COMPLEMENT of what is on screen rather than a second guess at it.
     Keyed by id alone, which is sound precisely because the global NodeId
     uniqueness invariant holds - the same invariant `findDuplicateNodeIds`
     enforces. Under per-section uniqueness this would silently collapse a skill
     and a bullet that happened to share an id. */
  const flaggedCarries = new Set(
    reviewable.filter((row) => row.reviewKind === 'fuzzy_carry').map((row) => row.carried.id),
  );
  const flaggedMints = new Set(
    reviewable.filter((row) => row.reviewKind === 'uncertain_mint').map((row) => row.minted.id),
  );

  return {
    /* Everything the policy did NOT flag. Derived by exclusion so a carry can
       never be both shown and collapsed, nor fall between the two. */
    settled: report.carried.filter((entry) => !flaggedCarries.has(entry.id)),
    rows,
    /* `ambiguous` mints are excluded separately, and this is the one piece of
       report-shape knowledge this file legitimately keeps: every ambiguity is
       ALSO listed in `minted` with that reason, and it is already on screen as
       its richer `ambiguous` row. Collapsing it into "plainly new" would tell
       Teja a node he is being asked to adjudicate is nothing to worry about. */
    plainlyNew: report.minted.filter(
      (entry) => !flaggedMints.has(entry.id) && entry.reason !== 'ambiguous',
    ),
  };
}

/* Whether this re-upload changes any node's IDENTITY.
 *
 * THE DISTINCTION THIS NAME IS CAREFUL ABOUT, because conflating it is how an
 * edit gets silently discarded. "No identity changes" means every node kept the
 * id it had: nothing minted, nothing dropped, nothing refused, nothing carried
 * by a score. It does NOT mean the profile is unchanged. The reconciler matches
 * on normalised text and match keys, so a bullet whose `tags` were edited, or a
 * date that was corrected, carries EXACTLY and is reported nowhere - the
 * content changed and this predicate is still true.
 *
 * That is why this decides the SCREEN and never the store. It answers "is there
 * anything for Teja to check", which is what `masterReview.ts` exists for and
 * what makes a clean re-upload the five-second glance its header demands. The
 * question "is this byte-identical to what is already stored" is a different
 * one with a different answer, and only the database can answer it - via the
 * `UNIQUE (user_id, content_hash)` constraint, on the normalised jsonb, where a
 * tags edit really does produce a different digest.
 *
 * Derived from the rows rather than from the report, for the same reason
 * `isCleanReview` is: a predicate that disagrees with what the screen lists is
 * worse than no predicate. */
export function noNodeIdentityChanges(review: MasterReview): boolean {
  return review.rows.length === 0 && review.plainlyNew.length === 0;
}

/* Whether this upload can be stored without anyone looking at it.
 *
 * Deliberately derived from the ROWS rather than from the report, so it cannot
 * disagree with what the screen actually shows. A predicate that says "clean"
 * while the screen lists four things to check is worse than no predicate. */
export function isCleanReview(review: MasterReview): boolean {
  return review.rows.length === 0;
}

function ambiguousRow(entry: AmbiguousMatch): ReviewRow {
  return {
    key: entry.path + ':ambiguous',
    cause: 'ambiguous',
    parentLabel: entry.parentLabel,
    /* The path, because an ambiguity is about a position the reconciler could
       not fill rather than about a node that exists. */
    label: entry.path,
    previousLabel: null,
    similarity: entry.score,
    reflowSuspected: false,
    /* The reconciler's own sentence, rendered as written. It names what tied
       and what was done, and rewording it here would be a second voice
       describing the same event. */
    detail: entry.detail,
  };
}

function fuzzyCarryRow(entry: CarriedNode): ReviewRow {
  const reflow = looksLikeReflow(entry.previousLabel, entry.label);
  return {
    key: entry.id + ':fuzzy',
    cause: 'fuzzy_carry',
    parentLabel: entry.parentLabel,
    label: entry.label,
    previousLabel: entry.previousLabel,
    similarity: entry.similarity,
    reflowSuspected: reflow,
    detail: reflow
      ? 'These read the same once line breaks are ignored, so this is probably the document reflowing rather than an edit.'
      : 'Matched by similarity rather than exactly. Check it is the same point, under the same job.',
  };
}

function droppedRow(entry: DroppedNode): ReviewRow {
  return {
    key: entry.id + ':dropped',
    cause: 'dropped',
    parentLabel: entry.parentLabel,
    label: entry.label,
    previousLabel: null,
    similarity: null,
    reflowSuspected: false,
    /* Says the consequence, not the event. "Removed" is the event and sounds
       like tidying; the consequence is that applications already sent point at
       something that will no longer exist. */
    detail:
      'This is in your current profile and not in the upload. Applications already built from it still reference it.',
  };
}

function uncertainMintRow(entry: MintedNode): ReviewRow {
  return {
    key: entry.id + ':minted',
    cause: 'uncertain_mint',
    parentLabel: entry.parentLabel,
    label: entry.label,
    previousLabel: null,
    similarity: entry.bestScore,
    reflowSuspected: false,
    detail:
      entry.reason === 'below_threshold'
        ? 'Treated as new, but something close to it already existed. If it is a rewording, this will read as a new point and the original will look dropped.'
        : 'Treated as new because another line had a better claim on the one it resembled. Usually right, occasionally the wrong way round.',
  };
}
