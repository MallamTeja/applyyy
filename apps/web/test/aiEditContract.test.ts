/* The resume-assist op contract, browser side vs server side (2026-11-05).
 *
 * WHY: the op union is written twice, in apps/web/src/features/approval/aiEdit.ts (AssistOp + readOp)
 * and in supabase/functions/resume-assist/assist.ts (AssistOp + the Gemini response schema). The web
 * is the STRICT reader: requestAssist refuses a WHOLE answer when one op is a shape readOp does not
 * know ("The AI answer had an unexpected shape."). So a kind added on the server and not the web
 * silently breaks every AI answer that uses it, in every open tab (CLAUDE.md §3, the remove_skill /
 * remove_entry near-miss of 2026-11-04).
 *
 * HOW: the server's op kinds are read at RUNTIME from the enum it hands Gemini (the only runtime list
 * it has; buildAssistPrompt returns it), not retyped here. SAMPLES holds one minimal wire op per kind.
 *   1. The server's kinds must equal SAMPLES' keys: a 10th server kind fails here until someone writes
 *      its sample, which forces the next check to run on it.
 *   2. Every sample must pass the web's real reader (requestAssist over a fake invoke), unchanged.
 * A kind added ONLY on the web is harmless (the server never sends it), so it is not policed here.
 */

// The .tsx loader the other approval tests use; aiEdit.ts relies on its extensionless imports.
import './support/registerTsxHooks.ts';
// Strict, so a sorted-list mismatch prints both lists.
import assert from 'node:assert/strict';
// The node:test runner.
import { before, describe, it } from 'node:test';
// The shared edge-client double, typed against the real EdgeClient so its shape cannot drift (W36).
import { fakeEdgeClient } from './support/fakeEdgeClient.ts';

// The web module under test, loaded after the hooks.
let ai: typeof import('../src/features/approval/aiEdit.ts');
// The server module, imported by relative path like approvalEdits.test.ts does (no new dependency).
let server: typeof import('../../../supabase/functions/resume-assist/assist.ts');

// One minimal, valid wire op per kind, exactly as the server returns it to the browser.
const SAMPLES: Record<string, Record<string, unknown>> = {
  // Rewrite a bullet (or the summary); newNumbers flags figures the master never had.
  edit: { op: 'edit', id: 'b1', text: 'Rephrased bullet.', newNumbers: [] },
  // Take a bullet off.
  remove: { op: 'remove', id: 'b1' },
  // Print a skill under a group.
  add_skill: { op: 'add_skill', name: 'Go', category: 'Languages' },
  // Take a printed skill off; the group is optional.
  remove_skill: { op: 'remove_skill', name: 'Go' },
  // Move a bullet within its entry.
  move: { op: 'move', id: 'b1', direction: 'up' },
  // Move a whole section.
  move_section: { op: 'move_section', section: 'projects', direction: 'up' },
  // Bring a master bullet or entry back.
  add_back: { op: 'add_back', id: 'm1' },
  // Write a new bullet into an entry.
  new_bullet: { op: 'new_bullet', entry: 'e1', text: 'New bullet.' },
  // Take a whole entry off.
  remove_entry: { op: 'remove_entry', id: 'e1' },
  // A job's title set to the owner's wording (2026-11-11).
  set_role: { op: 'set_role', entry: 'e0', text: 'Data Analyst Intern' },
  // S9j (2026-11-21): an entry to a place, sent only to a server-applied page; the reader must take it.
  move_entry: { op: 'move_entry', entry: 'e2', place: 1 },
};

// The smallest request parseAssistRequest accepts, so buildAssistPrompt can run.
const MINIMAL_REQUEST = { instruction: 'x', job: { title: 't', company: 'c', missing: [] }, summary: null, bullets: [], skills: '', categories: [], history: [] };

before(async () => {
  // Web first, after the hooks.
  ai = await import('../src/features/approval/aiEdit.ts');
  // Then the server; it imports only Node-safe _shared files (index.ts holds the Deno-only parts).
  server = await import('../../../supabase/functions/resume-assist/assist.ts');
});

// The server's op kinds, from the enum it sends Gemini; asserted to be a string list so a moved
// schema path fails as "not found", never as an empty list that matches nothing.
function serverOpKinds(): string[] {
  // A real request, through the server's own parser, so the prompt builder gets what it expects.
  const parsed = server.parseAssistRequest(MINIMAL_REQUEST);
  // The minimal request must stay valid, or this test is testing nothing.
  assert.ok(parsed.ok, `MINIMAL_REQUEST no longer parses: ${parsed.ok ? '' : parsed.message}`);
  // The schema Gemini answers in.
  const schema = server.buildAssistPrompt(parsed.request).responseSchema as Record<string, any>;
  // properties.ops.items.properties.op.enum: the one runtime list of kinds.
  const kinds: unknown = schema?.properties?.ops?.items?.properties?.op?.enum;
  // A list of strings, non-empty.
  assert.ok(Array.isArray(kinds) && kinds.length > 0 && kinds.every((k) => typeof k === 'string'), 'server op enum not found at responseSchema.properties.ops.items.properties.op.enum');
  // The kinds only the MODEL writes (add_group, 2026-11-21): the server expands them before answering, so the browser
  // never receives one. Subtracted here; the leak test below proves an answer really never carries one.
  const modelOnly = new Set<string>(server.MODEL_ONLY_OP_KINDS);
  // Sorted, so order changes on either side do not matter.
  return [...(kinds as string[])].filter((kind) => !modelOnly.has(kind)).sort();
}

describe('resume-assist op contract: server kinds vs web reader', () => {
  it('every op kind the server can send has a sample here', () => {
    // Same set, both directions; a new server kind names itself in the diff.
    assert.deepEqual(serverOpKinds(), Object.keys(SAMPLES).sort());
  });

  it('the web reader accepts every server kind, unchanged', async () => {
    // One answer per kind, so a refusal names its kind.
    for (const kind of serverOpKinds()) {
      // The sample for this kind (the previous test guarantees it exists).
      const op = SAMPLES[kind]!;
      // The real reader over a fake invoke returning the server's ok shape.
      const result = await ai.requestAssist(
        fakeEdgeClient(async () => ({ data: { status: 'ok', ops: [op], note: '', usage: {} }, error: null })),
        MINIMAL_REQUEST,
      );
      // Read, not refused.
      assert.equal(result.kind, 'ok', `web refused server op kind "${kind}": ${result.kind === 'error' ? result.message : ''}`);
      // And read as the same op, field for field.
      if (result.kind === 'ok') assert.deepEqual(result.ops, [op], `web changed op kind "${kind}" while reading it`);
    }
  });

  it("the server's answer never carries a model-only kind: add_group arrives as add_skill ops the web reads", async () => {
    // Without this, subtracting MODEL_ONLY_OP_KINDS above would hide a real leak: the web refuses a WHOLE answer over one
    // unknown kind. A master with one Tools skill, so one add_group expands and one (Databases) has nothing to add.
    const parsed = server.parseAssistRequest({ ...MINIMAL_REQUEST, instruction: 'add tools and databases', categories: ['Tools', 'Databases'], availableSkills: [{ name: 'Postman', category: 'Tools' }] });
    // The fixture must parse, or the test proves nothing.
    assert.ok(parsed.ok, parsed.ok ? '' : parsed.message);
    // The model's answer, through the server's own validator.
    const answer = server.parseAssistOps(JSON.stringify({ note: '', ops: [{ op: 'add_group', name: 'Tools', n: 3 }, { op: 'add_group', name: 'Databases', n: 3 }] }), parsed.request);
    // Parsed.
    assert.ok(answer.ok);
    // Non-vacuous: the fillable group really became an op.
    assert.deepEqual(answer.ops, [{ op: 'add_skill', name: 'Postman', category: 'Tools' }]);
    // Every kind sent is one the web has a sample for, and none is model-only.
    for (const op of answer.ops) assert.ok(op.op in SAMPLES && !(server.MODEL_ONLY_OP_KINDS as readonly string[]).includes(op.op), `leaked kind ${op.op}`);
    // And the web's real reader accepts the whole answer, as the server would send it.
    const read = await ai.requestAssist(fakeEdgeClient(async () => ({ data: { status: 'ok', ops: answer.ops, note: answer.note, usage: {} }, error: null })), MINIMAL_REQUEST);
    // Read, not refused.
    assert.equal(read.kind, 'ok');
  });
});
