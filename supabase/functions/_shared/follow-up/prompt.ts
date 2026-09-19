// Import schema type definition from the shared type contracts
// This ensures our response schema aligns with the database model
// We need to define the exact shape of a follow-up nudge draft
export interface FollowUpNudgeDraft {
  // The subject line for the follow up email
  subject: string;
  // The body content for the follow up email
  body: string;
}

// Define the parameters required to build the prompt
// We need the company name, job title, and application date
export interface BuildPromptParams {
  // The name of the company the user applied to
  companyName: string;
  // The title of the job the user applied for
  jobTitle: string;
  // The date the application was submitted
  applicationDate: string;
  // Any extra context or notes about the application
  notes?: string;
}

// Export the prompt builder function
// It takes in application details and outputs prompt components
export function buildFollowUpNudgePrompt(params: BuildPromptParams) {
  // Extract parameters to use in the prompt strings
  // This makes the string interpolation cleaner below
  const { companyName, jobTitle, applicationDate, notes } = params;

  // Define the system instruction for the LLM
  // We want it to act as a professional career coach
  // Writing concise and polite follow-up emails
  const systemInstruction = `You are an expert career coach and professional communicator.
Your task is to draft a polite, concise, and professional follow-up email for a job application.
The email should express continued interest and ask about the status of the application.
Keep the tone confident but not pushy.`;

  // Build the user content string with all provided context
  // Include company name, job title, and application date
  // Also include notes if any are provided
  const userContent = `Please draft a follow-up email for my application.
Company: ${companyName}
Job Title: ${jobTitle}
Application Date: ${applicationDate}
Additional Notes: ${notes || "None"}
Make sure to provide a subject line and the email body.`;

  // Define the expected JSON response schema
  // This forces the LLM to return data in a predictable format
  // We expect an object with 'subject' and 'body' properties
  const responseSchema = {
    // The type is an object
    type: "OBJECT",
    // Define the properties of the object
    properties: {
      // The subject line property
      subject: {
        // Must be a string
        type: "STRING",
        // Description of what the subject should contain
        description: "The subject line for the email",
      },
      // The body property
      body: {
        // Must be a string
        type: "STRING",
        // Description of what the body should contain
        description: "The main content of the follow-up email",
      },
    },
    // Both properties are required
    required: ["subject", "body"],
  };

  // Return the constructed prompt pieces
  // These will be passed to the Gemini client
  return {
    // The system instruction string
    systemInstruction,
    // The user content string
    userContent,
    // The required JSON schema
    responseSchema,
  };
}
