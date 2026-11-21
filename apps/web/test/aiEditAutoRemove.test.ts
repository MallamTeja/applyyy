/* Teja's ruling (2026-11-21 14:36 IST): "if i say rm something or remove something it need to directly remove the
 * skill, no need of clicking the apply button again". His live case: "rm  vs cod e" (a typo) left "Remove skill VS
 * Code [Apply]" waiting, because the web's naming check needed every word of "VS Code" typed EXACTLY, while the
 * server's own check (resume-assist ownerNamed) had already read it as VS Code. These tests pin the predicate the
 * panel's auto-apply list is built from (AiEditPanel: shouldAutoApply, then isPairedHalf), so a removal the owner
 * asked for lands with no click, and everything the old rule refused is still refused.
 * Harness: support/registerTsxHooks.ts, like the other approval suites. */
// The .tsx loader; must be the first import.
import './support/registerTsxHooks.ts';
// Strict comparisons.
import assert from 'node:assert/strict';
// The runner.
import { before, describe, it } from 'node:test';

// The module under test, loaded after the hooks.
let ai: typeof import('../src/features/approval/aiEdit.ts');
// Loaded once.
before(async () => {
  // Through the hooks, so its extensionless imports resolve like Vite's.
  ai = await import('../src/features/approval/aiEdit.ts');
});

// A printed skill to take off.
const off = (name: string) => ({ op: 'remove_skill', ref: 'skill_x', name }) as const;
// A whole entry to take off.
const entry = (label: string) => ({ op: 'remove_entry', section: 'projects', ref: 'p', label }) as const;

describe('a removal the owner asked for applies with no click (Teja 2026-11-21)', () => {
  it('"rm vs code" (and Teja\'s live typo "rm  vs cod e") removes VS Code with no click', () => {
    // The clean wording.
    assert.equal(ai.shouldAutoApply(off('VS Code'), 'rm vs code'), true);
    // The live message, split and short a letter: the server read it as VS Code, so must the web.
    assert.equal(ai.shouldAutoApply(off('VS Code'), 'rm  vs cod e'), true);
    // One typo on a 6+ letter name ("Typescrit").
    assert.equal(ai.shouldAutoApply(off('TypeScript'), 'remove typescrit'), true);
  });

  it('a removal the owner did NOT name still waits (a posting in the prompt cannot remove what it likes)', () => {
    // An extra removal riding along with a named one.
    assert.equal(ai.shouldAutoApply(off('Python'), 'rm vs code'), false);
    // No skill named at all.
    assert.equal(ai.shouldAutoApply(off('Python'), 'trim my skills'), false);
    // A short name is exact only: one edit from "Go" is half the language.
    assert.equal(ai.shouldAutoApply(off('Go'), 'rm gp'), false);
    // Whole runs only: "os" inside "cost" is not naming OS.
    assert.equal(ai.shouldAutoApply(off('OS'), 'cut the cost line'), false);
    // Three edits away is a different word: "code reviewing" is not "Code review".
    assert.equal(ai.shouldAutoApply(off('Code review'), 'remove the code reviewing skill'), false);
  });

  it('a whole entry the owner named by its name applies with no click; a partial or unnamed one still waits', () => {
    // The project named in full, the way Teja types it.
    assert.equal(ai.shouldAutoApply(entry('One-on-One · Interview prep platform'), 'rm one on one project'), true);
    // Only part of the name: ambiguous, so his click.
    assert.equal(ai.shouldAutoApply(entry('F1 Race Pace Predictor'), 'remove the F1 project'), false);
    // Not named at all.
    assert.equal(ai.shouldAutoApply(entry('F1 Race Pace Predictor'), 'tighten my projects'), false);
  });

  it('the bullet-swap remove still waits for its partner (1dd56317): never applied alone', () => {
    // A bullet removal and a new line under the same entry: one swap.
    const ops = [{ op: 'remove', ref: 'x_b1', before: null }, { op: 'new_bullet', section: 'experience', parentRef: 'x', text: 'New line.' }] as never;
    // The page's bullet -> entry map.
    const parents = new Map([['x_b1', 'x']]);
    // The remove would apply by itself...
    assert.equal(ai.shouldAutoApply((ops as { op: string }[])[0] as never, 'swap the first bullet'), true);
    // ...but it is half of a swap, so the panel's auto list skips it (isPairedHalf), and both wait for one click.
    assert.equal(ai.isPairedHalf(ops, 0, parents), true);
  });
});
