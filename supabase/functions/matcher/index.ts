// Matcher — Edge Function Entrypoint
//
// Reads `applications` sitting at status `passed_filters`, scores each against the pinned
// master resume snapshot through Gemini using `_shared/match/scorer.ts` and the LRU key pool,
// persists `match_score` and `match_reasoning` into `applications`, and advances application
// status to `scored`.
//
// ARCHITECTURAL DESIGN & INVARIANTS:
//
// 1. STATELESS DENO EDGE RUNTIME:
//    This edge function executes inside Deno isolates on Supabase Edge Functions. It signs in as
//    the ordinary authenticated application user via `createAppUserClient()`, enforcing RLS
//    policies on every database query.
//
// 2. PAYLOAD BEFORE STATUS TRANSITION ORDERING RULE:
//    Writing `match_score` and `match_reasoning` happens FIRST via a non-status update on `applications`.
//    Advancing the workflow status to `scored` happens SECOND via the `advance_application_status` RPC.
//    Advancing status without a payload written opens a race window where downstream agents see
//    an un-scored row sitting at `scored`.
//
// 3. KEY POOL FAILOVER AND PACING:
//    LLM calls are routed through `generateGeminiContent` from `_shared/gemini/client.ts`. This handles
//    atomic key claims from the Postgres key pool (`claimKey`), transparent HTTP 429 retries and key
//    rotation (`reportResult`), and deterministic token pacing (`GeminiPacer`).
//
// 4. GENERATOR / CRITIC SEPARATION & FENCED PROMPT ASSEMBLY:
//    The prompt is assembled via `createScorer` and `buildScorerPrompt`, placing untrusted job posting text
//    inside a fenced block (`<<<BEGIN_UNTRUSTED_JOB_POSTING>>>`) while candidate facts sit securely
//    in system instructions.
//
// 5. ATOMIC STATUS TRANSITION GUARD & AUDIT LOGGING:
//    Status updates use `advance_application_status`, which validates status graph transitions
//    against `application_status_transitions` table, sets `applyy.acting_agent = 'matcher'`, and logs
//    an append-only audit record in `application_events`.
//
// 6. HEALTH PAGE MONITORING & RUN TELEMETRY:
//    Every invocation registers an agent run row in `agent_runs` with agent name `'matcher'`,
//    recording `rows_in`, `rows_out`, `error_count`, and `gemini_calls` to avoid silent system halts.
//
// 7. DETERMINISTIC CONCURRENCY AND BATCHING:
//    Processing runs sequentially through the claimed batch to avoid racing concurrent calls against
//    the Gemini key pool rate limits.

// Import database client factory for authenticated app user credentials.
// Ensures that all queries run under row level security (RLS) policies.
import { createAppUserClient } from "../_shared/db/client.ts";
// Import Gemini API transport middleware with key pool failover and token pacer.
// Manages 429 retries, least-recently-used key rotation, and rate limiting.
import { generateGeminiContent } from "../_shared/gemini/client.ts";
// Import Matcher scorer factory and prompt definitions.
// Combines prompt formatting, candidate master profile context, and rubric scoring.
import { createScorer, type ScorerPrompt } from "../_shared/match/scorer.ts";
// Import EvalCase contract interface for scorer injection seam.
// Conforms to the standard evaluation case format used by evaluation gates.
import type { EvalCase } from "../_shared/eval/gate.ts";
// Import MasterProfile contract type for casting master profile JSONB.
// Guarantees type safety for candidate background structure.
import type { MasterProfile } from "../_shared/contracts/shared-types.ts";
// Caller auth and the fail-closed kill switch, shared by every pipeline agent.
// The matcher never checked the switch at all before this, so it spent Gemini quota
// with the system turned off.
import { authorizeCaller, readKillSwitch } from "../_shared/db/gates.ts";
// Shared CORS headers, plus the boundary that keeps them on an uncaught 500.
import { corsHeaders, withErrorBoundary } from "../_shared/cors.ts";
// The score threshold: decides advance (-> scored), drop (-> dropped_filter) or refuse. Pure,
// so its boundaries are table-tested in match/score-threshold.test.ts rather than only here.
import { decideScoreThreshold } from "../_shared/match/score-threshold.ts";
// Per-invocation deadline: plans each Gemini call from the time left and stops between rows.
import { createDeadline, deadlineNote, runBatchWithDeadline, shortenedBudgetNote, type CallOptions } from "../_shared/agent/deadline.ts";

// Default batch limit for one invocation to preserve key pool quota.
// Controls how many application rows are processed per function call.
const DEFAULT_BATCH_SIZE = 10;
// Maximum batch limit allowed per invocation to prevent quota exhaustion.
// Hard upper bound preventing callers from requesting unsustainable batch sizes.
const MAX_BATCH_SIZE = 25;

// Helper function to construct structured JSON HTTP responses.
// Encapsulates response creation with consistent headers and formatting.
function jsonResponse(
  // The HTTP response status code (e.g. 200, 409, 503).
  // Passed to Response constructor.
  status: number,
  // The data payload object to serialize into response body JSON.
  // Structured dictionary converted to JSON text.
  data: Record<string, unknown>,
): Response {
  // Return formatted Response object with JSON body string.
  return new Response(
    // Serialize data payload object to indented JSON string for human readability.
    // Pretty-printed JSON aids manual inspection and debugging.
    JSON.stringify(data, null, 2),
    // Response configuration options object.
    {
      // Assign HTTP status code to response object.
      status,
      // Merge content type header with UTF-8 charset and standard CORS headers.
      // Explicit charset prevents character encoding corruption on user text.
      headers: { "content-type": "application/json; charset=utf-8", ...corsHeaders },
    },
  );
}

// Parse and clamp raw limit query parameter string into valid batch size integer.
// Prevents invalid or negative input values from disrupting queue processing.
function resolveBatchSize(
  // The raw query parameter string extracted from request URL search parameters.
  // Null when query parameter was not provided by caller.
  raw: string | null,
): number {
  // If raw parameter is absent or null, return default batch size constant.
  if (raw === null) return DEFAULT_BATCH_SIZE;
  // Convert raw parameter string to numeric representation.
  const parsed = Number(raw);
  // Check if parsed number is a valid integer and strictly greater than zero.
  // Rejects zero, negative numbers, floats, and NaN strings.
  if (!Number.isInteger(parsed) || parsed < 1) return DEFAULT_BATCH_SIZE;
  // Return minimum of parsed integer value and maximum batch size ceiling limit.
  // Caps execution length to protect LLM quota pool.
  return Math.min(parsed, MAX_BATCH_SIZE);
}

// Register primary Deno HTTP server request listener callback.
// Serves incoming requests dispatched to the matcher edge function.
// Wrapped so a throw anywhere below still answers with CORS headers the browser can read.
Deno.serve(withErrorBoundary("applyy-matcher", async (req: Request): Promise<Response> => {
  // Started first so startup, auth and the queue read all count against the 150 s kill.
  const deadline = createDeadline();
  // Check if incoming request method is OPTIONS preflight request.
  // Handled early before authenticating or touching database resources.
  if (req.method === "OPTIONS") {
    // Return early HTTP 200 OK response carrying standard CORS headers.
    return new Response("ok", { headers: corsHeaders });
  }

  // Authenticate database connection using application user credentials from environment.
  // Signs in as ordinary Supabase auth user so RLS filters every query.
  const connection = await createAppUserClient();
  // Check if database client initialization or sign-in failed.
  // Handles missing env vars or authentication failures gracefully.
  if (!connection.ok) {
    // Log failure message to server console logs for debugging.
    // Logs details internally while returning generic error to client.
    console.error("[applyy-matcher] could not sign in:", connection.reason);
    // Return HTTP 503 Service Unavailable response to signal transient database failure.
    // Instructs callers to retry later rather than assuming permanent failure.
    return jsonResponse(503, { success: false, error: "database_unavailable" });
  }
  // Extract authenticated Supabase client instance from connection result object.
  // Ready to perform queries under active user session.
  const db = connection.db;

  // Refuse anyone but the app user BEFORE any write or any Gemini spend: the sign-in
  // above never looks at the caller, so the public anon key alone used to suffice.
  const caller = await authorizeCaller(req, db, connection.userId);
  // 401 for no/invalid session, 403 for someone else's — the verdict carries which.
  if (!caller.ok) return jsonResponse(caller.status, { success: false, error: caller.error });

  // Open an agent run tracking row in agent_runs table before executing work.
  // Ensures telemetry presence even if execution encounters unhandled crash.
  const { data: runRow } = await db
    // Target agent_runs table for run telemetry registration.
    .from("agent_runs")
    // Insert initial run row values with agent name 'matcher' and current timestamp.
    .insert({ agent: "matcher", status: "running", started_at: new Date().toISOString() })
    // Select generated unique identifier column from inserted row.
    .select("id")
    // Return single row object.
    .single();
  // Extract unique run identifier string from inserted row object if present.
  // Undefined if telemetry registration failed.
  const runId: string | undefined = runRow?.id;

  // Helper function to mark agent run as failed in database and return error response.
  // Consolidates error reporting and telemetry failure cleanup.
  async function failRun(
    // The HTTP status code to return in response.
    status: number,
    // The short error code string identifier.
    error: string,
    // Detailed error message text string for telemetry log.
    detail: string,
  ): Promise<Response> {
    // Check if valid agent run identifier exists for this invocation.
    if (runId) {
      // Update agent_runs table row status to 'failed'.
      await db
        // Target agent_runs table for run status update.
        .from("agent_runs")
        // Update status to 'failed', record completion timestamp and error detail text.
        .update({ status: "failed", finished_at: new Date().toISOString(), error_detail: detail })
        // Match specific run identifier.
        .eq("id", runId);
    }
    // Return formatted JSON response with error code and false success flag.
    return jsonResponse(status, { success: false, error });
  }

  // The shared fail-closed kill switch, checked before the master read and before any
  // model call — this agent is the first one that spends quota.
  const killSwitch = await readKillSwitch(db);
  // A failed read is an error, not a decision.
  if (killSwitch.kind === "unreadable") return await failRun(503, "kill_switch_read_failed", killSwitch.detail);
  // Off, or no settings row: record the skip so the health page can say why.
  if (killSwitch.kind === "disabled") {
    // Close the run row as a deliberate skip rather than leave it `running`.
    if (runId) {
      await db
        .from("agent_runs")
        .update({ status: "skipped_disabled", finished_at: new Date().toISOString(), error_detail: killSwitch.detail })
        .eq("id", runId);
    }
    // 200: the system did what it was told.
    return jsonResponse(200, { success: true, status: "skipped_disabled", detail: killSwitch.detail });
  }

  // Retrieve latest master profile snapshot row from master_profiles table.
  // Required to score candidate background against job posting requirements.
  const { data: masterRow, error: masterError } = await db
    // Target master_profiles table for profile retrieval.
    .from("master_profiles")
    // Select profile JSONB content and numeric version columns.
    .select("profile, version")
    // Order profiles by version descending to get highest version number first.
    .order("version", { ascending: false })
    // Limit query to single highest version row.
    .limit(1)
    // Execute query returning single row or null if table is empty.
    .maybeSingle();

  // Check if master profile query encountered database read error.
  if (masterError) {
    // Fail run with 503 error response detailing database query error message.
    return await failRun(503, "master_profile_unreadable", masterError.message);
  }
  // Check if master profile query returned empty result set.
  if (!masterRow) {
    // Fail run with 409 conflict error response indicating missing master profile.
    return await failRun(409, "no_master_profile", "master_profiles is empty");
  }

  // Cast retrieved raw profile JSONB payload to typed MasterProfile interface.
  // Converts raw JSON object into strongly typed candidate profile.
  const master = masterRow.profile as MasterProfile;
  // Extract numeric version pin from master profile row object.
  // Tracks master profile version used for scoring alignment.
  const masterVersion: number = masterRow.version;

  // Resolve batch size limit from URL search parameters limit parameter string.
  // Clamps batch size within safe operating bounds.
  const batchSize = resolveBatchSize(new URL(req.url).searchParams.get("limit"));

  // Query applications table for candidate applications sitting at status 'passed_filters'.
  // Fetches pending applications ready for Matcher LLM fit scoring.
  // Optional single-row target. Read from the URL so the CLI can push ONE application through
  // without waiting for it to reach the head of an oldest-first queue.
  const rawApplicationId = new URL(req.url).searchParams.get("application_id");
  // A malformed id is REFUSED, never ignored: ignoring it would fall back to the whole
  // queue and process rows the caller did not ask for (the fail-open this repo forbids).
  if (rawApplicationId !== null && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(rawApplicationId)) {
    // 400 with a named reason, so the caller sees what was wrong with the input.
    return await failRun(400, "invalid_application_id", "application_id must be a UUID");
  }
  // Null means "no target": the unchanged whole-queue behaviour.
  const applicationId: string | null = rawApplicationId;
  const { data: rows, error: rowsError } = await db
    // Target applications table for queue row lookup.
    .from("applications")
    // Select application ID and joined job details columns required by scorer.
    .select("id, job_id, jobs (title, company_name, description_raw, location_raw, min_experience_years, employment_type)")
    // Filter applications where status equals 'passed_filters'.
    .eq("status", "passed_filters")
    // Narrow to the one requested row; the status filter stays, so a wrong-status id yields
    // zero rows. An empty match object is a no-op when untargeted.
    .match(applicationId !== null ? { id: applicationId } : {})
    // Order applications by creation timestamp ascending for FIFO processing queue order.
    .order("created_at", { ascending: true })
    // Limit returned rows to calculated batch size ceiling.
    .limit(batchSize);

  // Check if applications queue query encountered database error.
  if (rowsError) {
    // Fail run with 503 error response detailing queue query failure.
    return await failRun(503, "queue_unreadable", rowsError.message);
  }

  // Serialize candidate master profile object to JSON string representation for prompt.
  // Prepares candidate background text for Gemini instruction block.
  const candidateProfileText = typeof master === "object" && master !== null ? JSON.stringify(master) : String(master);

  // The budget planned for the row in flight; set by the batch runner before each row and read
  // by callLlm below. Undefined until the first row, which falls back to the client defaults.
  let callBudget: CallOptions | undefined;
  // Initialize total Gemini API call execution count counter.
  // Tracks LLM calls for health monitoring and telemetry.
  let geminiCallsCount = 0;

  // Build Matcher scorer function instance with injected model caller seam.
  // Integrates prompt assembly, Gemini model transport, and fit rubric.
  const scorer = createScorer({
    // Supply serialized candidate master profile string to scorer dependencies.
    candidateProfile: candidateProfileText,
    // Supply pinned master profile version number to scorer dependencies.
    masterVersion,
    // Supply injected LLM caller function executing Gemini API calls with key pool.
    callLlm: async (prompt: ScorerPrompt) => {
      // Increment Gemini calls execution counter for telemetry tracking.
      geminiCallsCount += 1;
      // Execute Gemini API generateContent call using shared client with key failover and pacing.
      const outcome = await generateGeminiContent(db, {
        // Pass system instruction, user content, and JSON response schema prompt object.
        prompt: {
          systemInstruction: prompt.systemInstruction,
          userContent: prompt.userContent,
          responseSchema: prompt.responseSchema,
        },
        // Spread only when set: exactOptionalPropertyTypes forbids passing `undefined`.
        ...(callBudget ? { timeoutMs: callBudget.timeoutMs, maxRetries: callBudget.maxRetries } : {}),
      });
      // Check if Gemini API call execution or key claim failed.
      if (!outcome.ok) {
        // Throw Error object with detailed failure reason string to trigger retry branch.
        throw new Error(`gemini_call_failed: ${outcome.reason}`);
      }
      // Extract generated text string from first candidate part in API response payload.
      const text = outcome.data.candidates?.[0]?.content?.parts?.[0]?.text;
      // Validate that extracted text part is present and typed as string.
      if (typeof text !== "string") {
        // Throw Error object indicating model returned empty text response.
        throw new Error("gemini_returned_no_text");
      }
      // Return raw model output text string to scorer parser.
      return text;
    },
  });

  // Initialize successful scoring completion count accumulator.
  // Measures number of applications successfully scored and updated.
  let scoredCount = 0;
  // Rows below the threshold moved to dropped_filter. Kept apart from scoredCount so
  // rows_out still means "rows handed to the Tailor".
  let droppedCount = 0;
  // Initialize array holding individual application row processing failure records.
  // Captures per-row errors without halting whole batch execution.
  const failures: Array<{ applicationId: string; error: string }> = [];

  // Loop sequentially through each claimed application row retrieved from queue.
  // Sequentially executes scoring to prevent hitting LLM rate limits.
  // The deadline check lives in runBatchWithDeadline and runs only BETWEEN rows, so a row is
  // never stopped between its payload write and its status RPC. Unreached rows stay at
  // passed_filters and the next run picks them up; they are not failures.
  const batch = await runBatchWithDeadline(rows ?? [], async (row, call) => {
    // Hand this row's planned timeout/retries to callLlm through the closure above.
    callBudget = call;
      // Cast embedded job relation object to structured job fields interface.
      // Extracts job details parsed from joined database query.
      const job = row.jobs as unknown as {
        title?: string;
        company_name?: string;
        description_raw?: string | null;
        location_raw?: string | null;
        min_experience_years?: number | string | null;
        employment_type?: string;
      } | null;

      // Construct EvalCase input object matching eval gate interface for scorer.
      // Packages job metadata for prompt assembly and evaluation.
      const evalCase: EvalCase = {
        // Application row unique identifier string.
        id: row.id,
        // Construct frozen job snapshot object containing scraped job posting text.
        job_snapshot: {
          // Job title string fallback to empty string if missing.
          title: job?.title ?? "",
          // Company name string fallback to empty string if missing.
          company_name: job?.company_name ?? "",
          // Raw location string or null if unstated by board.
          location_raw: job?.location_raw ?? null,
          // Raw job description text string or null if unstated by board.
          description_raw: job?.description_raw ?? null,
          // Minimum experience years formatted as string or null.
          min_experience_years: job?.min_experience_years != null ? String(job.min_experience_years) : null,
          // Employment type string fallback to 'unknown'.
          employment_type: job?.employment_type ?? "unknown",
        },
        // Default eval label for injection seam compatibility.
        label: "good_fit",
        // Optional rationale string set to null.
        rationale: null,
        // Pinned master profile version number.
        master_version: masterVersion,
      };

      try {
        // Execute scoring logic against job snapshot using instantiated scorer function.
        // Evaluates technical, experience, behavioral, and career dimensions.
        const matchScore = await scorer(evalCase);

        // STEP 0: Gate the score BEFORE any write. An unreadable score (NaN, null, wrong scale)
        // FAILS CLOSED: nothing is written, the row stays at passed_filters, and the reason
        // lands in `failures` — never advanced, never dropped on a number that is not one.
        const threshold = decideScoreThreshold(matchScore.score);
        // The refusal branch: report it and move on to the next row.
        if (threshold.kind === "invalid") {
          // Counted as a failure so the run's error_count and error_detail show it.
          failures.push({ applicationId: row.id, error: threshold.reason });
          // No write and no status move for this row.
          return;
        }

        // STEP 1: Persist match_score and match_reasoning payload onto applications table row FIRST.
        // Enforces payload-before-status-transition rule to avoid orphaned statuses.
        const { error: patchError } = await db
          // Target applications table for payload update.
          .from("applications")
          // Update numeric match_score and text match_reasoning columns.
          .update({
            match_score: matchScore.score,
            match_reasoning: matchScore.reasoning,
            // The drop reason rides in the SAME write as the score, as persistScreenVerdict
            // does it: a dropped row always says why. CLEARED (null, not omitted) on advance:
            // if an earlier run wrote a drop and its RPC then failed, a retry that now scores
            // >= the floor would otherwise leave that stale reason on a `scored` row.
            drop_reason: threshold.kind === "drop" ? threshold.reason : null,
          })
          // Match specific application row identifier.
          .eq("id", row.id);

        // Check if application payload database update encountered error.
        if (patchError) {
          // Push error details to failures array and skip status transition.
          failures.push({ applicationId: row.id, error: patchError.message });
          // Continue loop to next application row without advancing status.
          return;
        }

        // STEP 2: Move the row via advance_application_status RPC SECOND — to 'scored' on advance,
        // to 'dropped_filter' below the threshold. Both edges allow the matcher (live, 2026-10-05).
        const { error: advanceError } = await db.rpc("advance_application_status", {
          // Target application row identifier parameter.
          p_application_id: row.id,
          // The threshold's verdict decides the edge; there is no third value by construction.
          p_to_status: threshold.kind === "advance" ? "scored" : "dropped_filter",
          // Acting agent name parameter set to 'matcher'.
          p_agent: "matcher",
          // Event detail JSONB parameter carrying score and reasoning details.
          p_detail: {
            score: matchScore.score,
            reasoning: matchScore.reasoning,
            // The band, so the event log shows WHERE the score fell, not just the number.
            band: threshold.band,
            // Present only on a drop, mirroring the drop_reason column.
            ...(threshold.kind === "drop" ? { reason: threshold.reason } : {}),
          },
        });

        // Check if advance_application_status RPC execution returned error.
        if (advanceError) {
          // Push status transition failure details to failures array.
          failures.push({ applicationId: row.id, error: advanceError.message });
          // Continue loop to next application row.
          return;
        }

        // Counted separately: a drop is a SUCCESSFUL outcome (the row moved), not an error.
        if (threshold.kind === "drop") droppedCount += 1;
        // Advanced rows are the ones the Tailor will pick up.
        else scoredCount += 1;
      } catch (err) {
        // Catch exceptions thrown during scoring or database writes and record error message.
        // Prevents single row exception from crashing batch run.
        failures.push({
          // Target application ID string.
          applicationId: row.id,
          // Extract error message string from Error object or stringify unknown error.
          // Tagged when the deadline cut this row's Gemini budget, so a deadline-caused timeout
          // is distinguishable from a real model timeout.
          error: (err instanceof Error ? err.message : String(err)) + shortenedBudgetNote(call),
        });
      }
  }, { deadline, targeted: applicationId !== null });

  // HONEST FINAL STATUS. `failed` when there was work, none of it moved, and errors
  // explain why: the live matcher run seen 2026-10-04 (rows_in 10, rows_out 0,
  // error_count 10) was stamped `succeeded`, the silent stop agent_runs exists to catch.
  // Mixed results stay `succeeded` with error_count set: `agent_run_status` has no
  // `partial` (enums.sql:190), and an empty queue (rows_in 0) is idle, not broken.
  // A batch where every row was DROPPED moved every row, so it counts as progress, not failure.
  const runStatus = (rows ?? []).length > 0 && scoredCount + droppedCount === 0 && failures.length > 0 ? "failed" : "succeeded";
  // The first few DISTINCT reasons, capped: ten rows failing the same way is one fact,
  // and error_detail is a health-page line, not a log. This is the FAILURE half only; a
  // deadline stop adds its own note below, so error_detail can be non-null with error_count 0.
  const failureDetail = failures.length > 0
    // Set dedupes, slice(0, 3) keeps it short, slice(0, 500) bounds a pathological message.
    ? [...new Set(failures.map((f) => f.error))].slice(0, 3).join(" | ").slice(0, 500)
    : null;
  // An early stop is reported next to any failures, never as one: skipped rows are untouched.
  const stopNote = deadlineNote(batch);
  // Joined so neither hides the other. Null only when there were no failures AND no stop, so a
  // stale reason never sits beside a clean run. A stop alone gives status `succeeded`,
  // error_count 0 and a `deadline:` note: that prefix is how the health page tells it apart.
  const errorDetail = [failureDetail, stopNote].filter((x) => x !== null).join(" | ") || null;

  // Check if valid agent run identifier exists for this execution.
  if (runId) {
    // Close the run with the honest status computed above and its throughput numbers.
    await db
      // Target agent_runs table for run status update.
      .from("agent_runs")
      // Status, finished timestamp, counters and the error_detail text.
      .update({
        // Derived from the counters, never hard-coded: see runStatus above.
        status: runStatus,
        // Failure reasons plus, on an early stop, the `deadline:` note (see errorDetail above).
        error_detail: errorDetail,
        finished_at: new Date().toISOString(),
        rows_in: (rows ?? []).length,
        rows_out: scoredCount,
        error_count: failures.length,
        gemini_calls: geminiCallsCount,
      })
      // Match specific run identifier.
      .eq("id", runId);
  }

  // Return HTTP 200 OK JSON response containing run outcome summary metrics.
  // Summarizes processed applications, scores, and any errors.
  return jsonResponse(200, {
    // The function ran to completion. Kept true so pipelineRunner still classifies from
    // the counters below instead of a bare "success: false" message.
    success: true,
    // The same status written to agent_runs, so the dashboard and health page agree.
    status: runStatus,
    // The same failure reasons and deadline note, so the operator sees them without a DB query.
    error_detail: errorDetail,
    // Master profile version pinned for this run.
    master_version: masterVersion,
    // Count of input application rows fetched from queue.
    rows_in: (rows ?? []).length,
    // Only present on a targeted run, so the untargeted response shape is unchanged. `found: 0`
    // says "that id is not at this agent's input status", which an empty queue never could.
    ...(applicationId !== null ? { targeted: true, found: (rows ?? []).length } : {}),
    // Count of successfully scored applications.
    scored: scoredCount,
    // Count dropped below the threshold, so the caller sees the gate working.
    dropped: droppedCount,
    // Total count of Gemini API calls executed.
    gemini_calls: geminiCallsCount,
    // Array of individual application row failure objects.
    failures,
  });
}));
