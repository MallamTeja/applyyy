// Import the generateGeminiContent function for calling the LLM API
// This is the standard way to interface with Gemini in this project
import { generateGeminiContent } from "../gemini/client.ts";

// Import the prompt builder and interfaces from the local prompt file
// This keeps the logic separated and testable
import { buildFollowUpNudgePrompt, BuildPromptParams, FollowUpNudgeDraft } from "./prompt.ts";

// Define the function to generate a follow up nudge
// This is an asynchronous function because it calls an external API
// It takes the same parameters as the prompt builder
export async function generateFollowUpNudge(params: BuildPromptParams): Promise<FollowUpNudgeDraft> {
  // Call the prompt builder to get the necessary components
  // We get the system instruction, user content, and schema
  const { systemInstruction, userContent, responseSchema } = buildFollowUpNudgePrompt(params);

  // Attempt to call the Gemini API
  // We wrap this in a try-catch block to handle any network or API errors
  try {
    // Await the response from the Gemini client
    // We pass the structured prompt and schema
    const result = await generateGeminiContent({
      // Pass the system instruction
      systemInstruction,
      // Pass the user content as the prompt
      prompt: userContent,
      // Pass the JSON schema to ensure structured output
      schema: responseSchema,
      // Request JSON response format
      responseFormat: "json",
    });

    // Check if the result was successful
    // The client returns an 'ok' boolean flag
    if (result.ok && result.text) {
      // Parse the JSON text returned by the model
      // We cast it to our FollowUpNudgeDraft interface
      const draft = JSON.parse(result.text) as FollowUpNudgeDraft;
      // Return the parsed draft
      return draft;
    }
    
    // If the result was not ok, or text was missing
    // We log the error for debugging purposes
    console.error("Gemini failed to generate nudge:", result.error);
    // Fallback to the generic nudge if LLM fails
    return buildFallbackNudge(params.companyName, params.jobTitle);
  } catch (error) {
    // If an exception was thrown during the API call
    // We catch it and log it
    console.error("Error generating follow-up nudge:", error);
    // Again, fallback to the generic nudge to ensure the user gets something
    return buildFallbackNudge(params.companyName, params.jobTitle);
  }
}

// Define a fallback function for when the LLM is unavailable
// This ensures the system remains robust
// It provides a deterministic, generic email draft
export function buildFallbackNudge(companyName: string, jobTitle: string): FollowUpNudgeDraft {
  // Construct a standard subject line
  // It includes the job title and company name
  const subject = `Following up on my application for ${jobTitle}`;
  
  // Construct a standard body
  // It is polite and asks for a status update
  const body = `Hi Hiring Team,\n\nI hope you're doing well.\n\nI recently applied for the ${jobTitle} position at ${companyName} and wanted to express my continued interest in the role. I would love to know if there are any updates regarding my application.\n\nThank you for your time and consideration.\n\nBest regards,`;
  
  // Return the constructed fallback draft
  return {
    // Return the fallback subject
    subject,
    // Return the fallback body
    body,
  };
}
