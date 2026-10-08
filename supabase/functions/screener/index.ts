// Screener — Edge Function Entrypoint & Batch Runner
//
// Reads `applications` sitting at status `deduped`, evaluates stage 0 (tech gate) and
// the deterministic cascade filter rules against each linked posting, and advances
// passed rows to `passed_filters` or dropped rows to `dropped_filter` (with drop_reason
// recording the matching rule).
//
// WHERE THIS SITS:
// Processes queue items sitting at status 'deduped' (the legal source state for the
// screener according to status_transition_guard.sql).

// Database client creation helper. Signs in under RLS policy.
import { createAppUserClient } from "../_shared/db/client.ts";
// Batch evaluation planner and row adapter.
import { planScreenedApplications } from "../_shared/screen/screen-batch.ts";
// Screener context loader (rules, blocklist, application history, preferences).
import { loadScreenContext } from "../_shared/screen/context.ts";
// Supabase queries adapter for screener context reads.
import { supabaseScreenQueries } from "../_shared/screen/supabase-queries.ts";
// Type definitions from shared contracts.
import type { JobRow } from "../_shared/contracts/shared-types.ts";
// The guarded status write. A bare `.update({ status })` is refused by the transition
// guard with 42501, which is why no row used to leave `deduped`.
import { persistScreenVerdict } from "../_shared/screen/persist-verdict.ts";
// Caller auth and the fail-closed kill switch, shared by every pipeline agent.
import { authorizeCaller, readKillSwitch } from "../_shared/db/gates.ts";
// Shared CORS headers, plus the boundary that keeps them on an uncaught 500.
import { corsHeaders, withErrorBoundary } from "../_shared/cors.ts";
// Persists the cascade's "rule skipped" warnings into the run row (B1, 2026-10-08).
import { withRuleWarnings } from "../_shared/screen/run-summary.ts";

// Default batch processing size per run.
const DEFAULT_BATCH_SIZE = 50;
// Maximum batch limit to prevent timeout or excessive payload sizes.
const MAX_BATCH_SIZE = 100;

// Formats a JSON response with status and CORS headers.
function jsonResponse(status: number, data: Record<string, unknown>): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...corsHeaders },
  });
}

// Parses and clamps the requested batch size.
function resolveBatchSize(raw: string | null): number {
  if (raw === null) return DEFAULT_BATCH_SIZE;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) return DEFAULT_BATCH_SIZE;
  return Math.min(parsed, MAX_BATCH_SIZE);
}

// Entrypoint handler for Deno runtime.
// Wrapped so a throw anywhere below still answers with CORS headers the browser can read.
Deno.serve(withErrorBoundary("screener", async (req: Request): Promise<Response> => {
  // Handle OPTIONS preflight request.
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  // Initialize DB client.
  const connection = await createAppUserClient();
  if (!connection.ok) {
    console.error("[screener] DB client connection failed:", connection.reason);
    return jsonResponse(503, { success: false, error: "database_unavailable" });
  }
  const db = connection.db;

  // Refuse anyone but the app user BEFORE any write, including the telemetry row: the
  // sign-in above never looked at the caller, and the anon key alone used to suffice.
  const caller = await authorizeCaller(req, db, connection.userId);
  if (!caller.ok) return jsonResponse(caller.status, { success: false, error: caller.error });

  // Insert agent_runs tracking row for screener agent.
  const { data: runRow } = await db
    .from("agent_runs")
    .insert({ agent: "screener", status: "running", started_at: new Date().toISOString() })
    .select("id")
    .single();
  const runId: string | undefined = runRow?.id;

  // Helper to mark agent run as failed and output error response.
  async function failRun(status: number, error: string, detail: string): Promise<Response> {
    if (runId) {
      await db
        .from("agent_runs")
        .update({ status: "failed", finished_at: new Date().toISOString(), error_detail: detail })
        .eq("id", runId);
    }
    return jsonResponse(status, { success: false, error, detail });
  }

  // The shared fail-closed kill switch. The old `?force=true` bypass is gone: every
  // agent now honours the switch the same way, and a URL parameter overriding a safety
  // switch is exactly the inconsistency this replaced.
  const url = new URL(req.url);
  const killSwitch = await readKillSwitch(db);
  // A failed read halts as an error, never as a decision either way.
  if (killSwitch.kind === "unreadable") {
    return await failRun(503, "kill_switch_read_failed", killSwitch.detail);
  }
  // Off (or no settings row): record WHY nothing ran, so the health page can tell.
  if (killSwitch.kind === "disabled") {
    if (runId) {
      await db
        .from("agent_runs")
        .update({
          status: "skipped_disabled",
          finished_at: new Date().toISOString(),
          error_detail: killSwitch.detail,
        })
        .eq("id", runId);
    }
    return jsonResponse(200, {
      status: "halted_by_kill_switch",
      message: killSwitch.detail,
      processed: 0,
    });
  }

  // Load screen context at current run timestamp.
  const now = new Date();
  const screenContext = await loadScreenContext(supabaseScreenQueries(db, now), now);
  if (!screenContext.ok) {
    return await failRun(503, "screener_context_unavailable", screenContext.reason);
  }

  // Fetch applications at status 'deduped'.
  const batchSize = resolveBatchSize(url.searchParams.get("limit"));
  const { data: apps, error: appsError } = await db
    .from("applications")
    .select("id, job_id, user_id, status, jobs ( id, fingerprint, title, company_name, company_slug, location_raw, locations, employment_type, min_experience_years, requires_advanced_degree, posted_at, posted_at_source, description_raw )")
    .eq("status", "deduped")
    .order("created_at", { ascending: true })
    .limit(batchSize);

  if (appsError) {
    return await failRun(500, "query_deduped_apps_failed", appsError.message);
  }

  // Handle case where no deduped applications are queued.
  if (!apps || apps.length === 0) {
    if (runId) {
      await db
        .from("agent_runs")
        .update({ status: "succeeded", finished_at: new Date().toISOString(), rows_in: 0, rows_out: 0 })
        .eq("id", runId);
    }
    return jsonResponse(200, {
      status: "no_deduped_applications",
      message: "No applications found at status 'deduped'.",
      processed: 0,
      passed: 0,
      dropped: 0,
    });
  }

  // Accumulate counters and warnings.
  let passedCount = 0;
  let droppedCount = 0;
  let failedCount = 0;
  const warnings = new Set<string>();

  // Process each application through screen batch planner.
  for (const app of apps) {
    const rawJob = app.jobs as unknown as JobRow | null;
    if (!rawJob) {
      // No posting to judge is a deterministic, permanent condition: fail the row so it
      // stops sorting first and blocking the queue every run. Through the RPC, which is
      // the only route the transition guard accepts.
      const failed = await persistScreenVerdict(db, app.id, { status: "failed", reason: "missing_job_record" });
      if (!failed.ok) console.error(`[screener] Failed to fail application ${app.id}:`, failed.message);
      failedCount++;
      continue;
    }

    // Evaluate application through tech gate and filter cascade.
    const entry = { jobId: rawJob.id, row: rawJob };
    const plan = planScreenedApplications(
      [entry],
      screenContext.value.rules,
      screenContext.value.context,
      screenContext.value.preferences,
    );

    // Record warnings.
    for (const w of plan.warnings) warnings.add(w);

    const insertResult = plan.inserts[0];
    if (!insertResult) continue;

    // One write path for both verdicts: drop_reason first, status second, via the RPC.
    const written = await persistScreenVerdict(
      db,
      app.id,
      // Narrowed per branch so the union stays closed: a pass never carries a reason.
      insertResult.status === "passed_filters"
        ? { status: "passed_filters", reason: null }
        : { status: "dropped_filter", reason: insertResult.drop_reason },
    );

    // A refused write leaves the row at `deduped` for the next run, and is counted.
    if (!written.ok) {
      console.error(`[screener] Failed to advance application ${app.id} to ${insertResult.status}:`, written.message);
      failedCount++;
    } else if (insertResult.status === "passed_filters") {
      passedCount++;
    } else {
      droppedCount++;
    }
  }

  // HONEST FINAL STATUS. `failed` when there was work, none of it moved, and errors
  // explain why: the live matcher run seen 2026-10-04 (rows_in 10, rows_out 0,
  // error_count 10) was stamped `succeeded`, the silent stop agent_runs exists to catch.
  // Mixed results stay `succeeded` with error_count set: `agent_run_status` has no
  // `partial` (enums.sql:190), and an empty queue (rows_in 0) is idle, not broken.
  // `rows_out` below counts passes only, but a DROP is also a completed verdict, so
  // "nothing moved" means neither passed nor dropped: the reading pipelineRunner uses.
  const runStatus = apps.length > 0 && passedCount + droppedCount === 0 && failedCount > 0 ? "failed" : "succeeded";
  // This agent counts failures but does not collect their messages (each is written to
  // the function log at the failing row), so the summary says how many and where to
  // look rather than inventing a reason. Null on a clean run.
  const errorDetail = failedCount > 0 ? `${failedCount} of ${apps.length} rows errored; per-row reasons are in the screener function log` : null;

  // Complete agent run row telemetry.
  if (runId) {
    await db
      .from("agent_runs")
      .update({
        // Derived from the counters, never hard-coded: see runStatus above.
        status: runStatus,
        // The failure summary, so the health page says WHY and not just how many, plus the
        // labelled rule warnings, which were only ever in the HTTP response (B1, 2026-10-08).
        // error_count stays failedCount: a warning is not an error.
        error_detail: withRuleWarnings(errorDetail, warnings),
        finished_at: new Date().toISOString(),
        rows_in: apps.length,
        rows_out: passedCount,
        // Rows that could not be moved or were failed, so a run that advanced nothing is
        // visible on the health page instead of reading as a clean success.
        error_count: failedCount,
      })
      .eq("id", runId);
  }

  // Return final JSON run response.
  return jsonResponse(200, {
    // The function ran to completion; per-row failures are in `failed` below.
    success: true,
    // The same status written to agent_runs, so the dashboard and health page agree.
    status: runStatus,
    // The same failure summary, so the operator sees it without a DB query.
    error_detail: errorDetail,
    processed: apps.length,
    passed: passedCount,
    dropped: droppedCount,
    failed: failedCount,
    warnings: [...warnings],
  });
}));
