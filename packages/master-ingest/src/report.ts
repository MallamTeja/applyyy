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
  | 'bullet';

/* HOW a node was matched, and this distinction is what the human review reads.
 *
 * `exact_key` and `exact_text` are certain: a normalised string was equal, so
 * there is nothing for a person to check. `fuzzy_text` is a JUDGEMENT the
 * threshold made, and it is the only value that requires a human. Collapsing
 * these into one "matched" flag would make the reviewable set unrecoverable
 * from the report. */
export type MatchKindLabel = 'exact_key' | 'exact_text' | 'fuzzy_text';

/* A node that kept its previous id. */
export interface CarriedNode {
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
  /* Human-readable identification of the node - a skill name, a company, the
     bullet text. The review UI needs this and should not have to re-walk the
     profile to find it. */
  readonly label: string;
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
export interface MintedNode {
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
export interface DroppedNode {
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
export interface AmbiguousMatch {
  readonly kind: ReconciledKind;
  readonly reason: AmbiguityReason;
  /* The reconciled parent whose scope the tie occurred in, for bullets. Null
     for top-level kinds. Present because it localises the problem: a tie inside
     one job is a much smaller thing than a tie across the profile - which this
     design makes impossible anyway. */
  readonly parentId: NodeId | null;
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

/* Whether this reconciliation needs a person before it can be stored.
 *
 * True when anything was decided by score, or when anything was refused. Both
 * halves matter: a fuzzy carry may be WRONG, and an ambiguity means an id was
 * dropped on the floor that a human might have been able to place. */
export function needsHumanReview(report: ReconciliationReport): boolean {
  return nonExactCarries(report).length > 0 || report.ambiguous.length > 0;
}
