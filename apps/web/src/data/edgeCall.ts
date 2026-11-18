/**
 * One edge-function call that survives a session revoked elsewhere (2026-11-07).
 *
 * WHY: at 05:34:47 UTC a script called logout?scope=global as Teja, which deleted every one of his
 * sessions. His tab still held an unexpired JWT, so the edge gate's getUser() failed and resume-assist
 * answered 401 `invalid_session`; the AI chat printed that raw code. A global logout also revokes the
 * refresh token, so a refresh can fail too.
 *
 * The rule here: on a 401 whose body names a session problem, refresh ONCE and retry ONCE. A second
 * 401, or a failed refresh, is final: sign out THIS browser only and hand the caller a plain sentence.
 * Never a loop, never the raw code on screen.
 */

// The real error classes, so the streaming call's errors are exactly what invoke would have returned.
import { FunctionsFetchError, FunctionsHttpError, FunctionsRelayError } from '@supabase/supabase-js';

// The sentence the caller shows when the session is gone; exported so the test pins it.
export const SIGNED_OUT_MESSAGE = 'You were signed out (your session ended elsewhere). Sign in again.';

// The two 401 codes the edge gate sends for a session problem (supabase/functions/_shared/db/gates.ts).
const SESSION_CODES: ReadonlySet<string> = new Set(['invalid_session', 'missing_bearer_token']);

/* The slice of supabase-js the helper calls; structural, so a test passes a fake. Every method
   RETURNS its error (supabase-js never throws for an HTTP or auth error). */
export interface EdgeClient {
  readonly functions: {
    // supabase-js adds the CURRENT session's token on every call, so a retry after a refresh sends the new one.
    // Options are optional: three callers send no body at all, and must keep sending none.
    // `response` is the raw Response newer supabase-js returns beside data; the row pipeline reads its status.
    invoke(name: string, options?: { body: Record<string, unknown> }): Promise<{ data: unknown; error: unknown; response?: unknown }>;
  };
  readonly auth: {
    // Trades the refresh token for a new session; fails with { error } when the token was revoked.
    refreshSession(): Promise<{ error: unknown }>;
    // Used only with { scope: 'local' }; see signOutThisBrowser.
    signOut(options?: { scope?: 'global' | 'local' | 'others' }): Promise<{ error: unknown }>;
  };
}

/* What the caller gets: the call's own { data, error } untouched, or the session-is-gone case.
   A closed union so a caller cannot read `data` off a signed-out result. */
export type EdgeCallResult =
  // The function answered (2xx or any error that is not a session problem): exactly what invoke returned.
  // Spread from invoke's own result, so `response` is there exactly when the SDK gave one and no caller loses the status.
  | { readonly kind: 'answered'; readonly data: unknown; readonly error: unknown; readonly response?: unknown }
  // The session could not be recovered; this browser is now signed out.
  | { readonly kind: 'signed_out'; readonly message: string };

/* Sign out THIS browser only. supabase-js's signOut() defaults to scope 'global', which revokes
   every session of the account, including the worker's and CI's mid-run (Teja's 05:33:21 browser
   sign-out did exactly that). 'local' clears this tab's tokens and fires SIGNED_OUT here only. */
// Generic over the result so useAuth keeps supabase-js's own { error: AuthError | null } type.
export async function signOutThisBrowser<R>(auth: { signOut(options: { scope: 'local' }): Promise<R> }): Promise<R> {
  // The only sign-out call in the web app; the scope is the whole point.
  return auth.signOut({ scope: 'local' });
}

/* True when the error is a 401 whose JSON body names a session problem. Reads a CLONE of the
   Response, because a body reads only once and the caller's own reader must still get it. */
async function isSessionRefusal(error: unknown): Promise<boolean> {
  // functions-js puts the raw Response behind `context`; other error kinds have none.
  const context = typeof error === 'object' && error !== null ? (error as { context?: unknown }).context : null;
  // Must be an object to carry a status.
  if (typeof context !== 'object' || context === null) return false;
  // Only a 401 can be a session refusal; anything else is never read here.
  if ((context as { status?: unknown }).status !== 401) return false;
  // A Response without clone() cannot be read without stealing the caller's body.
  if (typeof (context as { clone?: unknown }).clone !== 'function') return false;
  // A non-JSON 401 (a proxy page) must not throw out of the call.
  try {
    // Called as a method so `this` is the Response.
    const body: unknown = await (context as { clone(): { json(): Promise<unknown> } }).clone().json();
    // The gate's shape is { status: 'unauthorized', message: <code> }.
    const message = typeof body === 'object' && body !== null ? (body as { message?: unknown }).message : null;
    // Only the two named codes; the gateway's "Invalid JWT" and others pass through.
    return typeof message === 'string' && SESSION_CODES.has(message);
  } catch {
    // Unreadable body: not provably a session problem, so the caller sees the error as is.
    return false;
  }
}

/* Call an edge function; on a session 401, refresh once and retry once. Never throws on its own
   account (invoke's own throws, which supabase-js does not do, reach the caller unchanged). */
export async function invokeEdge(client: EdgeClient, name: string, options?: { body: Record<string, unknown> }): Promise<EdgeCallResult> {
  // The first attempt.
  const first = await client.functions.invoke(name, options);
  // Anything but a session 401 is the caller's to read.
  if (!(await isSessionRefusal(first.error))) return { kind: 'answered', ...first };
  // One refresh: a token that simply expired comes back here.
  const refreshed = await client.auth.refreshSession();
  // A revoked refresh token (global logout) cannot recover; stop before any retry.
  if (refreshed.error !== null && refreshed.error !== undefined) return signedOut(client);
  // One retry, carrying the new token.
  const second = await client.functions.invoke(name, options);
  // Still a session 401 after a good refresh: final, no second refresh.
  if (await isSessionRefusal(second.error)) return signedOut(client);
  // The retry's answer, whatever it is.
  return { kind: 'answered', ...second };
}

/* The give-up path: clear this browser's session so the app shows sign-in, then the plain sentence. */
async function signedOut(client: EdgeClient): Promise<EdgeCallResult> {
  // Its own error is ignored: the session is already dead server-side, and local clearing does not need the server.
  await signOutThisBrowser(client.auth);
  // The caller shows this, never the raw code.
  return { kind: 'signed_out', message: SIGNED_OUT_MESSAGE };
}

/* ---------------------------------------------------------------------------------------------------------
 * The streaming call (2026-11-18, resume chat latency fixes 3 and 5).
 *
 * WHY its own fetch: supabase-js's invoke reads any non-JSON body with text(), which waits for the WHOLE
 * stream, so the reply could not appear while Gemini writes. This posts the same request invoke would
 * (same URL, apikey, bearer token) plus `Accept: application/x-ndjson`, and hands back the body reader when
 * the server streams. Any other answer is shaped exactly as invoke returns it, so an old server (JSON) and an
 * early error (plain JSON, non-2xx) go through the caller's existing reader unchanged. Same session rule as
 * invokeEdge: a session 401 refreshes once and retries once, else this browser signs out.
 * ------------------------------------------------------------------------------------------------------- */

// The content type resume-assist streams in; anything else is read the way invoke reads it.
const NDJSON = 'application/x-ndjson';

/* Where and as whom the raw fetch goes. A plain object, so a test hands one in without a supabase client. */
export interface EdgeStreamTarget {
  // The project URL (https://<ref>.supabase.co), as the client was created with.
  readonly url: string;
  // The anon key: the gateway wants it as `apikey`, and it is the bearer when there is no session (as supabase-js does).
  readonly apikey: string;
  // The CURRENT session's access token, read per request so a retry after a refresh carries the new one.
  accessToken(): Promise<string | null>;
}

/* The streaming call's answer: the body reader when the server streams, otherwise invokeEdge's own union. */
export type EdgeStreamResult = { readonly kind: 'stream'; readonly reader: ReadableStreamDefaultReader<Uint8Array> } | EdgeCallResult;

/* The stream target of a supabase-js client, or null when it lacks one (a test fake, a future SDK that renamed
   the fields). supabase-js keeps `supabaseUrl`/`supabaseKey` as `protected` instance fields: present at run time,
   hidden from the type, so they are read through `unknown` and shape-checked here; null makes the caller use
   plain invoke, which still works, only without live progress. */
export function edgeStreamTargetOf(client: EdgeClient): EdgeStreamTarget | null {
  // The run-time view of the client; every field is checked before use.
  const raw = client as unknown as { supabaseUrl?: unknown; supabaseKey?: unknown; auth: { getSession?: unknown } };
  // Both must be non-empty strings, or there is no request to build.
  if (typeof raw.supabaseUrl !== 'string' || raw.supabaseUrl === '' || typeof raw.supabaseKey !== 'string' || raw.supabaseKey === '') return null;
  // No getSession means no token source; the stream path would send the anon key and be refused.
  if (typeof raw.auth.getSession !== 'function') return null;
  // Narrowed copy, typed with only the fields read below (each is checked again at run time).
  const getSession = raw.auth.getSession as () => Promise<{ data?: { session?: { access_token?: unknown } | null } }>;
  // The target.
  return {
    // Copied as is; the URL join in postOnce adds the slash.
    url: raw.supabaseUrl,
    // Same.
    apikey: raw.supabaseKey,
    // auth-js refreshes an expired token inside getSession, so this is the token invoke would send.
    accessToken: async () => {
      // Called on auth so `this` is the auth client.
      const { data } = await getSession.call(raw.auth);
      // The token, only when it is a string.
      const token = data?.session?.access_token;
      // No session: the caller falls back to the anon key, as supabase-js does.
      return typeof token === 'string' && token !== '' ? token : null;
    },
  };
}

/* One POST, answered as a stream or in invoke's own { data, error } shape. Never throws. */
async function postOnce(target: EdgeStreamTarget, name: string, body: Record<string, unknown>, fetchImpl: typeof fetch): Promise<EdgeStreamResult> {
  // The functions endpoint, joined the way supabase-js joins it (trailing slash, then a relative path).
  const url = new URL(`functions/v1/${name}`, target.url.endsWith('/') ? target.url : `${target.url}/`).href;
  // A failed token read (storage blocked) is a failed request, never a throw out of the chat.
  try {
    // The bearer: the session's token, else the anon key exactly as supabase-js sends with no session.
    const token = (await target.accessToken()) ?? target.apikey;
    // The request invoke would send, plus the streaming opt-in (an old server ignores the header).
    const response = await fetchImpl(url, {
      // resume-assist takes a JSON body over POST.
      method: 'POST',
      // The gateway and the edge gate read these.
      headers: { Authorization: `Bearer ${token}`, apikey: target.apikey, 'Content-Type': 'application/json', Accept: NDJSON },
      // The caller's body, serialized as invoke would.
      body: JSON.stringify(body),
    });
    // The relay's own failure, as invoke reports it.
    if (response.headers.get('x-relay-error') === 'true') return { kind: 'answered', data: null, error: new FunctionsRelayError(response), response };
    // Non-2xx: the Response rides behind error.context, where every caller's error reader looks.
    if (!response.ok) return { kind: 'answered', data: null, error: new FunctionsHttpError(response), response };
    // The bare media type, parameters (charset) dropped, as invoke compares it.
    const type = (response.headers.get('Content-Type') ?? 'text/plain').split(';')[0]?.trim();
    // The server streams: hand the body over unread.
    if (type === NDJSON && response.body !== null) return { kind: 'stream', reader: response.body.getReader() };
    // Anything else is read as invoke reads it: JSON parsed, everything else as text.
    const data: unknown = type === 'application/json' ? await response.json() : await response.text();
    // The old server's answer, in the shape the caller already reads.
    return { kind: 'answered', data, error: null, response };
  } catch (cause) {
    // A network drop or an unparsable body: invoke returns it as an error too.
    return { kind: 'answered', data: null, error: new FunctionsFetchError(cause) };
  }
}

/* Call an edge function asking for a stream; on a session 401, refresh once and retry once (invokeEdge's rule).
   `fetchImpl` is a parameter only so tests answer with a real Response; the app passes nothing. */
export async function invokeEdgeStream(
  // Its auth refreshes the session and signs out, exactly as invokeEdge uses it.
  client: EdgeClient,
  // Where the raw fetch goes and with which token (edgeStreamTargetOf).
  target: EdgeStreamTarget,
  // The edge function's name.
  name: string,
  // The JSON body.
  body: Record<string, unknown>,
  // Looked up at call time (not captured at import), so a test's stub of the global is honoured too.
  fetchImpl: typeof fetch = (input, init) => fetch(input, init),
): Promise<EdgeStreamResult> {
  // The first attempt.
  const first = await postOnce(target, name, body, fetchImpl);
  // A stream, or anything but a session 401, is the caller's to read.
  if (first.kind !== 'answered' || !(await isSessionRefusal(first.error))) return first;
  // One refresh: a token that simply expired comes back here.
  const refreshed = await client.auth.refreshSession();
  // A revoked refresh token cannot recover; stop before any retry.
  if (refreshed.error !== null && refreshed.error !== undefined) return signedOut(client);
  // One retry; accessToken() now reads the refreshed session.
  const second = await postOnce(target, name, body, fetchImpl);
  // Still a session 401 after a good refresh: final, no second refresh.
  if (second.kind === 'answered' && (await isSessionRefusal(second.error))) return signedOut(client);
  // The retry's answer, whatever it is.
  return second;
}
