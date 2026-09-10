/* applyy - master profile ingest. The single import surface for this package.
 *
 * Import from '@applyy/master-ingest', never from a deep path like
 * '@applyy/master-ingest/src/reconcile.ts'. A deep import pins the consumer to
 * this package's internal file layout and makes it unsafe to reorganise, which
 * is the same rule shared-types states for itself.
 *
 * WHAT THIS PACKAGE IS. Given the previously-stored MasterProfile and a freshly
 * parsed incoming one, it carries node ids forward for nodes that are the same
 * thing and mints new ids only for genuinely new ones. Pure functions: no UI,
 * no network, no PDF, no database, no clock, no randomness.
 *
 * WHY IDS ARE THE WHOLE POINT. The AI tailoring a resume may only return
 * REFERENCES to existing node ids, never free text - which is what makes
 * "invent a skill Teja does not have" structurally impossible rather than
 * merely detectable. A PDF has no ids, so every re-upload would otherwise mint
 * fresh ones and silently re-identify every node, with nothing erroring
 * anywhere. See `reconcile.ts` for the full reasoning, including why a
 * MIS-CARRIED id is worse than a missing one.
 *
 * START HERE: `reconcileMasterProfile`. Everything else is exported because a
 * consumer needs it to render the report, to pin the threshold in a test, or to
 * check a profile it did not produce.
 */

/* The entry point, its input and output shapes, and the one error it throws. */
export {
  ReconciliationError,
  reconcileMasterProfile,
  type ReconcileInput,
  type ReconcileOutput,
} from './reconcile.ts';

/* The report: what was carried, minted, dropped and refused, plus the two
 * helpers a review UI needs. `nonExactCarries` is the important one - it is the
 * list a human MUST see, because the similarity threshold cannot be set safely
 * in either direction. */
export {
  needsHumanReview,
  nonExactCarries,
  type AmbiguityReason,
  type AmbiguousMatch,
  type CarriedNode,
  type DroppedNode,
  type MatchKindLabel,
  type MintReason,
  type MintedNode,
  type ReconciledKind,
  type ReconciliationReport,
} from './report.ts';

/* The global NodeId invariant, exported so a caller can check a profile this
 * package did not produce - a hand-edited one, or one read back out of the
 * database. Global across the ENTIRE profile, never per section. */
export {
  collectNodeIds,
  findDuplicateNodeIds,
  type DuplicateNodeId,
  type NodeIdOccurrence,
} from './node-id-uniqueness.ts';

/* The threshold and the metric. Exported so a caller can pin the value it is
 * relying on rather than inheriting a default that might change, and so the
 * ingest UI can display the number it is showing matches against. */
export {
  DEFAULT_BULLET_SIMILARITY_THRESHOLD,
  SCORE_TIE_TOLERANCE,
  diceSimilarity,
  scoresAreTied,
} from './similarity.ts';

/* Normalisation and tokenisation. Exported mainly so the PDF parser (phase 2,
 * same package) uses the SAME folds the matcher uses - two implementations of
 * "the same text" would let a bullet fail to match itself for reasons invisible
 * in the document. */
export { normaliseKey, tokenSet, tokenise } from './normalise.ts';

/* The per-kind match keys, exported for tests and for anything that needs to
 * explain WHY two nodes were considered the same thing. */
export {
  educationKey,
  experienceKey,
  linkKey,
  projectKey,
  skillKey,
  type MatchKey,
} from './match-keys.ts';

/* The deterministic assignment, exported because it is testable directly with
 * hand-written scores - where a wrong answer is visible - rather than only
 * through the reconciler, where it shows up as a plausible-looking id. */
export {
  assignDeterministically,
  type Assignment,
  type ScoredPair,
  type Tie,
  type TieAxis,
} from './assign.ts';
