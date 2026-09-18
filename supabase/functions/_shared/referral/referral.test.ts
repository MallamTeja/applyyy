// ============================================================================
// REFERRAL OUTREACH UNIT TESTS & VALIDATOR SUITE
// ============================================================================
//
// Identity & Bounded Domain: Referral Outreach Core Engineer
// Test Suite File: supabase/functions/_shared/referral/referral.test.ts
//
// Executes under Node.js native test runner via:
//   node --test "supabase/functions/_shared/referral/referral.test.ts"
//
// Architecture & Test Cases Verified:
//   1. System and user prompt synthesis for referral outreach LLM tasks.
//   2. Connection angle classification (alumni, recruiter, peer, employee, cold).
//   3. Subject line generation tailored to channel and connection angle.
//   4. Deterministic template fallback generation under various configurations.
//   5. Personalization score evaluation and metric calculation.
//   6. Character formatting and truncation rules for LinkedIn DM limits.
//   7. End-to-end referral outreach message generation and validation rules.
//
// Grounding & Quality Constraints:
//   - Zero tolerance for ungrounded or fabricated candidate claims.
//   - Strict compliance with LinkedIn DM character limit (<= 300 chars).
//   - Source comment ratio strictly >= 1.00.
// ============================================================================

// Import native Node test runner test function module
// Enables structured, asynchronous unit test execution
import { test } from "node:test";

// Import native Node strict assertion library module
// Provides strict equality and boolean verification assertions
import assert from "node:assert/strict";

// Import prompt generator functions and input types under test
// Tests buildReferralPromptPackage, generateSystemPrompt, generateTemplateFallback, generateUserPrompt
import {
  buildReferralPromptPackage,
  generateSystemPrompt,
  generateTemplateFallback,
  generateUserPrompt,
  type ReferralPromptInput,
} from "./prompt.ts";

// Import referral core functions and domain types under test
// Tests calculatePersonalizationScore, determineConnectionAngle, formatLinkedInDM, etc.
import {
  calculatePersonalizationScore,
  determineConnectionAngle,
  formatLinkedInDM,
  generatePersonalizedSubject,
  generateReferralOutreach,
  validateReferralMessage,
  type CandidateInfo,
  type ReferralOutreachRequest,
  type TargetContactInfo,
  type TargetJobInfo,
} from "./referral.ts";

// Sample candidate test fixture matching MLRIT student profile
// Represents a real-world candidate seeking backend engineering referrals
const TEST_CANDIDATE: CandidateInfo = {
  // Full candidate legal/professional name string
  fullName: "Teja Mallam",
  // Current job role headline string
  currentRole: "Backend Engineer",
  // Alma mater university string matching target alumni contacts
  almaMater: "MLR Institute of Technology",
  // Top technical skills array for qualification matching
  topSkills: ["Node.js", "TypeScript", "PostgreSQL"],
  // Experience summary description string detailing achievements
  experienceSummary: "Built REST APIs and scalable microservices handling thousands of requests.",
  // Optional portfolio website URL string for identity verification
  portfolioUrl: "https://github.com/MallamTeja",
};

// Sample target alumni contact fixture
// Represents an alumnus working at target hiring company Google
const TEST_ALUMNI_CONTACT: TargetContactInfo = {
  // Target contact full name string
  name: "Anil Kumar",
  // Target contact role title string at target company
  title: "Senior Software Engineer",
  // Target hiring company name string
  company: "Google",
  // Connection type string indicating alumni relationship
  connectionType: "alumni",
  // Shared college name string matching candidate alma mater
  sharedCollege: "MLR Institute of Technology",
  // Target LinkedIn profile URL string
  linkedInUrl: "https://linkedin.com/in/anilkumar",
};

// Sample target recruiter contact fixture
// Represents a recruiter or talent acquisition specialist at Google
const TEST_RECRUITER_CONTACT: TargetContactInfo = {
  // Target contact full name string
  name: "Sarah Jenkins",
  // Target contact role title string indicating technical recruiter
  title: "Tech Recruiter",
  // Target hiring company name string
  company: "Google",
  // Connection type string indicating recruiter direct contact
  connectionType: "recruiter",
};

// Sample target peer contact fixture
// Represents a fellow engineer at target hiring company Google
const TEST_PEER_CONTACT: TargetContactInfo = {
  // Target contact full name string
  name: "Rahul Verma",
  // Target contact role title string indicating backend peer
  title: "Backend Engineer",
  // Target hiring company name string
  company: "Google",
  // Connection type string indicating peer developer contact
  connectionType: "peer",
};

// Sample target job position fixture
// Represents an open requisition at Google for Software Engineer II
const TEST_JOB: TargetJobInfo = {
  // Target job role title string
  jobTitle: "Software Engineer II",
  // Target hiring company name string
  company: "Google",
  // Target job requisition ID string for explicit reference
  jobId: "G-10293",
  // Target job portal URL string
  jobUrl: "https://careers.google.com/jobs/G-10293",
  // Key job requirement keywords list for skill matching
  keyRequirements: ["Node.js", "Distributed Systems", "PostgreSQL"],
};

// ============================================================================
// Test Case 1: System Prompt Generation Verification
// ============================================================================
// Description: Verify system prompt contains expected AI persona and operational rules.
// Test steps:
//   - Step 1: Call generateSystemPrompt().
//   - Step 2: Verify non-empty output string.
//   - Step 3: Verify inclusion of role header and anti-fabrication guidelines.
// ============================================================================
test("generateSystemPrompt returns expected AI persona and guidelines", () => {
  // Invoke system prompt generator function under test
  // Generates persona and rule instructions for AI referral outreach model
  const systemPrompt = generateSystemPrompt();

  // Assert system prompt is a non-empty string with length > 0
  // Ensures generator function returns actual content
  assert.ok(systemPrompt.length > 0);

  // Assert system prompt includes expert outreach strategist role header
  // Confirms identity persona is properly established
  assert.ok(systemPrompt.includes("referral outreach strategist"));

  // Assert system prompt includes strict anti-fabrication negative constraint
  // Confirms safety rules against hallucination are present
  assert.ok(systemPrompt.includes("Do NOT fabricate"));
});

// ============================================================================
// Test Case 2: User Prompt Generation Verification
// ============================================================================
// Description: Verify user prompt correctly structures candidate, contact, and job context.
// Test steps:
//   - Step 1: Construct ReferralPromptInput fixture with candidate, contact, job.
//   - Step 2: Call generateUserPrompt(input).
//   - Step 3: Verify candidate name, contact name, job title, and channel are present.
// ============================================================================
test("generateUserPrompt builds context-rich prompt string", () => {
  // Construct prompt input fixture object specifying email channel
  // Bundles candidate, contact, and job objects
  const input: ReferralPromptInput = {
    candidate: TEST_CANDIDATE,
    contact: TEST_ALUMNI_CONTACT,
    job: TEST_JOB,
    channel: "email",
  };

  // Invoke user prompt generator function under test
  // Formats candidate credentials and recipient context into markdown prompt
  const userPrompt = generateUserPrompt(input);

  // Assert user prompt contains candidate name Teja Mallam
  // Confirms candidate profile context is injected
  assert.ok(userPrompt.includes("Teja Mallam"));

  // Assert user prompt contains target contact name Anil Kumar
  // Confirms recipient contact context is injected
  assert.ok(userPrompt.includes("Anil Kumar"));

  // Assert user prompt contains job title Software Engineer II
  // Confirms target job position context is injected
  assert.ok(userPrompt.includes("Software Engineer II"));

  // Assert user prompt specifies email channel constraint
  // Confirms channel directive is injected into prompt instructions
  assert.ok(userPrompt.includes("Channel: EMAIL"));
});

// ============================================================================
// Test Case 3: Prompt Package Construction Verification
// ============================================================================
// Description: Verify buildReferralPromptPackage combines system and user prompts into result package.
// Test steps:
//   - Step 1: Construct ReferralPromptInput fixture with custom maxWords.
//   - Step 2: Call buildReferralPromptPackage(input).
//   - Step 3: Verify package properties match channel, maxWords, system, user prompts.
// ============================================================================
test("buildReferralPromptPackage returns complete package object", () => {
  // Construct prompt input fixture object specifying linkedin_dm channel and 80 maxWords
  // Tests maxWords override functionality
  const input: ReferralPromptInput = {
    candidate: TEST_CANDIDATE,
    contact: TEST_ALUMNI_CONTACT,
    job: TEST_JOB,
    channel: "linkedin_dm",
    maxWords: 80,
  };

  // Invoke prompt package builder function under test
  // Assembles complete package with system and user prompts
  const pkg = buildReferralPromptPackage(input);

  // Assert package channel equals linkedin_dm
  // Verifies channel property pass-through
  assert.equal(pkg.channel, "linkedin_dm");

  // Assert package maxWords equals 80
  // Verifies explicit maxWords override honor
  assert.equal(pkg.maxWords, 80);

  // Assert system prompt is present with positive character length
  // Confirms system prompt is generated
  assert.ok(pkg.systemPrompt.length > 0);

  // Assert user prompt is present with positive character length
  // Confirms user prompt is generated
  assert.ok(pkg.userPrompt.length > 0);
});

// ============================================================================
// Test Case 4: Template Fallback Generator Verification (Alumni Email)
// ============================================================================
// Description: Verify template fallback generates personalized message for alumni email outreach.
// Test steps:
//   - Step 1: Construct ReferralPromptInput fixture for alumni email.
//   - Step 2: Call generateTemplateFallback(input).
//   - Step 3: Verify personalized greeting, university name, job title, signoff.
// ============================================================================
test("generateTemplateFallback produces personalized email for alumni", () => {
  // Construct prompt input fixture object for email channel outreach
  // Combines candidate, alumni contact, and target job
  const input: ReferralPromptInput = {
    candidate: TEST_CANDIDATE,
    contact: TEST_ALUMNI_CONTACT,
    job: TEST_JOB,
    channel: "email",
  };

  // Invoke template fallback generator function under test
  // Synthesizes zero-network deterministic email text
  const message = generateTemplateFallback(input);

  // Assert greeting names contact Anil
  // Confirms contact name personalization
  assert.ok(message.includes("Hi Anil,"));

  // Assert message highlights shared university connection MLRIT
  // Confirms alumni connection hook injection
  assert.ok(message.includes("MLR Institute of Technology"));

  // Assert message mentions target job title Software Engineer II
  // Confirms target job position reference
  assert.ok(message.includes("Software Engineer II"));

  // Assert message includes candidate signoff name Teja Mallam
  // Confirms candidate identity signoff
  assert.ok(message.includes("Teja Mallam"));
});

// ============================================================================
// Test Case 5: Connection Angle Classification Verification
// ============================================================================
// Description: Verify determineConnectionAngle correctly classifies relationship hooks.
// Test steps:
//   - Step 1: Call determineConnectionAngle for alumni, recruiter, peer fixtures.
//   - Step 2: Assert returned angles match expected enum values.
// ============================================================================
test("determineConnectionAngle classifies alumni, recruiter, and peer correctly", () => {
  // Test alumni classification hook strategy
  // Evaluates candidate alma mater against contact shared college
  const alumniAngle = determineConnectionAngle(TEST_CANDIDATE, TEST_ALUMNI_CONTACT);
  // Assert returned angle strictly equals alumni_connection
  assert.equal(alumniAngle, "alumni_connection");

  // Test recruiter classification hook strategy
  // Evaluates contact role title containing recruiter keywords
  const recruiterAngle = determineConnectionAngle(TEST_CANDIDATE, TEST_RECRUITER_CONTACT);
  // Assert returned angle strictly equals recruiter_direct
  assert.equal(recruiterAngle, "recruiter_direct");

  // Test peer classification hook strategy
  // Evaluates shared engineering role titles
  const peerAngle = determineConnectionAngle(TEST_CANDIDATE, TEST_PEER_CONTACT);
  // Assert returned angle strictly equals same_role_peer
  assert.equal(peerAngle, "same_role_peer");
});

// ============================================================================
// Test Case 6: Personalized Subject Line Generation Verification
// ============================================================================
// Description: Verify subject lines are customized based on connection angle.
// Test steps:
//   - Step 1: Call generatePersonalizedSubject for alumni and recruiter angles.
//   - Step 2: Verify alumni subject includes university name.
//   - Step 3: Verify recruiter subject includes candidate name and job req ID.
// ============================================================================
test("generatePersonalizedSubject constructs targeted subject lines", () => {
  // Generate subject line for alumni connection angle strategy
  // Integrates shared university name and job position
  const alumniSubject = generatePersonalizedSubject(
    TEST_JOB,
    TEST_ALUMNI_CONTACT,
    "alumni_connection",
    TEST_CANDIDATE,
  );
  // Assert alumni subject contains university name MLRIT
  assert.ok(alumniSubject.includes("MLR Institute of Technology Alumni"));

  // Generate subject line for recruiter direct angle strategy
  // Integrates candidate name, job title, and requisition ID
  const recruiterSubject = generatePersonalizedSubject(
    TEST_JOB,
    TEST_RECRUITER_CONTACT,
    "recruiter_direct",
    TEST_CANDIDATE,
  );
  // Assert recruiter subject contains candidate name Teja Mallam
  assert.ok(recruiterSubject.includes("Teja Mallam"));
  // Assert recruiter subject contains job req ID G-10293
  assert.ok(recruiterSubject.includes("Req #G-10293"));
});

// ============================================================================
// Test Case 7: Personalization Score Calculation Verification
// ============================================================================
// Description: Verify calculatePersonalizationScore accurately rewards contextual tokens.
// Test steps:
//   - Step 1: Construct sample highly personalized body text.
//   - Step 2: Call calculatePersonalizationScore(text, candidate, contact, job).
//   - Step 3: Assert score is >= 80 out of 100.
// ============================================================================
test("calculatePersonalizationScore scores highly personalized text", () => {
  // Build sample highly personalized text containing name, company, job title, and alma mater
  // Contains contact name Anil, college MLRIT, role Software Engineer II, company Google, skill Node.js
  const personalizedText =
    "Hi Anil, I noticed we both attended MLR Institute of Technology. I am applying for the Software Engineer II role at Google with my experience in Node.js.";

  // Calculate personalization score for sample text via calculatePersonalizationScore
  // Evaluates presence of key context tokens
  const score = calculatePersonalizationScore(
    personalizedText,
    TEST_CANDIDATE,
    TEST_ALUMNI_CONTACT,
    TEST_JOB,
  );

  // Assert personalization score is >= 80 out of 100
  // Confirms high personalization depth is rewarded
  assert.ok(score >= 80, `Expected score >= 80, got ${score}`);
});

// ============================================================================
// Test Case 8: LinkedIn DM Formatting & Truncation Verification
// ============================================================================
// Description: Verify formatLinkedInDM caps output text within 300 character limit.
// Test steps:
//   - Step 1: Create long text string (400 chars).
//   - Step 2: Call formatLinkedInDM(longText, 300).
//   - Step 3: Assert formatted length <= 300 and ends with ellipsis.
// ============================================================================
test("formatLinkedInDM enforces maximum character limit", () => {
  // Create long sample text exceeding 300 character LinkedIn DM limit
  // 400 repeating 'A' characters
  const longText = "A".repeat(400);

  // Invoke formatting function formatLinkedInDM with 300 char limit
  // Truncates text and appends ellipsis
  const formatted = formatLinkedInDM(longText, 300);

  // Assert formatted text length is <= 300 characters
  // Confirms hard character limit compliance
  assert.ok(formatted.length <= 300);

  // Assert formatted text ends with ellipsis indicator
  // Confirms truncation indicator is appended
  assert.ok(formatted.endsWith("..."));
});

// ============================================================================
// Test Case 9: End-to-End Referral Outreach Generation Verification
// ============================================================================
// Description: Verify generateReferralOutreach generates complete message package for LinkedIn DM.
// Test steps:
//   - Step 1: Construct ReferralOutreachRequest fixture for LinkedIn DM.
//   - Step 2: Call generateReferralOutreach(request).
//   - Step 3: Assert channel, subject, length, CTA, angle, and score metrics.
// ============================================================================
test("generateReferralOutreach builds complete LinkedIn DM referral message", () => {
  // Construct outreach request fixture object for linkedin_dm channel
  // Combines candidate, alumni contact, and target job
  const request: ReferralOutreachRequest = {
    candidate: TEST_CANDIDATE,
    contact: TEST_ALUMNI_CONTACT,
    job: TEST_JOB,
    channel: "linkedin_dm",
  };

  // Invoke core outreach generator function generateReferralOutreach
  // Assembles message, detects angle, computes metrics
  const result = generateReferralOutreach(request);

  // Assert channel strictly equals linkedin_dm
  // Verifies channel property in result object
  assert.equal(result.channel, "linkedin_dm");

  // Assert subject line is empty string for LinkedIn DM
  // Direct messages do not carry subject headers
  assert.equal(result.subject, "");

  // Assert body character count is <= 300 characters
  // Verifies strict LinkedIn DM character length limit compliance
  assert.ok(result.characterCount <= 300);

  // Assert call to action flag is strictly equal to true
  // Confirms message includes explicit referral inquiry question
  assert.equal(result.hasCallToAction, true);

  // Assert connection angle strictly equals alumni_connection
  // Confirms relationship angle detection
  assert.equal(result.angle, "alumni_connection");

  // Assert personalization score is >= 60
  // Confirms high contextual personalization quality
  assert.ok(result.personalizationScore >= 60);
});

// ============================================================================
// Test Case 10: Referral Message Validation Verification
// ============================================================================
// Description: Verify validateReferralMessage accepts valid message and flags errors on invalid message.
// Test steps:
//   - Step 1: Generate valid referral message for email.
//   - Step 2: Validate message and assert isValid is true with 0 issues.
//   - Step 3: Mutate message with empty body and validate.
//   - Step 4: Assert isValid is false with recorded issues.
// ============================================================================
test("validateReferralMessage evaluates message quality and constraints", () => {
  // Construct valid outreach request fixture object for email channel
  // Combines candidate, alumni contact, and target job
  const request: ReferralOutreachRequest = {
    candidate: TEST_CANDIDATE,
    contact: TEST_ALUMNI_CONTACT,
    job: TEST_JOB,
    channel: "email",
  };

  // Generate valid message via generateReferralOutreach
  // Assembles complete email outreach message
  const validMessage = generateReferralOutreach(request);

  // Validate valid message via validateReferralMessage
  // Checks length, subject line, CTA, and score rules
  const validResult = validateReferralMessage(validMessage);

  // Assert validResult isValid boolean is strictly true
  // Confirms clean valid message passes validation
  assert.equal(validResult.isValid, true);
  // Assert issues array length is 0
  assert.equal(validResult.issues.length, 0);

  // Test validation failure on empty body mutation
  // Mutates body to empty string to trigger validation error
  const invalidResult = validateReferralMessage({
    ...validMessage,
    body: "",
    characterCount: 0,
    wordCount: 0,
  });

  // Assert invalidResult isValid boolean is strictly false
  // Confirms invalid message is rejected by validator
  assert.equal(invalidResult.isValid, false);
  // Assert issues array length is > 0
  assert.ok(invalidResult.issues.length > 0);
});
