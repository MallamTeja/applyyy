// ============================================================================
// AUDITOR AGENT DENO EDGE FUNCTION ENTRYPOINT
// ============================================================================
//
// Reads applications sitting at status `tailored`, runs the anti-fabrication
// check against the pinned master profile, writes `audit_findings` into the row,
// and advances application status through RPC to `audit_clean` or `audit_flagged`,
// followed by `awaiting_approval` for human review per status_transition_guard.sql.
//
// Workflow Pipeline Steps per Application:
//   1. Parse `tailored_profile` (ResolvedResume) and `tailor_refs` (TailoredProfile).
//   2. Run anti-fabrication detector against master profile (`auditApplication`).
//   3. Write `audit_findings` array to `applications` row.
//   4. Advance status `tailored` -> `audit_clean` or `audit_flagged` (agent: 'auditor').
//   5. Advance status `audit_clean`/`audit_flagged` -> `awaiting_approval` (agent: 'auditor').
// ============================================================================

// Import database client factory helper for authenticated Supabase connection
import { createAppUserClient } from "../_shared/db/client.ts";

// Import anti-fabrication auditor orchestrator function
import { auditApplication } from "../_shared/audit/audit.ts";

// Import shared contract interfaces for MasterProfile, ResolvedResume, and TailoredProfile
import type { MasterProfile, ResolvedResume, TailoredProfile } from "../_shared/contracts/shared-types.ts";

// Default batch processing limit size for Auditor invocation
const DEFAULT_BATCH_SIZE = 10;

// Maximum allowed batch processing limit ceiling
const MAX_BATCH_SIZE = 25;

// Standard CORS headers configuration for HTTP responses
const corsHeaders = {
  // Allow all origins for API access
  "Access-Control-Allow-Origin": "*",
  // Allowed request headers
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  // Allowed HTTP request methods
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
};

/**
 * Format and construct a standardized JSON HTTP response object with CORS headers.
 *
 * @param status HTTP response status code.
 * @param data JSON serializable response object payload.
 * @returns Standardized Response instance.
 */
function jsonResponse(status: number, data: Record<string, unknown>): Response {
  // Serialize response data object to indented JSON string
  const jsonBody = JSON.stringify(data, null, 2);

  // Define HTTP headers object
  const responseHeaders = {
    // Set response content type to JSON with UTF-8 character encoding
    "content-type": "application/json; charset=utf-8",
    // Spread standard CORS headers
    ...corsHeaders,
  };

  // Create Response with formatted JSON body and headers
  return new Response(jsonBody, {
    // Set status code
    status,
    // Set response headers
    headers: responseHeaders,
  });
}

/**
 * Resolve and bound requested batch processing size from URL query parameters.
 *
 * @param raw Raw string value from URL query parameter.
 * @returns Clamped integer batch size bounded between 1 and MAX_BATCH_SIZE.
 */
function resolveBatchSize(raw: string | null): number {
  // Use default batch size if parameter is missing
  if (raw === null) return DEFAULT_BATCH_SIZE;

  // Parse string parameter into number
  const parsed = Number(raw);

  // Fallback to default batch size if not a positive integer
  if (!Number.isInteger(parsed) || parsed < 1) return DEFAULT_BATCH_SIZE;

  // Clamp parsed batch size to maximum ceiling
  return Math.min(parsed, MAX_BATCH_SIZE);
}

// Register Deno HTTP serve request handler
Deno.serve(async (req: Request): Promise<Response> => {
  // Check if HTTP request method is OPTIONS
  if (req.method === "OPTIONS") {
    // Handle OPTIONS CORS preflight request with 200 OK
    return new Response("ok", { headers: corsHeaders });
  }

  // Establish database client connection under authenticated user RLS session
  const connection = await createAppUserClient();

  // Return service unavailable response if database connection failed
  if (!connection.ok) {
    // Log connection failure error message
    console.error("[applyy-auditor] database connection failed:", connection.reason);

    // Return 503 response
    return jsonResponse(503, { success: false, error: "database_unavailable" });
  }

  // Unpack connected database client
  const db = connection.db;

  // Insert initial agent run record into agent_runs telemetry table
  const { data: runRow } = await db
    // Target agent_runs table
    .from("agent_runs")
    // Insert running record for auditor
    .insert({ agent: "auditor", status: "running", started_at: new Date().toISOString() })
    // Select generated primary key ID
    .select("id")
    // Fetch single result row
    .single();

  // Store allocated agent run ID
  const runId: string | undefined = runRow?.id;

  // Helper function to mark agent run as failed and return HTTP response
  async function failRun(status: number, error: string, detail: string): Promise<Response> {
    // Update agent run record status to failed if runId is available
    if (runId) {
      // Update agent run table
      await db
        // Target agent_runs table
        .from("agent_runs")
        // Set status failed and finished_at timestamp
        .update({ status: "failed", finished_at: new Date().toISOString(), error_detail: detail })
        // Filter by runId
        .eq("id", runId);
    }

    // Return formatted failure response
    return jsonResponse(status, { success: false, error });
  }

  // Query highest-version pinned MasterProfile record from master_profiles table
  const { data: masterRow, error: masterError } = await db
    // Target master_profiles table
    .from("master_profiles")
    // Select profile JSON and version number
    .select("profile, version")
    // Order by version descending
    .order("version", { ascending: false })
    // Limit to top 1 highest version
    .limit(1)
    // Return single row or null
    .maybeSingle();

  // Handle master profile read error
  if (masterError) return await failRun(503, "master_profile_unreadable", masterError.message);

  // Check if master profile exists
  if (!masterRow) return await failRun(409, "no_master_profile", "master_profiles table is empty");

  // Cast retrieved master profile JSON into typed MasterProfile interface
  const master = masterRow.profile as MasterProfile;

  // Store master version number
  const masterVersion = masterRow.version;

  // Extract limit query parameter from request URL
  const limitParam = new URL(req.url).searchParams.get("limit");

  // Determine batch size limit from request URL parameter
  const batchSize = resolveBatchSize(limitParam);

  // Query applications queue sitting at status 'tailored'
  const { data: rows, error: rowsError } = await db
    // Target applications table
    .from("applications")
    // Select application ID, tailored_profile, tailor_refs, and master_version
    .select("id, tailored_profile, tailor_refs, master_version")
    // Filter for status = 'tailored'
    .eq("status", "tailored")
    // Order by created_at ascending
    .order("created_at", { ascending: true })
    // Limit batch size
    .limit(batchSize);

  // Handle applications queue read error
  if (rowsError) return await failRun(503, "queue_unreadable", rowsError.message);

  // Initialize total audited counter
  let auditedCount = 0;

  // Initialize clean applications counter
  let cleanCount = 0;

  // Initialize flagged applications counter
  let flaggedCount = 0;

  // Track per-row failures array
  const failures: Array<{ applicationId: string; error: string }> = [];

  // Extract application rows array or empty array fallback
  const applicationRows = rows ?? [];

  // Iterate over each application row in queue sequentially
  for (const row of applicationRows) {
    // Try auditing row
    try {
      // Extract resolved tailored resume JSON
      const resume = row.tailored_profile as ResolvedResume | null;

      // Extract raw tailor refs JSON
      const tailorRefs = row.tailor_refs as TailoredProfile | null;

      // Fail row processing if tailored_profile is missing
      if (!resume) {
        // Record failure
        failures.push({ applicationId: row.id, error: "missing_tailored_profile" });

        // Skip to next application row
        continue;
      }

      // Execute anti-fabrication audit against master profile
      const outcome = auditApplication(master, resume, tailorRefs);

      // Step 1: Write audit findings array into applications table row
      const findingsWrite = await db
        // Target applications table
        .from("applications")
        // Update audit_findings column
        .update({ audit_findings: outcome.findings })
        // Scoped to current row ID
        .eq("id", row.id);

      // Handle payload write error
      if (findingsWrite.error) {
        // Record failure
        failures.push({ applicationId: row.id, error: findingsWrite.error.message });

        // Skip to next application row
        continue;
      }

      // Step 2: Advance status tailored -> audit_clean or audit_flagged via guarded RPC
      const transitionResult = await db.rpc("advance_application_status", {
        // Application ID
        p_application_id: row.id,
        // Target status (audit_clean or audit_flagged)
        p_to_status: outcome.status,
        // Acting agent identity
        p_agent: "auditor",
        // Detail object
        p_detail: { findings_count: outcome.findings.length, master_version: masterVersion },
      });

      // Handle first status transition error
      if (transitionResult.error) {
        // Record failure
        failures.push({ applicationId: row.id, error: transitionResult.error.message });

        // Skip to next application row
        continue;
      }

      // Step 3: Advance status audit_clean/audit_flagged -> awaiting_approval via guarded RPC
      const approvalTransition = await db.rpc("advance_application_status", {
        // Application ID
        p_application_id: row.id,
        // Target status awaiting_approval
        p_to_status: "awaiting_approval",
        // Acting agent identity
        p_agent: "auditor",
        // Detail object
        p_detail: { audit_verdict: outcome.status, findings_count: outcome.findings.length },
      });

      // Handle second status transition error
      if (approvalTransition.error) {
        // Record failure
        failures.push({ applicationId: row.id, error: approvalTransition.error.message });

        // Skip to next application row
        continue;
      }

      // Increment total audited count
      auditedCount += 1;

      // Increment clean vs flagged counters
      if (outcome.isClean) {
        // Increment clean count
        cleanCount += 1;
      } else {
        // Increment flagged count
        flaggedCount += 1;
      }
    } catch (err) {
      // Construct error message string
      const errMsg = err instanceof Error ? err.message : String(err);

      // Record exception error for row
      failures.push({
        // Application ID
        applicationId: row.id,
        // Error message string
        error: errMsg,
      });
    }
  }

  // Update agent_runs telemetry record status to succeeded
  if (runId) {
    // Update agent run record
    await db
      // Target agent_runs table
      .from("agent_runs")
      // Update fields
      .update({
        // Status succeeded
        status: "succeeded",
        // Finished timestamp
        finished_at: new Date().toISOString(),
        // Rows in count
        rows_in: applicationRows.length,
        // Rows out count
        rows_out: auditedCount,
      })
      // Scoped by runId
      .eq("id", runId);
  }

  // Return successful execution JSON response
  return jsonResponse(200, {
    // Success flag
    success: true,
    // Master version
    master_version: masterVersion,
    // Audited count
    audited: auditedCount,
    // Clean count
    clean: cleanCount,
    // Flagged count
    flagged: flaggedCount,
    // Failures array
    failures,
  });
});
