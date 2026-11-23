/* S9a (Teja's live chat, 2026-11-21): "add 7 tools" lost adds to the group-width check while the reply said
 * "Proposed N"; only the word "all" lifted the limit (aiEdit SAYS_ALL). An explicit count of 2+ now dictates how many
 * just as "all" does, so the add_skill card carries allowWrap and the save passes wrap: 'allow'.
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

// The smallest diff the draft builder reads: no lines and empty keyword coverage.
const empty = { applicationId: 'app-1', jobTitle: 'Backend Engineer', companyName: 'Acme', coverage: { jdKeywords: [], honestlyMatched: [], matchedByFabrication: [], matchedByEdit: [] }, lines: [] } as never;
// One add_skill resolved against a draft built from this instruction.
const card = (instruction: string) => ai.resolveOps([{ op: 'add_skill', name: 'Jira', category: 'Tools' }], ai.buildAssistDraft(empty, ['Tools'], instruction))[0];

describe('S9a: an explicit count is read like "all"', () => {
  it('"add 7 tools" and "add toools 7" lift the line limit; "add jira" does not', () => {
    // RED before the fix: only "all" set it.
    assert.equal((card('add 7 tools') as { allowWrap?: true }).allowWrap, true);
    // Live wording with the count last.
    assert.equal((card('add toools 7') as { allowWrap?: true }).allowWrap, true);
    // No count: the limit holds.
    assert.equal((card('add jira') as { allowWrap?: true }).allowWrap, undefined);
    // "1" is not a fill count: one named skill keeps the limit.
    assert.equal((card('add 1 tool: jira') as { allowWrap?: true }).allowWrap, undefined);
  });
});
