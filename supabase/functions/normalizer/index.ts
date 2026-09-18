// Normalizer — Edge Function Entrypoint for PROJECT_PLAN.md §9.
//
// Reads `applications` sitting at status `discovered`, computes canonical SHA-256 fingerprints
// for their associated `jobs`, detects duplicate postings against existing database records or
// within the current batch, and updates application status to `deduped` or `dropped_duplicate`.
//
// Signs in as the ordinary app user via createAppUserClient, so every query runs under RLS.

// Client factory for authenticating as the ordinary app user under RLS policies.
import { createAppUserClient } from "../_shared/db/client.ts";
// Pure normalization planner and input types for fingerprinting and duplicate detection.
import {
  // Pure batch calculation planner function.
  planNormalizeBatch,
  // Input item type contract representing discovered application data.
  type DiscoveredApplicationItem,
} from "../_shared/normalize/normalize-batch.ts";

// Default batch processing size when limit parameter is omitted.
const DEFAULT_BATCH_SIZE = 50;
// Upper bound ceiling on batch size to avoid long execution timeouts.
const MAX_BATCH_SIZE = 200;

// Standard CORS response headers for browser preflight and API invocations.
const corsHeaders = {
  // Allow all origins since endpoint is secured by Supabase RLS authentication.
  "Access-Control-Allow-Origin": "*",
  // Allowed request headers matching standard Supabase JS client requests.
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  // Allowed HTTP verbs for options preflight and invocation.
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
};

// Formats a JSON response with status code and standard CORS headers.
function jsonResponse(
  // HTTP status code to return.
  status: number,
  // Object payload to serialize as JSON.
  data: Record<string, unknown>,
): Response {
  // Build and return HTTP Response object.
  return new Response(
    // Pretty-printed JSON string representation.
    JSON.stringify(data, null, 2),
    // Response options containing status code and content headers.
    {
      // Assign HTTP status code.
      status,
      // Assign content-type and CORS headers.
      headers: {
        // Specify JSON content type with UTF-8 encoding.
        "content-type": "application/json; charset=utf-8",
        // Spread CORS headers.
        ...corsHeaders,
      },
    },
  );
}

// Parses and clamps batch size request parameter.
function resolveBatchSize(
  // Raw query parameter string or null.
  raw: string | null,
): number {
  // Return default batch size if query parameter was absent.
  if (raw === null) return DEFAULT_BATCH_SIZE;
  // Parse numeric integer value from string.
  const parsed = Number(raw);
  // Guard against invalid NaN, empty string, or non-positive integers.
  if (!Number.isInteger(parsed) || parsed < 1) return DEFAULT_BATCH_SIZE;
  // Clamp batch size to maximum allowed ceiling.
  return Math.min(parsed, MAX_BATCH_SIZE);
}

// Deno Edge Function request handler entry point.
Deno.serve(async (req: Request): Promise<Response> => {
  // Return HTTP 200 ok for CORS OPTIONS preflight requests.
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  // Authenticate database client with app user credentials.
  const connection = await createAppUserClient();
  // Return HTTP 503 error if database authentication fails.
  if (!connection.ok) {
    // Log detailed failure reason on the server side.
    console.error("[applyy-normalizer] database connection failed:", connection.reason);
    // Return sanitized JSON error response to client.
    return jsonResponse(503, { success: false, error: "database_unavailable" });
  }

  // Extract authenticated Supabase DB client instance.
  const db = connection.db;
  // Extract URL parameters from incoming request.
  const reqUrl = new URL(req.url);
  // Resolve batch size limit from query parameter.
  const batchSize = resolveBatchSize(reqUrl.searchParams.get("limit"));

  // Record agent run start in agent_runs table for telemetry.
  const { data: runRow } = await db
    // Target agent_runs table.
    .from("agent_runs")
    // Insert running record for normalizer agent.
    .insert({
      // Name of acting agent.
      agent: "normalizer",
      // Initial run status.
      status: "running",
      // UTC start timestamp string.
      started_at: new Date().toISOString(),
    })
    // Select generated UUID.
    .select("id")
    // Return single row.
    .single();

  // Extract generated agent run UUID if insert succeeded.
  const runId = runRow?.id ?? null;

  // Check system settings kill switch before running normalization.
  const { data: settings } = await db
    // Target system_settings table.
    .from("system_settings")
    // Select system_enabled boolean flag.
    .select("system_enabled")
    // Limit to single configuration row.
    .limit(1)
    // Return single row.
    .single();

  // Check if system kill switch is explicitly disabled.
  if (settings && settings.system_enabled === false) {
    // Update agent_runs row to record skipped status due to kill switch.
    if (runId) {
      // Perform update query.
      await db
        // Target agent_runs.
        .from("agent_runs")
        // Update fields.
        .update({
          // Set status to skipped_disabled.
          status: "skipped_disabled",
          // Set completed timestamp.
          completed_at: new Date().toISOString(),
          // Attach detail reason.
          error_detail: "system_enabled is false",
        })
        // Match current run UUID.
        .eq("id", runId);
    }
    // Return HTTP 200 response informing caller that normalizer is disabled.
    return jsonResponse(200, { success: true, status: "skipped_disabled" });
  }

  // Query applications sitting at status 'discovered' along with joined job details.
  const { data: rawApps, error: fetchError } = await db
    // Target applications table.
    .from("applications")
    // Select application columns and inner joined jobs columns.
    .select(`
      id,
      user_id,
      job_id,
      jobs!inner (
        id,
        company_name,
        title,
        location_raw,
        locations,
        fingerprint
      )
    `)
    // Filter for applications sitting at discovered status.
    .eq("status", "discovered")
    // Apply batch size limit.
    .limit(batchSize);

  // Check if database query encountered an error.
  if (fetchError) {
    // Log query failure details.
    console.error("[applyy-normalizer] failed to fetch discovered applications:", fetchError.message);
    // Mark agent run as failed if run ID exists.
    if (runId) {
      // Execute failure update on agent_runs.
      await db
        // Target agent_runs table.
        .from("agent_runs")
        // Update status and error fields.
        .update({
          // Set failed status.
          status: "failed",
          // Set completion timestamp.
          completed_at: new Date().toISOString(),
          // Record database error message.
          error_detail: fetchError.message,
        })
        // Filter by run ID.
        .eq("id", runId);
    }
    // Return HTTP 500 error response.
    return jsonResponse(500, { success: false, error: fetchError.message });
  }

  // Handle case where no applications are currently sitting at status 'discovered'.
  if (!rawApps || rawApps.length === 0) {
    // Complete agent run with zero rows processed.
    if (runId) {
      // Update agent_runs table.
      await db
        // Target agent_runs.
        .from("agent_runs")
        // Set success metrics.
        .update({
          // Set status to succeeded.
          status: "succeeded",
          // Set completion timestamp.
          completed_at: new Date().toISOString(),
          // Set rows_in to 0.
          rows_in: 0,
          // Set rows_out to 0.
          rows_out: 0,
        })
        // Match run ID.
        .eq("id", runId);
    }
    // Return success response indicating zero jobs were processed.
    return jsonResponse(200, {
      // Success flag.
      success: true,
      // Total rows processed count.
      processed: 0,
      // Count of jobs transitioned to deduped.
      deduped: 0,
      // Count of jobs transitioned to dropped_duplicate.
      dropped_duplicate: 0,
    });
  }

  // Map raw database joined rows into typed DiscoveredApplicationItem contracts.
  const items: DiscoveredApplicationItem[] = rawApps.map((row) => {
    // Cast nested jobs relation payload.
    const j = row.jobs as unknown as {
      // Job UUID.
      id: string;
      // Company name string.
      company_name: string;
      // Job title string.
      title: string;
      // Raw location string if present.
      location_raw: string | null;
      // Parsed locations array if present.
      locations: string[] | null;
      // Stored fingerprint string.
      fingerprint: string;
    };
    // Return structured item object.
    return {
      // Application ID.
      applicationId: row.id,
      // User ID.
      userId: row.user_id,
      // Job ID.
      jobId: row.job_id,
      // Company name.
      companyName: j.company_name,
      // Title.
      title: j.title,
      // Location raw string.
      locationRaw: j.location_raw,
      // Locations array.
      locations: j.locations,
      // Current fingerprint.
      currentFingerprint: j.fingerprint,
    };
  });

  // Define DB collision lookup function for duplicate detection against public.jobs.
  const lookupExistingJob = async (
    // User UUID parameter.
    userId: string,
    // Fingerprint string parameter.
    fingerprint: string,
    // Current job ID to exclude from collision query.
    excludeJobId: string,
  ): Promise<string | null> => {
    // Query jobs table for collision with identical user_id and fingerprint.
    const { data: existingJobs } = await db
      // Target jobs table.
      .from("jobs")
      // Select ID of existing job.
      .select("id")
      // Filter by user ID for tenant isolation.
      .eq("user_id", userId)
      // Filter by canonical fingerprint digest.
      .eq("fingerprint", fingerprint)
      // Exclude the current job being evaluated.
      .neq("id", excludeJobId)
      // Limit to 1 result.
      .limit(1);

    // Return existing job ID if found, otherwise return null.
    return existingJobs && existingJobs.length > 0 ? existingJobs[0]!.id : null;
  };

  // Plan normalization decisions for the entire batch.
  const decisions = await planNormalizeBatch(items, lookupExistingJob);

  // Counter tracking jobs successfully advanced to status 'deduped'.
  let dedupedCount = 0;
  // Counter tracking jobs advanced to status 'dropped_duplicate'.
  let droppedDuplicateCount = 0;
  // Counter tracking failed transitions or errors.
  let errorCount = 0;

  // Process each planned normalization decision.
  for (const decision of decisions) {
    // Handle unique non-duplicate jobs ('deduped').
    if (decision.kind === "deduped") {
      // Patch jobs.fingerprint if stored value differed from canonical digest.
      if (decision.needsFingerprintPatch) {
        // Execute update query on jobs table.
        const { error: patchError } = await db
          // Target jobs table.
          .from("jobs")
          // Update fingerprint column with canonical digest.
          .update({ fingerprint: decision.canonicalFingerprint })
          // Filter by job ID.
          .eq("id", decision.jobId);

        // Log warning if patching job fingerprint failed.
        if (patchError) {
          // Print error log message.
          console.error(`[applyy-normalizer] failed to patch fingerprint for job ${decision.jobId}:`, patchError.message);
        }
      }

      // Advance application status from 'discovered' to 'deduped' via RPC.
      const { error: rpcError } = await db.rpc("advance_application_status", {
        // Pass application UUID.
        p_application_id: decision.applicationId,
        // Pass target status 'deduped'.
        p_to_status: "deduped",
        // Declare acting agent as 'normalizer'.
        p_agent: "normalizer",
        // Attach event detail.
        p_detail: {
          // Specify transition reason.
          reason: "fingerprint_computed",
          // Store canonical fingerprint in event detail.
          canonical_fingerprint: decision.canonicalFingerprint,
        },
      });

      // Handle RPC execution result.
      if (rpcError) {
        // Log RPC failure message.
        console.error(`[applyy-normalizer] RPC advance status to deduped failed for app ${decision.applicationId}:`, rpcError.message);
        // Increment error counter.
        errorCount++;
      } else {
        // Increment successfully deduped count.
        dedupedCount++;
      }
    } else if (decision.kind === "dropped_duplicate") {
      // Advance application status from 'discovered' to 'dropped_duplicate' via RPC.
      const { error: rpcError } = await db.rpc("advance_application_status", {
        // Pass application UUID.
        p_application_id: decision.applicationId,
        // Pass target status 'dropped_duplicate'.
        p_to_status: "dropped_duplicate",
        // Declare acting agent as 'normalizer'.
        p_agent: "normalizer",
        // Attach duplicate details.
        p_detail: {
          // Specify drop reason.
          reason: "duplicate_fingerprint",
          // Store canonical fingerprint.
          canonical_fingerprint: decision.canonicalFingerprint,
          // Link to existing job ID duplicated by this posting.
          duplicate_of_job_id: decision.duplicateOfJobId,
        },
      });

      // Handle RPC execution result.
      if (rpcError) {
        // Log RPC failure message.
        console.error(`[applyy-normalizer] RPC advance status to dropped_duplicate failed for app ${decision.applicationId}:`, rpcError.message);
        // Increment error counter.
        errorCount++;
      } else {
        // Increment successfully dropped duplicate count.
        droppedDuplicateCount++;
      }
    }
  }

  // Finalize agent run bookkeeping in agent_runs table.
  if (runId) {
    // Execute update on agent_runs.
    await db
      // Target agent_runs table.
      .from("agent_runs")
      // Update completion fields and counters.
      .update({
        // Set status to succeeded.
        status: "succeeded",
        // Set completion timestamp string.
        completed_at: new Date().toISOString(),
        // Record input rows count.
        rows_in: items.length,
        // Record total output rows count.
        rows_out: dedupedCount + droppedDuplicateCount,
      })
      // Match run ID.
      .eq("id", runId);
  }

  // Return final summary HTTP response to caller.
  return jsonResponse(200, {
    // Success flag.
    success: true,
    // Total processed applications count.
    processed: items.length,
    // Successfully deduped count.
    deduped: dedupedCount,
    // Successfully dropped duplicate count.
    dropped_duplicate: droppedDuplicateCount,
    // Total error count encountered.
    errors: errorCount,
  });
});
