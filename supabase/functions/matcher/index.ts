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
//    the ordinary authenticated application user via `createAuthorizedAppUserClient(req)` (W15:
//    the caller is verified before that sign-in), enforcing RLS
//    policies on every database query.
//
// 2. PAYLOAD BEFORE STATUS TRANSITION ORDERING RULE:
//    Writing `match_score` and `match_reasoning` happens FIRST via a non-status update on `applications`.
//    Advancing the workflow status to `scored` happens SECOND via the `advance_application_status` RPC.
//    Advancing status without a payload written opens a race window where downstream agents see
//    an un-scored row sitting at `scored`. Both steps are guarded against a duplicate run
//    (write-score.ts): the write only while the row is at passed_filters, the move only while
//    updated_at is still the stamp our own write produced.
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
import { createAuthorizedAppUserClient } from "../_shared/db/client.ts";
// Import Gemini API transport middleware with key pool failover and token pacer.
// Manages 429 retries, least-recently-used key rotation, and rate limiting.
import { generateGeminiContent } from "../_shared/gemini/client.ts";
// The response's top-level `reason` (2026-11-07): why a targeted run found nothing, or that Gemini rate-limited.
import { matcherRunReason } from "./run-reason.ts";
// One failure line for every Gemini caller: reason, HTTP status, short redacted detail.
import { formatGeminiFailure } from "../_shared/gemini/failure-message.ts";
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
// The shared `?application_id=` parser, so all five pipeline agents refuse a bad id identically.
// parseUuidParam is the same rule, reused for the sweep's after_id cursor.
import { parseApplicationIdParam, parseUuidParam } from "../_shared/http/application-id.ts";
// The score threshold: decides advance (-> scored), drop (-> dropped_filter) or refuse. Pure,
// so its boundaries are table-tested in match/score-threshold.test.ts rather than only here.
import { decideScoreThreshold, isHumanPicked } from "../_shared/match/score-threshold.ts";
// Per-invocation deadline: plans each Gemini call from the time left and stops between rows.
import { createDeadline, deadlineNote, runBatchWithDeadline, shortenedBudgetNote, type CallOptions } from "../_shared/agent/deadline.ts";
// The status-guarded score write and the stamp-guarded status move; extracted so both guards
// are unit-tested (write-score.test.ts).
import { advanceScoredRow, writeMatchScore } from "./write-score.ts";
// The permanent-failure exit (W2, 2026-11-01): the usable-job gate before Gemini, and the
// settle step for answers that could not be read.
import { settleModelFailures, withUsableJob, type MatcherFailureReason, type ModelAnswerFailure, type SettleClient } from "./fail-exit.ts";
// Stage 0 re-applied before scoring, so a row the screener would now drop costs no Gemini call.
import { nextSweepCursor, parseMatcherMode, PREGATE_ONLY_MAX_BATCH, selectScorer, withTechPreGate, type MatcherMode } from "./tech-pregate.ts";
// The one loader of the gate config (search_preferences + experience_ceiling), shared with the auditor.
import { loadPreGatePreferences, type ConfigReader } from "../_shared/pregate-config-loader.ts";

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
  // The ceiling for this run: MAX_BATCH_SIZE when scoring, higher for a Gemini-free sweep.
  max: number = MAX_BATCH_SIZE,
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
  return Math.min(parsed, max);
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
  const connection = await createAuthorizedAppUserClient(req);
  // W15 (2026-11-05): a refused caller (no token, the public anon key, another user) is answered HERE,
  // before any password grant was spent on Teja's account; same status and body as the caller check below.
  if (!connection.ok && connection.kind === "refused") return jsonResponse(connection.status, { success: false, error: connection.error });
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

  // Kept as a second check (defense in depth, 2026-11-05): the caller was already verified BEFORE
  // the sign-in (createAuthorizedAppUserClient, W15). This re-checks the session against the signed-in
  // user's id with one token lookup, never a password grant.
  const caller = await authorizeCaller(req, db, connection.userId);
  // 401 for no/invalid session, 403 for someone else's — the verdict carries which.
  if (!caller.ok) return jsonResponse(caller.status, { success: false, error: caller.error });

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

  // `?mode=pregate_only`: the one-off Gemini-free sweep (Teja, 2026-10-09). Parsed and
  // refused here, before the run row, like application_id: a typo must neither leave a
  // failed run behind nor fall back to a normal run that spends Gemini quota.
  const parsedMode = parseMatcherMode(new URL(req.url).searchParams);
  // Unknown mode: refused with a named reason.
  if (parsedMode.kind === "invalid") {
    // Same 400 shape as the application_id refusal above.
    return jsonResponse(400, { success: false, error: "invalid_mode", detail: "mode must be absent or pregate_only" });
  }
  // Narrowed to the closed union.
  const mode: MatcherMode = parsedMode;
  // `?after_id=<uuid>`: the sweep's keyset cursor. Survivors stay at passed_filters, so an
  // oldest-first read would return the same survivors every run and never progress; paging
  // by id past the last row seen does. Same uuid rule as application_id.
  const cursor = parseUuidParam(new URL(req.url).searchParams, "after_id");
  // A malformed cursor is refused, never treated as "start from the beginning".
  if (cursor.kind === "invalid") {
    // Named, so the operator sees which parameter was wrong.
    return jsonResponse(400, { success: false, error: "invalid_after_id", detail: "after_id must be a UUID" });
  }
  // The cursor only means something to a sweep; a scoring run keeps its oldest-first queue.
  if (cursor.kind === "valid" && mode.kind !== "pregate_only") {
    // Refused rather than ignored: silently dropping a parameter the caller sent is a fail-open.
    return jsonResponse(400, { success: false, error: "after_id_requires_pregate_only", detail: "after_id is only valid with mode=pregate_only" });
  }
  // Null on the first page of a sweep.
  const afterId: string | null = cursor.kind === "valid" ? cursor.id : null;

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

  // The user's CURRENT gate config, for the pre-gate below (Teja, 2026-10-09): search_preferences
  // plus the enabled experience_ceiling rule, through the ONE loader the auditor calls too, so the
  // two stages cannot read the same config differently. RLS scopes both reads to this user.
  // The cast: checking supabase-js's deeply generic builder against ConfigReader's self-chaining
  // `eq` overflows the compiler (TS2589), as in the auditor.
  const gateConfig = await loadPreGatePreferences(db as unknown as ConfigReader);
  // A FAILED read stops the run before any Gemini call. Reading it as "no config" would
  // turn an error into an answer: an empty config passes everything to scoring. Same 503 shape
  // as the master-profile read above, with the loader's code (preferences_unreadable or
  // filter_rules_unreadable).
  if (gateConfig.kind === "error") return await failRun(503, gateConfig.code, gateConfig.message);
  // Every field the three gates read, mapped by the screener's own shape checks.
  const preGatePreferences = gateConfig.preferences;

  // Resolve batch size limit from URL search parameters limit parameter string.
  // Clamps batch size within safe operating bounds.
  // A sweep makes no Gemini call per row, so it may take a far larger page than scoring may.
  const batchSize = resolveBatchSize(
    new URL(req.url).searchParams.get("limit"),
    // 500 for the Gemini-free sweep; the unchanged 25 when scoring.
    mode.kind === "pregate_only" ? PREGATE_ONLY_MAX_BATCH : MAX_BATCH_SIZE,
  );

  // `applicationId` was parsed and validated above, before the run row was opened.
  // Query applications table for candidate applications sitting at status 'passed_filters'.
  // Fetches pending applications ready for Matcher LLM fit scoring.
  const { data: rows, error: rowsError } = await db
    // Target applications table for queue row lookup.
    .from("applications")
    // Select application ID and joined job details columns required by scorer.
    // discovered_via (2026-10-31): a 'manual' entry marks a human-pasted job, which skips the
    // pre-gate and the score floor (isHumanPicked).
    // jobs!inner + disappeared_at (W2, 2026-11-01), the tailor's own select shape: `!inner` makes
    // the .is() below drop the ROW, where a plain embed would only null it and the dead job's
    // application would still arrive. disappeared_at is also what the usable-job gate's verdict
    // (planTailorBatch) reads; without the column every row is a reported defect, never scored.
    .select("id, job_id, jobs!inner (title, company_name, description_raw, location_raw, min_experience_years, employment_type, discovered_via, disappeared_at)")
    // SKIPPED, NOT FAILED: a posting scout-ats saw drop off its board. planReappearances clears
    // disappeared_at on a repost and the row rejoins this queue untouched; failing it would make
    // that impossible. Filtered here, not per row, so 21 dead rows (2026-11-01) cannot fill the
    // head of the oldest-first batch.
    .is("jobs.disappeared_at", null)
    // Filter applications where status equals 'passed_filters'.
    .eq("status", "passed_filters")
    // Narrow to the one requested row; the status filter stays, so a wrong-status id yields
    // zero rows. An empty match object is a no-op when untargeted.
    .match(applicationId !== null ? { id: applicationId } : {})
    // The sweep's keyset cursor: only ids after the last one a previous page saw. The nil
    // uuid on a first page (and on every scoring run) is below every real v4 id, so the
    // filter is then always true; one chain instead of two, which keeps tsc off TS2589.
    .gt("id", afterId ?? "00000000-0000-0000-0000-000000000000")
    // Scoring: oldest first (FIFO). Sweep: by id, the order the cursor pages in.
    .order(mode.kind === "pregate_only" ? "id" : "created_at", { ascending: true })
    // Limit returned rows to calculated batch size ceiling.
    .limit(batchSize);

  // Check if applications queue query encountered database error.
  if (rowsError) {
    // Fail run with 503 error response detailing queue query failure.
    return await failRun(503, "queue_unreadable", rowsError.message);
  }

  /* WHY A TARGETED RUN FOUND NOTHING (2026-11-07, for the response's `reason`): one extra read, only when a
     targeted run selected 0 rows, of the row's status and whether its job left the board. undefined when
     the read fails, so an unknown is never reported as "not found" (CLAUDE.md §6). */
  const targetLookup = applicationId !== null && (rows ?? []).length === 0
    ? await db.from("applications").select("status, jobs (disappeared_at)").eq("id", applicationId).maybeSingle()
    : null;
  // The lookup as matcherRunReason reads it: the row, null for "no such row", undefined for "not read".
  const targetRow = targetLookup === null || targetLookup.error
    ? undefined
    : targetLookup.data === null
      ? null
      // disappeared_at set on the embedded job means the posting left its board.
      : { status: String((targetLookup.data as { status: unknown }).status), disappeared: ((targetLookup.data as { jobs: { disappeared_at?: unknown } | null }).jobs?.disappeared_at ?? null) !== null };

  // Serialize candidate master profile object to JSON string representation for prompt.
  // Prepares candidate background text for Gemini instruction block.
  const candidateProfileText = typeof master === "object" && master !== null ? JSON.stringify(master) : String(master);

  // The budget planned for the row in flight; set by the batch runner before each row and read
  // by callLlm below. Undefined until the first row, which falls back to the client defaults.
  let callBudget: CallOptions | undefined;
  // Initialize total Gemini API call execution count counter.
  // Tracks LLM calls for health monitoring and telemetry.
  let geminiCallsCount = 0;
  // What the model gave for the row in flight (W2): "no_text" when it answered with no text,
  // "text" once the scorer holds its text. Reset per row beside callBudget and cleared when the
  // scorer returns, so a throw is classed as an unreadable ANSWER only between those points,
  // never for a transport failure (still null) or a later DB throw (cleared).
  let modelAnswer: "no_text" | "text" | null = null;

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
        // Reason AND status AND a capped, key-redacted detail, so the run's error_detail can
        // tell a 400 from an all-keys-rejected 403 from a non-JSON 200 (all "http_error").
        throw new Error(formatGeminiFailure(outcome));
      }
      // Extract generated text string from first candidate part in API response payload.
      const text = outcome.data.candidates?.[0]?.content?.parts?.[0]?.text;
      // Validate that extracted text part is present and typed as string.
      if (typeof text !== "string") {
        // The model answered and said nothing (a safety block): a property of this row's prompt.
        modelAnswer = "no_text";
        // Throw Error object indicating model returned empty text response.
        throw new Error("gemini_returned_no_text");
      }
      // From here until the scorer returns, a throw is the scorer refusing this text.
      modelAnswer = "text";
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
  // Rows another overlapping run took from us: moved off passed_filters before our score write
  // landed (step 1), or written after it so our stamped move was refused (step 2, PT409).
  // Neither scored nor failed by THIS run, so they get their own counter.
  let skippedStaleCount = 0;
  // Rows the pre-gate dropped before scoring (excluded term, no configured title/keyword matched,
  // and since 2026-11-04 work-auth and experience_ceiling too). Apart from droppedCount, which
  // counts score-floor drops that DID cost a call. Renamed from techGateDroppedCount on 11-04,
  // when it stopped meaning only the tech gate.
  let preGateDroppedCount = 0;
  // The same drops by drop_reason code, so a run summary says WHICH gate dropped them.
  const preGateDroppedByCode: Record<string, number> = {};
  // Sweep only: rows the gate passed and left at passed_filters for a later scoring run.
  let preGateSurvivorCount = 0;
  // Initialize array holding individual application row processing failure records.
  // Captures per-row errors without halting whole batch execution.
  const failures: Array<{ applicationId: string; error: string }> = [];
  // Reasons of the rows this run moved to failed (W2): progress, since each left the queue, and
  // reported as a note rather than an error, the same way pre-gate drops are.
  const failedReasons: MatcherFailureReason[] = [];
  // Rows whose model answer could not be read, held until the batch ends: settleModelFailures
  // fails them only if some other row in this run was read (see fail-exit.ts), and only on the
  // row's second strike in two separate runs; a first strike is recorded and retried.
  const heldModelFailures: ModelAnswerFailure[] = [];

  // Loop sequentially through each claimed application row retrieved from queue.
  // Sequentially executes scoring to prevent hitting LLM rate limits.
  // The deadline check lives in runBatchWithDeadline and runs only BETWEEN rows, so a row is
  // never stopped between its payload write and its status RPC. Unreached rows stay at
  // passed_filters and the next run picks them up; they are not failures.
  // The scorer below is wrapped by the pre-gate: it is reached ONLY for rows stage 0 lets
  // through, so a row the gate drops never gets a Gemini call (tech-pregate.test.ts proves
  // it with a spy). Rows the gate handles itself are counted in onGated.
  // OUTERMOST: the usable-job gate (W2). It runs before the tech pre-gate AND before the
  // human-pick bypass, because a pasted job with no description is refused by the tailor too.
  const batch = await runBatchWithDeadline(rows ?? [], withUsableJob(
    db,
    // Counted by kind, into the same places the pre-gate's outcomes land.
    (row, outcome) => {
      // Moved to failed: progress, with its reason kept for the note.
      if (outcome.kind === "failed") failedReasons.push(outcome.reason);
      // Another run got there first: the existing lost-race counter.
      else if (outcome.kind === "skipped_stale") skippedStaleCount += 1;
      // A select defect or a failed write: a row failure of this run.
      else failures.push({ applicationId: row.id, error: outcome.message });
    },
    withTechPreGate(
    db,
    // The config read above; re-judges the backlog against today's lists.
    preGatePreferences,
    // Title, body, location and stored years from the embedded job; null when the embed is
    // missing, so the pre-gate reports it instead of judging an empty title as "matched nothing".
    (row) => {
      // Same embedded-relation cast the scorer uses; the select at the batch query fetches all four.
      const job = row.jobs as unknown as {
        // The tech gate's main input.
        title?: string;
        // Read by all three stages (tech: first 300 chars; work-auth and experience: all of it).
        description_raw?: string | null;
        // The work-auth gate's main input.
        location_raw?: string | null;
        // Numeric arrives as a string from PostgREST; null on every live row today.
        min_experience_years?: number | string | null;
      } | null;
      // Missing data stays missing.
      if (job === null) return null;
      // The four fields the three stages read; absent keys are stated as null (missing).
      return {
        // An absent title is "", exactly as before 2026-11-04.
        title: job.title ?? "",
        // Absent body: the gates read nothing, which keeps the row.
        descriptionRaw: job.description_raw ?? null,
        // Absent location: the work-auth gate keeps the row (missing is never a drop).
        locationRaw: job.location_raw ?? null,
        // Absent years: the experience twin falls back to the JD parser.
        minExperienceYears: job.min_experience_years ?? null,
      };
    },
    // Counted by kind, so each lands in the same place a scorer outcome of that kind would.
    (row, outcome) => {
      // A pre-gate drop moved the row: progress, not failure.
      if (outcome.kind === "dropped") {
        // The total the workflows account with.
        preGateDroppedCount += 1;
        // And the breakdown by gate.
        preGateDroppedByCode[outcome.code] = (preGateDroppedByCode[outcome.code] ?? 0) + 1;
      }
      // Another run got there first: the existing lost-race counter.
      else if (outcome.kind === "skipped_stale") skippedStaleCount += 1;
      // A failed drop write: recorded like any other row failure.
      else failures.push({ applicationId: row.id, error: outcome.message });
    },
    // In a sweep, selectScorer returns a survivor counter that never reaches the scorer below,
    // so the sweep makes zero Gemini calls (tech-pregate.test.ts proves it with a spy).
    selectScorer(mode, async (row, call) => {
    // Hand this row's planned timeout/retries to callLlm through the closure above.
    callBudget = call;
    // No answer yet for this row; a previous row's state must not classify this row's throw.
    modelAnswer = null;
      // Cast embedded job relation object to structured job fields interface.
      // Extracts job details parsed from joined database query.
      const job = row.jobs as unknown as {
        title?: string;
        company_name?: string;
        description_raw?: string | null;
        location_raw?: string | null;
        min_experience_years?: number | string | null;
        employment_type?: string;
        // The human-pick marker; read through isHumanPicked, which shape-checks it.
        discovered_via?: unknown;
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
        // The scorer returned: any throw from here on is a write, not an unreadable answer.
        modelAnswer = null;

        // STEP 0: Gate the score BEFORE any write. An unreadable score (NaN, null, wrong scale)
        // FAILS CLOSED: nothing is written, the row stays at passed_filters, and the reason
        // lands in `failures` — never advanced, never dropped on a number that is not one.
        // A human-pasted job advances whatever its score; an unreadable score still fails closed.
        // W2 (2026-11-01): it is no longer retried forever. It is HELD, and settleModelFailures
        // fails it after the batch if another row's score was readable this run AND this row was
        // already unreadable in an earlier run (code-review #5: one bad answer is not the row).
        const threshold = decideScoreThreshold(matchScore.score, isHumanPicked(job?.discovered_via));
        // The refusal branch: report it and move on to the next row.
        if (threshold.kind === "invalid") {
          // Held, not written: the settle step decides whether it is this row's fault.
          heldModelFailures.push({ applicationId: row.id, reason: "unreadable_score", detail: threshold.reason });
          // No write and no status move for this row.
          return;
        }

        // STEP 1: Persist match_score and match_reasoning payload onto applications table row FIRST.
        // Enforces payload-before-status-transition rule to avoid orphaned statuses.
        // Guarded on status = passed_filters inside writeMatchScore, so a losing duplicate run
        // cannot overwrite a row a faster run already scored (see write-score.ts).
        const written = await writeMatchScore(db, row.id, {
          match_score: matchScore.score,
          match_reasoning: matchScore.reasoning,
          // The drop reason rides in the SAME write as the score, as persistScreenVerdict
          // does it: a dropped row always says why. CLEARED (null, not omitted) on advance:
          // if an earlier run wrote a drop and its RPC then failed, a retry that now scores
          // >= the floor would otherwise leave that stale reason on a `scored` row.
          drop_reason: threshold.kind === "drop" ? threshold.reason : null,
          // CLEARED for the same reason (W2): a failure write whose move then errored leaves its
          // failure_reason behind, and a retry that now scores must not carry it to `scored`.
          failure_reason: null,
        });

        // Check if application payload database update encountered error.
        if (written.kind === "error") {
          // Push error details to failures array and skip status transition.
          failures.push({ applicationId: row.id, error: written.message });
          // Continue loop to next application row without advancing status.
          return;
        }
        // Another run moved this row first: nothing was written, so there is nothing to
        // advance — calling the RPC would only fail on an illegal edge and read as an error.
        if (written.kind === "skipped_stale") {
          // Counted apart from failures: losing a race is expected, not broken.
          skippedStaleCount += 1;
          // No status move for a row that is no longer ours.
          return;
        }

        // STEP 2: Move the row via advance_application_status RPC SECOND — to 'scored' on advance,
        // to 'dropped_filter' below the threshold. Both edges allow the matcher (live, 2026-10-05).
        // Guarded by the stamp STEP 1 returned, so a duplicate run that wrote in between makes
        // this move refuse (PT409) instead of landing on that run's score (see write-score.ts).
        const moved = await advanceScoredRow(
          db,
          // Target application row.
          row.id,
          // The threshold's verdict decides the edge; there is no third value by construction.
          threshold.kind === "advance" ? "scored" : "dropped_filter",
          {
            score: matchScore.score,
            reasoning: matchScore.reasoning,
            // The band, so the event log shows WHERE the score fell, not just the number.
            band: threshold.band,
            // Present only on a drop, mirroring the drop_reason column.
            ...(threshold.kind === "drop" ? { reason: threshold.reason } : {}),
          },
          // The stamp of OUR write; only a row nobody has written since may be moved.
          written.updatedAt,
        );

        // Check if advance_application_status RPC execution returned a real error.
        if (moved.kind === "error") {
          // Push status transition failure details to failures array.
          failures.push({ applicationId: row.id, error: moved.message });
          // Continue loop to next application row.
          return;
        }
        // Another run wrote this row after us: its payload is the one in the row, so the move is
        // its to make. Counted with the step-1 skips — the same race, lost one step later.
        if (moved.kind === "skipped_stale") {
          // Expected under duplicate runs, so not a failure.
          skippedStaleCount += 1;
          // No status move for a row whose payload is no longer ours.
          return;
        }

        // Counted separately: a drop is a SUCCESSFUL outcome (the row moved), not an error.
        if (threshold.kind === "drop") droppedCount += 1;
        // Advanced rows are the ones the Tailor will pick up.
        else scoredCount += 1;
      } catch (err) {
        // Catch exceptions thrown during scoring or database writes and record error message.
        // Prevents single row exception from crashing batch run.
        // Extract error message string from Error object or stringify unknown error.
        // Tagged when the deadline cut this row's Gemini budget, so a deadline-caused timeout
        // is distinguishable from a real model timeout.
        const error = (err instanceof Error ? err.message : String(err)) + shortenedBudgetNote(call);
        // W2: the model answered, and its answer was empty or unreadable. The same prompt OFTEN
        // gets the same answer, but not always (LLM output varies), so it is held for the settle
        // step, which fails it only on a second strike in a later run.
        if (modelAnswer !== null) {
          // Named by what the model gave: nothing, or text the scorer refused.
          heldModelFailures.push({ applicationId: row.id, reason: modelAnswer === "no_text" ? "gemini_returned_no_text" : "unreadable_score", detail: error });
          // Not a failure of this row yet; the settle step decides.
          return;
        }
        // Transport, quota, timeout or a write: transient, so the row stays for the next run.
        failures.push({
          // Target application ID string.
          applicationId: row.id,
          // The message built above.
          error,
        });
      }
  }, () => {
    // Counted for the run summary; the row itself is not touched.
    preGateSurvivorCount += 1;
  }),
    // A human-pasted job is never judged by the title/keyword gate (job-link-intake).
    (row) => isHumanPicked((row.jobs as unknown as { discovered_via?: unknown } | null)?.discovered_via),
  )), { deadline, targeted: applicationId !== null });
  // W2: settle the held answer failures. Proven when this run read at least one model answer
  // (a score or a score-floor drop); pre-gate drops do not count, since they made no call.
  // Runs after the deadline check on purpose: at most one batch of rows, two round trips each,
  // plus one strike read of application_events for the whole batch.
  // Cast like normalizer's ExistingJobClient: supabase-js's generic select trips TS2589 against a
  // structural chain. The fake in fail-exit.test.ts pins the chain the settle step really calls.
  const settled = await settleModelFailures(db as unknown as SettleClient, heldModelFailures, scoredCount + droppedCount > 0);
  // Moved to failed: progress, reported in the note below.
  failedReasons.push(...settled.failed);
  // Lost races join the existing counter.
  skippedStaleCount += settled.skippedStale;
  // Unproven or failed moves are this run's failures.
  failures.push(...settled.failures);
  // The sweep cursor, computed by the tested pure function from what was PROCESSED, so the
  // response never claims "done" while rows are unjudged (see nextSweepCursor).
  const cursorOut = nextSweepCursor({
    // In id order, as the sweep read them.
    rowIds: (rows ?? []).map((r) => r.id),
    // The page size asked for.
    batchSize,
    // Finished rows, from the batch runner itself.
    processed: batch.processed,
    // The deadline, not the page end, stopped it.
    stoppedEarly: batch.stoppedEarly,
    // Where this page started.
    afterId,
    // Gate errors on this page: they keep the sweep from claiming done (see nextSweepCursor).
    errors: failures.length,
  });
  // Reported only for a sweep; a scoring run has no cursor.
  const sweepDone = mode.kind === "pregate_only" && cursorOut.done;
  // The after_id for the next call; null when done.
  const nextAfterId = cursorOut.nextAfterId;

  // HONEST FINAL STATUS. `failed` when there was work, none of it moved, and errors
  // explain why: the live matcher run seen 2026-10-04 (rows_in 10, rows_out 0,
  // error_count 10) was stamped `succeeded`, the silent stop agent_runs exists to catch.
  // Mixed results stay `succeeded` with error_count set: `agent_run_status` has no
  // `partial` (enums.sql:190), and an empty queue (rows_in 0) is idle, not broken.
  // A batch where every row was DROPPED moved every row, so it counts as progress, not failure.
  // Pre-gate drops moved their rows too, so they count as progress alongside the other two.
  // Rows this run moved to failed (W2) left the queue as well, so they count the same way.
  const runStatus = (rows ?? []).length > 0 && scoredCount + droppedCount + preGateDroppedCount + failedReasons.length === 0 && failures.length > 0 ? "failed" : "succeeded";
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
  // agent_runs has no skip column, so a lost race is a note beside the others (like the
  // deadline note): visible on the health page, never counted in error_count.
  const staleNote = skippedStaleCount > 0 ? `skipped_stale: ${skippedStaleCount} row(s) lost a race to another run` : null;
  // Pre-gate drops are not errors either; a note, so Health shows the backlog being pruned.
  const preGateNote = preGateDroppedCount > 0 ? `pre-gate dropped ${preGateDroppedCount} row(s) before scoring (${JSON.stringify(preGateDroppedByCode)})` : null;
  // A sweep says so on Health, with its survivors, so it is never mistaken for a scoring run
  // that scored nothing.
  const sweepNote = mode.kind === "pregate_only" ? `pregate_only sweep: ${preGateSurvivorCount} survivor(s) left at passed_filters` : null;
  // Rows this run failed (W2), with their distinct reasons, so Health shows WHY rows left the
  // queue as failed. A note, not an error: failing them was the run doing its job.
  const failedNote = failedReasons.length > 0 ? `matcher_failed: ${failedReasons.length} row(s) moved to failed (${[...new Set(failedReasons)].join(", ")})` : null;
  const errorDetail = [failureDetail, stopNote, staleNote, preGateNote, sweepNote, failedNote].filter((x) => x !== null).join(" | ") || null;

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
    // Rows another run took first; not failures, and not scored by this run.
    skipped_stale: skippedStaleCount,
    // Rows the pre-gate dropped before scoring, at zero Gemini cost: ALL pre-gate stages (tech, work-auth,
    // experience), so the honest name is pre_gate_dropped (#19, owned by peer 2 since 2026-11-07).
    // (The legacy tech_gate_dropped key went in #19 step 3, 2026-11-07, after both workflows switched in a6865e5.)
    pre_gate_dropped: preGateDroppedCount,
    // The same drops by drop_reason code (tech_gate, tech_gate_unclassified, work_auth,
    // experience_ceiling), so a reader is never told a work-auth drop was a title problem.
    pre_gate_dropped_by_code: preGateDroppedByCode,
    // Rows moved to failed (W2): an unusable job, or an answer that could never be read.
    failed: failedReasons.length,
    // Which run this was; a sweep also reports its survivors and where to resume.
    mode: mode.kind,
    // Sweep only: the cursor protocol the operator loops on until done is true.
    ...(mode.kind === "pregate_only"
      // unjudged_errors: rows the cursor moved past whose gate errored. The operator's loop
      // sums it across pages; a non-zero total means one more pass from the start (no
      // after_id). next_after_id null with done false also means "restart from the start".
      ? { pregate_survivors: preGateSurvivorCount, unjudged_errors: failures.length, next_after_id: nextAfterId, done: sweepDone }
      : {}),
    // Total count of Gemini API calls executed.
    gemini_calls: geminiCallsCount,
    // Array of individual application row failure objects.
    failures,
    // WHY, in one readable field (2026-11-07): a targeted run that found nothing, or a rate limit. Null
    // otherwise. Additive; failures[].error is unchanged (the web's card reads it today).
    reason: matcherRunReason({ targeted: applicationId !== null, found: (rows ?? []).length, target: targetRow, failures }),
  });
}));
