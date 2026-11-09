// option-match: finds the form's OWN option text for a bank answer that differs from it only in
// case, whitespace or separator punctuation ("india" -> "India", "yes" -> "Yes").
//
// WHY THIS FILE EXISTS. The live answer bank stores answers as Teja typed them (lowercase, free
// words), while a select or radio only accepts one of its own option strings. The planner and the
// filler both demand an EXACT option, so 9-10 answers per Canonical form parked the row at fill
// even though the answer and the option are the same statement.
//
// WHAT IT WILL NOT DO (CLAUDE.md §6: a permissive reader is the fail-open). No edit distance, no
// "contains", no prefix, no synonyms or abbreviations: "Yes" must never pick "Yes, I require
// sponsorship", "india" must never pick "Indian" or "Indiana", "10" must never pick "10+". Only
// whole-string equality after normalization counts, and a tie between two options is ambiguous.
// The caller parks the row on anything but exact/normalized, exactly as it does today.

// The result is a closed union: a picked option exists ONLY on the two success kinds, so a caller
// cannot read an option out of an ambiguous or missing match.
export type OptionMatch =
  // The answer is already one of the options, character for character (today's only accepted case).
  | { kind: 'exact'; option: string }
  // Exactly one option equals the answer after normalization; `option` is the form's own text.
  | { kind: 'normalized'; option: string }
  // Two or more options normalize to the answer: which one Teja meant is unknowable.
  | { kind: 'ambiguous' }
  // No option is the same text (or the answer is blank): Teja answers it.
  | { kind: 'none' };

// Case, width and separator noise only. Every character that can carry meaning ("+", "%", "&", "<",
// digits, letters) survives, so two strings that normalize equal still say the same thing.
function normalize(text: string): string {
  return (
    text
      // NFKC folds full-width letters and ligatures to their plain forms, which a pasted answer can carry.
      .normalize('NFKC')
      // Case never changes the statement ("india" is "India").
      .toLowerCase()
      // Apostrophes and periods are dropped, not spaced: "Bachelor's" is "bachelors", "U.S." is "us".
      .replace(/['‘’`.]/g, '')
      // Hyphens, dashes, slashes, commas, underscores and brackets separate words: "Guinea-Bissau" is "guinea bissau".
      .replace(/[-‐-―_/,()]/g, ' ')
      // Any run of whitespace is one space, so "Latino " and " Latino" match "latino".
      .replace(/\s+/g, ' ')
      // Leading and trailing whitespace is never part of the answer.
      .trim()
  );
}

// Picks the one option that is the same text as `answer`, or says why there isn't one.
export function matchOption(answer: string, options: readonly string[]): OptionMatch {
  // A blank answer is no answer, even when a blank placeholder option ("Select...") exists.
  const key = normalize(answer);
  // Checked before the exact step so '' can never "exactly" match an empty option.
  if (key === '') return { kind: 'none' };
  // Exact first: an answer that already matches keeps today's behaviour unchanged.
  if (options.includes(answer)) return { kind: 'exact', option: answer };
  // Every option equal to the answer after normalization (never a substring or prefix).
  const hits = options.filter((option) => normalize(option) === key);
  // Exactly one: return the FORM's text, so the filler's exact check finds it.
  if (hits.length === 1) return { kind: 'normalized', option: hits[0]! };
  // Several: fail closed rather than pick one Teja may not have meant.
  return hits.length === 0 ? { kind: 'none' } : { kind: 'ambiguous' };
}
