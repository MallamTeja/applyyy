/**
 * A revoked session in the browser (2026-11-07). A script's logout?scope=global deleted every one of
 * Teja's sessions; his tab kept an unexpired JWT, so resume-assist answered 401 `invalid_session` and
 * the AI chat printed that raw code. These tests pin the one shared fix in src/data/edgeCall.ts:
 * refresh once, retry once, else sign out THIS browser only and say so in plain words.
 *
 * The doubles behave like the real dependencies: invoke RETURNS { data, error } (never throws for an
 * HTTP error), and its error is supabase-js's own FunctionsHttpError around a real fetch Response;
 * refreshSession and signOut return { data, error } / { error } and never throw.
 */
// Node's own runner and strict asserts, as every web test here uses.
import assert from 'node:assert/strict';
// describe/it from the same runner.
import { describe, it } from 'node:test';
// File reads for the one source-shape check on the hook (the hook needs a DOM to run).
import { readFileSync } from 'node:fs';
// The real error class, so the double's error is exactly what supabase-js hands back on a non-2xx.
import { FunctionsHttpError } from '@supabase/supabase-js';
// The unit under test and its plain sentence.
import { invokeEdge, SIGNED_OUT_MESSAGE, signOutThisBrowser } from '../src/data/edgeCall.ts';
// The AI chat's ask, to prove the chat routes through the helper end to end.
import { requestAssist } from '../src/features/approval/aiEdit.ts';

// A non-2xx answer the way functions-js builds one: the raw Response, body unread, behind `context`.
function httpError(status: number, body: unknown): { data: null; error: FunctionsHttpError } {
  // A real Response, so json() and clone() behave as in the browser (a body reads once).
  const response = new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  // functions-js returns, never throws, with data null on an HTTP error.
  return { data: null, error: new FunctionsHttpError(response) };
}

// The exact body the edge gate sends for a revoked session (_shared/db/gates.ts via resume-assist).
const revoked = () => httpError(401, { status: 'unauthorized', message: 'invalid_session' });

// A fake client that answers invoke from a script and counts every auth call.
function fakeClient(answers: Array<{ data: unknown; error: unknown }>, refreshOk: boolean) {
  // What the helper did, read by the asserts.
  const calls = { invoke: 0, refresh: 0, signOut: [] as unknown[] };
  // Only the slice the helper touches, shaped like supabase-js.
  const client = {
    functions: {
      // Each call takes the next scripted answer; running out is a test bug, so it throws loudly.
      invoke: async () => {
        // Counted before answering so a retry is visible.
        calls.invoke += 1;
        // The next answer in order.
        const next = answers.shift();
        // A missing answer means the helper called more than the test allowed.
        if (next === undefined) throw new Error('invoke called more times than scripted');
        // Returned, never thrown, as the real invoke does.
        return next;
      },
    },
    auth: {
      // The real refreshSession returns { data, error }; a revoked refresh token gives an error.
      refreshSession: async () => {
        // Counted so "exactly one refresh" can be asserted.
        calls.refresh += 1;
        // Success carries a session; failure carries an error and null session, as auth-js does.
        return refreshOk
          ? { data: { session: { access_token: 'new' }, user: { id: 'u' } }, error: null }
          : { data: { session: null, user: null }, error: { name: 'AuthApiError', message: 'Invalid Refresh Token: Refresh Token Not Found', status: 400 } };
      },
      // The real signOut returns { error }; the options are recorded to check the scope.
      signOut: async (options?: unknown) => {
        // Recorded verbatim.
        calls.signOut.push(options);
        // Local sign-out succeeds.
        return { error: null };
      },
    },
  };
  // Both handed to the test.
  return { client, calls };
}

describe('invokeEdge: a revoked session', () => {
  it('(a) 401 invalid_session then 200 after a good refresh: one refresh, one retry, the answer returned', async () => {
    // The 401, then the answer the retry gets.
    const { client, calls } = fakeClient([revoked(), { data: { status: 'ok' }, error: null }], true);
    // The call.
    const result = await invokeEdge(client, 'resume-assist', { body: {} });
    // The retry's answer reaches the caller.
    assert.deepEqual(result, { kind: 'answered', data: { status: 'ok' }, error: null });
    // Exactly one refresh.
    assert.equal(calls.refresh, 1);
    // The first call plus exactly one retry.
    assert.equal(calls.invoke, 2);
    // Nobody was signed out.
    assert.equal(calls.signOut.length, 0);
  });

  it('missing_bearer_token is treated the same as invalid_session', async () => {
    // The other code the gate sends when no token went out.
    const { client, calls } = fakeClient([httpError(401, { status: 'unauthorized', message: 'missing_bearer_token' }), { data: 1, error: null }], true);
    // The call.
    const result = await invokeEdge(client, 'resume-assist', { body: {} });
    // Retried and answered.
    assert.deepEqual(result, { kind: 'answered', data: 1, error: null });
    // One refresh.
    assert.equal(calls.refresh, 1);
  });

  it('(b) the refresh fails: signOut once with scope local, the plain message, no retry', async () => {
    // Only the first call is scripted: a retry would throw.
    const { client, calls } = fakeClient([revoked()], false);
    // The call.
    const result = await invokeEdge(client, 'resume-assist', { body: {} });
    // The plain sentence, never the raw code.
    assert.deepEqual(result, { kind: 'signed_out', message: SIGNED_OUT_MESSAGE });
    // Local only: a global sign-out kills the worker's and CI's sessions.
    assert.deepEqual(calls.signOut, [{ scope: 'local' }]);
    // No retry.
    assert.equal(calls.invoke, 1);
    // The message names no code.
    assert.equal(/invalid_session|missing_bearer_token/.test(SIGNED_OUT_MESSAGE), false);
  });

  it('(c) a 401 with another code: no refresh, the error passes through unchanged and still readable', async () => {
    // The gateway's own JWT refusal is not a revoked session.
    const answer = httpError(401, { code: 401, message: 'Invalid JWT' });
    // Scripted once.
    const { client, calls } = fakeClient([answer], true);
    // The call.
    const result = await invokeEdge(client, 'resume-assist', { body: {} });
    // The same objects the caller would have got without the helper.
    assert.equal(result.kind, 'answered');
    // Narrowed for the reads below.
    if (result.kind !== 'answered') return;
    // Unchanged identity.
    assert.equal(result.error, answer.error);
    // The body was read from a clone, so the caller's own reader still gets it.
    assert.deepEqual(await (result.error as FunctionsHttpError).context.json(), { code: 401, message: 'Invalid JWT' });
    // No refresh, no sign-out.
    assert.equal(calls.refresh, 0);
    // Same.
    assert.equal(calls.signOut.length, 0);
  });

  it('(d) a second 401 after a good refresh is final: no second refresh', async () => {
    // Two revoked answers; a third call would throw.
    const { client, calls } = fakeClient([revoked(), revoked()], true);
    // The call.
    const result = await invokeEdge(client, 'resume-assist', { body: {} });
    // One refresh only.
    assert.equal(calls.refresh, 1);
    // First call plus one retry.
    assert.equal(calls.invoke, 2);
    // The refresh "worked" yet the server still refuses: the session is gone, so sign out locally.
    assert.deepEqual(result, { kind: 'signed_out', message: SIGNED_OUT_MESSAGE });
    // Local scope.
    assert.deepEqual(calls.signOut, [{ scope: 'local' }]);
  });
});

describe('the AI chat on a revoked session', () => {
  it('requestAssist shows the plain signed-out sentence, never "invalid_session"', async () => {
    // A failed refresh: the global logout revoked the refresh token too.
    const { client } = fakeClient([revoked()], false);
    // The chat's ask, with the smallest valid body.
    const result = await requestAssist(client, { instruction: 'x', job: { title: '', company: '', missing: [] }, summary: null, bullets: [], skills: '', categories: [], history: [] });
    // The plain sentence.
    assert.deepEqual(result, { kind: 'error', message: SIGNED_OUT_MESSAGE });
  });
});

describe('sign-out scope', () => {
  it('(e) signOutThisBrowser signs out with scope local', async () => {
    // A recording double.
    const seen: unknown[] = [];
    // Returns { error } like auth-js.
    await signOutThisBrowser({ signOut: async (options?: unknown) => { seen.push(options); return { error: null }; } });
    // Local only.
    assert.deepEqual(seen, [{ scope: 'local' }]);
  });

  it("(e) useAuth's Sign out button goes through signOutThisBrowser, not a default (global) signOut", () => {
    // The hook needs a DOM to render, so its wiring is checked in its source.
    const source = readFileSync(new URL('../src/data/useAuth.ts', import.meta.url), 'utf8');
    // The positive shape: the hook's sign-out awaits the local helper with its client.
    assert.match(source, /await signOutThisBrowser\(client\)/);
    // And no direct call that would default to the global scope.
    assert.equal((source.match(/client\.signOut\(/g) ?? []).length, 0);
  });
});
