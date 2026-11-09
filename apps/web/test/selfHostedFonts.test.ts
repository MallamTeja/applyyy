/* Fonts are self-hosted and off the critical path (2026-11-09).
 *
 * WHY. index.html loaded Inter / IBM Plex from fonts.googleapis.com as a render-blocking stylesheet placed
 * before the module script, so every page's JS waited a third-party round trip (~180 ms measured) first.
 * The fonts now ship from /fonts on our own origin with font-display: swap, and the CSP allows only that.
 *
 * WHAT IT PINS, each as the POSITIVE shape (CLAUDE.md §6: a "must not mention googleapis" check would fire on
 * the comments that document the change, and passes vacuously on a renamed host):
 *   1. every <link> in index.html is same-origin, and the one preload is the Inter latin file, as a font, CORS;
 *   2. every @font-face in tokens.css uses font-display: swap and a /fonts/*.woff2 that exists and IS woff2,
 *      and the three --font-* families each have faces (counted, so an empty match can't pass);
 *   3. the CSP's font-src is exactly 'self' and style-src names no remote origin: a local gate cannot see the
 *      CSP (the test server sends none), so without this a prod-only block would ship green;
 *   4. every inline <script> in index.html still hashes to a sha256 the CSP's script-src lists (an index.html
 *      edit that touched one would silently stop it running in prod);
 *   5. the OFL licence texts ship beside the files, as the licence requires.
 * RED-ON-REVERT: index.html, tokens.css and vercel.json from 7fcc6ed fail 1, 2 and 3. */

// Strict asserts.
import assert from 'node:assert/strict';
// The CSP's script hashes are sha256 of each inline script's exact text.
import { createHash } from 'node:crypto';
// Files are read as text or bytes; existence is checked without throwing.
import { existsSync, readFileSync } from 'node:fs';
// The runner.
import { describe, it } from 'node:test';

// The page shell Vite serves and builds from.
const indexHtml = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
// The stylesheet that declares the --font-* tokens and the @font-face rules.
const tokensCss = readFileSync(new URL('../src/styles/tokens.css', import.meta.url), 'utf8');
// The ONLY vercel.json (root), where the production CSP header is set.
const vercel = JSON.parse(readFileSync(new URL('../../../vercel.json', import.meta.url), 'utf8')) as { headers?: { headers?: { key: string; value: string }[] }[] };
// Where Vite copies public/ from; the font URLs resolve here.
const publicDir = new URL('../public/', import.meta.url);

// The CSP value, found by key so a reordered header list still resolves.
const csp = (vercel.headers ?? []).flatMap((rule) => rule.headers ?? []).find((header) => header.key === 'Content-Security-Policy')?.value;
/* One CSP directive's source tokens, or undefined when the directive is absent (absent is NOT "allowed nothing":
   font-src would then fall back to default-src). */
function directive(name: string): string[] | undefined {
  // The directive's own clause, e.g. "font-src 'self'".
  const clause = (csp ?? '').split(';').map((part) => part.trim()).find((part) => part.split(/\s+/)[0] === name);
  // Its sources, without the name.
  return clause === undefined ? undefined : clause.split(/\s+/).slice(1);
}

// Every @font-face block's body, in file order.
const faces = [...tokensCss.matchAll(/@font-face\s*\{([^}]*)\}/g)].map((match) => match[1] ?? '');

describe('self-hosted fonts (2026-11-09)', () => {
  it('1. index.html links only to its own origin, and preloads the Inter latin face as a CORS font', () => {
    // Every <link ...> tag, attributes and all.
    const links = [...indexHtml.matchAll(/<link\b[^>]*>/g)].map((match) => match[0]);
    // At least the icon and the preload: an empty match must not pass.
    assert.ok(links.length >= 2, `expected at least 2 <link> tags, found ${links.length}`);
    /* Each href is a same-origin absolute path or an inline data: URI (the favicon), both of which need no other
       host; a remote stylesheet here blocks the module script below it. */
    for (const link of links) assert.match(link, /href="(\/[^/]|data:)/, `not a same-origin href: ${link.slice(0, 120)}`);
    // The preloads, by rel.
    const preloads = links.filter((link) => /rel="preload"/.test(link));
    // Exactly the one face the first paint needs; more would compete with the app's own JS for bandwidth.
    assert.equal(preloads.length, 1, `expected exactly 1 preload, found ${preloads.length}`);
    // The Inter latin file, as a font, typed, and CORS (without crossorigin the browser fetches it twice).
    assert.match(preloads[0]!, /href="\/fonts\/Inter-400-700-latin\.woff2"/);
    // Same.
    assert.match(preloads[0]!, /as="font"/);
    // Same.
    assert.match(preloads[0]!, /type="font\/woff2"/);
    // Same.
    assert.match(preloads[0]!, /\bcrossorigin\b/);
  });

  it('2. every @font-face swaps and points at a real woff2 under /fonts; all three families are served', () => {
    // 3 Plex Mono + 3 Plex Serif + 1 Inter, each in latin and latin-ext.
    assert.equal(faces.length, 14, `expected 14 @font-face rules, found ${faces.length}`);
    // The families the faces serve.
    const families = new Set<string>();
    // Each face checked on its own, so a failure names the file.
    for (const face of faces) {
      // Text paints at once in the fallback stack; nothing waits on a font file.
      assert.match(face, /font-display:\s*swap;/, `no font-display: swap in: ${face.slice(0, 80)}`);
      // The one source, a same-origin path.
      const src = /src:\s*url\('\/fonts\/([A-Za-z0-9-]+\.woff2)'\)\s*format\('woff2'\)/.exec(face);
      // A face without that exact shape is a remote or malformed source.
      assert.ok(src, `src is not url('/fonts/<file>.woff2') format('woff2'): ${face.slice(0, 120)}`);
      // The file Vite will copy to dist/fonts.
      const file = new URL(`fonts/${src[1]}`, publicDir);
      // Present in the repo.
      assert.ok(existsSync(file), `missing public/fonts/${src[1]}`);
      // And really woff2: the format's 4-byte signature, not an HTML error page saved under the name.
      assert.equal(readFileSync(file).subarray(0, 4).toString('latin1'), 'wOF2', `${src[1]} is not woff2`);
      // Collected for the family check below.
      families.add(/font-family:\s*'([^']+)'/.exec(face)?.[1] ?? '');
    }
    // The first family named by each --font-* token; each must be one the faces serve.
    for (const token of ['--font-machine', '--font-paper', '--font-id']) {
      // e.g. "--font-machine: 'Inter', system-ui, ..." → Inter.
      const lead = new RegExp(`${token}:\\s*'([^']+)'`).exec(tokensCss)?.[1];
      // A token that stopped leading with a quoted family would silently skip the check.
      assert.ok(lead, `${token} does not lead with a quoted family`);
      // Served, so the token never falls through to a system font for want of a face.
      assert.ok(families.has(lead), `${token} leads with '${lead}', which no @font-face serves`);
    }
  });

  it("3. the production CSP allows fonts from 'self' only, and styles from no remote origin", () => {
    // The header exists at all.
    assert.ok(csp, 'vercel.json has no Content-Security-Policy header');
    // Exactly 'self': the /fonts files load, and no third-party font host is allowed.
    assert.deepEqual(directive('font-src'), ["'self'"]);
    // The stylesheet sources.
    const styleSrc = directive('style-src');
    // Present (absent would fall back to default-src and still pass by accident).
    assert.ok(styleSrc, 'the CSP has no style-src');
    // Only keyword sources ('self', 'unsafe-inline'), no host.
    for (const source of styleSrc) assert.match(source, /^'[a-z-]+'$/, `style-src names a remote source: ${source}`);
  });

  it("4. every inline <script> in index.html hashes to a sha256 the CSP's script-src lists", () => {
    // Inline scripts only: a src= script is covered by 'self'.
    const inline = [...indexHtml.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1] ?? '');
    // The theme bootstrap at least; zero would mean the regex missed, not that there are none.
    assert.ok(inline.length >= 1, 'no inline <script> found in index.html');
    // The allowed hashes.
    const scriptSrc = directive('script-src') ?? [];
    // Each script's exact text, hashed the way the browser does.
    for (const body of inline) {
      /* base64 sha256 of the UTF-8 text between the tags, with CRLF folded to LF: the HTML parser normalises
         newlines before the browser hashes, and a Windows working copy is CRLF while the deployed file is LF. */
      const hash = `'sha256-${createHash('sha256').update(body.replace(/\r\n?/g, '\n'), 'utf8').digest('base64')}'`;
      // Listed, or the browser refuses to run it in prod.
      assert.ok(scriptSrc.includes(hash), `inline script ${hash} is not in script-src`);
    }
  });

  it('5. the SIL OFL licence texts ship beside the font files', () => {
    // One per font project; OFL 1.1 requires the licence to accompany redistributed fonts.
    for (const name of ['Inter-OFL.txt', 'IBMPlex-OFL.txt']) {
      // The file Vite copies next to the fonts.
      const file = new URL(`fonts/${name}`, publicDir);
      // Present.
      assert.ok(existsSync(file), `missing public/fonts/${name}`);
      // And the actual licence, not a placeholder.
      assert.match(readFileSync(file, 'utf8'), /SIL OPEN FONT LICENSE/i);
    }
  });
});
