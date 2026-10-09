/* Focus and the screen-reader announcement must survive a save that moves a card between buckets.
 *
 * Adding a skill moves a Bucket A row to Bucket B (R2); removing it moves the row back. Each bucket
 * renders DiffView under its own list, so React remounts DiffView and its in-component live region
 * and focus return die with it. The fix lives on the page: one always-mounted live region, and a
 * one-shot effect that focuses the moved card in its new bucket.
 *
 * The page fetches on mount, so it is not rendered here (the browser harness t23 does that).
 * announcementFor is pure, so it is lifted out of the source, transpiled and called for real;
 * the wiring is checked by source shape between anchors that are asserted to exist first. */

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

// apps/web's own typescript: transpiles the lifted helper without any new dependency.
const ts = createRequire(import.meta.url)('typescript') as typeof import('typescript');
// The page source, read once.
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

// The helper's signature, as the page types it.
type Announce = (kind: string, outcome: { before: string | null; after: string | null }, from?: 'A' | 'B', to?: 'A' | 'B') => string;

// Lift announcementFor out of the page and make it callable: the real function, not a copy.
function loadAnnouncementFor(): Announce {
  // From its declaration to the next top-level helper.
  const source = between('function announcementFor(', '/* The focus target for one application');
  // Types stripped; the body is plain expressions.
  const js = ts.transpileModule(`${source}`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  // Evaluated in isolation: it reads nothing but its arguments.
  return new Function(`${js}\nreturn announcementFor;`)() as Announce;
}

describe('announcementFor (the page-level announcement text)', () => {
  // Built once for the whole block.
  const announce = loadAnnouncementFor();

  it('an add that moves A -> B names the skill and the move', () => {
    // The add's outcome carries the skill name in `after`.
    assert.equal(announce('add_skill', { before: null, after: 'SQL' }, 'A', 'B'), 'Added SQL to this resume. This application now needs individual approval.');
  });

  it('a remove that moves B -> A names the skill and the return', () => {
    // A removal carries the name in `before`.
    assert.equal(announce('remove_skill', { before: 'SQL', after: null }, 'B', 'A'), 'Removed SQL. This application is back in the verified batch.');
  });

  it('an in-bucket save says only what happened', () => {
    // Text edit, B stays B.
    assert.equal(announce('edit', { before: 'old', after: 'new' }, 'B', 'B'), 'Saved your edit.');
    // Bullet removed.
    assert.equal(announce('remove', { before: 'old', after: null }, 'B', 'B'), 'Removed the bullet.');
    // Reset.
    assert.equal(announce('reset', { before: 'x', after: 'y' }, 'B', 'B'), "Reset to the tailor's version.");
  });
});

describe('ApprovalQueuePage wiring for a cross-bucket save', () => {
  it('has exactly one page-level polite status region, rendering the announcement', () => {
    // The HIDDEN page-level announcer specifically. Visible per-card stale notices are also
    // role="status" (approvalStaleClick.test.ts), so counting every status region would conflate the two.
    const announcer = '<p className="visually-hidden" role="status" aria-live="polite">';
    // Exactly one announcer: a second would double-announce every edit.
    assert.equal(page.split(announcer).length - 1, 1);
    // And it renders the announcement state.
    assert.match(page, /<p className="visually-hidden" role="status" aria-live="polite">\s*\{announcement\}\s*<\/p>/);
    // Mounted in the main return BEFORE either bucket, so no bucket change can unmount it.
    assert.ok(page.indexOf(announcer) < page.indexOf('aria-labelledby="bucket-b-heading"'), 'the announcer must sit outside and above the buckets');
  });

  it('editRow clears the announcement before the save and sets it from the outcome after', () => {
    // From editRow's declaration to the next function on the page.
    const edit = between('async function editRow(', '// Flip one id in a set-valued state');
    // Cleared before the network write, so a repeat is re-announced.
    assert.ok(edit.indexOf("setAnnouncement('')") >= 0 && edit.indexOf("setAnnouncement('')") < edit.indexOf('await saveTailoredEdit('), 'cleared before the save');
    // Set after adoptRow, from the action, the outcome (skill name) and both buckets.
    assert.match(edit, /adoptRow\(applicationId, outcome\.resume, saved\.updatedAt\);[\s\S]*setAnnouncement\(announcementFor\(action\.kind, outcome, from, to\)\);/);
    // Never on the failure branch: that branch returns before the announcement.
    assert.ok(edit.indexOf('if (!saved.ok) {') < edit.indexOf('setAnnouncement(announcementFor('), 'announced only after the failure branch returned');
  });

  it('focus is requested only when the save moved the row between buckets', () => {
    // The same editRow slice.
    const edit = between('async function editRow(', '// Flip one id in a set-valued state');
    // Guarded by from !== to, so an in-bucket save leaves DiffView's own focus return alone.
    assert.match(edit, /if \(from !== undefined && to !== undefined && from !== to\) setPendingFocusId\(applicationId\);/);
  });

  it('an add that stays in its bucket is left to CoverageBar, so it is never announced twice', () => {
    // The same editRow slice.
    const edit = between('async function editRow(', '// Flip one id in a set-valued state');
    // The page announces everything EXCEPT an in-bucket add, which DiffView (not remounted) already said.
    assert.match(edit, /if \(!\(action\.kind === 'add_skill' && from === to\)\) setAnnouncement\(announcementFor\(/);
  });

  it('both buckets give the card the shared id and tabIndex -1', () => {
    // The id builder.
    assert.match(page, /function cardId\(applicationId: string\): string \{[\s\S]*?return `app-card-\$\{applicationId\}`;/);
    // Bucket B's card.
    const b = between('className="queue__item"', '<DiffView');
    // Carries the id and is script-focusable.
    assert.match(b, /id=\{cardId\(diff\.applicationId\)\}[\s\S]*tabIndex=\{-1\}/);
    // Bucket A's card.
    const a = between('className="queue__clean-row queue__clean-row--openable"', '<div className="queue__clean-line">');
    // Same id and focusability.
    assert.match(a, /id=\{cardId\(diff\.applicationId\)\}[\s\S]*tabIndex=\{-1\}/);
  });

  it('the focus effect focuses that card id and clears itself', () => {
    // From the effect to the load effect that follows it.
    const effect = between('if (pendingFocusId === null) return;', '}, [pendingFocusId]);');
    // Focuses the moved card by the shared builder.
    assert.match(effect, /document\.getElementById\(cardId\(pendingFocusId\)\)\?\.focus\(\);/);
    // One-shot.
    assert.match(effect, /setPendingFocusId\(null\);/);
  });
});
