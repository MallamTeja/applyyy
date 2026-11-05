// dispatch-apply: apply on approve (P1-6, 2026-11-05). Every refusal path, and the one dispatch.
//
// The switch is OFF by default and the GitHub token does not exist yet, so the paths that answer
// "no" are the ones that run for now: each must reach GitHub zero times. The happy path must reach
// it exactly once, with exactly the inputs apply.yml's drain reads.

// The node:test runner, matching every other suite in supabase/functions.
import { test } from "node:test";
// Strict, so a missing field never compares equal to undefined.
import assert from "node:assert/strict";
// The handler under test and its seam types.
import { DISPATCH_URL, KIT_DISPATCH_URL, handleDispatchApply, type DispatchDeps } from "./handler.ts";
// The pre-sign-in caller check index.ts composes (via createAuthorizedAppUserClient), used for real here.
import { authorizeBeforeSignIn } from "../_shared/db/gates.ts";
// Source reads for the two wiring pins below (index.ts and config.toml are not reachable from the handler).
import { readFileSync } from "node:fs";

// The app user the fake session signs in as.
const USER_ID = "0f4b24da-e85b-40bb-8606-c81824493b45";
// The app user's address, which the pre-sign-in check compares the caller's session to.
const APP_EMAIL = "operator@example.test";

/* One recorded GitHub call. */
type Call = { url: string; init: RequestInit };

/* The deps, with every lever a test turns: the switch, the count, the token, GitHub's answer. */
function deps(opts: {
  switchOn?: boolean | null;
  settingsError?: boolean;
  count?: unknown;
  countError?: boolean;
  token?: string | undefined;
  github?: () => Promise<Response>;
  caller?: "ok" | "anon" | "stranger";
  unavailable?: boolean;
} = {}): { deps: DispatchDeps; calls: Call[]; signIns: () => number } {
  // GitHub calls, in order.
  const calls: Call[] = [];
  // Password grants spent; a refused caller must cost none (W15).
  let signIns = 0;
  // The caller's session as the auth server reports it.
  const sessionUser = opts.caller === "anon" ? null : { id: opts.caller === "stranger" ? "someone-else" : USER_ID, email: opts.caller === "stranger" ? "stranger@example.test" : APP_EMAIL };
  // The anon-key verifier: asks only about the caller's token.
  const verifier = { auth: { getUser: async () => ({ data: { user: sessionUser }, error: null }) } };
  // The fake client: auth for the caller gate, two table reads for the handler.
  const db = {
    // authorizeCaller's one call: the bearer token's user.
    auth: { getUser: async () => ({ data: { user: sessionUser }, error: null }) },
    // The two reads, by table.
    from: (table: string) => {
      // The switch row.
      if (table === "system_settings") {
        // select().eq().maybeSingle()
        return { select: () => ({ eq: () => ({ maybeSingle: async () => (opts.settingsError ? { data: null, error: { message: "boom" } } : { data: opts.switchOn === null ? null : { auto_apply_on_approve: opts.switchOn ?? true }, error: null }) }) }) };
      }
      // The approved count: select(head, count).eq().is()
      return { select: () => ({ eq: () => ({ is: async () => (opts.countError ? { count: null, error: { message: "boom" } } : { count: "count" in opts ? opts.count : 2, error: null }) }) }) };
    },
  };
  // The three seams.
  const d: DispatchDeps = {
    // Exactly what index.ts wires: verify the caller FIRST, then sign in (counted).
    connect: (req) => opts.unavailable ? Promise.resolve({ ok: false, kind: "unavailable", reason: "env missing" }) : authorizeBeforeSignIn(req, verifier, APP_EMAIL, async () => { signIns += 1; return { ok: true, db, userId: USER_ID }; }),
    // The secret, or none.
    token: () => ("token" in opts ? opts.token : "github_pat_test"),
    // GitHub, recorded.
    fetch: async (url, init) => {
      // Every call kept.
      calls.push({ url: String(url), init: init ?? {} });
      // The scripted answer, default 204 (GitHub's dispatch success).
      return opts.github ? opts.github() : new Response(null, { status: 204 });
    },
  };
  // Both, so a test reads what it needs.
  return { deps: d, calls, signIns: () => signIns };
}

// A POST with a bearer token, as functions.invoke sends it.
const post = () => new Request("https://x.supabase.co/functions/v1/dispatch-apply", { method: "POST", headers: { authorization: "Bearer user-jwt" } });

// Reads a response's JSON body.
async function body(res: Response): Promise<Record<string, unknown>> {
  // JSON, always.
  return (await res.json()) as Record<string, unknown>;
}

test("switch off: approve builds kits (apply-kit dispatched) and does NOT start the applier", async () => {
  // Off, everything else ready.
  const { deps: d, calls } = deps({ switchOn: false });
  // Asked.
  const res = await handleDispatchApply(post(), d);
  // Not an error: the expected state until Teja turns it on.
  assert.equal(res.status, 200);
  // Said by name: no applier run, but the kit run started (Teja 14:47 + orchestrator ruling 2026-11-05).
  assert.deepEqual(await body(res), { status: "ok", dispatched: false, reason: "auto_apply_off", kit_dispatched: true });
  // Exactly one GitHub call: apply-kit.yml, never apply.yml (a kit is not a submit).
  assert.deepEqual(calls.map((c) => c.url), [KIT_DISPATCH_URL]);
});

test("no settings row reads as off (fail closed), never as on", async () => {
  // No row at all.
  const { deps: d, calls } = deps({ switchOn: null });
  // Asked.
  const res = await handleDispatchApply(post(), d);
  // Off.
  assert.equal((await body(res)).reason, "auto_apply_off");
  // The applier is never started; only the kit run is.
  assert.ok(!calls.some((c) => c.url === DISPATCH_URL));
});

test("an unreadable switch is a 503, never a dispatch", async () => {
  // The read fails.
  const { deps: d, calls } = deps({ settingsError: true });
  // Asked.
  const res = await handleDispatchApply(post(), d);
  // Retryable, named.
  assert.equal(res.status, 503);
  // The reason.
  assert.equal((await body(res)).message, "settings_unreadable");
  // Nothing sent.
  assert.equal(calls.length, 0);
});

test("nothing approved: no dispatch", async () => {
  // Zero live approved rows.
  const { deps: d, calls } = deps({ count: 0 });
  // Asked.
  const res = await handleDispatchApply(post(), d);
  // Said by name.
  assert.deepEqual(await body(res), { status: "ok", dispatched: false, reason: "nothing_approved" });
  // Nothing sent.
  assert.equal(calls.length, 0);
});

test("a count that is not a number is a 503, never a dispatch (CLAUDE.md §6)", async () => {
  // A missing count and a failed read.
  for (const opts of [{ count: null }, { count: "2" }, { countError: true }]) {
    // Each case fresh.
    const { deps: d, calls } = deps(opts);
    // Asked.
    const res = await handleDispatchApply(post(), d);
    // Refused.
    assert.equal(res.status, 503, JSON.stringify(opts));
    // Nothing sent.
    assert.equal(calls.length, 0, JSON.stringify(opts));
  }
});

test("no token: a 503 naming it, never a silent 200", async () => {
  // Missing and blank.
  for (const token of [undefined, "", "   "]) {
    // The switch on, rows approved, no secret.
    const { deps: d, calls } = deps({ token });
    // Asked.
    const res = await handleDispatchApply(post(), d);
    // Refused, named.
    assert.equal(res.status, 503);
    // The reason.
    assert.equal((await body(res)).message, "dispatch_token_missing");
    // Nothing sent.
    assert.equal(calls.length, 0);
  }
});

test("a GitHub refusal or a network failure is a 502 with the status, never the token", async () => {
  // A 422 (bad ref or input) and a 401 (bad token).
  for (const status of [422, 401]) {
    // GitHub says no.
    const { deps: d } = deps({ github: async () => new Response('{"message":"nope"}', { status }) });
    // Asked.
    const res = await handleDispatchApply(post(), d);
    // Upstream fault.
    assert.equal(res.status, 502);
    // The status, and never the token.
    const text = JSON.stringify(await body(res));
    // Status named.
    assert.match(text, new RegExp(`HTTP ${status}`));
    // Secret absent.
    assert.ok(!text.includes("github_pat_test"));
  }
  // The network drops.
  const { deps: d } = deps({ github: async () => { throw new TypeError("fetch failed"); } });
  // Asked.
  const res = await handleDispatchApply(post(), d);
  // Upstream fault.
  assert.equal(res.status, 502);
});

test("a caller who is not the app user is refused BEFORE any sign-in (W15), and before anything is read or sent", async () => {
  // The anon key's JWT (no user) and a stranger's valid session.
  for (const [caller, status] of [["anon", 401], ["stranger", 403]] as const) {
    // Each fresh.
    const { deps: d, calls, signIns } = deps({ caller });
    // Asked.
    const res = await handleDispatchApply(post(), d);
    // The pre-sign-in verdict's own status.
    assert.equal(res.status, status, caller);
    // NO password grant was spent on them.
    assert.equal(signIns(), 0, caller);
    // Nothing sent.
    assert.equal(calls.length, 0, caller);
  }
});

test("the app user signs in exactly once; an unavailable sign-in is a 503", async () => {
  // The real caller.
  const ok = deps({ switchOn: false });
  // Asked.
  await handleDispatchApply(post(), ok.deps);
  // One grant.
  assert.equal(ok.signIns(), 1);
  // The platform env is missing.
  const down = deps({ unavailable: true });
  // Asked.
  const res = await handleDispatchApply(post(), down.deps);
  // Our fault, retryable.
  assert.equal(res.status, 503);
});

test("switch on + approved rows + token: the kit run, then exactly one dispatch of the drain, with the right inputs", async () => {
  // Everything ready, two rows.
  const { deps: d, calls } = deps({ count: 2 });
  // Asked.
  const res = await handleDispatchApply(post(), d);
  // Sent.
  assert.deepEqual(await body(res), { status: "ok", dispatched: true, approved: 2, kit_dispatched: true });
  // Two calls: kits first (manual apply needs them whatever the applier does), then the applier, once.
  assert.deepEqual(calls.map((c) => c.url), [KIT_DISPATCH_URL, DISPATCH_URL]);
  // The kit call: a sweep of every due row (apply-kit.yml's application_id left at its blank default).
  assert.deepEqual(JSON.parse(String(calls[0]!.init.body)), { ref: "main" });
  // Pinned so a typo in the file name fails here, not as a 404 in production.
  assert.equal(KIT_DISPATCH_URL, "https://api.github.com/repos/MallamTeja/applyyy/actions/workflows/apply-kit.yml/dispatches");
  // The applier call.
  const call = calls[1]!;
  // The workflow's dispatch endpoint, on this repo.
  assert.equal(call.url, DISPATCH_URL);
  // Pinned so a typo in the repo or file name fails here, not as a 404 in production.
  assert.equal(DISPATCH_URL, "https://api.github.com/repos/MallamTeja/applyyy/actions/workflows/apply.yml/dispatches");
  // A POST.
  assert.equal(call.init.method, "POST");
  // Headers: the token as a bearer, GitHub's JSON type and API version.
  const headers = new Headers(call.init.headers);
  // The secret, sent only here.
  assert.equal(headers.get("authorization"), "Bearer github_pat_test");
  // The documented media type.
  assert.equal(headers.get("accept"), "application/vnd.github+json");
  // Pinned API version.
  assert.equal(headers.get("x-github-api-version"), "2022-11-28");
  // Exactly the inputs apply.yml's drain reads: live, the whole approved queue, from main.
  assert.deepEqual(JSON.parse(String(call.init.body)), { ref: "main", inputs: { dry_run: "false", drain_approved: "true" } });
});

test("OPTIONS answers the preflight without signing in; other methods are 405", async () => {
  // A preflight.
  const { deps: d, calls } = deps();
  // Answered.
  const pre = await handleDispatchApply(new Request("https://x/functions/v1/dispatch-apply", { method: "OPTIONS" }), d);
  // OK, with CORS.
  assert.ok(pre.status === 200 || pre.status === 204);
  // A GET.
  const get = await handleDispatchApply(new Request("https://x/functions/v1/dispatch-apply", { method: "GET" }), d);
  // Not allowed.
  assert.equal(get.status, 405);
  // Nothing sent either way.
  assert.equal(calls.length, 0);
});

// Fix 1 (2026-11-05 review, W15): the handler tests above fake `connect`, so they cannot see which
// builder index.ts really hands in. Re-importing the bare createAppUserClient would spend a password
// grant before the caller check and every test above would stay green; this pin is what goes red.
test("index.ts wires connect to createAuthorizedAppUserClient, never the bare sign-in (W15)", () => {
  // The entry point's source, resolved from this file.
  const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
  // The import from client.ts.
  const imports = /import\s*\{([^}]*)\}\s*from\s*"\.\.\/_shared\/db\/client\.ts"/.exec(source);
  // Present.
  assert.ok(imports, "dispatch-apply/index.ts must import from _shared/db/client.ts");
  // Exactly the gated builder: adding createAppUserClient back changes this line.
  assert.equal(imports[1]?.trim(), "createAuthorizedAppUserClient");
  // And it is the seam handed to the handler (the handler passes it the request).
  assert.match(source, /connect:\s*createAuthorizedAppUserClient\b/);
});

// Fix 5 (2026-11-05 review): the gateway's verify_jwt is the outer layer that stops TOKENLESS calls.
// A deploy reads it from config.toml, so a flipped or deleted line would ship silently; pin it.
test("config.toml pins [functions.dispatch-apply] verify_jwt = true", () => {
  // The project config, two levels up from this file.
  const toml = readFileSync(new URL("../../config.toml", import.meta.url), "utf8");
  // Only this function's section: from its header to the next header (or the end).
  const section = /^\[functions\.dispatch-apply\]\s*$([\s\S]*?)(?=^\[|$(?![\s\S]))/m.exec(toml)?.[1];
  // The section exists.
  assert.ok(section !== undefined, "config.toml has no [functions.dispatch-apply] section");
  // An uncommented `verify_jwt = true` line, exactly; false, absent or commented out fails.
  assert.match(section, /^verify_jwt\s*=\s*true\s*$/m);
});
