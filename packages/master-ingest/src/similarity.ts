/* How alike two bullets are, and the one number in this package that nobody can
 * set safely.
 *
 * TOKEN-BASED, NOT CHARACTER-BASED, AND THAT IS A DECISION ABOUT THE INPUT.
 * The edit Teja actually makes in Overleaf is a REWORDING: he keeps the nouns
 * and the numbers and changes the verbs and the connective tissue. A character
 * metric (Levenshtein, trigram) reads that as a large edit, because most of the
 * characters moved. A token-set metric reads it as a small one, because the
 * content words are still there. Choosing the metric that matches the edit is
 * what makes the threshold meaningful at all.
 *
 * DICE RATHER THAN JACCARD, though they rank identically and either would work.
 * Dice divides the shared tokens by the AVERAGE set size rather than the union,
 * so it is less punishing when a rewording adds words — which is the common
 * direction of an Overleaf edit, since bullets grow as a claim gets more
 * specific. Concretely, {cut,p95,latency,40} vs {reduced,p95,latency,by,40}
 * scores 0.67 under Dice and 0.50 under Jaccard: the same pair, on opposite
 * sides of a 0.6 threshold. So the choice of metric and the choice of threshold
 * are not independent, and changing one without the other is a silent behaviour
 * change. Recorded here because the ranking-equivalence makes it look free.
 */

/* Dice coefficient: 2 * |A n B| / (|A| + |B|). Ranges 0..1.
 *
 * Pure and symmetric, which the deterministic assignment in `assign.ts` relies
 * on: it detects a tie by comparing scores computed in both directions of the
 * same pairing, and an asymmetric metric would make a tie invisible from one
 * side. */
export function diceSimilarity(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  /* Two empty token sets score 0, NOT 1. The arithmetic would be 0/0 = NaN, and
     NaN silently compares false against every threshold — so the pair would
     behave as "no match" while any number written into the report is garbage.
     More importantly, two bullets with no tokens are not evidence of identity;
     a byte-identical empty bullet is caught by the exact-text pass before this
     function is ever reached. */
  if (a.size === 0 || b.size === 0) {
    return 0;
  }
  /* Count the intersection by walking the smaller set, so the cost is bounded
     by the shorter bullet rather than the longer one. */
  const [smaller, larger] = a.size <= b.size ? [a, b] : [b, a];
  let shared = 0;
  for (const token of smaller) {
    /* Set membership rather than an array scan: bullet pairs are scored
       O(previous * incoming) times per parent, so a linear membership test
       turns a 20-bullet job into 400 array walks. */
    if (larger.has(token)) {
      shared += 1;
    }
  }
  return (2 * shared) / (a.size + b.size);
}

/* THE KNOB THAT WILL BITE SOMEONE LATER. Read this before changing it.
 *
 * This threshold FAILS SILENTLY IN BOTH DIRECTIONS, and neither failure raises
 * anything anywhere:
 *
 *   TOO LOW  — two different bullets under the same job match, so a previous id
 *              carries onto a claim it was never about. Every pinned
 *              application that referenced that id now points at different
 *              text, and re-tailoring selects a bullet whose id means something
 *              else than it did. Nothing errors; the profile is valid.
 *   TOO HIGH — a bullet Teja reworded fails to match itself, gets a fresh id,
 *              and every old pin referencing it dangles. Nothing errors; the
 *              profile is valid.
 *
 * NO VALUE IS SAFE BY CONSTRUCTION, and this is provable rather than cautious.
 * `Built the auth service` and `Built the billing service` — two genuinely
 * different bullets — score 0.75. `Cut p95 latency 40%` and `Reduced p95
 * latency by 40%` — the same bullet, reworded — score 0.67. The false pair
 * scores HIGHER than the true pair, so there is no threshold that accepts the
 * second and rejects the first. Tuning this number cannot fix that, because the
 * ordering is wrong, not the cut point.
 *
 * WHICH IS WHY THE MITIGATION IS NOT A BETTER NUMBER. The ingest flow must show
 * a human EVERY non-exact match — the previous text, the incoming text, and the
 * score — and never a total. `nonExactCarries()` in `report.ts` exists for
 * exactly that, and a UI that renders a count instead of the list has removed
 * the only defence this package actually has.
 *
 * 0.6 is chosen to sit just below the reworded-bullet example above, so the
 * edit Teja actually produces carries by default. It is a default, not a
 * guarantee, and it is overridable per call so no caller silently inherits it. */
export const DEFAULT_BULLET_SIMILARITY_THRESHOLD = 0.6;

/* Two scores are "the same" within this tolerance, which is what makes a tie
 * detectable.
 *
 * Dice scores are rationals over small integers, and two MATHEMATICALLY equal
 * scores computed from different set sizes need not be bit-identical doubles —
 * 6/9 and 4/6 are both two thirds and are not required to round to the same
 * value. A tie that fails to register by one bit is not a rounding curiosity:
 * it is precisely the case where the assignment silently picks one candidate
 * over an equally-good one, which is the misattribution this package exists to
 * prevent. So ties are compared with a tolerance, deliberately erring towards
 * calling something ambiguous. */
export const SCORE_TIE_TOLERANCE = 1e-9;

/* Whether two scores count as tied. Named rather than inlined so the tolerance
 * has exactly one reader and cannot drift between the two axes of tie
 * detection. */
export function scoresAreTied(a: number, b: number): boolean {
  return Math.abs(a - b) <= SCORE_TIE_TOLERANCE;
}
