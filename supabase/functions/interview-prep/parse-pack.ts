// SHAPE VALIDATOR FOR GEMINI'S INTERVIEW PREP PACK.
//
// Split out of `index.ts` so it can be tested without Deno, network or a database
// (`node --test` strips the types and runs it directly).
//
// WHY IT EXISTS: the old code did `JSON.parse(text) as Record<string, unknown>` and then
// coerced every field — `String(undefined)` became "", a missing array became `[]` — so a
// truncated or off-schema reply was stored as a real, empty prep pack. Because the runner
// skips any application that already has a pack, that empty pack was permanent.
// Validating the shape and returning null instead means "nothing stored, retry next run".

// The stored pack's shape. Declared here rather than imported so this file has no
// dependencies at all; `index.ts` checks it against `InterviewPrepPack` structurally.
export interface ParsedPrepPack {
  // Free-text company summary; must be non-blank or the pack is not worth showing.
  readonly companyResearchOverview: string;
  // Practice questions; at least one, every entry a non-blank string.
  readonly roleSpecificQuestions: string[];
  // What to emphasise; same rule.
  readonly experienceHighlights: string[];
  // Conversation points; same rule.
  readonly talkingPoints: string[];
}

// A non-empty array of non-blank strings, or null. Rejecting rather than filtering bad
// entries, because a reply with junk inside an array is a reply that did not follow the
// schema, and keeping the good half would hide that.
function stringList(value: unknown): string[] | null {
  // Not an array, or an empty one, is not a usable list.
  if (!Array.isArray(value) || value.length === 0) return null;
  // Every entry must be real text.
  if (!value.every((item) => typeof item === "string" && item.trim().length > 0)) return null;
  // Trimmed copies; the check above guarantees they are strings.
  return value.map((item) => (item as string).trim());
}

// Returns a validated pack, or null when the text is not one. Never throws: a malformed
// reply is an expected outcome of an LLM call, not an exceptional one.
export function parsePrepPack(text: string): ParsedPrepPack | null {
  // Parse inside a try, because JSON.parse throws on any malformed input.
  let parsed: unknown;
  try {
    // The schema-constrained reply should be bare JSON.
    parsed = JSON.parse(text);
  } catch {
    // Not JSON at all.
    return null;
  }
  // Must be a plain object; arrays and primitives are off-schema.
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  // Field access through a record view of the object.
  const record = parsed as Record<string, unknown>;
  // The overview must be real text.
  const overview = record.companyResearchOverview;
  // A blank or missing overview fails the whole pack.
  if (typeof overview !== "string" || overview.trim().length === 0) return null;
  // Each list validated by the same rule.
  const questions = stringList(record.roleSpecificQuestions);
  // Highlights.
  const highlights = stringList(record.experienceHighlights);
  // Talking points.
  const points = stringList(record.talkingPoints);
  // Any missing list fails the whole pack; partial packs are not stored.
  if (questions === null || highlights === null || points === null) return null;
  // Every field present and well-formed.
  return {
    // Trimmed overview.
    companyResearchOverview: overview.trim(),
    // Validated lists.
    roleSpecificQuestions: questions,
    // Validated lists.
    experienceHighlights: highlights,
    // Validated lists.
    talkingPoints: points,
  };
}
