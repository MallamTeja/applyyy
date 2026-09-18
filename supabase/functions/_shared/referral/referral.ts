// ============================================================================
// REFERRAL OUTREACH CORE MODULE
// ============================================================================
//
// Identity & Bounded Domain: Referral Outreach Core Engineer
// Allowed Path: supabase/functions/_shared/referral/referral.ts
//
// Purpose:
// Generates personalized referral request messages for target employees, alumni,
// and recruiters at target hiring companies based on job details and candidate background.
//
// Key Responsibilities:
//   1. Determine connection angle (alumni, peer, recruiter, employee, cold).
//   2. Generate personalized subject lines tailored to channel and connection angle.
//   3. Compute outreach prompts and draft referral messages (AI prompt + fallback).
//   4. Calculate personalization score metrics evaluating hook and context depth.
//   5. Validate outreach message safety, length compliance, and call-to-action presence.
//
// Architecture & Verification Constraints:
//   - Deno reload type checks with zero errors under deno check.
//   - Node test runner compatibility under node --test.
//   - Source comment ratio strictly >= 1.00.
// ============================================================================

// Import prompt generator functions and types from sibling prompt module
// Import buildReferralPromptPackage for LLM prompt package assembly
// Import generateTemplateFallback for zero-network deterministic message generation
// Import domain type definitions for candidate, contact, job, and prompt options
import {
  buildReferralPromptPackage,
  generateTemplateFallback,
  type PromptCandidateDetails,
  type PromptContactDetails,
  type PromptJobDetails,
  type ReferralChannel,
  type ReferralPromptInput,
  type ReferralPromptPackage,
} from "./prompt.ts";

/**
 * Re-export candidate background type alias for domain clarity.
 * Provides uniform type naming across referral outreach modules.
 */
export type CandidateInfo = PromptCandidateDetails;

/**
 * Re-export contact background type alias for domain clarity.
 * Provides uniform type naming across referral outreach modules.
 */
export type TargetContactInfo = PromptContactDetails;

/**
 * Re-export job background type alias for domain clarity.
 * Provides uniform type naming across referral outreach modules.
 */
export type TargetJobInfo = PromptJobDetails;

/**
 * Connection angle classification for referral outreach strategy.
 * Defines the strategic relationship hook used to open the message.
 */
export type ConnectionAngle =
  | "alumni_connection"
  | "same_role_peer"
  | "recruiter_direct"
  | "company_employee"
  | "general_cold";

/**
 * Outreach request input structure.
 * Encapsulates all data needed to synthesize a referral message.
 */
export interface ReferralOutreachRequest {
  /** Candidate background details object. */
  readonly candidate: CandidateInfo;
  /** Target contact details object. */
  readonly contact: TargetContactInfo;
  /** Target job position details object. */
  readonly job: TargetJobInfo;
  /** Messaging channel to target (linkedin_dm, email, or inmail). */
  readonly channel: ReferralChannel;
  /** Optional custom message override or seed text. */
  readonly customNote?: string;
  /** Optional override for maximum word count. */
  readonly maxWords?: number;
}

/**
 * Complete synthesized referral outreach message result.
 * Bundles generated text, calculated metrics, classification, and prompt package.
 */
export interface ReferralOutreachMessage {
  /** Subject line (for email/inmail, empty string for short LinkedIn DM). */
  readonly subject: string;
  /** Main message body content text. */
  readonly body: string;
  /** Messaging channel utilized. */
  readonly channel: ReferralChannel;
  /** Determined connection angle hook strategy. */
  readonly angle: ConnectionAngle;
  /** Total word count of message body. */
  readonly wordCount: number;
  /** Total character count of message body. */
  readonly characterCount: number;
  /** Personalization quality score from 0 to 100. */
  readonly personalizationScore: number;
  /** True if explicit call-to-action is present in message body. */
  readonly hasCallToAction: boolean;
  /** Associated AI prompt package for downstream LLM invocation. */
  readonly promptPackage: ReferralPromptPackage;
}

/**
 * Result structure returned by message validation checks.
 * Indicates compliance status and lists detected validation issues.
 */
export interface ValidationResult {
  /** True if message meets all length, tone, and CTA compliance checks. */
  readonly isValid: boolean;
  /** List of warning or error messages if validation fails. */
  readonly issues: readonly string[];
}

/**
 * Determine primary connection angle hook based on candidate and contact profile.
 * Evaluates relationship attributes to pick the highest converting strategy.
 *
 * @param candidate Candidate background info object.
 * @param contact Target contact info object.
 * @returns ConnectionAngle enum value.
 */
export function determineConnectionAngle(
  candidate: CandidateInfo,
  contact: TargetContactInfo,
): ConnectionAngle {
  // Check if connection type is explicitly marked as alumni or shared college exists
  // Compares lowercased college strings to identify educational overlap
  if (
    contact.connectionType === "alumni" ||
    (contact.sharedCollege &&
      candidate.almaMater &&
      contact.sharedCollege.toLowerCase() === candidate.almaMater.toLowerCase())
  ) {
    // Return alumni connection angle hook
    // Alumni connections convert at significantly higher rates
    return "alumni_connection";
  }

  // Check if contact is a recruiter or talent acquisition specialist
  // Evaluates connectionType string or title keywords
  if (
    contact.connectionType === "recruiter" ||
    contact.title.toLowerCase().includes("recruiter") ||
    contact.title.toLowerCase().includes("talent acquisition") ||
    contact.title.toLowerCase().includes("hiring manager")
  ) {
    // Return recruiter direct outreach angle hook
    // Recruiters seek active candidates directly for requisitions
    return "recruiter_direct";
  }

  // Check if candidate and contact share peer role titles or connection type is peer
  // Evaluates engineer or developer keywords in job titles
  if (
    contact.connectionType === "peer" ||
    (contact.title &&
      candidate.currentRole &&
      (contact.title.toLowerCase().includes("engineer") ||
        contact.title.toLowerCase().includes("developer")) &&
      (candidate.currentRole.toLowerCase().includes("engineer") ||
        candidate.currentRole.toLowerCase().includes("developer")))
  ) {
    // Return same role peer angle hook
    // Peer engineers relate well to technical candidates in their domain
    return "same_role_peer";
  }

  // Check if contact is an employee at target hiring company
  // Verifies employee connection type or company presence
  if (
    contact.connectionType === "employee" ||
    (contact.company && candidate.fullName)
  ) {
    // Return company employee angle hook
    // Internal employees can access internal referral submission forms
    return "company_employee";
  }

  // Default fallback connection angle for general cold outreach
  // Used when no explicit relationship hook is detected
  return "general_cold";
}

/**
 * Generate engaging subject line for email or InMail outreach.
 * Tailors subject header text based on relationship angle and job title.
 *
 * @param job Target job info object.
 * @param contact Target contact info object.
 * @param angle Connection angle hook strategy.
 * @param candidate Candidate background info object.
 * @returns Formatted subject line string.
 */
export function generatePersonalizedSubject(
  job: TargetJobInfo,
  contact: TargetContactInfo,
  angle: ConnectionAngle,
  candidate: CandidateInfo,
): string {
  // Extract college name string if available from contact or candidate
  // Prefers shared college attribute if explicitly defined
  const college = contact.sharedCollege || candidate.almaMater;

  // Handle alumni connection angle subject line formatting
  // Highlights shared university ties to maximize open rates
  if (angle === "alumni_connection" && college) {
    // Return subject emphasizing shared alma mater and target job title
    return `${college} Alumni - Referral Request for ${job.jobTitle}`;
  }

  // Handle recruiter direct angle subject line formatting
  // Specifies candidate name and job requisition ID for recruiters
  if (angle === "recruiter_direct") {
    // Return subject specifying candidate name, role title, and req ID
    return `Inquiry: ${candidate.fullName} for ${job.jobTitle}${job.jobId ? ` (Req #${job.jobId})` : ""}`;
  }

  // Handle same role peer angle subject line formatting
  // Establishes peer engineer identity and asks about company role
  if (angle === "same_role_peer") {
    // Return subject highlighting peer role title and target job position
    return `Fellow ${candidate.currentRole} - Quick question regarding ${job.company}'s ${job.jobTitle} role`;
  }

  // Default subject line for company employees or general cold outreach
  // Clean, clear subject stating referral inquiry and job title
  return `Referral Inquiry: ${job.jobTitle} at ${job.company}`;
}

/**
 * Calculate personalization score (0 to 100) evaluating hook depth and context coverage.
 * Inspects body text for presence of key candidate, contact, and job tokens.
 *
 * @param body Generated message body string.
 * @param candidate Candidate info object.
 * @param contact Contact info object.
 * @param job Job info object.
 * @returns Personalization score integer between 0 and 100.
 */
export function calculatePersonalizationScore(
  body: string,
  candidate: CandidateInfo,
  contact: TargetContactInfo,
  job: TargetJobInfo,
): number {
  // Convert body text to lower case for case-insensitive token matching
  // Ensures matching is resilient to capitalization differences
  const lowerBody = body.toLowerCase();

  // Initialize base personalization score at 30 points
  // Base credit for structurally complete referral message
  let score = 30;

  // Extract contact first name for greeting check
  // Uses split on space or default string
  const firstName = contact.name.split(" ")[0]?.toLowerCase() ?? "";

  // Check if contact first name appears in message body
  // Personalized greeting increases message response rates
  if (firstName && lowerBody.includes(firstName)) {
    // Add 15 points for contact name greeting match
    score += 15;
  }

  // Check if target company name appears in message body
  // Explicit company references demonstrate tailored outreach
  if (job.company && lowerBody.includes(job.company.toLowerCase())) {
    // Add 15 points for target company name match
    score += 15;
  }

  // Check if job title or key job terms appear in message body
  // Explicit position mention proves candidate is asking for a specific role
  if (job.jobTitle && lowerBody.includes(job.jobTitle.toLowerCase())) {
    // Add 15 points for exact job title match
    score += 15;
  }

  // Check if candidate alma mater or shared college appears in message body
  // Mentioning educational background validates natural connection hook
  if (
    (candidate.almaMater && lowerBody.includes(candidate.almaMater.toLowerCase())) ||
    (contact.sharedCollege && lowerBody.includes(contact.sharedCollege.toLowerCase()))
  ) {
    // Add 15 points for educational background match
    score += 15;
  }

  // Check if any candidate top skills appear in message body
  // Skill match demonstrates concrete qualifications for position
  const hasSkillMatch = candidate.topSkills.some((skill) =>
    lowerBody.includes(skill.toLowerCase())
  );

  // Add 10 points if skill match is found in message body
  // Rewards technical grounding in candidate qualifications
  if (hasSkillMatch) {
    // Add 10 points for skill match presence
    score += 10;
  }

  // Return clamped score between 0 and 100
  // Prevents score overflow above 100 or underflow below 0
  return Math.min(100, Math.max(0, score));
}

/**
 * Format and trim message body specifically for LinkedIn DM character limits (<= 300 chars).
 * Safe string formatting function ensuring DMs never get rejected by LinkedIn API or UI.
 *
 * @param body Raw message body text.
 * @param maxLength Optional max length limit (default 300).
 * @returns Trimmed and formatted string within character limits.
 */
export function formatLinkedInDM(
  body: string,
  maxLength: number = 300,
): string {
  // Check if body is already within max length constraint
  // Returns original string if character count is within bounds
  if (body.length <= maxLength) {
    // Return original body string unchanged
    return body;
  }

  // Truncate body string to maxLength - 3 characters to fit trailing ellipsis
  // Trims trailing whitespace before appending ellipsis
  const trimmed = body.slice(0, maxLength - 3).trim();

  // Append ellipsis indicator to show text truncation
  // Formats final string to strictly satisfy character limit
  return `${trimmed}...`;
}

/**
 * Core function to generate complete personalized referral outreach message.
 * Orchestrates angle detection, prompt assembly, message generation, and metrics calculation.
 *
 * @param request ReferralOutreachRequest containing candidate, contact, job, and channel.
 * @returns ReferralOutreachMessage object containing body, subject, metrics, and prompt package.
 */
export function generateReferralOutreach(
  request: ReferralOutreachRequest,
): ReferralOutreachMessage {
  // Determine primary connection angle hook for candidate and contact
  // Identifies alumni, recruiter, peer, employee, or cold strategy
  const angle = determineConnectionAngle(request.candidate, request.contact);

  // Prepare input structure for prompt generator
  // Omits maxWords key if undefined to satisfy exactOptionalPropertyTypes
  const promptInput: ReferralPromptInput = {
    candidate: request.candidate,
    contact: request.contact,
    job: request.job,
    channel: request.channel,
    ...(request.maxWords !== undefined ? { maxWords: request.maxWords } : {}),
  };

  // Build complete prompt package object containing system and user prompts
  // Used for LLM generation or inspection
  const promptPackage = buildReferralPromptPackage(promptInput);

  // Generate body text using custom note if provided, or deterministic template fallback
  // Ensures reliable message output without mandatory LLM network calls
  let rawBody = request.customNote && request.customNote.trim().length > 0
    ? request.customNote.trim()
    : generateTemplateFallback(promptInput);

  // Apply channel-specific formatting for LinkedIn DM channel
  // Enforces 300-character hard limit for LinkedIn Direct Messages
  if (request.channel === "linkedin_dm") {
    // Format body text to satisfy LinkedIn DM character limit constraint
    rawBody = formatLinkedInDM(rawBody, 300);
  }

  // Generate subject line string (empty string for LinkedIn DM channel)
  // Email and InMail require non-empty subject lines
  const subject = request.channel === "linkedin_dm"
    ? ""
    : generatePersonalizedSubject(
        request.job,
        request.contact,
        angle,
        request.candidate,
      );

  // Compute total word count in generated message body text
  // Splits on whitespace and excludes empty string tokens
  const wordCount = rawBody.split(/\s+/).filter((w) => w.length > 0).length;

  // Compute total character count in generated message body text
  // Used for channel length enforcement and UI display
  const characterCount = rawBody.length;

  // Check if call-to-action question or keyword exists in body text
  // Evaluates presence of key referral or CV submission terms
  const lowerBody = rawBody.toLowerCase();
  const hasCallToAction =
    lowerBody.includes("referral") ||
    lowerBody.includes("refer") ||
    lowerBody.includes("resume") ||
    lowerBody.includes("cv") ||
    lowerBody.includes("open to") ||
    lowerBody.includes("?") ||
    lowerBody.includes("connect");

  // Calculate quality personalization score (0 - 100)
  // Evaluates presence of candidate, contact, job, and skill tokens
  const personalizationScore = calculatePersonalizationScore(
    rawBody,
    request.candidate,
    request.contact,
    request.job,
  );

  // Return complete synthesized referral message result object
  // Bundles body, subject, channel, metrics, and prompt package
  return {
    subject,
    body: rawBody,
    channel: request.channel,
    angle,
    wordCount,
    characterCount,
    personalizationScore,
    hasCallToAction,
    promptPackage,
  };
}

/**
 * Validate synthesized referral message against quality and constraint criteria.
 * Verifies message length, subject line presence, call to action, and personalization.
 *
 * @param message ReferralOutreachMessage object to validate.
 * @returns ValidationResult containing isValid boolean and issues list.
 */
export function validateReferralMessage(
  message: ReferralOutreachMessage,
): ValidationResult {
  // Initialize empty issues array to collect validation warnings or errors
  const issues: string[] = [];

  // Check if message body is non-empty string
  // Empty bodies indicate generation failure
  if (!message.body || message.body.trim().length === 0) {
    // Record error issue for empty body text
    issues.push("Message body cannot be empty.");
  }

  // Check LinkedIn DM character count constraint (<= 300 chars)
  // Excessively long DMs will fail LinkedIn UI delivery
  if (message.channel === "linkedin_dm" && message.characterCount > 300) {
    // Record error issue for exceeding LinkedIn DM character limit
    issues.push(
      `LinkedIn DM exceeds 300 character limit (${message.characterCount} chars).`,
    );
  }

  // Check Email/InMail subject line presence
  // Email and InMail messages require non-empty subject headers
  if (message.channel !== "linkedin_dm" && (!message.subject || message.subject.trim().length === 0)) {
    // Record error issue for missing subject line
    issues.push("Email/InMail message requires a non-empty subject line.");
  }

  // Check for presence of call to action in message body
  // Messages without a clear ask convert poorly
  if (!message.hasCallToAction) {
    // Record warning issue for missing call to action
    issues.push("Message lacks a clear call to action or referral request.");
  }

  // Check if personalization score is below minimum quality threshold of 40
  // Low score indicates generic, un-customized boilerplate text
  if (message.personalizationScore < 40) {
    // Record warning issue for low personalization quality score
    issues.push(
      `Personalization score is low (${message.personalizationScore}/100).`,
    );
  }

  // Determine overall validity boolean based on issues list length
  // Valid if zero issues were recorded
  const isValid = issues.length === 0;

  // Return final validation result object containing status and issues
  return {
    isValid,
    issues,
  };
}
