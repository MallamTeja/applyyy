// Cover Letter domain rules, validation schema, salutation ladder, and rendering utilities.
//
// WHY THIS MODULE IS SEPARATED FROM PROMPT ASSEMBLY:
// This module owns the validation rules, JSON schema contract, word count budgeting,
// salutation selection ladder, and formatting logic for tailored cover letters.
// Separating schema definition and runtime validation from prompt generation ensures
// that cover letter validation logic can be executed independently across stages.
//
// HISTORICAL PROVENANCE & CONSTRAINTS:
// Based on real application data (69 applications, 20 first interviews), a cover letter
// must fit strictly on a single page. 250-300 words of body text is the target length.
// Body text exceeding 350 words overflows a single page and is rejected as a hard limit.

// Import MasterProfile contract type for reference verification.
import type { MasterProfile } from "../contracts/shared-types.ts";

// Target lower bound word count for body text (250 words).
// Recommended minimum length for a complete 3-paragraph cover letter.
export const WORD_COUNT_MIN = 250;

// Target upper bound word count for body text (300 words).
// Safe maximum length to fit on one page alongside header and signoff blocks.
export const WORD_COUNT_MAX = 300;

// Hard upper bound limit for body text (350 words).
// Exceeding 350 words overflows a single page and causes strict validation failure.
export const WORD_COUNT_HARD_LIMIT = 350;

// Forbidden salutation phrases that violate professional anti-impersonation and personalization rules.
// "To whom it may concern" is explicitly prohibited across all cover letters.
export const FORBIDDEN_SALUTATIONS = ["to whom it may concern"] as const;

// Interface representing the 3 distinct paragraphs of a tailored cover letter.
//
// PARAGRAPH 1 (opening): Hook connecting candidate interest to the specific role and company.
// PARAGRAPH 2 (body): Core evidence aligning past achievements and technical skills to job requirements.
// PARAGRAPH 3 (closing): Call to action, enthusiasm statement, and transition to signoff.
export interface CoverLetterParagraphs {
  // Paragraph 1: Opening hook referencing role and company value proposition.
  readonly opening: string;
  // Paragraph 2: Core body alignment citing master profile achievements.
  readonly body: string;
  // Paragraph 3: Closing statement with call to action.
  readonly closing: string;
}

// Full output object returned by the Gemini cover letter generation model.
//
// SHARED SCHEMA CONTRACT:
// Matches the structured output JSON schema sent to Gemini via `COVER_LETTER_RESPONSE_SCHEMA`.
export interface CoverLetterOutput {
  // Master profile version pinned when generating this cover letter.
  readonly masterVersion: number;
  // Salutation string selected according to the salutation ladder rules.
  readonly salutation: string;
  // The 3 required body paragraphs (opening, body, closing).
  readonly paragraphs: CoverLetterParagraphs;
  // Professional closing signoff line (e.g. "Sincerely, Candidate Name").
  readonly signoff: string;
  // Array of master profile node ref IDs cited in the cover letter text.
  readonly refs: readonly string[];
}

// Result structure returned by cover letter validation.
export interface CoverLetterValidationResult {
  // Boolean flag indicating whether all validation checks passed.
  readonly valid: boolean;
  // List of human-readable error descriptions explaining any failed rules.
  readonly errors: readonly string[];
  // Total calculated word count of all 3 cover letter paragraphs combined.
  readonly wordCount: number;
}

// JSON Schema definition for Gemini structured response matching `CoverLetterOutput`.
//
// WHY STRUCTURED RESPONSE SCHEMA IS MANDATORY:
// Enforces that Gemini returns well-formed JSON containing exactly the required fields.
// Eliminates free-form text formatting errors and guarantees structured paragraph separation.
export const COVER_LETTER_RESPONSE_SCHEMA: Record<string, unknown> = {
  // Root type must be a JSON object.
  type: "object",
  // Object property definitions.
  properties: {
    // Echoed master version integer for snapshot alignment.
    master_version: { type: "integer" },
    // Salutation line string.
    salutation: { type: "string" },
    // Container object for the 3 distinct cover letter paragraphs.
    paragraphs: {
      // Paragraphs property must be an object.
      type: "object",
      // Inner paragraph string properties.
      properties: {
        // Opening paragraph string.
        opening: { type: "string" },
        // Body paragraph string.
        body: { type: "string" },
        // Closing paragraph string.
        closing: { type: "string" },
      },
      // All 3 paragraphs are required.
      required: ["opening", "body", "closing"],
    },
    // Signoff phrase string.
    signoff: { type: "string" },
    // Array of master node ref ID strings cited in the letter.
    refs: {
      // Type is array.
      type: "array",
      // Items are string reference IDs.
      items: { type: "string" },
    },
  },
  // Top-level required fields for schema validation.
  required: ["master_version", "salutation", "paragraphs", "signoff", "refs"],
};

// Count words in a block of text by splitting on whitespace sequences.
//
// @param text - Input string to count words for.
// @returns Integer number of words present in the text.
export function countWords(text: string): number {
  // Trim leading and trailing whitespace from input string.
  const trimmed = text.trim();
  // Return 0 if the string is empty after trimming.
  if (trimmed === "") {
    // Zero words in empty text.
    return 0;
  }
  // Split on any sequence of whitespace characters (spaces, tabs, newlines).
  const words = trimmed.split(/\s+/);
  // Return total count of array elements.
  return words.length;
}

// Select appropriate salutation using the 3-rung salutation ladder.
//
// SALUTATION LADDER RULES:
// Rung 1: If verified hiring manager name is available -> "Dear [First Last],"
// Rung 2: Else if team name is available -> "Dear [Company] hiring team,"
// Rung 3: Generic fallback -> "Dear [Company],"
// ANTI-FABRICATION RULE: Never emit "To whom it may concern".
//
// @param company - Name of the target employer company.
// @param hiringManagerName - Optional hiring manager full name if verified.
// @param teamName - Optional specific team or department name if known.
// @returns Selected salutation string.
export function selectSalutation(
  company: string,
  hiringManagerName?: string | null,
  teamName?: string | null,
): string {
  // Clean and trim target company name input.
  const cleanCompany = company.trim();

  // Check Rung 1: Verified hiring manager name provided.
  if (hiringManagerName !== undefined && hiringManagerName !== null) {
    // Trim hiring manager name.
    const cleanManager = hiringManagerName.trim();
    // Verify manager name is non-empty.
    if (cleanManager !== "") {
      // Return Rung 1 salutation with manager name.
      return `Dear ${cleanManager},`;
    }
  }

  // Check Rung 2: Known team or department name provided.
  if (teamName !== undefined && teamName !== null) {
    // Trim team name.
    const cleanTeam = teamName.trim();
    // Verify team name is non-empty.
    if (cleanTeam !== "") {
      // Return Rung 2 salutation with team name.
      return `Dear ${cleanTeam} hiring team,`;
    }
  }

  // Fallback Rung 3: Generic company salutation.
  // Uses clean company name or generic default if company name is empty.
  const fallbackCompany = cleanCompany !== "" ? cleanCompany : "Hiring Team";
  // Return Rung 3 salutation string.
  return `Dear ${fallbackCompany},`;
}

// Render complete cover letter document text from structured CoverLetterOutput.
//
// Combines salutation, opening, body, closing paragraphs, and signoff with standard
// double-newline paragraph spacing for crisp presentation.
//
// @param output - Validated CoverLetterOutput object.
// @returns Formatted multi-paragraph cover letter text.
export function renderFullCoverLetter(output: CoverLetterOutput): string {
  // Array collecting distinct text blocks of the cover letter.
  const blocks: string[] = [
    // Salutation block.
    output.salutation,
    // Opening paragraph (Paragraph 1).
    output.paragraphs.opening,
    // Body paragraph (Paragraph 2).
    output.paragraphs.body,
    // Closing paragraph (Paragraph 3).
    output.paragraphs.closing,
    // Signoff block.
    output.signoff,
  ];

  // Join all blocks with double newlines for standard paragraph separation.
  return blocks.join("\n\n");
}

// Validate CoverLetterOutput against all structural, length, and content constraints.
//
// @param output - Output object to validate.
// @param expectedMasterVersion - Optional expected master profile version for pin verification.
// @returns CoverLetterValidationResult object with validity status and error list.
export function validateCoverLetter(
  output: CoverLetterOutput,
  expectedMasterVersion?: number,
): CoverLetterValidationResult {
  // Array accumulating error messages encountered during validation.
  const errors: string[] = [];

  // Rule 1: Master version alignment check.
  if (expectedMasterVersion !== undefined && output.masterVersion !== expectedMasterVersion) {
    // Record error if generated version does not match expected snapshot version.
    errors.push(
      `Master version mismatch: expected ${expectedMasterVersion}, received ${output.masterVersion}`,
    );
  }

  // Rule 2: Salutation prohibition check.
  // Convert salutation to lowercase for case-insensitive matching.
  const lowerSalutation = output.salutation.toLowerCase();
  // Check against forbidden salutation patterns.
  for (const forbidden of FORBIDDEN_SALUTATIONS) {
    // If salutation contains forbidden phrase, reject.
    if (lowerSalutation.includes(forbidden)) {
      // Record error for forbidden salutation.
      errors.push(`Forbidden salutation phrase detected: "${output.salutation}"`);
    }
  }

  // Rule 3: Paragraph presence and non-emptiness check.
  // Calculate opening paragraph word count.
  const openingWords = countWords(output.paragraphs.opening ?? "");
  // Calculate body paragraph word count.
  const bodyWords = countWords(output.paragraphs.body ?? "");
  // Calculate closing paragraph word count.
  const closingWords = countWords(output.paragraphs.closing ?? "");

  // Verify opening paragraph is non-empty.
  if (openingWords === 0) {
    // Record error for missing opening paragraph.
    errors.push("Opening paragraph is missing or empty");
  }
  // Verify body paragraph is non-empty.
  if (bodyWords === 0) {
    // Record error for missing body paragraph.
    errors.push("Body paragraph is missing or empty");
  }
  // Verify closing paragraph is non-empty.
  if (closingWords === 0) {
    // Record error for missing closing paragraph.
    errors.push("Closing paragraph is missing or empty");
  }

  // Rule 4: Total word count budget evaluation.
  // Total body word count across opening, body, and closing paragraphs.
  const totalWordCount = openingWords + bodyWords + closingWords;

  // Check if total word count exceeds the hard 1-page overflow limit (350 words).
  if (totalWordCount > WORD_COUNT_HARD_LIMIT) {
    // Record error for hard word limit overflow.
    errors.push(
      `Cover letter word count (${totalWordCount}) exceeds hard limit of ${WORD_COUNT_HARD_LIMIT} words`,
    );
  }

  // Rule 5: Citation references check.
  // Ensure that at least one master profile ref ID is cited in the letter.
  if (!Array.isArray(output.refs) || output.refs.length === 0) {
    // Record error for ungrounded cover letter missing master profile citations.
    errors.push("Cover letter output must cite at least one master profile reference ID");
  }

  // Return validation result summary.
  return {
    // Valid if error array is completely empty.
    valid: errors.length === 0,
    // Readonly error array.
    errors,
    // Calculated total word count.
    wordCount: totalWordCount,
  };
}
