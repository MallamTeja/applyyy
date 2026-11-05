// dispatch-apply: start the applier when Teja approves a job (P1-6, 2026-11-05).
//
// WHY IT EXISTS. Teja (00:16 IST): "whenever i approve a job it need to be applied at that time, no
// daily job apply limits at all". Ruled (12:50 IST): build it behind an OFF switch he turns on only
// after one proven live submit. The browser calls this once after a successful approve; it starts
// apply.yml as a live drain of the approved queue (drain_approved "true"), which GitHub runs.
//
// WHAT CAN STOP IT, in order, each answering WITHOUT touching GitHub:
//   1. a caller who is not the app user: refused BEFORE any sign-in (W15, createAuthorizedAppUserClient
//      in index.ts), so a visitor holding the public anon key cannot make it spend a password grant;
//   2. the switch system_settings.auto_apply_on_approve is off, or its row is missing (200, said why);
//   3. no approved row whose job is still live (200, said why);
//   4. no GITHUB_APPLY_DISPATCH_TOKEN secret (503, named: never a silent 200).
// A GitHub refusal or a network failure is a 502 with GitHub's status, never with the token.
//
// REALITY CHECK (kept here on purpose): as of 2026-11-05, 0 of 7 CI live submits have landed
// (Greenhouse reCAPTCHA, unsupported_form, unanswerable_question); both `applied` rows were done by
// hand. A dispatched run will mostly end rows at blocked_needs_human. The worker re-checks every row
// right before submit (pre-gate + page liveness), so a drain never ships a row that fails today's gates.
//
// SPLIT FROM index.ts (the skill-gap / resume-assist pattern): index.ts calls Deno.serve at import
// and pulls in the jsr client, so the decisions live here, where node --test can import them.

// The shared CORS headers every browser-called function answers with.
import { corsHeaders } from "../_shared/cors.ts";
// Gate 1: the bearer JWT must be the app user's own session.
// authorizeCaller is the SECOND check now; AuthorizedSignIn is the verdict of the first (W15, below).
import { authorizeCaller, type AuthorizedSignIn, type CallerAuthClient } from "../_shared/db/gates.ts";

// The workflow dispatch endpoint for apply.yml on this repo (GitHub REST "Create a workflow dispatch
// event"). Pinned by a test, so a typo in the owner, repo or file name fails there, not as a 404 live.
export const DISPATCH_URL = "https://api.github.com/repos/MallamTeja/applyyy/actions/workflows/apply.yml/dispatches";

// The secret's name: a fine-grained PAT scoped to this one repo, Actions read and write, nothing else.
export const DISPATCH_TOKEN_ENV_VAR = "GITHUB_APPLY_DISPATCH_TOKEN";

// How long GitHub gets: a dispatch is one small POST, so a slow answer is a fault, not patience.
const GITHUB_TIMEOUT_MS = 15_000;

/* The client the handler reads through: the caller gate's auth slice, and two table reads. Narrow
   and loosely typed at the edges, so a test fakes it without the jsr client. */
export type DispatchDb = CallerAuthClient & { from(table: string): any };

/* What the handler needs from the outside world: three seams, each faked by the tests. */
export interface DispatchDeps {
  // Verify the caller, THEN sign in as the app user (every read then runs under that user's RLS).
  // Takes the request because the caller check needs its bearer token (W15).
  readonly connect: (req: Request) => Promise<AuthorizedSignIn<DispatchDb>>;
  // The PAT, or nothing.
  readonly token: () => string | undefined;
  // The HTTP call to GitHub.
  readonly fetch: (url: string, init: RequestInit) => Promise<Response>;
}

/* One JSON answer with the CORS headers. */
function json(status: number, body: Record<string, unknown>): Response {
  // JSON, with CORS so the browser can read the body of an error too.
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" } });
}

/* The request, answered. Never throws: every outcome is a Response. */
export async function handleDispatchApply(req: Request, deps: DispatchDeps): Promise<Response> {
  // Preflight: answered before any sign-in.
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  // Only the POST functions.invoke sends.
  if (req.method !== "POST") return json(405, { status: "error", message: "POST only" });
  // GATE 1 (W15, 2026-11-05 security review): the caller is verified BEFORE the password grant.
  const conn = await deps.connect(req);
  // Refused: 401 or 403, as the verdict says; no grant was spent on them.
  if (!conn.ok && conn.kind === "refused") return json(conn.status, { status: "error", message: conn.error });
  // The caller was fine but the sign-in failed: a configuration fault; the reason stays in the log.
  if (!conn.ok) {
    // Logged for the operator.
    console.error("[dispatch-apply] database connection failed:", conn.reason);
    // Retryable once fixed.
    return json(503, { status: "error", message: "database_unavailable" });
  }
  // A second check, by user id under the signed-in client (cheap: no grant left to save).
  const caller = await authorizeCaller(req, conn.db, conn.userId);
  // 401 or 403, as the verdict says.
  if (!caller.ok) return json(caller.status, { status: "error", message: caller.error });

  // GATE 2: the switch, read from his own settings row (RLS: auth.uid() = user_id).
  const settings = await conn.db.from("system_settings").select("auto_apply_on_approve").eq("user_id", conn.userId).maybeSingle();
  // An unreadable switch is never read as "on" (CLAUDE.md §6).
  if (settings.error) return json(503, { status: "error", message: "settings_unreadable" });
  // Only an explicit true is on; a missing row or a missing column reads as off.
  if (settings.data?.auto_apply_on_approve !== true) return json(200, { status: "ok", dispatched: false, reason: "auto_apply_off" });

  // GATE 3: approved rows whose job is still live (a job the scout marked disappeared is never sent
  // for). A head count: no rows travel. The inner embed lets the filter read the job's column.
  const counted = await conn.db
    // The queue table.
    .from("applications")
    // Count only; `!inner` so the job filter below drops rows instead of nulling the embed.
    .select("id, jobs!inner(disappeared_at)", { count: "exact", head: true })
    // Approved rows only.
    .eq("status", "approved")
    // Whose job has not disappeared.
    .is("jobs.disappeared_at", null);
  // A failed read, or a count that is not a number, is never "zero" and never "some" (CLAUDE.md §6).
  if (counted.error || typeof counted.count !== "number" || !Number.isInteger(counted.count) || counted.count < 0) {
    // Retryable, named.
    return json(503, { status: "error", message: "count_unreadable" });
  }
  // Nothing to send.
  if (counted.count === 0) return json(200, { status: "ok", dispatched: false, reason: "nothing_approved" });

  // GATE 4: the PAT. Missing or blank is a named 503, so the browser says why nothing happened.
  const token = deps.token()?.trim() ?? "";
  // Blank counts as missing.
  if (token === "") return json(503, { status: "error", message: "dispatch_token_missing" });

  // THE DISPATCH: apply.yml from main, live, the whole approved queue (its drain_approved input).
  let res: Response;
  // A thrown fetch (network, timeout) is a 502 below.
  try {
    // GitHub answers 204 No Content on success.
    res = await deps.fetch(DISPATCH_URL, {
      // Create a workflow dispatch event.
      method: "POST",
      // The token as a bearer; GitHub's documented media type and a pinned API version.
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "Content-Type": "application/json" },
      // Inputs are strings, exactly as apply.yml compares them ("false", "true").
      body: JSON.stringify({ ref: "main", inputs: { dry_run: "false", drain_approved: "true" } }),
      // Bounded.
      signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
    });
  } catch (cause) {
    // The error's name only; a message could carry request details.
    console.error("[dispatch-apply] GitHub unreachable:", cause instanceof Error ? cause.name : "unknown");
    // Upstream fault.
    return json(502, { status: "error", message: "github_unreachable" });
  }
  // Anything but a 2xx: GitHub's status, never the token or its body (it can echo the request).
  if (!res.ok) return json(502, { status: "error", message: `github_refused: HTTP ${res.status}` });
  // Started. The count tells the browser how many rows the run will try.
  return json(200, { status: "ok", dispatched: true, approved: counted.count });
}
