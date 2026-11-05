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
import { DISPATCH_URL, handleDispatchApply, type DispatchDeps } from "./handler.ts";

// The app user the fake session signs in as.
const USER_ID = "0f4b24da-e85b-40bb-8606-c81824493b45";

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
  caller?: "ok" | "anon";
} = {}): { deps: DispatchDeps; calls: Call[] } {
  // GitHub calls, in order.
  const calls: Call[] = [];
  // The fake client: auth for the caller gate, two table reads for the handler.
  const db = {
    // authorizeCaller's one call: the bearer token's user.
    auth: { getUser: async () => ({ data: { user: opts.caller === "anon" ? null : { id: USER_ID } }, error: null }) },
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
    // Signed in.
    connect: async () => ({ ok: true, db, userId: USER_ID }),
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
  return { deps: d, calls };
}

// A POST with a bearer token, as functions.invoke sends it.
const post = () => new Request("https://x.supabase.co/functions/v1/dispatch-apply", { method: "POST", headers: { authorization: "Bearer user-jwt" } });

// Reads a response's JSON body.
async function body(res: Response): Promise<Record<string, unknown>> {
  // JSON, always.
  return (await res.json()) as Record<string, unknown>;
}

test("switch off: no dispatch, a 200 that says why", async () => {
  // Off, everything else ready.
  const { deps: d, calls } = deps({ switchOn: false });
  // Asked.
  const res = await handleDispatchApply(post(), d);
  // Not an error: the expected state until Teja turns it on.
  assert.equal(res.status, 200);
  // Said by name.
  assert.deepEqual(await body(res), { status: "ok", dispatched: false, reason: "auto_apply_off" });
  // GitHub never reached.
  assert.equal(calls.length, 0);
});

test("no settings row reads as off (fail closed), never as on", async () => {
  // No row at all.
  const { deps: d, calls } = deps({ switchOn: null });
  // Asked.
  const res = await handleDispatchApply(post(), d);
  // Off.
  assert.equal((await body(res)).reason, "auto_apply_off");
  // Nothing sent.
  assert.equal(calls.length, 0);
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

test("a caller who is not the app user is refused before anything is read or sent", async () => {
  // The anon key's JWT, or a stranger's.
  const { deps: d, calls } = deps({ caller: "anon" });
  // Asked.
  const res = await handleDispatchApply(post(), d);
  // 401: the gate's own verdict.
  assert.equal(res.status, 401);
  // Nothing sent.
  assert.equal(calls.length, 0);
});

test("switch on + approved rows + token: exactly one dispatch of the drain, with the right inputs", async () => {
  // Everything ready, two rows.
  const { deps: d, calls } = deps({ count: 2 });
  // Asked.
  const res = await handleDispatchApply(post(), d);
  // Sent.
  assert.deepEqual(await body(res), { status: "ok", dispatched: true, approved: 2 });
  // Once.
  assert.equal(calls.length, 1);
  // The one call.
  const call = calls[0]!;
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
