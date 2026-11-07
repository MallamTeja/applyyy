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
