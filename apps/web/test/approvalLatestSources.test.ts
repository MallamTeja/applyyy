/* An edit must read the row's CURRENT pin, never the render closure's (review finding, 2026-11-01).
 *
 * attest_skill and attest_bullet RE-PIN a row to a new master version. The AI chat's Apply all and
 * auto-apply then call editRow again within the same click, from a closure rendered before the
 * re-pin. editRow used to read `sources.get(id)` from that closure, so the next op saw the OLD
 * master version and was refused as "master version changed; reload". The fix is a ref,
 * latestSources, published synchronously beside every setSources, like latestResumes.
 *
 * The page fetches on mount, so it is not rendered here (same as approvalStaleClick.test.ts). The
 * wiring is checked by source shape, comments stripped, between anchors asserted to exist. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

// The page source, read once.
const page = readFileSync(fileURLToPath(new URL('../src/features/approval/ApprovalQueuePage.tsx', import.meta.url)), 'utf8');
// Code only: block comments and line comments (at line start or after whitespace) removed.
const code = (slice: string): string => slice.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1');
// One component-level function, declaration to its closing brace at two-space indent; a missing one fails by name.
function componentFunction(declaration: string): string {
  // The declaration must exist, or the slice would be empty and prove nothing.
  const from = page.indexOf(declaration);
  // Named failure.
  assert.ok(from >= 0, `anchor not found: ${declaration}`);
  // The first "\n  }" after it closes a component-level function.
  const to = page.indexOf('\n  }', from + declaration.length);
  // Named failure.
  assert.ok(to > from, `end of ${declaration} not found`);
  // Comments stripped, so a comment naming the ref cannot satisfy the test.
  return code(page.slice(from, to));
}

describe('latestSources: async edits read the row as last published', () => {
  it('editRow takes the row source from latestSources, not the render closure', () => {
    // The function body, code only.
    // T10: editRows, since editRow only delegates to it (a batch of one).
    const body = componentFunction('async function editRows(');
    // Positive shape: the source comes from the ref.
    assert.match(body, /const source = latestSources\.current\.get\(applicationId\)/);
    // And the closure read it replaced is gone from this function.
    assert.doesNotMatch(body, /\bsources\.get\(/);
  });

  it('every setSources publishes to latestSources in the same code path', () => {
    // Code only, whole page.
    const all = code(page);
    // Each state publication of a source map.
    const publishes = all.match(/\bsetSources\(/g) ?? [];
    // Each synchronous write to the ref: a whole-map assignment or a per-row set.
    const mirrors = all.match(/latestSources\.current(?: = new Map\(|\.set\()/g) ?? [];
    // There are some, or the count comparison below proves nothing.
    assert.ok(publishes.length > 0, 'no setSources found');
    // One mirror per publication.
    assert.equal(mirrors.length, publishes.length);
  });
});
