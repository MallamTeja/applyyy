/* No emoji anywhere in the web app's source (Teja, 2026-11-05: "looks like a vibe-coded app").
 *
 * WHY A TEST, NOT A STYLE NOTE: emoji were removed once already, from SourceBadge (swapped for
 * inline SVG), and ~100 crept back through other pages. Agents writing UI reach for them by
 * default, so only a gate that fails CI keeps them out.
 * WHY THIS CHARACTER CLASS: the Unicode `Extended_Pictographic` property is the set of characters
 * an OS may paint as a colour pictogram, which ignores the theme tokens and differs per machine.
 * U+FE0F is the selector that forces emoji painting onto an otherwise plain symbol.
 * Plain typographic symbols (✓ ✕ → ↑ ↓ ↵ ⌘) are NOT in that property and stay allowed: they take
 * the text colour like any letter. Comments are scanned too, so the guard has no blind spot. */

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import { it } from 'node:test';
// URL -> OS path, drive letters and percent-escapes included.
import { fileURLToPath } from 'node:url';

// The source root, resolved from this file so the test does not depend on the cwd.
const SRC = new URL('../src/', import.meta.url);
// Every kind of file the app ships text from: code, styles and markup.
const EXTENSIONS = new Set(['.ts', '.tsx', '.css', '.html']);
// Pictographs, plus the variation selector that turns a plain symbol into one.
const EMOJI = /[\p{Extended_Pictographic}\u{FE0F}]/u;

it('apps/web/src contains no emoji (Extended_Pictographic or U+FE0F)', () => {
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
  // Every offending line, as "path:line: text", so the failure says exactly what to fix.
  const hits = files.flatMap((file) =>
    // Line numbers are 1-based to match editors.
    readFileSync(file, 'utf8').split(/\r?\n/).flatMap((line, i) =>
      // Only lines carrying an emoji are reported, trimmed so the message stays readable.
      EMOJI.test(line) ? [`${relative(root, file)}:${i + 1}: ${line.trim().slice(0, 100)}`] : []));
  // Empty means clean; otherwise list every hit.
  assert.deepEqual(hits, [], `emoji found:\n${hits.join('\n')}`);
});
