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

// Import database client factory: verifies the caller first, then signs in (W15)
import { createAuthorizedAppUserClient } from "../_shared/db/client.ts";

// Import anti-fabrication auditor orchestrator function
import { auditApplication } from "../_shared/audit/audit.ts";

// Resolves each row's master by its pin; the closed union is what makes "use the latest" unwritable.
import { collectPins, resolvePinnedMaster } from "../_shared/audit/pinned-master.ts";

// Import shared contract interfaces for MasterProfile, ResolvedResume, and TailoredProfile
import type { MasterProfile, ResolvedResume, TailoredProfile } from "../_shared/contracts/shared-types.ts";

// The fail-closed kill switch, shared by every pipeline agent (caller auth is in the client now)
import { readKillSwitch } from "../_shared/db/gates.ts";

// Shared CORS headers, plus the boundary that keeps them on an uncaught 500
import { corsHeaders, withErrorBoundary } from "../_shared/cors.ts";

// The shared `?application_id=` parser, so all five pipeline agents refuse a bad id identically
import { parseApplicationIdParam } from "../_shared/http/application-id.ts";

// The matcher's pre-gate, re-run as the last check before a human sees the row (leak 1, 2026-11-05)
import { auditorPreGateDrop, loadPreGatePreferences, type AuditorJobEmbed, type ConfigReader } from "./pregate.ts";

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

  // Verify the caller FIRST, then sign in under the app user's RLS session (W15): this
  // function is verify_jwt=false, so a tokenless request reaches here and must not cost a
  // password grant
  const connection = await createAuthorizedAppUserClient(req);

  // 401 for no/invalid session, 403 for someone else's: refused before any write, same bodies
  if (!connection.ok && connection.kind === "refused") {
    // The verdict carries which status
    return jsonResponse(connection.status, { success: false, error: connection.error });
  }

  // Return service unavailable response if database connection failed
  if (!connection.ok) {
    // Log connection failure error message
    console.error("[applyy-auditor] database connection failed:", connection.reason);

    // Return 503 response
    return jsonResponse(503, { success: false, error: "database_unavailable" });
  }

  // Unpack connected database client
  const db = connection.db;

  // Optional single-row target. Read from the URL so the CLI can push ONE application through
  // without waiting for it to reach the head of an oldest-first queue.
  const target = parseApplicationIdParam(new URL(req.url).searchParams);
  // A malformed id is REFUSED, never ignored: ignoring it would fall back to the whole
  // queue and process rows the caller did not ask for (the fail-open this repo forbids).
  // Checked BEFORE the agent_runs insert, so a bad request leaves no run row behind:
  // nothing ran, and a `failed` row would tell the health page the agent broke.
  if (target.kind === "invalid") {
    // 400 with a named reason, so the caller sees what was wrong with its input.
    return jsonResponse(400, { success: false, error: "invalid_application_id", detail: "application_id must be a UUID" });
  }
  // Null means "no target": the unchanged whole-queue behaviour.
  const applicationId: string | null = target.kind === "valid" ? target.id : null;

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

  // NO "latest master" read here any more. This used to load `version desc limit 1` and audit
  // every row against it, so a master uploaded after tailoring became the ground truth for
  // resumes built from an older one. Masters are now loaded per batch, by each row's pin,
  // after the queue read below (see pinned-master.ts).

  // Extract limit query parameter from request URL
  const limitParam = new URL(req.url).searchParams.get("limit");

  // Determine batch size limit from request URL parameter
  const batchSize = resolveBatchSize(limitParam);

  // `applicationId` was parsed and validated above, before the run row was opened.
  // Query the queue: fresh `tailored` rows, plus rows stranded between the two RPCs
  const { data: rows, error: rowsError } = await db
    // Target applications table
    .from("applications")
    // `status` is selected so the loop can tell a fresh row from a stranded one
    // `applications.master_version` is deliberately NOT selected: nothing writes it (null on every
    // live row, 2026-10-08), so the pin is read from `tailored_profile.master_version` instead.
    // The job's four gate inputs plus discovered_via, for the pre-gate re-check below. A plain
    // (left) embed, not `!inner`: a row whose job is missing must surface as a per-row failure,
    // not vanish from the queue (auditorPreGateDrop throws on a null embed).
    .select("id, status, tailored_profile, tailor_refs, jobs(title, description_raw, location_raw, min_experience_years, discovered_via)")
    // `audit_clean`/`audit_flagged` are only ever left behind by a failed second hop
    .in("status", ["tailored", "audit_clean", "audit_flagged"])
    // Narrow to the one requested row; the status filter stays, so a wrong-status id yields
    // zero rows. An empty match object is a no-op when untargeted.
    .match(applicationId !== null ? { id: applicationId } : {})
    // Order by created_at ascending
    .order("created_at", { ascending: true })
    // Limit batch size
    .limit(batchSize);

  // Handle applications queue read error
  if (rowsError) return await failRun(503, "queue_unreadable", rowsError.message);

  // The pin lives in the resolved resume: the tailor's validator refuses output whose version
  // differs from the master it loaded and stamps it there (validator.ts:431-433, :776). Only
  // `tailored` rows are audited, so only their pins decide which masters to load.
  const pinOf = (row: { tailored_profile: unknown }): unknown =>
    // Optional chaining: a null profile yields undefined, which resolves to "unpinned".
    (row.tailored_profile as { master_version?: unknown } | null)?.master_version;
  // Distinct, shape-checked pins for this batch; invalid ones are reported per row below.
  const pins = collectPins((rows ?? []).filter((row) => row.status === "tailored").map((row) => ({ master_version: pinOf(row) })));

  // Exactly the pinned versions, one query. RLS scopes master_profiles to the signed-in
  // owner (createAppUserClient), and versions are immutable (forbid_update/forbid_delete).
  const mastersByVersion = new Map<number, MasterProfile>();
  // Skip the round trip when nothing is pinned; `.in()` with an empty list is pointless.
  if (pins.length > 0) {
    // Same table and columns as the old latest-master read, filtered to the pins instead.
    const { data: masterRows, error: masterError } = await db.from("master_profiles").select("profile, version").in("version", pins);
    // A failed read is an error for the whole run, never a reason to audit against something else.
    if (masterError) return await failRun(503, "master_profile_unreadable", masterError.message);
    // Index by version so each row resolves its own pin with an exact lookup.
    for (const m of masterRows ?? []) mastersByVersion.set(m.version as number, m.profile as MasterProfile);
  }

  // Today's gate config, read once per run and only when a fresh `tailored` row needs it
  // (stranded rows are past the audit and have no auditor edge except awaiting_approval).
  const needsGate = (rows ?? []).some((row) => row.status === "tailored");
  // Loaded before the loop so a failed read stops the run before any row moves, as in the matcher.
  // The cast: checking supabase-js's deeply generic builder against ConfigReader's self-chaining
  // `eq` overflows the compiler (TS2589); the reads it makes are exactly the matcher's.
  const gateConfig = needsGate ? await loadPreGatePreferences(db as unknown as ConfigReader) : null;
  // A failed read is a run failure, never "no config" (which would pass every row).
  if (gateConfig?.kind === "error") return await failRun(503, gateConfig.code, gateConfig.message);

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

      // THE LAST GATE (leak 1, 2026-11-05): re-judge the job with today's pre-gate before any
      // audit work, so a row that passed the matcher under an older gate never reaches a human.
      // gateConfig is non-null here: this row is `tailored`, so needsGate was true above.
      const drop = gateConfig?.kind === "ok" ? auditorPreGateDrop(row.jobs as unknown as AuditorJobEmbed | null, gateConfig.preferences) : null;
      // An objection: off the queue with the gate's code, through the auditor's one exit.
      if (drop !== null) {
        // `tailored -> failed` is the auditor's only non-audit edge (live graph, 2026-11-05).
        const gateMove = await db.rpc("advance_application_status", {
          // Application ID
          p_application_id: row.id,
          // Off the queue; a human can send it back (failed -> passed_filters)
          p_to_status: "failed",
          // Acting agent identity
          p_agent: "auditor",
          // The gate's code and words, in the matcher's detail shape, with this stage named
          p_detail: { reason: drop.code, stage: "auditor_pre_gate", detail: drop.reason },
        });
        // A refused move leaves the row in place; report it rather than count it
        if (gateMove.error) failures.push({ applicationId: row.id, error: gateMove.error.message });
        // Counted with the other permanent failures; the drain reads `failed` as advanced
        else failedCount += 1;
        // Never audited, never shown to Teja
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

      // The master this row was TAILORED against; anything but `pinned` fails closed below.
      const pinned = resolvePinnedMaster(pinOf(row), mastersByVersion);

      // No trustworthy ground truth. Falling back to the latest master is the bug this replaced
      // (CLAUDE.md §5), so the row is failed with a named reason, like a missing profile above:
      // the pin cannot appear later (the profile is written once by the tailor), and leaving
      // the row would block the oldest-first queue behind it forever.
      if (pinned.kind !== "pinned") {
        // Through the RPC; `tailored -> failed` is the auditor's edge (:123).
        const failMove = await db.rpc("advance_application_status", {
          // Application ID
          p_application_id: row.id,
          // Off the queue for good
          p_to_status: "failed",
          // Acting agent identity
          p_agent: "auditor",
          // The verdict object itself, so the dashboard shows which pin problem it was.
          p_detail: { reason: `master_pin_${pinned.kind}`, pin: pinned },
        });
        // A refused move leaves the row in place; report it rather than count it
        if (failMove.error) failures.push({ applicationId: row.id, error: failMove.error.message });
        // Counted as failed, separately from transient errors
        else failedCount += 1;
        // Never audit this row against anything
        continue;
      }

      // Execute anti-fabrication audit against the PINNED master profile
      const outcome = auditApplication(pinned.master, resume, tailorRefs);

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
        // The version actually audited against, so the event records this row's ground truth.
        p_detail: { findings_count: outcome.findings.length, master_version: pinned.version },
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
    // Every master version this batch audited against; a batch can span several, so it is a
    // list. No worker/web code read the old single `master_version` field (grep 2026-10-08).
    master_versions: pins,
    // Only present on a targeted run, so the untargeted response shape is unchanged. `found: 0`
    // says "that id is not at this agent's input status", which an empty queue never could.
    ...(applicationId !== null ? { targeted: true, found: applicationRows.length } : {}),
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
