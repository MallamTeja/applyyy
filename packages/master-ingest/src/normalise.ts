/* Turning resume text into something two uploads can be compared on.
 *
 * TWO NORMALISATIONS, NOT ONE, AND THE DIFFERENCE IS LOAD-BEARING.
 *
 * `normaliseKey` is for identity: a skill name, a company, a degree. It fixes
 * only the things a PDF pipeline changes by accident — Unicode form, case,
 * typographic quotes and dashes, stray whitespace — and PRESERVES symbols.
 * `tokenise` is for similarity: it throws symbols away, because in a sentence a
 * `+` carries no identity.
 *
 * WHY THEY CANNOT BE THE SAME FUNCTION. Strip punctuation from a skill name and
 * `C`, `C++` and `C#` all normalise to `c`. Three genuinely different skills
 * then collide on one match key, the key becomes ambiguous, all three refuse to
 * carry, and every pinned application that referenced any of them breaks — on
 * an upload where Teja changed nothing. A punctuation-stripping key is the kind
 * of simplification that looks harmless and costs the ids it was meant to keep.
 *
 * NO STEMMING AND NO STOPWORD LIST, DELIBERATELY. Both are extra silent knobs,
 * and a stopword list does not even buy what it appears to: `Built the auth
 * service` vs `Built the billing service` scores 0.75 with stopwords in and
 * 0.667 with them out — over threshold either way. The words are not what
 * separates those two bullets, so removing words is not the defence. The defence
 * is that a human sees every non-exact match. See `similarity.ts`.
 *
 * NO NODE APIs IN THIS FILE, or anywhere under src/. This package has to import
 * cleanly into a Deno Edge Function, the Node worker and the browser, so a
 * `node:` builtin here would break two of the three at runtime rather than at
 * compile time.
 */

/* Characters a PDF or a word processor substitutes for their ASCII equivalents
 * without anyone asking. Overleaf emits en/em dashes and curly quotes from
 * plain typing, so the SAME bullet re-exported from a slightly different
 * template arrives with different bytes and the same meaning. Folding these is
 * what stops that being mistaken for an edit. */
const TYPOGRAPHIC_FOLDS: readonly (readonly [RegExp, string])[] = [
  /* Curly single quotes and the prime, all of which stand in for an apostrophe
     in possessives — `Teja's` must equal `Teja's`. */
  [/[\u2018\u2019\u201A\u201B\u2032]/gu, "'"],
  /* Curly double quotes and the double prime. */
  [/[\u201C\u201D\u201E\u201F\u2033]/gu, '"'],
  /* En dash, em dash, figure dash, minus sign and non-breaking hyphen. A date
     range written `2024–2025` and `2024-2025` is the same range. */
  [/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/gu, '-'],
  /* Non-breaking and narrow spaces, which LaTeX inserts around units and which
     are invisible in every editor. Folded to a plain space so the whitespace
     collapse below can see them. */
  [/[\u00A0\u2007\u202F\u2009\u200A]/gu, ' '],
  /* SOFT HYPHEN. A justified LaTeX paragraph carries these as legitimate
     "you may break the word here" markers, and they are invisible in every
     editor. Removed entirely rather than folded to a space, because they sit
     INSIDE a word. */
  [/\u00AD/gu, ''],
  /* Zero-width characters: a PDF text layer can carry these mid-word, so
     without this fold a token silently fails to equal its own twin. They fold
     to nothing rather than to a space — a zero-width joiner inside a word must
     not split it into two tokens. */
  [/[\u200B\u200C\u200D\u2060\uFEFF]/gu, ''],
];

/* Identity normalisation. Use this for anything that acts as a MATCH KEY.
 *
 * NFKC rather than NFC: it also folds compatibility forms, so a ligature or a
 * full-width character extracted from a PDF equals the plain text a human
 * typed. Case folding is `toLowerCase` on the already-normalised string,
 * because normalising after lowercasing can leave a form NFKC would have
 * changed. */
export function normaliseKey(raw: string): string {
  /* Start from the composed form so every later comparison is byte-comparable. */
  let value = raw.normalize('NFKC');
  /* Fold the substitutions a document pipeline makes on its own. Applied before
     the whitespace collapse because two of the folds PRODUCE whitespace. */
  for (const [pattern, replacement] of TYPOGRAPHIC_FOLDS) {
    value = value.replace(pattern, replacement);
  }
  /* Case is never identity on a resume: `PostgreSQL` and `postgresql` are one
     skill, and a PDF extractor may not preserve the capitalisation. */
  value = value.toLowerCase();
  /* Any run of whitespace becomes one space. A PDF line-wrap inside a company
     name arrives as a newline or a double space and means nothing. */
  value = value.replace(/\s+/gu, ' ');
  /* THE LINE-WRAP HYPHEN, and this fold is the one that protects node ids.
     MEASURED IN TEJA'S REAL RESUME (2026-09-10): the document is justified
     LaTeX and hyphenates across line breaks in six places -- `Expe-/rienced`,
     `intel-/ligence`, `Post-/greSQL`, `busi-/ness`, `opti-/mization`,
     `evalua-/tion`. Once those lines are joined, the bullet text contains
     `expe- rienced`.

     WHY THAT IS AN ID PROBLEM RATHER THAN A COSMETIC ONE. Where LaTeX chooses
     to break a line depends on every word BEFORE the break. So editing one
     early word in a bullet moves the wrap, which moves the hyphen, which
     changes the token set of text Teja did not touch. The similarity score
     drops for a reason invisible in the document, the bullet fails to match
     itself, its id churns, and every pinned application referencing it dangles
     -- with nothing anywhere reporting a problem.

     The pattern requires a LETTER before the hyphen and whitespace after it, so
     `event-driven` (no space) and ` - ` used as a separator (whitespace before)
     are both untouched. It does mangle a rare construction like `pre- and
     post-processing` into `preand post-processing`, and that cost is accepted
     for a reason worth internalising: NORMALISATION ONLY HAS TO BE CONSISTENT,
     NOT LINGUISTICALLY CORRECT. Both sides of every comparison pass through
     this same function, so a deterministic mangling cannot change which bullet
     matches which -- whereas a moved line-wrap can. */
  value = value.replace(/(\p{L})-\s+(\p{L})/gu, '$1$2');
  /* Leading and trailing whitespace is pure noise from a text layer. */
  return value.trim();
}

/* Similarity tokenisation. Use this for BULLET TEXT only.
 *
 * Splits on everything that is not a letter or a number, which is what makes
 * `40%` and `40` the same token and `latency,` and `latency` the same token —
 * both differences a rewording produces constantly and neither of which changes
 * the claim. Numbers are KEPT, and that is the important half: the numbers in a
 * bullet are the part a fact-check turns on, so they must weigh in the score
 * rather than being discarded as noise. */
export function tokenise(raw: string): readonly string[] {
  /* Reuse the identity normalisation first, so a curly apostrophe does not
     produce a different token split from a straight one. */
  const normalised = normaliseKey(raw);
  /* \p{L} and \p{N} with the u flag rather than \w: \w is ASCII-only, so a
     name with an accent would be split into fragments and stop matching itself. */
  return normalised.split(/[^\p{L}\p{N}]+/u).filter((token) => token.length > 0);
}

/* The token SET, which is what a Dice coefficient is computed over.
 *
 * A set, not a list: repetition is not evidence. A bullet that says `service`
 * twice is not twice as much about services, and counting it twice would let a
 * repeated filler word carry a match on its own. */
export function tokenSet(raw: string): ReadonlySet<string> {
  return new Set(tokenise(raw));
}
