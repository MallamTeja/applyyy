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
// Caller auth and the fail-closed kill switch, shared by every pipeline agent.
import { authorizeCaller, readKillSwitch } from "../_shared/db/gates.ts";
// Shared CORS headers, plus the boundary that keeps them on an uncaught 500.
import { corsHeaders, withErrorBoundary } from "../_shared/cors.ts";

// Default batch processing size when limit parameter is omitted.
const DEFAULT_BATCH_SIZE = 50;
// Upper bound ceiling on batch size to avoid long execution timeouts.
const MAX_BATCH_SIZE = 200;

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
// Wrapped so a throw anywhere below still answers with CORS headers the browser can read.
Deno.serve(withErrorBoundary("applyy-normalizer", async (req: Request): Promise<Response> => {
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
  // Refuse anyone but the app user BEFORE any write: the sign-in above never looks at
  // the caller, so without this the public anon key alone could drive the pipeline.
  const caller = await authorizeCaller(req, db, connection.userId);
  // 401 for no/invalid session, 403 for someone else's — the verdict carries which.
  if (!caller.ok) return jsonResponse(caller.status, { success: false, error: caller.error });
  // Extract URL parameters from incoming request.
  const reqUrl = new URL(req.url);
  // Resolve batch size limit from query parameter.
  const batchSize = resolveBatchSize(reqUrl.searchParams.get("limit"));
  // Optional single-row target, so the dashboard can push ONE discovered job through
  // without waiting for it to reach the head of the queue (same contract as auditor/index.ts).
  const rawApplicationId = reqUrl.searchParams.get("application_id");
  // A malformed id is REFUSED, never ignored: ignoring it would fall back to the whole
  // queue and process rows the caller did not ask for (the fail-open this repo forbids).
  // Checked BEFORE the agent_runs insert, so a bad request leaves no run row behind:
  // nothing ran, and a `failed` row would tell the health page the agent broke.
  if (rawApplicationId !== null && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(rawApplicationId)) {
    // 400 with a named reason, so the caller sees what was wrong with its input.
    return jsonResponse(400, { success: false, error: "invalid_application_id", detail: "application_id must be a UUID" });
  }
  // Null means "no target": the unchanged whole-queue behaviour.
  const applicationId: string | null = rawApplicationId;

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

  // The shared fail-closed kill switch. This used to run when no settings row existed
  // and ignore read errors entirely — the opposite of the screener's rule.
  const killSwitch = await readKillSwitch(db);
  // Anything but an explicit "on" halts the run.
  if (killSwitch.kind !== "enabled") {
    // Unreadable is a failure; disabled is a deliberate skip. Both are recorded.
    const unreadable = killSwitch.kind === "unreadable";
    // Close the telemetry row so the health page can say why nothing ran.
    if (runId) {
      // Perform update query.
      await db
        // Target agent_runs.
        .from("agent_runs")
        // Update fields.
        .update({
          // `failed` for a broken read, `skipped_disabled` for an off switch.
          status: unreadable ? "failed" : "skipped_disabled",
          // Set finished timestamp.
          finished_at: new Date().toISOString(),
          // The reason, which is the only thing the health page has to go on.
          error_detail: killSwitch.detail,
        })
        // Match current run UUID.
        .eq("id", runId);
    }
    // 503 for an unreadable switch (retry later); 200 for a deliberate halt.
    return unreadable
      ? jsonResponse(503, { success: false, error: "kill_switch_read_failed" })
      : jsonResponse(200, { success: true, status: "skipped_disabled" });
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
    // Narrow to the one requested row; the status filter stays, so a wrong-status id yields
    // zero rows (a no-op). An empty match object is a no-op when untargeted.
    .match(applicationId !== null ? { id: applicationId } : {})
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
          // Set finished timestamp.
          finished_at: new Date().toISOString(),
          // Record error count.
          error_count: 1,
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
          // Set finished timestamp.
          finished_at: new Date().toISOString(),
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
      // Targeted runs say so, and `found: 0` tells the button the id was not at `discovered`.
      ...(applicationId !== null ? { targeted: true, found: 0 } : {}),
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

  // HONEST FINAL STATUS. `failed` when there was work, none of it moved, and errors
  // explain why: the live matcher run seen 2026-10-04 (rows_in 10, rows_out 0,
  // error_count 10) was stamped `succeeded`, the silent stop agent_runs exists to catch.
  // Mixed results stay `succeeded` with error_count set: `agent_run_status` has no
  // `partial` (enums.sql:190), and an empty queue (rows_in 0) is idle, not broken.
  const runStatus = items.length > 0 && dedupedCount + droppedDuplicateCount === 0 && errorCount > 0 ? "failed" : "succeeded";
  // This agent counts failures but does not collect their messages (each is written to
  // the function log at the failing row), so the summary says how many and where to
  // look rather than inventing a reason. Null on a clean run.
  const errorDetail = errorCount > 0 ? `${errorCount} of ${items.length} rows errored; per-row reasons are in the normalizer function log` : null;

  // Finalize agent run bookkeeping in agent_runs table.
  if (runId) {
    // Execute update on agent_runs.
    await db
      // Target agent_runs table.
      .from("agent_runs")
      // Update completion fields and counters.
      .update({
        // Derived from the counters, never hard-coded: see runStatus above.
        status: runStatus,
        // The failure summary, so the health page says WHY and not just how many.
        error_detail: errorDetail,
        // Set completion timestamp string.
        finished_at: new Date().toISOString(),
        // Record input rows count.
        rows_in: items.length,
        // Record total output rows count.
        rows_out: dedupedCount + droppedDuplicateCount,
        // The refused transitions, so the health page can see them.
        error_count: errorCount,
      })
      // Match run ID.
      .eq("id", runId);
  }

  // Return final summary HTTP response to caller.
  return jsonResponse(200, {
    // The function ran to completion; per-row failures are in `errors` below.
    success: true,
    // The same status written to agent_runs, so the dashboard and health page agree.
    status: runStatus,
    // The same failure summary, so the operator sees it without a DB query.
    error_detail: errorDetail,
    // Total processed applications count.
    processed: items.length,
    // Successfully deduped count.
    deduped: dedupedCount,
    // Successfully dropped duplicate count.
    dropped_duplicate: droppedDuplicateCount,
    // Total error count encountered.
    errors: errorCount,
    // Targeted runs say so, with how many rows the narrowed read found (0 or 1).
    ...(applicationId !== null ? { targeted: true, found: items.length } : {}),
  });
}));
