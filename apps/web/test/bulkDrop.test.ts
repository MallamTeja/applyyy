/* Approvals-page bulk drop (pending board parcel 8, "Teja's clicks", 2026-11-21).
 * Teja ticks several queue rows and drops them in one go; each row still goes through
 * advance_application_status() as the human, one RPC per row (settle). Two layers are tested:
 * - the pure rule (bulkDrop.ts): WHICH ids a click may send. Teja approves from this page, so a
 *   bulk move must never touch an unticked row, a row the view hides, or a row already gone;
 * - the page's wiring (ApprovalQueuePage.tsx, read as source: apps/web has no DOM lib and the page
 *   imports supabase, so it cannot be rendered here), in the style of approvalQueueToolbar.test.ts.
 * Every assertion is a POSITIVE shape (the wiring or list that must exist), never the absence of a
 * substring: a check that forbids naming a bug fires on the comment that documents it. */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
// The rule and its words, under test.
import { BULK_DROP_DETAIL, bulkDropConfirm, bulkDropTargets } from '../src/features/approval/bulkDrop.ts';

describe('bulkDropTargets: which rows one bulk-drop click may send', () => {
  it('sends exactly the ticked rows that are on screen, in screen order', () => {
    // Four visible rows; two ticked, listed out of screen order on purpose.
    assert.deepEqual(bulkDropTargets(new Set(['c', 'a']), ['a', 'b', 'c', 'd']), ['a', 'c']);
  });

  it('never sends an unticked row, even when every other row is ticked', () => {
    // b is the one Teja means to approve: it must stay out.
    assert.deepEqual(bulkDropTargets(new Set(['a', 'c', 'd']), ['a', 'b', 'c', 'd']), ['a', 'c', 'd']);
  });

  it('never sends a ticked row the view no longer shows (filtered out, or already settled)', () => {
    // x was ticked, then hidden by a search or settled elsewhere: it is not in the visible list.
    assert.deepEqual(bulkDropTargets(new Set(['a', 'x']), ['a', 'b']), ['a']);
  });

  it('sends nothing when nothing on screen is ticked', () => {
    // A stale tick alone is not a selection.
    assert.deepEqual(bulkDropTargets(new Set(['gone']), ['a', 'b']), []);
  });
});

describe('bulkDrop words and detail', () => {
  it('names the count in the confirm sentence and in both button names', () => {
    // Three rows.
    const three = bulkDropConfirm(3);
    // The sentence says how many and that it is final.
    assert.equal(three.message, 'Drop 3 selected applications? They leave the approval queue and are never submitted. This cannot be undone.');
    // InlineConfirm prefixes "Confirm: " / "Cancel: ", so the action carries the subject.
    assert.equal(three.action, 'Drop 3 selected applications');
    // One row reads singular.
    assert.equal(bulkDropConfirm(1).action, 'Drop 1 selected application');
  });

  it('records a reason on every dropped row, in the same key the single Reject uses', () => {
    // drop_reason, like rejectReviewed's { drop_reason: reason }, so the audit log reads one key.
    assert.deepEqual(BULK_DROP_DETAIL, { drop_reason: 'bulk-dropped at approval gate' });
  });
});

describe('approval page bulk-drop wiring', () => {
  // The page's source, read once.
  const page = readFileSync(new URL('../src/features/approval/ApprovalQueuePage.tsx', import.meta.url), 'utf8');
  // The bar's source.
  const bar = readFileSync(new URL('../src/features/approval/bulkDropBar.tsx', import.meta.url), 'utf8');

  it('keeps the ticked ids in page state and derives the targets from the VISIBLE rows only', () => {
    // One id set, same useState pattern as the page's other row sets.
    assert.match(page, /const \[selected, setSelected\] = useState<ReadonlySet<string>>\(\(\) => new Set\(\)\);/);
    // Bucket A as shown plus Bucket B minus the rows the view hides, through the pure rule.
    assert.match(page, /const bulkTargets = bulkDropTargets\(selected, \[\.\.\.bucketB\.filter\(\(diff\) => !bucketBFilteredOut\.has\(diff\.applicationId\)\), \.\.\.bucketA\]\.map\(\(diff\) => diff\.applicationId\)\);/);
  });

  it('gives every Bucket A and Bucket B row a checkbox named for its job, inside the row toolbar', () => {
    // Each bucket's card, from its map to the end of its card.
    for (const start of ['{bucketB.map((diff) => {', '{bucketA.map((diff) => {']) {
      // The card's source.
      const card = page.slice(page.indexOf(start), page.indexOf('</li>', page.indexOf(start)));
      // The toolbar part of it.
      const tools = card.split('className="queue__row-tools"')[1] ?? '';
      // A checkbox bound to the set, toggled through the page's one toggle helper.
      assert.match(tools, /type="checkbox"\s+checked=\{selected\.has\(diff\.applicationId\)\}\s+onChange=\{\(\) => toggle\(setSelected, diff\.applicationId\)\}/, `${start} has no bound checkbox`);
      // Named for the job, so a screen reader says which row it ticks.
      assert.match(tools, /aria-label=\{`Select \$\{diff\.jobTitle\} at \$\{diff\.companyName\} to drop`\}/, `${start} checkbox is unnamed`);
    }
  });

  it('drops through settle as the human with the reason, only the derived targets', () => {
    // The bar is rendered with the targets and a confirm handler that settles exactly them.
    assert.match(page, /<BulkDropBar\s+targets=\{bulkTargets\}\s+onClear=\{\(\) => setSelected\(new Set\(\)\)\}\s+onDrop=\{\(ids\) => void settle\(ids, 'dropped_filter', BULK_DROP_DETAIL\)\}\s+\/>/);
  });

  it('confirms inline: the bar arms InlineConfirm, and Confirm hands over the ids it showed', () => {
    // Wrapped in the shared inline confirm, KEYED on the targets: a tick or untick while the confirm is
    // open remounts it, and an unmount cancels its pending confirm, so Confirm can never send a list
    // other than the one its sentence counted (an untick after arming would otherwise still be dropped).
    assert.match(bar, /<InlineConfirm key=\{ids\.join\(' '\)\} id=\{BULK_DROP_CONFIRM_ID\}>/);
    // The click only arms; Confirm calls onDrop with the ids captured at arming time.
    assert.match(bar, /armConfirm\(BULK_DROP_CONFIRM_ID, \{ \.\.\.bulkDropConfirm\(ids\.length\), onConfirm: \(\) => onDrop\(ids\), trigger: event\.currentTarget \}\)/);
    // Nothing ticked on screen: no bar at all, so there is nothing to click.
    assert.match(bar, /if \(targets\.length === 0\) return null;/);
  });

  // Round 5 (2026-11-21): the bar's layout moved from inline styles into the page stylesheet.
  it('lays the bar out from ApprovalQueuePage.css, wrapping so a phone never scrolls sideways', () => {
    // The page stylesheet.
    const css = readFileSync(new URL('../src/features/approval/ApprovalQueuePage.css', import.meta.url), 'utf8');
    // The bar and its count use the classes.
    assert.match(bar, /role="group" aria-label="Selected applications" className="queue__bulk-bar"/);
    assert.match(bar, /<p className="queue__bulk-count">/);
    // The bar's rule is a wrapping flex row with the token gap (the old inline values).
    assert.match(css, /\.queue__bulk-bar \{[^}]*display: flex;[^}]*flex-wrap: wrap;[^}]*align-items: center;[^}]*gap: var\(--gap-3\);/);
    // The count drops its paragraph margin.
    assert.match(css, /\.queue__bulk-count \{[^}]*margin: 0;/);
  });
});
