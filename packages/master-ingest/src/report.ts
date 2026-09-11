/* What the reconciler tells a human about what it just did.
 *
 * THE REPORT IS NOT DIAGNOSTICS. It is the product. The similarity threshold in
 * `similarity.ts` cannot be set safely in either direction, which means the
 * reconciler's output is never self-certifying: the only real defence against a
 * wrongly-carried id is a person looking at the pair. So this report exists to
 * be RENDERED, and every entry carries enough text for a human to decide
 * without a second lookup - the previous id, the path, the label, the score.
 *
 * FOUR LISTS, NOT FOUR COUNTS, AND `dropped` IS THE ONE THAT PROVES IT. When a
 * project is deleted from the resume, older pinned applications still reference
 * its bullets. "3 dropped" tells a reader nothing they can act on; the list
 * tells them exactly which ids stopped existing, which is the only form in
 * which that fact is useful. The same argument applies to the other three, so
 * there are deliberately NO count fields anywhere in this file - a count field
 * is an invitation to render the count and skip the list, and rendering the
 * count is how this package silently stops working.
 */

import type { NodeId } from '@applyy/shared-types';

/* Which kind of node an entry is about.
 *
 * A plain string union rather than a TS `enum`: tsconfig.base.json sets
 * `erasableSyntaxOnly`, and an `enum` in a shared module RUNS under Deno and
 * THROWS at parse under Node 24 - a failure invisible to anyone developing
 * against Deno. */
export type ReconciledKind =
  | 'link'
  | 'skill'
  | 'experience'
  | 'education'
  | 'project'
  /* Added 2026-09-11 with the contract change that gave achievements,
     certifications and the summary real nodes. Each is a SEPARATE member rather
     than folded into an existing one: `kind` is what a review UI groups and
     filters by, so calling a certification a `project` would put it in the wrong
     bucket on screen, and calling it `bullet` would lose the distinction the
     report exists to show. */
  | 'achievement'
  | 'certification'
  /* The summary is a single node, not a section, and it still needs a kind: it
     has an id, so it can be carried, minted or dropped like anything else, and a
     report entry with no kind for it could not be rendered. */
  | 'summary'
  | 'bullet';

/* HOW a node was matched, and this distinction is what the human review reads.
 *
 * `exact_key` and `exact_text` are certain: a normalised string was equal, so
 * there is nothing for a person to check. `fuzzy_text` is a JUDGEMENT the
 * threshold made, and it is the only value that requires a human. Collapsing
 * these into one "matched" flag would make the reviewable set unrecoverable
 * from the report. */
export type MatchKindLabel = 'exact_key' | 'exact_text' | 'fuzzy_text';

/* WHERE A ROW SITS, for the three lists that describe individual nodes.
 *
 * WHY EVERY ROW CARRIES ITS PARENT, and this is the correction that matters
 * most in the file. The failure this package exists to prevent is a TRUE bullet
 * appearing under the WRONG parent. So a review row reading "Cut p95 latency
 * 40% - reworded" is not reviewable on its own: it is only reviewable beside
 * "...under Full Stack AI Engineer at Northwind Systems". Without the parent, a
 * reviewer can confirm the wording and still miss the one error that matters.
 *
 * THE FIRST VERSION OF THIS FILE PUT `parentId` ON `AmbiguousMatch` ONLY, which
 * was exactly the wrong list to have it on. `ambiguous` is where the reconciler
 * REFUSED to decide, so a human is already looking hard. The dangerous list is
 * `carried` with `match: 'fuzzy_text'` - where a decision WAS made, silently,
 * by a score. Caught by applyyy-20 reading the shipped code against a claim
 * that it already carried this. It did not.
 *
 * `parentLabel` IS THE RENDERED FORM, not the components, so that every
 * consumer shows the same string. Handing out `{ company, role }` guarantees
 * two callers join them differently and Teja sees one wording in the review and
 * another in the diff. */
export interface NodePlacement {
  /* The RECONCILED parent's id for a bullet - the id that will be in the stored
     profile, not the throwaway one the parse produced. Null for a top-level
     node (a skill, a link, or a parent itself), which has no parent rather than
     an unknown one. */
  readonly parentId: NodeId | null;
  /* Pre-rendered, e.g. "Full Stack AI Engineer at Northwind Systems". Null
     exactly when `parentId` is null. */
  readonly parentLabel: string | null;
}

/* A node that kept its previous id. */
export interface CarriedNode extends NodePlacement {
  readonly kind: ReconciledKind;
  /* The id that now sits on the output node - the PREVIOUS one. This is the
     whole purpose of the package: this id is what old pinned applications
     reference. */
  readonly id: NodeId;
  /* The id the fresh parse had put on this node, now discarded. Kept so a
     debugging session can trace a node back to what the parser produced; it is
     never meaningful on its own, because a parser mints throwaway ids. */
  readonly supersededId: NodeId;
  /* Dotted path in the OUTPUT profile, e.g. `experience[1].bullets[2]`. Same
     convention as the ingest validator in apps/web, deliberately: an operator
     can search for the identical string in the JSON either tool complains
     about. */
  readonly path: string;
  readonly match: MatchKindLabel;
  /* Dice score for `fuzzy_text`; null for both exact kinds, because an exact
     match has no score and reporting 1.0 would make an exact match
     indistinguishable from a fuzzy match that happened to score 1.0. */
  readonly similarity: number | null;
  /* Human-readable identification of the node as it is NOW - a skill name, a
     company, the full bullet text. Not truncated: the review UI renders this,
     and a real bullet runs to 150-200 characters, so an abbreviation would cut
     every row mid-sentence. */
  readonly label: string;
  /* The same, as it was in the STORED profile.
   *
   * REQUIRED FOR THE REPORT TO MEET ITS OWN STATED GOAL. A fuzzy carry is
   * reviewed by reading previous against incoming side by side; the score alone
   * is just a number to nod at. And this is the one field a caller cannot
   * recover from the output profile, because the previous text is precisely
   * what the output replaced - so without it the review needs a second lookup
   * into a second profile, which the header of this file promises it will not.
   *
   * Differs from `label` only when the text actually changed, so a consumer can
   * compare the two rather than being told which kind of match it was. */
  readonly previousLabel: string;
}

/* WHY a node got a fresh id. Five distinct reasons, and they are not
 * interchangeable: `no_previous_profile` is the first-upload case where minting
 * everything is correct, whereas `ambiguous` means the reconciler REFUSED to
 * decide and a human should look. A single "minted" flag would hide that
 * difference. */
export type MintReason =
  /* First ever upload: there is nothing to carry from. */
  | 'no_previous_profile'
  /* The parent this node hangs under is itself new, so there was no previous
     parent to search inside. Recorded separately because it is the CASCADE
     case - one unmatched parent mints every bullet under it, and a reader
     seeing many of these should go look at the parent, not at the bullets. */
  | 'new_parent'
  /* Nothing in the previous pool had this match key at all, or no previous
     bullet scored above zero. Genuinely new content. */
  | 'no_candidate'
  /* There WAS a best candidate and it scored below the threshold. The
     interesting reason: it is either genuinely new content or a rewording the
     threshold was too high to see, and the report cannot tell which. */
  | 'below_threshold'
  /* There was a candidate above the threshold, but another incoming node had a
     strictly better claim on it and took it. Distinct from `below_threshold`
     because the score was good enough - what failed was the competition, not
     the similarity - and distinct from `ambiguous` because the contest was
     decided rather than tied. Worth a human glance: two bullets scoring highly
     against one previous bullet usually means one of them is a rewording of it
     and the other is new. */
  | 'candidate_taken'
  /* Two or more candidates were equally good, so carrying either would have
     been a coin flip. Refusing is the correct answer and this is where a human
     is genuinely needed. */
  | 'ambiguous';

/* A node that received a freshly minted id. */
export interface MintedNode extends NodePlacement {
  readonly kind: ReconciledKind;
  readonly id: NodeId;
  readonly path: string;
  readonly reason: MintReason;
  readonly label: string;
  /* The best score seen for this node, when a scored comparison happened at
     all. Null for the key-matched kinds and for the no-candidate case. Present
     for `below_threshold`, where it is the single most useful number in the
     whole report: it says how close the threshold came to carrying. */
  readonly bestScore: number | null;
}

/* A previous node with no counterpart in the incoming profile.
 *
 * THIS IS THE ENTRY THAT EARNS THE LIST-NOT-COUNT RULE. A dropped id is not a
 * cleanup detail: pinned applications and frozen resolved resumes still refer
 * to it, so it is a dangling reference somebody has to decide about. */
export interface DroppedNode extends NodePlacement {
  readonly kind: ReconciledKind;
  readonly id: NodeId;
  /* Path in the PREVIOUS profile - the output has no such node, so an
     output-relative path would be a lie. */
  readonly previousPath: string;
  readonly label: string;
}

/* Why the reconciler refused to decide. */
export type AmbiguityReason =
  /* Two or more nodes shared one match key, and the tiebreak did not separate
     them either. */
  | 'duplicate_match_key'
  /* Two or more bullets scored identically, so the threshold has no information
     to choose with. Per the design: a tie is exactly the case where a
     similarity score cannot resolve anything, and a silent pick is the
     misattribution this package exists to prevent. */
  | 'tied_similarity';

/* One refusal to guess. Reported instead of resolved, on purpose.
 *
 * Every ambiguity is ALSO represented in `minted`, with reason `ambiguous`.
 * That redundancy is deliberate: `minted` answers "what happened to this node"
 * and `ambiguous` answers "what should a human look at", and a reader of either
 * list gets a complete answer without having to join the two. */
export interface AmbiguousMatch extends NodePlacement {
  readonly kind: ReconciledKind;
  readonly reason: AmbiguityReason;
  /* Path of the INCOMING node that could not be resolved. */
  readonly path: string;
  /* The previous ids that tied. The human decides between exactly these. */
  readonly candidateIds: readonly NodeId[];
  /* The tied score, for `tied_similarity`; null for a duplicate key, where
     nothing was scored. */
  readonly score: number | null;
  /* One sentence a UI can render as-is, naming what tied and what was done
     about it. The report is meant to be read by a person under time pressure. */
  readonly detail: string;
}

/* The whole outcome of one reconciliation. */
export interface ReconciliationReport {
  readonly carried: readonly CarriedNode[];
  readonly minted: readonly MintedNode[];
  readonly dropped: readonly DroppedNode[];
  readonly ambiguous: readonly AmbiguousMatch[];
}

/* The set of carries a human MUST look at.
 *
 * Exists as a function rather than as a field on the report for one reason: a
 * field is a value a UI can render a `.length` of and move on, whereas calling
 * this function returns the rows themselves. The threshold cannot be set safely
 * in either direction, so this list - previous text against incoming text, with
 * the score - is the only actual defence in the design. A UI that shows a count
 * here has removed it. */
export function nonExactCarries(report: ReconciliationReport): readonly CarriedNode[] {
  return report.carried.filter((entry) => entry.match === 'fuzzy_text');
}

/* Mint reasons that a person has to look at.
 *
 * The other three are not judgements: `no_previous_profile` is a first upload,
 * `no_candidate` is content with no counterpart at all, and `new_parent` is the
 * cascade already made visible by its parent's own row. Asking for an
 * acknowledgement on those buries the three that matter in a wall of noise -
 * and a reviewer who is shown too much stops reading, which is the failure mode
 * this whole report is shaped around. */
const REVIEWABLE_MINT_REASONS: readonly MintReason[] = [
  /* Close enough that it may be a rewording the threshold could not see. */
  'below_threshold',
  /* Two bullets both scored well against one previous bullet; usually one is a
     rewording and the other is new, and only a human knows which. */
  'candidate_taken',
];

/* NOT IN THAT LIST, DELIBERATELY: `ambiguous`.
 *
 * Every ambiguity appears in BOTH `minted` (reason `ambiguous`) and
 * `ambiguous`, which is intentional - each list answers a different question
 * completely. But a REVIEW GATE must count each decision once. Including it
 * here would make one refusal produce two rows: the rich one naming the tied
 * candidates, and a bare mint saying nothing the other did not. A reviewer
 * reads that as two problems, and a per-row acknowledgement gate would demand
 * two acknowledgements for one decision.
 *
 * The `ambiguous` row is the one that survives, because it is the one carrying
 * the candidate ids and the `detail` sentence. Found by applyyy-20 reaching the
 * same conclusion independently while building the render adapter - which is
 * the useful kind of agreement, since we got there from opposite ends. */

/* ONE ROW A PERSON MUST ACKNOWLEDGE, tagged by why.
 *
 * A discriminated union rather than four separate getters, because the consumer
 * gates the accept button on EVERY reviewable row having been acknowledged
 * individually - so it needs one enumerable set, not four lists it has to
 * remember to concatenate. Forgetting one of four lists is silent; forgetting
 * to handle a variant of this union is a compile error. */
export type ReviewableRow =
  /* An id was carried by SCORE. The dangerous case: a decision was made
     silently, and this is where a misattribution would be. */
  | { readonly reviewKind: 'fuzzy_carry'; readonly carried: CarriedNode }
  /* The reconciler refused to decide and named the candidates. */
  | { readonly reviewKind: 'ambiguous'; readonly ambiguous: AmbiguousMatch }
  /* A fresh id where a rewording was plausible. */
  | { readonly reviewKind: 'uncertain_mint'; readonly minted: MintedNode }
  /* A node that was in the stored profile and is NOT in the new one.
   *
   * EVERY dropped row is reviewable, including on a deliberate deletion, and
   * that is the point rather than an oversight. If the PDF parse loses a bullet
   * - a layout quirk, a ligature, a column boundary - Teja sees an otherwise
   * clean list, accepts it, and a true achievement disappears from every future
   * resume with nothing anywhere reporting a problem. Making him acknowledge
   * the deletion he MEANT is the price of catching the one he did not. */
  | { readonly reviewKind: 'dropped'; readonly dropped: DroppedNode };

/* Every row a person must acknowledge before this reconciliation is stored.
 *
 * THE POLICY LIVES HERE AND NOWHERE ELSE. A consumer that reimplements "which
 * rows are risky" will drift from this one, and the two will disagree about the
 * only question that matters. Exported for exactly that reason. */
export function reviewableRows(report: ReconciliationReport): readonly ReviewableRow[] {
  return [
    ...nonExactCarries(report).map(
      (carried): ReviewableRow => ({ reviewKind: 'fuzzy_carry', carried }),
    ),
    ...report.ambiguous.map(
      (ambiguous): ReviewableRow => ({ reviewKind: 'ambiguous', ambiguous }),
    ),
    ...report.minted
      .filter((minted) => REVIEWABLE_MINT_REASONS.includes(minted.reason))
      .map((minted): ReviewableRow => ({ reviewKind: 'uncertain_mint', minted })),
    ...report.dropped.map((dropped): ReviewableRow => ({ reviewKind: 'dropped', dropped })),
  ];
}

/* Whether this reconciliation needs a person before it can be stored.
 *
 * Derived from `reviewableRows` rather than computed separately, so the boolean
 * and the list can never disagree - a UI that says "nothing to review" while
 * the list has three rows in it is worse than either answer alone.
 *
 * NOTE FOR CONSUMERS: this is a "should a human look" signal, NOT "refuse to
 * store". Gating the accept button on `false` would make a reworded bullet
 * unacceptable rather than reviewable, and Teja would be stuck with no way
 * forward. Gate on every reviewable row having been acknowledged instead. */
export function needsHumanReview(report: ReconciliationReport): boolean {
  return reviewableRows(report).length > 0;
}
