// Tests for rls-proof's entry gate (W16 + W34, 2026-11-02). index.ts runs Deno.serve on
// import, so the gate is a pure module and these tests reach it under node --test.
import { test } from "node:test";
// Strict equality so null and undefined stay distinct.
import assert from "node:assert/strict";
// Unit under test and its named constants, read live so the tests never copy a value.
import { PRODUCTION_PROJECT_REF, RLS_PROOF_SECRET_ENV_VAR, runGate } from "./guard.ts";
// The intake's secret name, to prove rls-proof no longer shares it.
import { INTAKE_SECRET_ENV_VAR } from "../_shared/intake/auth.ts";

// The diagnostic's own secret, as the orchestrator would set it.
const SECRET = "rls-proof-secret-t3st";
// A throwaway project's ref: 20 lowercase alphanumerics, like every Supabase ref.
const TEST_REF = "abcdefghijklmnopqrst";
// A request that passes every gate on the throwaway project; each test changes one field.
const PASSING = { method: "POST", presentedSecret: SECRET, configuredSecret: SECRET, supabaseUrl: `https://${TEST_REF}.supabase.co`, targetRef: TEST_REF };

test("W16: rls-proof reads its own secret, not the intake's", () => {
  // Named for the orchestrator's `supabase secrets set`.
  assert.equal(RLS_PROOF_SECRET_ENV_VAR, "APPLYY_RLS_PROOF_SECRET");
  // One secret per entry point.
  assert.notEqual(RLS_PROOF_SECRET_ENV_VAR, INTAKE_SECRET_ENV_VAR);
});

test("W16: rls-proof refuses when its secret is unset or wrong", () => {
  // Unset: fail closed with 500 (the fault is configuration), whatever the caller sent.
  assert.deepEqual(runGate({ ...PASSING, configuredSecret: undefined }), { ok: false, status: 500, error: `${RLS_PROOF_SECRET_ENV_VAR} is not set` });
  // Absent header: 401.
  assert.equal(runGate({ ...PASSING, presentedSecret: null }).ok, false);
  // Wrong secret: 401.
  assert.deepEqual(runGate({ ...PASSING, presentedSecret: "nope" }), { ok: false, status: 401, error: "unauthorized" });
  // A link click (GET) never runs a diagnostic that writes rows.
  assert.equal(runGate({ ...PASSING, method: "GET" }).ok, false);
});

test("W34: rls-proof refuses on the production project, even with a valid secret and marker", () => {
  // The RLS-scoped emptiness count passed on prod (it counts as a test user who owns nothing),
  // so the project itself is what is checked now, before any sign-in or count.
  const verdict = runGate({ ...PASSING, supabaseUrl: `https://${PRODUCTION_PROJECT_REF}.supabase.co`, targetRef: PRODUCTION_PROJECT_REF });
  // Refused with a conflict.
  assert.deepEqual([verdict.ok, verdict.ok ? 0 : verdict.status], [false, 409]);
});

test("W34: rls-proof refuses unless a marker names this exact project as a throwaway", () => {
  // No marker: the default for every project, prod included.
  assert.equal(runGate({ ...PASSING, targetRef: undefined }).ok, false);
  // A marker for a DIFFERENT project (copied from another environment).
  assert.equal(runGate({ ...PASSING, targetRef: "zzzzzzzzzzzzzzzzzzzz" }).ok, false);
  // An unreadable URL: the project cannot be identified, so refuse.
  assert.equal(runGate({ ...PASSING, supabaseUrl: "http://localhost:54321" }).ok, false);
  // Unset URL: same.
  assert.equal(runGate({ ...PASSING, supabaseUrl: undefined }).ok, false);
  // Positive control: the marked throwaway project passes, so the refusals above are not a dead gate.
  assert.deepEqual(runGate(PASSING), { ok: true });
});
