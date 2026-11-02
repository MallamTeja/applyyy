// Outcome classifier for email messages received from hiring teams and recruiters.
//
// WHY THIS IS A DEDICATED OUTCOME CLASSIFIER MODULE: When an email is received from a hiring team,
// the system must classify the job application lifecycle outcome into one of five deterministic states:
// 'interviewing', 'employer_screening', 'rejected', 'offer' (since W32, 2026-11-02), or 'unknown'.
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
// - 'offer': The employer has extended a job offer (W32, 2026-11-02). Terminal downstream, so it
//   needs a positive decision phrase; offer-letter and subject wording only corroborate.
// - 'unknown': Email is an application receipt, auto-reply, or generic text without status decision.
export type EmailOutcome = "interviewing" | "rejected" | "employer_screening" | "offer" | "unknown";

// Array tuple of allowed email outcome strings for runtime validation.
//
// WHY AN EXPLICIT CONST TUPLE IS EXPOSED: Allows runtime iteration, validation, and schema definitions
// without duplicating the literal outcome string array across packages.
export const EMAIL_OUTCOMES = ["interviewing", "rejected", "employer_screening", "offer", "unknown"] as const;

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
// Exported (2026-10-06) only so the weight guards in `email-tracker-intake/decide.test.ts` can type the rules.
export interface SignalRule {
  // Description tag for logging and auditing matched signals.
  readonly tag: string;
  // Regular expression pattern matching specific wording in the email text.
  readonly pattern: RegExp;
  // Weight contribution of this signal to the outcome score.
  readonly weight: number;
  // Target text section to inspect ('subject', 'body', or 'both').
  readonly target: "subject" | "body" | "both";
  // True for a weak signal that may only CORROBORATE a decision phrase, never reach a terminal
  // verdict by itself or with other weak ones. WHY A FLAG AND NOT A COMMENT: scores are ADDITIVE
  // (`totalScore += rule.weight` in `evaluateSignals`), so "can only corroborate" is a property of
  // the SUM of all such rules, which only a test can hold. The flag is what that test reads.
  readonly corroborateOnly?: true;
}

// Lowest rejection score the moderate branch labels `rejected` (it never moves a status: the
// tracker's terminal gate is 0.8). Exported so the weight guard reads the live cutoff, not a copy.
export const MODERATE_REJECTION_MIN = 0.5;

// Either apostrophe: mail clients swap ASCII ' for the typographic ’ freely, so "we've"
// arrives in both forms and a rule that knew only one would miss half of real mail.
const APOS = "['’]";

// What must follow "Unfortunately, we" / "After careful consideration, we" for it to be a DECISION.
//
// WHY EVERY BRANCH CARRIES ITS OBJECT (2026-10-06): the bare verb is not a decision. "decided" alone
// made "after careful consideration, we have decided to move forward with your application" a strong
// TERMINAL rejection, and "cannot move" did the same to "unfortunately, we cannot move your
// interview to Friday" — both live false rejections. So "decided" counts only with "not to" or with
// OTHER candidates, and every negated verb only with "move forward", "proceed with your/further",
// or an offer. Shared by both openers, so the two can never drift apart.
const DECISION_AFTER_WE = [
  // "we decided" / "we have decided" / "we've decided" (and determined, chosen, elected)...
  `(?:\\s+have|${APOS}ve)?\\s+(?:decided|determined|chosen|elected)\\s+`,
  // ...followed by a refusal, or by choosing someone else. "to move forward with you" is NOT here.
  `(?:not\\s+to\\b|to\\s+(?:move|go)\\s+forward\\s+with\\s+(?:other|another|different)\\b|to\\s+pursue\\s+other\\b)`,
  // OR a negated ability or intent, contracted or not ("won't", "we're not", "can't", "are unable to")...
  `|(?:\\s+will\\s+not|\\s+won${APOS}t|\\s+are\\s+not|${APOS}re\\s+not|\\s+aren${APOS}t|\\s+cannot|\\s+can${APOS}t|\\s+are\\s+unable\\s+to|${APOS}re\\s+unable\\s+to)`,
  // ...followed by moving forward, proceeding with the candidate, or an offer. Never a meeting or a slot.
  `\\s+(?:be\\s+)?(?:able\\s+to\\s+)?(?:mov(?:e|ing)\\s+forward|proceed(?:ing)?\\s+(?:with\\s+your|further)|offer\\s+you|extend(?:ing)?\\s+(?:you\\s+)?an\\s+offer)`,
].join("");

// Strong explicit rejection phrases used by ATS platforms and hiring managers.
//
// WHY REJECTION PATTERNS ARE EXPLICIT: Rejection emails follow predictable corporate templates.
// Identifying these exact decision phrases guarantees zero false positives for active candidates.
// Exported (2026-10-06) for the weight-sum guard only; nothing at runtime imports it.
export const REJECTION_SIGNALS: readonly SignalRule[] = [
  // Direct statement of non-selection ("not moving forward", "decided not to proceed").
  //
  // WHY THIS HAS HIGH WEIGHT: Explicit statements of non-selection carry near-certain confidence of rejection.
  {
    tag: "not_moving_forward",
    // WHY THE LOOKAHEAD (2026-10-06): "not moving forward" is a verdict only when what follows is
    // the candidate, a time qualifier, or the end of the clause. "will not be moving forward with the
    // onsite until..." is a postponement and used to score 0.95 as a terminal rejection.
    // WHY `won't`/`aren't` (2026-10-06): the contraction of the same phrase matched nothing, since
    // "won't" contains no "not". Both apostrophes, via APOS.
    pattern: new RegExp(
      // The negation, written out or contracted; `\b` sits before each because "won't" has no
      // word boundary before its "n".
      `(?:\\bnot|\\b(?:won|aren|isn)${APOS}t)\\s+(?:be\\s+)?moving\\s+forward` +
        // ...and only when its object is the candidate, a time, or the clause simply ends.
        `(?=\\s+with\\s+(?:your|you)\\b|\\s+at\\s+this\\s+(?:time|stage|point)\\b|\\s*[.,;!]|\\s*$)` +
        // The other two phrasings, unchanged in meaning; `won't be proceeding` added for the contraction.
        `|\\b(?:will\\s+not|won${APOS}t)\\s+(?:be\\s+)?proceeding\\b|\\bdecided\\s+not\\s+to\\s+(?:proceed|move\\s+forward)\\b`,
      // Case-insensitive, as every rule here.
      "i",
    ),
    weight: 0.95,
    target: "both",
  },
  // Choosing other candidates ("moved forward with other candidates", "chosen another candidate").
  //
  // WHY THIS HAS HIGH WEIGHT: Candidate competition decisions indicate final non-selection for this position.
  {
    tag: "moved_with_other_candidates",
    // WHY BASE FORM, `go`, `proceed` AND `another` (2026-10-06): "we have decided to MOVE forward
    // with other candidates" (no "Unfortunately,") matched no rule at all, nor did "go forward with
    // another candidate". The object stays mandatory: OTHER/ANOTHER/DIFFERENT candidates or
    // applicants, so "move forward with you" or "with your application" can never match here.
    pattern: /\b(?:(?:mov(?:e|ed|ing)|go(?:ing)?|went)\s+forward\s+with\s+(?:other|another|different)\s+(?:candidates?|applicants?)|proceed(?:ed|ing)?\s+with\s+(?:other|another|different)\s+(?:candidates?|applicants?)|pursu(?:ing|e|ed)\s+other\s+candidates|chosen\s+another\s+candidate|selected\s+another\s+(?:applicant|candidate))\b/i,
    weight: 0.95,
    target: "both",
  },
  // Regret to inform boilerplate ("regret to inform you", "after careful consideration").
  //
  // WHY THIS HAS HIGH WEIGHT: Standard formal rejection opening phrases used by corporate recruitment teams.
  {
    tag: "regret_to_inform",
    // WHY NO BARE "unfortunately, we" HERE (fixed 2026-10-05): "Unfortunately, we need to reschedule
    // your interview" scored 0.85 as a rejection and `rejected` is terminal. Only a decision phrase
    // after "unfortunately, we" counts as strong; "after careful consideration, we" needs the same decision phrase
    // (2026-10-05: "after careful consideration, we have scheduled your onsite" was a false terminal rejection).
    // 2026-10-06: the decision phrase is DECISION_AFTER_WE (see it for why every branch needs an
    // object), the comma is optional ("Unfortunately we..."), and contractions are accepted.
    pattern: new RegExp(
      // The formal opener stands alone; the two softer openers need a decision phrase after "we".
      `\\b(?:regret\\s+to\\s+inform\\s+you|(?:unfortunately|after\\s+careful\\s+consideration),?\\s+we(?:${DECISION_AFTER_WE}))`,
      // Case-insensitive, as every rule here.
      "i",
    ),
    weight: 0.85,
    target: "both",
  },
  // Bare politeness opener with no decision phrase ("unfortunately, we need to reschedule",
  // "after careful consideration, we have scheduled your final round").
  //
  // WHY THIS HAS LOW WEIGHT: It is a tone word, also used for scheduling, delay and outage news.
  // 0.35 (was 0.4 until 2026-10-06): below the 0.5 moderate cutoff alone, and lowered so that ALL
  // corroborate-only rules firing together (0.35 + 0.25 + 0.15 = 0.75) stay under the 0.8 terminal gate.
  // At 0.4 with the old sign-off weight, "Unfortunately, we ... best in your job search" scored 0.85.
  {
    tag: "unfortunately_bare",
    pattern: /\b(?:unfortunately|after\s+careful\s+consideration),?\s+we\b/i,
    weight: 0.35,
    target: "both",
    // Tone word only; see the weight-sum guard in decide.test.ts.
    corroborateOnly: true,
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
  // 0.25 (was 0.3 until 2026-10-06): part of the corroborate-only budget that must sum under 0.8.
  // With the bare opener (0.35) it still reaches 0.6, the stored-but-never-moved moderate band.
  {
    tag: "rejection_subject",
    pattern: /\b(?:update\s+on\s+your\s+application|status\s+of\s+your\s+application|your\s+application\s+to|thank\s+you\s+for\s+interviewing)\b/i,
    weight: 0.25,
    target: "subject",
    // "Update on your application" heads offers and interviews too; it can only corroborate.
    corroborateOnly: true,
  },
  // Wish best in job search signature phrase ("best of luck in your search").
  //
  // WHY THIS HAS LOW WEIGHT (0.8 until 2026-10-05, 0.45 until 2026-10-06, now 0.15): a sign-off is
  // politeness, not a decision. At 0.45 it plus the bare opener (0.4) summed to 0.85 and cleared the
  // terminal gate with no decision phrase at all. 0.15 keeps all corroborate-only rules at 0.75 total.
  {
    tag: "best_in_job_search",
    pattern: /\b(?:wish\s+you\s+(?:the\s+)?best\s+in\s+your\s+job\s+search|best\s+of\s+luck\s+with\s+your\s+search)\b/i,
    weight: 0.15,
    target: "body",
    // Sign-off only; see the weight-sum guard in decide.test.ts.
    corroborateOnly: true,
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

// Lowest offer score classified as `offer`: the tracker's terminal gate (decide.ts, 0.8), so an
// offer verdict always clears it and the corroborate-only sum (0.6) never reaches it.
export const OFFER_MIN = 0.8;

// Job-offer phrases (W32, 2026-11-02). Exported for the weight-sum guard in decide.test.ts.
//
// WHY SO NARROW: `offer` is terminal, and the word is everywhere in recruiter and retail mail
// ("offer letter templates", "job offers for you", "an offer of 30% off"). Only an employer
// stating that it IS offering Teja a job counts: a positive verb ("pleased/delighted/... to")
// bound to a job object ("the position", "an offer of employment"). A negation ("will not be
// extending an offer") has no positive verb, so it never matches here; with "unfortunately,
// we" it is a rejection, which classifyEmail checks first.
export const OFFER_SIGNALS: readonly SignalRule[] = [
  // The decision phrase.
  {
    tag: "offer_extended",
    pattern: new RegExp(
      // The positive opener: an emotion verb or "would like to"/"'d like to".
      `\\b(?:(?:pleased|delighted|happy|excited|thrilled|glad)\\s+to|(?:would|${APOS}d)\\s+like\\s+to)\\s+(?:formally\\s+)?` +
        // Either "offer you the position/role/job" ("the opportunity" is not a job: excluded)...
        `(?:offer\\s+you\\s+the\\s+(?:position|role|job)\\b` +
        // ...or "extend (you) an offer" whose object is employment, never a discount.
        `|extend\\s+(?:to\\s+you\\s+|you\\s+)?(?:an?\\s+|our\\s+)?(?:formal\\s+|verbal\\s+|written\\s+)?(?:job\\s+offer\\b|offer\\s+of\\s+employment\\b|offer\\s+to\\s+join\\b|offer\\s+for\\s+the\\s+(?:position|role)\\b))`,
      // Case-insensitive, as every rule here.
      "i",
    ),
    weight: 0.9,
    target: "both",
  },
  // The offer letter itself, attached or to be signed.
  {
    tag: "offer_letter_attached",
    // "Your offer letter is attached" / "attached is your offer letter" / "sign and return the
    // offer letter". The lookahead drops "offer letter template(s)", the spam form.
    pattern: /\b(?:(?:your|the)\s+offer\s+letter(?!\s+templates?)\s+(?:is\s+)?attached|attached\s+(?:is\s+)?(?:your|the)\s+offer\s+letter(?!\s+templates?)|sign\s+(?:and\s+return\s+)?(?:your|the)\s+offer\s+letter(?!\s+templates?))\b/i,
    // Corroborates only: a forwarded or templated letter mentions this without a decision.
    weight: 0.3,
    target: "body",
    corroborateOnly: true,
  },
  // Subject naming an offer ("Your offer from Stripe", "Offer of employment").
  {
    tag: "offer_subject",
    // `job offer\b` refuses "job offers" (a listing digest); the lookahead refuses "offer letter templates".
    pattern: /\b(?:job\s+offer\b|offer\s+of\s+employment\b|offer\s+letter\b(?!\s+templates?)|your\s+offer\b)/i,
    // Subjects are short and spammy: corroborates only.
    weight: 0.3,
    target: "subject",
    corroborateOnly: true,
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

  // Step 3b: Evaluate the offer signal set (W32).
  //
  // WHY BEFORE THE PRECEDENCE RULES: rule 1b reads it, ahead of interviewing.
  const offer = evaluateSignals(OFFER_SIGNALS, parsed);

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

  // DECISION PRECEDENCE RULE 1b: An explicit offer (W32, 2026-11-02).
  //
  // WHY AFTER REJECTION AND BEFORE INTERVIEWING: an offer email routinely mentions the interview
  // it follows ("after your onsite interview, we are pleased to offer you..."), so the later
  // stage must win; a strong rejection still wins over both. WHY THE REJECTION CEILING: any
  // moderate rejection wording beside an offer phrase makes the email ambiguous, and `offer` is
  // terminal, so ambiguity falls through to the safer verdicts below.
  if (offer.score >= OFFER_MIN && rejection.score < MODERATE_REJECTION_MIN) {
    // Construct and return the offer outcome result object.
    return {
      // Primary outcome classification string verdict.
      outcome: "offer",
      // Numerical confidence score calculated from offer signals.
      confidence: offer.score,
      // Matched offer and structural signal tags.
      matchedSignals: [...offer.matches, ...structuralMatches],
      // Human-readable summary explanation detailing why offer was chosen.
      reasoning: "Email states that the employer is extending a job offer.",
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
  // Named constant so the weight guard tests the same cutoff this branch uses.
  if (rejection.score >= MODERATE_REJECTION_MIN && boostedInterviewingScore < 0.3 && boostedScreeningScore < 0.3) {
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
    matchedSignals: [...rejection.matches, ...interviewing.matches, ...screening.matches, ...offer.matches, ...structuralMatches],
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
