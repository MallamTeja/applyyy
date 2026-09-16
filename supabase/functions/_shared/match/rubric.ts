// The fit rubric — weights and bands, adopted from the harvest plan §P3.
//
// WHY THESE NUMBERS AND NOT OUR OWN: they come from a real search that produced 69
// applications, 20 first interviews and a signed contract. Inventing a weighting from
// nothing would be strictly worse, because we would have no way to tell a bad weight from
// a bad prompt. "Tested numbers" is a claim about provenance, so the provenance is
// recorded here rather than in a commit message nobody will find.
//
// FOUR WEIGHTED DIMENSIONS, NOT FIVE. Upstream scores five, but the fifth — Location — is
// pass/fail and unweighted, because it is a GATE. Our salary rule takes the same shape and
// lives beside it in the cascade. That is the reusable idea worth naming: A VETO IS NOT A
// LOW SCORE. A job requiring relocation is not "a job with fewer points"; letting it
// express itself as lost points would allow a strong technical match to outvote a
// deal-breaker, which is how a ranking quietly recommends something you already refused.
//
// THIS MODULE IS PURE ARITHMETIC AND HOLDS NO PROMPT. It is separated from the prompt
// assembly so the weighting and banding can be tested exhaustively without a model in the
// loop — the same separation `eval/gate.ts` makes when it injects its scorer.

// The four scored dimensions. A union rather than loose strings so a typo in a dimension
// name is a compile error rather than a silently missing 30% of the score.
export type MatchDimension = "technical" | "experience" | "behavioral" | "career";

// One model-produced score per dimension, each 0-100.
//
// EVERY FIELD REQUIRED, DELIBERATELY. There is no optional dimension: a partial answer is
// an error to surface, not a shape to accommodate. The runtime check in `weightedTotal`
// exists because this type cannot survive contact with a JSON response from a model.
export type DimensionScores = Readonly<Record<MatchDimension, number>>;

// What each dimension contributes to the total, in percent.
//
// Adopted verbatim: Technical 30, Experience 25, Behavioral 15, Career 30. They sum to
// 100 and a test asserts it, because a future edit that changes one without rebalancing
// would silently rescale every score the system has ever produced — including the ones
// already sitting in `applications.match_score`, which would then be incomparable with
// new ones while looking identical.
export const DIMENSION_WEIGHTS: Readonly<Record<MatchDimension, number>> = {
  // How well the required skills align with what the candidate actually has.
  technical: 30,
  // Whether the work history matches the FUNCTION of the role rather than its job title.
  experience: 25,
  // Culture and working-style fit. The smallest weight because it is the least
  // evidenced from a posting alone.
  behavioral: 15,
  // Whether the role advances the career, weighted equal to raw skill match on purpose:
  // a job you can do is not the same as a job worth doing.
  career: 30,
};

// The named fit bands. §P3's thresholds, which drive routing rather than description.
export type FitBand = "strong" | "good" | "moderate" | "weak" | "poor";

// Where each band starts. Declared as data rather than buried in an if-chain so the
// boundaries are readable next to each other and a gap or overlap is visible.
const BAND_FLOORS: readonly { readonly floor: number; readonly band: FitBand }[] = [
  // Definitely apply, tailor everything.
  { floor: 75, band: "strong" },
  // Apply, and address the gaps in the cover letter.
  { floor: 60, band: "good" },
  // THE HUMAN-REVIEW BAND. §P3 routes this to Teja rather than deciding for him, which is
  // the two-bucket approval design arriving pre-specified.
  { floor: 45, band: "moderate" },
  // Probably skip, absent a strategic reason.
  { floor: 30, band: "weak" },
  // Skip.
  { floor: 0, band: "poor" },
];

// Every dimension name, for validation. Derived from the weights so the two can never
// disagree — adding a dimension to the weights automatically requires a score for it.
const ALL_DIMENSIONS = Object.keys(DIMENSION_WEIGHTS) as readonly MatchDimension[];

// Combine the four dimension scores into the single 0-100 number a human will read.
//
// THROWS RATHER THAN DEFAULTING, AND THIS IS THE MOST IMPORTANT DECISION IN THE FILE.
// A missing dimension silently contributing zero drags a Strong Fit (75+) down into Weak
// (30-44), and the output carries nothing that distinguishes "the model judged this
// harshly" from "the model never answered". It reads as a considered judgement rather
// than a bug, which is the most expensive way for a number to be wrong — a human trusts
// it precisely because it looks deliberate.
//
// This is one instance of a failure family this codebase keeps meeting: MISSING DATA MUST
// NOT BECOME AN ANSWER. `cascade.ts:160` rules the same way for an unparseable experience
// value, and the salary gate beside this file rules it for an unparseable pay range.
export function weightedTotal(scores: DimensionScores): number {
  // Accumulate in percent-points so the division happens exactly once, at the end. A
  // running average would compound rounding error across four terms.
  let weightedSum = 0;

  for (const dimension of ALL_DIMENSIONS) {
    // Read through an index rather than destructuring, because the value genuinely may
    // not be there despite what the type claims.
    const value = scores[dimension];

    // Absent entirely, or present as the null a JSON response happily supplies. Both are
    // "the model did not answer", and neither may become a zero.
    if (value === null || value === undefined) {
      throw new Error(`match rubric: dimension "${dimension}" is missing; a partial score must not be completed with a default`);
    }

    // A non-number, or NaN, which would poison the total silently — NaN propagates through
    // arithmetic and compares false against every threshold, so it would land in the
    // lowest band without ever looking like an error.
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new Error(`match rubric: dimension "${dimension}" is not a finite number`);
    }

    // Outside the scale means the model ignored the rubric. Clamping would hide that, and
    // `applications.match_score` has a 0-100 CHECK that would reject the row later anyway
    // — better to fail here, where the dimension name is still in hand.
    if (value < 0 || value > 100) {
      throw new Error(`match rubric: dimension "${dimension}" scored ${value}, outside the 0-100 scale`);
    }

    weightedSum += value * DIMENSION_WEIGHTS[dimension];
  }

  // HALF-UP, NOT FLOOR. A truncating total biases every score downward by up to a point,
  // which is enough to move a job across a band boundary and change what happens to it.
  // `Math.round` is half-up for the non-negative values this function permits.
  return Math.round(weightedSum / 100);
}

// Turn a total into the band that decides what happens to the job.
//
// A SEPARATE FUNCTION FROM THE TOTAL so a band can be recomputed from a stored score
// without re-running the model. Historical rows in `applications.match_score` can be
// re-banded if the thresholds are ever retuned, which would be impossible if banding
// happened only at scoring time.
export function bandForScore(score: number): FitBand {
  // Walk the floors from the top down; the first one the score clears is its band.
  for (const entry of BAND_FLOORS) {
    if (score >= entry.floor) return entry.band;
  }
  // Unreachable for a validated 0-100 score, since the last floor is 0. Present so the
  // function is total rather than relying on the table's last row by luck.
  return "poor";
}
