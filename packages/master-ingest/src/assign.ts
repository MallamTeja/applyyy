/* Deciding which incoming bullet is which previous bullet, without ever
 * guessing and without depending on the order the bullets arrive in.
 *
 * THIS FILE KNOWS NOTHING ABOUT BULLETS. It takes scored index pairs and
 * returns an assignment. Keeping it that way is what makes it testable directly
 * with hand-written numbers, where a wrong answer is visible - as opposed to
 * testing it through the reconciler, where a wrong assignment shows up only as
 * a plausible-looking id.
 *
 * WHY NOT A FIRST-MATCH LOOP, which is the obvious implementation. Walking
 * incoming bullets in order and taking the first previous bullet above the
 * threshold produces an answer that depends on ARRAY ORDER: reorder two bullets
 * in the resume and different ids carry. That bug is invisible in every test
 * whose fixtures happen to be in a convenient order, and it appears in
 * production the first time Teja moves a bullet up - which is one of the most
 * common edits there is. So: score every pair, then assign best-first.
 *
 * WHY TIES ARE DETECTED BEFORE ANY ASSIGNMENT, ON BOTH AXES. Greedy assignment
 * has to break a tie somehow, and any rule it uses - lowest index, first seen -
 * is a coin flip dressed up as a policy. A tie is precisely the case where the
 * similarity score contains NO information about which candidate is right, so
 * the only honest output is a refusal. Both directions count:
 *   - one incoming bullet, two equally good previous bullets: carrying either
 *     is a guess about which claim this is.
 *   - one previous bullet, two equally good incoming bullets: carrying it to
 *     either is a guess about which of them inherits the id, and the loser
 *     silently gets a fresh one.
 * The second is the one a single-axis implementation misses, and it is the same
 * failure with the arrow reversed.
 */

import { scoresAreTied } from './similarity.ts';

/* One scored comparison. Indexes, not nodes, so this module cannot accidentally
 * read a company name and start making domain decisions. */
export interface ScoredPair {
  readonly previousIndex: number;
  readonly incomingIndex: number;
  readonly score: number;
}

/* Which side of the comparison was contested. */
export type TieAxis =
  /* One incoming node, several equally-good previous candidates. */
  | 'incoming_tied_between_previous'
  /* One previous node, several equally-good incoming candidates. */
  | 'previous_tied_between_incoming';

/* A refusal to choose. Both index lists are always populated so a caller can
 * report the ambiguity from either direction without recomputing anything. */
export interface Tie {
  readonly axis: TieAxis;
  readonly incomingIndexes: readonly number[];
  readonly previousIndexes: readonly number[];
  readonly score: number;
}

export interface Assignment {
  /* The accepted pairings. Each previous index and each incoming index appears
     at most once. */
  readonly pairs: readonly ScoredPair[];
  readonly ties: readonly Tie[];
  /* Best score seen for each incoming index across ALL pairs, including those
     below the threshold. This is what lets the caller report "closest match
     scored 0.55" rather than "no match", which is the difference between a
     report a human can act on and one they cannot. */
  readonly bestScoreByIncoming: ReadonlyMap<number, number>;
  /* Incoming indexes that had at least one candidate at or above the
     threshold. An unassigned member of this set lost its candidate to someone
     else rather than having none - a distinction the mint reason depends on. */
  readonly eligibleIncoming: ReadonlySet<number>;
  /* Incoming indexes touched by a tie on either axis. These are refused rather
     than assigned. */
  readonly ambiguousIncoming: ReadonlySet<number>;
}

/* Groups pairs by one of their two indexes. Written once and used for both axes
 * so the two directions cannot drift apart - a tie detector that is correct on
 * one axis and subtly different on the other is exactly the asymmetry this
 * design is trying to avoid. */
function groupBy(
  pairs: readonly ScoredPair[],
  keyOf: (pair: ScoredPair) => number,
): Map<number, ScoredPair[]> {
  const groups = new Map<number, ScoredPair[]>();
  for (const pair of pairs) {
    const key = keyOf(pair);
    const bucket = groups.get(key);
    /* Explicit undefined check rather than `groups.get(key) || []`: with
       `noUncheckedIndexedAccess` the compiler requires it, and the falsy-OR
       form would also silently replace a legitimately empty bucket. */
    if (bucket === undefined) {
      groups.set(key, [pair]);
    } else {
      bucket.push(pair);
    }
  }
  return groups;
}

/* The best score in a bucket, and every pair achieving it within the tie
 * tolerance. Returns the pairs rather than the indexes because the caller needs
 * both indexes off each tied pair. */
function bestAndTied(bucket: readonly ScoredPair[]): { best: number; tied: readonly ScoredPair[] } {
  /* Seeded from the bucket rather than from -Infinity, so `best` is always a
     real score and the caller never has to handle a sentinel. Buckets are never
     empty: they only exist because a pair was put in them. */
  let best = Number.NEGATIVE_INFINITY;
  for (const pair of bucket) {
    if (pair.score > best) {
      best = pair.score;
    }
  }
  /* Tolerance rather than `===`. Two mathematically equal Dice scores computed
     from different set sizes need not be bit-identical doubles, and a tie that
     fails to register by one bit is not a rounding curiosity - it is the silent
     coin flip this whole mechanism exists to prevent. */
  return { best, tied: bucket.filter((pair) => scoresAreTied(pair.score, best)) };
}

/* Assign pairings deterministically, refusing every tie.
 *
 * Takes ALL scored pairs, including ones below the threshold, and filters
 * internally. That is deliberate: the below-threshold scores are needed for the
 * report, so a caller that pre-filtered would have to compute them twice and
 * the two computations could disagree. */
export function assignDeterministically(
  candidates: readonly ScoredPair[],
  threshold: number,
): Assignment {
  /* Best-of-all-pairs first, over the UNFILTERED input, because a score below
     the threshold is still the most useful thing to report about a node that
     did not match. */
  const bestScoreByIncoming = new Map<number, number>();
  for (const pair of candidates) {
    const current = bestScoreByIncoming.get(pair.incomingIndex);
    if (current === undefined || pair.score > current) {
      bestScoreByIncoming.set(pair.incomingIndex, pair.score);
    }
  }

  /* Only pairs at or above the threshold may be assigned. `>=` rather than `>`
     so a threshold of exactly 1.0 still admits an identical pair - an off-by-one
     on the comparison operator here would make the strictest setting reject
     everything, which is the kind of edge a caller would reasonably expect to
     work. */
  const eligible = candidates.filter((pair) => pair.score >= threshold);

  const eligibleIncoming = new Set<number>();
  for (const pair of eligible) {
    eligibleIncoming.add(pair.incomingIndex);
  }

  const ties: Tie[] = [];
  /* Indexes withdrawn from assignment because they were contested. Kept as two
     sets so a tie on one axis removes only the contested node, not its
     candidates - those stay available to whoever else can claim them
     unambiguously. */
  const blockedIncoming = new Set<number>();
  const blockedPrevious = new Set<number>();

  /* AXIS 1 - one incoming node, several equally good previous candidates. */
  for (const [incomingIndex, bucket] of groupBy(eligible, (pair) => pair.incomingIndex)) {
    const { best, tied } = bestAndTied(bucket);
    if (tied.length > 1) {
      ties.push({
        axis: 'incoming_tied_between_previous',
        incomingIndexes: [incomingIndex],
        /* Sorted so the reported candidate list is stable across runs; a report
           that reorders between two identical runs is a report nobody can
           diff. */
        previousIndexes: tied.map((pair) => pair.previousIndex).sort((a, b) => a - b),
        score: best,
      });
      blockedIncoming.add(incomingIndex);
    }
  }

  /* AXIS 2 - one previous node, several equally good incoming candidates. This
     is the axis a single-direction implementation forgets, and forgetting it
     means the losing bullet silently receives a fresh id. */
  for (const [previousIndex, bucket] of groupBy(eligible, (pair) => pair.previousIndex)) {
    const { best, tied } = bestAndTied(bucket);
    if (tied.length > 1) {
      const incomingIndexes = tied.map((pair) => pair.incomingIndex).sort((a, b) => a - b);
      ties.push({
        axis: 'previous_tied_between_incoming',
        incomingIndexes,
        previousIndexes: [previousIndex],
        score: best,
      });
      /* The previous node is withdrawn, and so is every incoming node that tied
         for it: carrying the id to any of them would be the coin flip. */
      blockedPrevious.add(previousIndex);
      for (const incomingIndex of incomingIndexes) {
        blockedIncoming.add(incomingIndex);
      }
    }
  }

  /* Everything still in play after the refusals. */
  const survivors = eligible.filter(
    (pair) =>
      !blockedIncoming.has(pair.incomingIndex) && !blockedPrevious.has(pair.previousIndex),
  );

  /* THE DETERMINISTIC ORDER. Score descending is the "best first" part; the two
     index tiebreaks make the sort a TOTAL order, which is what actually
     guarantees a stable result. Without them, two pairs with equal scores on
     different axes - which is not an ambiguity, since neither node is contested
     - would be left in whatever relative order the input happened to produce,
     and `Array.prototype.sort` is only required to be stable with respect to
     the input, so the input order would leak into the answer. */
  const ordered = [...survivors].sort(
    (a, b) =>
      b.score - a.score ||
      a.previousIndex - b.previousIndex ||
      a.incomingIndex - b.incomingIndex,
  );

  const usedPrevious = new Set<number>();
  const usedIncoming = new Set<number>();
  const pairs: ScoredPair[] = [];
  for (const pair of ordered) {
    /* Greedy: the best remaining pair wins, and both of its nodes leave the
       pool. Safe here precisely BECAUSE every tie was already withdrawn - each
       remaining pair is the strict best for at least one of its two nodes, so
       there is no arbitrary choice left for greed to make. */
    if (usedPrevious.has(pair.previousIndex) || usedIncoming.has(pair.incomingIndex)) {
      continue;
    }
    pairs.push(pair);
    usedPrevious.add(pair.previousIndex);
    usedIncoming.add(pair.incomingIndex);
  }

  return {
    pairs,
    ties,
    bestScoreByIncoming,
    eligibleIncoming,
    ambiguousIncoming: blockedIncoming,
  };
}
