// Shape validator for the cover-letter model reply.
//
// WHY THIS EXISTS: the old entrypoint did `let letter = rawText; try { JSON.parse… }
// catch {}`, so a malformed reply — a refusal, a truncated stream, "Sure! Here is…" —
// was STORED AS THE LETTER. And once `cover_letter` is non-null the row leaves the
// queue for good, so a bad reply was permanent. Here, anything that is not exactly
// the shape the prompt's responseSchema asks for becomes null, and null stores nothing.
//
// It asks "is this the shape I expect?", never "did the parser give up?" — JSON.parse
// happily accepts `"text"`, `[]` and `{}`, so a parse that succeeds proves nothing.

// Below this the reply is a fragment, not a 3-4 paragraph letter: the prompt asks
// for 3-4 paragraphs, which no honest letter does in under fifty words.
export const MIN_LETTER_WORDS = 50;

// Returns the trimmed letter, or null for every reply that is not a real letter.
export function parseCoverLetterReply(text: unknown): string | null {
  // The transport can hand back a missing part; only a string can be JSON.
  if (typeof text !== "string") return null;
  // Parsed into `unknown` so every field below is checked, not assumed.
  let parsed: unknown;
  try {
    // The schema-constrained reply is a JSON object.
    parsed = JSON.parse(text);
  } catch {
    // Plain prose is a schema violation, not a letter — the old code's exact bug.
    return null;
  }
  // `[]` and `null` both parse; neither is the object the schema demands.
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  // The one field the response schema requires.
  const letter = (parsed as { coverLetter?: unknown }).coverLetter;
  // A number, an object or a missing key are all off-schema.
  if (typeof letter !== "string") return null;
  // Surrounding whitespace is noise; the database CHECK also refuses a blank letter.
  const trimmed = letter.trim();
  // Word count by whitespace runs; an empty string splits to [""], hence the filter.
  const words = trimmed.split(/\s+/).filter((w) => w.length > 0).length;
  // Too short to be the letter the prompt asked for.
  if (words < MIN_LETTER_WORDS) return null;
  // Exactly the shape expected.
  return trimmed;
}
