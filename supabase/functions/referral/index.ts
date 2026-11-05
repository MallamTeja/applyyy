// Referral Outreach Runner — Edge Function Entrypoint
//
// IDENTITY AND BOUNDED DOMAIN:
// Build Referral Edge Function runner to automate cold outreach draft generation for candidate referrals.
//
// WHAT THIS EDGE FUNCTION DOES:
// 1. Queries applications sitting at status `awaiting_approval` or `approved` (Teja's
//    ruling 2026-11-02; see eligible-queue.ts for why earlier statuses are excluded).
// 2. Checks and validates company name presence for each candidate application row.
// 3. Loads candidate master profile context from `master_profiles` table.
// 4. Generates a personalized referral outreach message draft (subject + body + networking strategy notes)
//    using Gemini. On any model failure or off-schema reply it stores NOTHING and the
//    next run retries (the template fallback was removed 2026-10-04: see NO FALLBACK).
// 5. Logs the generated referral outreach draft as an audit event into `application_events` table.
// 6. Records execution telemetry in `agent_runs` as agent 'referral' (it borrowed
//    'screener' until migration 20261004210000 gave it an identity).
//
// INVARIANTS & CONSTRAINTS:
// - Executes inside Deno Edge runtime under authenticated Supabase client using App RLS policies.
// - Respects system kill switch (`system_settings.system_enabled`).
// - Never mutates legal status transitions illegally; logs outreach drafts as append-only audit events.
// - All untrusted inputs (job titles, company names, job descriptions) are handled safely.

// Import the database client creation helper for authenticated Supabase user sessions under RLS policy enforcement.
// Ensures that every database query runs under Row Level Security without bypassing tenant boundaries.
import { createAuthorizedAppUserClient } from "../_shared/db/client.ts";
// Import Gemini API transport helper with multi-key pool failover and token pacing.
// Handles rate limits, transparent 429 key rotations, and token pacing automatically.
import { generateGeminiContent } from "../_shared/gemini/client.ts";
// The shared failure description (reason, status, short redacted detail).
import { describeGeminiFailure } from "../_shared/gemini/failure-message.ts";
// Caller auth and the fail-closed kill switch, shared with every agent that spends quota.
import { authorizeCaller, readKillSwitch } from "../_shared/db/gates.ts";
// Import shared contracts type re-exports for system schema stability.
// Re-exports core schema types so deep imports are avoided across the workspace.
import type { MasterProfile } from "../_shared/contracts/shared-types.ts";
// Strict reply-shape check; null means "store nothing, retry next run".
import { parseReferralReply } from "./parse-reply.ts";
// The queue query and its eligible-status list, tested apart from this Deno.serve entrypoint.
import { REFERRAL_ELIGIBLE_STATUSES, selectReferralQueue } from "./eligible-queue.ts";

// Define the default batch processing size constant for queue lookups.
// Limits the number of candidate application rows fetched per single Edge Function execution.
const DEFAULT_BATCH_SIZE = 10;

// Define the maximum allowed batch processing size ceiling constant.
// Prevents caller queries from requesting excessive batch sizes that exhaust LLM quota or memory limits.
const MAX_BATCH_SIZE = 25;

// CORS comes from _shared/cors.ts, the one source (P2 #3, 2026-11-05): this function used to
// carry a private `Access-Control-Allow-Origin: *` copy. withCors (below, around Deno.serve)
// adds the per-request origin decision; corsHeaders keeps the shared header/method list.
import { corsHeaders, withCors } from "../_shared/cors.ts";

// Interface contract defining structure of generated referral outreach draft payload object.
// Represents the structured output containing message subject, body text, and networking notes.
export interface ReferralOutreachDraft {
  // Target company name string extracted from job posting record.
  // Used to identify the target employer organization for outreach.
  companyName: string;
  // Target job position title string.
  // Used to specify the exact position being inquired about.
  jobTitle: string;
  // Recommended target recipient role description string.
  // Identifies whether outreach should target a Peer Engineer, Manager, or Recruiter.
  recipientRole: string;
  // Email or LinkedIn message subject line text string.
  // Formatted subject line designed to capture recipient attention.
  subject: string;
  // Cold referral outreach message body text string.
  // Complete message content requesting introduction or referral connection.
  body: string;
  // Strategic advice and networking tips for outreach delivery string.
  // Guides candidate on how to find and connect with recipients on professional networks.
  notes: string;
  // ISO timestamp string recording when referral draft was generated.
  // Provides accurate audit trail timestamp for when outreach content was generated.
  generatedAt: string;
}

// Formats structured JSON HTTP responses with status code and CORS headers.
// Encapsulates Response creation with consistent content headers and pretty-printed JSON formatting.
function jsonResponse(
  // HTTP status code integer to return in response header (e.g. 200, 409, 500, 503).
  // Passed directly to the Response constructor options.
  status: number,
  // Dictionary object containing key-value data payload to serialize into response body.
  // Structured dictionary converted into JSON text.
  data: Record<string, unknown>,
): Response {
  // Return formatted Response instance containing serialized JSON payload.
  // Constructs HTTP response object for Deno runtime delivery.
  return new Response(
    // Serialize data payload dictionary to pretty-printed JSON text string.
    // Indented formatting aids debugging and human inspection during testing.
    JSON.stringify(data, null, 2),
    // Response configuration options object specifying status code and headers.
    // Attaches HTTP status code and CORS/content-type headers.
    {
      // Assign HTTP status code integer value.
      status,
      // Merge content-type header with UTF-8 charset specification and CORS headers.
      // Guarantees proper character encoding handling for response text.
      headers: { "content-type": "application/json; charset=utf-8", ...corsHeaders },
    },
  );
}

// Parses and clamps limit query parameter string into bounded integer batch size.
// Sanitizes user inputs to ensure safe, integer batch size bounds.
function resolveBatchSize(
  // Raw search parameter string extracted from request URL parameters.
  // Can be null if the parameter was omitted by the caller.
  raw: string | null,
): number {
  // Check if raw query parameter was not provided by caller.
  // Returns default batch size constant when parameter is missing.
  if (raw === null) return DEFAULT_BATCH_SIZE;
  // Convert raw search parameter string to numeric value.
  // Converts string representation to number primitive.
  const parsed = Number(raw);
  // Check if parsed value is not a valid integer or is less than 1.
  // Guards against NaN, floating point values, zero, and negative numbers.
  if (!Number.isInteger(parsed) || parsed < 1) return DEFAULT_BATCH_SIZE;
  // Return minimum value between parsed integer and maximum batch size ceiling limit.
  // Caps requested limit value to protect system quota limits.
  return Math.min(parsed, MAX_BATCH_SIZE);
}

// Register main Deno HTTP server request handler callback.
// Listens for incoming HTTP requests dispatched to the referral edge function.
// withCors: every response, preflight included, gets the allowlisted origin and Vary: Origin.
Deno.serve(withCors(async (req: Request): Promise<Response> => {
  // Check if incoming request method is OPTIONS preflight request.
  // Evaluates HTTP request method for CORS preflight handling.
  if (req.method === "OPTIONS") {
    // Return fast HTTP 200 OK response with standard CORS headers.
    // Completes browser CORS preflight check immediately.
    return new Response("ok", { headers: corsHeaders });
  }

  // Authenticate database client using request authorization header credentials under RLS.
  // Initializes authenticated Supabase client for database operations.
  const connection = await createAuthorizedAppUserClient(req);
  // W15 (2026-11-05): a refused caller (no token, the public anon key, another user) is answered HERE,
  // before any password grant was spent on Teja's account; same status and body as the caller check below.
  if (!connection.ok && connection.kind === "refused") return jsonResponse(connection.status, { success: false, error: connection.error });

  // Check if database client initialization or authentication failed.
  // Evaluates connection status result object.
  if (!connection.ok) {
    // Log connection failure message to server internal console logs.
    // Output error context for system debugging.
    console.error("[referral] DB connection failed:", connection.reason);
    // Return HTTP 503 Service Unavailable error response to client.
    // Signals transient database connection failure.
    return jsonResponse(503, { success: false, error: "database_unavailable" });
  }

  // Extract authenticated Supabase client instance from connection result.
  // Obtains ready-to-use database client instance.
  const db = connection.db;

  // Kept as a second check (defense in depth, 2026-11-05): the caller was already verified BEFORE
  // the sign-in (createAuthorizedAppUserClient, W15). This re-checks the session against the signed-in
  // user's id with one token lookup, never a password grant.
  const caller = await authorizeCaller(req, db, connection.userId);
  // 401 for no/invalid session, 403 for someone else's; a refused call is not a run.
  if (!caller.ok) return jsonResponse(caller.status, { success: false, error: caller.error });

  // Insert agent run tracking record into agent_runs table for execution telemetry.
  // Records run start event before performing queue work.
  const { data: runRow, error: runError } = await db
    // Target agent_runs table for telemetry registration.
    .from("agent_runs")
    // Its own identity. It logged as 'screener' until 2026-10-04, which made a referral
    // run show the Screener as alive on the health page.
    .insert({ agent: "referral", status: "running", started_at: new Date().toISOString() })
    // Select generated unique identifier column from inserted row.
    .select("id")
    // Execute query expecting single row result.
    .single();
  // Telemetry must not block the agent: a failed insert (e.g. the enum migration not
  // pushed yet) is logged and drafting still runs, just without a run row.
  if (runError) console.error("[referral] agent_runs insert failed; continuing without telemetry:", runError.message);

  // Extract unique run identifier string from inserted telemetry row object if present.
  // Stores run ID for status update upon run completion.
  const runId: string | undefined = runRow?.id;

  // Helper function to update telemetry run status to failed and return error response.
  // Centralizes failure handling and run telemetry updates.
  async function failRun(
    // HTTP status code integer to return in response.
    status: number,
    // Short error code string identifier.
    error: string,
    // Detailed error message text string for telemetry tracking.
    detail: string,
  ): Promise<Response> {
    // Check if valid telemetry run identifier exists for this invocation.
    if (runId) {
      // Update agent_runs table record status to 'failed'.
      await db
        // Target agent_runs table for telemetry update.
        .from("agent_runs")
        // Update status to failed and set finished timestamp and error detail text.
        .update({ status: "failed", finished_at: new Date().toISOString(), error_detail: detail })
        // Match specific run identifier.
        .eq("id", runId);
    }
    // Return formatted JSON response with error details.
    return jsonResponse(status, { success: false, error, detail });
  }

  // Parse request URL object to extract query search parameters.
  // Reads incoming request URL parameters.
  const url = new URL(req.url);

  // The shared fail-closed switch, same as every pipeline agent. The `?force=true`
  // override was removed 2026-10-04: a URL parameter any caller can type must not
  // outrank the switch the user flipped to stop Gemini spend. This also replaces a
  // `.single()` read whose `?? false` let a non-boolean truthy value count as "on".
  const killSwitch = await readKillSwitch(db);
  // An unreadable switch is an error, not a decision — and never "on".
  if (killSwitch.kind === "unreadable") return await failRun(503, "kill_switch_read_failed", killSwitch.detail);
  // Off: a deliberate halt, recorded so the health page can tell it from a dead cron.
  if (killSwitch.kind === "disabled") {
    // Close the run row as a skip rather than leave it `running`.
    if (runId) {
      // Status, finish time and the switch's own reason.
      await db
        .from("agent_runs")
        .update({ status: "skipped_disabled", finished_at: new Date().toISOString(), error_detail: killSwitch.detail })
        // This run only.
        .eq("id", runId);
    }
    // 200: the system did what it was told.
    return jsonResponse(200, { status: "halted_by_kill_switch", message: killSwitch.detail, processed: 0 });
  }

  // Resolve target processing batch size integer limit from request query parameters.
  // Calculates clamped batch limit for application query.
  const batchSize = resolveBatchSize(url.searchParams.get("limit"));

  // ALREADY-DRAFTED EXCLUSION (2026-10-04). Without it every run re-drafted the same
  // oldest rows, spending Gemini quota and appending a duplicate draft event each time —
  // and `application_events` is append-only, so duplicates can never be cleaned up.
  // Read BEFORE the queue query so the exclusion happens in the database: filtering after
  // `.limit()` would let the oldest N drafted rows fill every batch forever.
  const { data: draftedRows, error: draftedError } = await db
    // The append-only log the drafts are written to.
    .from("application_events")
    // Only the application id is needed.
    .select("application_id")
    // Drafts are written as notes…
    .eq("event_type", "note")
    // …tagged with this action (see the insert below).
    .eq("detail->>action", "referral_outreach_drafted");
  // An unreadable exclusion list must not read as "nothing drafted yet".
  if (draftedError) return await failRun(500, "query_drafted_failed", draftedError.message);
  // Distinct ids; one application may carry old duplicate drafts.
  const draftedIds = [...new Set((draftedRows ?? []).map((r: { application_id: string }) => r.application_id))];

  // The oldest undrafted applications at awaiting_approval or approved, capped at batchSize.
  // The query lives in eligible-queue.ts so a test can pin the status filter it sends.
  const { data: apps, error: appsError } = await selectReferralQueue(db, draftedIds, batchSize);

  // Handle database query error if application queue lookup failed.
  // Evaluates applications query error result object.
  if (appsError) {
    // Fail run with 500 error response detailing query error message.
    return await failRun(500, "query_applications_failed", appsError.message);
  }

  // Check if applications queue query returned empty result set.
  // Evaluates fetched applications array length.
  if (!apps || apps.length === 0) {
    // Check if telemetry run identifier exists for this execution.
    if (runId) {
      // Update agent_runs table record status to 'succeeded' with zero row metrics.
      await db
        // Target agent_runs table for telemetry update.
        .from("agent_runs")
        // Set status to succeeded and zero out row counts.
        .update({ status: "succeeded", finished_at: new Date().toISOString(), rows_in: 0, rows_out: 0 })
        // Match specific run identifier.
        .eq("id", runId);
    }
    // Return HTTP 200 response indicating no eligible applications were queued.
    return jsonResponse(200, {
      status: "no_eligible_applications",
      // Built from the same list the query used, so the message cannot drift from it.
      message: `No undrafted applications found at status ${REFERRAL_ELIGIBLE_STATUSES.join(" or ")}.`,
      processed: 0,
      generated: 0,
    });
  }

  // Query master_profiles table for latest candidate profile snapshot to personalize referral outreach.
  // Fetches master profile record to extract candidate skills and background.
  const { data: masterRow } = await db
    // Target master_profiles table.
    .from("master_profiles")
    // Select profile JSONB column payload.
    .select("profile")
    // Order by version descending to select highest version number first.
    .order("version", { ascending: false })
    // Limit query result to single row.
    .limit(1)
    // Execute query returning single row or null.
    .maybeSingle();

  // Cast retrieved raw profile payload to typed MasterProfile interface if present.
  // Converts raw profile JSONB into structured profile object.
  const masterProfile = masterRow?.profile as MasterProfile | undefined;

  // Extract top candidate skills array keys or fallback summary string for prompt personalization.
  // Prepares candidate background highlights text.
  // `skills` is an ARRAY of `{ name, category }` nodes; the old `Object.keys` sent the
  // indices "0, 1, 2, 3, 4" to the prompt. Read by shape, since stored JSON is unchecked.
  const skillNames = (Array.isArray(masterProfile?.skills) ? masterProfile.skills : [])
    // Only entries that really carry a name.
    .map((skill: unknown) => (typeof skill === "object" && skill !== null ? (skill as { name?: unknown }).name : undefined))
    // Non-blank strings only.
    .filter((name): name is string => typeof name === "string" && name.trim().length > 0)
    // Top five, in the profile's own order.
    .slice(0, 5);
  // The generic phrase only when the profile has no usable skills at all.
  const candidateSkills = skillNames.length > 0 ? skillNames.join(", ") : "full-stack development and system design";

  // Initialize successful referral generation count accumulator variable.
  // Tracks count of successfully generated referral outreach drafts.
  let generatedCount = 0;

  // Initialize item processing failure count accumulator variable.
  // Tracks count of failed application processing items.
  let failedCount = 0;

  // Initialize total Gemini API call execution count accumulator variable.
  // Tracks LLM calls for run telemetry tracking.
  let geminiCalls = 0;

  // Initialize processing warnings array list to store operational warnings.
  // Captures non-fatal warnings encountered during batch execution.
  const warnings: string[] = [];

  // Iterate sequentially through each fetched application row retrieved from queue.
  // Processes each candidate application to check company name and draft referral outreach.
  for (const app of apps) {
    // Cast joined job relation object to structured job fields interface.
    // Extracts parsed job posting details from database query.
    const job = app.jobs as unknown as {
      id?: string;
      title?: string;
      company_name?: string;
      company_slug?: string;
      location_raw?: string | null;
      description_raw?: string | null;
    } | null;

    // Check if joined job relation object is missing or null.
    // Guards against applications without linked job posting records.
    if (!job) {
      // Append warning message string to warnings array.
      warnings.push(`Application ${app.id} missing job relation record.`);
      // Increment failure count accumulator variable.
      failedCount++;
      // Continue loop to next application row.
      continue;
    }

    // Extract and trim target company name string from job record.
    // Removes leading and trailing whitespace from company name.
    const companyName = job.company_name?.trim();

    // Extract and trim target job title string from job record, falling back to default title.
    // Provides fallback title if unstated by job record.
    const jobTitle = job.title?.trim() ?? "Software Engineer";

    // Check and validate company name presence.
    // Rejects applications where company name is absent or empty.
    if (!companyName || companyName.length === 0) {
      // Append warning message string for invalid/missing company name.
      warnings.push(`Application ${app.id} has invalid or missing company name.`);
      // Increment failure count accumulator variable.
      failedCount++;
      // Skip processing applications without valid company names.
      continue;
    }

    // Assigned only by a validated Gemini reply. Stays null on every failure, and null
    // stores nothing — see the NO FALLBACK note below.
    let referralDraft: ReferralOutreachDraft | null = null;

    // Construct system instruction prompt text string for Gemini LLM referral generator.
    // Sets AI persona, task context, and strict JSON output formatting instructions.
    const systemInstruction = `You are an expert career strategist and networking coach. Your task is to draft a concise, highly effective, professional referral outreach message requesting an employee or recruiter at ${companyName} for a job referral for the position of ${jobTitle}.
Return ONLY a JSON object adhering strictly to the response schema.`;

    // Construct user content prompt text string for Gemini LLM referral generator.
    // Packages job context and candidate skills for prompt evaluation.
    const userContent = `Company Name: ${companyName}
Job Title: ${jobTitle}
Location: ${job.location_raw ?? "Remote / Unspecified"}
Candidate Skills: ${candidateSkills}
Job Description Context: ${job.description_raw ? job.description_raw.slice(0, 1000) : "N/A"}`;

    // Define JSON schema object for Gemini structured output generation.
    // Enforces structured response schema containing recipient role, subject, body, and notes.
    const responseSchema = {
      // Root schema type specified as OBJECT.
      type: "OBJECT",
      // Define properties object specifying required string field shapes.
      properties: {
        // Target recipient role field schema definition.
        recipientRole: { type: "STRING" },
        // Subject line field schema definition.
        subject: { type: "STRING" },
        // Message body field schema definition.
        body: { type: "STRING" },
        // Strategic notes field schema definition.
        notes: { type: "STRING" },
      },
      // List required property keys that must be present in model JSON response.
      required: ["recipientRole", "subject", "body", "notes"],
    };

    // Execute Gemini API call inside try-catch block for fail-safe error handling.
    // Wraps LLM generation and fallback handling in protected block.
    try {
      // Increment total Gemini API call execution counter.
      geminiCalls++;

      // Invoke Gemini API using shared client middleware with key pool failover and token pacing.
      // Dispatches LLM call with transparent retry handling.
      const outcome = await generateGeminiContent(db, {
        // Pass system instruction, user content, and response schema prompt object.
        prompt: { systemInstruction, userContent, responseSchema },
      });

      // A transport failure stores nothing; reason, status and a capped, key-redacted detail
      // are safe to report and tell one http_error from another.
      if (!outcome.ok) {
        warnings.push(`Gemini call failed for ${app.id} (${describeGeminiFailure(outcome)}); nothing stored, will retry.`);
      } else {
        // Shape-validated; null for anything that is not all four non-blank strings.
        const parsed = parseReferralReply(outcome.data.candidates?.[0]?.content?.parts?.[0]?.text);
        // Off-schema: reported and retried, never patched up with defaults.
        if (parsed === null) {
          warnings.push(`Gemini reply for ${app.id} did not match the referral schema; nothing stored, will retry.`);
        } else {
          // The validated fields plus the context this run already knows.
          referralDraft = { companyName, jobTitle, ...parsed, generatedAt: new Date().toISOString() };
        }
      }
    } catch (err) {
      // A thrown transport error is a failure like any other: store nothing.
      warnings.push(`Error generating referral for ${app.id}: ${err instanceof Error ? err.message : String(err)}`);
    }

    // NO FALLBACK (2026-10-04). A template draft used to be stored on every failure, and
    // the ALREADY-DRAFTED exclusion above then hid the row from every later run — so one
    // Gemini hiccup made a "[Name]"/"[Your Name]" template permanent in an append-only
    // log. Storing nothing keeps the row in the queue and the next run retries it.
    if (referralDraft === null) {
      // Counted, so a run where everything failed reports `failed`, not `succeeded`.
      failedCount++;
      // Next application.
      continue;
    }

    // Log the generated referral outreach draft as an append-only audit event into application_events table.
    // Records audit trail event without modifying application status graph.
    const { error: eventError } = await db
      // Target application_events table for audit log entry.
      .from("application_events")
      // Insert note event record containing structured referral outreach draft detail payload.
      .insert({
        // Assign target application ID parameter.
        application_id: app.id,
        // Assign user ID parameter.
        user_id: app.user_id,
        // Assign event_type string constant 'note'.
        event_type: "note",
        // Still NULL, deliberately, though migration 20261004210000 now adds 'referral':
        // agent_runs tolerates a missing enum value (logged, not fatal), but a failed
        // INSERT here loses the draft, so naming the agent would make every draft depend
        // on the migration landing before the deploy. Unattributed is honest; the old
        // 'screener' was not, in a log that can never be corrected.
        agent: null,
        // Assign structured detail JSONB payload object.
        detail: {
          // Action identifier label string.
          action: "referral_outreach_drafted",
          // Target company name string.
          company_name: companyName,
          // Target job position title string.
          job_title: jobTitle,
          // Generated referral outreach draft object.
          draft: referralDraft,
        },
      });

    // Check if audit log insertion encountered database error.
    if (eventError) {
      // Append database insertion error message string to warnings array.
      warnings.push(`Failed to insert application_event for ${app.id}: ${eventError.message}`);
      // Increment failed item processing counter.
      failedCount++;
    } else {
      // Increment successful referral generation counter.
      generatedCount++;
    }
  }

  // HONEST FINAL STATUS (matcher's rule): `failed` only when there was work, none of it
  // landed and errors explain why. Before this every run was `succeeded`, including one
  // where every Gemini call failed. Mixed stays `succeeded` with error_count set, since
  // agent_run_status has no `partial`.
  const runStatus = apps.length > 0 && generatedCount === 0 && failedCount > 0 ? "failed" : "succeeded";
  // First three DISTINCT reasons, capped; null on a clean run so no stale reason lingers.
  const errorDetail = warnings.length > 0 ? [...new Set(warnings)].slice(0, 3).join(" | ").slice(0, 500) : null;

  // Check if valid telemetry run identifier exists for this invocation.
  // Updates agent_runs table with completed execution metrics.
  if (runId) {
    // Close the run with the derived verdict; a failed close is logged, not thrown,
    // because telemetry must not turn a finished batch into an error response.
    const { error: closeError } = await db
      // Target agent_runs table for status update.
      .from("agent_runs")
      // Derived status, the reason, row counts and Gemini call metrics.
      .update({
        // Never hard-coded: see runStatus above.
        status: runStatus,
        // Why, not just how many.
        error_detail: errorDetail,
        finished_at: new Date().toISOString(),
        rows_in: apps.length,
        rows_out: generatedCount,
        error_count: failedCount,
        gemini_calls: geminiCalls,
      })
      // Match specific run identifier.
      .eq("id", runId);
    // Explains a run row left at `running` in the function log.
    if (closeError) console.error("[referral] agent_runs close failed:", closeError.message);
  }

  // Return HTTP 200 OK JSON response summarizing referral outreach runner execution metrics.
  // Returns summary dictionary object to caller.
  return jsonResponse(200, {
    // Set execution success flag boolean to true.
    success: true,
    // The same verdict agent_runs holds, so dashboard and health page agree.
    status: runStatus,
    // Count of input application queue items fetched.
    processed: apps.length,
    // Count of successfully generated referral outreach drafts.
    generated: generatedCount,
    // Count of failed application processing items.
    failed: failedCount,
    // Count of executed Gemini API calls.
    gemini_calls: geminiCalls,
    // List of recorded operational warning message strings.
    warnings,
  });
}));
