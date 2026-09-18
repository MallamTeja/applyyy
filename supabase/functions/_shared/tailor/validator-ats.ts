/**
 * @fileoverview ATS Parse Score Validator Gate for the Tailor Engine.
 * 
 * This module enforces ATS (Applicant Tracking System) parse quality thresholds
 * for tailored profiles before final rendering or downstream delivery.
 * 
 * DESIGN RATIONALE & DEFENSE-IN-DEPTH:
 * 1. Hard Gate Enforcement: A resume profile that scores below the minimum ATS parse
 *    threshold (85%) carries a high risk of structural parser misinterpretation,
 *    field misattribution, or text extraction failure in external ATS systems
 *    (e.g., Greenhouse, Lever, Workday, Ashby).
 * 2. Early Warning & Audit: When a parse score fails to reach the threshold, the validator
 *    emits an explicit warning log (console.warn) detailing the score deficiency so that
 *    auditors, dashboards, and caller functions can log or handle the degradation.
 * 3. Range Normalization: Accepts parse scores expressed either as percentages (0..100)
 *    or as normalized decimal ratios (0.0..1.0), guaranteeing consistent evaluation.
 *
 * @module _shared/tailor/validator-ats
 */

/**
 * Minimum required ATS parse score percentage threshold (85%).
 * Tailored profiles achieving a parse score equal to or exceeding this threshold pass the gate.
 */
export const ATS_PARSE_SCORE_THRESHOLD = 85;

/**
 * Result object interface for detailed ATS threshold evaluation.
 */
export interface AtsValidationResult {
  /** Indicates whether the parse score met or exceeded the threshold. */
  readonly ok: boolean;
  /** The normalized percentage score evaluated (0..100). */
  readonly scorePercentage: number;
  /** The minimum threshold percentage required. */
  readonly thresholdPercentage: number;
  /** Warning message string if validation failed; null if validation passed. */
  readonly warning: string | null;
}

/**
 * Normalizes a raw parse score input into a standardized 0..100 percentage value.
 *
 * @param parseScore - Raw parse score (percentage 0..100 or ratio 0.0..1.0).
 * @returns Standardized percentage score in the range [0, 100].
 */
export function normalizeParseScore(parseScore: number): number {
  // Check if input is a valid non-NaN number.
  if (typeof parseScore !== "number" || Number.isNaN(parseScore)) {
    // Return 0 for invalid non-numeric or NaN inputs.
    return 0;
  }

  // Handle decimal ratios in the range (0.0, 1.0].
  // Example: 0.85 becomes 85.0%.
  if (parseScore > 0 && parseScore <= 1.0) {
    // Convert decimal ratio to percentage.
    return parseScore * 100;
  }

  // Return score directly for values already in percentage scale (0..100) or out of bounds.
  return parseScore;
}

/**
 * Evaluates whether an ATS parse score meets or exceeds the required threshold (85%).
 *
 * Requirements:
 * 1. Exports validateAtsThreshold(parseScore: number): boolean.
 * 2. Returns true if parseScore >= 85%, otherwise false with warning.
 *
 * @param parseScore - The ATS parse score to validate (0..100 or decimal 0..1).
 * @returns True if parseScore >= 85%, false otherwise (emitting a warning).
 */
export function validateAtsThreshold(parseScore: number): boolean {
  // Step 1: Normalize score input to a standard 0..100 percentage scale.
  const normalizedScore = normalizeParseScore(parseScore);

  // Step 2: Compare normalized score against the required 85% threshold.
  const isPassing = normalizedScore >= ATS_PARSE_SCORE_THRESHOLD;

  // Step 3: Handle failing evaluation by emitting a warning log.
  if (!isPassing) {
    // Construct descriptive warning string outlining score deficit.
    const warningMessage =
      `[ATS Validator Warning] ATS parse score (${normalizedScore.toFixed(1)}%) ` +
      `is below the required threshold of ${ATS_PARSE_SCORE_THRESHOLD}%.`;

    // Log warning message to console for telemetry and auditing.
    console.warn(warningMessage);

    // Return false to indicate threshold failure.
    return false;
  }

  // Step 4: Return true for scores meeting or exceeding the threshold.
  return true;
}

/**
 * Performs a comprehensive evaluation of an ATS parse score, returning a detailed result object.
 *
 * @param parseScore - The ATS parse score to evaluate.
 * @returns An AtsValidationResult object containing full evaluation breakdown.
 */
export function evaluateAtsThresholdDetails(parseScore: number): AtsValidationResult {
  // Step 1: Normalize score to percentage scale.
  const scorePercentage = normalizeParseScore(parseScore);

  // Step 2: Perform threshold comparison against 85%.
  const ok = scorePercentage >= ATS_PARSE_SCORE_THRESHOLD;

  // Step 3: Compute warning message if failing.
  const warning = ok
    ? null
    : `[ATS Validator Warning] ATS parse score (${scorePercentage.toFixed(1)}%) ` +
      `is below the required threshold of ${ATS_PARSE_SCORE_THRESHOLD}%.`;

  // Step 4: If failing, trigger warning side-effect.
  if (!ok && warning !== null) {
    // Output warning to console log.
    console.warn(warning);
  }

  // Step 5: Return structured validation result.
  return {
    ok,
    scorePercentage,
    thresholdPercentage: ATS_PARSE_SCORE_THRESHOLD,
    warning,
  };
}
