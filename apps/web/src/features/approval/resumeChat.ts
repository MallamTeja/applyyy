/* THE AI CHAT'S MEMORY (2026-11-01): reading and appending `resume_chat_messages`, grouping the
 * rows into chats, and choosing which earlier messages go back to the AI as context.
 *
 * WHY THE BROWSER WRITES, NOT THE EDGE FUNCTION. resume-assist stays stateless and never writes;
 * the page already holds what a stored message needs (the short-id -> ref map, the audit advice),
 * and RLS lets the signed-in user append only their own rows about their own applications.
 *
 * WHY THE MEMORY IS A SHORT WINDOW OF WORDS. Every applied edit is already IN the resume the AI
 * is sent, so the chat only has to carry intent: the last HISTORY_WINDOW instructions and notes,
 * never the old proposals. That keeps an ask's input roughly flat as a chat grows.
 *
 * Pure apart from the injected client, so node --test drives it with a fake. */

// Types only: what a message carries, and the turn shape the edge function takes.
import type { AssistUsage, ChatTurn, StoredOp } from './aiEdit';
// The two row readers, shared with the live answer so a stored row is checked the same way.
import { readStoredOp, readUsage } from './aiEdit';

// The table (migration 20261101120000).
const TABLE = 'resume_chat_messages';
// The columns every read and insert returns.
const COLUMNS = 'id, chat_id, role, content, ops, usage, created_at';
// The edge function's own window (resume-assist MAX_HISTORY); more would be refused there.
export const HISTORY_WINDOW = 10;
// The edge function's per-message cap (HISTORY_TEXT).
const HISTORY_TEXT = 500;
// Rows read per application. ponytail: one page, newest chats would need paging past this.
const LOAD_LIMIT = 500;

/* One stored message. */
export interface ChatMessage {
  // The row id; null for a message the save did not land (shown, but not in the history).
  readonly id: number | null;
  // The chat it belongs to.
  readonly chatId: string;
  // The operator or the AI.
  readonly role: 'user' | 'assistant';
  // The instruction, or the AI's note.
  readonly content: string;
  // Assistant only: the proposed edits, resolved to this resume's targets.
  readonly ops: readonly StoredOp[] | null;
  // Assistant only: what the ask cost.
  readonly usage: AssistUsage | null;
  // When it was written, ISO.
  readonly createdAt: string;
}

/* One chat: its messages in order, a title, and when it was last used. */
export interface ChatThread {
  // The chat id.
  readonly chatId: string;
  // The first instruction, shortened; what the picker shows.
  readonly title: string;
  // The newest message's time, for ordering the picker.
  readonly lastAt: string;
  // Oldest first.
  readonly messages: readonly ChatMessage[];
}

/* What a save sends: a message without the two columns the database fills. */
export type NewChatMessage = Omit<ChatMessage, 'id' | 'createdAt'>;

/* A read or a save: the rows, or a reason in words. Never throws. */
export type ChatResult = { readonly kind: 'ok'; readonly messages: ChatMessage[] } | { readonly kind: 'error'; readonly message: string };

/* The store the panel is handed; injected so the panel never holds a client. */
export interface ChatStore {
  // Every message of one application, oldest first.
  load(applicationId: string): Promise<ChatResult>;
  // Append messages in one insert; answers the stored rows.
  save(applicationId: string, messages: readonly NewChatMessage[]): Promise<ChatResult>;
}

/* Typed as `any` on purpose, like saveTailoredEdit's MinimalClient: supabase-js's builder generics
   differ between the real client and a test double, and every value read from it is shape-checked. */
export type ChatClient = { from(table: string): any };

/* True for a plain object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  // Arrays and null are not records.
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/* One database row as a ChatMessage, or null when any column has the wrong shape. */
export function readMessageRow(row: unknown): ChatMessage | null {
  // Must be an object.
  if (!isRecord(row)) return null;
  // The role is one of two words.
  const role = row.role === 'user' || row.role === 'assistant' ? row.role : null;
  // Ops: null for a user row, an array of readable ops for an assistant row.
  const rawOps = row.ops;
  // Each op read on its own.
  const ops = Array.isArray(rawOps) ? rawOps.map(readStoredOp) : null;
  // One unreadable op makes the row unreadable: a card with a guessed target could save the wrong bullet.
  if (ops !== null && ops.some((op) => op === null)) return null;
  // The role and the ops must agree, as the table's check constraint says.
  if (role === null || (role === 'assistant') !== (ops !== null)) return null;
  // The scalar columns, typed exactly.
  if (typeof row.id !== 'number' || typeof row.chat_id !== 'string' || typeof row.content !== 'string' || typeof row.created_at !== 'string') return null;
  // A whole, readable message.
  return {
    // The row id, so React keys and "saved" status are exact.
    id: row.id,
    // snake_case column to camelCase field, the one place the two meet.
    chatId: row.chat_id,
    // Checked above.
    role,
    // Bounded by the table check.
    content: row.content,
    // Every entry was read above; the cast only drops the null the check ruled out.
    ops: ops as StoredOp[] | null,
    // A user row has none; an assistant row is read like a live answer.
    usage: row.usage === null || row.usage === undefined ? null : readUsage(row.usage),
    // ISO from Postgres; sorting and keys use it.
    createdAt: row.created_at,
  };
}

/* Rows from a select or insert, read as a whole: one bad row refuses them all. */
function readRows(data: unknown): ChatResult {
  // A missing list is not "no messages".
  if (!Array.isArray(data)) return { kind: 'error', message: 'The chat history came back in an unexpected shape.' };
  // Each row read.
  const messages = data.map(readMessageRow);
  // Every row must be readable.
  if (messages.some((m) => m === null)) return { kind: 'error', message: 'A stored chat message has an unexpected shape.' };
  // Read.
  return { kind: 'ok', messages: messages as ChatMessage[] };
}

/* The store over a real (or fake) supabase client. */
export function createChatStore(client: ChatClient): ChatStore {
  // Two methods over one client.
  return {
    // Every message of one application.
    async load(applicationId) {
      // supabase-js answers { error } rather than throwing; the catch covers a thrown fetch.
      try {
        // One application's messages, oldest first; id breaks a same-millisecond tie.
        const { data, error } = await client
          // The chat table.
          .from(TABLE)
          // Only the columns a message needs.
          .select(COLUMNS)
          // This resume only; RLS already limits it to the caller.
          .eq('application_id', applicationId)
          // Oldest first, the order a chat reads in.
          .order('created_at', { ascending: true })
          // A question and its answer share a timestamp (one insert); id keeps them in order.
          .order('id', { ascending: true })
          // Bounded read.
          .limit(LOAD_LIMIT);
        // The database's own words.
        if (error) return { kind: 'error', message: `Could not load the chat: ${String((error as { message?: unknown }).message ?? 'unknown error')}` };
        // Shape-checked.
        return readRows(data);
      } catch (cause) {
        // No answer at all.
        return { kind: 'error', message: `Could not load the chat: ${cause instanceof Error ? cause.message : 'no answer'}.` };
      }
    },
    // One exchange, appended.
    async save(applicationId, messages) {
      // Same never-throw contract.
      try {
        // One insert for the whole exchange, so a reload never shows a question without its answer.
        const { data, error } = await client
          // The chat table.
          .from(TABLE)
          // Camel fields to snake columns; user_id and created_at are filled by the database.
          .insert(messages.map((m) => ({ application_id: applicationId, chat_id: m.chatId, role: m.role, content: m.content, ops: m.ops, usage: m.usage })))
          // The stored rows come back, so the page shows ids and server times.
          .select(COLUMNS);
        // Refused, in the database's words.
        if (error) return { kind: 'error', message: `Not saved to the chat history: ${String((error as { message?: unknown }).message ?? 'unknown error')}` };
        // The stored rows, with their ids and times.
        return readRows(data);
      } catch (cause) {
        // No answer.
        return { kind: 'error', message: `Not saved to the chat history: ${cause instanceof Error ? cause.message : 'no answer'}.` };
      }
    },
  };
}

/* Messages grouped into chats, the most recently used first. */
export function groupThreads(messages: readonly ChatMessage[]): ChatThread[] {
  // Chat id -> its messages, in arrival order (the input is oldest first).
  const byChat = new Map<string, ChatMessage[]>();
  // Each message into its chat.
  for (const message of messages) {
    // Created on first sight.
    const list = byChat.get(message.chatId) ?? [];
    // Appended in order.
    list.push(message);
    // Stored.
    byChat.set(message.chatId, list);
  }
  // One thread per chat.
  const threads = [...byChat].map(([chatId, list]) => {
    // The first instruction names the chat.
    const first = list.find((m) => m.role === 'user')?.content ?? 'New chat';
    // Shortened for the picker.
    const title = first.length > 60 ? `${first.slice(0, 57)}…` : first;
    // The newest message's time.
    const lastAt = list[list.length - 1]?.createdAt ?? '';
    // Assembled.
    return { chatId, title, lastAt, messages: list };
  });
  // Most recent first; ISO strings sort as times.
  return threads.sort((a, b) => (a.lastAt < b.lastAt ? 1 : a.lastAt > b.lastAt ? -1 : 0));
}

/* The memory sent with the next ask: the chat's last messages, as the edge function takes them. */
export function historyFor(messages: readonly ChatMessage[]): ChatTurn[] {
  // Only the window; older turns are dropped, never summarised (see the header).
  return messages.slice(-HISTORY_WINDOW).map((m) => ({ role: m.role, text: m.content.slice(0, HISTORY_TEXT) }));
}
