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
//
// SELF-HEALING: steps 4 and 5 are two RPCs, so a failure between them strands a row at
// `audit_clean`/`audit_flagged`. The queue therefore also selects those two statuses and
// retries only step 5 for them — the audit itself already ran and its findings are
// written. Without this, a stranded row never reached the human queue at all.
// ============================================================================

// Import database client factory helper for authenticated Supabase connection
import { createAppUserClient } from "../_shared/db/client.ts";

// Import anti-fabrication auditor orchestrator function
import { auditApplication } from "../_shared/audit/audit.ts";

// Import shared contract interfaces for MasterProfile, ResolvedResume, and TailoredProfile
import type { MasterProfile, ResolvedResume, TailoredProfile } from "../_shared/contracts/shared-types.ts";

// Caller auth and the fail-closed kill switch, shared by every pipeline agent
import { authorizeCaller, readKillSwitch } from "../_shared/db/gates.ts";

// Shared CORS headers, plus the boundary that keeps them on an uncaught 500
import { corsHeaders, withErrorBoundary } from "../_shared/cors.ts";

// Default batch processing limit size for Auditor invocation
const DEFAULT_BATCH_SIZE = 10;

// Maximum allowed batch processing limit ceiling
const MAX_BATCH_SIZE = 25;

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
// Wrapped so a throw anywhere below still answers with CORS headers the browser can read
Deno.serve(withErrorBoundary("applyy-auditor", async (req: Request): Promise<Response> => {
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

  // Refuse anyone but the app user BEFORE any write: the sign-in above never looks at
  // the caller, so the public anon key alone used to be enough to advance rows
  const caller = await authorizeCaller(req, db, connection.userId);

  // 401 for no/invalid session, 403 for someone else's — the verdict carries which
  if (!caller.ok) return jsonResponse(caller.status, { success: false, error: caller.error });

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

  // The shared fail-closed kill switch; the auditor never checked it before
  const killSwitch = await readKillSwitch(db);

  // A failed read is an error, not a decision
  if (killSwitch.kind === "unreadable") return await failRun(503, "kill_switch_read_failed", killSwitch.detail);

  // Off, or no settings row: a deliberate skip, recorded so the health page says why
  if (killSwitch.kind === "disabled") {
    // Close the run row as skipped rather than leave it `running`
    if (runId) {
      await db
        .from("agent_runs")
        .update({ status: "skipped_disabled", finished_at: new Date().toISOString(), error_detail: killSwitch.detail })
        .eq("id", runId);
    }

    // 200: the system did what it was told
    return jsonResponse(200, { success: true, status: "skipped_disabled", detail: killSwitch.detail });
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

  // Query the queue: fresh `tailored` rows, plus rows stranded between the two RPCs
  const { data: rows, error: rowsError } = await db
    // Target applications table
    .from("applications")
    // `status` is selected so the loop can tell a fresh row from a stranded one
    .select("id, status, tailored_profile, tailor_refs, master_version")
    // `audit_clean`/`audit_flagged` are only ever left behind by a failed second hop
    .in("status", ["tailored", "audit_clean", "audit_flagged"])
    // Order by created_at ascending
    .order("created_at", { ascending: true })
    // Limit batch size
    .limit(batchSize);

  // Handle applications queue read error
  if (rowsError) return await failRun(503, "queue_unreadable", rowsError.message);

  // Initialize total audited counter
  let auditedCount = 0;

  // Stranded rows moved on to awaiting_approval this run — reported separately because
  // they were audited by an EARLIER run, and counting them as audited would overstate
  let resumedCount = 0;

  // Rows failed for a permanent reason, so they stop blocking the head of the queue
  let failedCount = 0;

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
      // A stranded row: the audit already ran and wrote its findings, only the hop into
      // the human queue failed. Retry that hop alone — re-auditing would rewrite findings
      // a run already committed and could flip the verdict under a newer master.
      if (row.status === "audit_clean" || row.status === "audit_flagged") {
        // `audit_clean|audit_flagged -> awaiting_approval` is the auditor's edge (:126-127)
        const resumed = await db.rpc("advance_application_status", {
          // Application ID
          p_application_id: row.id,
          // The human queue
          p_to_status: "awaiting_approval",
          // Acting agent identity
          p_agent: "auditor",
          // The verdict is the status it was stranded at; flagged as a resumed hop
          p_detail: { audit_verdict: row.status, resumed_after_stranding: true },
        });

        // Still stranded: reported, and retried again next run
        if (resumed.error) failures.push({ applicationId: row.id, error: resumed.error.message });
        // Moved on
        else resumedCount += 1;

        // Nothing else to do for an already-audited row
        continue;
      }

      // Extract resolved tailored resume JSON
      const resume = row.tailored_profile as ResolvedResume | null;

      // Extract raw tailor refs JSON
      const tailorRefs = row.tailor_refs as TailoredProfile | null;

      // A `tailored` row with no profile is permanently unauditable — the tailor writes
      // the profile BEFORE the status (persist.ts), so this is damaged data, not a race.
      // Fail it (`tailored -> failed` is allowed for the auditor, :123) rather than leave
      // it at the head of an oldest-first queue blocking every row behind it forever
      if (!resume) {
        // Through the RPC — a bare status update is refused by the guard with 42501
        const failMove = await db.rpc("advance_application_status", {
          // Application ID
          p_application_id: row.id,
          // Off the queue for good
          p_to_status: "failed",
          // Acting agent identity
          p_agent: "auditor",
          // The reason, for the dashboard
          p_detail: { reason: "missing_tailored_profile" },
        });

        // A refused move leaves the row in place; report it rather than count it
        if (failMove.error) failures.push({ applicationId: row.id, error: failMove.error.message });
        // Counted as failed, separately from transient errors
        else failedCount += 1;

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

  // HONEST FINAL STATUS. `failed` when there was work, none of it moved, and errors
  // explain why: the live matcher run seen 2026-10-04 (rows_in 10, rows_out 0,
  // error_count 10) was stamped `succeeded`, the silent stop agent_runs exists to catch.
  // Mixed results stay `succeeded` with error_count set: `agent_run_status` has no
  // `partial` (enums.sql:190), and an empty queue (rows_in 0) is idle, not broken.
  const runStatus = applicationRows.length > 0 && auditedCount + resumedCount === 0 && failures.length > 0 ? "failed" : "succeeded";
  // The first few DISTINCT reasons, capped: ten rows failing the same way is one fact,
  // and error_detail is a health-page line, not a log. Null on a clean run so a stale
  // reason never sits beside error_count 0.
  const errorDetail = failures.length > 0
    // Set dedupes, slice(0, 3) keeps it short, slice(0, 500) bounds a pathological message.
    ? [...new Set(failures.map((f) => f.error))].slice(0, 3).join(" | ").slice(0, 500)
    : null;

  // Close the agent_runs telemetry record with the honest status
  if (runId) {
    // Update agent run record
    await db
      // Target agent_runs table
      .from("agent_runs")
      // Update fields
      .update({
        // Derived from the counters, never hard-coded: see runStatus above.
        status: runStatus,
        // The failure summary, so the health page says WHY and not just how many.
        error_detail: errorDetail,
        // Finished timestamp
        finished_at: new Date().toISOString(),
        // Rows in count
        rows_in: applicationRows.length,
        // Rows out: freshly audited plus stranded rows moved on
        rows_out: auditedCount + resumedCount,
        // Per-row errors, so a run that moved nothing reads as a problem, not as idle
        error_count: failures.length,
      })
      // Scoped by runId
      .eq("id", runId);
  }

  // Return successful execution JSON response
  return jsonResponse(200, {
    // The function ran to completion; per-row failures are in `failures` below
    success: true,
    // The same status written to agent_runs, so the dashboard and health page agree.
    status: runStatus,
    // The same failure summary, so the operator sees it without a DB query.
    error_detail: errorDetail,
    // Master version
    master_version: masterVersion,
    // Audited count
    audited: auditedCount,
    // Clean count
    clean: cleanCount,
    // Flagged count
    flagged: flaggedCount,
    // Stranded rows moved on to awaiting_approval
    resumed: resumedCount,
    // Rows failed for a permanent reason
    failed: failedCount,
    // Failures array
    failures,
  });
}));
