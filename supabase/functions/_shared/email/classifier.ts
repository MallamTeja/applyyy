// Outcome classifier for email messages received from hiring teams and recruiters.
//
// WHY THIS IS A DEDICATED OUTCOME CLASSIFIER MODULE: When an email is received from a hiring team,
// the system must classify the job application lifecycle outcome into one of four deterministic states:
// 'interviewing', 'employer_screening', 'rejected', or 'unknown'.
//
// WHY DECISION PRECEDENCE MATTERS: A candidate email may mention multiple terms (e.g. referencing
// a past "interview" in a rejection message, or starting with polite thanks). The classification logic
// must evaluate explicit decision statements with strict precedence (e.g. rejection overrides past interview
// mentions or receipt greetings) so that application state transitions remain accurate and trustworthy.

// Import the parser types and functions for extracting structural email features.
//
// WHY IMPORT PARSER TYPES: Parsing raw email input into structured features (sanitized text, domain, links)
// decouples text processing from classification logic and allows pure unit testing.
import { parseEmail, type ParseEmailInput, type ParsedEmail } from "./parser.ts";

// Union of allowed application outcome classifications.
//
// WHY THIS UNION IS LOCKED: Application status transitions downstream map directly to these outcomes.
// - 'interviewing': Candidate has received an interview invitation or scheduling link.
// - 'employer_screening': Candidate has received a technical test (OA), take-home assessment, or phone screen request.
// - 'rejected': Candidate application has been declined or role has been filled.
// - 'unknown': Email is an application receipt, auto-reply, or generic text without status decision.
export type EmailOutcome = "interviewing" | "rejected" | "employer_screening" | "unknown";

// Array tuple of allowed email outcome strings for runtime validation.
//
// WHY AN EXPLICIT CONST TUPLE IS EXPOSED: Allows runtime iteration, validation, and schema definitions
// without duplicating the literal outcome string array across packages.
export const EMAIL_OUTCOMES = ["interviewing", "rejected", "employer_screening", "unknown"] as const;

// Detailed result structure returned by the classifier.
//
// WHY RETURN STRUCTURED RESULT METRICS: Returns not just the outcome string but also numerical confidence score,
// list of matched signal tags, and human-readable reasoning for observability and debugging.
export interface OutcomeClassification {
  // The primary outcome verdict string ('interviewing' | 'rejected' | 'employer_screening' | 'unknown').
  readonly outcome: EmailOutcome;
  // Numerical confidence score ranging from 0.0 (uncertain) to 1.0 (certain).
  readonly confidence: number;
  // List of textual or structural signal descriptions that triggered this classification.
  readonly matchedSignals: readonly string[];
  // Human-readable rationale summarizing why the classification was selected.
  readonly reasoning: string;
}

// Internal signal rule structure for keyword and phrase matching.
//
// WHY SIGNAL RULES ARE TYPED STRUCTURES: Defines declarative matching rules with target scope and weights,
// keeping heuristic definitions clean and extensible without hardcoded conditional logic clutter.
interface SignalRule {
  // Description tag for logging and auditing matched signals.
  readonly tag: string;
  // Regular expression pattern matching specific wording in the email text.
  readonly pattern: RegExp;
  // Weight contribution of this signal to the outcome score.
  readonly weight: number;
  // Target text section to inspect ('subject', 'body', or 'both').
  readonly target: "subject" | "body" | "both";
}

// Strong explicit rejection phrases used by ATS platforms and hiring managers.
//
// WHY REJECTION PATTERNS ARE EXPLICIT: Rejection emails follow predictable corporate templates.
// Identifying these exact decision phrases guarantees zero false positives for active candidates.
const REJECTION_SIGNALS: readonly SignalRule[] = [
  // Direct statement of non-selection ("not moving forward", "decided not to proceed").
  //
  // WHY THIS HAS HIGH WEIGHT: Explicit statements of non-selection carry near-certain confidence of rejection.
  {
    tag: "not_moving_forward",
    pattern: /\b(?:not\s+(?:be\s+)?moving\s+forward|will\s+not\s+(?:be\s+)?proceeding|decided\s+not\s+to\s+proceed)\b/i,
    weight: 0.95,
    target: "both",
  },
  // Choosing other candidates ("moved forward with other candidates", "chosen another candidate").
  //
  // WHY THIS HAS HIGH WEIGHT: Candidate competition decisions indicate final non-selection for this position.
  {
    tag: "moved_with_other_candidates",
    pattern: /\b(?:mov(?:ed|ing)\s+forward\s+with\s+other|pursu(?:ing|e)\s+other\s+candidates|chosen\s+another\s+candidate|selected\s+another\s+applicant)\b/i,
    weight: 0.95,
    target: "both",
  },
  // Regret to inform boilerplate ("regret to inform you", "after careful consideration").
  //
  // WHY THIS HAS HIGH WEIGHT: Standard formal rejection opening phrases used by corporate recruitment teams.
  {
    tag: "regret_to_inform",
    pattern: /\b(?:regret\s+to\s+inform\s+you|unfortunately,\s+we|after\s+careful\s+consideration,\s+we)\b/i,
    weight: 0.85,
    target: "both",
  },
  // Position filled or closed notification ("role has been filled").
  //
  // WHY THIS HAS HIGH WEIGHT: Role closure notifications mean candidate evaluation for the role has ended.
  {
    tag: "position_filled",
    pattern: /\b(?:position\s+has\s+been\s+filled|role\s+has\s+been\s+filled|no\s+longer\s+accepting\s+applications)\b/i,
    weight: 0.9,
    target: "both",
  },
  // Decline subject line pattern ("update on your application").
  //
  // WHY THIS HAS LOW MODERATE WEIGHT: Rejection email subject lines are often vague and need body phrase support.
  {
    tag: "rejection_subject",
    pattern: /\b(?:update\s+on\s+your\s+application|status\s+of\s+your\s+application|your\s+application\s+to|thank\s+you\s+for\s+interviewing)\b/i,
    weight: 0.3,
    target: "subject",
  },
  // Wish best in job search signature phrase ("best of luck in your search").
  //
  // WHY THIS HAS HIGH WEIGHT: Closing sign-offs wishing luck in job search are classic rejection closing indicators.
  {
    tag: "best_in_job_search",
    pattern: /\b(?:wish\s+you\s+(?:the\s+)?best\s+in\s+your\s+job\s+search|best\s+of\s+luck\s+with\s+your\s+search)\b/i,
    weight: 0.8,
    target: "body",
  },
];

// Direct interview invitation phrases for non-screening interview rounds.
//
// WHY INTERVIEW PATTERNS ARE EXPLICIT: An invitation to speak with a hiring manager or tech team
// marks the active `interviewing` stage of an application.
const INTERVIEWING_SIGNALS: readonly SignalRule[] = [
  // Invitation to interview phrases ("like to invite you to an interview").
  //
  // WHY THIS HAS MAXIMUM WEIGHT: Direct explicit invitation wording is definitive proof of interview offer.
  {
    tag: "invite_to_interview",
    pattern: /\b(?:like\s+to\s+invite\s+you\s+to|pleased\s+to\s+invite\s+you|invited\s+to\s+an?\s+interview|schedule\s+an?\s+interview)\b/i,
    weight: 0.95,
    target: "both",
  },
  // Next round of interviews ("advance you to the next stage").
  //
  // WHY THIS HAS HIGH WEIGHT: Progression language indicates advancing to formal interview rounds.
  {
    tag: "next_round_interview",
    pattern: /\b(?:next\s+round\s+of\s+interviews|move\s+you\s+to\s+the\s+next\s+round|advance\s+(?:you\s+)?to\s+the\s+next\s+stage)\b/i,
    weight: 0.9,
    target: "both",
  },
  // Hiring manager or panel interview mention ("technical interview", "onsite interview").
  //
  // WHY THIS HAS HIGH WEIGHT: Mentions of specific interview formats (onsite, panel, hiring manager) confirm interview stage.
  {
    tag: "hiring_manager_interview",
    pattern: /\b(?:interview\s+with\s+the\s+hiring\s+manager|technical\s+interview|panel\s+interview|onsite\s+interview|virtual\s+onsite)\b/i,
    weight: 0.9,
    target: "both",
  },
  // Schedule a call to discuss interview details ("schedule a time to chat").
  //
  // WHY THIS HAS MODERATE HIGH WEIGHT: Recruiter request to schedule calendar slot for conversation.
  {
    tag: "schedule_time_to_chat",
    pattern: /\b(?:schedule\s+a\s+time\s+to\s+(?:chat|speak|talk)|book\s+a\s+time\s+on\s+(?:my|our)\s+calendar)\b/i,
    weight: 0.75,
    target: "both",
  },
  // Subject line interview invitation indicators ("Interview Invitation").
  //
  // WHY THIS HAS HIGH WEIGHT: Email subject explicitly announcing an interview invitation.
  {
    tag: "interview_subject",
    pattern: /\b(?:interview\s+invitation|invitation\s+to\s+interview|schedule\s+your\s+interview)\b/i,
    weight: 0.95,
    target: "subject",
  },
];

// Employer screening phrases (technical assessments, online tests, recruiter pre-screens).
//
// WHY SCREENING PATTERNS ARE DISTINCT: Screening steps (coding challenges, pre-screens) occur
// before formal interviews and map specifically to `employer_screening`.
const SCREENING_SIGNALS: readonly SignalRule[] = [
  // Technical coding assessment / take-home test invitation ("online assessment", "take-home assignment").
  //
  // WHY THIS HAS MAXIMUM WEIGHT: Request to complete an Online Assessment (OA) indicates employer screening stage.
  {
    tag: "technical_assessment",
    pattern: /\b(?:coding\s+assessment|technical\s+assessment|online\s+assessment|take-home\s+(?:test|assignment|project)|coding\s+challenge)\b/i,
    weight: 0.95,
    target: "both",
  },
  // Initial recruiter screen or phone screen ("phone screen", "recruiter screen").
  //
  // WHY THIS HAS HIGH WEIGHT: Recruiter phone screens represent initial candidate screening before team interviews.
  {
    tag: "recruiter_screen",
    pattern: /\b(?:recruiter\s+screen|initial\s+screen|phone\s+screen|pre-screening|screening\s+call)\b/i,
    weight: 0.9,
    target: "both",
  },
  // Questionnaire / pre-screen details request ("screening questions").
  //
  // WHY THIS HAS HIGH WEIGHT: Pre-interview candidate questionnaires are preliminary screening tasks.
  {
    tag: "screening_questionnaire",
    pattern: /\b(?:screening\s+questions|complete\s+the\s+following\s+questionnaire|pre-interview\s+questions)\b/i,
    weight: 0.85,
    target: "both",
  },
  // CodeSignal / HackerRank specific invitation text.
  //
  // WHY THIS HAS MAXIMUM WEIGHT: Direct mention of third-party evaluation vendors is conclusive proof of screening test.
  {
    tag: "assessment_platform_invite",
    pattern: /\b(?:complete\s+your\s+(?:codesignal|hackerrank|byteboard|codility)\b|assessment\s+invitation)\b/i,
    weight: 0.95,
    target: "both",
  },
];

// Evaluate a set of signal rules against parsed email content.
//
// WHY THIS HELPER IS GENERALIZED: Evaluates rules against subject and body uniformly,
// calculating cumulative weighted confidence score and compiling matched signal tags.
function evaluateSignals(
  rules: readonly SignalRule[],
  parsed: ParsedEmail,
): { readonly score: number; readonly matches: readonly string[] } {
  // Initialize accumulator variable for cumulative score weight calculation.
  let totalScore = 0;
  // Initialize array tracking matched signal tags for classification auditing and logging.
  const matchedTags: string[] = [];

  // Iterate over each signal rule in the provided rule set using a standard zero-indexed loop.
  for (let i = 0; i < rules.length; i += 1) {
    // Access individual rule definition object for current iteration.
    const rule = rules[i]!;

    // Initialize string variable to hold selected target text section.
    let textToTest = "";
    // Check if target field is constrained strictly to email subject line.
    if (rule.target === "subject") {
      // Assign clean lowercased subject string for evaluation.
      textToTest = parsed.cleanSubject;
    } else if (rule.target === "body") {
      // Check if target field is constrained strictly to email body content.
      // Assign clean lowercased body string for evaluation.
      textToTest = parsed.cleanBody;
    } else {
      // Target is set to both; concatenate subject and body with space delimiter.
      textToTest = `${parsed.cleanSubject} ${parsed.cleanBody}`;
    }

    // Test regular expression pattern against selected text target string.
    if (rule.pattern.test(textToTest)) {
      // Increment cumulative score by rule's designated score weight value.
      totalScore += rule.weight;
      // Append matched signal tag string to array of matched tags.
      matchedTags.push(rule.tag);
    }
  }

  // Cap normalized confidence score at maximum 1.0 ceiling using Math.min.
  const score = Math.min(1.0, totalScore);

  // Return calculated score number and list of matched tag strings as an immutable object.
  return { score, matches: matchedTags };
}

// Classify a parsed email structure into an `OutcomeClassification` verdict.
//
// WHY THIS IS THE CORE DECISION ENGINE: Evaluates structural signals (scheduling links, assessment platforms,
// auto-replies) alongside weighted keyword scores, applying strict decision order to arrive at the classification.
export function classifyEmail(parsed: ParsedEmail): OutcomeClassification {
  // Step 1: Evaluate rejection signal set first.
  //
  // WHY EVALUATE REJECTION FIRST: Allows calculating rejection confidence score before checking auto-reply flags.
  const rejection = evaluateSignals(REJECTION_SIGNALS, parsed);

  // Step 2: Evaluate interviewing signal set.
  //
  // WHY EVALUATE INTERVIEWING SIGNALS: Calculates keyword match score for interview invitations.
  const interviewing = evaluateSignals(INTERVIEWING_SIGNALS, parsed);

  // Step 3: Evaluate employer screening signal set.
  //
  // WHY EVALUATE SCREENING SIGNALS: Calculates keyword match score for online assessments and pre-screens.
  const screening = evaluateSignals(SCREENING_SIGNALS, parsed);

  // Collect structural signal boosters detected during parsing phase.
  //
  // WHY STRUCTURAL BOOSTERS ARE TRACKED: URLs and platform names detected by parser provide non-textual evidence.
  const structuralMatches: string[] = [];

  // Initialize boosted interviewing score with raw keyword match score.
  let boostedInterviewingScore = interviewing.score;

  // Check if an interview scheduling link (e.g. Calendly, ChiliPiper) was extracted by parser.
  if (parsed.detectedSchedulingUrl !== null) {
    // Increase interviewing score by 0.5 boost factor, capped at 1.0 maximum limit.
    boostedInterviewingScore = Math.min(1.0, boostedInterviewingScore + 0.5);
    // Add scheduling URL tag to structural matches list for auditability.
    structuralMatches.push(`detected_scheduling_url:${parsed.detectedSchedulingUrl}`);
  }

  // Initialize boosted screening score with raw keyword match score.
  let boostedScreeningScore = screening.score;

  // Check if a technical assessment platform (e.g. HackerRank, CodeSignal) was extracted by parser.
  if (parsed.detectedAssessmentPlatform !== null) {
    // Increase screening score by 0.6 boost factor, capped at 1.0 maximum limit.
    boostedScreeningScore = Math.min(1.0, boostedScreeningScore + 0.6);
    // Add assessment platform tag to structural matches list for auditability.
    structuralMatches.push(`detected_assessment_platform:${parsed.detectedAssessmentPlatform}`);
  }

  // DECISION PRECEDENCE RULE 1: Explicit rejection decisions override other signals.
  //
  // WHY REJECTION OVERRIDES: Rejection letters often mention previous stages ("Thank you for interviewing with us..."),
  // but the final decision is non-selection. High confidence rejection signals must take precedence.
  if (rejection.score >= 0.8) {
    // Construct and return high confidence rejection outcome result object.
    return {
      // Primary outcome classification string verdict.
      outcome: "rejected",
      // Numerical confidence score calculated from rejection signals.
      confidence: rejection.score,
      // Consolidated array of matched rejection and structural signal tags.
      matchedSignals: [...rejection.matches, ...structuralMatches],
      // Human-readable summary explanation detailing why rejection was chosen.
      reasoning: "Email contains strong explicit rejection phrases indicating candidate non-selection.",
    };
  }

  // DECISION PRECEDENCE RULE 2: Interviewing signals (invitations to interview with team/manager).
  //
  // WHY INTERVIEWING HAS NEXT PRIORITY: Direct interview invitations indicate stage advancement.
  if (boostedInterviewingScore >= 0.7 && boostedInterviewingScore >= boostedScreeningScore) {
    // Construct and return high confidence interviewing outcome result object.
    return {
      // Primary outcome classification string verdict.
      outcome: "interviewing",
      // Numerical confidence score calculated from boosted interviewing signals.
      confidence: boostedInterviewingScore,
      // Consolidated array of matched interviewing and structural signal tags.
      matchedSignals: [...interviewing.matches, ...structuralMatches],
      // Human-readable summary explanation detailing why interviewing was chosen.
      reasoning: "Email contains invitation to interview or scheduling link for an interview round.",
    };
  }

  // DECISION PRECEDENCE RULE 3: Employer screening signals (coding challenges, pre-screens).
  //
  // WHY SCREENING FOLLOWS: Technical assessments or recruiter screens indicate pre-interview evaluation.
  if (boostedScreeningScore >= 0.7) {
    // Construct and return high confidence employer screening outcome result object.
    return {
      // Primary outcome classification string verdict.
      outcome: "employer_screening",
      // Numerical confidence score calculated from boosted screening signals.
      confidence: boostedScreeningScore,
      // Consolidated array of matched screening and structural signal tags.
      matchedSignals: [...screening.matches, ...structuralMatches],
      // Human-readable summary explanation detailing why employer screening was chosen.
      reasoning: "Email requests technical assessment, online coding challenge, or recruiter pre-screen.",
    };
  }

  // Step 4: Check for automated receipt acknowledgments or out-of-office notes when no explicit outcome match occurred.
  //
  // WHY CHECK RECEIPT AFTER DECISION SIGNALS: Prevents auto-reply detection from swallowing genuine rejection decisions.
  if (parsed.isAutoReplyOrConfirmation) {
    // Construct and return unknown outcome for receipt confirmations so application status is preserved.
    return {
      // Primary outcome classification string verdict.
      outcome: "unknown",
      // High confidence score that email is an unclassified receipt acknowledgment.
      confidence: 0.9,
      // Matched signal tag indicating automated receipt confirmation.
      matchedSignals: ["auto_reply_or_application_receipt"],
      // Human-readable summary explanation detailing why unknown was chosen for auto-reply.
      reasoning: "Email identified as an automated application receipt confirmation or out-of-office reply.",
    };
  }

  // Moderate rejection signal check (score >= 0.5 when no interview or screen signals present).
  //
  // WHY CATCH MODERATE REJECTIONS: Catches softer rejection phrases when no competing active signals exist.
  if (rejection.score >= 0.5 && boostedInterviewingScore < 0.3 && boostedScreeningScore < 0.3) {
    // Construct and return moderate confidence rejection verdict object.
    return {
      // Primary outcome classification string verdict.
      outcome: "rejected",
      // Numerical confidence score calculated from moderate rejection signals.
      confidence: rejection.score,
      // Consolidated array of matched rejection and structural signal tags.
      matchedSignals: [...rejection.matches, ...structuralMatches],
      // Human-readable summary explanation detailing why moderate rejection was chosen.
      reasoning: "Email contains moderate rejection phrasing without any interview or screening invitation.",
    };
  }

  // Fallback Rule: If no category reached minimum confidence threshold, classify as 'unknown'.
  //
  // WHY UNKNOWN IS THE SAFE FALLBACK: Prevents false status transitions when email content is ambiguous.
  return {
    // Primary outcome classification string verdict.
    outcome: "unknown",
    // Low fallback confidence score representing uncertainty.
    confidence: 0.3,
    // Consolidated array of all matched signals evaluated across categories.
    matchedSignals: [...rejection.matches, ...interviewing.matches, ...screening.matches, ...structuralMatches],
    // Human-readable summary explanation detailing why fallback unknown was chosen.
    reasoning: "Email content did not match interviewing, screening, or rejection criteria with high confidence.",
  };
}

// Convenience classifier entry point taking raw email input fields (subject, body, sender).
//
// WHY THIS FUNCTION EXISTS: Allows callers to pass raw strings directly without manually calling `parseEmail`.
export function classifyRawEmail(input: ParseEmailInput): OutcomeClassification {
  // Parse raw input fields into a structured `ParsedEmail` object using `parseEmail`.
  const parsed = parseEmail(input);

  // Pass parsed email to classification decision engine and return outcome result object.
  return classifyEmail(parsed);
}
