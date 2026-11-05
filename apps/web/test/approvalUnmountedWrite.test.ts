/* A late AI answer must never write from a page that is gone (2026-11-05, AI chat bug b).
 *
 * Live: the Approval page REMOUNTED while an AI ask was in flight. The old, unmounted page's auto-apply
 * landed later and wrote the row, so the new page held a stale updated_at stamp. The operator's next Apply
 * then matched 0 rows and the card showed "Changed elsewhere; reloaded." right next to "Applied".
 *
 * Two contracts, both checked by SOURCE SHAPE (the page fetches on mount and apps/web has no DOM lib,
 * the same reason as approvalStaleClick.test.ts). Every slice is found by an anchor ASSERTED to exist,
 * then stripped of comments, so a comment that merely names the guard can never satisfy a test:
 *   1. ApprovalQueuePage's editRow refuses to write once the page has unmounted (a mounted ref), and it
 *      refuses BEFORE any write path. The guard lives in the page, never in AiEditPanel: a Bucket A->B
 *      move remounts the panel mid-auto-apply while the page, and its fresh refs, stay mounted.
 *   2. AiEditPanel never shows a failed reason on a card that is applied. */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

// Read one source file relative to this test, once per file.
function source(relative: string): string {
  // Relative to apps/web/test, so the test runs from any cwd.
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');
}

// The page and the panel: the two files these contracts live in.
const page = source('../src/features/approval/ApprovalQueuePage.tsx');
// The panel renders each op card and its failed reason.
const panel = source('../src/features/approval/AiEditPanel.tsx');

/* Code only: block comments (incl. JSX {/* *\/}) and // line comments removed. A // counts as a comment
   only at line start or after whitespace, so a "https://" inside a string survives. */
function code(slice: string): string {
  // Block comments first, so a // inside one cannot cut a line of code after it.
  return slice.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1');
}

// The text from an anchor to the next "\n  }" (a component-level function's close), failing by name if absent.
function componentFunction(text: string, declaration: string): string {
  // The opening anchor.
  const from = text.indexOf(declaration);
  // Missing means the code moved; say which anchor, never pass on an empty slice.
  assert.ok(from >= 0, `anchor not found: ${declaration}`);
  // Functions inside the component sit at two spaces, so the first "\n  }" after the anchor closes it.
  const to = text.indexOf('\n  }', from);
  // Same for the close.
  assert.ok(to > from, `no closing brace after: ${declaration}`);
  // Comments stripped: only code satisfies an assertion.
  return code(text.slice(from, to));
}

describe('a late AI answer never writes from an unmounted page (2026-11-05)', () => {
  it('the page keeps a mounted ref that turns false on unmount and true on (re)mount', () => {
    // The whole page, comments stripped.
    const body = code(page);
    // Declared as a ref, so an async continuation reads the CURRENT value, never a render closure's copy.
    assert.match(body, /const mountedRef = useRef\(true\);/);
    /* Set true in the effect body and false in its cleanup: StrictMode's dev double-mount runs the cleanup
       once, so an effect that only cleared it would leave a live page refusing every edit. */
    assert.match(body, /useEffect\(\(\) => \{\s*mountedRef\.current = true;\s*return \(\) => \{\s*mountedRef\.current = false;\s*\};\s*\}, \[\]\);/);
  });

  it('editRow refuses on an unmounted page before any write path', () => {
    // editRow's own body, comments stripped.
    const body = componentFunction(page, 'async function editRow(');
    // The guard, in its exact positive shape.
    const guard = body.indexOf('if (!mountedRef.current) return notSaved(');
    // Present at all.
    assert.ok(guard >= 0, 'editRow has no mounted-ref guard');
    // Every path that writes the row, by the call that does the write.
    for (const write of ['saveTailoredEdit(', 'attestRow(', 'attestBulletRow(']) {
      // Each must be in the body, or "before it" proves nothing.
      const at = body.indexOf(write);
      // Named, so a renamed write path fails loudly instead of passing.
      assert.ok(at >= 0, `write path not found in editRow: ${write}`);
      // The guard comes first.
      assert.ok(guard < at, `the mounted guard must run before ${write}`);
    }
  });
});

describe('an applied card never shows a failed reason (2026-11-05)', () => {
  it('the failed reason renders only when the op is NOT applied', () => {
    // The panel, comments stripped.
    const body = code(panel);
    // Exactly one place renders the save path's refusal on a card.
    const renders = body.match(/<p className="ai-chat__error">\{state\.reason\}<\/p>/g) ?? [];
    // One, so the gate below covers every render of it.
    assert.equal(renders.length, 1, 'expected exactly one per-card failed-reason render');
    // Gated on !applied, so "Applied" and a stale refusal can never show on one card.
    assert.match(body, /\{!applied && state\?\.status === 'failed' \? <p className="ai-chat__error">\{state\.reason\}<\/p> : null\}/);
  });
});
