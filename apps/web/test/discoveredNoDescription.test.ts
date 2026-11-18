/* "No description" on a Ready to tailor card (2026-11-18, Teja 21:46 IST: "no jd jobs also need to be in ready to
 * tailor"). The screener now passes a no-description job into the lane instead of holding it at `discovered`, so the
 * card must flag it before Teja sends it through. The flag is derived from description_preview (discoveredList.ts
 * hasNoDescription); the page renders a pill when it is true. Both halves are pinned: the rule by value, and the
 * page's use of it by source shape (apps/web has no DOM renderer, see discoveredLanes.test.ts).
 */

// node:test, the runner every apps/web test uses.
import { test } from 'node:test';
// Strict asserts, so a near-miss is never treated as equal.
import assert from 'node:assert/strict';
// The page is read as text for the shape check.
import { readFileSync } from 'node:fs';
// The rule under test, imported directly: discoveredList.ts has no supabase or React import.
import { hasNoDescription } from '../src/features/discovery/discoveredList.ts';

test('no-description: null, absent, empty and whitespace-only previews all flag the card', () => {
  // Each blank shape the column can come back as.
  for (const preview of [null, undefined, '', '   \n\t']) {
    // Flagged, whatever the blank shape.
    assert.equal(hasNoDescription({ description_preview: preview }), true, `preview ${JSON.stringify(preview)} must flag`);
  }
});

test('no-description: a preview with text does not flag the card', () => {
  // A real excerpt.
  assert.equal(hasNoDescription({ description_preview: 'Build React apps.' }), false);
});

test('no-description: the Discovered page renders the pill from hasNoDescription(job)', () => {
  // The page source, EOL-normalised.
  const page = readFileSync(new URL('../src/features/discovery/DiscoveredJobsPage.tsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  // The pill, gated on the shared rule (not a second, drifting copy of the check), with its visible label.
  assert.match(page, /\{hasNoDescription\(job\) && \(\s*(?:\{?\/\*[\s\S]*?\*\/\}?\s*)*<span className="job-pill job-pill--no-description"[^>]*>\s*No description\s*<\/span>/);
});
