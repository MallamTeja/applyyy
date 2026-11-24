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

  it('reads a server-applied move_skill (the live "Harness Engineering first" ask); a malformed one is refused whole', async () => {
    // The live case (2026-11-23): a skill to the first place of its group, applied by the server.
    const ops = [{ op: 'move_skill', name: 'Harness Engineering', category: 'AI', place: 1 }];
    // The server's answer with its one-line apply report.
    const answer = await ai.requestAssist(answering({ status: 'ok', ops, note: '', applied: [{ status: 'applied', label: 'Move skill to place 1' }], chat_saved: true }), body);
    // Read, not refused, and the op kept exactly as the wire sent it.
    assert.deepEqual(answer.kind === 'ok' ? answer.ops : answer, ops);
    // Malformed shapes: place 0, an empty name, a fractional place, a numeric category, a missing place.
    const bad = [{ place: 0 }, { name: '' }, { place: 1.5 }, { category: 3 }, { place: undefined }];
    // Each must refuse the WHOLE answer, never pass as a half-read op.
    for (const patch of bad) {
      // One answer per malformed shape, so a failure names it.
      const read = await ai.requestAssist(answering({ status: 'ok', ops: [{ ...ops[0], ...patch }], note: '' }), body);
      // Refused whole.
      assert.equal(read.kind, 'error', `accepted ${JSON.stringify(patch)}`);
    }
    // The group is optional: without it the op still reads, with no category key invented.
    const bare = await ai.requestAssist(answering({ status: 'ok', ops: [{ op: 'move_skill', name: 'Go', place: 2 }], note: '' }), body);
    // Exactly the two sent fields.
    assert.deepEqual(bare.kind === 'ok' ? bare.ops : bare, [{ op: 'move_skill', name: 'Go', place: 2 }]);
  });

  it('a place-move reaching a page that applies in the browser becomes a named refusal card', () => {
    // The smallest diff the draft builder reads.
    const empty = { applicationId: 'app-1', jobTitle: '', companyName: '', coverage: { jdKeywords: [], honestlyMatched: [], matchedByFabrication: [], matchedByEdit: [] }, lines: [] } as never;
    // Resolved in browser mode.
    const [card] = ai.resolveOps([{ op: 'move_entry', entry: 'e2', place: 1 }], ai.buildAssistDraft(empty, [], 'x'));
    // Refused by name, never applied by the browser.
    assert.equal(card?.op, 'rejected');
    // A skill to a place is server-only too (2026-11-23): refused by name, never guessed into a browser move.
    const [skill] = ai.resolveOps([{ op: 'move_skill', name: 'Go', place: 1 }], ai.buildAssistDraft(empty, [], 'x'));
    // The same named refusal.
    assert.equal(skill?.op, 'rejected');
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

describe('S9i P2: a server-applied reply shows its record (found by aiEditServerApplyE2e, 2026-11-23)', () => {
  it('replyNote never hides the server record of a card-less reply; an AI claim with no cards is still hidden', () => {
    // The text chatRows / the panel store for a server-applied answer: record first, then the AI's note.
    const record = '[Applied: Remove skill "Redis" | Could not do: Remove skill "Kubernetes" (It is not on this resume.)] Removed it.';
    // Shown whole, though it says "Applied" and "Removed" with no cards beside it.
    assert.equal(ai.replyNote(record, []), record);
    // The old guard still holds for an AI note that claims a change nothing can back.
    assert.equal(ai.replyNote('I removed Redis.', []), '');
    // Matched on the record's exact opening only: a note that merely mentions the word is not a record.
    assert.deepEqual([ai.isServerRecord(record), ai.isServerRecord('Applied: nothing'), ai.isServerRecord('[Suggested, not applied: x (y)]')], [true, false, true]);
  });
});
