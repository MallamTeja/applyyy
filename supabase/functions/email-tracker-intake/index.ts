// POST /functions/v1/email-tracker-intake
//
// The publicly reachable webhook endpoint for receiving Google Apps Script email intake.
// Google Apps Script runs inside Google's infrastructure as Teja and cannot mint a Supabase JWT,
// so this function is deployed with `verify_jwt = false` and defends itself with a shared secret
// (see `_shared/intake/auth.ts` for detailed authentication mechanisms).
//
// WHAT THIS EDGE FUNCTION DOES:
// 1. Authenticates incoming HTTP webhook POST requests via a shared secret header.
// 2. Validates wire contract and batch constraints against byte limits.
// 3. Classifies email responses using `_shared/email/` parser and classifier modules.
// 4. Matches incoming emails against active user applications in the database.
// 5. Advances application workflow status using `advance_application_status` RPC when valid.
// 6. Stores classified email event records in `email_events` idempotently.
//
// STATUS CODES RETURNED TO APPS SCRIPT:
//   202  accepted and processed (or duplicates) — mark threads processed
//   400  malformed body — DO NOT RETRY, error is permanent
//   401  bad/absent secret — DO NOT RETRY, configuration error
//   405  wrong HTTP method — DO NOT RETRY, verb rejected
//   413  payload too large — split batch into smaller chunks and retry
//   500  server fault — retry on next 15-minute trigger cycle

// RLS-bound client factory for user-authenticated database access.
// Import function to construct client bound by user credentials.
import { createAppUserClient } from "../_shared/db/client.ts";
// Shared-secret authentication helper and environment variable constants.
// Import authentication function and environment variable names.
import { authenticateIntake, INTAKE_SECRET_ENV_VAR, INTAKE_SECRET_HEADER } from "../_shared/intake/auth.ts";
// Wire-contract validator and maximum body payload byte size ceiling.
// Import byte limits and validator function.
import { MAX_BODY_BYTES, validateIntakeBody, type IntakeMessage } from "../_shared/intake/email-contract.ts";
// Database row insert shapes for email events and enum types.
// Import type shapes for email events and application workflow statuses.
import type { EmailEventInsert, EmailClassification, ApplicationStatus } from "../_shared/contracts/shared-types.ts";
// Legal status transition checker enforcing status transition graph rules.
// Import status transition verification helper function.
import { canTransition } from "../_shared/contracts/shared-types.ts";
// Pure email parser module for structural feature extraction and auto-reply detection.
// Import pure email parsing helper module.
import { parseEmail } from "../_shared/email/parser.ts";
// Pure email outcome classifier engine for decision rule evaluation.
// Import pure outcome classification engine.
import { classifyEmail, type OutcomeClassification } from "../_shared/email/classifier.ts";

// Central helper function to emit standard JSON responses with explicit headers.
//
// WHY CENTRALIZED RESPONSE CREATION MATTERS:
// Guarantees consistent application/json content-type headers and UTF-8 charset encoding
// across all handler execution paths so Google Apps Script parses errors correctly.
function json(status: number, body: Record<string, unknown>): Response {
  // Serialize body payload object to formatted JSON string.
  // JSON string serialization ensures standard payload format.
  const responseText = JSON.stringify(body);
  // Define HTTP headers specifying content-type and UTF-8 charset.
  // Set content-type header for application/json UTF-8.
  const responseHeaders = { "content-type": "application/json; charset=utf-8" };
  // Construct and return standard web API Response object.
  // Instantiate Web API Response object with status and headers.
  return new Response(responseText, {
    // Pass HTTP status code parameter.
    // HTTP response status code instruction.
    status,
    // Pass explicit response headers object.
    // Header record defining content type and encoding.
    headers: responseHeaders,
  });
}

// Interface representing an active application record queried for email matching.
//
// WHY THIS INTERFACE IS ISOLATED:
// Provides explicit typing for active application rows queried from PostgREST joins.
interface ActiveApplication {
  // Unique application primary key UUID string.
  // Primary key UUID identifier for the application.
  readonly id: string;
  // Current workflow status of the candidate application.
  // Current application status enum value.
  readonly status: ApplicationStatus;
  // Foreign key reference to associated job record.
  // Foreign key pointing to the jobs table row.
  readonly job_id: string;
  // Joined job record fields containing target company metadata.
  // Nested object containing joined job metadata.
  readonly jobs: {
    // Raw company display name from job posting.
    // Display name of the employer company.
    readonly company_name: string;
    // Lowercase normalized company slug used for heuristic matching.
    // Normalized URL-safe slug for the company.
    readonly company_slug: string;
  } | null;
}

// Map classified outcome verdict to legal database `EmailClassification` enum string.
//
// WHY MAPPING IS MANDATORY:
// Transforms pure classification engine outcome codes into database column enum values.
function mapOutcomeToClassification(
  outcomeResult: OutcomeClassification,
  isAutoReply: boolean,
): EmailClassification {
  // Check if email was identified as automated receipt or out-of-office response.
  // Test auto-reply boolean flag.
  if (isAutoReply) {
    // Return receipt status classification enum value.
    // Map auto reply to application received.
    return "application_received";
  }

  // Check for explicit interviewing outcome verdict from classifier engine.
  // Test if outcome is interviewing.
  if (outcomeResult.outcome === "interviewing") {
    // Return interview invitation classification enum value.
    // Map interviewing to interview invite.
    return "interview_invite";
  }

  // Check for explicit rejection outcome verdict from classifier engine.
  // Test if outcome is rejected.
  if (outcomeResult.outcome === "rejected") {
    // Return rejection classification enum value.
    // Map rejected to rejection.
    return "rejection";
  }

  // Check for employer screening outcome verdict from classifier engine.
  // Test if outcome is employer screening.
  if (outcomeResult.outcome === "employer_screening") {
    // Inspect matched signal tags to detect online technical assessment invitations.
    // Search matched signals array for technical test keywords.
    const isOnlineAssessment = outcomeResult.matchedSignals.some(
      // Test signal tag string for assessment platform keywords.
      // Arrow function evaluating signal tag string.
      (signal: string) =>
        // Check for assessment keyword.
        // Match assessment keyword.
        signal.includes("assessment") ||
        // Check for technical keyword.
        // Match technical keyword.
        signal.includes("technical") ||
        // Check for CodeSignal platform keyword.
        // Match CodeSignal platform keyword.
        signal.includes("codesignal") ||
        // Check for HackerRank platform keyword.
        // Match HackerRank platform keyword.
        signal.includes("hackerrank") ||
        // Check for platform keyword.
        // Match platform keyword.
        signal.includes("platform"),
    );
    // If online technical test detected, return oa_invite; otherwise return recruiter_outreach.
    // Select appropriate classification enum based on boolean check.
    return isOnlineAssessment ? "oa_invite" : "recruiter_outreach";
  }

  // Return unclassified fallback enum value for unknown or ambiguous outcomes.
  // Default fallback classification.
  return "unclassified";
}

// Map database `EmailClassification` enum value to target `ApplicationStatus`.
//
// WHY TARGET STATUS MAPPING IS ISOLATED:
// Isolates workflow state selection rules for advancing application status.
function mapClassificationToTargetStatus(
  classification: EmailClassification,
): ApplicationStatus | null {
  // Evaluate classification category using switch statement.
  // Switch over input classification enum string.
  switch (classification) {
    // Interview invitation classification advances workflow to interview status.
    // Case for interview invitation email.
    case "interview_invite":
      // Return interview status enum value.
      // Target state is interview.
      return "interview";
    // Online assessment invitation classification advances workflow to oa_pending status.
    // Case for online assessment invitation email.
    case "oa_invite":
      // Return oa_pending status enum value.
      // Target state is oa_pending.
      return "oa_pending";
    // Rejection notification classification advances workflow to rejected status.
    // Case for rejection email.
    case "rejection":
      // Return rejected status enum value.
      // Target state is rejected.
      return "rejected";
    // Recruiter outreach classification advances workflow to employer_screening status.
    // Case for recruiter outreach email.
    case "recruiter_outreach":
    // Application receipt confirmation classification advances workflow to employer_screening status.
    // Case for application receipt email.
    case "application_received":
      // Return employer_screening status enum value.
      // Target state is employer_screening.
      return "employer_screening";
    // Job offer notification classification advances workflow to offer status.
    // Case for job offer email.
    case "offer":
      // Return offer status enum value.
      // Target state is offer.
      return "offer";
    // Unclassified or unrecognized emails do not trigger status transition.
    // Default case for unhandled classifications.
    default:
      // Return null when no transition target applies.
      // Null signifies no status change.
      return null;
  }
}

// Find matching active application for an incoming email message.
//
// WHY MATCHING ALGORITHM USES DOMAIN AND SLUG HEURISTICS:
// Matches incoming emails by comparing extracted sender domains and text snippets
// against normalized company names and slugs in active job applications.
function findMatchingApplication(
  message: IntakeMessage,
  senderDomain: string | null,
  activeApplications: readonly ActiveApplication[],
): ActiveApplication | null {
  // Extract domain name prefix if sender domain is present (e.g., 'stripe.com' -> 'stripe').
  // Split sender domain by dot to isolate sub-domain or company prefix.
  const domainPrefix = senderDomain ? senderDomain.split(".")[0]?.toLowerCase() : null;
  // Convert email sender address to lowercase string.
  // Lowercase normalized sender email address.
  const senderLower = message.from.toLowerCase();
  // Convert email subject line to lowercase string.
  // Lowercase normalized email subject line.
  const subjectLower = message.subject.toLowerCase();
  // Convert email message snippet to lowercase string.
  // Lowercase normalized email snippet text.
  const snippetLower = message.snippet.toLowerCase();

  // Loop through available active candidate applications.
  // Iterate over active applications array with index loop.
  for (let i = 0; i < activeApplications.length; i += 1) {
    // Reference application item by index.
    // Fetch application item at index i.
    const app = activeApplications[i]!;
    // Skip application record if joined job properties are missing.
    // Check if joined job record exists.
    if (!app.jobs) continue;

    // Normalize target company slug string to lowercase.
    // Extract lowercased company slug.
    const compSlug = app.jobs.company_slug.toLowerCase();
    // Normalize target company display name string to lowercase.
    // Extract lowercased company display name.
    const compName = app.jobs.company_name.toLowerCase();

    // Strategy 1: Match sender domain prefix against company slug when both strings meet minimum length.
    // Evaluate domain prefix length and company slug length preconditions.
    if (domainPrefix && domainPrefix.length >= 3 && compSlug.length >= 3) {
      // Check for exact match or mutual string inclusion between domain prefix and company slug.
      // Compare domain prefix against company slug for substring equality.
      if (domainPrefix === compSlug || domainPrefix.includes(compSlug) || compSlug.includes(domainPrefix)) {
        // Return matching application instance.
        // Return successfully matched application.
        return app;
      }
    }

    // Strategy 2: Check if target company name appears inside email sender, subject, or snippet.
    // Check company name length precondition.
    if (compName.length >= 3) {
      // Test sender header, subject line, or message body snippet for company name string.
      // Search for company name in sender, subject, or snippet.
      if (senderLower.includes(compName) || subjectLower.includes(compName) || snippetLower.includes(compName)) {
        // Return matching application instance.
        // Return successfully matched application.
        return app;
      }
    }

    // Strategy 3: Check if target company slug appears inside email sender, subject, or snippet.
    // Check company slug length precondition.
    if (compSlug.length >= 3) {
      // Test sender header, subject line, or message body snippet for company slug string.
      // Search for company slug in sender, subject, or snippet.
      if (senderLower.includes(compSlug) || subjectLower.includes(compSlug) || snippetLower.includes(compSlug)) {
        // Return matching application instance.
        // Return successfully matched application.
        return app;
      }
    }
  }

  // Return null when no matching application passes criteria.
  // Default return when no match is found.
  return null;
}

// Main Edge Function HTTP server entry point registered with `Deno.serve`.
Deno.serve(async (request: Request): Promise<Response> => {
  // Validate HTTP method before performing any expensive operations.
  // Verify request HTTP method is POST.
  if (request.method !== "POST") {
    // Return 405 Method Not Allowed response for non-POST HTTP verbs.
    // Emit method not allowed JSON response.
    return json(405, { error: "method not allowed" });
  }

  // Extract shared intake secret header value from request headers.
  // Read intake secret header from HTTP request headers.
  const headerSecret = request.headers.get(INTAKE_SECRET_HEADER);
  // Extract configured intake secret environment variable value.
  // Read expected secret from process environment variables.
  const envSecret = Deno.env.get(INTAKE_SECRET_ENV_VAR);
  // Perform constant-time shared secret authentication check.
  // Execute constant-time string comparison authentication check.
  const auth = authenticateIntake(headerSecret, envSecret);
  // Check if authentication failed.
  // Test authentication success flag.
  if (!auth.ok) {
    // Log authentication failure message to server logs for debugging.
    // Write error message to console error log.
    console.error(`[email-tracker-intake] auth refused: ${auth.reason}`);
    // Determine user-facing error message based on status code.
    // Select appropriate error message string.
    const errorMessage = auth.status === 401 ? "unauthorized" : "server misconfigured";
    // Return authentication error response.
    // Emit HTTP error status response.
    return json(auth.status, { error: errorMessage });
  }

  // Declare string variable to hold raw request body text.
  // Variable to store raw request payload text.
  let bodyText: string;
  // Wrap body reading in try-catch block to handle network transport truncation errors.
  // Try block for async body reading.
  try {
    // Read raw body asynchronously as plain text.
    // Await text body extraction from HTTP request.
    bodyText = await request.text();
  } catch (cause) {
    // Log body reading exception details to server logs.
    // Log exception error to console.
    console.error(`[email-tracker-intake] could not read body: ${String(cause)}`);
    // Return 400 Bad Request error response.
    // Emit bad request error JSON response.
    return json(400, { error: "could not read request body" });
  }

  // Encode raw body text to UTF-8 byte array and measure length.
  // Measure encoded byte length of payload text.
  const byteLength = new TextEncoder().encode(bodyText).length;

  // Validate wire payload structure and byte size against pure schema.
  // Run pure wire contract validator function over raw body.
  const validated = validateIntakeBody(bodyText, byteLength);
  // Check if payload validation failed.
  // Test validation result success flag.
  if (!validated.ok) {
    // Log payload rejection details to server logs.
    // Log validation failure to console error.
    console.error(`[email-tracker-intake] rejected body: ${validated.error}`);
    // Return payload error response along with maximum body size ceiling.
    // Emit validation error JSON response with byte limit details.
    return json(validated.status, {
      // Include specific validation error message.
      // Error message key.
      error: validated.error,
      // Repeat byte ceiling constant for client chunking logic.
      // Max body bytes ceiling key.
      max_body_bytes: MAX_BODY_BYTES,
    });
  }

  // Extract validated message batch and rejected message items.
  // Destructure batch payload object and rejected items.
  const { batch, rejected } = validated;

  // Check if message batch is empty (common periodic trigger check).
  // Test if message array length is zero.
  if (batch.messages.length === 0) {
    // Return 202 Accepted response immediately to avoid database roundtrip.
    // Emit 202 accepted response for empty batch.
    return json(202, { accepted: 0, duplicates: 0, rejected: rejected.length, batch_id: batch.batch_id });
  }

  // Initialize RLS-authenticated Supabase database client instance.
  // Create user-authenticated DB client instance.
  const client = await createAppUserClient();
  // Check if database client initialization failed.
  // Test client creation success flag.
  if (!client.ok) {
    // Log database connection failure details to server logs.
    // Log DB client failure to console error.
    console.error(`[email-tracker-intake] database unavailable: ${client.reason}`);
    // Return 500 Internal Server Error response.
    // Emit internal server error response.
    return json(500, { error: "storage unavailable" });
  }

  // Declare mutable array to hold active user applications for email matching.
  // Mutable array for storing queried applications.
  let activeApplications: ActiveApplication[] = [];
  // Wrap database query in try-catch block for safe execution.
  // Try block around database query execution.
  try {
    // Query active application rows joined with associated job company details.
    // Execute Supabase PostgREST query on applications table.
    const { data: appsData, error: appsError } = await client.db
      .from("applications")
      .select("id, status, job_id, jobs(company_name, company_slug)")
      .in("status", ["applied", "employer_screening", "oa_pending", "interview"]);

    // Check if query returned an error object.
    // Test if query returned error.
    if (appsError !== null) {
      // Log application query error details to server logs.
      // Log query error to console.
      console.error(`[email-tracker-intake] applications fetch error: ${appsError.message}`);
    } else if (appsData !== null) {
      // Cast and assign queried application rows to local active applications array.
      // Assign queried data array to activeApplications variable.
      activeApplications = appsData as unknown as ActiveApplication[];
    }
  } catch (err) {
    // Log unexpected query exception to server logs.
    // Log unexpected query exception to console.
    console.error(`[email-tracker-intake] applications query exception: ${String(err)}`);
  }

  // Generate ISO-8601 timestamp string for record processing timestamp field.
  // Current ISO-8601 timestamp string.
  const processedAtTimestamp = new Date().toISOString();

  // Create array to hold prepared database insert objects for `email_events`.
  // Array storing prepared DB insert records.
  const rowsToInsert: (EmailEventInsert & Record<string, unknown>)[] = [];

  // Loop over each intake message in the validated batch payload.
  // Iterate through batch messages with index loop.
  for (let i = 0; i < batch.messages.length; i += 1) {
    // Access current message item from batch array.
    // Reference current message in loop iteration.
    const message = batch.messages[i]!;

    // Parse email headers, subject line, and snippet into structured features.
    // Run pure parser over current message fields.
    const parsed = parseEmail({
      // Pass raw email subject.
      // Raw subject input string.
      subject: message.subject,
      // Pass message snippet as body text.
      // Raw snippet body input string.
      body: message.snippet,
      // Pass sender header string.
      // Raw sender header input string.
      sender: message.from,
    });

    // Run pure outcome classification decision engine over parsed email features.
    // Classify parsed email features with pure classifier.
    const classificationResult = classifyEmail(parsed);

    // Map classifier outcome verdict to legal database `EmailClassification` enum string.
    // Map outcome code to DB classification enum value.
    const dbClassification = mapOutcomeToClassification(
      // Pass classification result object.
      // Pure classifier result.
      classificationResult,
      // Pass auto-reply flag.
      // Auto reply boolean indicator.
      parsed.isAutoReplyOrConfirmation,
    );

    // Attempt to locate matching active candidate application.
    // Find matching application record using heuristics.
    const matchedApp = findMatchingApplication(
      // Pass current intake message.
      // Current message payload.
      message,
      // Pass extracted company sender domain string.
      // Extracted sender domain.
      parsed.extractedCompanyDomain,
      // Pass active applications array.
      // Active applications pool.
      activeApplications,
    );

    // Declare mutable variable to hold matched application UUID string or null.
    // ID variable for matched application.
    let matchedApplicationId: string | null = null;

    // Check if a matching application record was found.
    // Test if matching application instance is non-null.
    if (matchedApp !== null) {
      // Set matched application ID value.
      // Store matched application ID.
      matchedApplicationId = matchedApp.id;

      // Map email classification to target application workflow status.
      // Calculate target application workflow status.
      const targetStatus = mapClassificationToTargetStatus(dbClassification);

      // Verify that target status exists and transition is permitted for 'tracker' agent.
      // Check target status and transition graph legality.
      if (targetStatus !== null && canTransition(matchedApp.status, targetStatus, "tracker")) {
        // Execute status transition via `advance_application_status` database RPC.
        // Call advance_application_status database RPC.
        const { error: transitionError } = await client.db.rpc("advance_application_status", {
          // Pass target application UUID.
          // Application ID parameter.
          p_application_id: matchedApp.id,
          // Pass destination status enum string.
          // Target status parameter.
          p_to_status: targetStatus,
          // Pass acting agent name.
          // Acting agent parameter.
          p_agent: "tracker",
          // Pass structured event detail payload.
          // Detail payload parameter.
          p_detail: {
            // Record provider message ID.
            // Message ID in detail.
            provider_message_id: message.message_id,
            // Record database classification string.
            // Classification enum in detail.
            classification: dbClassification,
            // Record classification confidence score.
            // Confidence score in detail.
            confidence: classificationResult.confidence,
            // Record array of matched signal tags.
            // Matched signals array in detail.
            matched_signals: classificationResult.matchedSignals,
            // Record human-readable reasoning text.
            // Reasoning text in detail.
            reasoning: classificationResult.reasoning,
          },
        });

        // Check if transition RPC returned an error.
        // Test RPC error result.
        if (transitionError !== null) {
          // Log status advancement failure details to server logs.
          // Log RPC failure to console error.
          console.error(
            `[email-tracker-intake] advance status failed for app ${matchedApp.id}: ${transitionError.message}`,
          );
        } else {
          // Log successful status advancement to server logs.
          // Log successful RPC execution to console info.
          console.info(
            `[email-tracker-intake] advanced app ${matchedApp.id} from ${matchedApp.status} to ${targetStatus}`,
          );
        }
      }
    }

    // Push prepared email event row to insert list.
    // Append database insert row object to rows array.
    rowsToInsert.push({
      // Set provider message ID deduplication key.
      // Provider message ID column.
      provider_message_id: message.message_id,
      // Set sender address string.
      // From address column.
      from_address: message.from,
      // Set subject line string.
      // Subject column.
      subject: message.subject,
      // Set snippet text string.
      // Snippet column.
      snippet: message.snippet,
      // Set message received timestamp.
      // Received at column.
      received_at: message.received_at,
      // Set calculated email classification enum value.
      // Classification column.
      classification: dbClassification,
      // Set classification confidence numerical score.
      // Confidence score column.
      classification_confidence: classificationResult.confidence,
      // Set matched application ID or null.
      // Matched application ID column.
      matched_application_id: matchedApplicationId,
      // Set processing completion timestamp string.
      // Processed at timestamp column.
      processed_at: processedAtTimestamp,
    });
  }

  // Perform idempotent batch upsert of email event rows into `email_events` table.
  // Execute Supabase upsert query on email_events table.
  const { data: inserted, error: insertError } = await client.db
    .from("email_events")
    .upsert(rowsToInsert, {
      // Specify composite constraint key for deduplication.
      // On conflict column constraint.
      onConflict: "user_id,provider_message_id",
      // Ignore duplicate inserts to prevent re-processing existing messages.
      // Ignore duplicates flag.
      ignoreDuplicates: true,
    })
    .select("provider_message_id");

  // Check if database upsert operation returned an error.
  // Test if insert query returned error.
  if (insertError !== null) {
    // Log database insert failure details to server logs.
    // Log database insert error to console.
    console.error(`[email-tracker-intake] insert failed: ${insertError.message}`);
    // Return 500 Internal Server Error response.
    // Emit internal server error JSON response.
    return json(500, { error: "storage failed" });
  }

  // Calculate count of newly inserted email event rows.
  // Compute accepted inserted row count.
  const acceptedCount = (inserted ?? []).length;
  // Calculate count of duplicate messages by subtraction from batch total.
  // Compute duplicate message count.
  const duplicateCount = batch.messages.length - acceptedCount;

  // Return 202 Accepted response containing processing execution stats.
  // Emit final 202 accepted success response.
  return json(202, {
    // Count of accepted new rows.
    // Accepted count field.
    accepted: acceptedCount,
    // Count of ignored duplicate messages.
    // Duplicates count field.
    duplicates: duplicateCount,
    // Count of rejected malformed items.
    // Rejected count field.
    rejected: rejected.length,
    // Array of rejection reason objects.
    // Rejected details array field.
    rejected_detail: rejected,
    // Echoed batch tracking identifier.
    // Batch ID field.
    batch_id: batch.batch_id,
  });
});
