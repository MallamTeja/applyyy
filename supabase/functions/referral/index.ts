// Referral Outreach Runner — Edge Function Entrypoint
//
// IDENTITY AND BOUNDED DOMAIN:
// Build Referral Edge Function runner to automate cold outreach draft generation for candidate referrals.
//
// WHAT THIS EDGE FUNCTION DOES:
// 1. Queries applications queue sitting at status `passed_filters` or `scored`.
// 2. Checks and validates company name presence for each candidate application row.
// 3. Loads candidate master profile context from `master_profiles` table.
// 4. Generates a personalized referral outreach message draft (subject + body + networking strategy notes)
//    using Gemini LLM when available, or a structured deterministic fallback template.
// 5. Logs the generated referral outreach draft as an audit event into `application_events` table.
// 6. Records execution telemetry in `agent_runs` table for system health monitoring.
//
// INVARIANTS & CONSTRAINTS:
// - Executes inside Deno Edge runtime under authenticated Supabase client using App RLS policies.
// - Respects system kill switch (`system_settings.system_enabled`).
// - Never mutates legal status transitions illegally; logs outreach drafts as append-only audit events.
// - All untrusted inputs (job titles, company names, job descriptions) are handled safely.

// Import the database client creation helper for authenticated Supabase user sessions under RLS policy enforcement.
// Ensures that every database query runs under Row Level Security without bypassing tenant boundaries.
import { createAppUserClient } from "../_shared/db/client.ts";
// Import Gemini API transport helper with multi-key pool failover and token pacing.
// Handles rate limits, transparent 429 key rotations, and token pacing automatically.
import { generateGeminiContent } from "../_shared/gemini/client.ts";
// Import shared contracts type re-exports for system schema stability.
// Re-exports core schema types so deep imports are avoided across the workspace.
import type { AgentName, MasterProfile } from "../_shared/contracts/shared-types.ts";

// Define the default batch processing size constant for queue lookups.
// Limits the number of candidate application rows fetched per single Edge Function execution.
const DEFAULT_BATCH_SIZE = 10;

// Define the maximum allowed batch processing size ceiling constant.
// Prevents caller queries from requesting excessive batch sizes that exhaust LLM quota or memory limits.
const MAX_BATCH_SIZE = 25;

// Define standard CORS headers dictionary object for cross-origin browser requests.
// Configures headers required by browser clients interacting with Supabase Edge Functions.
const corsHeaders = {
  // Allow requests from any origin domain during browser cross-origin requests.
  // Security is maintained via Supabase JWT authorization tokens and RLS rules.
  "Access-Control-Allow-Origin": "*",
  // List permitted HTTP request headers allowed in client API calls.
  // Includes standard Supabase client headers and standard JSON content-type.
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  // List supported HTTP verbs allowed for this edge function endpoint.
  // Permits POST for execution, GET for manual query tests, and OPTIONS for CORS preflights.
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
};

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

// Generates a structured fallback referral outreach draft when LLM service is unavailable or rate limited.
// Ensures reliable fallback message generation without throwing errors or breaking runs.
function buildFallbackReferralDraft(
  // Target company name string.
  // Identifies employer company name for template substitution.
  companyName: string,
  // Target job title string.
  // Identifies job position title for template substitution.
  jobTitle: string,
  // Candidate background highlights or top skills summary string.
  // Provides brief summary of candidate background for outreach text.
  candidateHighlights: string,
): ReferralOutreachDraft {
  // Construct professional email subject line string using template string.
  // Combines job title and company name into subject header.
  const subject = `Referral Inquiry — ${jobTitle} role at ${companyName}`;

  // Construct structured cold referral message body text string using template literal.
  // Formats polite, professional cold outreach message for candidate.
  const body = `Hi [Name],

I noticed you are working at ${companyName} and wanted to reach out regarding the ${jobTitle} position.

I have strong experience in software engineering (${candidateHighlights}) and I am really excited about the work ${companyName} is doing.

If you have a few minutes, I would love to connect and learn more about your experience on the team. If you feel comfortable, I would be deeply grateful for a referral or introduction to the hiring team.

Thanks so much for your time!

Best regards,
[Your Name]`;

  // Construct strategic networking advice notes string for the candidate.
  // Provides actionable advice on identifying and approaching potential referrers.
  const notes = `Search LinkedIn for current team members or 2nd-degree connections at ${companyName} in relevant engineering/product roles. Personalize the intro line before sending.`;

  // Return formatted ReferralOutreachDraft object adhering to interface contract.
  // Delivers completed fallback draft structure.
  return {
    // Assign company name property.
    companyName,
    // Assign job title property.
    jobTitle,
    // Assign default target recipient role description string.
    recipientRole: "Software Engineer / Team Member / Recruiter",
    // Assign constructed subject line string.
    subject,
    // Assign constructed message body text string.
    body,
    // Assign constructed strategic notes string.
    notes,
    // Assign ISO timestamp string recording generation time.
    generatedAt: new Date().toISOString(),
  };
}

// Register main Deno HTTP server request handler callback.
// Listens for incoming HTTP requests dispatched to the referral edge function.
Deno.serve(async (req: Request): Promise<Response> => {
  // Check if incoming request method is OPTIONS preflight request.
  // Evaluates HTTP request method for CORS preflight handling.
  if (req.method === "OPTIONS") {
    // Return fast HTTP 200 OK response with standard CORS headers.
    // Completes browser CORS preflight check immediately.
    return new Response("ok", { headers: corsHeaders });
  }

  // Authenticate database client using request authorization header credentials under RLS.
  // Initializes authenticated Supabase client for database operations.
  const connection = await createAppUserClient();

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

  // Insert agent run tracking record into agent_runs table for execution telemetry.
  // Records run start event before performing queue work.
  const { data: runRow } = await db
    // Target agent_runs table for telemetry registration.
    .from("agent_runs")
    // Insert initial telemetry row with agent identity 'screener' and start timestamp.
    .insert({ agent: "screener" as AgentName, status: "running", started_at: new Date().toISOString() })
    // Select generated unique identifier column from inserted row.
    .select("id")
    // Execute query expecting single row result.
    .single();

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

  // Parse optional force query parameter flag string to override kill switch.
  // Evaluates whether caller requested force override.
  const force = url.searchParams.get("force") === "true";

  // Query system_settings table for kill switch system_enabled boolean flag state.
  // Reads global kill switch setting before executing application processing.
  const { data: settingsData, error: settingsError } = await db
    // Target system_settings configuration table.
    .from("system_settings")
    // Select system_enabled boolean configuration column.
    .select("system_enabled")
    // Limit query to single configuration row.
    .limit(1)
    // Execute query returning single row or null.
    .single();

  // Handle system_settings query error if database read encountered failure.
  // Checks for query failure other than missing row code PGRST116.
  if (settingsError && settingsError.code !== "PGRST116") {
    // Fail run with 500 error response if system settings read failed.
    return await failRun(500, "kill_switch_read_failed", settingsError.message);
  }

  // Determine effective system enabled boolean status flag.
  // Defaults to false if settings data row is missing.
  const systemEnabled = settingsData?.system_enabled ?? false;

  // Check if system is disabled and force override parameter is not enabled.
  // Enforces system kill switch check to halt processing when system is disabled.
  if (!systemEnabled && !force) {
    // Check if telemetry run identifier exists for this execution.
    if (runId) {
      // Update agent_runs telemetry row status to 'skipped_disabled'.
      await db
        // Target agent_runs table for status update.
        .from("agent_runs")
        // Update status to skipped_disabled and set detail explanation.
        .update({
          status: "skipped_disabled",
          finished_at: new Date().toISOString(),
          error_detail: "system_settings.system_enabled is false",
        })
        // Match specific run ID.
        .eq("id", runId);
    }
    // Return HTTP 200 response acknowledging halted execution by kill switch.
    return jsonResponse(200, {
      status: "halted_by_kill_switch",
      message: "system_settings.system_enabled is false. Pass ?force=true to override.",
      processed: 0,
    });
  }

  // Resolve target processing batch size integer limit from request query parameters.
  // Calculates clamped batch limit for application query.
  const batchSize = resolveBatchSize(url.searchParams.get("limit"));

  // Query applications table for applications sitting at status 'passed_filters' or 'scored'.
  // Fetches eligible candidate applications ready for referral outreach drafting.
  const { data: apps, error: appsError } = await db
    // Target applications queue table.
    .from("applications")
    // Select application ID, status, match score, match reasoning, and joined job record details.
    .select("id, job_id, user_id, status, match_score, match_reasoning, jobs ( id, title, company_name, company_slug, location_raw, locations, employment_type, description_raw )")
    // Filter applications where status is either 'passed_filters' or 'scored'.
    .in("status", ["passed_filters", "scored"])
    // Order applications by creation timestamp ascending for FIFO queue processing order.
    .order("created_at", { ascending: true })
    // Limit returned application rows to resolved batch size ceiling.
    .limit(batchSize);

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
      message: "No applications found at status 'passed_filters' or 'scored'.",
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
  const candidateSkills = masterProfile?.skills
    ? Object.keys(masterProfile.skills).slice(0, 5).join(", ")
    : "full-stack development and system design";

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

    // Declare variable to hold generated ReferralOutreachDraft object instance.
    // Container variable assigned by Gemini response or fallback generator.
    let referralDraft: ReferralOutreachDraft;

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

      // Check if Gemini API call execution succeeded.
      if (outcome.ok) {
        // Extract generated JSON text string from candidate response part.
        const text = outcome.data.candidates?.[0]?.content?.parts?.[0]?.text;

        // Check if generated text string is present.
        if (text) {
          // Parse generated JSON text string into dictionary object.
          const parsed = JSON.parse(text) as Record<string, string>;

          // Construct ReferralOutreachDraft object from parsed model output values.
          referralDraft = {
            // Assign target company name string.
            companyName,
            // Assign target job title string.
            jobTitle,
            // Assign parsed recipient role string or fallback.
            recipientRole: parsed.recipientRole ?? "Employee / Recruiter",
            // Assign parsed subject line string or fallback.
            subject: parsed.subject ?? `Referral Request — ${jobTitle} at ${companyName}`,
            // Assign parsed message body string or empty string.
            body: parsed.body ?? "",
            // Assign parsed strategic notes string or default advice string.
            notes: parsed.notes ?? "Connect with employees on LinkedIn.",
            // Assign ISO generation timestamp string.
            generatedAt: new Date().toISOString(),
          };
        } else {
          // Use deterministic fallback template generator if Gemini text was empty.
          referralDraft = buildFallbackReferralDraft(companyName, jobTitle, candidateSkills);
        }
      } else {
        // Record warning for unfulfilled Gemini call.
        warnings.push(`Gemini call unfulfilled for ${app.id} (${outcome.reason}); using fallback template.`);
        // Construct deterministic fallback referral draft.
        referralDraft = buildFallbackReferralDraft(companyName, jobTitle, candidateSkills);
      }
    } catch (err) {
      // Catch exceptions thrown during Gemini generation and record error message string.
      warnings.push(`Error generating referral for ${app.id}: ${err instanceof Error ? err.message : String(err)}`);
      // Construct deterministic fallback referral draft on exception.
      referralDraft = buildFallbackReferralDraft(companyName, jobTitle, candidateSkills);
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
        // Assign acting agent identity 'screener'.
        agent: "screener" as AgentName,
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

  // Check if valid telemetry run identifier exists for this invocation.
  // Updates agent_runs table with completed execution metrics.
  if (runId) {
    // Update agent_runs table record status to 'succeeded' and record execution metrics.
    await db
      // Target agent_runs table for status update.
      .from("agent_runs")
      // Update status to succeeded and attach row counts and Gemini call metrics.
      .update({
        status: "succeeded",
        finished_at: new Date().toISOString(),
        rows_in: apps.length,
        rows_out: generatedCount,
        error_count: failedCount,
        gemini_calls: geminiCalls,
      })
      // Match specific run identifier.
      .eq("id", runId);
  }

  // Return HTTP 200 OK JSON response summarizing referral outreach runner execution metrics.
  // Returns summary dictionary object to caller.
  return jsonResponse(200, {
    // Set execution success flag boolean to true.
    success: true,
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
});
