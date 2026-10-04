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
import { authorizeCaller, readKillSwitch, type CallerAuthClient, type KillSwitchClient } from "./gates.ts";

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
