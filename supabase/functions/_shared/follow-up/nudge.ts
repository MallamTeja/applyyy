// Generate one follow-up nudge draft through Gemini — or report why there is none.
//
// NO FALLBACK (2026-10-04). This used to return a generic template on every failure.
// follow-up/index.ts skips any application that already has a nudge, so a stored template
// was PERMANENT: one Gemini hiccup and that application never got a real draft. Now a
// failure is returned as an error, the caller stores nothing and counts it, and the next
// run retries — the same rule as referral and interview-prep.
//
// Transport shape (fixed earlier the same day): `(db, { prompt: { systemInstruction,
// userContent, responseSchema } })`, returning `{ ok: true, data }` or `{ ok: false,
// reason, detail? }`, exactly as the matcher and tailor call it.

// The Gemini key-pool transport.
import { generateGeminiContent } from "../gemini/client.ts";
// One failure line for every Gemini caller: reason, HTTP status, short redacted detail.
import { formatGeminiFailure } from "../gemini/failure-message.ts";
// The fenced prompt builder and its types.
import { buildFollowUpNudgePrompt, type BuildPromptParams, type FollowUpNudgeDraft } from "./prompt.ts";
// The pure shape check, kept where `node --test` can pin it.
import { parseNudgeReply } from "./nudge-row.ts";

// The database client the transport claims pool keys through. Derived from the
// transport's own signature so this file names no second copy of a type that could drift.
type GeminiDb = Parameters<typeof generateGeminiContent>[0];

// A draft, or the reason there is none. A union rather than a nullable draft so the
// caller can report WHY, and so no code path can mistake "nothing" for a draft.
export type NudgeOutcome =
  // A validated draft, safe to store.
  | { readonly ok: true; readonly draft: FollowUpNudgeDraft }
  // Nothing to store; `error` is a short code for the run's failure list.
  | { readonly ok: false; readonly error: string };

// One model call per invocation; never throws.
export async function generateFollowUpNudge(db: GeminiDb, params: BuildPromptParams): Promise<NudgeOutcome> {
  // The fenced prompt pieces, built by the pure, separately testable builder.
  const { systemInstruction, userContent, responseSchema } = buildFollowUpNudgePrompt(params);
  try {
    // Two arguments: the db for key-pool claims, then the prompt in the transport's shape.
    const result = await generateGeminiContent(db, { prompt: { systemInstruction, userContent, responseSchema } });
    // A pool or transport failure is not a draft.
    if (!result.ok) {
      // `detail` can carry upstream bodies, so it stays in the log.
      console.error("[follow-up] gemini failed:", result.reason, result.detail ?? "");
      // Reason plus status plus a detail that is capped and key-redacted, so it is safe to
      // report while still telling one http_error from another.
      return { ok: false, error: formatGeminiFailure(result) };
    }
    // Optional at every hop: a safety-blocked response can omit any of them.
    const draft = parseNudgeReply(result.data.candidates?.[0]?.content?.parts?.[0]?.text);
    // Off-schema: store nothing, retry next run.
    if (draft === null) return { ok: false, error: "reply_not_a_nudge" };
    // Exactly the shape the insert needs.
    return { ok: true, draft };
  } catch (err) {
    // A thrown transport error is logged in full…
    console.error("[follow-up] gemini threw:", err);
    // …and reported as a failure like any other, never a draft.
    return { ok: false, error: `gemini_threw: ${err instanceof Error ? err.message : String(err)}` };
  }
}
