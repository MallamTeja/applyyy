// W15, everywhere (2026-11-05): no entry point spends a password grant on a caller it then refuses.
//
// WHY: the sign-in is a GoTrue password grant on Teja's account. verify_jwt only stops TOKENLESS calls,
// and the public anon key is a validly signed JWT, so any visitor could make each POST to a function that
// signed in first cost one grant (rate-limit and lockout pressure). Eleven functions did that on
// 2026-11-05 (peer 2's dispatch-apply finding, then a grep of every function). Each now gets its client
// from createAuthorizedAppUserClient(req), which runs authorizeBeforeSignIn: caller first, grant second.
//
// TWO PROOFS. (1) A spy: each node-loadable handler, wired exactly as its index.ts wires it (connect =
// the real authorizeBeforeSignIn with a counting sign-in), answers a refused caller 401/403 and spends
// ZERO sign-ins. (2) A shape check over every index.ts, which Deno.serve keeps out of node: each imports
// only createAuthorizedAppUserClient from client.ts and passes it the request.

// node:test, as every function test here.
import { test } from "node:test";
// Strict equality.
import assert from "node:assert/strict";
// The index.ts files are read as text: they call Deno.serve on import.
import { readFileSync } from "node:fs";
// The real gate, composed exactly as createAuthorizedAppUserClient composes it.
import { authorizeBeforeSignIn, type CallerAuthClient } from "./gates.ts";
// The four handlers whose index.ts builds connect() around the gate.
import { handleResumeAssist } from "../../resume-assist/assist.ts";
import { handleScoutWeb } from "../../scout-web/handler.ts";
import { handleJobLinkIntake } from "../../job-link-intake/handler.ts";
import { handleSkillGap } from "../../skill-gap/handler.ts";

// The app user, by email (the secret the gate compares) and id.
const APP_USER_EMAIL = "teja@example.test";
const APP_USER_ID = "00000000-0000-0000-0000-00000000a99a";

// A fake auth server: the anon key is refused like GoTrue refuses it; another user's token is a real session.
const verifier: CallerAuthClient = {
  auth: {
    // One known non-app-user token; everything else (the anon key included) is not a session.
    getUser: (jwt: string) =>
      Promise.resolve(jwt === "other-user-jwt"
        ? { data: { user: { id: "someone-else", email: "visitor@example.test" } }, error: null }
        : { data: { user: null }, error: { message: "invalid JWT" } }),
  },
} as unknown as CallerAuthClient;

// The sign-in spy: counts grants, and would succeed if ever reached.
function grantSpy() {
  // Grants spent.
  let calls = 0;
  // The seam createAuthorizedAppUserClient passes: createAppUserClient's shape.
  const signIn = () => {
    calls += 1;
    return Promise.resolve({ ok: true as const, db: {} as never, userId: APP_USER_ID });
  };
  return { signIn, calls: () => calls };
}

// A POST with the given bearer token, as the browser or a cron would send it.
const post = (token: string) => new Request("https://x.supabase.co/functions/v1/fn", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: "{}" });

// Each handler, wired as its index.ts wires it; only connect() is reachable on a refused call.
const HANDLERS: [string, (req: Request, connect: () => Promise<never>) => Promise<Response>][] = [
  ["resume-assist", (req, connect) => handleResumeAssist(req, { connect } as never)],
  ["scout-web", (req, connect) => handleScoutWeb(req, { connect } as never)],
  ["job-link-intake", (req, connect) => handleJobLinkIntake(req, { connect } as never)],
  ["skill-gap", (req, connect) => handleSkillGap(req, connect as never)],
];

for (const [name, handle] of HANDLERS) {
  test(`W15 ${name}: the public anon key is a 401 and spends no password grant`, async () => {
    // The request, and a grant counter.
    const req = post("anon-key-jwt");
    const grants = grantSpy();
    // connect() exactly as index.ts builds it: the gate, then the sign-in.
    const res = await handle(req, () => authorizeBeforeSignIn(req, verifier, APP_USER_EMAIL, grants.signIn) as Promise<never>);
    // Refused as before.
    assert.equal(res.status, 401);
    // The fix: no grant on Teja's account.
    assert.equal(grants.calls(), 0);
  });

  test(`W15 ${name}: another user's real session is a 403 and spends no password grant`, async () => {
    // A valid session that is not the app user's.
    const req = post("other-user-jwt");
    const grants = grantSpy();
    // Same wiring.
    const res = await handle(req, () => authorizeBeforeSignIn(req, verifier, APP_USER_EMAIL, grants.signIn) as Promise<never>);
    // Forbidden, as before.
    assert.equal(res.status, 403);
    // And no grant.
    assert.equal(grants.calls(), 0);
  });
}

test("W15: every app-user entry point builds its client with createAuthorizedAppUserClient(req), never the bare sign-in", () => {
  // The 15 functions that sign in as the app user (dispatch-apply is fixed separately by its owner;
  // email-tracker-intake checks its shared secret before signing in and is not in this set).
  const functions = [
    // W15's original four (verify_jwt=false).
    "normalizer", "screener", "auditor", "scout-ats",
    // The eleven fixed 2026-11-05.
    "cover-letter", "follow-up", "gmail-sync", "interview-prep", "job-link-intake", "matcher", "referral", "resume-assist", "scout-web", "skill-gap", "tailor",
  ];
  for (const fn of functions) {
    // The entry point's source, resolved from this file.
    const source = readFileSync(new URL(`../../${fn}/index.ts`, import.meta.url), "utf8");
    // The import from client.ts names exactly the gated builder.
    const imports = /import\s*\{([^}]*)\}\s*from\s*"\.\.\/_shared\/db\/client\.ts"/.exec(source);
    // Present.
    assert.ok(imports, `${fn}/index.ts must import from _shared/db/client.ts`);
    // Only the gated builder: re-importing createAppUserClient changes this line and fails here.
    assert.equal(imports[1]?.trim(), "createAuthorizedAppUserClient", `${fn}/index.ts must import only createAuthorizedAppUserClient`);
    // And it is given the request it verifies.
    assert.match(source, /createAuthorizedAppUserClient\(req\)/, `${fn}/index.ts must call createAuthorizedAppUserClient(req)`);
  }
});
