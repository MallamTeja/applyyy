/* S9i P2 + S9j, the web's strict reader (consumer before producer, CLAUDE.md §3): a server that applied the answer
 * itself sends `applied` (one outcome per op) and `chat_saved`, and may send S9j place-moves (move_entry, and
 * move/move_section with "place"). The reader must take all of these, never refusing a whole answer over them, and must
 * still refuse a malformed report whole (a partial list could hide a change that landed).
 * Harness: support/registerTsxHooks.ts, like the other approval suites. */
// The .tsx loader; must be the first import.
import './support/registerTsxHooks.ts';
// Strict comparisons.
import assert from 'node:assert/strict';
// The runner.
import { before, describe, it } from 'node:test';
// The supabase-js-shaped double for functions.invoke.
import { fakeEdgeClient } from './support/fakeEdgeClient.ts';

// The module under test, loaded after the hooks.
let ai: typeof import('../src/features/approval/aiEdit.ts');
// Loaded once.
before(async () => {
  // Through the hooks.
  ai = await import('../src/features/approval/aiEdit.ts');
});

// A minimal ask: the reader's job is the answer.
const body = { instruction: 'place applyyy first', job: { title: '', company: '', missing: [] }, summary: null, bullets: [], skills: '', categories: [], history: [] };
// A client whose function answers `data`.
const answering = (data: unknown) => fakeEdgeClient(async () => ({ data, error: null }));

describe('S9i P2: the reader takes a server-applied answer', () => {
  it('reads S9j place-moves and the apply report; chat_saved only as an exact true', async () => {
    // The live S9j asks, applied by the server.
    const answer = await ai.requestAssist(answering({ status: 'ok', ops: [{ op: 'move_entry', entry: 'e2', place: 1 }, { op: 'move_section', section: 'projects', place: 1 }], note: '', applied: [{ status: 'applied', label: 'Move projects entry to place 1' }, { status: 'refused', label: 'Move section projects to place 1', why: 'already first' }], chat_saved: true }), body);
    // Read, not refused.
    assert.equal(answer.kind, 'ok');
    // The ops exactly as the wire sent them, the report as sent, and the save flag.
    assert.deepEqual(answer.kind === 'ok' ? [answer.ops, answer.applied, answer.chatSaved] : answer, [
      [{ op: 'move_entry', entry: 'e2', place: 1 }, { op: 'move_section', section: 'projects', place: 1 }],
      [{ status: 'applied', label: 'Move projects entry to place 1' }, { status: 'refused', label: 'Move section projects to place 1', why: 'already first' }],
      true,
    ]);
  });

  it('a malformed report is refused whole; an answer with no report has no applied key', async () => {
    // A refused outcome without its reason.
    const bad = await ai.requestAssist(answering({ status: 'ok', ops: [], note: '', applied: [{ status: 'refused', label: 'x' }] }), body);
    // Refused whole.
    assert.equal(bad.kind, 'error');
    // An older server: no report.
    const old = await ai.requestAssist(answering({ status: 'ok', ops: [], note: '' }), body);
    // No key at all.
    assert.equal(old.kind === 'ok' && 'applied' in old, false);
  });

  it('a place-move reaching a page that applies in the browser becomes a named refusal card', () => {
    // The smallest diff the draft builder reads.
    const empty = { applicationId: 'app-1', jobTitle: '', companyName: '', coverage: { jdKeywords: [], honestlyMatched: [], matchedByFabrication: [], matchedByEdit: [] }, lines: [] } as never;
    // Resolved in browser mode.
    const [card] = ai.resolveOps([{ op: 'move_entry', entry: 'e2', place: 1 }], ai.buildAssistDraft(empty, [], 'x'));
    // Refused by name, never applied by the browser.
    assert.equal(card?.op, 'rejected');
  });
});

describe('S9i P2: the web body and the server reader agree', () => {
  it('a withServerApply body turns server apply ON at the server, with the draft\'s own maps', async () => {
    // The server's request reader, by relative path (aiEditContract.test.ts does the same).
    const server = await import('../../../supabase/functions/resume-assist/assist.ts');
    // The smallest diff the draft builder reads.
    const empty = { applicationId: 'app-1', jobTitle: 'Backend Engineer', companyName: 'Acme', coverage: { jdKeywords: [], honestlyMatched: [], matchedByFabrication: [], matchedByEdit: [] }, lines: [] } as never;
    // A draft asking the server to apply.
    const draft = ai.withServerApply(ai.buildAssistDraft(empty, ['Tools'], 'place applyyy first'), '11111111-2222-4333-8444-555555555555', '99999999-8888-4777-8666-555555555555');
    // Read by the server exactly as sent.
    const parsed = server.parseAssistRequest(JSON.parse(JSON.stringify(draft.body)));
    // On, with this row, this chat and empty maps (an empty resume mints no ids).
    assert.deepEqual(parsed.ok ? [parsed.request.serverApply, parsed.request.applicationId, parsed.request.chatId, parsed.request.applyMaps] : parsed, [true, '11111111-2222-4333-8444-555555555555', '99999999-8888-4777-8666-555555555555', { bullets: {}, entries: {}, availableBullets: {}, availableEntries: {}, skills: [] }]);
  });
});
