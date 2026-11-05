// Follow-up — Edge Function that drafts follow-up nudge emails for stale applications.
//
// Reads applications at status `applied` older than seven days, drafts one nudge each
// through Gemini (no template fallback: a failure stores nothing and the next run
// retries, because the already-nudged exclusion made a stored template permanent),
// and inserts it into `follow_up_nudges`
// for the user to review.
//
// REWRITTEN 2026-10-04. Before this, every insert failed: it wrote `subject`/`body`/
// `status:'draft'` into a table whose NOT NULL columns are `user_id`, `job_id`,
// `draft_subject` and `draft_body`; it selected `company_name`/`job_title` from
// `applications`, which has neither; and it logged agent runs under a column
// (`agent_name`) that does not exist. All three errors were logged and swallowed.
//
// TELEMETRY RESTORED 2026-10-04 as agent 'follow_up' (migration 20261004210000). It was
// dropped while no enum value existed, because borrowing `tracker` would have made the
// health page report the email tracker alive when it was not. A failed agent_runs write
// is logged and never blocks drafting.

// Signs in as the app user, so every query runs under RLS.
import { createAuthorizedAppUserClient } from "../_shared/db/client.ts";
// Caller auth and the fail-closed kill switch, shared with the pipeline agents.
import { authorizeCaller, readKillSwitch } from "../_shared/db/gates.ts";
// Shared CORS headers, plus the boundary that keeps them on an uncaught 500.
import { corsHeaders, withErrorBoundary } from "../_shared/cors.ts";
// Draft generation (Gemini with template fallback).
import { generateFollowUpNudge } from "../_shared/follow-up/nudge.ts";
// Row validation and the insert's exact column names, pinned by nudge-row.test.ts.
import { readNudgeSource, toNudgeInsert } from "../_shared/follow-up/nudge-row.ts";

// How many nudges one invocation drafts. Small: each one may be a Gemini call.
const BATCH_SIZE = 5;
// An application must have gone quiet this long before nudging is polite.
const FOLLOW_UP_AFTER_DAYS = 7;

// One JSON response shape for every exit.
function jsonResponse(status: number, data: Record<string, unknown>): Response {
  // CORS on every response, or the browser hides the status from the page.
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...corsHeaders },
  });
}

// Wrapped so a throw anywhere below still answers with CORS headers.
Deno.serve(withErrorBoundary("applyy-follow-up", async (req: Request): Promise<Response> => {
  // Preflight, before any work.
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  // Sign in; a missing credential is an operational 503, not a bug.
  const connection = await createAuthorizedAppUserClient(req);
  // W15 (2026-11-05): a refused caller (no token, the public anon key, another user) is answered HERE,
  // before any password grant was spent on Teja's account; same status and body as the caller check below.
  if (!connection.ok && connection.kind === "refused") return jsonResponse(connection.status, { success: false, error: connection.error });
  if (!connection.ok) {
    // `reason` stays in the log — it distinguishes "no user" from "wrong password".
    console.error("[applyy-follow-up] could not sign in:", connection.reason);
    return jsonResponse(503, { success: false, error: "database_unavailable" });
  }
  // Unpacked once for readability.
  const db = connection.db;

  // Kept as a second check (defense in depth, 2026-11-05): the caller was already verified BEFORE
  // the sign-in (createAuthorizedAppUserClient, W15). This re-checks the session against the signed-in
  // user's id with one token lookup, never a password grant.
  const caller = await authorizeCaller(req, db, connection.userId);
  // 401 or 403, as the verdict says.
  if (!caller.ok) return jsonResponse(caller.status, { success: false, error: caller.error });

  // Open the run row after auth (a refused caller is not a run) and before any work,
  // so a crash leaves a visible stuck run rather than nothing.
  const { data: runRow, error: runError } = await db
    .from("agent_runs")
    // Its own identity; never borrowed.
    .insert({ agent: "follow_up", status: "running", started_at: new Date().toISOString() })
    // Only the id is needed to close it.
    .select("id")
    // Exactly one row.
    .single();
  // Telemetry must not block the agent: a failed insert (e.g. the enum migration not
  // pushed yet) is logged and drafting still runs.
  if (runError) console.error("[applyy-follow-up] agent_runs insert failed; continuing without telemetry:", runError.message);
  // Undefined when the insert failed; closeRun then does nothing.
  const runId: string | undefined = runRow?.id;
  // Closes the run row. Never throws: a failed close is logged for the same reason.
  async function closeRun(patch: Record<string, unknown>): Promise<void> {
    // No row to close.
    if (!runId) return;
    // Finish time plus the caller's verdict and counters.
    const { error } = await db.from("agent_runs").update({ finished_at: new Date().toISOString(), ...patch }).eq("id", runId);
    // Explains a row stuck at `running`.
    if (error) console.error("[applyy-follow-up] agent_runs close failed:", error.message);
  }

  // Same fail-closed switch as the pipeline agents.
  const killSwitch = await readKillSwitch(db);
  // A broken read is retryable, so 503 — and a failure on the health page.
  if (killSwitch.kind === "unreadable") {
    // Recorded with the reason.
    await closeRun({ status: "failed", error_detail: killSwitch.detail });
    // Retryable.
    return jsonResponse(503, { success: false, error: "kill_switch_read_failed" });
  }
  // Off: a deliberate halt, recorded so the health page can say why nothing ran.
  if (killSwitch.kind === "disabled") {
    // Distinct from a dead cron.
    await closeRun({ status: "skipped_disabled", error_detail: killSwitch.detail });
    // 200: the system did what it was told.
    return jsonResponse(200, { success: true, status: "skipped_disabled" });
  }

  // Applications that already have a nudge. Excluded up front, because now that
  // inserts succeed, re-running would otherwise draft a duplicate every invocation —
  // and filtering after the `limit` would starve the queue on the same five rows.
  const { data: existing, error: existingError } = await db.from("follow_up_nudges").select("application_id");
  // Without this list we cannot avoid duplicates, so stop rather than guess.
  if (existingError) {
    // A failed read is a failed run, not an idle one.
    await closeRun({ status: "failed", error_detail: existingError.message.slice(0, 500) });
    // Retryable.
    return jsonResponse(503, { success: false, error: "nudges_unreadable" });
  }
  // The ids to skip, as strings for the postgrest `in` list.
  const nudgedIds = (existing ?? []).map((r) => String((r as { application_id: unknown }).application_id));

  // The cut-off: applied at least FOLLOW_UP_AFTER_DAYS ago.
  const cutoff = new Date(Date.now() - FOLLOW_UP_AFTER_DAYS * 24 * 60 * 60 * 1000).toISOString();
  // Company and title live on `jobs` (core_tables.sql:190-192), so they come via the join.
  let query = db
    .from("applications")
    .select("id, user_id, job_id, applied_at, jobs ( title, company_name )")
    .eq("status", "applied")
    .lte("applied_at", cutoff)
    // Oldest first: the longest-silent application is the one most worth a nudge.
    .order("applied_at", { ascending: true })
    .limit(BATCH_SIZE);
  // Skip already-nudged rows. Only applied when non-empty: `not in ()` is a syntax error.
  if (nudgedIds.length > 0) query = query.not("id", "in", `(${nudgedIds.join(",")})`);
  // Run it.
  const { data: applications, error: appsError } = await query;
  // A failed read is reported, not mistaken for "nothing to do".
  if (appsError) {
    // A failed read is a failed run, not an empty queue.
    await closeRun({ status: "failed", error_detail: appsError.message.slice(0, 500) });
    // Retryable.
    return jsonResponse(503, { success: false, error: "applications_unreadable" });
  }

  // Counters reported back so a run that wrote nothing is visible as such.
  let drafted = 0;
  // Every generate call is exactly one model call, so quota spend is reportable.
  let geminiCalls = 0;
  // Per-row failures with their reason.
  const failures: Array<{ applicationId: string; error: string }> = [];

  // Sequential: each may be a Gemini call against the shared key pool.
  for (const row of applications ?? []) {
    // Validate the row's shape before anything reaches the prompt or the insert.
    const source = readNudgeSource(row);
    // Incomplete row (no posting joined, missing id): reported, never half-written.
    if (!source) {
      failures.push({ applicationId: String((row as { id?: unknown }).id), error: "incomplete_application_row" });
      continue;
    }

    // Counted before the call: a failed attempt still spends quota.
    geminiCalls += 1;
    // Draft or a reason; never throws.
    const outcome = await generateFollowUpNudge(db, {
      companyName: source.companyName,
      jobTitle: source.jobTitle,
      applicationDate: source.appliedAt,
    });
    // No validated draft: store nothing, count it, and the next run retries this row.
    if (!outcome.ok) {
      // Reported with the generator's reason code.
      failures.push({ applicationId: source.applicationId, error: outcome.error });
      // Next application.
      continue;
    }

    // Insert with the migration's real column names, and CHECK the error.
    const { error: insertError } = await db.from("follow_up_nudges").insert(toNudgeInsert(source, outcome.draft));
    // A failed insert is counted and reported, not just logged.
    if (insertError) failures.push({ applicationId: source.applicationId, error: insertError.message });
    // Landed.
    else drafted += 1;
  }

  // Rows the queue returned; the denominator for the honest status.
  const rowsIn = (applications ?? []).length;
  // HONEST FINAL STATUS (matcher's rule): `failed` only when there was work, none of it
  // landed, and errors explain why; mixed stays `succeeded` with error_count set, since
  // agent_run_status has no `partial`, and an empty queue is idle, not broken.
  const runStatus = rowsIn > 0 && drafted === 0 && failures.length > 0 ? "failed" : "succeeded";
  // First three DISTINCT reasons, capped; null on a clean run so no stale reason lingers.
  const errorDetail = failures.length > 0
    ? [...new Set(failures.map((f) => f.error))].slice(0, 3).join(" | ").slice(0, 500)
    : null;
  // The counters the health page reads, gemini_calls included now that there is no
  // template path to blur it.
  await closeRun({ status: runStatus, error_detail: errorDetail, rows_in: rowsIn, rows_out: drafted, error_count: failures.length, gemini_calls: geminiCalls });

  // The summary a caller can act on, with the same verdict as agent_runs.
  return jsonResponse(200, { success: true, status: runStatus, drafted, gemini_calls: geminiCalls, failures });
}));
