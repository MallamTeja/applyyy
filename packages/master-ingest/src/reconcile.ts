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
  MasterAchievement,
  MasterBullet,
  MasterCertification,
  MasterEducation,
  MasterExperience,
  MasterLink,
  MasterProfile,
  MasterProject,
  MasterSkill,
  MasterSummary,
  NodeId,
} from '@applyy/shared-types';
import { assignDeterministically, type ScoredPair } from './assign.ts';
import {
  achievementKey,
  certificationKey,
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

/* The renderable form of a link. Written once and shared by all THREE link
 * pools - identity links, project links and top-level links - because
 * `parentLabel` and `label` are promised to be PRE-RENDERED so that two
 * consumers cannot join the parts differently; three inline copies of the join
 * would reintroduce exactly the divergence the pre-rendering rule forbids,
 * inside one file. */
function linkLabel(link: MasterLink): string {
  return link.label + ' <' + link.url + '>';
}

/* The renderable form of an achievement or a certification.
 *
 * INCLUDES THE DESCRIPTION, which the MATCH KEY deliberately does not. The two
 * are answering different questions: the key asks "is this the same node" and
 * must ignore the reworded half, while the label asks "what is a reviewer
 * looking at" and must show it - a certification that carried its id while its
 * issuer changed from "Amazon Web Services" to "AWS" is a row where `label` and
 * `previousLabel` differ, and that difference is the entire content of the
 * review. Structural typing rather than a union of the two interfaces, so it
 * cannot drift if one of them gains a field.
 *
 * AN ABSENT DESCRIPTION KEY READS AS NULL (2026-10-24). The stored master is
 * jsonb read back through a cast, and master_profiles v2 holds achievements with
 * no `description` key at all. Testing only `=== null` let undefined reach the
 * concatenation and the review row read "... - undefined". `undefined` is
 * admitted in the parameter type on purpose, so the compiler keeps the check
 * honest; '' still renders as a separator because a stored '' is a real value
 * and this label must show the reviewer exactly what is there. */
function labelledEntryLabel(node: { readonly label: string; readonly description: string | null | undefined }): string {
  /* `== null` is the one check that matches exactly null and undefined. */
  return node.description == null ? node.label : node.label + ' - ' + node.description;
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
  /* Rebuilds one output node from its reconciled id and bullets.
   *
   * `previousNode` AND `path` WERE ADDED 2026-09-11, for project links, and the
   * shape is the point rather than an accident of what was convenient. A nested
   * pool needs two things this generic already knows and nobody outside it can
   * re-derive safely: WHICH previous node matched (so the pool is
   * `previousNode.links` and not every project's links), and WHERE the output
   * node sits (so the nested report paths read `projects[1].links[0]`).
   * Recomputing the first outside would mean a second matcher deciding which
   * stored project this one is, and two matchers that disagree is cross-parent
   * migration arriving by the back door - the thing decision 1 keeps
   * unrepresentable by having exactly one answer to that question.
   *
   * `previousNode` is `T | null`, not an optional parameter: null is the REAL
   * answer for an unmatched parent, and an optional would let a caller read
   * "absent" as "not passed" and fall back to searching something it must not.
   * Every other caller simply declares fewer parameters and ignores both. */
  rebuild: (
    node: T,
    id: NodeId,
    bullets: readonly MasterBullet[],
    previousNode: T | null,
    path: string,
  ) => T,
  /* Reports the ids under a DROPPED parent that this generic does not know
     about - today, a project's links.
   *
   * WHY THIS EXISTS AT ALL, AND IT WAS FOUND BY A TEST RATHER THAN BY READING.
   * The dropped walk below already lists a deleted parent's BULLETS individually,
   * because a pinned application references a bullet id and not the project id.
   * The moment a project gained `links: DocumentOrdered<MasterLink>`, it gained a
   * SECOND nested id-bearing array with exactly the same property - and deleting
   * the project made those link ids dangle with nothing anywhere reporting it.
   * That is the silent half of `dropped`, in a brand-new field, and the first
   * version of this change shipped it.
   *
   * `null` rather than optional, for the same reason as `previousNode`: the four
   * sections that have no nested arrays must SAY so, so that the next kind with
   * one cannot inherit silence by omission. */
  dropNested: ((node: T, previousPath: string) => void) | null,
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
        /* The matched stored node, handed to the caller so a NESTED pool is
           scoped to this one parent. Nothing else may read it. */
        previousNode,
        path,
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
      /* NULL, AND THIS IS THE LOAD-BEARING HALF OF THE NEW SIGNATURE. The parent
         did not match, so there is no previous node whose nested pool could
         legitimately be searched - and searching a DIFFERENT parent's pool is
         the migration decision 1 exists to make unrepresentable. Passing null
         rather than omitting the argument makes the caller state that case. */
      null,
      path,
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
    /* Anything else id-bearing under the parent - see `dropNested`. Called after
       the bullets so the drop list reads in the same order as the profile
       walk. */
    dropNested?.(node, sectionPath + '[' + String(index) + ']');
  });

  return output;
}

/* WHERE A FLAT SECTION HANGS, AND WHAT AN EMPTY POOL UNDER IT MEANS.
 *
 * Added 2026-09-11 with project links - the first flat section in this package
 * that is NOT at the root of the profile. Passed as ONE object rather than three
 * parameters because all three answer the same question ("whose links are
 * these"), and a caller that got one right and another wrong would emit a report
 * row that contradicts itself: a row naming a parent while claiming its content
 * is brand new. */
interface SectionPlacement {
  /* The RECONCILED parent's id - the id that will be in the stored profile, not
     the throwaway one the parse produced. Null means "this node HAS no parent",
     never "the parent is unknown", which is the contract `NodePlacement` states
     in report.ts. */
  readonly parentId: NodeId | null;
  /* Pre-rendered, so every consumer shows the same string. Null exactly when
     `parentId` is null. */
  readonly parentLabel: string | null;
  /* The mint reason for a node that found no candidate at all.
   *
   * At the root, an empty pool genuinely means new content, so `no_candidate` is
   * true. Inside a parent that FAILED to match, the pool was empty only because
   * the parent was - and reporting `no_candidate` there would assert that a
   * GitHub link unchanged since the first upload is new content. `new_parent`
   * says the true thing, in the vocabulary the bullets already use, so a reader
   * seeing several of these goes and looks at the parent rather than at the
   * links. */
  readonly noCandidateReason: MintReason;
}

/* The root of the profile: identity links, skills, top-level links. Named rather
 * than written inline three times, so the three root callers cannot drift. */
const TOP_LEVEL: SectionPlacement = {
  parentId: null,
  parentLabel: null,
  noCandidateReason: 'no_candidate',
};

/* Reconcile a section of id-only nodes: skills and links. Same key logic, no
 * bullets, so it cannot share the function above without giving every skill an
 * empty bullets array it does not have.
 *
 * USED FOR NESTED POOLS TOO, as of 2026-09-11: a project's links are reconciled
 * by this same function against that ONE project's previous links. Reusing it
 * rather than hand-writing a fourth walk is the same argument the bulleted
 * generic makes - a second copy is a second chance to lose the parent scoping,
 * and the loss would be invisible in a test that only exercised identity
 * links. */
function reconcileFlatSection<T extends { readonly id: NodeId }>(
  previous: readonly T[],
  incoming: readonly T[],
  kind: ReconciledKind,
  sectionPath: string,
  keyOf: (node: T) => MatchKey,
  labelOf: (node: T) => string,
  rebuild: (node: T, id: NodeId) => T,
  placement: SectionPlacement,
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
        /* Null at the root; the owning project for a project link. A link row
           naming no parent would be unreviewable in the one way that matters -
           "Source <github.com/example/x>" is only checkable beside the project
           it is claimed to belong to. */
        parentId: placement.parentId,
        parentLabel: placement.parentLabel,
        path,
        match: 'exact_key',
        similarity: null,
        label: labelOf(node),
        /* Meaningful even for an exact-KEY match: the key deliberately reads
           only part of the node, so a link whose LABEL was reworded carries its
           id while its rendered label changes - and that difference is exactly
           what a reviewer wants to see. */
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
        parentId: placement.parentId,
        parentLabel: placement.parentLabel,
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
      parentId: placement.parentId,
      parentLabel: placement.parentLabel,
      path,
      /* Most-specific reason first, as everywhere else: a first upload explains
         everything at once, an unresolved key is the thing a human can act on,
         and only then the placement's own answer to "nothing matched" - which
         differs between the root and a parent that is itself new. */
      reason: acc.firstUpload
        ? 'no_previous_profile'
        : tiedPrevious !== undefined
          ? 'ambiguous'
          : placement.noCandidateReason,
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
      parentId: placement.parentId,
      parentLabel: placement.parentLabel,
      previousPath: sectionPath + '[' + String(index) + ']',
      label: labelOf(node),
    });
  });

  return output;
}

/* --- The summary: one node, and therefore no pool ------------------------ */

/* Reconcile the single summary node.
 *
 * WHY THIS IS BESPOKE RATHER THAN A ONE-ELEMENT SECTION. Every other reconciler
 * in this file answers "which of these previous nodes is this incoming node",
 * and the whole apparatus above - match keys, tiebreaks, ambiguity reporting -
 * exists to REFUSE that question when it has more than one answer. The summary
 * has no pool: `MasterProfile.summary` is one nullable node, so if a previous
 * summary and an incoming summary both exist there is exactly one candidate and
 * exactly one claimant. AMBIGUITY IS NOT MERELY UNLIKELY HERE, IT IS
 * UNREPRESENTABLE - the type cannot hold a second summary - so there is nothing
 * for a key or a threshold to decide, and running this through the generic would
 * have invented a key whose only purpose was to be trivially unique.
 *
 * WHICH MEANS THE TEXT IS DELIBERATELY NOT CONSULTED. A completely rewritten
 * summary still carries its id, because it is still THE summary, and the
 * alternative is the churn that matters most: `TailoredSummary.refs` points at
 * this id, so minting a fresh one on a rewording breaks every pinned tailoring's
 * one non-bullet ref on an edit Teja makes constantly. The change is still
 * visible - `label` and `previousLabel` carry both texts - so a reader sees what
 * happened without the id having moved.
 *
 * `match: 'exact_key'`, because the KEY IS THE FIELD ITSELF: `profile.summary`
 * identifies this node the way a normalised name identifies a skill, and it can
 * never be ambiguous. `fuzzy_text` would be a lie (nothing was scored, and
 * `similarity` would have to be null beside it) and would put the summary in the
 * human-review list on every single upload, which is how a review list stops
 * being read. `exact_text` would be a lie whenever the paragraph changed. */
function reconcileSummary(
  previous: MasterSummary | null,
  incoming: MasterSummary | null,
  acc: Accumulator,
): MasterSummary | null {
  /* THE DELETION CASE, AND IT IS THE REASON `dropped` EXISTS. A pinned tailoring
     may hold a ref to this id; the paragraph going away makes that ref dangling,
     and a dangling ref is a decision for a person rather than a tidy-up. Handled
     before the null-incoming early return, or the one case the report is built
     around would be the one case it stayed silent about. */
  if (incoming === null) {
    if (previous !== null) {
      acc.dropped.push({
        kind: 'summary',
        id: previous.id,
        /* A top-level node: it has no parent, rather than an unknown one. */
        parentId: null,
        parentLabel: null,
        /* No index: there is one summary, so `summary[0]` would suggest a
           section that does not exist and would not match the JSON an operator
           searches. */
        previousPath: 'summary',
        label: labelFor(previous.text),
      });
    }
    return null;
  }

  /* CARRY. One candidate, one claimant, no pool - see the header. */
  if (previous !== null) {
    acc.carried.push({
      kind: 'summary',
      id: previous.id,
      /* The parse's throwaway id, kept only so a debugging session can trace the
         node back to what the parser produced. */
      supersededId: incoming.id,
      parentId: null,
      parentLabel: null,
      path: 'summary',
      match: 'exact_key',
      /* Null, because nothing was scored. A number here would make this
         indistinguishable from a judgement a human should check. */
      similarity: null,
      label: labelFor(incoming.text),
      /* THE FIELD THAT MAKES A REWRITTEN SUMMARY VISIBLE despite the id not
         moving. Unrecoverable from the output, because the output replaced it. */
      previousLabel: labelFor(previous.text),
    });
    return { ...incoming, id: previous.id };
  }

  /* MINT. Either the very first upload, or a summary that did not exist before.
     Those are different facts and the report says which: `no_previous_profile`
     on a first upload would otherwise be reported as `no_candidate`, which reads
     like a summary that failed to match something. */
  const id = acc.mintId();
  acc.minted.push({
    kind: 'summary',
    id,
    parentId: null,
    parentLabel: null,
    path: 'summary',
    reason: acc.firstUpload ? 'no_previous_profile' : 'no_candidate',
    label: labelFor(incoming.text),
    /* Null: no comparison happened, and 0 would claim one did and found nothing
       alike. */
    bestScore: null,
  });
  return { ...incoming, id };
}

/* --- Links nested under an achievement or a certification --------------- */

/* The fields both entry kinds share that link reconciliation needs. Structural,
 * like `labelledEntryLabel`, so it cannot drift if one of the two interfaces
 * gains a field the other lacks. `links` is OPTIONAL in the contract (absent on
 * every stored v1-v8 entry), which is why every read below is `?? []`. */
type LinkedEntry = BulletedNode & {
  /* Read by labelledEntryLabel for the report's parent label. */
  readonly label: string;
  /* Same, and `undefined` admitted because v2 rows lack the key (see labelledEntryLabel). */
  readonly description: string | null | undefined;
  /* The pool being reconciled. Optional: absent on every stored v1-v8 entry. */
  readonly links?: readonly MasterLink[];
};

/* Rebuilds an achievement or certification AND reconciles its links against
 * THAT ONE matched entry's previous links (2026-11-01).
 *
 * THIS IS NOT OPTIONAL TIDYING. The rebuild these sections had before was
 * `({ ...node, id, bullets })`, and the spread carries `node.links` through
 * untouched - the PARSE'S throwaway link ids would have gone straight into the
 * stored profile, the one thing this file's header says never happens. A test
 * measured it: the reparse's `p-elink-1` came out where `link_cert_ml` belonged.
 *
 * Same per-parent pool as project links, for the same reason (decision 1): a
 * credential URL reused under a different cert must not carry the id across.
 * Returns a function rather than being one so `acc` is bound once at the call
 * site, matching the inline lambdas the project section passes. */
function rebuildLinkedEntry<T extends LinkedEntry>(
  /* The shared report accumulator, so link rows land beside every other row. */
  acc: Accumulator,
): (node: T, id: NodeId, bullets: readonly MasterBullet[], previousNode: T | null, path: string) => T {
  /* The exact signature `reconcileBulletedSection`'s `rebuild` expects. */
  return (node, id, bullets, previousNode, path) => ({
    /* Label and description verbatim from the incoming parse... */
    ...node,
    /* ...but the RECONCILED entry id, never the parse's throwaway... */
    id,
    /* ...and the bullets the generic already reconciled under this parent. */
    bullets,
    /* Always emitted, even when empty: from v9 on, every stored entry carries the
       key, so the absent-key shape ages out instead of being re-stored forever. */
    links: reconcileFlatSection<MasterLink>(
      /* THIS entry's previous links only - decision 1, one level down. */
      previousNode?.links ?? [],
      /* The parse's links for this entry; a PDF parse has none (see master-pdf). */
      node.links ?? [],
      /* Filed under the link kind, like every other link row. */
      'link',
      /* Report path, e.g. `certifications[1].links[0]`. */
      path + '.links',
      /* The URL is the identity, same key as identity and project links. */
      linkKey,
      /* Pre-rendered "label <url>", shared by all link pools. */
      linkLabel,
      /* Carry or mint the id; everything else about the link is the incoming one. */
      (link, linkId) => ({ ...link, id: linkId }),
      {
        /* The RECONCILED entry id - the one a pin would reference. */
        parentId: id,
        /* Rendered exactly as the bullets under the same entry render it. */
        parentLabel: labelledEntryLabel(node),
        /* Unmatched parent -> the empty pool is a cascade, not new content. */
        noCandidateReason: previousNode === null ? 'new_parent' : 'no_candidate',
      },
      acc,
    ),
  });
}

/* A DELETED entry takes its links with it, listed one by one the way a deleted
 * project's are: a pinned application references the LINK id, not the entry id.
 * Reconciling against an EMPTY incoming pool makes every previous link unmatched,
 * which is exactly "the entry is gone", and keeps the row shape defined once. */
function dropLinkedEntryLinks<T extends LinkedEntry>(acc: Accumulator): (node: T, previousPath: string) => void {
  /* The exact signature `reconcileBulletedSection`'s `dropNested` expects. */
  return (node, previousPath) => {
    /* Result discarded on purpose: only the `dropped` rows it records matter. */
    reconcileFlatSection<MasterLink>(
      /* The deleted entry's stored links; absent on v1-v8 reads as none. */
      node.links ?? [],
      /* Empty incoming pool: every previous link is unmatched, i.e. dropped. */
      [],
      /* Link kind, matching the live walk's rows. */
      'link',
      /* The STORED path, which is what an operator searches the old version for. */
      previousPath + '.links',
      /* Same identity key as the live walk, so the two cannot disagree. */
      linkKey,
      /* Same rendering as the live walk. */
      linkLabel,
      /* Never called with an empty incoming pool; required by the signature. */
      (link, linkId) => ({ ...link, id: linkId }),
      {
        /* The STORED entry, since the previous side is what is being reported. */
        parentId: node.id,
        parentLabel: labelledEntryLabel(node),
        /* Unreachable with an empty incoming pool; stated so no default decides it. */
        noCandidateReason: 'no_candidate',
      },
      /* Rows go to the same report as the live walk's. */
      acc,
    );
  };
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
  /* Added 2026-09-11, when the contract gained real nodes for the three things
     the real resume contained and `MasterProfile` could not hold. Without these
     pools the sections would still COMPILE - they would simply be reconciled
     against nothing and re-minted on every upload, which is the silent
     re-identification this package exists to prevent, reintroduced in three new
     fields. */
  const previousAchievements: readonly MasterAchievement[] = previous?.achievements ?? [];
  const previousCertifications: readonly MasterCertification[] = previous?.certifications ?? [];
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
    linkLabel,
    (link, id) => ({ ...link, id }),
    TOP_LEVEL,
    acc,
  );

  /* Second, matching `collectNodeIds`. The summary is one node rather than a
     section, so it has its own reconciler - see `reconcileSummary`. */
  const summary = reconcileSummary(previous?.summary ?? null, incoming.summary, acc);

  const skills = reconcileFlatSection<MasterSkill>(
    previousSkills,
    incoming.skills,
    'skill',
    'skills',
    skillKey,
    (skill) => skill.name,
    (skill, id) => ({ ...skill, id }),
    TOP_LEVEL,
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
    /* Nothing nested but bullets, and the generic already lists those. */
    null,
    acc,
  );

  const projects = reconcileBulletedSection<MasterProject>(
    previousProjects,
    incoming.projects,
    'project',
    'projects',
    projectKey,
    (node) => node.name,
    /* PROJECT LINKS ARE RECONCILED HERE, INSIDE THE PROJECT, AND NOWHERE ELSE.
     *
     * `MasterProject.url` became `links` on 2026-09-11 because one real project
     * has a live URL AND a GitHub URL and the single slot silently dropped one.
     * A `MasterLink` carries a NodeId, so project links are now real nodes in the
     * one global id space and need carrying forward like anything else.
     *
     * THE POOL IS `previousNode.links` - THIS project's previous links - and that
     * scoping is decision 1 applied one level down. Reconciling every project's
     * links against one global pool would let the "Source" link of project A
     * inherit the id of the "Source" link of project B whenever the URLs happened
     * to match, which they do across forks, org renames and template repos. The
     * result would be a link node whose id says it belongs to a project it was
     * never about - the same misattribution as a bullet under the wrong employer,
     * arrived at by the same mechanism, and just as invisible.
     *
     * `previousNode === null` means the PARENT did not match, so the empty pool is
     * a cascade rather than evidence of new content, and the mint reason says so.
     * Reconciled inside `rebuild` rather than in a second pass over the output,
     * because a second pass would have to re-derive which previous project each
     * output project matched - a second matcher, free to disagree with the first. */
    (node, id, bullets, previousNode, path) => ({
      ...node,
      id,
      bullets,
      links: reconcileFlatSection<MasterLink>(
        previousNode?.links ?? [],
        node.links,
        'link',
        path + '.links',
        linkKey,
        linkLabel,
        (link, linkId) => ({ ...link, id: linkId }),
        {
          /* The RECONCILED project id, so a link row names the id a pin would
             actually reference rather than the throwaway one the parse made. */
          parentId: id,
          /* The INCOMING name, because that is the wording on the reviewer's
             screen - the same choice the bullet rows make. */
          parentLabel: node.name,
          noCandidateReason: previousNode === null ? 'new_parent' : 'no_candidate',
        },
        acc,
      ),
    }),
    /* A DELETED PROJECT TAKES ITS LINKS WITH IT, and those ids have to be listed
     * the same way its bullets are: a pinned application references the LINK id,
     * not the project id, so reporting only the parent leaves a reader to infer
     * which references broke - the "visible, not inferred" rule the whole report
     * is built around.
     *
     * Written as `reconcileFlatSection` against an EMPTY incoming pool rather
     * than by pushing rows by hand. Every previous link is then unmatched, which
     * is precisely what "the project is gone" means, and the row shape - kind,
     * path, parent, label - stays defined in exactly one place. A second
     * hand-written copy would be free to spell the path differently from the one
     * the live walk emits, and a path that does not match is a path an operator
     * cannot search for. */
    (node, previousPath) => {
      reconcileFlatSection<MasterLink>(
        node.links,
        [],
        'link',
        previousPath + '.links',
        linkKey,
        linkLabel,
        (link, linkId) => ({ ...link, id: linkId }),
        {
          /* The STORED project - it is the previous side that is being reported,
             and its id is the one a pin would have referenced. */
          parentId: node.id,
          parentLabel: node.name,
          /* Unreachable with an empty incoming pool - nothing is minted - and
             stated rather than left to a default, because a default is how a
             wrong reason gets reported the day this function grows a caller. */
          noCandidateReason: 'no_candidate',
        },
        acc,
      );
    },
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
    null,
    acc,
  );

  /* ACHIEVEMENTS AND CERTIFICATIONS ARE BULLETED PARENTS, so they go through the
     SAME generic as experience, projects and education rather than through two
     more hand-written walks. That is not tidiness: the generic is where decision
     1 is enforced - `reconcileBullets` is only ever handed ONE parent's bullets -
     and a fourth or fifth hand-written copy is a fourth or fifth chance for one
     section to lose that scoping, in a way no test of the other sections would
     see. Most achievements have no bullets at all, which makes the omission even
     easier to miss: the walk would look correct until the one achievement that
     does have them. */
  const achievements = reconcileBulletedSection<MasterAchievement>(
    previousAchievements,
    incoming.achievements,
    'achievement',
    'achievements',
    achievementKey,
    labelledEntryLabel,
    /* Links reconciled inside THIS achievement (2026-11-01); see rebuildLinkedEntry. */
    rebuildLinkedEntry<MasterAchievement>(acc),
    /* A deleted achievement lists its link ids, not just its own. */
    dropLinkedEntryLinks<MasterAchievement>(acc),
    acc,
  );

  const certifications = reconcileBulletedSection<MasterCertification>(
    previousCertifications,
    incoming.certifications,
    'certification',
    'certifications',
    certificationKey,
    labelledEntryLabel,
    /* Credential links reconciled inside THIS certification. */
    rebuildLinkedEntry<MasterCertification>(acc),
    /* A deleted certification lists its credential link ids. */
    dropLinkedEntryLinks<MasterCertification>(acc),
    acc,
  );

  const links = reconcileFlatSection<MasterLink>(
    previousLinks,
    incoming.links,
    'link',
    'links',
    linkKey,
    linkLabel,
    (link, id) => ({ ...link, id }),
    TOP_LEVEL,
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
    /* REQUIRED FIELDS, NOT OPTIONAL ONES, and that is why they are listed here
       rather than spread from `incoming`. `MasterProfile` declares `summary`,
       `achievements` and `certifications` as required-but-nullable/possibly-empty
       precisely so that a construction site which forgot one fails to compile
       instead of storing a profile with the section silently gone. Spreading
       `...incoming` would have satisfied the type while shipping the incoming
       THROWAWAY ids straight into the stored profile - the one thing the header
       of this file says never happens. */
    summary,
    education,
    experience,
    projects,
    skills,
    achievements,
    certifications,
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
