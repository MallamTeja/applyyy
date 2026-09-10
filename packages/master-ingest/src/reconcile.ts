/* Carrying node ids forward across a re-upload.
 *
 * THE PROBLEM, because it is not obvious and it drives every decision below.
 * The master resume is built in Overleaf and re-uploaded whenever a project or
 * a skill is added. A PDF has no node ids, so a naive re-parse mints brand-new
 * ones for everything and silently RE-IDENTIFIES every node. Nothing errors:
 * the database still sees a valid version, the composite foreign key stays
 * satisfied, and the ids inside simply stop meaning what older applications
 * assumed they meant.
 *
 * And a mis-carried id is worse than a broken one. A broken reference fails
 * loudly at resolution. A mis-carried id re-parents a TRUE bullet under the
 * WRONG employer, producing fabricated experience assembled entirely out of
 * true parts - where every individual claim survives a fact-check. That failure
 * has a name in this repo: `misattributed_bullet`.
 *
 * FOUR DECISIONS, AND THE FIRST ONE IS THE LOAD-BEARING ONE:
 *
 * 1. PARENTS ARE RECONCILED FIRST, AND BULLETS ARE MATCHED ONLY WITHIN THEIR
 *    ALREADY-RECONCILED PARENT. Matching bullets globally would let a bullet
 *    migrate between employers whenever its text happened to score well - which
 *    is the misattribution above, arrived at by a mechanism nobody would
 *    notice. Scoping the search to one parent makes cross-parent migration
 *    UNREPRESENTABLE rather than merely unlikely: there is no code path that
 *    can express it, so no threshold setting and no future refactor can produce
 *    it. Prefer a design where the wrong answer cannot be written down over a
 *    design that detects it.
 *
 * 2. DIFFERENT MATCH KEYS PER KIND, because the kinds have different stability.
 *    See `match-keys.ts`. Bullets are the ONLY fuzzy match, because bullets are
 *    the only thing that gets reworded between uploads.
 *
 * 3. AMBIGUITY FAILS LOUD; IT NEVER GUESSES. A tie is precisely the case where
 *    a similarity threshold has no information to resolve anything, so it is
 *    reported in `ambiguous` and both nodes get fresh ids. See `assign.ts`.
 *
 * 4. `mintId` IS INJECTED, NEVER AMBIENT. It keeps src/ free of every Node API
 *    so Deno, Node and the browser can all import this file, and it makes every
 *    test deterministic without stubbing a global.
 *
 * WHAT THIS FILE NEVER DOES: no network, no database, no PDF, no UI, no clock,
 * no randomness. Given the same three inputs it returns the same two outputs,
 * which is the property that makes a wrong answer reproducible.
 *
 * AN INCOMING ID IS NEVER USED AS AN OUTPUT ID. Unmatched nodes get a MINTED
 * id, not the id the parser happened to put on them. This is not tidiness: a
 * parser that labels bullets positionally would produce `bullet-0` on every
 * upload, and keeping that id would let a brand-new first bullet inherit the
 * identity of last month's first bullet - a misattribution with no similarity
 * score anywhere in its causal chain. So incoming ids are treated as
 * positional labels with no meaning, which is all they are.
 */

import type {
  MasterBullet,
  MasterEducation,
  MasterExperience,
  MasterLink,
  MasterProfile,
  MasterProject,
  MasterSkill,
  NodeId,
} from '@applyy/shared-types';
import { assignDeterministically, type ScoredPair } from './assign.ts';
import {
  educationKey,
  experienceKey,
  linkKey,
  projectKey,
  skillKey,
  type MatchKey,
} from './match-keys.ts';
import { normaliseKey, tokenSet } from './normalise.ts';
import { findDuplicateNodeIds } from './node-id-uniqueness.ts';
import { DEFAULT_BULLET_SIMILARITY_THRESHOLD, diceSimilarity } from './similarity.ts';
import type {
  AmbiguousMatch,
  CarriedNode,
  DroppedNode,
  MintedNode,
  MintReason,
  ReconciledKind,
  ReconciliationReport,
} from './report.ts';

/* Thrown when a CALLER broke a contract, as opposed to when the DATA is
 * awkward. The distinction is the whole reason this is an exception rather than
 * a report entry: awkward data (a tie, a deleted project) is expected and is
 * reported for a human to read, whereas a duplicate id in the stored profile or
 * a `mintId` that repeats itself means every guarantee downstream is already
 * void and continuing would launder a corrupt id space into a new version. */
export class ReconciliationError extends Error {
  constructor(message: string) {
    super(message);
    /* Set explicitly: extending a builtin loses the subclass name in some
       transpile targets, and `error.name` is what a log line shows. */
    this.name = 'ReconciliationError';
  }
}

export interface ReconcileInput {
  /* The profile currently stored - null on the very first upload. Null rather
     than an empty profile so "first upload" is a distinguishable state in the
     report instead of looking like a resume that lost every section. */
  readonly previous: MasterProfile | null;
  /* The freshly parsed profile. Its content wins; only its IDS are subject to
     replacement. */
  readonly incoming: MasterProfile;
  /* Mints a fresh, globally unique NodeId. Injected - see decision 4. */
  readonly mintId: () => NodeId;
  /* Overrides the bullet similarity threshold. Optional with a documented
     default, so a caller inherits a value it can see rather than one buried in
     this module. */
  readonly similarityThreshold?: number;
}

export interface ReconcileOutput {
  /* The incoming content with reconciled ids. This is what becomes version
     N+1. */
  readonly profile: MasterProfile;
  readonly report: ReconciliationReport;
}

/* Mutable state threaded through the walk. One object rather than five
 * parameters, so adding a report list later does not touch every signature. */
interface Accumulator {
  readonly carried: CarriedNode[];
  readonly minted: MintedNode[];
  readonly dropped: DroppedNode[];
  readonly ambiguous: AmbiguousMatch[];
  readonly mintId: () => NodeId;
  readonly threshold: number;
  /* True when `previous` was null. Checked before every other mint reason so
     the first upload reports `no_previous_profile` for everything rather than
     hundreds of misleading `no_candidate` entries. */
  readonly firstUpload: boolean;
}

/* The renderable form of a bullet's text.
 *
 * Whitespace collapsed and NOT truncated. An earlier version cut this at 80
 * characters to keep report entries small, which was wrong for the one use the
 * report has: a real resume bullet runs to 150-200 characters, so every review
 * row would have been cut mid-sentence - and a fuzzy carry is reviewed by
 * reading the previous text against the incoming text. The report is the
 * product, not a log, so it carries what a person needs to read. */
function labelFor(text: string): string {
  return text.replace(/\s+/gu, ' ').trim();
}

/* --- Exact key matching, shared by every non-bullet kind ---------------- */

interface KeyedMatch {
  /* incoming index -> previous index. Only unambiguous pairs appear. */
  readonly matched: ReadonlyMap<number, number>;
  /* incoming index -> the previous indexes that tied for it. */
  readonly ambiguous: ReadonlyMap<number, readonly number[]>;
}

/* Groups indexes by a key string. Used four times over, which is why it is not
 * inlined: four hand-written copies of a grouping loop is four chances for one
 * of them to use the primary key where it meant the tiebreak. */
function indexByKey(keys: readonly MatchKey[], pick: (key: MatchKey) => string): Map<string, number[]> {
  const groups = new Map<string, number[]>();
  keys.forEach((key, index) => {
    const value = pick(key);
    const bucket = groups.get(value);
    if (bucket === undefined) {
      groups.set(value, [index]);
    } else {
      bucket.push(index);
    }
  });
  return groups;
}

/* Match two pools of nodes on their exact keys.
 *
 * A pairing is accepted only when the key identifies exactly ONE node on EACH
 * side. Both halves are required, and the second is the one that is easy to
 * forget: if one previous node matches two incoming nodes, the previous id can
 * only go to one of them, and choosing is a guess about which one inherits the
 * history. That is refused, not resolved.
 *
 * The tiebreak is consulted ONLY when the primary key is ambiguous, which is
 * what keeps it from becoming part of the key - see `match-keys.ts` for why
 * that ordering matters. */
function matchByKey(
  previousKeys: readonly MatchKey[],
  incomingKeys: readonly MatchKey[],
): KeyedMatch {
  const previousByPrimary = indexByKey(previousKeys, (key) => key.primary);
  const incomingByPrimary = indexByKey(incomingKeys, (key) => key.primary);
  const previousByTiebreak = indexByKey(previousKeys, (key) => key.tiebreak);
  const incomingByTiebreak = indexByKey(incomingKeys, (key) => key.tiebreak);

  const matched = new Map<number, number>();
  const ambiguous = new Map<number, readonly number[]>();

  incomingKeys.forEach((key, incomingIndex) => {
    const previousCandidates = previousByPrimary.get(key.primary) ?? [];
    /* Nothing previous had this key: genuinely new content, and there is
       nothing to report beyond the mint the caller will record. */
    if (previousCandidates.length === 0) {
      return;
    }
    const incomingCandidates = incomingByPrimary.get(key.primary) ?? [];

    /* The clean case: one on each side. */
    const soleprevious = previousCandidates[0];
    if (previousCandidates.length === 1 && incomingCandidates.length === 1 && soleprevious !== undefined) {
      matched.set(incomingIndex, soleprevious);
      return;
    }

    /* Ambiguous on at least one side. Try the finer key before giving up - two
       stints at one company are separated by their dates, and two projects
       sharing a title head by their full titles. */
    const refinedPrevious = previousByTiebreak.get(key.tiebreak) ?? [];
    const refinedIncoming = incomingByTiebreak.get(key.tiebreak) ?? [];
    const soleRefined = refinedPrevious[0];
    if (refinedPrevious.length === 1 && refinedIncoming.length === 1 && soleRefined !== undefined) {
      matched.set(incomingIndex, soleRefined);
      return;
    }

    /* Still ambiguous. Report the PRIMARY-key candidates rather than the
       refined ones: those are the nodes a human is actually choosing between,
       and the refined set may be empty. */
    ambiguous.set(incomingIndex, previousCandidates);
  });

  return { matched, ambiguous };
}

/* --- Bullets: the only fuzzy match in the package ----------------------- */

/* Every incoming bullet gets a fresh id, with no similarity search attempted.
 * Used when the parent is new or when this is the first upload - in both cases
 * there is no previous parent whose bullets could legitimately be searched, and
 * searching a DIFFERENT parent's bullets is the misattribution. */
function mintAllBullets(
  incoming: readonly MasterBullet[],
  parentId: NodeId,
  parentLabel: string,
  parentPath: string,
  reason: MintReason,
  acc: Accumulator,
): MasterBullet[] {
  return incoming.map((bullet, index) => {
    const id = acc.mintId();
    acc.minted.push({
      kind: 'bullet',
      id,
      /* The parent is on every bullet row: a reviewer confirming a bullet
         without seeing which job it sits under can miss the only error that
         matters. */
      parentId,
      parentLabel,
      path: parentPath + '.bullets[' + String(index) + ']',
      reason,
      label: labelFor(bullet.text),
      /* No score: nothing was compared. Reporting 0 would suggest a comparison
         happened and found nothing alike, which is a different fact. */
      bestScore: null,
    });
    return { ...bullet, id };
  });
}

/* Reconcile the bullets of ONE parent against the bullets of the previous
 * version of THAT SAME parent.
 *
 * TWO PASSES, AND THE ORDER IS NOT AN OPTIMISATION. Exact normalised-text
 * equality is settled first, so a bullet that was not touched at all cannot be
 * dragged into a scoring contest by a similar sibling. If both passes were
 * merged, an untouched bullet scoring 1.0 could tie with a reworded sibling
 * also scoring 1.0 after normalisation, and a certainty would be turned into an
 * ambiguity by the presence of unrelated text. */
function reconcileBullets(
  previous: readonly MasterBullet[],
  incoming: readonly MasterBullet[],
  parentId: NodeId,
  parentLabel: string,
  parentPath: string,
  acc: Accumulator,
): MasterBullet[] {
  /* Resolved output ids, by incoming index. Filled by both passes and read once
     at the end, so the output is built in incoming DOCUMENT ORDER regardless of
     the order the matching happened in - array order is document order and is a
     tailoring decision, so nothing here may reorder it. */
  const resolved = new Map<number, CarriedNode>();
  const usedPrevious = new Set<number>();

  /* PASS 1 - exact normalised text.
   *
   * The queue-per-text form makes this POSITIONAL pairing within a group of
   * identical texts: the n-th incoming copy takes the n-th previous copy. That
   * is not the order-dependent first-match loop `assign.ts` warns about, and
   * the difference is worth stating because the code looks the same. There, a
   * first-match loop over SCORES picks a winner among candidates of differing
   * quality, so the answer depends on input order. Here every candidate in the
   * group has IDENTICAL text under the SAME parent, so the two candidates are
   * indistinguishable in every respect the system can observe - whichever way
   * they are paired, each output bullet has the same text under the same
   * parent. The pairing is arbitrary and semantically invisible. */
  const previousByText = new Map<string, number[]>();
  previous.forEach((bullet, index) => {
    const key = normaliseKey(bullet.text);
    const bucket = previousByText.get(key);
    if (bucket === undefined) {
      previousByText.set(key, [index]);
    } else {
      bucket.push(index);
    }
  });

  incoming.forEach((bullet, incomingIndex) => {
    const queue = previousByText.get(normaliseKey(bullet.text));
    if (queue === undefined || queue.length === 0) {
      return;
    }
    /* `shift` consumes the candidate, so a second identical incoming bullet
       cannot claim the same previous bullet - which would put one id on two
       output nodes and break global uniqueness. */
    const previousIndex = queue.shift();
    if (previousIndex === undefined) {
      return;
    }
    const previousBullet = previous[previousIndex];
    if (previousBullet === undefined) {
      return;
    }
    usedPrevious.add(previousIndex);
    resolved.set(incomingIndex, {
      kind: 'bullet',
      id: previousBullet.id,
      supersededId: bullet.id,
      parentId,
      parentLabel,
      path: parentPath + '.bullets[' + String(incomingIndex) + ']',
      match: 'exact_text',
      /* Null, not 1.0: an exact match has no score, and reporting one would
         make it indistinguishable from a fuzzy match that scored 1.0 - which is
         a judgement a human should review, whereas this is not. */
      similarity: null,
      label: labelFor(bullet.text),
      /* Equal to `label` here by definition - the texts matched exactly - and
         populated anyway so a consumer can render every carry the same way
         instead of special-casing the exact kinds. */
      previousLabel: labelFor(previousBullet.text),
    });
  });

  /* PASS 2 - similarity over what is left on both sides. */
  const remainingPrevious = previous
    .map((bullet, index) => ({ bullet, index }))
    .filter((entry) => !usedPrevious.has(entry.index));
  const remainingIncoming = incoming
    .map((bullet, index) => ({ bullet, index }))
    .filter((entry) => !resolved.has(entry.index));

  /* Token sets computed ONCE per bullet rather than once per pair. With n
     previous and m incoming bullets the naive form tokenises n*m times, and
     tokenisation is the expensive half of scoring. */
  const previousTokens = new Map<number, ReadonlySet<string>>();
  for (const entry of remainingPrevious) {
    previousTokens.set(entry.index, tokenSet(entry.bullet.text));
  }

  /* Every pair is scored, including pairs below the threshold: the assignment
     needs the best-of-all score to explain a mint, and computing it separately
     would be a second implementation that could disagree with this one. */
  const candidates: ScoredPair[] = [];
  for (const incomingEntry of remainingIncoming) {
    const incomingTokens = tokenSet(incomingEntry.bullet.text);
    for (const previousEntry of remainingPrevious) {
      const tokens = previousTokens.get(previousEntry.index);
      if (tokens === undefined) {
        continue;
      }
      candidates.push({
        previousIndex: previousEntry.index,
        incomingIndex: incomingEntry.index,
        score: diceSimilarity(tokens, incomingTokens),
      });
    }
  }

  const assignment = assignDeterministically(candidates, acc.threshold);

  for (const pair of assignment.pairs) {
    const previousBullet = previous[pair.previousIndex];
    const incomingBullet = incoming[pair.incomingIndex];
    if (previousBullet === undefined || incomingBullet === undefined) {
      continue;
    }
    usedPrevious.add(pair.previousIndex);
    resolved.set(pair.incomingIndex, {
      kind: 'bullet',
      id: previousBullet.id,
      supersededId: incomingBullet.id,
      parentId,
      parentLabel,
      path: parentPath + '.bullets[' + String(pair.incomingIndex) + ']',
      /* The only value in the package that means "a human must look at this". */
      match: 'fuzzy_text',
      similarity: pair.score,
      label: labelFor(incomingBullet.text),
      /* THE FIELD THE REVIEW ACTUALLY TURNS ON. A score of 0.71 is a number to
         nod at; these two strings side by side are the decision. And this is
         the one value a caller cannot recover from the output profile, because
         the output is what replaced it. */
      previousLabel: labelFor(previousBullet.text),
    });
  }

  /* Every refusal, reported from the incoming side because that is the node
     whose id is about to change. */
  for (const tie of assignment.ties) {
    const candidateIds: NodeId[] = [];
    for (const previousIndex of tie.previousIndexes) {
      const previousBullet = previous[previousIndex];
      if (previousBullet !== undefined) {
        candidateIds.push(previousBullet.id);
      }
    }
    for (const incomingIndex of tie.incomingIndexes) {
      acc.ambiguous.push({
        kind: 'bullet',
        reason: 'tied_similarity',
        /* The reconciled parent, which localises the problem: a tie inside one
           job is a much smaller thing than a tie across the profile - which
           this design makes impossible anyway. */
        parentId,
        parentLabel,
        path: parentPath + '.bullets[' + String(incomingIndex) + ']',
        candidateIds,
        score: tie.score,
        detail:
          tie.axis === 'incoming_tied_between_previous'
            ? 'This bullet matched ' +
              String(candidateIds.length) +
              ' previous bullets equally well (' +
              tie.score.toFixed(3) +
              '). Carrying either id would have been a guess, so a new id was minted.'
            : 'This bullet and ' +
              String(tie.incomingIndexes.length - 1) +
              ' other(s) matched one previous bullet equally well (' +
              tie.score.toFixed(3) +
              '). Whichever inherited the id would have been arbitrary, so all of them were minted.',
      });
    }
  }

  /* Build the output in incoming document order, minting for anything the two
     passes did not resolve. */
  const output = incoming.map((bullet, incomingIndex) => {
    const carried = resolved.get(incomingIndex);
    if (carried !== undefined) {
      acc.carried.push(carried);
      return { ...bullet, id: carried.id };
    }
    const id = acc.mintId();
    const bestScore = assignment.bestScoreByIncoming.get(incomingIndex);
    /* The reasons are ordered most-specific first, because several are true at
       once: an ambiguous bullet is also unassigned and also has a best score,
       and reporting the vaguest true reason would hide the one a human needs. */
    const reason: MintReason = acc.firstUpload
      ? 'no_previous_profile'
      : assignment.ambiguousIncoming.has(incomingIndex)
        ? 'ambiguous'
        : assignment.eligibleIncoming.has(incomingIndex)
          ? 'candidate_taken'
          : bestScore !== undefined && bestScore > 0
            ? 'below_threshold'
            : 'no_candidate';
    acc.minted.push({
      kind: 'bullet',
      id,
      parentId,
      parentLabel,
      path: parentPath + '.bullets[' + String(incomingIndex) + ']',
      reason,
      label: labelFor(bullet.text),
      bestScore: bestScore ?? null,
    });
    return { ...bullet, id };
  });

  /* Previous bullets nobody claimed. Reported as dropped rather than ignored:
     a pinned application may still reference one, so its disappearance is a
     dangling reference somebody has to decide about. */
  previous.forEach((bullet, index) => {
    if (usedPrevious.has(index)) {
      return;
    }
    acc.dropped.push({
      kind: 'bullet',
      id: bullet.id,
      parentId,
      parentLabel,
      previousPath: parentPath + '.bullets[' + String(index) + ']',
      label: labelFor(bullet.text),
    });
  });

  return output;
}

/* --- Sections ----------------------------------------------------------- */

/* The two shapes a section reconciler needs from its node type. Structural
 * rather than nominal, so `MasterExperience`, `MasterProject` and
 * `MasterEducation` all satisfy it without a shared base interface in the
 * contract - which is another stream's file and not mine to reshape. */
interface BulletedNode {
  readonly id: NodeId;
  readonly bullets: readonly MasterBullet[];
}

/* Reconcile one bulleted section: parents by exact key, then bullets within
 * each matched parent. The generic exists so experience, projects and education
 * get IDENTICAL treatment - three hand-written copies of this walk would be
 * three chances for one section to lose the parent-scoping that decision 1
 * depends on, and that divergence would be invisible in a test that only
 * exercised experience. */
function reconcileBulletedSection<T extends BulletedNode>(
  previous: readonly T[],
  incoming: readonly T[],
  kind: ReconciledKind,
  sectionPath: string,
  keyOf: (node: T) => MatchKey,
  labelOf: (node: T) => string,
  rebuild: (node: T, id: NodeId, bullets: readonly MasterBullet[]) => T,
  acc: Accumulator,
): T[] {
  const match = matchByKey(previous.map(keyOf), incoming.map(keyOf));
  const usedPrevious = new Set<number>();

  const output = incoming.map((node, incomingIndex) => {
    const path = sectionPath + '[' + String(incomingIndex) + ']';
    const previousIndex = match.matched.get(incomingIndex);
    const previousNode = previousIndex === undefined ? undefined : previous[previousIndex];

    /* MATCHED PARENT: carry its id, then search its bullets - and ONLY its
       bullets. This single line is where decision 1 is enforced; the bullet
       matcher is never handed a pool that spans two parents. */
    if (previousIndex !== undefined && previousNode !== undefined) {
      usedPrevious.add(previousIndex);
      acc.carried.push({
        kind,
        id: previousNode.id,
        supersededId: node.id,
        /* A top-level node has no parent, rather than an unknown one. */
        parentId: null,
        parentLabel: null,
        path,
        match: 'exact_key',
        similarity: null,
        label: labelOf(node),
        /* Meaningful even for an exact-KEY match: the key deliberately reads
           only part of the node, so a project whose tagline was reworded
           carries its id while its label changes - and that difference is
           exactly what a reviewer wants to see. */
        previousLabel: labelOf(previousNode),
      });
      return rebuild(
        node,
        previousNode.id,
        reconcileBullets(
          previousNode.bullets,
          node.bullets,
          previousNode.id,
          /* The parent label is taken from the INCOMING node, because that is
             the wording the reviewer is looking at on screen. */
          labelOf(node),
          path,
          acc,
        ),
      );
    }

    /* UNMATCHED PARENT: a fresh id, and every bullet under it minted without a
       similarity search. Deliberately NOT falling back to searching other
       parents' bullets - that fallback is precisely the cross-parent migration
       decision 1 exists to make unrepresentable. */
    const tiedPrevious = match.ambiguous.get(incomingIndex);
    const id = acc.mintId();
    if (tiedPrevious !== undefined) {
      const candidateIds: NodeId[] = [];
      for (const index of tiedPrevious) {
        const candidate = previous[index];
        if (candidate !== undefined) {
          candidateIds.push(candidate.id);
        }
      }
      acc.ambiguous.push({
        kind,
        reason: 'duplicate_match_key',
        parentId: null,
        parentLabel: null,
        path,
        candidateIds,
        /* Null: nothing was scored. A key either matched or it did not. */
        score: null,
        detail:
          'The match key for this ' +
          kind +
          ' identifies ' +
          String(candidateIds.length) +
          ' stored node(s) and the tiebreak did not separate them, so no id was carried. Every bullet under it was minted too.',
      });
    }
    acc.minted.push({
      kind,
      id,
      parentId: null,
      parentLabel: null,
      path,
      reason: acc.firstUpload
        ? 'no_previous_profile'
        : tiedPrevious !== undefined
          ? 'ambiguous'
          : 'no_candidate',
      label: labelOf(node),
      bestScore: null,
    });
    return rebuild(
      node,
      id,
      mintAllBullets(
        node.bullets,
        id,
        labelOf(node),
        path,
        acc.firstUpload ? 'no_previous_profile' : 'new_parent',
        acc,
      ),
    );
  });

  /* Dropped parents, and every bullet that went with them. The bullets are
     listed individually because a pinned application references a BULLET id,
     not the project id - reporting only the parent would leave a reader to
     infer which references broke, which is the "visible, not inferred" rule
     the report is built around. */
  previous.forEach((node, index) => {
    if (usedPrevious.has(index)) {
      return;
    }
    acc.dropped.push({
      kind,
      id: node.id,
      parentId: null,
      parentLabel: null,
      previousPath: sectionPath + '[' + String(index) + ']',
      label: labelOf(node),
    });
    node.bullets.forEach((bullet, bulletIndex) => {
      acc.dropped.push({
        kind: 'bullet',
        id: bullet.id,
        /* The parent that went away with it. A reader seeing four bullet drops
           all naming one parent knows it was one deletion, not four. */
        parentId: node.id,
        parentLabel: labelOf(node),
        previousPath:
          sectionPath + '[' + String(index) + '].bullets[' + String(bulletIndex) + ']',
        label: labelFor(bullet.text),
      });
    });
  });

  return output;
}

/* Reconcile a section of id-only nodes: skills and links. Same key logic, no
 * bullets, so it cannot share the function above without giving every skill an
 * empty bullets array it does not have. */
function reconcileFlatSection<T extends { readonly id: NodeId }>(
  previous: readonly T[],
  incoming: readonly T[],
  kind: ReconciledKind,
  sectionPath: string,
  keyOf: (node: T) => MatchKey,
  labelOf: (node: T) => string,
  rebuild: (node: T, id: NodeId) => T,
  acc: Accumulator,
): T[] {
  const match = matchByKey(previous.map(keyOf), incoming.map(keyOf));
  const usedPrevious = new Set<number>();

  const output = incoming.map((node, incomingIndex) => {
    const path = sectionPath + '[' + String(incomingIndex) + ']';
    const previousIndex = match.matched.get(incomingIndex);
    const previousNode = previousIndex === undefined ? undefined : previous[previousIndex];

    if (previousIndex !== undefined && previousNode !== undefined) {
      usedPrevious.add(previousIndex);
      acc.carried.push({
        kind,
        id: previousNode.id,
        supersededId: node.id,
        /* A top-level node has no parent, rather than an unknown one. */
        parentId: null,
        parentLabel: null,
        path,
        match: 'exact_key',
        similarity: null,
        label: labelOf(node),
        /* Meaningful even for an exact-KEY match: the key deliberately reads
           only part of the node, so a project whose tagline was reworded
           carries its id while its label changes - and that difference is
           exactly what a reviewer wants to see. */
        previousLabel: labelOf(previousNode),
      });
      return rebuild(node, previousNode.id);
    }

    const tiedPrevious = match.ambiguous.get(incomingIndex);
    const id = acc.mintId();
    if (tiedPrevious !== undefined) {
      const candidateIds: NodeId[] = [];
      for (const index of tiedPrevious) {
        const candidate = previous[index];
        if (candidate !== undefined) {
          candidateIds.push(candidate.id);
        }
      }
      acc.ambiguous.push({
        kind,
        reason: 'duplicate_match_key',
        parentId: null,
        parentLabel: null,
        path,
        candidateIds,
        score: null,
        detail:
          'The match key for this ' +
          kind +
          ' identifies ' +
          String(candidateIds.length) +
          ' stored node(s) and the tiebreak did not separate them, so no id was carried.',
      });
    }
    acc.minted.push({
      kind,
      id,
      parentId: null,
      parentLabel: null,
      path,
      reason: acc.firstUpload
        ? 'no_previous_profile'
        : tiedPrevious !== undefined
          ? 'ambiguous'
          : 'no_candidate',
      label: labelOf(node),
      bestScore: null,
    });
    return rebuild(node, id);
  });

  previous.forEach((node, index) => {
    if (usedPrevious.has(index)) {
      return;
    }
    acc.dropped.push({
      kind,
      id: node.id,
      parentId: null,
      parentLabel: null,
      previousPath: sectionPath + '[' + String(index) + ']',
      label: labelOf(node),
    });
  });

  return output;
}

/* --- The entry point ---------------------------------------------------- */

/* Reconcile a freshly parsed master profile against the stored one.
 *
 * Returns the profile that should become version N+1, plus a report of every
 * decision. Throws only on a broken CALLER contract - see
 * `ReconciliationError`. */
export function reconcileMasterProfile(input: ReconcileInput): ReconcileOutput {
  const { previous, incoming, mintId } = input;
  const threshold = input.similarityThreshold ?? DEFAULT_BULLET_SIMILARITY_THRESHOLD;

  /* PRECONDITION on the stored profile. Matching against a corrupt id space
     produces exactly the misattribution this package exists to prevent: the id
     carried forward would be one of two nodes that share it, and which one is
     decided by walk order. Refusing is the only honest response - minting
     everything instead would silently break every existing pin, which is a
     decision far too large for a library to take on its own. */
  if (previous !== null) {
    const duplicates = findDuplicateNodeIds(previous);
    if (duplicates.length > 0) {
      const first = duplicates[0];
      throw new ReconciliationError(
        'The stored profile has ' +
          String(duplicates.length) +
          ' duplicated NodeId(s) and cannot be reconciled against. First: "' +
          String(first?.id) +
          '" at ' +
          (first?.paths.join(', ') ?? '') +
          '. NodeIds must be unique across the ENTIRE profile.',
      );
    }
  }

  const acc: Accumulator = {
    carried: [],
    minted: [],
    dropped: [],
    ambiguous: [],
    mintId,
    threshold,
    firstUpload: previous === null,
  };

  /* Empty pools stand in for a null previous profile, so every section below
     has one code path instead of two. The report still distinguishes the case
     through `acc.firstUpload`, which is the only place it actually matters. */
  const previousSkills: readonly MasterSkill[] = previous?.skills ?? [];
  const previousExperience: readonly MasterExperience[] = previous?.experience ?? [];
  const previousProjects: readonly MasterProject[] = previous?.projects ?? [];
  const previousEducation: readonly MasterEducation[] = previous?.education ?? [];
  const previousLinks: readonly MasterLink[] = previous?.links ?? [];
  const previousIdentityLinks: readonly MasterLink[] = previous?.identity.links ?? [];

  /* Order of the calls matches `collectNodeIds`, so the report reads in the
     same order as the profile it describes. */
  const identityLinks = reconcileFlatSection<MasterLink>(
    previousIdentityLinks,
    incoming.identity.links,
    'link',
    'identity.links',
    linkKey,
    (link) => link.label + ' <' + link.url + '>',
    (link, id) => ({ ...link, id }),
    acc,
  );

  const skills = reconcileFlatSection<MasterSkill>(
    previousSkills,
    incoming.skills,
    'skill',
    'skills',
    skillKey,
    (skill) => skill.name,
    (skill, id) => ({ ...skill, id }),
    acc,
  );

  const experience = reconcileBulletedSection<MasterExperience>(
    previousExperience,
    incoming.experience,
    'experience',
    'experience',
    experienceKey,
    (node) => node.role + ' at ' + node.company,
    (node, id, bullets) => ({ ...node, id, bullets }),
    acc,
  );

  const projects = reconcileBulletedSection<MasterProject>(
    previousProjects,
    incoming.projects,
    'project',
    'projects',
    projectKey,
    (node) => node.name,
    (node, id, bullets) => ({ ...node, id, bullets }),
    acc,
  );

  const education = reconcileBulletedSection<MasterEducation>(
    previousEducation,
    incoming.education,
    'education',
    'education',
    educationKey,
    (node) => node.degree + ', ' + node.institution,
    (node, id, bullets) => ({ ...node, id, bullets }),
    acc,
  );

  const links = reconcileFlatSection<MasterLink>(
    previousLinks,
    incoming.links,
    'link',
    'links',
    linkKey,
    (link) => link.label + ' <' + link.url + '>',
    (link, id) => ({ ...link, id }),
    acc,
  );

  const profile: MasterProfile = {
    /* Written as a literal rather than copied from `incoming`, so a profile
       claiming a future schema version cannot pass through unnoticed - the
       literal type would stop compiling if the contract's version changed,
       which is the point of the field. */
    schema_version: 1,
    /* Identity is copied verbatim except for its link ids: there is no honest
       reason to tailor a name or a phone number, and the contract gives the
       Tailor no way to touch them either. */
    identity: { ...incoming.identity, links: identityLinks },
    education,
    experience,
    projects,
    skills,
    links,
  };

  /* POSTCONDITION. Uniqueness here is a property of the CONSTRUCTION - previous
     ids come from disjoint per-kind pools and each is carried at most once - so
     this check is not compensating for the algorithm. It exists because
     `mintId` is injected and cannot be verified: a caller that hands in a
     counter it also uses elsewhere, or a stub returning a constant, breaks the
     one assumption the construction rests on. Failing here is loud; failing
     later is a corrupted misattribution check that reports clean. */
  const outputDuplicates = findDuplicateNodeIds(profile);
  if (outputDuplicates.length > 0) {
    const first = outputDuplicates[0];
    throw new ReconciliationError(
      'Reconciliation produced ' +
        String(outputDuplicates.length) +
        ' duplicated NodeId(s), which means the injected mintId returned an id that already existed. First: "' +
        String(first?.id) +
        '" at ' +
        (first?.paths.join(', ') ?? '') +
        '.',
    );
  }

  return {
    profile,
    report: {
      carried: acc.carried,
      minted: acc.minted,
      dropped: acc.dropped,
      ambiguous: acc.ambiguous,
    },
  };
}
