// ============================================================================
// COVER LETTER PROMPT GENERATOR MODULE
// ============================================================================
//
// This module provides prompt construction utilities for generating professional,
// highly-tailored cover letters using Gemini LLM model pool transport.
//
// Prompt Engineering & Grounding Constraints:
//   1. System Instruction: Establishes strict professional tone and anti-fabrication
//      guardrails. Every claim, experience, skill, metric, and company reference
//      MUST strictly ground to the candidate's master profile.
//   2. Fenced Untrusted Input: Formats job description and posting text inside
//      fenced blocks to eliminate prompt-injection vectors.
//   3. Structured Output Schema: Demands JSON output conforming to a defined schema
//      containing the generated cover letter prose.
// ============================================================================

// Import shared contract interfaces for MasterProfile and ResolvedResume
import type { MasterProfile, ResolvedResume } from "../_shared/contracts/shared-types.ts";

/**
 * Input arguments required to construct a Cover Letter Gemini prompt.
 */
export interface CoverLetterPromptInput {
  /** The pinned master profile snapshot from the database. */
  readonly master: MasterProfile;

  /** The tailored resolved resume snapshot associated with the application. */
  readonly resume: ResolvedResume;

  /** Job posting metadata including job title, company name, and raw description text. */
  readonly job: {
    /** Title of the targeted position. */
    readonly title: string;

    /** Name of the hiring company. */
    readonly companyName: string;

    /** Raw untrusted job description text content. */
    readonly descriptionRaw: string | null;
  };
}

/**
 * Structured Gemini prompt payload ready for model transport execution.
 */
export interface GeminiPromptPayload {
  /** System instruction establishing identity, persona, and anti-fabrication rules. */
  readonly systemInstruction: string;

  /** Fenced user content containing candidate profile data and job context. */
  readonly userContent: string;

  /** Structured JSON Schema object constraining Gemini response output. */
  readonly responseSchema: Record<string, unknown>;
}

/**
 * Construct a structured Gemini prompt payload for generating a tailored cover letter.
 *
 * Grounding Guarantee:
 *   - Identity fields (full_name, email, phone) are extracted directly from MasterProfile.
 *   - Experience roles, companies, and bullet text are extracted directly from ResolvedResume.
 *   - Skill names are extracted directly from ResolvedResume.skills.
 *   - Untrusted job description text is safely enclosed within <untrusted_job_description> tags.
 *
 * @param input Input profile, resume, and job metadata.
 * @returns Structured Gemini prompt payload object.
 */
export function buildCoverLetterPrompt(input: CoverLetterPromptInput): GeminiPromptPayload {
  // Extract candidate identity details object from master profile with safe fallback defaults
  const identity = input.master.identity;

  // Extract candidate full_name from identity object (MasterIdentity contract field)
  // Fall back to "Applicant" string if full_name property is missing or empty
  const candidateName = identity.full_name || "Applicant";

  // Extract candidate email address string from identity object
  // Fall back to empty string if email property is undefined
  const candidateEmail = identity.email || "";

  // Extract candidate phone number string from identity object
  // Fall back to empty string if phone property is null or undefined
  const candidatePhone = identity.phone || "";

  // Create temporary header array containing candidate identity components
  const identityParts = [candidateName, candidateEmail, candidatePhone];

  // Construct candidate contact header string by filtering out empty values and joining with pipe separator
  const contactHeader = identityParts.filter(Boolean).join(" | ");

  // Define system instruction establishing anti-fabrication rules, professional persona, and output rules
  const systemInstruction = `
You are an expert executive cover letter author and career advisor.
Your objective is to draft a compelling, highly-tailored, professional 3-4 paragraph cover letter for ${candidateName} applying for the role of ${input.job.title} at ${input.job.companyName}.

CRITICAL HONESTY & ANTI-FABRICATION CONSTRAINTS:
1. Grounding: You MUST ONLY reference work experience, skills, projects, degrees, technologies, metrics, and achievements that exist in the candidate's provided Master Profile or Tailored Resume.
2. Zero Invention: NEVER invent or hallucinate any employer, job title, date range, metric, tool, degree, award, or technical claim.
3. Tone: Professional, direct, enthusiastic, and tailored to the job requirements without hyperbole or clichés.
4. Output Format: Return a clean JSON object adhering strictly to the provided response schema, containing the completed cover letter string under the "coverLetter" key.
`.trim();

  // Extract raw job description string from job object
  const rawDesc = input.job.descriptionRaw;

  // Check whether untrusted raw job description string is present and non-empty
  const hasDescription = Boolean(rawDesc);

  // Format job description text within fenced untrusted block to defeat prompt injection attacks
  const fencedJobDescription = hasDescription
    ? `\n<untrusted_job_description>\n${rawDesc}\n</untrusted_job_description>`
    : "";

  // Extract experience array from tailored resolved resume object
  const expList = input.resume.experience;

  // Format resume experience bullet lines for context prompt using ResolvedExperience fields (role, company)
  const experienceSummary = expList
    .map((exp) => {
      // Extract role title string from experience item
      const roleTitle = exp.role;

      // Extract company name string from experience item
      const companyName = exp.company;

      // Format company name and role title header using ResolvedExperience contract property 'role'
      const header = `${roleTitle} at ${companyName}`;

      // Map experience bullets into formatted list with bullet points
      const bullets = exp.bullets.map((b) => `  - ${b.text}`).join("\n");

      // Combine header line and indented bullet points
      return `${header}:\n${bullets}`;
    })
    // Join experience entries with double newlines
    .join("\n\n");

  // Extract skills array from tailored resolved resume object
  const skillList = input.resume.skills;

  // Format candidate top skills list into comma-separated string
  const skillsSummary = skillList.map((s) => s.name).join(", ");

  // Extract target job position title
  const jobTitle = input.job.title;

  // Extract target hiring company name
  const hiringCompany = input.job.companyName;

  // Construct user content lines array
  const userContentLines = [
    // Contact section header
    "CANDIDATE CONTACT:",
    // Contact details string
    contactHeader,
    // Spacer
    "",
    // Target position section header
    "TARGET POSITION:",
    // Position title
    `Title: ${jobTitle}`,
    // Company name
    `Company: ${hiringCompany}`,
    // Spacer
    "",
    // Skills section header
    "CANDIDATE HIGHLIGHTED SKILLS:",
    // Skills list
    skillsSummary,
    // Spacer
    "",
    // Experience section header
    "CANDIDATE RELEVANT WORK EXPERIENCE:",
    // Experience summary
    experienceSummary,
    // Spacer
    "",
    // Job description section header and content
    `JOB DESCRIPTION CONTEXT:${fencedJobDescription}`,
    // Spacer
    "",
    // Tailoring instruction header
    "INSTRUCTION:",
    // Tailoring prompt line 1
    `Write a 3 to 4 paragraph cover letter tailored to ${jobTitle} at ${hiringCompany}.`,
    // Tailoring prompt line 2 enforcing grounding
    "Ensure every achievement and technical skill cited is directly backed by the candidate profile above.",
  ];

  // Construct complete user content prompt string combining candidate profile sections and job context
  const userContent = userContentLines.join("\n").trim();

  // Define JSON schema for Gemini structured output forcing return object shape
  const responseSchema = {
    // Top-level response data type is OBJECT
    type: "OBJECT",
    // Properties map defining required coverLetter string field
    properties: {
      // Cover letter string property definition
      coverLetter: {
        // Data type string
        type: "STRING",
        // Field description explanation for Gemini model
        description: "The complete, formatted 3 to 4 paragraph cover letter text.",
      },
    },
    // Array of required JSON property names in output object
    required: ["coverLetter"],
  };

  // Return constructed Gemini prompt payload object with instruction, user content, and schema
  return {
    // System instruction string
    systemInstruction,
    // Fenced user content string
    userContent,
    // Response schema object
    responseSchema,
  };
}
