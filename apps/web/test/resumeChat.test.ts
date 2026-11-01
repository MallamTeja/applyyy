/* The AI chat's memory (2026-11-01): reading and appending resume_chat_messages, grouping rows
 * into chats, and the window of earlier messages sent back as context.
 *
 * The client is a hand-built fake that behaves like supabase-js: it answers { data, error } and
 * never throws (CLAUDE.md §5), and records what was sent so the column mapping is pinned. */

// The .tsx loader; first, so the extensionless imports in the module resolve.
import './support/registerTsxHooks.ts';
import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';

// The module under test.
let chat: typeof import('../src/features/approval/resumeChat.ts');

before(async () => {
  // Loaded after the hooks.
  chat = await import('../src/features/approval/resumeChat.ts');
});

// One stored row, as the database returns it.
const row = (id: number, chatId: string, role: 'user' | 'assistant', content: string, at: string) => ({
  id,
  chat_id: chatId,
  role,
  content,
  // The check constraint: assistant rows always carry an ops array, user rows never do.
  ops: role === 'assistant' ? [{ op: 'remove', ref: 'r1', before: 'old' }] : null,
  usage: role === 'assistant' ? { input: 900 } : null,
  created_at: at,
});

// A fake client answering `answer` for every chain, recording the insert payload.
function fakeClient(answer: { data: unknown; error: unknown }) {
  // What insert() received, for the mapping assertion.
  const sent: unknown[] = [];
  // A builder whose every step returns itself and which resolves to `answer`, like supabase-js's thenable.
  const builder: Record<string, unknown> = {};
  // The chained methods the store calls.
  for (const name of ['select', 'eq', 'order', 'limit']) builder[name] = () => builder;
  // insert records its rows, then chains.
  builder.insert = (rows: unknown) => {
    // Recorded.
    sent.push(rows);
    // Chains to select().
    return builder;
  };
  // Awaiting the builder yields the answer.
  builder.then = (resolve: (v: unknown) => unknown) => resolve(answer);
  // The client and the record.
  return { client: { from: () => builder }, sent };
}

describe('createChatStore', () => {
  it('loads and shape-checks rows, oldest first as returned', async () => {
    // Two rows of one chat.
    const { client } = fakeClient({ data: [row(1, 'c1', 'user', 'Shorten b0', '2026-11-01T10:00:00Z'), row(2, 'c1', 'assistant', 'Done.', '2026-11-01T10:00:00Z')], error: null });
    // The read.
    const result = await chat.createChatStore(client).load('app-1');
    // Read, with the stored op and usage typed.
    assert.equal(result.kind, 'ok');
    // Narrowed.
    if (result.kind !== 'ok') return;
    // Both messages, in order, with the assistant's op and usage read.
    assert.deepEqual(result.messages.map((m) => [m.role, m.ops?.length ?? null, m.usage?.input ?? null]), [['user', null, null], ['assistant', 1, 900]]);
  });

  it('refuses the whole read when one row is malformed, and passes a database error through', async () => {
    // An assistant row without ops breaks the role/ops rule.
    const bad = { ...row(2, 'c1', 'assistant', 'Done.', 't'), ops: null };
    // Refused, not shown as a shorter chat.
    assert.equal((await chat.createChatStore(fakeClient({ data: [bad], error: null }).client).load('a')).kind, 'error');
    // supabase-js's { error } shape.
    const failed = await chat.createChatStore(fakeClient({ data: null, error: { message: 'permission denied' } }).client).load('a');
    // The database's words.
    assert.deepEqual(failed, { kind: 'error', message: 'Could not load the chat: permission denied' });
  });

  it('saves an exchange in one insert, mapped to the table columns', async () => {
    // The insert answers the stored rows.
    const { client, sent } = fakeClient({ data: [row(3, 'c1', 'user', 'Hi', 't'), row(4, 'c1', 'assistant', 'Ok.', 't')], error: null });
    // One user and one assistant message.
    const result = await chat.createChatStore(client).save('app-1', [
      { chatId: 'c1', role: 'user', content: 'Hi', ops: null, usage: null },
      { chatId: 'c1', role: 'assistant', content: 'Ok.', ops: [], usage: { input: 1, cached: null, output: null, thinking: null } },
    ]);
    // Stored.
    assert.equal(result.kind, 'ok');
    // Exactly one insert, carrying both rows with the application id.
    assert.deepEqual(sent, [[
      { application_id: 'app-1', chat_id: 'c1', role: 'user', content: 'Hi', ops: null, usage: null },
      { application_id: 'app-1', chat_id: 'c1', role: 'assistant', content: 'Ok.', ops: [], usage: { input: 1, cached: null, output: null, thinking: null } },
    ]]);
  });
});

describe('groupThreads and historyFor', () => {
  // Reads rows through the real reader, so fixtures cannot drift from it.
  const msg = (...args: Parameters<typeof row>) => chat.readMessageRow(row(...args))!;

  it('groups messages into chats, most recently used first, titled by the first instruction', () => {
    // Chat a used at 10:00, chat b at 11:00.
    const threads = chat.groupThreads([msg(1, 'a', 'user', 'Add Kafka', '2026-11-01T10:00:00Z'), msg(2, 'b', 'user', 'x'.repeat(80), '2026-11-01T11:00:00Z')]);
    // b first.
    assert.deepEqual(threads.map((t) => t.chatId), ['b', 'a']);
    // A long first instruction is shortened for the picker.
    assert.equal(threads[0]?.title.length, 58);
    // A short one is kept.
    assert.equal(threads[1]?.title, 'Add Kafka');
  });

  it('sends back only the last window of messages, as role + text', () => {
    // Twelve messages in one chat.
    const all = Array.from({ length: 12 }, (_, i) => msg(i, 'c', i % 2 === 0 ? 'user' : 'assistant', `m${i}`, `t${String(i).padStart(2, '0')}`));
    // The window.
    const history = chat.historyFor(all);
    // Exactly the edge function's window.
    assert.equal(history.length, chat.HISTORY_WINDOW);
    // The newest ones, oldest of them first.
    assert.deepEqual(history.slice(0, 2), [{ role: 'user', text: 'm2' }, { role: 'assistant', text: 'm3' }]);
  });
});
