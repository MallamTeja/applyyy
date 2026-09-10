// A deliberately DUMB HTML-to-text reader, standing in for what an ATS parser sees.
//
// ── WHAT THIS IS NOT ──────────────────────────────────────────────────────────────
// This is NOT a model of any real ATS, and it is NOT the ATS parse simulator. That
// belongs to the worker stream (applyyy-ef) and must not be duplicated here — two
// implementations of "what a parser reads" is the same two-spellings-of-one-concept
// drift the shared-types package exists to prevent. When ef's simulator produces real
// extracted text, drop it into `test/fixtures/*.extracted.txt` and the assertions in
// ats-parse.test.ts run against that instead. THE ASSERTIONS ARE THE ASSET HERE; the
// extractor is scaffolding with a documented seam.
//
// ── WHY DELIBERATELY NAIVE IS THE RIGHT CHOICE, NOT A COMPROMISE ─────────────────
// The instinct is to write the smartest extractor possible. That is backwards. The
// failure this guards against is a resume that LOOKS immaculate and parses into
// interleaved gibberish — so the machine never sees the skills and a human never sees
// the resume. That failure is produced by DUMB readers: ones that walk text nodes in
// document order and insert breaks only at block boundaries. A clever extractor that
// reconstructs a multi-column layout correctly would hide exactly the defect worth
// catching.
//
// So this reader does the least defensible thing that any real parser also does:
// concatenate text in document order, break lines only at block-level elements. If the
// rendered resume survives THIS, it survives better readers too — the assertion is a
// lower bound on parse quality, which is the direction that makes it safe.
//
// It is dependency-free and uses no Node API, matching the rest of this package.

/** Block-level tags that force a line break. Everything else is inline and must not. */
const BLOCK_TAGS = [
  'address', 'article', 'aside', 'blockquote', 'br', 'div', 'dd', 'dl', 'dt',
  'fieldset', 'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4',
  'h5', 'h6', 'header', 'hr', 'li', 'main', 'nav', 'ol', 'p', 'pre', 'section',
  'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'ul',
];

/** Minimal entity decoding — only what the renderer's escaper can emit. */
function decodeEntities(text: string): string {
  return (
    text
      // &amp; LAST would double-decode `&amp;lt;` into `<`; doing it last is the bug
      // the escaper's own "escape ampersands exactly once" test guards against, so the
      // reverse operation has to unescape it last for the same reason.
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&amp;/g, '&')
  );
}

/**
 * Read a rendered resume the way a plain text extractor would.
 *
 * Returns the non-empty lines, in document order, trimmed. Blank lines are dropped
 * because whitespace is not what any of the assertions are about, and keeping them
 * would make every fixture brittle against a formatting change that no parser cares
 * about.
 */
export function naiveTextExtract(html: string): string[] {
  return (
    html
      // <head> content is not body text. The stylesheet is inlined into this document,
      // so leaving it in would put every CSS selector into the "extracted text" and
      // make the skills-are-present assertions pass for the wrong reason.
      .replace(/<head[\s\S]*?<\/head>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      // Comments carry no text a parser would read.
      .replace(/<!--[\s\S]*?-->/g, '')
      // COLLAPSE ALL EXISTING WHITESPACE, INCLUDING NEWLINES, BEFORE INSERTING ANY.
      //
      // This line is load-bearing and was missing in the first version of this file.
      // Without it the extractor rode on the renderer's own pretty-printing: the source
      // HTML happens to put elements on separate lines, `split('\n')` picked those up,
      // and the block-boundary rule below contributed almost nothing. Mutation-testing
      // proved it — deleting the block-boundary line entirely left all 8 ATS
      // assertions PASSING, which means they were passing for the wrong reason and
      // would have said nothing about a minified document.
      //
      // It is also the more faithful model. A real parser reads a DOM or a box tree; it
      // has no access to how the author formatted the source, and HTML treats a newline
      // as ordinary whitespace. An extractor that depends on source formatting is
      // measuring the renderer's indentation, not its structure.
      .replace(/\s+/g, ' ')
      // Block boundaries become newlines. This is the ONE piece of layout awareness
      // the extractor has, and it is what makes interleaving detectable: inline
      // elements deliberately do NOT break, so two things rendered side by side land
      // on one line — which is precisely the multi-column failure signature.
      .replace(new RegExp(`</?(?:${BLOCK_TAGS.join('|')})\\b[^>]*>`, 'gi'), '\n')
      // Every remaining tag is inline and contributes no break.
      .replace(/<[^>]+>/g, '')
      .split('\n')
      .map((line) => decodeEntities(line).replace(/\s+/g, ' ').trim())
      .filter((line) => line.length > 0)
  );
}
