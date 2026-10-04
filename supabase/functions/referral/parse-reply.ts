// Shape validator for the referral model reply.
//
// WHY: the old code did `JSON.parse(text) as Record<string, string>` and then filled any
// missing field with a default (`body: parsed.body ?? ""`). So `{}` became a stored
// draft with an empty body, and a non-JSON reply threw into a catch that stored the
// template. Both were permanent, because a drafted application is never re-drafted.
// Here, anything but the exact schema shape is null, and null stores nothing.

// The four fields the prompt's responseSchema requires, all model-written text.
export interface ReferralReply {
  // Who to approach (peer engineer, manager, recruiter).
  readonly recipientRole: string;
  // The message subject line.
  readonly subject: string;
  // The message itself.
  readonly body: string;
  // Delivery advice for the candidate.
  readonly notes: string;
}

// Returns the four trimmed fields, or null for every reply that is not exactly that.
export function parseReferralReply(text: unknown): ReferralReply | null {
  // A missing text part from the transport is not a reply.
  if (typeof text !== "string") return null;
  // `unknown`, so every field below is checked rather than assumed.
  let parsed: unknown;
  try {
    // The schema-constrained reply is a JSON object.
    parsed = JSON.parse(text);
  } catch {
    // Prose is a schema violation, not a draft.
    return null;
  }
  // `null` and `[]` both parse and neither is the object the schema demands.
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  // Narrowed once for the field reads.
  const record = parsed as Record<string, unknown>;
  // Each required field must be a non-blank string — no defaults, ever.
  const fields = ["recipientRole", "subject", "body", "notes"] as const;
  // Collected trimmed, so stored text has no stray whitespace.
  const out: Record<string, string> = {};
  // One rule for all four fields.
  for (const field of fields) {
    // The raw value.
    const value = record[field];
    // Missing, non-string or blank: the reply is off-schema.
    if (typeof value !== "string" || value.trim().length === 0) return null;
    // Keep it.
    out[field] = value.trim();
  }
  // Exactly the expected shape.
  return out as unknown as ReferralReply;
}
