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
//
// CHANGED 2026-11-01 (W6): the transition step above now makes receipt confirmations only.
// Every outcome-email move then goes through the REPLAY SWEEP (`./replay.ts`), on every
// run including the empty-batch heartbeat: stored, matched emails with no tracker note for
// their message id are owed, and are re-driven oldest first. The 2026-10-04 guarantee is
// kept by `replayQueue`: an email older than one the tracker already moved its row on, or
// older than a human's stage move, is stale and never replayed. Refused moves are counted
// on the run row (error_count), so Health stops showing green; the batch still gets 202.

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
  emailEventRowOf,
  mayAdvanceStatus,
  classifyMessage,
  // Tracked rows first, then match-only rows (2026-11-05).
  matchTrackedFirst,
  // The pool index.ts loads: tracked + match-only.
  MATCH_POOL_STATUSES,
  receiptConfirmsApplied,
  titleNamedIn,
  verifyReceiptSender,
  type ActiveApplication,
  type MessageDecision,
} from "./decide.ts";
// The replay sweep (W6, 2026-11-01): every outcome-email move, fresh or owed, goes through it.
// Its own module so node --test can drive it; this file calls Deno.serve on import.
import { replayStoredMoves } from "./replay.ts";

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

  // The client is created BEFORE the empty-batch exit (moved 2026-10-23): an empty batch
  // is the Apps Script HEARTBEAT, and recording it is the entire point — the health
  // page's tracker row stayed `never_run` forever because this function wrote no
  // agent_runs row, so a dead trigger and a quiet mailbox looked identical (the 0-emails-
  // since-2026-09-11 incident).
  const client = await createAppUserClient();
  // Check if database client initialization failed.
  if (!client.ok) {
    // Log database connection failure details to server logs.
    console.error(`[email-tracker-intake] database unavailable: ${client.reason}`);
    // 500 also for a heartbeat: a check-in that cannot land must not claim success.
    return json(500, { error: "storage unavailable" });
  }

  // THE TRACKER'S RUN ROW, opened as 'running' before any work (repo convention,
  // supporting_tables.sql: a crash leaves a visible stuck run, which the reaper closes).
  // rows_in = messages received this call; a heartbeat records 0.
  const { data: runRow, error: runOpenError } = await client.db
    .from("agent_runs")
    .insert({ agent: "tracker", rows_in: batch.messages.length })
    .select("id")
    .single();
  // Observability must never fail the batch: a failed open is logged and skipped.
  if (runOpenError !== null) console.error(`[email-tracker-intake] agent_runs open failed: ${runOpenError.message}`);
  // Null when the open failed; every close below then no-ops.
  const runId: string | null = runRow?.id ?? null;
  // Close the run row. Called before every exit after this point; never throws.
  // errorCount (W6, 2026-11-01): a succeeded batch can still carry refused or skipped moves;
  // Health renders status succeeded + error_count > 0 as "succeeded with N errors".
  // Defaults to the old rule (1 for a failed run, none otherwise) so every older call is unchanged.
  const closeRun = async (status: "succeeded" | "failed", rowsOut: number, errorDetail: string | null, errorCount = status === "failed" ? 1 : 0): Promise<void> => {
    // No row to close (open failed): nothing to do.
    if (runId === null) return;
    // One update carries the verdict; error_count 1 on failure feeds the health page.
    const { error } = await client.db
      .from("agent_runs")
      .update({
        status,
        finished_at: new Date().toISOString(),
        rows_out: rowsOut,
        // Written only when there is something to count; the column defaults to 0.
        ...(errorCount > 0 ? { error_count: errorCount } : {}),
        ...(errorDetail === null ? {} : { error_detail: errorDetail }),
      })
      .eq("id", runId);
    // Same rule as the open: log, never throw.
    if (error !== null) console.error(`[email-tracker-intake] agent_runs close failed: ${error.message}`);
  };

  // KILL SWITCH (2026-10-23): this function stores intel unconditionally (the events are
  // append-only), but a status MOVE needs the switch readable and on — the tracker was the
  // one status-writing agent that never consulted it. A closure since W6 (2026-11-01): the
  // heartbeat and the batch path both read it, because both now run the replay sweep.
  // Returns true/false from a real row, or null (fail closed) on any error or no row.
  const readSystemEnabled = async (): Promise<boolean | null> => {
    // Exceptions are treated like an error result: null, which fails closed.
    try {
      // The same single-row settings read scout-ats makes.
      const { data: settingsRow, error: settingsError } = await client.db
        .from("system_settings")
        .select("system_enabled")
        .limit(1)
        .single();
      // An error (including no row) stays null; only a real row can say true.
      return settingsError !== null ? null : (settingsRow as { system_enabled?: unknown } | null)?.system_enabled === true;
    } catch (err) {
      // Same fail-closed handling as an error result; detail to the log.
      console.error(`[email-tracker-intake] kill switch read exception: ${String(err)}`);
      return null;
    }
  };

  // Check if message batch is empty: the heartbeat case, common by design (the trigger
  // fires every 15 minutes whether or not mail arrived; since 2026-10-23 the script
  // POSTs the empty batch instead of skipping, so this run row IS the liveness signal).
  if (batch.messages.length === 0) {
    // W6 (2026-11-01): the heartbeat also re-drives owed moves. Without this, a move paused
    // by the kill switch would wait for the next email to arrive, which may never come.
    const replay = await replayStoredMoves(client.db, await readSystemEnabled(), new Map());
    // A recorded heartbeat is a succeeded run that stored nothing; replay errors are counted
    // on it (the first five in the detail), so a refused move can't hide behind a heartbeat.
    await closeRun("succeeded", 0, replay.errors.length > 0 ? replay.errors.slice(0, 5).join("; ") : null, replay.errors.length);
    // 202 as before; Apps Script treats anything else as transient failure.
    return json(202, { accepted: 0, duplicates: 0, rejected: rejected.length, batch_id: batch.batch_id });
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
    // Statuses an employer email can still move, PLUS `needs_verification`, which no email
    // may move (human-only lane since 2026-10-23) but which must stay a MATCH CANDIDATE:
    // hidden from the matcher, its row would stop making a same-company receipt ambiguous,
    // and its late receipt could then confirm the WRONG applying row (security review,
    // 2026-10-23). The move itself stays refused by CONFIRMABLE_STATUSES and the graph.
    // The list is decide.ts's TRACKED_STATUSES (2026-11-01), shared with the replay sweep; since 2026-11-05
    // MATCH_POOL_STATUSES adds the match-only rows (approved, awaiting_approval, blocked_needs_human), which
    // an email may link but never move (statusMoveFor refuses them).
    const { data: appsData, error: appsError } = await client.db
      .from("applications")
      // `title` is read by the receipt confirmation and, since W7, by the matcher's tiebreak (titleNamedIn).
      .select("id, status, job_id, updated_at, jobs(company_name, company_slug, title)")
      .in("status", [...MATCH_POOL_STATUSES]);
    // An error result is a failed batch.
    if (appsError !== null) {
      // The detail goes to the log, not to the caller.
      console.error(`[email-tracker-intake] applications fetch error: ${appsError.message}`);
      // The run row says why nothing landed.
      await closeRun("failed", 0, `applications fetch error: ${appsError.message}`);
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
    // Recorded like the error result above.
    await closeRun("failed", 0, `applications query exception: ${String(err)}`);
    // 500 = retry.
    return json(500, { error: "applications unavailable" });
  }

  // One timestamp for the batch's `processed_at`.
  const processedAtTimestamp = new Date().toISOString();

  // Classify and match every message first; nothing is written yet.
  const decided: DecidedMessage[] = batch.messages.map((message) => {
    // Outcome first, out-of-office never advances, receipt only as a fallback.
    const decision = classifyMessage(message);
    // The pool rule used to live in decide.ts (matchPoolFor) so it was node-tested: receipts
    // saw every row (a needs_verification sibling can force ambiguity), everything else only
    // post-submit rows. The 2026-10-23 wrong-row regression was an inline filter here.
    // Since W6 (2026-11-01) EVERY email sees every loaded row (TRACKED_STATUSES, tested), so
    // an outcome email for a row awaiting a human check is stored matched and the replay
    // applies it later; see the TRACKED_STATUSES comment for the trade-off.
    // Exactly one application, or null for none/ambiguous.
    const matchedApplicationId = matchTrackedFirst(message, decision.senderDomain, activeApplications);
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
        // The run row says why nothing landed.
        await closeRun("failed", 0, `applying-entry lookup error: ${entriesError.message}`);
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
      // Recorded like the error result above.
      await closeRun("failed", 0, `applying-entry lookup exception: ${String(err)}`);
      // 500 = retry.
      return json(500, { error: "application history unavailable" });
    }
  }

  // Event rows for the upsert. Built by the pure, node-tested mapper (decide.ts): the
  // inline map it replaces silently dropped thread_id for two weeks because no test
  // could see it (2026-10-23).
  const rowsToInsert: (EmailEventInsert & Record<string, unknown>)[] = decided.map(({ message, decision, matchedApplicationId }) =>
    emailEventRowOf(message, decision, matchedApplicationId, processedAtTimestamp)
  );

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
    // The run row says why nothing landed.
    await closeRun("failed", 0, `email_events upsert failed: ${insertError.message}`);
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

  // KILL SWITCH (2026-10-23): this function stores intel unconditionally (the events are
  // append-only and already written above), but a status MOVE needs the switch readable
  // and on — the tracker was the one status-writing agent that never consulted it.
  // Read on EVERY batch since W6 (2026-11-01), not only when this batch has new matches:
  // the replay sweep below may owe moves from earlier calls. See readSystemEnabled.
  const systemEnabled = await readSystemEnabled();
  // The verdict, pure and node-tested (decide.ts). Off or unreadable: skip every move,
  // still 202 — the emails ARE stored, and Apps Script must not redeliver the batch.
  const advancesPermitted = mayAdvanceStatus(systemEnabled);
  // Operational trace of what the switch suppressed, so a quiet day is distinguishable
  // from a halted one in the function logs.
  if (!advancesPermitted && toTransition.length > 0) console.warn(`[email-tracker-intake] kill switch off or unreadable: ${toTransition.length} candidate transition(s) skipped`);

  // Every refused move this call, for the run row (W6): a refusal used to be a log line only,
  // and the run still closed green.
  const moveErrors: string[] = [];

  // Transitions, one per qualifying message — none while the kill switch refuses.
  // Since W6 (2026-11-01) this loop makes RECEIPT CONFIRMATIONS only (applying -> applied).
  // Outcome-email moves all go through the replay sweep below, fresh or owed alike: one path,
  // one staleness rule, and no second attempt in the same call when the first is refused.
  // Receipts stay here because they need wire-only fields (authentication_results, To) that
  // email_events does not store, so they cannot be replayed.
  for (const { message, decision, matchedApplicationId } of advancesPermitted ? toTransition : []) {
    // Narrowed by the filter above.
    const applicationId = matchedApplicationId!;
    // Where the application is now, as far as this batch knows.
    const currentStatus = statusById.get(applicationId);
    // Unknown row: leave it.
    if (currentStatus === undefined) continue;
    // A row the worker tried to submit can ONLY be confirmed by a verified receipt; no other
    // email moves it (the graph has no other tracker edge out of these statuses anyway).
    const confirming = CONFIRMABLE_STATUSES.includes(currentStatus);
    // Every other row's move is the replay sweep's (W6); an outcome email on an applying row
    // is stored matched and waits there until the row leaves the submit lane.
    if (!confirming) continue;
    // Gmail's verdict on the sender, computed only where it matters.
    const verification = verifyReceiptSender(message.from, message.authentication_results);
    // The receipt path decides `applied` or nothing.
    const targetStatus = receiptConfirmsApplied({
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
      : null;
    // (The non-receipt branch that stood here — statusMoveFor, with its graph check and
    // confidence gate that keep the 0.5-0.8 moderate-rejection band from moving anything —
    // now runs in replay.ts, unchanged.)
    // Nothing to do.
    if (targetStatus === null) continue;
    // A confirmation must not land on a row that changed since it was read (e.g. the worker
    // just wrote applied or failed): without a stamp it is refused rather than sent blind.
    const expectedUpdatedAt = updatedAtById.get(applicationId) ?? null;
    if (expectedUpdatedAt === null) continue;
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
        // (Every move here is a confirmation since W6, so the old `confirming ?` guard went.)
        email_event_id: eventIdByMessage.get(message.message_id) ?? null,
        // Gmail's verdict.
        authentication: verification,
        // When Gmail received the receipt.
        received_at: message.received_at,
        // When the row last entered applying.
        entered_applying_at: enteredApplyingAt.get(applicationId) ?? null,
      },
      // Optimistic concurrency for confirmations (PT409 if the row moved meanwhile).
      p_expected_updated_at: expectedUpdatedAt,
    });
    // A refused edge is logged AND counted on the run (W6); the email is already stored
    // and matched. Receipts are not replayed (wire-only fields), so this is its record.
    if (transitionError !== null) {
      // Detail to the log.
      console.error(`[email-tracker-intake] advance status failed for app ${applicationId}: ${transitionError.message}`);
      // And to the run row, so Health shows "succeeded with N errors".
      moveErrors.push(`confirm ${applicationId} ${currentStatus}->applied failed: ${transitionError.message}`);
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

  // THE REPLAY SWEEP (W6, 2026-11-01): every owed outcome-email move, this batch's new ones
  // included, oldest first, after the receipts above so a row just confirmed to applied is
  // seen there. Off or unreadable switch: no moves (unreadable is counted as an error).
  // This call's verdicts ride along so fresh moves keep their classifier signals and reasoning.
  const liveDecisions = new Map(
    // Only rows this call stored; a duplicate's verdict was already recorded the first time.
    decided.filter((d) => newlyInserted.has(d.message.message_id)).map((d) => [d.message.message_id, d.decision] as const),
  );
  // Never throws; returns its own errors.
  const replay = await replayStoredMoves(client.db, systemEnabled, liveDecisions);
  // Receipt refusals first, then the sweep's.
  const runErrors = [...moveErrors, ...replay.errors];

  // The batch landed: rows_out = newly stored events (duplicates moved nothing new).
  // Still 202 below even with errors: the emails ARE stored, and an owed move is retried by
  // the next run's sweep, so Apps Script must not redeliver the batch. The first five errors
  // go in the detail; the count is exact.
  await closeRun("succeeded", acceptedCount, runErrors.length > 0 ? runErrors.slice(0, 5).join("; ") : null, runErrors.length);

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
