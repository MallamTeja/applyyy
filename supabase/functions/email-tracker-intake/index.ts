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

//
// ORDER OF OPERATIONS (changed 2026-10-04):
//   classify + match every message -> upsert `email_events` (dedup) -> transition ONLY the
//   messages that upsert newly inserted, oldest first.
// The old order transitioned before the dedup upsert, so Apps Script re-sending a batch
// (it does, after any 5xx or timeout) replayed old emails against current statuses — an
// OA invite from last week could walk `interview -> oa_pending`, a legal machine edge.
// Classification, matching and the status mapping live in `./decide.ts` so they are tested.

// RLS-bound client factory for user-authenticated database access.
// Import function to construct client bound by user credentials.
import { APP_USER_EMAIL_ENV_VAR, createAppUserClient } from "../_shared/db/client.ts";
// Shared-secret authentication helper and environment variable constants.
// Import authentication function and environment variable names.
import { authenticateIntake, INTAKE_SECRET_ENV_VAR, INTAKE_SECRET_HEADER } from "../_shared/intake/auth.ts";
// Wire-contract validator and maximum body payload byte size ceiling.
// Import byte limits and validator function.
import { MAX_BODY_BYTES, validateIntakeBody, type IntakeMessage } from "../_shared/intake/email-contract.ts";
// Database row insert shape and the status enum type.
// The insert shape keeps the upsert payload checked against the schema owner's type.
import type { EmailEventInsert, ApplicationStatus } from "../_shared/contracts/shared-types.ts";
// Pure decisions: classification, status mapping, and the one-match-or-none matcher.
// Separate module so `node --test` can exercise them without Deno or a database.
import {
  CONFIRMABLE_STATUSES,
  addressedTo,
  classifyMessage,
  matchApplication,
  receiptConfirmsApplied,
  statusMoveFor,
  titleNamedIn,
  verifyReceiptSender,
  type ActiveApplication,
  type MessageDecision,
} from "./decide.ts";

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

// One message after classification and matching, held until the dedup upsert says whether
// it is new.
interface DecidedMessage {
  // The wire message, for the event row and the transition detail.
  readonly message: IntakeMessage;
  // Classification verdict.
  readonly decision: MessageDecision;
  // The single matched application, or null (none, or ambiguous).
  readonly matchedApplicationId: string | null;
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

  // Applications the tracker may move, with the job fields matching reads.
  // A failed read FAILS THE BATCH: storing every message unmatched would mark the threads
  // processed in Gmail and the outcomes would never be applied. A 500 makes Apps Script
  // retry the whole batch on its next trigger, and the dedup below keeps that safe.
  let activeApplications: ActiveApplication[];
  // Each row's updated_at, so a receipt confirmation can refuse if the row moved meanwhile.
  const updatedAtById = new Map<string, string>();
  // Exceptions from the client are treated the same as an error result.
  try {
    // Statuses an employer email can still move. `applying` and `needs_verification` are
    // here so a verified receipt can confirm a submit (receiptConfirmsApplied); they are
    // also match candidates, so a receipt that names two rows of one company stays ambiguous.
    const { data: appsData, error: appsError } = await client.db
      .from("applications")
      // `title` is read only by the receipt confirmation (titleNamedIn).
      .select("id, status, job_id, updated_at, jobs(company_name, company_slug, title)")
      .in("status", ["applying", "needs_verification", "applied", "employer_screening", "oa_pending", "interview"]);
    // An error result is a failed batch.
    if (appsError !== null) {
      // The detail goes to the log, not to the caller.
      console.error(`[email-tracker-intake] applications fetch error: ${appsError.message}`);
      // 500 = retry on the next trigger cycle.
      return json(500, { error: "applications unavailable" });
    }
    // Null data with no error means zero rows.
    activeApplications = (appsData ?? []) as unknown as ActiveApplication[];
    // Remember each row's updated_at; a non-string one is simply not recorded, and the
    // confirmation then refuses (no stamp, no optimistic-concurrency guard, no move).
    for (const row of (appsData ?? []) as { id: string; updated_at?: unknown }[]) {
      if (typeof row.updated_at === "string") updatedAtById.set(row.id, row.updated_at);
    }
  } catch (err) {
    // Same handling as an error result.
    console.error(`[email-tracker-intake] applications query exception: ${String(err)}`);
    // 500 = retry.
    return json(500, { error: "applications unavailable" });
  }

  // One timestamp for the batch's `processed_at`.
  const processedAtTimestamp = new Date().toISOString();

  // Classify and match every message first; nothing is written yet.
  const decided: DecidedMessage[] = batch.messages.map((message) => {
    // Outcome first, out-of-office never advances, receipt only as a fallback.
    const decision = classifyMessage(message);
    // Only a receipt may land on a row the worker tried to submit; every other email is
    // matched against the post-apply statuses alone, exactly as before receipts could
    // confirm, so an interview email isn't made ambiguous by an unrelated submitting row.
    const pool = decision.classification === "application_received"
      ? activeApplications
      : activeApplications.filter((app) => !CONFIRMABLE_STATUSES.includes(app.status));
    // Exactly one application, or null for none/ambiguous.
    const matchedApplicationId = matchApplication(message, decision.senderDomain, pool);
    // Kept together until the upsert result is known.
    return { message, decision, matchedApplicationId };
  });

  // When each matched, confirmable row LAST entered `applying`, read BEFORE anything is
  // written: a failed read returns 500 and Apps Script retries the whole batch, whereas a
  // failure after the upsert would leave the receipt stored and never reconsidered.
  // "Last" because a row can re-enter applying (approved -> applying -> needs_verification
  // -> approved -> applying); a receipt must postdate the CURRENT attempt.
  const enteredApplyingAt = new Map<string, string>();
  // Only rows a receipt could confirm need the lookup.
  const confirmableIds = [...new Set(
    decided
      .map((d) => d.matchedApplicationId)
      .filter((id): id is string => id !== null)
      .filter((id) => {
        // The row's status as loaded above.
        const status = activeApplications.find((app) => app.id === id)?.status;
        return status !== undefined && CONFIRMABLE_STATUSES.includes(status);
      }),
  )];
  // Skip the round trip when no message touches a confirmable row.
  if (confirmableIds.length > 0) {
    // Exceptions are treated like an error result.
    try {
      // status_change rows are written by the log_status_change trigger, one per move.
      const { data: entries, error: entriesError } = await client.db
        .from("application_events")
        .select("application_id, created_at")
        .eq("event_type", "status_change")
        .eq("to_status", "applying")
        .in("application_id", confirmableIds)
        .order("created_at", { ascending: false });
      // A failed read fails the batch, before any write.
      if (entriesError !== null) {
        // Detail to the log.
        console.error(`[email-tracker-intake] applying-entry lookup error: ${entriesError.message}`);
        // 500 = retry, and nothing has been written yet.
        return json(500, { error: "application history unavailable" });
      }
      // Newest first, so the first row seen per application is its latest entry.
      for (const entry of (entries ?? []) as { application_id: unknown; created_at: unknown }[]) {
        // Shape-checked: a non-string field is not a timestamp.
        if (typeof entry.application_id !== "string" || typeof entry.created_at !== "string") continue;
        // Keep only the newest per application.
        if (!enteredApplyingAt.has(entry.application_id)) enteredApplyingAt.set(entry.application_id, entry.created_at);
      }
    } catch (err) {
      // Same handling as an error result.
      console.error(`[email-tracker-intake] applying-entry lookup exception: ${String(err)}`);
      // 500 = retry.
      return json(500, { error: "application history unavailable" });
    }
  }

  // Event rows for the upsert.
  const rowsToInsert: (EmailEventInsert & Record<string, unknown>)[] = decided.map(({ message, decision, matchedApplicationId }) => ({
    // Deduplication key, half of `(user_id, provider_message_id)`.
    provider_message_id: message.message_id,
    // Sender header.
    from_address: message.from,
    // Subject line.
    subject: message.subject,
    // Body excerpt.
    snippet: message.snippet,
    // When Gmail received it.
    received_at: message.received_at,
    // Verdict.
    classification: decision.classification,
    // Verdict confidence.
    classification_confidence: decision.confidence,
    // Null when unmatched or ambiguous; the message is still stored.
    matched_application_id: matchedApplicationId,
    // Processing time.
    processed_at: processedAtTimestamp,
  }));

  // DEDUP FIRST. `ignoreDuplicates` returns only rows actually inserted, which is exactly
  // the set of messages this endpoint has never acted on.
  const { data: inserted, error: insertError } = await client.db
    .from("email_events")
    .upsert(rowsToInsert, {
      // The table's unique key.
      onConflict: "user_id,provider_message_id",
      // Replays insert nothing and come back absent from `inserted`.
      ignoreDuplicates: true,
    })
    // The row id too, so a confirmation's event detail can name the exact email_events row.
    .select("id, provider_message_id");

  // A failed upsert means nothing was recorded and nothing should move.
  if (insertError !== null) {
    // Detail to the log.
    console.error(`[email-tracker-intake] insert failed: ${insertError.message}`);
    // 500 = retry; no transition has run yet, so the retry is clean.
    return json(500, { error: "storage failed" });
  }

  // Message ids that are new in this call.
  const newlyInserted = new Set((inserted ?? []).map((row: { provider_message_id: string }) => row.provider_message_id));
  // The stored email_events id per message, for the confirmation's evidence trail.
  const eventIdByMessage = new Map(
    (inserted ?? []).map((row: { id: string; provider_message_id: string }) => [row.provider_message_id, row.id] as const),
  );

  // Current status per application, updated as this batch moves them, so a second email
  // about the same application is checked against where the first one left it.
  const statusById = new Map<string, ApplicationStatus>(activeApplications.map((app) => [app.id, app.status]));

  // New, matched messages, oldest first: the order the employer sent them is the order
  // the application moved through its stages.
  const toTransition = decided
    .filter((d) => d.matchedApplicationId !== null && newlyInserted.has(d.message.message_id))
    .sort((a, b) => Date.parse(a.message.received_at) - Date.parse(b.message.received_at));

  // Transitions, one per qualifying message.
  for (const { message, decision, matchedApplicationId } of toTransition) {
    // Narrowed by the filter above.
    const applicationId = matchedApplicationId!;
    // Where the application is now, as far as this batch knows.
    const currentStatus = statusById.get(applicationId);
    // Unknown row: leave it.
    if (currentStatus === undefined) continue;
    // A row the worker tried to submit can ONLY be confirmed by a verified receipt; no other
    // email moves it (the graph has no other tracker edge out of these statuses anyway).
    const confirming = CONFIRMABLE_STATUSES.includes(currentStatus);
    // Gmail's verdict on the sender, computed only where it matters.
    const verification = confirming ? verifyReceiptSender(message.from, message.authentication_results) : null;
    // The receipt path decides `applied` or nothing; every other row uses the usual mapping.
    const targetStatus = confirming
      ? (receiptConfirmsApplied({
          // What the email is.
          decision,
          // Where the row is.
          current: currentStatus,
          // When Gmail received it.
          receivedAt: message.received_at,
          // When the row last entered applying (null: never, so refused).
          enteredApplyingAt: enteredApplyingAt.get(applicationId) ?? null,
          // Gmail's verdict.
          verification,
          // The email names THIS job's title, not just the company.
          titleMatches: titleNamedIn(message, activeApplications.find((app) => app.id === applicationId)?.jobs?.title),
          // The signed To names Teja (not a replay of someone else's receipt). The owner
          // is the app user the function signs in as; unset means nothing is confirmed.
          addressedToOwner: addressedTo(message.to, Deno.env.get(APP_USER_EMAIL_ENV_VAR)),
        })
          ? "applied"
          : null)
      // Target status after the graph check AND the confidence gate (see `statusMoveFor`);
      // a low-confidence verdict such as the 0.5-0.8 moderate-rejection band is stored
      // above but returns null here, so it moves nothing.
      : statusMoveFor(decision, currentStatus);
    // Nothing to do.
    if (targetStatus === null) continue;
    // A confirmation must not land on a row that changed since it was read (e.g. the worker
    // just wrote applied or failed): without a stamp it is refused rather than sent blind.
    const expectedUpdatedAt = confirming ? updatedAtById.get(applicationId) ?? null : null;
    if (confirming && expectedUpdatedAt === null) continue;
    // The only correct way to change status.
    const { error: transitionError } = await client.db.rpc("advance_application_status", {
      // Application UUID.
      p_application_id: applicationId,
      // Destination status.
      p_to_status: targetStatus,
      // Acting agent; the guard checks the edge allows it.
      p_agent: "tracker",
      // Evidence recorded with the transition.
      p_detail: {
        // Which email caused it.
        provider_message_id: message.message_id,
        // How it was read.
        classification: decision.classification,
        // With what confidence.
        confidence: decision.confidence,
        // On which signals.
        matched_signals: decision.matchedSignals,
        // In words.
        reasoning: decision.reasoning,
        // For a confirmation, the audit trail a human can check and reverse: the stored
        // email row, Gmail's verdict, and the two instants that were compared.
        ...(confirming
          ? {
              email_event_id: eventIdByMessage.get(message.message_id) ?? null,
              authentication: verification,
              received_at: message.received_at,
              entered_applying_at: enteredApplyingAt.get(applicationId) ?? null,
            }
          : {}),
      },
      // Optimistic concurrency for confirmations only (PT409 if the row moved meanwhile);
      // omitted for the other moves, exactly as before this change.
      ...(confirming ? { p_expected_updated_at: expectedUpdatedAt } : {}),
    });
    // A refused edge is logged; the email is already stored and matched.
    if (transitionError !== null) {
      // Detail to the log.
      console.error(`[email-tracker-intake] advance status failed for app ${applicationId}: ${transitionError.message}`);
    } else {
      // Later emails in this batch see the new status.
      statusById.set(applicationId, targetStatus);
      // Operational trace.
      console.info(`[email-tracker-intake] advanced app ${applicationId} from ${currentStatus} to ${targetStatus}`);
    }
  }

  // Count of newly stored rows.
  const acceptedCount = newlyInserted.size;
  // Everything else in the batch was already stored.
  const duplicateCount = batch.messages.length - acceptedCount;

  // 202 = processed; Apps Script marks the threads done.
  return json(202, {
    // New rows.
    accepted: acceptedCount,
    // Replays.
    duplicates: duplicateCount,
    // Malformed items rejected by the contract.
    rejected: rejected.length,
    // Why each was rejected.
    rejected_detail: rejected,
    // Echoed batch id.
    batch_id: batch.batch_id,
  });
});
