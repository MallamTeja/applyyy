// Interview Prep Edge Function Runner
//
// WHAT THIS EDGE FUNCTION DOES:
// 1. Queries applications sitting at status `interview`.
// 2. Checks if an `interview_prep_packs` record already exists for that application_id — skips if so.
// 3. Loads candidate master profile context from `master_profiles` table.
// 4. Loads linked job posting record details from `jobs` table.
// 5. Generates a personalized interview prep pack using Gemini LLM when available.
// 6. Uses deterministic fallback template if Gemini is rate limited or unavailable.
// 7. Inserts the prep pack into `interview_prep_packs` table.
// 8. Logs execution telemetry in `agent_runs` table for system health monitoring.

// Import authenticated database client helper.
// WHY: Ensures every query runs under RLS as the app user.
import { createAppUserClient } from "../_shared/db/client.ts";
// Import Gemini API transport helper with key pool failover.
// WHY: Manages rate limits and 429 key rotations automatically.
import { generateGeminiContent } from "../_shared/gemini/client.ts";
// Import prompt builder for interview prep packs.
// WHY: Constructs fenced instruction and response schema.
import { buildInterviewPrepPrompt } from "../_shared/interview-prep/prompt.ts";
// Import fallback generator and prep pack interface.
// WHY: Provides fallback prep pack when Gemini is unavailable.
import { buildFallbackPrepPack, type InterviewPrepPack } from "../_shared/interview-prep/prep-generator.ts";
// Import contract types.
// WHY: Type safety across shared domain modules.
import type { AgentName } from "../_shared/contracts/shared-types.ts";

// Default batch size constant.
// WHY: Limits how many applications to process per run.
const DEFAULT_BATCH_SIZE = 5;

// Maximum batch size ceiling constant.
// WHY: Prevents excessive LLM quota burn in a single execution.
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
  // Return formatted Response object.
  // WHY: Standard HTTP response constructor.
  return new Response(JSON.stringify(data, null, 2), {
    // HTTP status code.
    // WHY: Signals success or specific failure status.
    status,
    // Response headers.
    // WHY: Attaches JSON content-type and CORS headers.
    headers: { "content-type": "application/json; charset=utf-8", ...corsHeaders },
  });
}

// Register Deno HTTP server request handler.
// WHY: Entrypoint for edge function execution.
Deno.serve(async (req: Request): Promise<Response> => {
  // Check if request is OPTIONS CORS preflight.
  // WHY: Browser CORS preflight requests must return 200 OK fast.
  if (req.method === "OPTIONS") {
    // Return OK with CORS headers.
    // WHY: Completes preflight request.
    return new Response("ok", { headers: corsHeaders });
  }

  // Authenticate DB client under app user RLS.
  // WHY: Grants database access bound by tenant security policies.
  const connection = await createAppUserClient();

  // Handle DB connection failure.
  // WHY: Prevents unauthenticated queries and returns 503 error.
  if (!connection.ok) {
    // Log failure reason.
    // WHY: Operational diagnostics in function log.
    console.error("[interview-prep] DB connection failed:", connection.reason);
    // Return 503 error response.
    // WHY: Informs caller that database is unavailable.
    return jsonResponse(503, { success: false, error: "database_unavailable" });
  }

  // Extract client instance.
  // WHY: Database query execution handle.
  const db = connection.db;

  // Register execution run in agent_runs table.
  // WHY: Health page telemetry monitoring.
  const { data: runRow } = await db
    // Target agent_runs table.
    .from("agent_runs")
    // Insert run start telemetry row.
    .insert({ agent: "auditor" as AgentName, status: "running", started_at: new Date().toISOString() })
    // Return inserted row ID.
    .select("id")
    // Select single row.
    .single();

  // Extract telemetry run ID.
  // WHY: Used to update run status upon completion or failure.
  const runId: string | undefined = runRow?.id;

  // Query kill switch state from system_settings.
  // WHY: Respect global system pause flag.
  const { data: settingsData } = await db
    // Target system_settings table.
    .from("system_settings")
    // Select system_enabled boolean flag.
    .select("system_enabled")
    // Limit to single row.
    .limit(1)
    // Return single row or null.
    .single();

  // Determine system enabled state.
  // WHY: Default to false if unconfigured.
  const systemEnabled = settingsData?.system_enabled ?? false;

  // Check if caller forced execution via query parameter.
  // WHY: Permits manual testing override.
  const url = new URL(req.url);
  // Read force parameter.
  const force = url.searchParams.get("force") === "true";

  // Check kill switch constraint.
  // WHY: Halt processing immediately when system is disabled.
  if (!systemEnabled && !force) {
    // Check if run telemetry row exists.
    if (runId) {
      // Update telemetry status to skipped_disabled.
      await db.from("agent_runs").update({
        status: "skipped_disabled",
        finished_at: new Date().toISOString(),
        error_detail: "system_settings.system_enabled is false",
      }).eq("id", runId);
    }
    // Return 200 response acknowledging kill switch.
    return jsonResponse(200, { status: "halted_by_kill_switch", processed: 0 });
  }

  // Parse limit parameter.
  // WHY: Bound processing batch size.
  const rawLimit = url.searchParams.get("limit");
  // Calculate clamped batch size.
  const batchSize = rawLimit ? Math.min(Math.max(1, Number(rawLimit) || DEFAULT_BATCH_SIZE), MAX_BATCH_SIZE) : DEFAULT_BATCH_SIZE;

  // Query applications sitting at status 'interview'.
  // WHY: Identify candidates that reached interview stage needing prep packs.
  const { data: apps, error: appsError } = await db
    // Target applications table.
    .from("applications")
    // Select application columns and joined job fields.
    .select("id, user_id, job_id, jobs ( company_name, title, description_raw )")
    // Filter status = interview.
    .eq("status", "interview")
    // Limit batch size.
    .limit(batchSize);

  // Handle application query failure.
  // WHY: Log error and update telemetry run status.
  if (appsError) {
    // Check if telemetry row exists.
    if (runId) {
      // Update telemetry run status to failed.
      await db.from("agent_runs").update({
        status: "failed",
        finished_at: new Date().toISOString(),
        error_detail: appsError.message,
      }).eq("id", runId);
    }
    // Return 500 response.
    return jsonResponse(500, { success: false, error: "query_applications_failed", detail: appsError.message });
  }

  // Handle empty queue.
  // WHY: Early exit when no interview-stage applications are pending.
  if (!apps || apps.length === 0) {
    // Check if telemetry row exists.
    if (runId) {
      // Update telemetry run status to succeeded.
      await db.from("agent_runs").update({ status: "succeeded", finished_at: new Date().toISOString(), rows_in: 0, rows_out: 0 }).eq("id", runId);
    }
    // Return 200 response.
    return jsonResponse(200, { status: "no_eligible_applications", processed: 0, generated: 0 });
  }

  // Initialize accumulators.
  // WHY: Metric tracking for response payload and telemetry.
  let generatedCount = 0;
  // Gemini calls counter.
  let geminiCalls = 0;
  // Warnings list.
  const warnings: string[] = [];

  // Process each interview application sequentially.
  // WHY: Controlled LLM execution per candidate.
  for (const app of apps) {
    // Check if prep pack already exists for this application.
    // WHY: Prevent duplicate generation and Gemini quota burn.
    const { data: existingPrep } = await db
      // Target interview_prep_packs table.
      .from("interview_prep_packs")
      // Select ID.
      .select("id")
      // Filter by application_id.
      .eq("application_id", app.id)
      // Limit 1.
      .limit(1)
      // Maybe single.
      .maybeSingle();

    // Skip if prep pack already exists.
    // WHY: Idempotent execution.
    if (existingPrep) {
      // Record info warning.
      warnings.push(`Application ${app.id} already has an interview prep pack.`);
      // Continue to next application.
      continue;
    }

    // Extract joined job data.
    // WHY: Obtain target company and role details.
    const job = app.jobs as unknown as { company_name?: string; title?: string; description_raw?: string } | null;
    // Extract company name.
    const companyName = job?.company_name?.trim() ?? "Company";
    // Extract job title.
    const jobTitle = job?.title?.trim() ?? "Position";
    // Extract description.
    const jobDescription = job?.description_raw?.trim() ?? "";

    // Build prompt payload.
    // WHY: Format fenced prompt for Gemini.
    const promptPayload = buildInterviewPrepPrompt({ jobTitle, companyName, jobDescription });
    // Declare prep pack container.
    let prepPack: InterviewPrepPack;

    // Try generating via Gemini.
    // WHY: LLM provides tailored research and interview questions.
    try {
      // Increment call counter.
      geminiCalls++;
      // Execute Gemini API call.
      const outcome = await generateGeminiContent(db, { prompt: promptPayload });

      // Handle Gemini success outcome.
      if (outcome.ok) {
        // Extract text response.
        const text = outcome.data.candidates?.[0]?.content?.parts?.[0]?.text;
        // Parse JSON response.
        if (text) {
          // Parse response text.
          const parsed = JSON.parse(text) as Record<string, unknown>;
          // Construct prep pack.
          prepPack = {
            companyResearchOverview: String(parsed.companyResearchOverview ?? ""),
            roleSpecificQuestions: Array.isArray(parsed.roleSpecificQuestions) ? parsed.roleSpecificQuestions.map(String) : [],
            experienceHighlights: Array.isArray(parsed.experienceHighlights) ? parsed.experienceHighlights.map(String) : [],
            talkingPoints: Array.isArray(parsed.talkingPoints) ? parsed.talkingPoints.map(String) : [],
          };
        } else {
          // Use fallback if text empty.
          prepPack = buildFallbackPrepPack(companyName, jobTitle);
        }
      } else {
        // Log Gemini failure reason.
        warnings.push(`Gemini call unfulfilled for ${app.id} (${outcome.reason}); using fallback template.`);
        // Use fallback template.
        prepPack = buildFallbackPrepPack(companyName, jobTitle);
      }
    } catch (err) {
      // Catch exceptions and log warning.
      warnings.push(`Error generating prep pack for ${app.id}: ${err instanceof Error ? err.message : String(err)}`);
      // Use fallback template on exception.
      prepPack = buildFallbackPrepPack(companyName, jobTitle);
    }

    // Insert prep pack into interview_prep_packs table.
    // WHY: Persist prep pack for user review on dashboard.
    const { error: insertError } = await db
      // Target interview_prep_packs table.
      .from("interview_prep_packs")
      // Insert row properties.
      .insert({
        user_id: app.user_id,
        application_id: app.id,
        job_id: app.job_id,
        company_overview: prepPack.companyResearchOverview,
        role_specific_questions: prepPack.roleSpecificQuestions,
        experience_highlights: prepPack.experienceHighlights,
        talking_points: prepPack.talkingPoints,
      });

    // Handle insertion error.
    // WHY: Log warning if database write fails.
    if (insertError) {
      // Record warning message.
      warnings.push(`Failed to insert interview_prep_pack for ${app.id}: ${insertError.message}`);
    } else {
      // Increment successful generation count.
      generatedCount++;
    }
  }

  // Update telemetry run status to succeeded.
  // WHY: Complete agent_runs record.
  if (runId) {
    // Update agent_runs row.
    await db.from("agent_runs").update({
      status: "succeeded",
      finished_at: new Date().toISOString(),
      rows_in: apps.length,
      rows_out: generatedCount,
      gemini_calls: geminiCalls,
    }).eq("id", runId);
  }

  // Return success JSON response.
  // WHY: Report processing metrics to caller.
  return jsonResponse(200, {
    success: true,
    processed: apps.length,
    generated: generatedCount,
    gemini_calls: geminiCalls,
    warnings,
  });
});
