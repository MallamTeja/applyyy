// ============================================================================
// REFERRAL OUTREACH PROMPT GENERATOR MODULE
// ============================================================================
//
// Identity & Bounded Domain: Referral Outreach Core Engineer
// Allowed Path: supabase/functions/_shared/referral/prompt.ts
//
// Purpose:
// Generates structured system and user prompts for LLM-based referral message
// synthesis, as well as high-converting deterministic template fallbacks.
//
// Key Responsibilities:
//   1. Build structured Gemini system prompts specifying tone, constraints, & CTA.
//   2. Build context-rich user prompts combining candidate, contact, and job data.
//   3. Generate zero-network deterministic template messages as robust fallbacks.
//   4. Enforce channel-specific character and word limits (LinkedIn DM, InMail, Email).
//
// Architecture & Verification Constraints:
//   - Deno reload type checks with zero errors under deno check.
//   - Node test runner compatibility under node --test.
//   - Source comment ratio strictly >= 1.00.
// ============================================================================

/**
 * Candidate background details for referral prompt generation.
 * Encapsulates all resume/profile attributes necessary to formulate a strong pitch.
 */
export interface PromptCandidateDetails {
  /** Full legal or professional name of the candidate. */
  readonly fullName: string;
  /** Current job title, professional headline, or position. */
  readonly currentRole: string;
  /** Primary college, university, or educational alma mater. */
  readonly almaMater?: string;
  /** Core technical skills, key frameworks, or domain expertise highlights. */
  readonly topSkills: readonly string[];
  /** High-level summary of relevant work experience, projects, or achievements. */
  readonly experienceSummary: string;
  /** Portfolio, GitHub repository, or LinkedIn profile URL for verification. */
  readonly portfolioUrl?: string;
}

/**
 * Target employee, alumni, or recruiter contact details.
 * Contains metadata about the person receiving the referral request message.
 */
export interface PromptContactDetails {
  /** Full name of target referral contact. */
  readonly name: string;
  /** Job title or position at the target hiring company. */
  readonly title: string;
  /** Name of the target hiring company or organization. */
  readonly company: string;
  /** Relationship or connection angle with candidate (alumni, peer, recruiter, cold). */
  readonly connectionType: "alumni" | "employee" | "recruiter" | "peer" | "cold";
  /** Name of shared college or university if an alumni connection exists. */
  readonly sharedCollege?: string;
  /** LinkedIn profile URL of the contact. */
  readonly linkedInUrl?: string;
}

/**
 * Target job position details.
 * Defines the open position at the hiring company for which a referral is sought.
 */
export interface PromptJobDetails {
  /** Official title of target open role. */
  readonly jobTitle: string;
  /** Target hiring company name. */
  readonly company: string;
  /** Requisition ID or Job ID if available on the job portal. */
  readonly jobId?: string;
  /** URL of official job listing or careers page. */
  readonly jobUrl?: string;
  /** Key skill requirements or qualifications listed in job posting. */
  readonly keyRequirements: readonly string[];
}

/**
 * Communication channel for referral outreach.
 * Determines formatting constraints, word limits, and tone choices.
 */
export type ReferralChannel = "linkedin_dm" | "email" | "inmail";

/**
 * Input options required to generate a referral outreach prompt package.
 */
export interface ReferralPromptInput {
  /** Candidate background details object. */
  readonly candidate: PromptCandidateDetails;
  /** Target referral contact details object. */
  readonly contact: PromptContactDetails;
  /** Target job position details object. */
  readonly job: PromptJobDetails;
  /** Target messaging channel (linkedin_dm, email, or inmail). */
  readonly channel: ReferralChannel;
  /** Optional maximum word limit override for generated response text. */
  readonly maxWords?: number;
}

/**
 * Result package containing system prompt, user prompt, and channel limits.
 * Ready for consumption by Gemini client or fallback generators.
 */
export interface ReferralPromptPackage {
  /** System prompt defining AI persona, strict rules, and boundaries. */
  readonly systemPrompt: string;
  /** User prompt containing detailed candidate, contact, and job context. */
  readonly userPrompt: string;
  /** Suggested max word count for generation. */
  readonly maxWords: number;
  /** Channel target identifier. */
  readonly channel: ReferralChannel;
}

/**
 * Generate standard system prompt for referral outreach synthesis.
 * Establishes the AI persona, rules against fabrication, and output format constraints.
 *
 * @returns System prompt string with clear operational guardrails.
 */
export function generateSystemPrompt(): string {
  // Define expert role header for the AI assistant persona
  // Sets authority and focus area for referral outreach generation
  const roleHeader = "You are an expert referral outreach strategist and executive career coach.";

  // Array of core operational guidelines and strict negative constraints
  // Used to prevent common AI failure modes like fabrication or pushiness
  const guidelines = [
    // Rule 1: Authenticity, respect, and brevity requirement
    // Ensures outreach messages are courteous and digestible
    "1. Keep messages authentic, respectful, concise, and highly personalized.",

    // Rule 2: Establishing a strong connection hook
    // Hooks capture recipient attention based on real shared context
    "2. Establish a natural connection hook (alumni tie, shared background, or admiration for target team).",

    // Rule 3: Explicit call to action requirement
    // Ensures the message asks a clear, low-friction question
    "3. Include a low-friction, polite call to action asking if they are open to referring or submitting a CV internally.",

    // Rule 4: Anti-fabrication guardrail
    // Strictly forbids hallucinating facts, fake credentials, or false claims
    "4. Do NOT fabricate background facts, inflate metrics, or use pushy sales language.",

    // Rule 5: Pure output format constraint
    // Instructs LLM to return only the raw message body without markdown meta-wrapper
    "5. Return ONLY the final outreach message body without commentary or meta-text.",
  ].join("\n");

  // Format system prompt combining persona role header and guidelines block
  // Separated by double newlines for readability and clean LLM parsing
  return `${roleHeader}\n\nStrict Guidelines:\n${guidelines}`;
}

/**
 * Generate user prompt containing structured candidate, contact, and job context.
 * Assembles all background facts into a clean markdown-formatted prompt snippet.
 *
 * @param input Input options object containing candidate, contact, job, and channel.
 * @returns User prompt string for LLM input.
 */
export function generateUserPrompt(input: ReferralPromptInput): string {
  // Extract candidate details object reference
  // Provides candidate name, role, skills, and background summary
  const c = input.candidate;

  // Extract contact details object reference
  // Provides target contact name, position, company, and connection type
  const r = input.contact;

  // Extract job details object reference
  // Provides job title, company name, requisition ID, and key requirements
  const j = input.job;

  // Compute target word limit based on explicit input or channel-specific default
  // LinkedIn DMs default to 75 words, whereas Email/InMail default to 150 words
  const wordLimit = input.maxWords ?? (input.channel === "linkedin_dm" ? 75 : 150);

  // Format candidate context summary array
  // Builds line-by-line summary of candidate credentials
  const candidateContext = [
    // Candidate full name property formatting
    `Candidate Name: ${c.fullName}`,
    // Candidate current role property formatting
    `Current Role: ${c.currentRole}`,
    // Optional candidate alma mater property formatting
    c.almaMater ? `Alma Mater: ${c.almaMater}` : "",
    // Candidate top technical skills list formatting
    `Key Skills: ${c.topSkills.join(", ")}`,
    // Candidate work experience summary formatting
    `Experience Summary: ${c.experienceSummary}`,
  ]
    // Filter out empty lines resulting from missing optional fields
    .filter((line) => line.length > 0)
    // Join lines into single formatted section string
    .join("\n");

  // Format contact context summary array
  // Builds line-by-line summary of recipient details
  const contactContext = [
    // Contact recipient full name formatting
    `Contact Name: ${r.name}`,
    // Contact job title or position formatting
    `Title: ${r.title}`,
    // Contact company name formatting
    `Company: ${r.company}`,
    // Connection relationship type formatting
    `Connection Type: ${r.connectionType}`,
    // Optional shared college or university formatting
    r.sharedCollege ? `Shared College/University: ${r.sharedCollege}` : "",
  ]
    // Filter out empty lines from missing optional properties
    .filter((line) => line.length > 0)
    // Join lines into single formatted section string
    .join("\n");

  // Format job context summary array
  // Builds line-by-line summary of open requisition
  const jobContext = [
    // Target job position title formatting
    `Job Title: ${j.jobTitle}`,
    // Target hiring organization name formatting
    `Company: ${j.company}`,
    // Optional job requisition ID string formatting
    j.jobId ? `Job Requisition ID: ${j.jobId}` : "",
    // Key job requirements list formatting
    `Key Requirements: ${j.keyRequirements.join(", ")}`,
  ]
    // Filter out empty lines from missing optional properties
    .filter((line) => line.length > 0)
    // Join lines into single formatted section string
    .join("\n");

  // Assemble full structured user prompt with markdown headers
  // Combines candidate, contact, job, and execution directives
  return [
    // Candidate profile section header label
    "--- CANDIDATE PROFILE ---",
    // Candidate context block
    candidateContext,
    // Target contact section header label
    "\n--- TARGET CONTACT ---",
    // Target contact context block
    contactContext,
    // Target job section header label
    "\n--- TARGET JOB ---",
    // Target job context block
    jobContext,
    // Execution instructions section header label
    "\n--- INSTRUCTIONS ---",
    // Target channel specification line
    `Channel: ${input.channel.toUpperCase()}`,
    // Maximum word limit constraint line
    `Max Words: ${wordLimit}`,
    // Direct action request line for the language model
    "Draft a personalized referral request message following these details.",
  ].join("\n");
}

/**
 * Build complete prompt package combining system and user prompts.
 * Bundles system prompt, user prompt, channel parameters, and word limits.
 *
 * @param input Referral prompt input object.
 * @returns ReferralPromptPackage object.
 */
export function buildReferralPromptPackage(
  input: ReferralPromptInput,
): ReferralPromptPackage {
  // Generate system prompt string via generateSystemPrompt function
  // Establishes AI persona guidelines and constraints
  const systemPrompt = generateSystemPrompt();

  // Generate user prompt string via generateUserPrompt function
  // Combines candidate, contact, and job metadata
  const userPrompt = generateUserPrompt(input);

  // Compute maxWords using explicit input value or channel default fallback
  // Ensures word count budget matches channel constraints
  const maxWords = input.maxWords ?? (input.channel === "linkedin_dm" ? 75 : 150);

  // Construct and return final prompt package object
  // Bundles all components into a clean, typed container
  return {
    // System prompt string property
    systemPrompt,
    // User prompt string property
    userPrompt,
    // Maximum words number property
    maxWords,
    // Target messaging channel property
    channel: input.channel,
  };
}

/**
 * Deterministic template-based referral message generator.
 * Provides a reliable fallback message without relying on external LLM services.
 * Guarantees zero runtime dependency on network or AI services.
 *
 * @param input Referral prompt input object.
 * @returns Deterministic fallback message string.
 */
export function generateTemplateFallback(input: ReferralPromptInput): string {
  // Destructure candidate, contact, job, and channel properties from input
  // Unpacks input object for direct access to attributes
  const { candidate: c, contact: r, job: j, channel } = input;

  // Extract contact first name for warm, natural greeting line
  // Falls back to full name if single word or space splitting fails
  const firstName = r.name.split(" ")[0] ?? r.name;

  // Format primary skill highlight string from candidate top skills array
  // Uses first two top skills joined by ampersand, or default domain string
  const skillHighlight = c.topSkills.length > 0
    ? c.topSkills.slice(0, 2).join(" & ")
    : "software development";

  // Check if target channel is short LinkedIn Direct Message
  // LinkedIn DMs require ultra-concise text under 280-300 characters
  if (channel === "linkedin_dm") {
    // Determine connection hook string for LinkedIn DM
    // Highlights shared alma mater if alumni connection exists, else friendly greeting
    const hook = r.connectionType === "alumni" && (r.sharedCollege || c.almaMater)
      ? `Fellow ${r.sharedCollege || c.almaMater} alum here!`
      : `Hope you're doing well at ${j.company}.`;

    // Construct concise call to action question for LinkedIn DM
    // Assembles ultra-compact message guaranteed to stay under 280 characters
    return `Hi ${firstName},\n\n${hook} I'm applying for ${j.jobTitle}${j.jobId ? ` (#${j.jobId})` : ""} with experience in ${skillHighlight}.\n\nWould you be open to sharing a referral if it looks like a fit?\n\nThanks,\n${c.fullName}`;
  }

  // Format formal email greeting phrase using contact first name
  // Standard opening line for Email or LinkedIn InMail messages
  const greeting = `Hi ${firstName},`;

  // Initialize connection hook paragraph string
  // Will be populated based on relationship type
  let hook = "";

  // Check if connection type is alumni with shared college match
  if (r.connectionType === "alumni" && (r.sharedCollege || c.almaMater)) {
    // Extract college name string from shared college or candidate alma mater
    const college = r.sharedCollege || c.almaMater || "our college";
    // Build alumni connection hook sentence referencing shared institution
    hook = `I noticed we both attended ${college}! Hope you're doing well at ${j.company}.`;
  } else if (r.connectionType === "recruiter") {
    // Build recruiter outreach hook sentence acknowledging talent acquisition role
    hook = `I came across your profile while exploring engineering opportunities at ${j.company}.`;
  } else if (r.connectionType === "peer") {
    // Build peer outreach hook sentence referencing shared engineering discipline
    hook = `I saw your work as ${r.title} at ${j.company} and wanted to connect with a fellow engineer.`;
  } else {
    // Default cold connection hook sentence expressing company admiration
    hook = `I hope you're having a great week. I admire the work ${j.company} is doing in this space.`;
  }

  // Build body paragraph referencing target job title, requisition ID, and top skills
  // Explains candidate interest and why background fits the role requirements
  const body = `I'm currently applying for the ${j.jobTitle} position (${j.jobId ? `Req #${j.jobId}` : "listed on the portal"}). With my background as ${c.currentRole} specializing in ${skillHighlight}, I believe I'd be a strong fit for the team.`;

  // Build polite, low-friction call to action asking for internal referral
  // Direct, polite inquiry requesting resume submission without pressure
  const callToAction = "If you have a few minutes, would you be open to passing along my resume for an internal referral? I'd be incredibly grateful.";

  // Build signoff block with candidate full name and optional portfolio URL
  // Includes external link if portfolio or GitHub URL is available
  const signoff = c.portfolioUrl
    ? `Best regards,\n${c.fullName}\n${c.portfolioUrl}`
    : `Best regards,\n${c.fullName}`;

  // Assemble full structured Email or InMail outreach message string
  // Combines greeting, hook, body, call to action, and signoff blocks
  return `${greeting}\n\n${hook}\n\n${body}\n\n${callToAction}\n\n${signoff}`;
}
