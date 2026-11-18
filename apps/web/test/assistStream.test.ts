/* The resume chat's streamed answer (2026-11-18, chat latency fixes 3 and 5).
 *
 * WHY: resume-assist answers NDJSON when asked with `Accept: application/x-ndjson`: status lines, the reply
 * note as it grows, and ONE `result` line carrying exactly today's JSON body. The web must read it line by line
 * while network chunks split lines (and UTF-8 characters) anywhere, and must keep reading a plain JSON answer
 * exactly as before, because Vercel can ship this web before the server streams.
 *
 * Harness: pure functions over real Response / ReadableStream objects (Node 24 has both); nothing reaches the
 * network. The fetch double answers with a real Response, so status, headers and body behave like fetch's. */
// The .tsx loader and extensionless-import resolver; must run before any app module loads.
import './support/registerTsxHooks.ts';
// Node's own runner and strict asserts, as every web test here uses.
import assert from 'node:assert/strict';
// describe/it from the same runner; before() loads the app modules after the hook.
import { before, describe, it } from 'node:test';
// The shared edge-client double, so the client shape cannot drift from the real one.
import { fakeEdgeClient } from './support/fakeEdgeClient.ts';

// The pure module under test.
let ai: typeof import('../src/features/approval/aiEdit.ts');
// The streaming fetch helper under test.
let edge: typeof import('../src/data/edgeCall.ts');

before(async () => {
  // Loaded after the hook so the extensionless imports resolve.
  ai = await import('../src/features/approval/aiEdit.ts');
  // Same.
  edge = await import('../src/data/edgeCall.ts');
});

// UTF-8 bytes of a string, so a test can cut a chunk inside a multi-byte character.
const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

// A reader that hands out exactly these chunks, in order, like a network body.
function readerOf(chunks: readonly Uint8Array[]): ReadableStreamDefaultReader<Uint8Array> {
  // Each pull hands out the next chunk; the stream closes after the last.
  return new ReadableStream<Uint8Array>({ start(controller) { for (const chunk of chunks) controller.enqueue(chunk); controller.close(); } }).getReader();
}

// Cuts a text's bytes at the given byte offsets, so a line or a character lands across two chunks.
function cut(text: string, at: readonly number[]): Uint8Array[] {
  // The whole body as bytes.
  const all = bytes(text);
  // Each boundary pair becomes one chunk.
  const edges = [0, ...at, all.length];
  // Slices between consecutive boundaries.
  return edges.slice(1).map((end, i) => all.slice(edges[i], end));
}

// The ok body resume-assist sends today, reused as the stream's result body.
const okBody = { status: 'ok', ops: [{ op: 'remove', id: 'b0' }], note: 'Removed the bullet — café', usage: { input: 10 } };
// What the reader turns that body into (pinned by aiEdit.test.ts for the JSON path).
const okResult = { kind: 'ok', ops: [{ op: 'remove', id: 'b0' }], rejected: [], note: 'Removed the bullet — café', usage: { input: 10, cached: null, output: null, thinking: null } };

// A full stream: status, a growing note, a model switch, a restarted note, then the result.
const stream = [
  // Before attempt 1.
  { type: 'status', stage: 'thinking', text: 'Thinking...' },
  // The note so far.
  { type: 'note', text: 'Remov' },
  // The model switched after a 503: the note restarts.
  { type: 'status', stage: 'switching_model', text: 'Gemini is overloaded - trying the backup model...' },
  // The new attempt's note, cumulative.
  { type: 'note', text: 'Removed the bullet — café' },
  // Always last.
  { type: 'result', httpStatus: 200, body: okBody },
].map((event) => JSON.stringify(event)).join('\n') + '\n';

describe('splitNdjson', () => {
  it('returns complete lines and keeps the unfinished tail for the next chunk', () => {
    // Two whole lines and half of a third.
    const { lines, rest } = ai.splitNdjson('{"a":1}\n{"b":2}\r\n{"c":');
    // CR stripped, tail held back.
    assert.deepEqual([lines, rest], [['{"a":1}', '{"b":2}'], '{"c":']);
  });

  it('skips blank lines (a keep-alive newline is not an event)', () => {
    // Blank and whitespace-only lines between events.
    assert.deepEqual(ai.splitNdjson('\n  \n{"a":1}\n').lines, ['{"a":1}']);
  });
});

describe('readAssistStream', () => {
  it('reports status and note as they arrive, then reads the result like the JSON path', async () => {
    // Every progress the panel would see.
    const seen: unknown[] = [];
    // Cut inside the first line, inside "é" (2 bytes) of the restarted note, and inside the result line.
    const cafe = bytes(stream).indexOf(0xc3);
    // The read.
    const result = await ai.readAssistStream(readerOf(cut(stream, [7, cafe + 1, bytes(stream).length - 20])), (p) => seen.push(p));
    // The same AssistResult the JSON path gives for this body.
    assert.deepEqual(result, okResult);
    // A status clears the old note; a note keeps the latest status.
    assert.deepEqual(seen, [
      { status: 'Thinking...', note: '' },
      { status: 'Thinking...', note: 'Remov' },
      { status: 'Gemini is overloaded - trying the backup model...', note: '' },
      { status: 'Gemini is overloaded - trying the backup model...', note: 'Removed the bullet — café' },
    ]);
  });

  it('reads a last line that has no trailing newline', async () => {
    // The result without the final "\n".
    const result = await ai.readAssistStream(readerOf([bytes(stream.trimEnd())]), () => undefined);
    // Still read.
    assert.deepEqual(result, okResult);
  });

  it('a stream that ends with no result line is the "connection dropped" error', async () => {
    // Status and note only: the server died mid-answer.
    const cutShort = stream.split('\n').slice(0, 2).join('\n') + '\n';
    // The read.
    const result = await ai.readAssistStream(readerOf([bytes(cutShort)]), () => undefined);
    // The pinned sentence.
    assert.deepEqual(result, { kind: 'error', message: 'The AI connection dropped; try again.' });
  });

  it('a body that fails mid-read is the same "connection dropped" error, never a throw', async () => {
    // A reader whose second read rejects, as a reset connection does.
    let reads = 0;
    // First read gives a status, then the socket dies.
    const reader = { read: async () => (reads++ === 0 ? { done: false, value: bytes('{"type":"status","text":"Thinking..."}\n') } : Promise.reject(new TypeError('network error'))) } as unknown as ReadableStreamDefaultReader<Uint8Array>;
    // The read.
    assert.deepEqual(await ai.readAssistStream(reader, () => undefined), { kind: 'error', message: 'The AI connection dropped; try again.' });
  });

  it('a result carrying a 503 upstream_unavailable shows the busy sentence, as the JSON path does', async () => {
    // The raw line goes to the console; silenced so the test output stays clean.
    const warn = console.warn;
    // Swallowed for this call only.
    console.warn = () => undefined;
    // The error outcome inside the stream.
    const line = JSON.stringify({ type: 'result', httpStatus: 503, body: { status: 'upstream_unavailable', message: 'upstream_unavailable status=503' } });
    // The read.
    const result = await ai.readAssistStream(readerOf([bytes(line + '\n')]), () => undefined).finally(() => { console.warn = warn; });
    // Exactly the friendly sentence.
    assert.deepEqual(result, { kind: 'error', message: ai.AI_BUSY_MESSAGE });
  });

  it('ignores malformed and unknown lines but never a malformed result (shape checked, not trusted)', async () => {
    // Garbage, an unknown event type, a status without text, and a result with a string status.
    const body = ['not json', '{"type":"ping"}', '{"type":"status"}', '{"type":"result","httpStatus":"200","body":{}}'].join('\n') + '\n';
    // Nothing usable was sent, so there is no result.
    assert.deepEqual(await ai.readAssistStream(readerOf([bytes(body)]), () => undefined), { kind: 'error', message: 'The AI connection dropped; try again.' });
  });
});

describe('invokeEdgeStream', () => {
  // The target the helper posts to; the token comes from the session.
  const target = { url: 'https://proj.supabase.co', apikey: 'anon-key', accessToken: async () => 'jwt-1' };
  // Every request the fetch double saw.
  type Seen = { url: string; init: RequestInit };

  it('posts with the session token, apikey and the NDJSON Accept header, and hands back a reader', async () => {
    // Recorded requests.
    const seen: Seen[] = [];
    // A server that streams.
    const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => { seen.push({ url: String(url), init: init ?? {} }); return new Response(stream, { headers: { 'Content-Type': 'application/x-ndjson' } }); };
    // The call.
    const answer = await edge.invokeEdgeStream(fakeEdgeClient(async () => ({ data: null, error: null })), target, 'resume-assist', { instruction: 'x' }, fetchImpl);
    // A stream, readable to the end by the assist reader.
    assert.equal(answer.kind, 'stream');
    // The stream reads to the ok result.
    if (answer.kind === 'stream') assert.deepEqual(await ai.readAssistStream(answer.reader, () => undefined), okResult);
    // The request the edge gate expects.
    const headers = new Headers(seen[0]?.init.headers);
    // URL, auth, key, opt-in header, JSON body.
    assert.deepEqual([seen[0]?.url, headers.get('Authorization'), headers.get('apikey'), headers.get('Accept'), seen[0]?.init.body], ['https://proj.supabase.co/functions/v1/resume-assist', 'Bearer jwt-1', 'anon-key', 'application/x-ndjson', '{"instruction":"x"}']);
  });

  it('an old server answering JSON comes back as data, exactly like invoke', async () => {
    // Today's server ignores the Accept header.
    const fetchImpl = async () => Response.json(okBody);
    // The call.
    const answer = await edge.invokeEdgeStream(fakeEdgeClient(async () => ({ data: null, error: null })), target, 'resume-assist', {}, fetchImpl);
    // Answered, data parsed, no error.
    assert.deepEqual(answer.kind === 'answered' ? [answer.data, answer.error] : answer, [okBody, null]);
  });

  it('a non-2xx JSON error keeps its body readable behind error.context, as supabase-js does', async () => {
    // A 409 from before Gemini runs.
    const fetchImpl = async () => Response.json({ status: 'conflict', message: 'The resume changed.' }, { status: 409 });
    // The call.
    const answer = await edge.invokeEdgeStream(fakeEdgeClient(async () => ({ data: null, error: null })), target, 'resume-assist', {}, fetchImpl);
    // The error's context is the Response, so the caller's reader gets the message.
    const context = answer.kind === 'answered' ? (answer.error as { context?: Response }).context : undefined;
    // Status and body intact.
    assert.deepEqual([context?.status, await context?.json()], [409, { status: 'conflict', message: 'The resume changed.' }]);
  });

  it('a session 401 refreshes once and retries with the new token', async () => {
    // Tokens handed out: the stale one, then the refreshed one.
    const tokens = ['stale', 'fresh'];
    // Recorded requests.
    const seen: Seen[] = [];
    // 401 for the stale token, a stream for the fresh one.
    const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
      // Kept for the assertion.
      seen.push({ url: String(url), init: init ?? {} });
      // The gate's session refusal for the first call only.
      return seen.length === 1 ? Response.json({ status: 'unauthorized', message: 'invalid_session' }, { status: 401 }) : new Response(stream, { headers: { 'Content-Type': 'application/x-ndjson' } });
    };
    // A refresh that works.
    const client = fakeEdgeClient(async () => ({ data: null, error: null }), { refreshSession: async () => ({ error: null }) });
    // The call.
    const answer = await edge.invokeEdgeStream(client, { ...target, accessToken: async () => tokens.shift() ?? null }, 'resume-assist', {}, fetchImpl);
    // Streamed on the retry, with the fresh token.
    assert.deepEqual([answer.kind, seen.map((s) => new Headers(s.init.headers).get('Authorization'))], ['stream', ['Bearer stale', 'Bearer fresh']]);
  });

  it('a session 401 whose refresh fails signs this browser out with the plain sentence', async () => {
    // Which sign-out scopes were used.
    const scopes: unknown[] = [];
    // The default fake refresh fails, like a revoked refresh token.
    const client = fakeEdgeClient(async () => ({ data: null, error: null }), { signOut: async (options) => { scopes.push(options?.scope); return { error: null }; } });
    // Always the session refusal.
    const fetchImpl = async () => Response.json({ status: 'unauthorized', message: 'invalid_session' }, { status: 401 });
    // The call.
    const answer = await edge.invokeEdgeStream(client, target, 'resume-assist', {}, fetchImpl);
    // Signed out locally, with the sentence.
    assert.deepEqual([answer, scopes], [{ kind: 'signed_out', message: edge.SIGNED_OUT_MESSAGE }, ['local']]);
  });

  it('a fetch that throws comes back as an answered error, never a throw (invoke does the same)', async () => {
    // Offline.
    const fetchImpl = async () => { throw new TypeError('Failed to fetch'); };
    // The call.
    const answer = await edge.invokeEdgeStream(fakeEdgeClient(async () => ({ data: null, error: null })), target, 'resume-assist', {}, fetchImpl);
    // An error, no data.
    assert.deepEqual([answer.kind, answer.kind === 'answered' && answer.error !== null], ['answered', true]);
  });
});

describe('edgeStreamTargetOf', () => {
  it('reads url, key and session token off a supabase-js client, and refuses a client without them', async () => {
    // The fields supabase-js keeps on its client (protected in its types, present at run time).
    const real = { ...fakeEdgeClient(async () => ({ data: null, error: null })), supabaseUrl: 'https://p.supabase.co', supabaseKey: 'k' };
    // Its auth gains getSession, as auth-js has.
    const client = { ...real, auth: { ...real.auth, getSession: async () => ({ data: { session: { access_token: 'jwt' } }, error: null }) } };
    // The target.
    const target = edge.edgeStreamTargetOf(client);
    // Url and key copied, token from the session.
    assert.deepEqual([target?.url, target?.apikey, await target?.accessToken()], ['https://p.supabase.co', 'k', 'jwt']);
    // A plain fake (no url, no getSession) has no target: the caller falls back to invoke.
    assert.equal(edge.edgeStreamTargetOf(fakeEdgeClient(async () => ({ data: null, error: null }))), null);
  });
});

describe('requestAssist with onProgress', () => {
  // A minimal valid body.
  const body = { instruction: 'x', job: { title: '', company: '', missing: [] }, summary: null, bullets: [], skills: '', categories: [], history: [] };
  // A client the stream path can use: url, key and a session.
  const streamable = () => {
    // The shared fake, whose invoke must never be reached on this path.
    const base = fakeEdgeClient(async () => { throw new Error('invoke must not be called on the stream path'); });
    // Plus what edgeStreamTargetOf reads.
    return { ...base, supabaseUrl: 'https://p.supabase.co', supabaseKey: 'k', auth: { ...base.auth, getSession: async () => ({ data: { session: { access_token: 'jwt' } }, error: null }) } };
  };

  // Runs one ask with globalThis.fetch answering `response`.
  async function askWith(response: Response, onProgress: (p: unknown) => void) {
    // The real fetch, restored after.
    const real = globalThis.fetch;
    // The double.
    globalThis.fetch = async () => response;
    // The ask, fetch restored whatever happens.
    try { return await ai.requestAssist(streamable(), body, onProgress); } finally { globalThis.fetch = real; }
  }

  it('streams progress and returns the result', async () => {
    // Progress seen.
    const seen: unknown[] = [];
    // The streamed answer.
    const result = await askWith(new Response(stream, { headers: { 'Content-Type': 'application/x-ndjson' } }), (p) => seen.push(p));
    // Same result, four progress updates.
    assert.deepEqual([result, seen.length], [okResult, 4]);
  });

  it('an old server answering plain JSON gives exactly today\'s result and no progress', async () => {
    // Progress seen.
    const seen: unknown[] = [];
    // The JSON answer.
    const result = await askWith(Response.json(okBody), (p) => seen.push(p));
    // Identical to the JSON path, nothing streamed.
    assert.deepEqual([result, seen], [okResult, []]);
  });

  it('an early plain-JSON error keeps the function\'s own message', async () => {
    // A 400 before Gemini.
    const result = await askWith(Response.json({ status: 'bad_request', message: 'The instruction is empty.' }, { status: 400 }), () => undefined);
    // Verbatim.
    assert.deepEqual(result, { kind: 'error', message: 'The instruction is empty.' });
  });
});
