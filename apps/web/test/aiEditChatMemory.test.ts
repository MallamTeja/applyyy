/* S9b-web (Teja's live chat, 2026-11-21): the AI had no memory of what the chat did. "rm vs code", then "add 3 more
 * tools" put VS Code back 7 s later, because the server picks from master-skills-not-on-resume and a removed skill is
 * exactly that. The web now sends `removed_skills` (skills taken off by remove_skill ops that are applied NOW, read from
 * the resume), and an earlier reply's history turn drops the server's empty "Proposed 1 change. See the list below.",
 * leaving the app's own record of what landed ([Applied: remove skill "VS Code"]) as the turn's text.
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

// A skills line that prints Jira (ref sk_jira) and no longer prints VS Code (ref sk_vs): the resume after "rm vs code".
const diff = {
  lines: [{ kind: 'skills', tailoredRuns: [{ text: 'Jira' }], printedSkills: [{ ref: 'sk_jira', name: 'Jira', category: 'Tools' }] }],
} as never;
// A removal of VS Code, applied (its ref is gone from the line).
const rmVs = { op: 'remove_skill', ref: 'sk_vs', name: 'VS Code' } as const;
// A removal of Jira, NOT applied (its ref still prints).
const rmJira = { op: 'remove_skill', ref: 'sk_jira', name: 'Jira' } as const;

describe('S9b-web: the chat remembers what it removed', () => {
  it('removedInChat names only removals that are applied now, once each, across every reply', () => {
    // Two replies proposed VS Code's removal (one repeat), one proposed Jira's (never applied), one had no ops.
    assert.deepEqual(ai.removedInChat([[rmVs], null, [rmJira, rmVs]], diff), ['VS Code']);
    // Nothing removed: an empty list.
    assert.deepEqual(ai.removedInChat([[rmJira]], diff), []);
  });

  it('buildAssistDraft sends removed_skills only when there are some, so an older body stays byte-identical', () => {
    // The smallest diff the draft builder reads: no lines (an empty resume) and empty keyword coverage.
    const empty = { applicationId: 'app-1', jobTitle: 'Backend Engineer', companyName: 'Acme', coverage: { jdKeywords: [], honestlyMatched: [], matchedByFabrication: [], matchedByEdit: [] }, lines: [] } as never;
    // With a removal.
    assert.deepEqual(ai.buildAssistDraft(empty, [], 'add tools', [], null, ['VS Code']).body.removed_skills, ['VS Code']);
    // Without: the key is absent, not an empty list.
    assert.equal('removed_skills' in ai.buildAssistDraft(empty, [], 'add tools', [], null, []).body, false);
  });

  it('a history turn keeps the app record of what landed and drops the server\'s empty "Proposed N change" line', () => {
    // The live turn: one applied removal, and the server's fallback note as the reply text.
    assert.equal(ai.historyTurnText([rmVs], 'Proposed 1 change. See the list below.', diff, null), '[Applied: remove skill "VS Code"]');
    // A real sentence from the model is kept after the record.
    assert.equal(ai.historyTurnText([rmVs], 'Done, VS Code is off.', diff, null), '[Applied: remove skill "VS Code"] Done, VS Code is off.');
  });
});
