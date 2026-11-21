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

test('no-description: a preview with real role text does not flag the card (Zeta 4eb08982, 128 chars, verbatim)', () => {
  // The shortest real JD live: one genuine duty line. Over 100 chars of role text, so never flagged.
  assert.equal(hasNoDescription({ description_preview: "Equity and SBC accounting and reporting for every quarter, preparing Cap Labor details and assisting in Direct Taxes calclations" }), false);
});

// THIN = NO DESCRIPTION (round 4, 2026-11-21): the card and the screener call the same jd-substance.ts rule.
test('no-description: a boilerplate-only preview flags the card (Fractal 002b1d10, verbatim)', () => {
  // The Workday tenant wrapper that passed with no role text; under 600 chars, so the preview is the whole JD.
  assert.equal(hasNoDescription({ description_preview: "It's fun to work in a company where people truly BELIEVE in what they are doing!\n\nWe're committed to bringing passion and customer focus to the business.\n\nIf you like wild growth and working with happy, enthusiastic over-achievers, you'll enjoy your career with us!\n\nNot the right fit?  Let us know you're interested in a future opportunity by clicking Introduce Yourself in the top-right corner of the page or create an account to set up email alerts as new job postings become available that meet your interest!" }), true);
});

test('no-description: a short excerpt with too little role text flags the card', () => {
  // 17 chars: a stub, not a description (it was the old "has text" fixture).
  assert.equal(hasNoDescription({ description_preview: 'Build React apps.' }), true);
});

test('no-description: the Discovered page renders the pill from hasNoDescription(job)', () => {
  // The page source, EOL-normalised.
  const page = readFileSync(new URL('../src/features/discovery/DiscoveredJobsPage.tsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  // The pill, gated on the shared rule (not a second, drifting copy of the check), with its visible label.
  assert.match(page, /\{hasNoDescription\(job\) && \(\s*(?:\{?\/\*[\s\S]*?\*\/\}?\s*)*<span className="job-pill job-pill--no-description"[^>]*>\s*No description\s*<\/span>/);
});
