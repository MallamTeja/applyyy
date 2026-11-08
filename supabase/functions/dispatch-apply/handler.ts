// dispatch-apply: start the applier when Teja approves a job (P1-6, 2026-11-05).
//
// WHY IT EXISTS. Teja (00:16 IST): "whenever i approve a job it need to be applied at that time, no
// daily job apply limits at all". Ruled (12:50 IST): build it behind an OFF switch he turns on only
// after one proven live submit. The browser calls this once after a successful approve; it starts
// apply.yml as a live drain of the approved queue (drain_approved "true"), which GitHub runs.
//
// KITS ON EVERY APPROVE (2026-11-05, Teja 14:47 "they must run every time a job is in the queue";
// orchestrator ruling 19:41): apply-kit.yml is dispatched on every approve WHATEVER the switch says.
// A kit never submits and writes no status, so it needs no switch; without it an approved row had no
// kit until the 12:00 UTC cron and Manual apply showed nothing. apply-kit.yml's concurrency group
// coalesces rapid approves into one queued run. Only the applier's LIVE drain stays behind the switch.
//
// KIT-ONLY ON ANSWER SAVE (peer 4, 2026-11-08): a body of exactly {"kit_only": true}, sent by the web's
// saveBankAnswer after an answer lands, dispatches the apply-kit.yml sweep and NOTHING else: no switch
// read, no approved count (Manual apply rows are mostly blocked_needs_human, not approved), never apply.yml.
//
// WHAT CAN STOP IT, in order, each answering WITHOUT touching GitHub:
//   1. a caller who is not the app user: refused BEFORE any sign-in (W15, createAuthorizedAppUserClient
//      in index.ts), so a visitor holding the public anon key cannot make it spend a password grant;
//   2. an unreadable switch (503: never guess "on" or "off");
//   3. no approved row whose job is still live (200, said why);
//   4. no GITHUB_APPLY_DISPATCH_TOKEN secret (503, named: never a silent 200).
// Then the kit run is dispatched; then, only if system_settings.auto_apply_on_approve is exactly true
// (a missing row reads as off), the applier's drain. Off is a 200 that says so.
// A GitHub refusal or a network failure is a 502 with GitHub's status and the workflow, never the token.
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

// The same endpoint for apply-kit.yml (the kit builder), dispatched on every approve. Pinned by a test too.
export const KIT_DISPATCH_URL = "https://api.github.com/repos/MallamTeja/applyyy/actions/workflows/apply-kit.yml/dispatches";

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

  // KIT-ONLY MODE (peer 4, 2026-11-08): an answer saved in Manual apply or the Answer bank asks for a kit
  // rebuild here. The sweep already treats every kit older than the newest answer as due (K1, 2026-11-06);
  // what was missing is a run STARTING when the answer lands, so the card waited for the next applier run
  // or the 12:00 UTC cron. Read AFTER both caller checks, so a stranger's body is never even parsed.
  if (await wantsKitOnly(req)) {
    // The same PAT rule as below: blank or missing is a named 503, never a silent 200.
    const kitToken = deps.token()?.trim() ?? "";
    // Said by name, so the card can say why no rebuild started.
    if (kitToken === "") return json(503, { status: "error", message: "dispatch_token_missing" });
    // The sweep only (blank application_id). NEVER apply.yml: saving an answer must not start a submit,
    // whatever the switch says, which is also why the switch and the approved count are not read here.
    // A burst of saves costs at most one running + one pending run: apply-kit.yml's concurrency group
    // (cancel-in-progress: false) replaces an older PENDING run with the newer one.
    const kitOnly = await dispatch(deps, kitToken, KIT_DISPATCH_URL, { ref: "main" }, "apply-kit.yml");
    // Refused or unreachable: the 502 naming the workflow.
    if (kitOnly !== null) return kitOnly;
    // Started; dispatched:false because no applier run was started, by design.
    return json(200, { status: "ok", dispatched: false, reason: "answer_saved", kit_dispatched: true });
  }

  // GATE 2: the switch, read from his own settings row (RLS: auth.uid() = user_id).
  const settings = await conn.db.from("system_settings").select("auto_apply_on_approve").eq("user_id", conn.userId).maybeSingle();
  // An unreadable switch is never read as "on" (CLAUDE.md §6).
  if (settings.error) return json(503, { status: "error", message: "settings_unreadable" });
  // Only an explicit true is on; a missing row or a missing column reads as off. Read now, acted on
  // last: the switch decides only the applier, never the kit run.
  const autoApply = settings.data?.auto_apply_on_approve === true;

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

  // THE KIT RUN, every approve: a sweep of every due row (application_id left at its blank default).
  const kit = await dispatch(deps, token, KIT_DISPATCH_URL, { ref: "main" }, "apply-kit.yml");
  // Refused or unreachable: said, and the applier is not started on top of a token GitHub just refused.
  if (kit !== null) return kit;
  // The switch is off: kits only, said by name (the expected state until Teja turns it on).
  if (!autoApply) return json(200, { status: "ok", dispatched: false, reason: "auto_apply_off", kit_dispatched: true });
  // THE DRAIN: apply.yml from main, live, the approved queue (its drain_approved input; 25 per run).
  // Inputs are strings, exactly as apply.yml compares them ("false", "true").
  const drain = await dispatch(deps, token, DISPATCH_URL, { ref: "main", inputs: { dry_run: "false", drain_approved: "true" } }, "apply.yml");
  // Refused or unreachable: said.
  if (drain !== null) return drain;
  // Started. The count tells the browser how many rows the run will try.
  return json(200, { status: "ok", dispatched: true, approved: counted.count, kit_dispatched: true });
}

/* True only for a JSON body whose kit_only is exactly true. Closed on purpose (CLAUDE.md §6): no body (the
   approve path sends none), unparseable text, "true" as a string or any other shape all keep the approve
   behaviour, so a malformed request can never silently skip the approve path's gates. */
async function wantsKitOnly(req: Request): Promise<boolean> {
  // The raw text: an empty body is "" here, where req.json() would throw.
  const raw = await req.text().catch(() => "");
  // Nothing sent: the approve path.
  if (raw.trim() === "") return false;
  // Parsed inside a try, because a bad body is "not kit-only", never a 500.
  try {
    // The body as sent.
    const parsed: unknown = JSON.parse(raw);
    // An object (not an array or null) whose flag is the boolean true and nothing looser.
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) && (parsed as Record<string, unknown>).kit_only === true;
  } catch {
    // Unparseable: the approve path.
    return false;
  }
}

/* One workflow dispatch. Null when GitHub accepted it; otherwise the 502 to answer with, naming the
   workflow so the browser says WHICH run did not start. Never throws, never echoes the token. */
async function dispatch(deps: DispatchDeps, token: string, url: string, body: Record<string, unknown>, workflow: string): Promise<Response | null> {
  // The answer, once fetched.
  let res: Response;
  // A thrown fetch (network, timeout) is a 502 below.
  try {
    // GitHub answers 204 No Content on success.
    res = await deps.fetch(url, {
      // Create a workflow dispatch event.
      method: "POST",
      // The token as a bearer; GitHub's documented media type and a pinned API version.
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "Content-Type": "application/json" },
      // The ref and the workflow's own inputs.
      body: JSON.stringify(body),
      // Bounded.
      signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
    });
  } catch (cause) {
    // The error's name only; a message could carry request details.
    console.error(`[dispatch-apply] GitHub unreachable (${workflow}):`, cause instanceof Error ? cause.name : "unknown");
    // Upstream fault.
    return json(502, { status: "error", message: `github_unreachable (${workflow})` });
  }
  // Anything but a 2xx: GitHub's status, never the token or its body (it can echo the request).
  if (!res.ok) return json(502, { status: "error", message: `github_refused: HTTP ${res.status} (${workflow})` });
  // Accepted.
  return null;
}
