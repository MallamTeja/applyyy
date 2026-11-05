// Interview Prep Edge Function Runner
//
// WHAT THIS EDGE FUNCTION DOES:
// 1. Queries applications sitting at status `interview`.
// 2. Skips any application that already has an `interview_prep_packs` row.
// 3. Generates a prep pack with Gemini, validated against the prompt's schema.
// 4. Inserts the pack into `interview_prep_packs`.
//
// WHAT IT DELIBERATELY DOES NOT DO (changed 2026-10-04):
// - It never changes `applications.status`. A prep pack is a side artifact of an
//   interview, not a pipeline stage. The old call named a status (`interview_prepped`) and
//   an agent (`interview_prep`) that do not exist and used the wrong RPC parameter names,
//   so it failed on every row; the existence check in step 2 is the real idempotency key.
// - It never stores the fallback template. Step 2 skips any application with a pack, so a
//   stored placeholder was permanent and Gemini was never asked again. On any failure the
//   function stores nothing and the next run retries. The table has no column to mark a
//   row as a fallback, so "store nothing" is the only honest option without a migration.
//
// TELEMETRY RESTORED 2026-10-04 as agent 'interview_prep' (migration 20261004210000).
// It was dropped while no enum value existed; borrowing another agent's name would
// have credited that agent on the health page. A failed agent_runs write is logged and
// never blocks pack generation.

// Authenticated database client. WHY: every query runs under RLS as the app user.
import { createAuthorizedAppUserClient } from "../_shared/db/client.ts";
// Caller auth and the fail-closed kill switch. WHY: shared with every agent that spends quota.
import { authorizeCaller, readKillSwitch } from "../_shared/db/gates.ts";
// Gemini transport with key-pool failover. WHY: handles 429 rotation for us.
import { generateGeminiContent } from "../_shared/gemini/client.ts";
// WHY: the shared failure description (reason, status, short redacted detail).
import { describeGeminiFailure } from "../_shared/gemini/failure-message.ts";
// Prompt builder. WHY: fences the untrusted job text and carries the response schema.
import { buildInterviewPrepPrompt } from "../_shared/interview-prep/prompt.ts";
// The stored pack's type. WHY: the validated parse result must match it structurally.
import type { InterviewPrepPack } from "../_shared/interview-prep/prep-generator.ts";
// Shape validator. WHY: a malformed reply must become "nothing stored", never an empty pack.
import { parsePrepPack } from "./parse-pack.ts";

// Default batch size. WHY: bounds LLM calls per run when the caller gives no limit.
const DEFAULT_BATCH_SIZE = 5;

// Batch ceiling. WHY: prevents excessive LLM quota burn in a single execution.
const MAX_BATCH_SIZE = 10;

// Standard CORS headers object.
// WHY: Required for cross-origin browser client requests.
const corsHeaders = {
  // Allow all origins.
  // WHY: Authorization header and RLS enforce security.
  "Access-Control-Allow-Origin": "*",
  // Allowed request headers.
  // WHY: Permits auth token and content type.
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  // Allowed HTTP methods.
  // WHY: Supports GET, POST, and OPTIONS preflights.
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
};

// Formats JSON HTTP responses with status code and CORS headers.
// WHY: Encapsulates response creation with standard content type and CORS.
function jsonResponse(status: number, data: Record<string, unknown>): Response {
  // WHY: one constructor so every exit carries the same headers.
  return new Response(JSON.stringify(data, null, 2), {
    // WHY: signals success or the specific failure.
    status,
    // WHY: JSON content type plus CORS, or a browser hides the status.
    headers: { "content-type": "application/json; charset=utf-8", ...corsHeaders },
  });
}

// Parses `?limit`. WHY: the same shape check as the pipeline agents — `Number("abc")` is
// NaN and `Number("2.5")` is a fraction, and both used to slip through `|| DEFAULT`.
function resolveBatchSize(raw: string | null): number {
  // Absent parameter: the default.
  if (raw === null) return DEFAULT_BATCH_SIZE;
  // `Number("")` is 0, rejected below along with NaN and fractions.
  const parsed = Number(raw);
  // Only a positive whole number is a batch size.
  if (!Number.isInteger(parsed) || parsed < 1) return DEFAULT_BATCH_SIZE;
  // Clamp to the ceiling.
  return Math.min(parsed, MAX_BATCH_SIZE);
}

// Register Deno HTTP server request handler.
// WHY: Entrypoint for edge function execution.
Deno.serve(async (req: Request): Promise<Response> => {
  // WHY: browser CORS preflight must be answered before any work.
  if (req.method === "OPTIONS") {
    // WHY: completes the preflight.
    return new Response("ok", { headers: corsHeaders });
  }

  // WHY: grants database access bound by tenant security policies.
  const connection = await createAuthorizedAppUserClient(req);
  // W15 (2026-11-05): a refused caller (no token, the public anon key, another user) is answered HERE,
  // before any password grant was spent on Teja's account; same status and body as the caller check below.
  if (!connection.ok && connection.kind === "refused") return jsonResponse(connection.status, { success: false, error: connection.error });

  // WHY: without a session no query is safe.
  if (!connection.ok) {
    // WHY: operational diagnostics stay in the function log.
    console.error("[interview-prep] DB connection failed:", connection.reason);
    // WHY: tells the caller the database is unavailable.
    return jsonResponse(503, { success: false, error: "database_unavailable" });
  }

  // WHY: the handle every query below uses.
  const db = connection.db;

  // Kept as a second check (defense in depth, 2026-11-05): the caller was already verified BEFORE
  // the sign-in (createAuthorizedAppUserClient, W15). This re-checks the session against the signed-in
  // user's id with one token lookup, never a password grant.
  const caller = await authorizeCaller(req, db, connection.userId);
  // WHY: 401 for no/invalid session, 403 for someone else's; a refused call is not a run.
  if (!caller.ok) return jsonResponse(caller.status, { success: false, error: caller.error });

  // WHY: opened before any work, so a crash leaves a visible stuck run rather than nothing.
  const { data: runRow, error: runError } = await db
    .from("agent_runs")
    // WHY: its own identity; never borrowed.
    .insert({ agent: "interview_prep", status: "running", started_at: new Date().toISOString() })
    // WHY: only the id is needed to close it.
    .select("id")
    // WHY: exactly one row was inserted.
    .single();
  // WHY: telemetry must not block the agent — a failed insert (e.g. the enum migration not
  // pushed yet) is logged and generation still runs.
  if (runError) console.error("[interview-prep] agent_runs insert failed; continuing without telemetry:", runError.message);
  // WHY: undefined when the insert failed; closeRun then does nothing.
  const runId: string | undefined = runRow?.id;
  // WHY: one close path for every exit. Never throws: a failed close is logged instead.
  async function closeRun(patch: Record<string, unknown>): Promise<void> {
    // WHY: no row to close.
    if (!runId) return;
    // WHY: finish time plus the caller's verdict and counters.
    const { error } = await db.from("agent_runs").update({ finished_at: new Date().toISOString(), ...patch }).eq("id", runId);
    // WHY: explains a row stuck at `running`.
    if (error) console.error("[interview-prep] agent_runs close failed:", error.message);
  }

  // WHY: the shared fail-closed switch, same as every pipeline agent. The `?force=true`
  // override was removed 2026-10-04: a URL parameter any caller can type must not
  // outrank the switch the user flipped to stop Gemini spend.
  const killSwitch = await readKillSwitch(db);
  // WHY: an unreadable switch is an error, not a decision — and never "on".
  if (killSwitch.kind === "unreadable") {
    // WHY: shown on the health page as a failure.
    await closeRun({ status: "failed", error_detail: killSwitch.detail });
    // WHY: retryable.
    return jsonResponse(503, { success: false, error: "kill_switch_read_failed" });
  }
  // WHY: off is a deliberate halt.
  if (killSwitch.kind === "disabled") {
    // WHY: recorded so the health page can tell a deliberate halt from a dead cron.
    await closeRun({ status: "skipped_disabled", error_detail: killSwitch.detail });
    // WHY: 200, because halting on the switch is the system doing what it was told.
    return jsonResponse(200, { status: "halted_by_kill_switch", processed: 0 });
  }

  // WHY: the batch size comes from the query string.
  const url = new URL(req.url);

  // WHY: bound the batch; validated so NaN and fractions cannot reach `.limit()`.
  const batchSize = resolveBatchSize(url.searchParams.get("limit"));

  // WHY: applications at the interview stage are the ones that need a prep pack.
  const { data: apps, error: appsError } = await db
    // Target applications table.
    .from("applications")
    // Application keys plus the joined job fields the prompt needs.
    .select("id, user_id, job_id, jobs ( company_name, title, description_raw )")
    // Only interview-stage rows.
    .eq("status", "interview")
    // Bounded batch.
    .limit(batchSize);

  // WHY: a failed read is a failed run, not an empty queue.
  if (appsError) {
    // WHY: the detail can name tables; keep it in the log.
    console.error("[interview-prep] applications query failed:", appsError.message);
    // WHY: a failed read is a failed run on the health page, not an idle one.
    await closeRun({ status: "failed", error_detail: appsError.message.slice(0, 500) });
    // WHY: a fixed code to the caller.
    return jsonResponse(500, { success: false, error: "query_applications_failed" });
  }

  // WHY: early exit when nothing is pending.
  if (!apps || apps.length === 0) {
    // WHY: idle is a successful run with zero rows, so the health page still sees it ran.
    await closeRun({ status: "succeeded", rows_in: 0, rows_out: 0, error_count: 0, gemini_calls: 0 });
    // WHY: an empty queue is success.
    return jsonResponse(200, { status: "no_eligible_applications", processed: 0, generated: 0 });
  }

  // WHY: metrics for the response payload.
  let generatedCount = 0;
  // WHY: LLM spend per run is worth reporting.
  let geminiCalls = 0;
  // WHY: per-row problems are reported, not thrown, so one bad row does not stop the batch.
  const warnings: string[] = [];

  // WHY: sequential, so LLM calls stay paced per candidate.
  for (const app of apps) {
    // WHY: the existence check is the idempotency key; regenerating burns quota.
    const { data: existingPrep, error: existingError } = await db
      // Target interview_prep_packs table.
      .from("interview_prep_packs")
      // Existence only.
      .select("id")
      // For this application.
      .eq("application_id", app.id)
      // One is enough.
      .limit(1)
      // Row or null.
      .maybeSingle();

    // WHY: an unreadable check must not read as "no pack yet" — that would duplicate.
    if (existingError) {
      // WHY: surfaced to the caller; the row is retried next run.
      warnings.push(`Could not check existing prep pack for ${app.id}; skipped.`);
      // WHY: skip this row only.
      continue;
    }

    // WHY: idempotent execution.
    if (existingPrep) continue;

    // WHY: the embed is untyped; narrow it once.
    const job = app.jobs as unknown as { company_name?: string; title?: string; description_raw?: string } | null;
    // WHY: prompt context; a placeholder beats an empty fence.
    const companyName = job?.company_name?.trim() ?? "Company";
    // WHY: prompt context.
    const jobTitle = job?.title?.trim() ?? "Position";
    // WHY: prompt context; may legitimately be empty.
    const jobDescription = job?.description_raw?.trim() ?? "";

    // WHY: fenced prompt plus response schema.
    const promptPayload = buildInterviewPrepPrompt({ jobTitle, companyName, jobDescription });

    // WHY: count every attempt, successful or not, because each one spends quota.
    geminiCalls++;
    // WHY: a thrown transport error is treated like any other failure: store nothing.
    let prepPack: InterviewPrepPack | null = null;
    try {
      // WHY: the LLM call itself.
      const outcome = await generateGeminiContent(db, { prompt: promptPayload });
      // WHY: a failed call stores nothing; the next run retries.
      if (!outcome.ok) {
        // WHY: reason, status and a capped, key-redacted detail are safe to report and tell one
        // http_error from another; the full detail still goes to the log below.
        warnings.push(`Gemini call failed for ${app.id} (${describeGeminiFailure(outcome)}); nothing stored, will retry.`);
        // WHY: the detail can carry upstream error bodies.
        console.warn("[interview-prep] gemini failure:", outcome.reason, outcome.detail);
      } else {
        // WHY: the schema-constrained reply is in the first candidate's first part.
        const text = outcome.data.candidates?.[0]?.content?.parts?.[0]?.text;
        // WHY: shape-validated; null means off-schema, never an empty pack.
        prepPack = typeof text === "string" ? parsePrepPack(text) : null;
        // WHY: an off-schema reply is reported and retried, not stored.
        if (prepPack === null) warnings.push(`Gemini reply for ${app.id} did not match the prep pack schema; nothing stored.`);
      }
    } catch (err) {
      // WHY: transport exceptions are logged, not stored as a pack.
      console.warn("[interview-prep] gemini threw:", err);
      // WHY: the caller sees which row failed.
      warnings.push(`Error generating prep pack for ${app.id}; nothing stored, will retry.`);
    }

    // WHY: no validated pack, nothing to write.
    if (prepPack === null) continue;

    // WHY: persist the pack for the dashboard.
    const { error: insertError } = await db
      // Target interview_prep_packs table.
      .from("interview_prep_packs")
      // Explicit columns from the validated pack.
      .insert({
        // WHY: tenant column, required by RLS `with check`.
        user_id: app.user_id,
        // WHY: the idempotency key checked above.
        application_id: app.id,
        // WHY: lets the UI join the job without going through applications.
        job_id: app.job_id,
        // WHY: validated non-blank text.
        company_overview: prepPack.companyResearchOverview,
        // WHY: validated non-empty lists.
        role_specific_questions: prepPack.roleSpecificQuestions,
        // WHY: validated non-empty lists.
        experience_highlights: prepPack.experienceHighlights,
        // WHY: validated non-empty lists.
        talking_points: prepPack.talkingPoints,
      });

    // WHY: a failed write is reported per row.
    if (insertError) {
      // WHY: detail to the log.
      console.error("[interview-prep] insert failed:", app.id, insertError.message);
      // WHY: the caller sees which row failed.
      warnings.push(`Failed to insert interview_prep_pack for ${app.id}.`);
    } else {
      // WHY: success is a stored pack; there is no status transition to wait for.
      generatedCount++;
    }
  }

  // WHY: matcher's honest rule — `failed` only when there was work, none of it landed and
  // errors explain why. Mixed stays `succeeded` (agent_run_status has no `partial`), and a
  // batch of rows that all already had packs is idle, not broken: warnings stays empty.
  const runStatus = apps.length > 0 && generatedCount === 0 && warnings.length > 0 ? "failed" : "succeeded";
  // WHY: first three DISTINCT reasons, capped; null on a clean run so no stale reason lingers.
  const errorDetail = warnings.length > 0 ? [...new Set(warnings)].slice(0, 3).join(" | ").slice(0, 500) : null;
  // WHY: the counters the health page reads; warnings are exactly the per-row failures.
  await closeRun({
    // WHY: derived from the counters, never hard-coded.
    status: runStatus,
    // WHY: the reason, not just the count.
    error_detail: errorDetail,
    // WHY: rows read, including those skipped because a pack exists.
    rows_in: apps.length,
    // WHY: packs actually stored.
    rows_out: generatedCount,
    // WHY: rows that stored nothing for a reason.
    error_count: warnings.length,
    // WHY: quota spent.
    gemini_calls: geminiCalls,
  });

  // WHY: report processing metrics to the caller.
  return jsonResponse(200, {
    // The run completed; per-row failures are in `warnings`.
    success: true,
    // WHY: the same verdict agent_runs holds, so the two never disagree.
    status: runStatus,
    // Rows considered.
    processed: apps.length,
    // Packs stored.
    generated: generatedCount,
    // LLM calls spent.
    gemini_calls: geminiCalls,
    // Per-row problems.
    warnings,
  });
});
