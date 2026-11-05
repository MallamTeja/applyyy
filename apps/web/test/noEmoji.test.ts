/* No emoji anywhere in the web app's source (Teja, 2026-11-05: "looks like a vibe-coded app").
 *
 * WHY A TEST, NOT A STYLE NOTE: emoji were removed once already, from SourceBadge (swapped for
 * inline SVG), and ~100 crept back through other pages. Agents writing UI reach for them by
 * default, so only a gate that fails CI keeps them out.
 * WHY THIS CHARACTER CLASS: the Unicode `Extended_Pictographic` property is the set of characters
 * an OS may paint as a colour pictogram, which ignores the theme tokens and differs per machine.
 * U+FE0F is the selector that forces emoji painting onto an otherwise plain symbol.
 * Plain typographic symbols (✓ ✕ → ↑ ↓ ↵ ⌘) are NOT in that property and stay allowed: they take
 * the text colour like any letter. Comments are scanned too, so the guard has no blind spot.
 *
 * WHY IT DECODES FIRST (added 2026-11-05 12:50 IST): the first version tested the raw spelling,
 * so `&harr;` (HealthPage.tsx) shipped U+2194 to prod while the guard stayed green. A browser
 * renders the DECODED text, so the guard now decodes HTML entities (&name; &#NNN; &#xHH;), JS
 * escapes (\uXXXX \u{...} \xHH) and CSS escapes (\2194) before testing (CLAUDE.md §6: check the
 * form the reader sees, never the spelling). Named entities are a CLOSED list: one the list does
 * not know fails the test instead of passing undecoded.
 * WHY A SECOND TEST OVER dist/: the source scan cannot see library code. The prod bundle carried
 * React Router's "Hey developer" default boundary, so the built output is scanned too. */

import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import { it } from 'node:test';
// URL -> OS path, drive letters and percent-escapes included.
import { fileURLToPath } from 'node:url';

// The source root, resolved from this file so the test does not depend on the cwd.
const SRC = new URL('../src/', import.meta.url);
// The built assets, which CI builds (vite build --mode e2e) before it runs these tests.
const DIST_ASSETS = new URL('../dist/assets/', import.meta.url);
// Every kind of file the app ships text from: code, styles and markup.
const EXTENSIONS = new Set(['.ts', '.tsx', '.css', '.html']);
// Pictographs, plus the variation selector that turns a plain symbol into one.
const EMOJI = /[\p{Extended_Pictographic}\u{FE0F}]/u;
// The same class, global, for counting every hit in a bundle rather than the first per line.
const EMOJI_ALL = /[\p{Extended_Pictographic}\u{FE0F}]/gu;

// Every named entity apps/web/src spells today (2026-11-05). Closed on purpose: decode() reports
// any other name, so a new entity is a deliberate one-line addition here, never a silent pass.
// &harr; is listed so it DECODES (to U+2194) and is then caught, rather than reported as unknown.
const NAMED_ENTITIES: Record<string, string> = {
  // Apostrophe, used in JSX text.
  apos: "'",
  // Double quote, used in JSX text.
  quot: '"',
  // Less-than, used in JSX text.
  lt: '<',
  // Greater-than, used in JSX text.
  gt: '>',
  // Right arrow: plain symbol, not Extended_Pictographic, so it stays allowed.
  rarr: '→',
  // Left-right arrow: Extended_Pictographic, so decoding it makes the guard fail.
  harr: '↔',
};

// One code point, or the original text when the number is not a code point at all (a stray
// `\ffffff` in a regex), so a weird spelling can never crash the scan into a false red.
function codePoint(value: number, original: string): string {
  // String.fromCodePoint throws above U+10FFFF.
  return value <= 0x10ffff ? String.fromCodePoint(value) : original;
}

/** The text with every entity and escape decoded; unknown named entities go into `unknown`. */
function decode(text: string, unknown: string[]): string {
  // Built with String.fromCharCode(92), not a typed backslash pair: one less escape layer to misread.
  const bs = String.fromCharCode(92);
  // HTML numeric entities, hex first (&#x2194;) so the decimal rule never sees the x.
  let out = text.replace(/&#[xX]([0-9A-Fa-f]+);/g, (m, hex: string) => codePoint(parseInt(hex, 16), m));
  // HTML numeric entities, decimal (&#8596;).
  out = out.replace(/&#([0-9]+);/g, (m, dec: string) => codePoint(parseInt(dec, 10), m));
  // HTML named entities, from the closed list; anything else is recorded and left as spelled.
  out = out.replace(/&([A-Za-z][A-Za-z0-9]*);/g, (m, name: string) => {
    // Known: decode it, so the emoji test sees what the browser renders.
    if (name in NAMED_ENTITIES) return NAMED_ENTITIES[name]!;
    // Unknown: the caller fails the test with this name.
    unknown.push(m);
    // Left as spelled; the unknown list is what fails.
    return m;
  });
  // JS escapes: \u{1F4BF}, ↔ (a surrogate pair decodes as two halves that rejoin) and \xA9.
  out = out.replace(new RegExp(`${bs}${bs}(?:u\\{([0-9A-Fa-f]+)\\}|u([0-9A-Fa-f]{4})|x([0-9A-Fa-f]{2}))`, 'g'),
    // Exactly one of the three groups matched.
    (m, braced?: string, four?: string, two?: string) =>
      // \u{...} is a whole code point; \uXXXX and \xHH are UTF-16 code units.
      braced !== undefined ? codePoint(parseInt(braced, 16), m) : String.fromCharCode(parseInt((four ?? two)!, 16)));
  // CSS escapes: a backslash, 1-6 hex digits, one optional whitespace terminator (CSS Syntax §4.3.7).
  // Run on every file kind: in TS it can only turn `\b` and friends into control characters,
  // which are never Extended_Pictographic, so it cannot invent a hit.
  return out.replace(new RegExp(`${bs}${bs}([0-9A-Fa-f]{1,6})\\s?`, 'g'), (m, hex: string) => codePoint(parseInt(hex, 16), m));
}

it('apps/web/src contains no emoji (Extended_Pictographic or U+FE0F), however it is spelled', () => {
  // The filesystem path of the source root.
  const root = fileURLToPath(SRC);
  // Every file the guard will read: Node's recursive listing (as inlineConfirm.test.ts uses), kept by extension.
  const files = readdirSync(root, { recursive: true, encoding: 'utf8' })
    // Only the kinds of file the app ships text from.
    .filter((name) => EXTENSIONS.has(extname(name)))
    // Absolute, so the read and the report below need no second join.
    .map((name) => join(root, name));
  // A walk that found nothing would pass vacuously; this repo has well over 100 source files.
  assert.ok(files.length > 100, `scanned only ${files.length} files under ${root}`);
  // Named entities the closed list does not know, as "path:line: &name;".
  const unknownEntities: string[] = [];
  // Every offending line, as "path:line: text", so the failure says exactly what to fix.
  const hits = files.flatMap((file) =>
    // Line numbers are 1-based to match editors.
    readFileSync(file, 'utf8').split(/\r?\n/).flatMap((line, i) => {
      // Where this line lives, for both reports.
      const where = `${relative(root, file)}:${i + 1}`;
      // This line's unknown entities, collected by decode().
      const unknown: string[] = [];
      // The text as the browser would render it.
      const decoded = decode(line, unknown);
      // Each unknown entity is reported with its location.
      for (const name of unknown) unknownEntities.push(`${where}: ${name}`);
      // Only lines whose DECODED text carries an emoji are reported; the raw line is shown so it can be found.
      return EMOJI.test(decoded) ? [`${where}: ${line.trim().slice(0, 100)}`] : [];
    }));
  // An entity outside the closed list was not decoded, so it was not really checked.
  assert.deepEqual(unknownEntities, [], `unknown HTML entity (add it to NAMED_ENTITIES or spell it plainly):\n${unknownEntities.join('\n')}`);
  // Empty means clean; otherwise list every hit.
  assert.deepEqual(hits, [], `emoji found:\n${hits.join('\n')}`);
});

// React Router's DefaultErrorComponent text (react-router 7.18.4, dist/production chunk, line
// 6208). It ships in the bundle but can never render here, for two independent reasons:
// (1) App.tsx uses <BrowserRouter>, a NON-data router, so _renderMatches has no dataRouterState
// and never wraps a route in RenderErrorBoundary or picks defaultErrorElement; (2) the text sits
// behind ENABLE_DEV_WARNINGS, which is `false` in the production chunk. Reason (1) is asserted
// below: switching to a data router revokes this allowlist and fails the test.
const UNREACHABLE_LIBRARY_TEXT = '\u{1F4BF} Hey developer \u{1F44B}';
// The data-router APIs whose use would make that default boundary reachable.
const DATA_ROUTER_APIS = /\b(?:createBrowserRouter|createHashRouter|createMemoryRouter|createStaticRouter|RouterProvider)\b/;

it('the built bundle (dist/assets) contains no emoji except React Router\'s unreachable default boundary', () => {
  // The assets folder of the last build.
  const assets = fileURLToPath(DIST_ASSETS);
  // No build means nothing was checked; fail with the fix rather than pass vacuously (e2eSuite does the same).
  assert.ok(existsSync(assets), `${assets} does not exist. Build it: cd apps/web && ./node_modules/.bin/vite build --mode e2e`);
  // The shipped JS and CSS; source maps are not served to the page, so they are skipped.
  const files = readdirSync(assets).filter((name) => ['.js', '.css'].includes(extname(name)));
  // A bundle without JS is not a build of this app.
  assert.ok(files.some((name) => name.endsWith('.js')), `no .js file in ${assets}`);
  // The allowlist holds only while the app has no data router; prove that from the source.
  const srcRoot = fileURLToPath(SRC);
  // Every source file that names a data-router API.
  const dataRouterFiles = readdirSync(srcRoot, { recursive: true, encoding: 'utf8' })
    // Code only; styles and markup cannot create a router.
    .filter((name) => ['.ts', '.tsx'].includes(extname(name)))
    // Kept when the file names one of the APIs.
    .filter((name) => DATA_ROUTER_APIS.test(readFileSync(join(srcRoot, name), 'utf8')));
  // A data router makes the default boundary reachable: give the root route errorElement
  // (app/ErrorBoundary) and delete UNREACHABLE_LIBRARY_TEXT instead of keeping the allowlist.
  assert.deepEqual(dataRouterFiles, [], 'a data router is in use, so React Router\'s default boundary is reachable; set errorElement and drop the allowlist');
  // Every pictograph left after the allowlisted text is removed, as "file@offset: context".
  const hits = files.flatMap((name) => {
    // RAW, not decode()d: Vite's esbuild emits string literals as literal UTF-8 (React Router's
    // "\u{1F4BF}" source ships as the character itself), so every painted string carries its
    // character. The escapes left in a bundle are regex sources, e.g. master-pdf's bullet class
    // (packages/master-pdf/src/extract.ts:82, ▪), which strips text and never paints it.
    const raw = readFileSync(join(assets, name), 'utf8');
    // The one allowlisted string removed, every occurrence of it.
    const remaining = raw.split(UNREACHABLE_LIBRARY_TEXT).join('');
    // Each remaining hit with 30 characters each side, so the source can be grepped.
    return [...remaining.matchAll(EMOJI_ALL)].map((m) => `${name}@${m.index}: ${remaining.slice(Math.max(0, m.index - 30), m.index + 30)}`);
  });
  // Empty means the shipped page paints no emoji.
  assert.deepEqual(hits, [], `emoji in the built bundle:\n${hits.join('\n')}`);
});
