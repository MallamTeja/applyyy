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

// Default batch processing size per run.
const DEFAULT_BATCH_SIZE = 50;
// Maximum batch limit to prevent timeout or excessive payload sizes.
const MAX_BATCH_SIZE = 100;

// Standard CORS headers required for Supabase Edge Functions.
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
};

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
Deno.serve(async (req: Request): Promise<Response> => {
  // Handle OPTIONS preflight request.
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  // Initialize DB client.
  const connection = await createAppUserClient();
  if (!connection.ok) {
    console.error("[screener] DB client connection failed:", connection.reason);
    return jsonResponse(503, { success: false, error: "database_unavailable" });
  }
  const db = connection.db;

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

  // Inspect system kill switch settings.
  const url = new URL(req.url);
  const force = url.searchParams.get("force") === "true";
  const { data: settingsData, error: settingsError } = await db
    .from("system_settings")
    .select("system_enabled")
    .limit(1)
    .single();

  if (settingsError && settingsError.code !== "PGRST116") {
    return await failRun(500, "kill_switch_read_failed", settingsError.message);
  }

  const systemEnabled = settingsData?.system_enabled ?? false;
  if (!systemEnabled && !force) {
    if (runId) {
      await db
        .from("agent_runs")
        .update({
          status: "skipped_disabled",
          finished_at: new Date().toISOString(),
          error_detail: "system_settings.system_enabled is false",
        })
        .eq("id", runId);
    }
    return jsonResponse(200, {
      status: "halted_by_kill_switch",
      message: "system_settings.system_enabled is false. Set ?force=true to override.",
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
      // Mark application as failed when associated job row is absent.
      await db
        .from("applications")
        .update({ status: "failed", failure_reason: "missing_job_record", status_changed_at: new Date().toISOString() })
        .eq("id", app.id);
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

    if (insertResult.status === "passed_filters") {
      // Transition status from 'deduped' to 'passed_filters'.
      const { error: updateErr } = await db
        .from("applications")
        .update({
          status: "passed_filters",
          drop_reason: null,
          status_changed_at: new Date().toISOString(),
        })
        .eq("id", app.id);

      if (updateErr) {
        console.error(`[screener] Failed to update application ${app.id} to passed_filters:`, updateErr.message);
        failedCount++;
      } else {
        passedCount++;
      }
    } else {
      // Transition status from 'deduped' to 'dropped_filter'.
      const { error: updateErr } = await db
        .from("applications")
        .update({
          status: "dropped_filter",
          drop_reason: insertResult.drop_reason,
          status_changed_at: new Date().toISOString(),
        })
        .eq("id", app.id);

      if (updateErr) {
        console.error(`[screener] Failed to update application ${app.id} to dropped_filter:`, updateErr.message);
        failedCount++;
      } else {
        droppedCount++;
      }
    }
  }

  // Complete agent run row telemetry.
  if (runId) {
    await db
      .from("agent_runs")
      .update({
        status: "succeeded",
        finished_at: new Date().toISOString(),
        rows_in: apps.length,
        rows_out: passedCount,
      })
      .eq("id", runId);
  }

  // Return final JSON run response.
  return jsonResponse(200, {
    success: true,
    processed: apps.length,
    passed: passedCount,
    dropped: droppedCount,
    failed: failedCount,
    warnings: [...warnings],
  });
});
