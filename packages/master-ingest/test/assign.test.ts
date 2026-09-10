/* The deterministic assignment, tested directly with hand-written scores.
 *
 * WHY DIRECTLY RATHER THAN THROUGH THE RECONCILER. Driving this through real
 * bullets means constructing text that happens to produce the score you want,
 * and then a wrong assignment shows up as a plausible-looking node id - which
 * is exactly the shape of failure that survives review. With numbers written by
 * hand, the correct answer is visible in the test.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { assignDeterministically, type ScoredPair } from '../src/index.ts';

/* Shorthand: previous index, incoming index, score. */
function pair(previousIndex: number, incomingIndex: number, score: number): ScoredPair {
  return { previousIndex, incomingIndex, score };
}

/* Compares pairings ignoring the order they were produced in, since the ORDER
 * of the pairs array is not part of the contract - only which nodes ended up
 * matched to which. */
function pairings(pairs: readonly ScoredPair[]): string[] {
  return pairs.map((p) => p.previousIndex + '->' + p.incomingIndex).sort();
}

describe('best-first assignment', () => {
  it('takes the best pair and lets the loser fall to its next-best', () => {
    /* Incoming 0 prefers previous 0 (0.9); incoming 1 also wants previous 0
       (0.7) but must settle for previous 1 (0.65). */
    const result = assignDeterministically(
      [pair(0, 0, 0.9), pair(0, 1, 0.7), pair(1, 1, 0.65)],
      0.6,
    );
    assert.deepEqual(pairings(result.pairs), ['0->0', '1->1']);
    assert.deepEqual(result.ties, []);
  });

  it('leaves a node unassigned when its only candidate was taken', () => {
    const result = assignDeterministically([pair(0, 0, 0.9), pair(0, 1, 0.7)], 0.6);
    assert.deepEqual(pairings(result.pairs), ['0->0']);
    /* Incoming 1 was eligible - its score cleared the threshold - so the caller
       can report "candidate taken" rather than "no candidate", which are
       different facts about the same node. */
    assert.ok(result.eligibleIncoming.has(1));
    assert.equal(result.ambiguousIncoming.has(1), false);
  });

  /* THE BUG A FIRST-MATCH LOOP PRODUCES. The same pairs in a different input
     order must produce the same answer; otherwise moving a bullet in the resume
     changes which ids carry. */
  it('gives the same answer regardless of input order', () => {
    const candidates = [pair(0, 0, 0.9), pair(0, 1, 0.7), pair(1, 1, 0.65), pair(1, 0, 0.61)];
    const forwards = assignDeterministically(candidates, 0.6);
    const backwards = assignDeterministically([...candidates].reverse(), 0.6);
    assert.deepEqual(pairings(forwards.pairs), pairings(backwards.pairs));
    /* And the naive answer differs, which is what makes this test meaningful: a
       first-match loop over the reversed input would pair 1->0 first. */
    assert.deepEqual(pairings(forwards.pairs), ['0->0', '1->1']);
  });

  it('breaks equal scores on different axes by index, not by input order', () => {
    /* Neither node is contested here - incoming 0 wants previous 0 and incoming
       1 wants previous 1 - so equal scores are not an ambiguity, and the result
       must still be stable. */
    const candidates = [pair(0, 0, 0.8), pair(1, 1, 0.8)];
    const forwards = assignDeterministically(candidates, 0.6);
    const backwards = assignDeterministically([...candidates].reverse(), 0.6);
    assert.deepEqual(pairings(forwards.pairs), ['0->0', '1->1']);
    assert.deepEqual(pairings(backwards.pairs), ['0->0', '1->1']);
    /* THE ASSERTION THAT MAKES THE INDEX TIEBREAK LOAD-BEARING, compared
       unsorted. Worth stating precisely, because the tiebreak is easy to
       over-claim: it cannot change WHICH nodes get paired, since two
       equal-scoring pairs can only conflict by sharing an index, and sharing an
       index is a tie that was already withdrawn. What it does decide is the
       ORDER of this array, and that order flows straight into the report lists
       - so without it, two runs over the same profile with the bullets supplied
       in a different order produce reports that differ only in row order, which
       is a report nobody can diff. */
    assert.deepEqual(forwards.pairs, backwards.pairs);
  });
});

describe('the threshold boundary', () => {
  it('admits a pair exactly at the threshold', () => {
    /* `>=` rather than `>`: a threshold of exactly 1.0 must still admit an
       identical pair, or the strictest setting would reject everything. */
    const result = assignDeterministically([pair(0, 0, 0.6)], 0.6);
    assert.deepEqual(pairings(result.pairs), ['0->0']);
  });

  it('rejects a pair just below it but still reports its score', () => {
    const result = assignDeterministically([pair(0, 0, 0.599)], 0.6);
    assert.deepEqual(result.pairs, []);
    assert.equal(result.eligibleIncoming.has(0), false);
    /* The near-miss score survives, which is what lets the report say "closest
       match scored 0.599" instead of "no match". */
    assert.equal(result.bestScoreByIncoming.get(0), 0.599);
  });
});

describe('tie detection on both axes', () => {
  /* AXIS 1 - one incoming node, two equally good previous candidates. */
  it('refuses when one incoming node ties between two previous nodes', () => {
    const result = assignDeterministically([pair(0, 0, 0.8), pair(1, 0, 0.8)], 0.6);
    assert.deepEqual(result.pairs, []);
    assert.equal(result.ties.length, 1);
    assert.equal(result.ties[0]?.axis, 'incoming_tied_between_previous');
    assert.deepEqual(result.ties[0]?.previousIndexes, [0, 1]);
    assert.ok(result.ambiguousIncoming.has(0));
  });

  /* AXIS 2 - one previous node, two equally good incoming candidates. This is
     the direction a single-axis implementation misses, and missing it means the
     losing node silently receives a fresh id. */
  it('refuses when two incoming nodes tie for one previous node', () => {
    const result = assignDeterministically([pair(0, 0, 0.8), pair(0, 1, 0.8)], 0.6);
    assert.deepEqual(result.pairs, []);
    assert.equal(result.ties.length, 1);
    assert.equal(result.ties[0]?.axis, 'previous_tied_between_incoming');
    assert.deepEqual(result.ties[0]?.incomingIndexes, [0, 1]);
    assert.ok(result.ambiguousIncoming.has(0));
    assert.ok(result.ambiguousIncoming.has(1));
  });

  /* TWIN - and this is the one that stops "refuses ties" from being satisfied by
     a function that refuses everything. One token of difference in the scores
     and the assignment must go through. */
  it('assigns when the scores differ by more than the tie tolerance', () => {
    const result = assignDeterministically([pair(0, 0, 0.81), pair(1, 0, 0.8)], 0.6);
    assert.deepEqual(pairings(result.pairs), ['0->0']);
    assert.deepEqual(result.ties, []);
  });

  it('withdraws only the contested node, leaving other candidates claimable', () => {
    /* Previous 0 is tied between incoming 0 and 1, so all three are withdrawn -
       but incoming 2 and previous 1 are uncontested and must still pair. */
    const result = assignDeterministically(
      [pair(0, 0, 0.8), pair(0, 1, 0.8), pair(1, 2, 0.7)],
      0.6,
    );
    assert.deepEqual(pairings(result.pairs), ['1->2']);
    assert.equal(result.ties.length, 1);
  });

  it('reports tied candidate indexes in sorted order so the report is diffable', () => {
    const result = assignDeterministically([pair(3, 0, 0.8), pair(1, 0, 0.8)], 0.6);
    assert.deepEqual(result.ties[0]?.previousIndexes, [1, 3]);
  });
});

describe('empty input', () => {
  it('returns an empty assignment rather than throwing', () => {
    /* A parent with no previous bullets, or none incoming, is an ordinary case
       - a brand-new job, or one whose bullets were all deleted. */
    const result = assignDeterministically([], 0.6);
    assert.deepEqual(result.pairs, []);
    assert.deepEqual(result.ties, []);
    assert.equal(result.bestScoreByIncoming.size, 0);
  });
});
