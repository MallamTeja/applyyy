/* jdPlainText: a job description as readable plain text (2026-11-07).
 *
 * WHY THIS EXISTS. jobs.description_raw holds whatever the ATS returned: plain text, HTML, or
 * entity-escaped HTML ("&lt;p&gt;..."). The Discovered page printed it raw, so the card and the
 * full-JD modal showed markup (Teja's Circuithub sample). A server-side backfill of clean text is
 * planned; until it lands, the web converts at display time.
 *
 * WHY NO DOMParser / innerHTML. The output is rendered as a React text node, so it can never execute,
 * and a pure string function runs in the plain-Node unit tests, which have no DOM. */

// "Looks like markup": an opening/closing tag that starts with a letter, or a comment / doctype.
// Requiring a letter after "<" keeps plain-text maths like "a < b" from being treated as HTML.
const MARKUP = /<\/?[a-z][^>]*>|<!/i;

// The named entities scraped postings actually use; anything else is left as written, never guessed.
const NAMED: Record<string, string> = {
  // The escape for "&" itself, decoded last-in-effect by the single regex pass below.
  amp: '&',
  // Escaped "<", the marker of the double-escaped case.
  lt: '<',
  // Escaped ">", its partner.
  gt: '>',
  // Escaped double quote, common inside attribute-heavy ATS HTML.
  quot: '"',
  // Escaped apostrophe (XHTML / HTML5 spelling).
  apos: "'",
  // Non-breaking space; the whitespace tidy below turns it into an ordinary space.
  nbsp: ' ',
};

// Decode one level of entities. One regex pass, so a doubly escaped less-than decodes to a singly escaped
// one and NOT to "<" (the test file pins the exact strings; the emoji guard forbids spelling them here).
function decodeEntities(text: string): string {
  // Match a named, decimal or hex entity; the trailing ";" is required so "R&D" is not touched.
  return text.replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (whole, body: string) => {
    // A numeric entity: decimal (#39) or hex (#x2019).
    if (body[0] === '#') {
      // Hex when the second char is x/X, otherwise decimal.
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      // An out-of-range code point would make fromCodePoint throw; keep the text as written instead.
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    // A named entity: decode the known ones (case-sensitive per HTML), leave unknown ones visible.
    return NAMED[body] ?? whole;
  });
}

// Strip one level of tags, turning block structure into line breaks.
// collapseSource: HTML source whitespace (indentation, newlines between tags) is insignificant, so it
// is folded to single spaces BEFORE the tags add the meaningful breaks. It is false only when an
// earlier pass already produced those breaks, which a second fold would erase.
function stripTags(html: string, collapseSource: boolean): string {
  // Script/style bodies are code, not description text; drop them together with their tags.
  let text = html.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '');
  // Comments carry no reader-facing text.
  text = text.replace(/<!--[\s\S]*?-->/g, '');
  // Fold source whitespace only on the pass that sees the original source.
  if (collapseSource) text = text.replace(/\s+/g, ' ');
  // A <br> is a single line break.
  text = text.replace(/<br\b[^>]*>/gi, '\n');
  // A list item starts its own line; its closing tag adds nothing, so items do not double-space.
  text = text.replace(/<li\b[^>]*>/gi, '\n');
  // Block elements open and close paragraphs; the tidy step folds any pile-up to one blank line.
  text = text.replace(/<\/?(?:p|div|h[1-6]|ul|ol|section|article|blockquote|table|tr|header|footer)\b[^>]*>/gi, '\n\n');
  // Every other tag (span, strong, a, </li>, ...) is formatting only: remove it.
  return text.replace(/<[^>]*>/g, '');
}

/** Plain, readable text for a job description; "" for a missing one. Render it as a text node. */
export function jdPlainText(raw: string | null): string {
  // A missing description renders as nothing, never as "null".
  if (raw == null) return '';
  // Windows / old-Mac line endings become "\n" so the tidy step sees one kind of break.
  let text = raw.replace(/\r\n?/g, '\n');
  // Pass 1: real markup in the stored value. Plain text skips this, so its own newlines survive.
  const firstHadMarkup = MARKUP.test(text);
  // Strip pass-1 tags, folding the HTML source whitespace.
  if (firstHadMarkup) text = stripTags(text, true);
  // Decode one level of entities, which reveals the tags of an entity-escaped description.
  text = decodeEntities(text);
  // Pass 2 (bounded: there is no third): the decode revealed markup, so the value was escaped HTML.
  // Fold source whitespace only if pass 1 did not already turn structure into breaks.
  if (MARKUP.test(text)) text = decodeEntities(stripTags(text, !firstHadMarkup));
  // Tidy: any non-newline whitespace run (incl. the decoded nbsp) becomes one space.
  text = text.replace(/[^\S\n]+/g, ' ');
  // Trim each line, so a break never leaves a leading or trailing space behind.
  text = text.replace(/ ?\n ?/g, '\n');
  // Three or more breaks are a pile-up of block tags; one blank line is the paragraph break.
  text = text.replace(/\n{3,}/g, '\n\n');
  // Leading/trailing breaks from the first and last block tags carry no meaning.
  return text.trim();
}
