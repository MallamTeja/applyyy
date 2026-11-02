// Bucket B's "Hide review" (2026-11-02, Teja: "i dont have hide review button for the first job").
// apps/web has no DOM library, so this pins the SHAPE of the page source, the same way
// approvalBucketMoveFocus.test.ts does: open by default, folded by hand, and kept MOUNTED when
// folded so the AI chat and an unsaved edit survive a fold.
import { readFileSync } from 'node:fs';
// Resolves the page path relative to this test, wherever node --test is run from.
import { fileURLToPath } from 'node:url';
// The repo's test runner and assertions, as in every other web test.
import { describe, it } from 'node:test';
// Strict mode: no loose equality hides a wrong shape.
import assert from 'node:assert/strict';

// The page source under test, read once.
const page = readFileSync(fileURLToPath(new URL('../src/features/approval/ApprovalQueuePage.tsx', import.meta.url)), 'utf8');

// The text between two anchors, failing by name if either is missing (a vacuous slice guards nothing).
function between(start: string, end: string): string {
  // The opening anchor.
  const from = page.indexOf(start);
  // Missing means the code moved; say which anchor, never pass on an empty slice.
  assert.ok(from >= 0, `anchor not found: ${start}`);
  // The closing anchor, searched after the opening one.
  const to = page.indexOf(end, from + start.length);
  // Same for the closing anchor.
  assert.ok(to > from, `anchor not found after start: ${end}`);
  // The slice itself.
  return page.slice(from, to);
}

describe('Bucket B review can be folded, and is open by default', () => {
  // Bucket B's card list, from its map to the end of its list.
  const bucketB = between('{bucketB.map((diff) => {', '</ul>');

  it('starts with nothing folded, so every flagged row opens in front of the operator', () => {
    // An empty set of FOLDED ids is the open-by-default rule; a set of open ids would invert it.
    assert.match(page, /const \[foldedB, setFoldedB\] = useState<ReadonlySet<string>>\(\(\) => new Set\(\)\);/);
  });

  it('has a Hide review / Review disclosure that flips the folded set', () => {
    // The button reports expanded while the review shows.
    assert.match(bucketB, /aria-expanded=\{!isFolded\}/);
    // It names the region it controls.
    assert.match(bucketB, /aria-controls=\{reviewId\}/);
    // Clicking flips this row in the folded set through the page's shared toggle.
    assert.match(bucketB, /onClick=\{\(\) => toggle\(setFoldedB, diff\.applicationId\)\}/);
    // The same words as Bucket A, open and closed.
    assert.match(bucketB, /\{isFolded \? 'Review' : 'Hide review'\}/);
  });

  it('hides the diff with the hidden attribute and keeps it mounted', () => {
    // The wrapper hides; DiffView is its direct child and always rendered.
    assert.match(bucketB, /<div id=\{reviewId\} hidden=\{isFolded\}>\s*<DiffView/);
    // Exactly one DiffView in Bucket B: a second, conditional copy would mean a remount path.
    assert.equal(bucketB.split('<DiffView').length - 1, 1);
  });
});
