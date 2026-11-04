/* The "add to master" question must not file a skill under a group the operator never chose
 * (2026-11-04). Live master v14: Code review, Machine learning, Testing and a skill named "AI" all
 * sat under "AI", because the picker opened on the master's FIRST group (attestCategories[0]) and one
 * click accepted it. The fix: the picker opens on an explicit "Choose a group" with Add disabled.
 *
 * DiffView has no DOM test harness here (apps/web has no DOM lib), and the question only opens on a
 * click, so the guard reads the component source. It asserts the POSITIVE shape (CLAUDE.md section 6):
 * the reset value, the placeholder option, and the disabled rule, each present. */

// The checks.
import assert from 'node:assert/strict';
// File reading, for the source.
import { readFileSync } from 'node:fs';
// The runner.
import { describe, it } from 'node:test';

// The component, read once.
const view = readFileSync(new URL('../src/features/approval/DiffView.tsx', import.meta.url), 'utf8');
// Just the askAttest function, so a match elsewhere in the file cannot satisfy the test.
const ask = view.slice(view.indexOf('function askAttest('), view.indexOf('async function confirmAttest('));

describe('attest group picker', () => {
  it('opens on no group, offers an explicit placeholder, and keeps Add disabled until a group is chosen', () => {
    // The anchors exist, so the slice is not empty (a vacuous pass otherwise).
    assert.ok(ask.length > 0, 'askAttest not found');
    // Opening the question resets the choice to nothing.
    assert.match(ask, /setAttestCategory\(''\)/);
    // The select's first option is the placeholder, value "", never submittable.
    assert.match(view, /<option value="" disabled>\s*Choose a group\s*<\/option>/);
    // The confirm control refuses while nothing is chosen.
    assert.match(view, /disabled=\{[^}]*attestCategory === ''[^}]*\}/);
  });
});
