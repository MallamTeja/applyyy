// Tests for the two pre-work gates every pipeline agent passes.
//
// Gate 1 (caller auth) is a security control, so each refusal branch is asserted by its
// STATUS as well as its outcome: a 401 and a 403 tell an operator different things, and
// collapsing them is how a "wrong user" bug gets debugged as a "expired token" bug.
// Gate 2 (kill switch) is asserted fail-closed on every non-happy input.
import { test } from "node:test";
// Strict, so a missing key never equals a key holding `undefined`.
import assert from "node:assert/strict";
// Extension-suffixed so this runs under Deno and `node --test` alike.
import {
  // Gate 1 for the functions that still sign in first and compare ids after.
  authorizeCaller,
  // W15: gate 1 run BEFORE the password sign-in, so a refused caller costs no grant.
  authorizeBeforeSignIn,
  // Gate 2.
  readKillSwitch,
  // The fake auth server's shape.
  type CallerAuthClient,
  // The fake settings read's shape.
  type KillSwitchClient,
  // The sign-in seam's result, so the double returns exactly what the real one can.
  type SignInResult,
} from "./gates.ts";
// W15 shape test: reads the four entry points as text, because index.ts runs Deno.serve on import.
import { readFileSync } from "node:fs";

// The one identity the functions act as.
const APP_USER_ID = "00000000-0000-0000-0000-00000000a99a";

// A fake auth server that knows one token per user, and records what it was asked.
function authClient(tokens: Record<string, string>) {
  // Tokens actually sent to the server, to prove a missing header never costs a call.
  const asked: string[] = [];
  const client: CallerAuthClient = {
    auth: {
      getUser: (jwt: string) => {
        asked.push(jwt);
        // An unknown token is refused the way supabase-js refuses one: error + null user.
        const id = tokens[jwt];
        return Promise.resolve(
          id === undefined
            ? { data: { user: null }, error: { message: "invalid JWT" } }
            : { data: { user: { id } }, error: null },
        );
      },
    },
  };
  return { client, asked };
}

// A request with an optional Authorization header.
function request(authorization?: string): Request {
  // Only the header matters to the gate; the URL is a placeholder.
  return new Request("https://example.test/functions/v1/screener", {
    headers: authorization === undefined ? {} : { authorization },
  });
}

test("the app user's own session is admitted", async () => {
  const { client } = authClient({ "good-token": APP_USER_ID });

  const verdict = await authorizeCaller(request("Bearer good-token"), client, APP_USER_ID);

  assert.deepEqual(verdict, { ok: true, userId: APP_USER_ID });
});

test("no Authorization header is a 401 and never reaches the auth server", async () => {
  const { client, asked } = authClient({});

  const verdict = await authorizeCaller(request(), client, APP_USER_ID);

  assert.deepEqual(verdict, { ok: false, status: 401, error: "missing_bearer_token" });
  // Refused locally: an empty token must not become a network round trip.
  assert.deepEqual(asked, []);
});

test("a header with an empty bearer is a 401", async () => {
  const { client } = authClient({});

  // "Bearer " with nothing after it — the slice-off-a-prefix trap.
  const verdict = await authorizeCaller(request("Bearer "), client, APP_USER_ID);

  assert.equal(verdict.ok, false);
  assert.equal(verdict.ok === false && verdict.status, 401);
});

test("the anon key, or any token the auth server rejects, is a 401", async () => {
  // The anon key is a valid JWT to the gateway but has no user; the server refuses it.
  const { client } = authClient({});

  const verdict = await authorizeCaller(request("Bearer anon-key-jwt"), client, APP_USER_ID);

  assert.deepEqual(verdict, { ok: false, status: 401, error: "invalid_session" });
});

test("a real session for a different user is a 403, not a 401", async () => {
  const { client } = authClient({ "other-token": "ffffffff-0000-0000-0000-000000000000" });

  const verdict = await authorizeCaller(request("Bearer other-token"), client, APP_USER_ID);

  // Authenticated, but not entitled — the distinction is the point of two codes.
  assert.deepEqual(verdict, { ok: false, status: 403, error: "caller_is_not_app_user" });
});

// A fake settings read returning a fixed response.
function settingsClient(response: { data: unknown[] | null; error: { message: string } | null }): KillSwitchClient {
  // Only the one table/column the gate reads; anything else would be a bug in the gate.
  return { from: () => ({ select: () => Promise.resolve(response) }) };
}

test("the kill switch is enabled only by a row saying exactly true", async () => {
  const state = await readKillSwitch(settingsClient({ data: [{ system_enabled: true }], error: null }));

  assert.deepEqual(state, { kind: "enabled" });
});

test("the kill switch halts on false, on no row, and on a non-boolean", async () => {
  // Explicitly off.
  assert.equal((await readKillSwitch(settingsClient({ data: [{ system_enabled: false }], error: null }))).kind, "disabled");
  // No row: the normalizer used to RUN here. Fail closed.
  assert.equal((await readKillSwitch(settingsClient({ data: [], error: null }))).kind, "disabled");
  // A string is not a boolean — the lenient-reader trap from CLAUDE.md §5.
  assert.equal((await readKillSwitch(settingsClient({ data: [{ system_enabled: "true" }], error: null }))).kind, "disabled");
});

test("an unreadable kill switch is reported as unreadable, not as on or off", async () => {
  const state = await readKillSwitch(settingsClient({ data: null, error: { message: "permission denied" } }));

  // The normalizer used to ignore this error and proceed.
  assert.deepEqual(state, { kind: "unreadable", detail: "permission denied" });
});

// ---------------------------------------------------------------------------------------
// W15 (wiring audit 2026-11-01): verify the caller BEFORE the password sign-in.
//
// The sign-in is a GoTrue password grant, and GoTrue rate-limits those per IP. When the
// grant ran first, a loop of tokenless requests spent one grant each and could lock the
// pipeline's own sign-ins out (503). Every refusal below therefore asserts TWO things:
// the status, and that the sign-in double was never called.
// ---------------------------------------------------------------------------------------

// The app user's address as the APPLYY_APP_USER_EMAIL secret holds it.
const APP_USER_EMAIL = "app.user@example.test";

// A fake auth server that knows one user (id + email) per token.
function emailAuthClient(tokens: Record<string, { id: string; email?: string }>): CallerAuthClient {
  // Only getUser: the pre-check must never need anything else from the auth server.
  return {
    auth: {
      getUser: (jwt: string) => {
        // The user this token belongs to, if any.
        const user = tokens[jwt];
        // Unknown token: refused the way supabase-js refuses one (error + null user).
        return Promise.resolve(
          user === undefined
            ? { data: { user: null }, error: { message: "invalid JWT" } }
            : { data: { user }, error: null },
        );
      },
    },
  };
}

// A password sign-in double that COUNTS its calls: the count is the W15 property itself.
function signInDouble(result: SignInResult<string>) {
  // Calls so far; read through calls() after the gate returns.
  let calls = 0;
  return {
    // The seam the gate calls only for an authorized caller.
    signIn: () => {
      // Each call is one password grant against GoTrue's rate limit.
      calls += 1;
      // Resolve to the scripted outcome.
      return Promise.resolve(result);
    },
    // How many grants the gate spent.
    calls: () => calls,
  };
}

// A successful sign-in as the app user. `db` is a string because the gate never touches it.
const SIGNED_IN: SignInResult<string> = { ok: true, db: "db-handle", userId: APP_USER_ID };

test("W15: a tokenless request is a 401 and runs no password sign-in", async () => {
  // The verify_jwt=false functions accept this request at the gateway.
  const grants = signInDouble(SIGNED_IN);

  const result = await authorizeBeforeSignIn(request(), emailAuthClient({}), APP_USER_EMAIL, grants.signIn);

  // Same 401 body the entry points sent before.
  assert.deepEqual(result, { ok: false, kind: "refused", status: 401, error: "missing_bearer_token" });
  // The fix: no grant spent on a caller we refuse.
  assert.equal(grants.calls(), 0);
});

test("W15: the anon key (a token the auth server rejects) is a 401 and runs no password sign-in", async () => {
  // The anon key ships in the browser bundle; GoTrue's /user refuses it (no sub).
  const grants = signInDouble(SIGNED_IN);

  const result = await authorizeBeforeSignIn(request("Bearer anon-key-jwt"), emailAuthClient({}), APP_USER_EMAIL, grants.signIn);

  // Same 401 body as authorizeCaller's.
  assert.deepEqual(result, { ok: false, kind: "refused", status: 401, error: "invalid_session" });
  // No grant spent.
  assert.equal(grants.calls(), 0);
});

test("W15: another user's real session is a 403 and runs no password sign-in", async () => {
  // A second auth user, or one with no email at all (phone / anonymous sign-in).
  const auth = emailAuthClient({
    // A real user, wrong address.
    "other-token": { id: "ffffffff-0000-0000-0000-000000000000", email: "someone@else.test" },
    // A real user with no email: absence is not a match.
    "no-email-token": { id: "eeeeeeee-0000-0000-0000-000000000000" },
  });
  // One double per case, so each count is isolated.
  const other = signInDouble(SIGNED_IN);
  // Same, for the no-email case.
  const noEmail = signInDouble(SIGNED_IN);

  // Same 403 body as authorizeCaller's.
  assert.deepEqual(
    await authorizeBeforeSignIn(request("Bearer other-token"), auth, APP_USER_EMAIL, other.signIn),
    { ok: false, kind: "refused", status: 403, error: "caller_is_not_app_user" },
  );
  // A missing email is refused the same way, never treated as "nothing to compare".
  assert.deepEqual(
    await authorizeBeforeSignIn(request("Bearer no-email-token"), auth, APP_USER_EMAIL, noEmail.signIn),
    { ok: false, kind: "refused", status: 403, error: "caller_is_not_app_user" },
  );
  // Neither refusal spent a grant.
  assert.equal(other.calls() + noEmail.calls(), 0);
});

test("W15: the app user's session signs in exactly once (email compared case-insensitively)", async () => {
  // GoTrue stores emails lowercased; the secret may not be. Both spellings are one user.
  const auth = emailAuthClient({ "good-token": { id: APP_USER_ID, email: "app.user@example.test" } });
  // The double that should be called once.
  const grants = signInDouble(SIGNED_IN);

  // The secret as Teja might have typed it: padded and mixed case.
  const result = await authorizeBeforeSignIn(request("Bearer good-token"), auth, " App.User@Example.test ", grants.signIn);

  // The signed-in client and id come straight from the sign-in.
  assert.deepEqual(result, { ok: true, db: "db-handle", userId: APP_USER_ID });
  // One grant for one authorized call: no more, no less.
  assert.equal(grants.calls(), 1);
});

test("W15: a failed sign-in after an authorized caller is 'unavailable', keeping the reason for the log", async () => {
  // A caller that passes the pre-check.
  const auth = emailAuthClient({ "good-token": { id: APP_USER_ID, email: APP_USER_EMAIL } });
  // A wrong password secret, say.
  const grants = signInDouble({ ok: false, reason: "sign-in failed: Invalid login credentials" });

  const result = await authorizeBeforeSignIn(request("Bearer good-token"), auth, APP_USER_EMAIL, grants.signIn);

  // The entry points map this kind to their existing 503/500 and log the reason.
  assert.deepEqual(result, { ok: false, kind: "unavailable", reason: "sign-in failed: Invalid login credentials" });
});

test("W15: a signed-in id that differs from the verified caller's id is a 403", async () => {
  // The email matched, but the caller is a different account (a deleted and re-created user).
  const auth = emailAuthClient({ "good-token": { id: "dddddddd-0000-0000-0000-000000000000", email: APP_USER_EMAIL } });
  // The sign-in returns the real app user's id.
  const grants = signInDouble(SIGNED_IN);

  const result = await authorizeBeforeSignIn(request("Bearer good-token"), auth, APP_USER_EMAIL, grants.signIn);

  // The id check authorizeCaller made still holds; email alone is never enough.
  assert.deepEqual(result, { ok: false, kind: "refused", status: 403, error: "caller_is_not_app_user" });
});

test("W15: the four verify_jwt=false entry points take their client only from createAuthorizedAppUserClient", () => {
  // The functions the gateway does not shield: a tokenless request reaches their code.
  for (const fn of ["normalizer", "screener", "auditor", "scout-ats"]) {
    // Resolved from this file, so the test passes from any cwd.
    const source = readFileSync(new URL(`../../${fn}/index.ts`, import.meta.url), "utf8");
    // The import from client.ts names exactly the gated builder: importing the bare
    // createAppUserClient back (alone or beside it) changes this line and fails here.
    const imports = /import\s*\{([^}]*)\}\s*from\s*"\.\.\/_shared\/db\/client\.ts"/.exec(source);
    // The import exists at all.
    assert.ok(imports, `${fn}/index.ts must import from _shared/db/client.ts`);
    // And names one thing: the builder that verifies the caller first.
    assert.equal(imports[1]?.trim(), "createAuthorizedAppUserClient", `${fn}/index.ts must import only createAuthorizedAppUserClient`);
    // The request is what it verifies, so it must be passed in.
    assert.match(source, /await createAuthorizedAppUserClient\(req\)/, `${fn}/index.ts must call createAuthorizedAppUserClient(req)`);
  }
});
