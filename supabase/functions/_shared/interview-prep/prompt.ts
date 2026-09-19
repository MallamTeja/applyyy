// Define the parameters for building the interview prep prompt.
// WHY: We need a typed contract for the untrusted inputs used to generate the prompt.
import type { Untrusted } from "../contracts/shared-types.ts";

// Define the interface for the prompt parameters.
// WHY: We want to ensure callers provide the exact required untrusted fields.
export interface InterviewPrepPromptParams {
  // The job title from the application.
  // WHY: Needed to focus the preparation on the specific role.
  jobTitle: Untrusted;
  // The company name from the application.
  // WHY: Needed to provide context for company research.
  companyName: Untrusted;
  // The job description from the application.
  // WHY: Needed to generate relevant questions and talking points.
  jobDescription: Untrusted;
}

// Build the prompt payload for the Gemini model.
// WHY: Centralizes the generation logic so it can be tested and reused independently of the API call.
export function buildInterviewPrepPrompt(params: InterviewPrepPromptParams) {
  // The system instruction defines the persona and constraints for the LLM.
  // WHY: We need Gemini to act as an expert interview coach and return structured JSON.
  const systemInstruction = "You are an expert interview coach. Your task is to analyze the job description and company to generate an interview preparation pack. Return the result in the requested JSON structure.";

  // The user content contains the fenced untrusted inputs.
  // WHY: Fencing with triple backticks prevents the untrusted text from breaking out and injecting instructions.
  const userContent = `
Generate an interview prep pack for the following role:

Company:
\`\`\`
${params.companyName}
\`\`\`

Job Title:
\`\`\`
${params.jobTitle}
\`\`\`

Job Description:
\`\`\`
${params.jobDescription}
\`\`\`
  `.trim();

  // The response schema enforces the structure of the JSON returned by Gemini.
  // WHY: Structured output is required to parse the response deterministically without fragile regexes.
  const responseSchema = {
    // The top-level type must be an object.
    // WHY: The prep pack is a collection of properties.
    type: "OBJECT",
    // Define the properties expected in the output.
    // WHY: We need specific fields for the prep pack structure.
    properties: {
      // The company research overview.
      // WHY: Gives the user a quick summary of the company.
      companyResearchOverview: {
        // String type for paragraphs.
        // WHY: The overview is text.
        type: "STRING",
        // Describe what is needed.
        // WHY: Helps the model understand the field.
        description: "A brief overview of the company and its market position.",
      },
      // Questions specific to the role.
      // WHY: Helps the user practice.
      roleSpecificQuestions: {
        // Array type for multiple questions.
        // WHY: We want a list of questions.
        type: "ARRAY",
        // Array items are strings.
        // WHY: Each question is text.
        items: { type: "STRING" },
        // Describe what is needed.
        // WHY: Helps the model generate relevant questions.
        description: "A list of 3-5 technical or behavioral questions specific to the job description.",
      },
      // Highlights to focus on.
      // WHY: Guides the user on what to emphasize.
      experienceHighlights: {
        // Array type for multiple highlights.
        // WHY: We want a list.
        type: "ARRAY",
        // Array items are strings.
        // WHY: Each highlight is text.
        items: { type: "STRING" },
        // Describe what is needed.
        // WHY: Directs the model's focus.
        description: "A list of 3-5 key experience highlights the candidate should emphasize.",
      },
      // General talking points.
      // WHY: Gives the user conversation starters or key themes.
      talkingPoints: {
        // Array type for multiple points.
        // WHY: We want a list.
        type: "ARRAY",
        // Array items are strings.
        // WHY: Each point is text.
        items: { type: "STRING" },
        // Describe what is needed.
        // WHY: Ensures the model provides useful points.
        description: "A list of 3-5 general talking points or questions the candidate can ask the interviewer.",
      },
    },
    // Mark all properties as required.
    // WHY: We need all parts of the pack to render the UI properly.
    required: ["companyResearchOverview", "roleSpecificQuestions", "experienceHighlights", "talkingPoints"],
  };

  // Return the built prompt object.
  // WHY: This is the exact shape expected by the `generateGeminiContent` helper.
  return {
    // Pass the instruction.
    // WHY: Required for the persona.
    systemInstruction,
    // Pass the prompt text.
    // WHY: Contains the data to process.
    userContent,
    // Pass the schema.
    // WHY: Enforces the return type.
    responseSchema,
  };
}
