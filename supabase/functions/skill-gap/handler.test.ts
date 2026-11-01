// skill-gap handler: the caller gate (W14, 2026-11-01 wiring audit) and the kill switch.
// Run with: node --test "supabase/functions/skill-gap/*.test.ts"
//
// WHY THIS FILE EXISTS: skill-gap signed in as the app user and wrote skill_gap_reports for
// ANY bearer the gateway accepted. verify_jwt only checks the signature, and the public anon
// key (shipped in the web bundle) is a validly signed JWT, so it passed. The anon-key test
// below is the red-on-revert guard: delete the authorizeCaller() call and it fails.
import { test } from "node:test";
import assert from "node:assert/strict";
import { handleSkillGap } from "./handler.ts";
import type { DbClientResult } from "../_shared/db/client.ts";

// The bearer each caller sends. Only APP_USER_JWT is the app user's own session.
const APP_USER_JWT = "app-user-jwt";
// The public anon key: validly signed, so verify_jwt passes it, but it has no `sub` claim.
const ANON_KEY_JWT = "anon-key-jwt";
// A real session for a different auth user.
const OTHER_USER_JWT = "other-user-jwt";

// One job description that names skills the extractor knows, so the happy path writes rows.
const DESCRIPTION = "We need TypeScript, Kubernetes and PostgreSQL experience.";

// A fake supabase client that behaves like the real one: every builder method chains, the
// chain is awaitable, and it resolves to { data, error } (supabase-js never throws on a
// query error). `touched` records every table the handler reached, read or write.
function fakeClient(opts: { systemEnabled?: boolean } = {}) {
  // Every table the handler called `.from()` on, in order.
  const touched: string[] = [];
  // What awaiting a chain on each table yields.
  const replies: Record<string, unknown> = {
    // The run row insert returns its id.
    agent_runs: { data: { id: "run-1" }, error: null },
    // The kill switch row.
    system_settings: { data: [{ system_enabled: opts.systemEnabled ?? true }], error: null },
    // A master profile with no skills, so every extracted skill counts as a gap.
    master_profiles: { data: { profile: { skills: [] } }, error: null },
    // One scored application with an embedded job description.
    applications: { data: [{ id: "app-1", jobs: { description_raw: DESCRIPTION } }], error: null },
    // The report upsert succeeds.
    skill_gap_reports: { data: null, error: null },
  };
  // The client handed to the handler.
  const db = {
    // getUser as the auth server answers it for each bearer.
    auth: {
      getUser: (jwt: string) =>
        Promise.resolve(
          jwt === APP_USER_JWT
            ? { data: { user: { id: "app-user" } }, error: null }
            : jwt === OTHER_USER_JWT
            ? { data: { user: { id: "someone-else" } }, error: null }
            // The anon key and anything unknown: no user (GoTrue refuses a token with no sub).
            : { data: { user: null }, error: { message: "invalid claim: missing sub claim" } },
        ),
    },
    // Records the table, then returns a chain where every method returns the chain itself.
    from(table: string) {
      // Recorded before anything else, so a refused caller's touch is visible.
      touched.push(table);
      // A Proxy stands in for the whole builder API (insert, select, eq, order, upsert, ...).
      const chain: unknown = new Proxy({}, {
        // `then` makes the chain awaitable; any other property is a chaining method.
        get: (_target, prop) =>
          prop === "then"
            ? (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => Promise.resolve(replies[table]).then(resolve, reject)
            : () => chain,
      });
      // The chain for this table.
      return chain;
    },
  };
  // connect() as index.ts supplies it, with this fake in place of the jsr client.
  const connect = () => Promise.resolve({ ok: true, userId: "app-user", db } as unknown as DbClientResult);
  // Both, so a test can call the handler and then inspect what it touched.
  return { connect, touched };
}

// A POST with an optional bearer, as the workflow or a browser would send it.
function post(token: string | null): Request {
  // No header at all when token is null.
  return new Request("https://fn.local/skill-gap", { method: "POST", headers: token === null ? {} : { authorization: `Bearer ${token}` } });
}

test("W14: the public anon key is refused 401 and nothing is read or written", async () => {
  // The caller this gate exists to stop.
  const { connect, touched } = fakeClient();
  // Sent exactly as any page visitor holding the bundled anon key could.
  const res = await handleSkillGap(post(ANON_KEY_JWT), connect);
  // 401: the auth server would not vouch for it.
  assert.equal(res.status, 401);
  // Same body shape as follow-up's refusal.
  assert.deepEqual(await res.json(), { success: false, error: "invalid_session" });
  // Not one table: no agent_runs row, no read, and above all no skill_gap_reports write.
  assert.deepEqual(touched, []);
});

test("no bearer is 401 and another user's session is 403; neither touches a table", async () => {
  // No Authorization header at all.
  const anon = fakeClient();
  // Refused before the auth server is even asked.
  assert.equal((await handleSkillGap(post(null), anon.connect)).status, 401);
  // A real session, but not the app user's.
  const other = fakeClient();
  // 403: a valid user who is not the one this function acts for.
  assert.equal((await handleSkillGap(post(OTHER_USER_JWT), other.connect)).status, 403);
  // Neither reached the database.
  assert.deepEqual([...anon.touched, ...other.touched], []);
});

test("the app user's session runs the aggregation and writes the report", async () => {
  // Proves the fake drives the full path, so the refusals above are the gate and not a broken double.
  const { connect, touched } = fakeClient();
  // The app user's own JWT.
  const res = await handleSkillGap(post(APP_USER_JWT), connect);
  // Success with every skill the description names.
  assert.equal(res.status, 200);
  // typescript, kubernetes, postgresql, plus sql (the extractor substring-matches it inside
  // "postgresql"): none are on the empty profile.
  assert.deepEqual(await res.json(), { success: true, aggregatedSkills: 4 });
  // The report table was written.
  assert.ok(touched.includes("skill_gap_reports"));
});

test("kill switch off: 200 skipped_disabled, the same halt answer as follow-up, and no report", async () => {
  // The switch Teja flips to stop the system.
  const { connect, touched } = fakeClient({ systemEnabled: false });
  // A legitimate caller.
  const res = await handleSkillGap(post(APP_USER_JWT), connect);
  // 200: halting on the switch is the system doing what it was told, so a scheduled run stays green.
  assert.equal(res.status, 200);
  // The shape the satellites workflow reads as a halt.
  assert.deepEqual(await res.json(), { success: true, status: "skipped_disabled" });
  // Nothing aggregated.
  assert.equal(touched.includes("skill_gap_reports"), false);
});
