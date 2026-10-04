// Import the generateGeminiContent function for calling the LLM API
// This is the standard way to interface with Gemini in this project
import { generateGeminiContent } from "../gemini/client.ts";

// Import the prompt builder and interfaces from the local prompt file
// This keeps the logic separated and testable
import { buildFollowUpNudgePrompt, type BuildPromptParams, type FollowUpNudgeDraft } from "./prompt.ts";

// The database client the Gemini transport claims pool keys through. Derived from the
// transport's own signature rather than importing `SupabaseClient` from jsr, so this file
// names no second copy of a type that could drift from what the transport actually takes.
type GeminiDb = Parameters<typeof generateGeminiContent>[0];

// Generate one follow-up nudge draft.
//
// FIXED 2026-10-04: this used to call `generateGeminiContent({ systemInstruction, prompt,
// schema, responseFormat })` — ONE argument in a shape the transport never had — and read
// `.text`/`.error`, which do not exist on its result. Four TS errors, and at runtime every
// call threw into the catch below, so every nudge was the generic fallback. The transport
// takes `(db, { prompt: { systemInstruction, userContent, responseSchema } })` and returns
// `{ ok: true, data: GeminiResponseBody }` or `{ ok: false, reason, detail? }`, exactly as
// the matcher and tailor call it.
export async function generateFollowUpNudge(db: GeminiDb, params: BuildPromptParams): Promise<FollowUpNudgeDraft> {
  // The fenced prompt pieces, built by the pure, separately testable builder.
  const { systemInstruction, userContent, responseSchema } = buildFollowUpNudgePrompt(params);

  // Any throw (network, malformed JSON) degrades to the fallback rather than failing the run.
  try {
    // Two arguments: the db for key-pool claims, then the prompt in the transport's shape.
    const result = await generateGeminiContent(db, {
      // Passed through unchanged — the builder already shaped it for the transport.
      prompt: { systemInstruction, userContent, responseSchema },
    });

    // A pool or transport failure is not a draft: log the reason and fall back.
    if (!result.ok) {
      // `reason` is the closed failure kind; `detail` is optional free text.
      console.error("Gemini failed to generate nudge:", result.reason, result.detail ?? "");
      // The user still gets something to send.
      return buildFallbackNudge(params.companyName, params.jobTitle);
    }

    // Same extraction as matcher/tailor: optional at every hop, because a safety-blocked
    // response can omit any of them.
    const text = result.data.candidates?.[0]?.content?.parts?.[0]?.text;
    // No text means the model did not answer.
    if (typeof text !== "string") return buildFallbackNudge(params.companyName, params.jobTitle);

    // Parsed as unknown, then shape-checked — a cast would let `{}` through as a draft
    // with an undefined subject that only fails at the NOT NULL insert.
    const parsed: unknown = JSON.parse(text);
    // Both fields must be non-empty strings to count as a draft.
    if (
      typeof parsed === "object" && parsed !== null &&
      typeof (parsed as { subject?: unknown }).subject === "string" &&
      typeof (parsed as { body?: unknown }).body === "string" &&
      (parsed as { subject: string }).subject.trim() !== "" &&
      (parsed as { body: string }).body.trim() !== ""
    ) {
      // Only the two fields the table stores, nothing else the model may have added.
      return { subject: (parsed as { subject: string }).subject, body: (parsed as { body: string }).body };
    }
    // Wrong shape: treat like no answer.
    return buildFallbackNudge(params.companyName, params.jobTitle);
  } catch (error) {
    // If an exception was thrown during the API call or parse, log it
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
