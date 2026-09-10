/* The similarity metric, and the two worked examples that prove the threshold
 * cannot be set safely.
 *
 * WHY THE DOCUMENTED EXAMPLES ARE ASSERTED HERE. `similarity.ts` claims that a
 * FALSE pair scores HIGHER than a TRUE pair, and concludes from that that no
 * threshold exists which accepts one and rejects the other. That is the
 * justification for showing a human every non-exact match, so it is the most
 * consequential claim in the package - and a claim in a comment rots silently.
 * Asserting the two numbers here means changing the metric breaks these tests
 * loudly instead of quietly invalidating the reasoning that shaped the design.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  DEFAULT_BULLET_SIMILARITY_THRESHOLD,
  diceSimilarity,
  scoresAreTied,
  SCORE_TIE_TOLERANCE,
  tokenSet,
} from '../src/index.ts';

/* Convenience: score two raw strings the way the reconciler does. */
function score(a: string, b: string): number {
  return diceSimilarity(tokenSet(a), tokenSet(b));
}

describe('diceSimilarity', () => {
  it('is 1 for identical token sets and 0 for disjoint ones', () => {
    assert.equal(score('alpha beta', 'beta alpha'), 1);
    assert.equal(score('alpha beta', 'gamma delta'), 0);
  });

  it('is symmetric, which the tie detection depends on', () => {
    /* `assign.ts` compares scores computed from both directions of a pairing;
       an asymmetric metric would make a tie invisible from one side. */
    assert.equal(score('alpha beta gamma', 'alpha beta'), score('alpha beta', 'alpha beta gamma'));
  });

  it('scores two empty token sets 0, not 1 and not NaN', () => {
    /* The arithmetic would be 0/0. NaN compares false against every threshold,
       so the pair would behave as no-match while any number written into the
       report is garbage. */
    const empty = tokenSet('');
    assert.equal(diceSimilarity(empty, empty), 0);
    assert.equal(diceSimilarity(empty, tokenSet('alpha')), 0);
  });
});

describe('the two worked examples from similarity.ts', () => {
  /* THE TRUE PAIR: the same bullet, reworded the way it actually gets reworded. */
  const truePair = score(
    'Cut p95 latency 40%',
    'Reduced p95 latency by 40%',
  );
  /* THE FALSE PAIR: two genuinely different claims that share their sentence
     frame - which is how most bullets under one job are written. */
  const falsePair = score('Built the auth service', 'Built the billing service');

  it('scores the true pair about 0.67', () => {
    assert.ok(truePair > 0.66 && truePair < 0.67, 'got ' + String(truePair));
  });

  it('scores the false pair 0.75', () => {
    assert.equal(falsePair, 0.75);
  });

  /* THE CONCLUSION THE WHOLE DESIGN RESTS ON. Because the false pair scores
     higher, there is no cut point that admits the rewording and rejects the
     unrelated pair. Tuning the number cannot fix this: the ORDERING is wrong,
     not the threshold. Which is why the mitigation is a human looking at every
     non-exact match, and why a UI that renders a count has removed the only
     real defence in this package. */
  it('scores the false pair HIGHER than the true pair, so no safe threshold exists', () => {
    assert.ok(falsePair > truePair, String(falsePair) + ' must exceed ' + String(truePair));
  });

  it('has a default threshold that admits the true pair', () => {
    /* The default is chosen to sit just below the rewording that actually
       happens, which is the best a single number can do. */
    assert.ok(truePair >= DEFAULT_BULLET_SIMILARITY_THRESHOLD);
    assert.equal(DEFAULT_BULLET_SIMILARITY_THRESHOLD, 0.6);
  });
});

describe('scoresAreTied', () => {
  it('treats mathematically equal scores from different set sizes as tied', () => {
    /* 6/9 and 4/6 are both two thirds and are not required to round to the same
       double. A tie that fails to register by one bit is a silent coin flip, so
       the comparison uses a tolerance. */
    assert.ok(scoresAreTied(6 / 9, 4 / 6));
    assert.ok(scoresAreTied(0.8, 0.8 + SCORE_TIE_TOLERANCE / 2));
  });

  /* TWIN - without this, a function returning `true` unconditionally would pass
     the test above, and every scored pair would be reported as ambiguous. */
  it('does not treat genuinely different scores as tied', () => {
    assert.equal(scoresAreTied(0.8, 0.75), false);
    assert.equal(scoresAreTied(0.8, 0.8 + 1e-6), false);
  });
});
