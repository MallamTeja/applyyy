// Import the Untrusted type.
// WHY: We need to mark inputs that come from the application or user as untrusted.
import type { Untrusted } from "../contracts/shared-types.ts";

// Define the interface for the generated interview prep pack.
// WHY: We need a typed structure for the database insertion and UI consumption.
export interface InterviewPrepPack {
  // A brief overview of the company.
  // WHY: Helps the candidate understand who they are interviewing with.
  companyResearchOverview: string;
  // A list of questions tailored to the role.
  // WHY: Allows the candidate to practice answering relevant questions.
  roleSpecificQuestions: string[];
  // A list of experience highlights to emphasize.
  // WHY: Reminds the candidate what parts of their background fit the job best.
  experienceHighlights: string[];
  // A list of general talking points or questions for the interviewer.
  // WHY: Ensures the candidate has things to say or ask during the interview.
  talkingPoints: string[];
}

// Build a fallback prep pack when generation fails or is skipped.
// WHY: We need a safe default to prevent the UI from breaking if the LLM fails.
export function buildFallbackPrepPack(
  // The company name.
  // WHY: Used to personalize the fallback slightly.
  companyName: Untrusted,
  // The job title.
  // WHY: Used to personalize the fallback slightly.
  jobTitle: Untrusted
): InterviewPrepPack {
  // Return a generic prep pack.
  // WHY: This fulfills the contract without needing the LLM.
  return {
    // A generic company overview.
    // WHY: We don't have real research, so we state that clearly.
    companyResearchOverview: `Research overview for ${companyName} is currently unavailable. Please review their website.`,
    // Generic questions.
    // WHY: Basic behavioral questions apply to almost any role.
    roleSpecificQuestions: [
      // Standard question 1.
      // WHY: Extremely common interview question.
      "Tell me about yourself.",
      // Standard question 2.
      // WHY: Good for assessing alignment with the role.
      `Why do you want to work as a ${jobTitle}?`,
      // Standard question 3.
      // WHY: Tests problem-solving and resilience.
      "Describe a time you faced a difficult challenge at work."
    ],
    // Generic experience highlights.
    // WHY: We don't know the candidate's exact fit without the LLM, so we give general advice.
    experienceHighlights: [
      // Highlight advice 1.
      // WHY: Encourages focusing on impact.
      "Emphasize your most recent and relevant projects.",
      // Highlight advice 2.
      // WHY: Standard STAR method advice.
      "Focus on measurable outcomes and metrics.",
      // Highlight advice 3.
      // WHY: Shows ability to collaborate.
      "Highlight instances of teamwork and leadership."
    ],
    // Generic talking points.
    // WHY: Useful questions for the candidate to ask at the end.
    talkingPoints: [
      // Point 1.
      // WHY: Shows interest in the company's future.
      "What are the biggest challenges the team is facing right now?",
      // Point 2.
      // WHY: Clarifies expectations.
      "What does success look like in the first 90 days?",
      // Point 3.
      // WHY: Shows interest in team dynamics.
      "Can you describe the team culture?"
    ]
  };
}
