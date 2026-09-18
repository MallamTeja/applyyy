// ============================================================================
// COVER LETTER AGENT DENO EDGE FUNCTION ENTRYPOINT
// ============================================================================
//
// Reads tailored applications sitting at status `tailored`, generates a professional
// and custom-tailored cover letter using Gemini pool key transport, passes the candidate
// materials through the Auditor agent for anti-fabrication verification, updates the
// application record with findings and cover letter text, and advances application
// status through guarded RPC functions to `audit_clean` or `audit_flagged`, followed by
// `awaiting_approval` for human review per status_transition_guard.sql.
//
// Workflow Pipeline Steps per Application:
//   1. Authenticate Supabase user RLS session (`createAppUserClient`).
//   2. Open agent run telemetry record in `agent_runs` (`agent: 'tailor'`).
//   3. Fetch pinned highest-version MasterProfile snapshot from `master_profiles`.
//   4. Query applications queue sitting at status `tailored` up to batch limit.
//   5. Plan batch eligibility (`planCoverLetterBatch`).
//   6. For each eligible application:
//      a. Build structured Gemini prompt (`buildCoverLetterPrompt`).
//      b. Invoke Gemini model pool transport (`generateGeminiContent`).
//      c. Parse generated cover letter text response.
//      d. Execute anti-fabrication audit check (`auditApplication`).
//      e. Persist `audit_findings` array and cover letter into `applications` row.
//      f. Transition application status `tailored` -> `audit_clean` / `audit_flagged` (agent: 'auditor').
//      g. Transition application status -> `awaiting_approval` (agent: 'auditor').
//   7. Close agent run telemetry record with final counts.
//   8. Return standardized JSON HTTP response.
// ============================================================================

// Import database client factory helper for authenticated Supabase connection
import { createAppUserClient } from "../_shared/db/client.ts";

// Import Gemini key pool model transport client function
import { generateGeminiContent } from "../_shared/gemini/client.ts";

// Import anti-fabrication auditor orchestrator function
import { auditApplication } from "../_shared/audit/audit.ts";

// Import shared contract interfaces for MasterProfile and TailoredProfile
import type { MasterProfile, TailoredProfile } from "../_shared/contracts/shared-types.ts";

// Import cover letter prompt generator helper function
import { buildCoverLetterPrompt } from "./cover-letter-prompt.ts";

// Import cover letter batch planning helper function
import { planCoverLetterBatch } from "./cover-letter-batch.ts";

// Default batch processing limit size for Cover Letter invocation
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
  if (raw === null) {
    // Return default batch size
    return DEFAULT_BATCH_SIZE;
  }

  // Parse string parameter into number
  const parsed = Number(raw);

  // Fallback to default batch size if not a positive integer
  if (!Number.isInteger(parsed) || parsed < 1) {
    // Return default batch size
    return DEFAULT_BATCH_SIZE;
  }

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
    console.error("[applyy-cover-letter] database connection failed:", connection.reason);

    // Return 503 response
    return jsonResponse(503, { success: false, error: "database_unavailable" });
  }

  // Unpack connected database client
  const db = connection.db;

  // Insert initial agent run record into agent_runs telemetry table
  const { data: runRow } = await db
    // Target agent_runs table
    .from("agent_runs")
    // Insert running record for tailor agent
    .insert({ agent: "tailor", status: "running", started_at: new Date().toISOString() })
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
  if (masterError) {
    // Return 503 master profile unreadable
    return await failRun(503, "master_profile_unreadable", masterError.message);
  }

  // Check if master profile exists
  if (!masterRow) {
    // Return 409 no master profile
    return await failRun(409, "no_master_profile", "master_profiles table is empty");
  }

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
    // Select application ID, tailored_profile, tailor_refs, master_version, and job details
    .select("id, status, tailored_profile, tailor_refs, master_version, jobs (title, company_name, description_raw)")
    // Filter for status = 'tailored'
    .eq("status", "tailored")
    // Order by created_at ascending
    .order("created_at", { ascending: true })
    // Limit batch size
    .limit(batchSize);

  // Handle applications queue read error
  if (rowsError) {
    // Return 503 queue unreadable
    return await failRun(503, "queue_unreadable", rowsError.message);
  }

  // Evaluate batch plan to separate eligible vs skipped applications
  const plan = planCoverLetterBatch(rows ?? []);

  // Initialize total cover letters generated counter
  let generatedCount = 0;

  // Initialize clean applications counter
  let cleanCount = 0;

  // Initialize flagged applications counter
  let flaggedCount = 0;

  // Track per-row failures array
  const failures: Array<{ applicationId: string; error: string }> = [];

  // Process eligible jobs sequentially to prevent rate limit contention
  for (const job of plan.eligible) {
    // Try processing job
    try {
      // Build structured Gemini prompt payload for cover letter generation
      const promptPayload = buildCoverLetterPrompt({
        // Master profile
        master,
        // Resolved resume
        resume: job.resume,
        // Job metadata
        job: job.job,
      });

      // Execute Gemini model call via key pool transport
      const outcome = await generateGeminiContent(db, {
        // Prompt payload
        prompt: {
          // System instruction
          systemInstruction: promptPayload.systemInstruction,
          // User content
          userContent: promptPayload.userContent,
          // Response schema
          responseSchema: promptPayload.responseSchema,
        },
      });

      // Check if Gemini call succeeded
      if (!outcome.ok) {
        // Record Gemini transport call failure
        failures.push({ applicationId: job.applicationId, error: `gemini_call_failed: ${outcome.reason}` });

        // Skip to next eligible application
        continue;
      }

      // Extract generated text from Gemini response candidate parts
      const rawText = outcome.data.candidates?.[0]?.content?.parts?.[0]?.text;

      // Validate that response contains valid text string
      if (typeof rawText !== "string" || !rawText.trim()) {
        // Record failure when Gemini returns empty or non-string response
        failures.push({ applicationId: job.applicationId, error: "gemini_returned_no_text" });

        // Skip to next eligible application
        continue;
      }

      // Parse JSON response object to extract cover letter string
      let coverLetterText = rawText;

      // Try parsing JSON output wrapper
      try {
        // Parse JSON output if Gemini returned JSON wrapper object
        const parsedJson = JSON.parse(rawText);

        // Extract coverLetter string field if available
        if (typeof parsedJson.coverLetter === "string") {
          // Set cover letter text
          coverLetterText = parsedJson.coverLetter;
        }
      } catch {
        // Retain rawText if response was plain text rather than JSON
      }

      // Run anti-fabrication check against master profile using Auditor engine
      const auditVerdict = auditApplication(master, job.resume, job.tailorRefs as TailoredProfile | null);

      // Step 1: Write audit_findings and cover letter into applications table row
      const updateResult = await db
        // Target applications table
        .from("applications")
        // Update audit_findings array and store cover letter in block_detail JSONB object
        .update({
          // Audit findings array
          audit_findings: auditVerdict.findings,
          // Store cover letter prose inside block_detail payload
          block_detail: { cover_letter: coverLetterText },
        })
        // Scoped to current row ID
        .eq("id", job.applicationId);

      // Handle payload write error
      if (updateResult.error) {
        // Record update failure
        failures.push({ applicationId: job.applicationId, error: updateResult.error.message });

        // Skip to next eligible application
        continue;
      }

      // Step 2: Advance status tailored -> audit_clean or audit_flagged via guarded RPC
      const transitionResult = await db.rpc("advance_application_status", {
        // Application ID
        p_application_id: job.applicationId,
        // Target status (audit_clean or audit_flagged)
        p_to_status: auditVerdict.status,
        // Acting agent identity
        p_agent: "auditor",
        // Detail object carrying findings count and master version
        p_detail: { findings_count: auditVerdict.findings.length, master_version: masterVersion },
      });

      // Handle first status transition error
      if (transitionResult.error) {
        // Record transition failure
        failures.push({ applicationId: job.applicationId, error: transitionResult.error.message });

        // Skip to next eligible application
        continue;
      }

      // Step 3: Advance status audit_clean/audit_flagged -> awaiting_approval via guarded RPC
      const approvalTransition = await db.rpc("advance_application_status", {
        // Application ID
        p_application_id: job.applicationId,
        // Target status awaiting_approval
        p_to_status: "awaiting_approval",
        // Acting agent identity
        p_agent: "auditor",
        // Detail object carrying cover letter verdict
        p_detail: { audit_verdict: auditVerdict.status, cover_letter_generated: true },
      });

      // Handle second status transition error
      if (approvalTransition.error) {
        // Record approval transition failure
        failures.push({ applicationId: job.applicationId, error: approvalTransition.error.message });

        // Skip to next eligible application
        continue;
      }

      // Increment generated cover letters count
      generatedCount += 1;

      // Increment clean vs flagged counters
      if (auditVerdict.isClean) {
        // Increment clean count
        cleanCount += 1;
      } else {
        // Increment flagged count
        flaggedCount += 1;
      }
    } catch (err) {
      // Format error message string
      const errMsg = err instanceof Error ? err.message : String(err);

      // Record exception error for row
      failures.push({ applicationId: job.applicationId, error: errMsg });
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
        rows_in: plan.eligible.length,
        // Rows out count
        rows_out: generatedCount,
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
    // Total generated count
    generated: generatedCount,
    // Clean count
    clean: cleanCount,
    // Flagged count
    flagged: flaggedCount,
    // Skipped jobs array
    skipped: plan.skipped,
    // Failures array
    failures,
  });
});
