// THE TWO GATES EVERY PIPELINE AGENT PASSES BEFORE IT DOES ANY WORK.
//
// Kept in one file, apart from `client.ts`, for a mechanical reason: `client.ts` imports
// `jsr:@supabase/supabase-js`, which `node --test` cannot resolve. These gates are pure
// over narrow seams, so their tests run in the same suite as everything else.
//
// GATE 1 — WHO IS CALLING. `createAppUserClient()` signs in with the app user's env
// credentials and never looks at the request, so before this gate ANYONE holding the
// public anon key (it ships in the browser bundle) could drive the pipeline: the
// platform's `verify_jwt` accepts the anon key because it is itself a valid JWT. The
// gate demands a real user session and that it be the one app user's session.
// Two variants: `authorizeCaller` runs after the sign-in (it compares ids), and
// `authorizeBeforeSignIn` runs before it (W15: a refused caller costs no password grant).
//
// GATE 2 — THE KILL SWITCH. Each agent used to read `system_settings` its own way: the
// screener halted on a missing row, the normalizer ran on one and ignored read errors,
// and the matcher, tailor and auditor never looked. One helper, one fail-closed rule.

// The slice of `supabase.auth` gate 1 needs. Narrow so a test can fake it.
export interface CallerAuthClient {
  readonly auth: {
    // `getUser(jwt)` asks the auth server, so an expired, forged or anon token fails here
    // — a local decode would happily accept a token signed for a different project.
    getUser(jwt: string): PromiseLike<{
      // `email` is optional because supabase-js types it so (phone and anonymous users have
      // none); authorizeBeforeSignIn compares it, authorizeCaller ignores it.
      readonly data: { readonly user: { readonly id: string; readonly email?: string } | null };
      readonly error: { readonly message: string } | null;
    }>;
  };
}

// The verdict. A closed union rather than a boolean, so the HTTP status travels with it
// and no caller can collapse "no token" and "wrong user" into the same answer.
export type CallerVerdict =
  // A session belonging to the app user. The function may proceed.
  | { readonly ok: true; readonly userId: string }
  // 401: no credential, or one the auth server would not vouch for.
  | { readonly ok: false; readonly status: 401; readonly error: "missing_bearer_token" | "invalid_session" }
  // 403: a real user, but not the one whose data this function acts on.
  | { readonly ok: false; readonly status: 403; readonly error: "caller_is_not_app_user" };

// `Bearer <token>`, one token, nothing else. Validated by shape rather than by slicing
// a prefix off, because a header of just "Bearer " would otherwise yield an empty token
// that only fails one network round trip later.
const BEARER_SHAPE = /^Bearer\s+(\S+)\s*$/i;

// The bearer token, or null when the header is absent or malformed. Shared by both gate-1
// variants so they cannot disagree about what counts as "a token".
function readBearer(req: Request): string | null {
  // Absent header and malformed header are the same failure to the caller.
  const match = BEARER_SHAPE.exec(req.headers.get("authorization") ?? "");
  // The captured group; `?? null` covers the undefined the type system allows and the
  // shape above rules out.
  return match?.[1] ?? null;
}

// Gate 1. Run before any read or write on the app user's data.
export async function authorizeCaller(
  req: Request,
  client: CallerAuthClient,
  appUserId: string,
): Promise<CallerVerdict> {
  // The token, validated by shape.
  const token = readBearer(req);
  // No token at all: refuse without spending a call on the auth server.
  if (token === null) return { ok: false, status: 401, error: "missing_bearer_token" };

  // Ask the auth server. The anon key has no `sub` claim and is refused here, which is
  // precisely the caller this gate exists to stop.
  const { data, error } = await client.auth.getUser(token);
  // Either an error or a null user is "not a session we can trust" — checked together so
  // a response carrying neither cannot slip through as success.
  if (error !== null || data.user === null) return { ok: false, status: 401, error: "invalid_session" };

  // A valid session for SOMEONE ELSE. RLS would already confine them, but these
  // functions act through the app user's own session, so their RLS is not the caller's.
  if (data.user.id !== appUserId) return { ok: false, status: 403, error: "caller_is_not_app_user" };

  // The app user, verified by the auth server.
  return { ok: true, userId: data.user.id };
}

// What a password sign-in yields: the same union `client.ts#DbClientResult` is, generic
// over the client so a test can sign in with a string instead of a real SupabaseClient.
export type SignInResult<Db> =
  // Signed in; `userId` is the id the sign-in returned.
  | { readonly ok: true; readonly db: Db; readonly userId: string }
  // Could not sign in; `reason` is for the server log only.
  | { readonly ok: false; readonly reason: string };

// The verdict of gate 1 run BEFORE the sign-in. Two failure kinds, because the entry
// points answer them differently: `refused` is the caller's fault (401/403, the same
// bodies authorizeCaller produces), `unavailable` is ours (503, reason only in the log).
export type AuthorizedSignIn<Db> =
  // An authorized caller, and a client signed in as the app user.
  | { readonly ok: true; readonly db: Db; readonly userId: string }
  // The caller was refused. No password grant was spent on them.
  | { readonly ok: false; readonly kind: "refused"; readonly status: 401 | 403; readonly error: Extract<CallerVerdict, { ok: false }>["error"] }
  // The caller was fine, but the sign-in failed.
  | { readonly ok: false; readonly kind: "unavailable"; readonly reason: string };

// W15 (wiring audit 2026-11-01). Gate 1, run BEFORE the password sign-in.
//
// WHY THE ORDER MATTERS: the sign-in is a GoTrue password grant, rate-limited per IP.
// authorizeCaller needs the app user's id, which only the sign-in returned, so every
// caller ran the grant first: a loop of tokenless requests against a verify_jwt=false
// function spent one grant each and could rate-limit the pipeline's own sign-ins (503).
// Here the caller is checked against the app user's EMAIL instead (already a secret,
// APPLYY_APP_USER_EMAIL), so no new secret is needed and a refused caller costs no grant.
export async function authorizeBeforeSignIn<Db>(
  req: Request,
  // Any client that can ask the auth server about a token; an anon-key client suffices.
  verifier: CallerAuthClient,
  // The app user's email, from the secret.
  appUserEmail: string,
  // The password sign-in, called only once the caller has passed.
  signIn: () => Promise<SignInResult<Db>>,
): Promise<AuthorizedSignIn<Db>> {
  // The token, validated by shape.
  const token = readBearer(req);
  // No token: refused locally, no auth-server call and no grant.
  if (token === null) return { ok: false, kind: "refused", status: 401, error: "missing_bearer_token" };

  // /auth/v1/user verifies the token's signature and expiry server-side; it is a token
  // check, not a password grant, so it is not the rate limit W15 is about.
  const { data, error } = await verifier.auth.getUser(token);
  // An error or a null user is "not a session we can trust", checked together as above.
  if (error !== null || data.user === null) return { ok: false, kind: "refused", status: 401, error: "invalid_session" };

  // GoTrue stores emails lowercased; the secret may carry case or padding. A user with no
  // email (phone, anonymous) has nothing to match and is refused, never waved through.
  const callerEmail = typeof data.user.email === "string" ? data.user.email.trim().toLowerCase() : null;
  // A real session for someone else: 403, as authorizeCaller says it.
  if (callerEmail === null || callerEmail !== appUserEmail.trim().toLowerCase()) {
    return { ok: false, kind: "refused", status: 403, error: "caller_is_not_app_user" };
  }

  // The caller is the app user: only now spend the password grant.
  const connection = await signIn();
  // Our failure, not the caller's; the reason stays for the server log.
  if (!connection.ok) return { ok: false, kind: "unavailable", reason: connection.reason };
  // The id check authorizeCaller made, kept: an email is reusable after a user is deleted
  // and re-created, an id is not. Costs no network call; the sign-in already returned it.
  if (data.user.id !== connection.userId) return { ok: false, kind: "refused", status: 403, error: "caller_is_not_app_user" };

  // Authorized, and signed in.
  return { ok: true, db: connection.db, userId: connection.userId };
}

// The slice of postgrest gate 2 needs — the same shape as `screen/supabase-queries.ts`.
export interface KillSwitchClient {
  from(table: string): {
    select(columns: string): PromiseLike<{ data: unknown[] | null; error: { message: string } | null }>;
  };
}

// What the switch says. Three states, not two: "unreadable" is NOT "off" — it is an
// error the health page must show as one, and NOT "on", because then a failing read
// would run the pipeline.
export type KillSwitchState =
  | { readonly kind: "enabled" }
  // Explicitly off, or no settings row at all. Both halt; neither is an error.
  | { readonly kind: "disabled"; readonly detail: string }
  // The read itself failed. Halts, and reports.
  | { readonly kind: "unreadable"; readonly detail: string };

// Gate 2. FAIL CLOSED: anything but a readable row saying exactly `true` halts.
export async function readKillSwitch(client: KillSwitchClient): Promise<KillSwitchState> {
  // No `.single()`: it turns "no row" into an error code callers then have to special
  // case (PGRST116), which is how the normalizer ended up ignoring every error.
  const { data, error } = await client.from("system_settings").select("system_enabled");
  // A failed read is reported as such, never mistaken for a decision.
  if (error !== null) return { kind: "unreadable", detail: error.message };
  // No row under RLS means bootstrap never ran for this user. The column defaults to
  // false (core_tables.sql:33), so "no row" honours the same default: off.
  if (data === null || data.length === 0) return { kind: "disabled", detail: "no system_settings row" };
  // Strict `=== true` on every row: a null, a string "true", or a second row saying
  // false all halt. §5 — validate the shape, never ask a lenient reader.
  const allOn = data.every((row) =>
    typeof row === "object" && row !== null && (row as { system_enabled?: unknown }).system_enabled === true
  );
  // Off, with the reason the health page shows.
  if (!allOn) return { kind: "disabled", detail: "system_settings.system_enabled is false" };
  // Readable, present, and explicitly on.
  return { kind: "enabled" };
}
