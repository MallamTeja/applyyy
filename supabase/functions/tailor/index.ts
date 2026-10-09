// Tailor — Edge Function Entrypoint
//
// Reads `applications` sitting at status `scored`, rewrites the master resume against
// each posting through Gemini, validates every claim back to a master node, and writes
// the surviving `ResolvedResume` into `applications.tailored_profile`.
//
// WHY THIS LIVES IN DENO AND NOT IN THE NODE WORKER, because the obvious place was the
// worker and it does not work: `_shared/gemini/` imports `jsr:@supabase/supabase-js` and
// reads `Deno.env` (pool.ts:119). Importing it from `worker/` fails with TS2307 and
// TS2304 — measured, not assumed.
//
// That is a RUNTIME boundary, and it is worth separating from the type errors the same
// file used to carry: `db98d6e` closed all four of those on 2026-09-18 and this import
// still cannot cross into Node. Fixing the types was never what stood in the way. The
// Tailor belongs next to the key pool it depends on.
//
// THIS FILE IS GLUE AND HOLDS NO LOGIC WORTH TESTING, deliberately. Every decision it
// could get wrong has been pushed into a pure module with its own tests:
// `tailor-batch.ts` decides which rows are even tailorable, `tailorer.ts` decides the
// verdict, `persist.ts` decides the write order. What is left here is I/O and wiring,
// which is why no `index.ts` in this repo has a test file.

// Signs in as the ordinary app user, so every query below runs under normal RLS. There
// is no service-role key in this stream — see _shared/db/client.ts for the argument.
import { createAppUserClient } from "../_shared/db/client.ts";
// The model transport, with key-pool claiming, 429 failover and pacing already handled.
import { generateGeminiContent } from "../_shared/gemini/client.ts";
// Which rows may be tailored at all. The guard against tailoring an empty posting.
import { planTailorBatch } from "../_shared/tailor/tailor-batch.ts";
// The shared reader-side liveness helpers, so every reader that adopts them names a lost
// column the same way (today the Tailor is the only one). allLivenessUnknown spots the batch shape that means the select below lost it.
import { allLivenessUnknown, classifyJobLiveness, LIVENESS_UNKNOWN_DETAIL } from "../_shared/scout/liveness.ts";
// The runner: prompt -> model -> validate -> verdict.
import { createTailorer } from "../_shared/tailor/tailorer.ts";
// The write: payload first, status second, never the reverse.
import { persistTailorOutcome } from "../_shared/tailor/persist.ts";
// The master shape, so the stored JSON is cast against the contract rather than inferred.
import type { MasterProfile } from "../_shared/contracts/shared-types.ts";
// Caller auth and the fail-closed kill switch, shared by every pipeline agent.
import { authorizeCaller, readKillSwitch } from "../_shared/db/gates.ts";
// Shared CORS headers, plus the boundary that keeps them on an uncaught 500.
import { corsHeaders, withErrorBoundary } from "../_shared/cors.ts";
// The shared `?application_id=` parser, so all five pipeline agents refuse a bad id identically.
import { parseApplicationIdParam } from "../_shared/http/application-id.ts";
// Per-invocation deadline: plans each Gemini call from the time left and stops between rows.
import { createDeadline, deadlineNote, runBatchWithDeadline, shortenedBudgetNote, type CallOptions } from "../_shared/agent/deadline.ts";

// How many rows one invocation will attempt. Bounded because each row is a Gemini call
// against a shared key pool, and an unbounded batch would drain the quota that every
// other agent shares. A caller wanting more invokes again.
const DEFAULT_BATCH_SIZE = 10;
// Hard ceiling, so a caller-supplied value cannot turn one request into a quota outage.
const MAX_BATCH_SIZE = 25;

// One JSON response shape for every exit, so a caller never has to branch on content type.
function jsonResponse(status: number, data: Record<string, unknown>): Response {
  // Indented output: this endpoint is read by a human far more often than by a program,
  // and will be for as long as nothing schedules it.
  return new Response(JSON.stringify(data, null, 2), {
    status,
    // Charset stated explicitly — the tailored text is user-facing and may carry
    // non-ASCII, and a sniffed encoding is a silent corruption rather than an error.
    headers: { "content-type": "application/json; charset=utf-8", ...corsHeaders },
  });
}

// Clamp the requested batch size into something the key pool can survive.
function resolveBatchSize(raw: string | null): number {
  // Absent is the common case and means "use the default", not "use zero".
  if (raw === null) return DEFAULT_BATCH_SIZE;
  const parsed = Number(raw);
  // `Number("")` is 0 and `Number("abc")` is NaN — both would silently mean "do nothing"
  // if passed through. Validating the shape rather than trusting the parser is CLAUDE.md
  // §5, and this is the exact trap it names.
  if (!Number.isInteger(parsed) || parsed < 1) return DEFAULT_BATCH_SIZE;
  return Math.min(parsed, MAX_BATCH_SIZE);
}

// Wrapped so a throw anywhere below still answers with CORS headers the browser can read.
Deno.serve(withErrorBoundary("applyy-tailor", async (req: Request): Promise<Response> => {
  // Started first so startup, auth and the queue read all count against the 150 s kill.
  const deadline = createDeadline();
  // Preflight, before any work or any database connection.
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  // Sign in. A missing environment variable is an operational condition with its own
  // status code, not a 500 — the client returns it as data for exactly that reason.
  const connection = await createAppUserClient();
  if (!connection.ok) {
    // `reason` distinguishes "no such user" from "wrong password" and so stays in the
    // log, never in the body.
    console.error("[applyy-tailor] could not sign in:", connection.reason);
    // 503 rather than 500: this is "come back later", and a caller retrying on it is
    // behaving correctly. A 500 would invite someone to go looking for a bug in here.
    return jsonResponse(503, { success: false, error: "database_unavailable" });
  }
  // Unpacked once so the rest of the handler reads as ordinary queries rather than
  // threading the result union through every call.
  const db = connection.db;

  // Refuse anyone but the app user BEFORE any write or Gemini spend. The sign-in above
  // never looks at the caller, so the public anon key alone used to suffice.
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

  // Open the run row BEFORE the work, so an uncatchable death leaves a visible stuck
  // run rather than no trace at all — the documented design in supporting_tables.sql.
  const { data: runRow } = await db
    .from("agent_runs")
    // `tailor` is a real `agent_name` enum member (enums.sql:173), not a free string;
    // a typo here is refused by the column type rather than logged under a ghost agent.
    .insert({ agent: "tailor", status: "running", started_at: new Date().toISOString() })
    .select("id")
    .single();
  // Error deliberately not checked: failing to OPEN a run row must not stop the run.
  // Telemetry is the observer of the work, never a precondition for it — and `runId`
  // being undefined already makes every write below a no-op.
  const runId: string | undefined = runRow?.id;

  // Close the run row with a failure, then answer. Folded into one helper because every
  // early exit below has to do both and forgetting the first leaves a phantom run.
  async function failRun(status: number, error: string, detail: string): Promise<Response> {
    if (runId) {
      await db
        .from("agent_runs")
        .update({ status: "failed", finished_at: new Date().toISOString(), error_detail: detail })
        .eq("id", runId);
    }
    return jsonResponse(status, { success: false, error });
  }

  // The shared fail-closed kill switch. The tailor never checked it before, so it spent
  // Gemini quota with the system turned off.
  const killSwitch = await readKillSwitch(db);
  // A failed read is an error, not a decision.
  if (killSwitch.kind === "unreadable") return await failRun(503, "kill_switch_read_failed", killSwitch.detail);
  // Off, or no settings row: a deliberate skip, recorded so the health page says why.
  if (killSwitch.kind === "disabled") {
    // Closed as skipped rather than left `running`.
    if (runId) {
      await db
        .from("agent_runs")
        .update({ status: "skipped_disabled", finished_at: new Date().toISOString(), error_detail: killSwitch.detail })
        .eq("id", runId);
    }
    // 200: the system did what it was told.
    return jsonResponse(200, { success: true, status: "skipped_disabled", detail: killSwitch.detail });
  }

  // THE PINNED MASTER. Highest version wins; the trigger assigns version as max+1.
  const { data: masterRow, error: masterError } = await db
    .from("master_profiles")
    .select("profile, version")
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle();

  // A read failure and an empty table are different facts and get different answers.
  if (masterError) return await failRun(503, "master_profile_unreadable", masterError.message);
  // NO MASTER MEANS NO TAILORING, and refusing here is the point. Every honesty check
  // downstream resolves refs against this profile; without one there is nothing for a
  // tailoring to be faithful to, and the validator would refuse every row anyway — but
  // only after paying for a Gemini call per row to find out.
  if (!masterRow) return await failRun(409, "no_master_profile", "master_profiles is empty");

  // Cast once, against the contract. The column is `jsonb`, so this is the boundary
  // where stored JSON becomes a typed profile.
  //
  // UNVALIDATED ON PURPOSE, and worth saying out loud rather than leaving as an
  // omission: the validator refuses a tailoring whose master has duplicate node ids
  // (`validator.ts:415`), which is the failure this cast could otherwise hide. A shape
  // check here would duplicate a control that already exists one layer down and answers
  // the same question — and the known bad master today is not malformed, it is the
  // hardcoded placeholder the broken PDF path writes, which no shape check can detect.
  const master = masterRow.profile as MasterProfile;
  // The pin, kept separate from the profile because it lives in a column and not in the
  // JSON — `MasterProfile` carries `schema_version`, never the row version.
  const masterVersion: number = masterRow.version;

  // The work queue. `scored` is the Tailor's only legal source
  // (status_transition_guard.sql:116), so this select IS the edge, expressed as a query.
  const batchSize = resolveBatchSize(new URL(req.url).searchParams.get("limit"));
  // `applicationId` was parsed and validated above, before the run row was opened.
  const { data: rows, error: rowsError } = await db
    .from("applications")
    // The embedded resource is the posting itself. Fetched in one round trip rather than
    // per row: N+1 against a shared Postgres is how a batch of ten becomes a timeout.
    // `disappeared_at` is REQUIRED: planTailorBatch fails closed on its absence and skips
    // the row as liveness_unknown. `!inner` is REQUIRED too: without it the .is() below
    // only nulls the embed and the dead job's application still arrives (the reasoning and
    // citation live at the top of _shared/scout/liveness.ts). Both pinned by
    // _shared/tailor/tailor-index-select.test.ts.
    .select("id, jobs!inner (title, company_name, description_raw, disappeared_at)")
    // Exclude postings scout-ats marked gone. They stay at `scored`, unselected, so a
    // repost clears disappeared_at and they rejoin this queue with no status repair.
    .is("jobs.disappeared_at", null)
    // No `user_id` filter, and that is deliberate — RLS already scopes this to the signed
    // -in user. Adding one would read as defence in depth while actually being a second
    // place for the tenant rule to drift out of step with the policy.
    .eq("status", "scored")
    // Narrow to the one requested row; the status filter stays, so a wrong-status id yields
    // zero rows. An empty match object is a no-op when untargeted.
    .match(applicationId !== null ? { id: applicationId } : {})
    // Oldest first, so a persistent failure at the head of the queue is visible rather
    // than being skipped over by newer rows every run.
    .order("created_at", { ascending: true })
    .limit(batchSize);

  if (rowsError) return await failRun(503, "queue_unreadable", rowsError.message);

  // Decide what is actually tailorable. Rows missing a posting are skipped with a named
  // reason rather than sent to the model as a well-formed request about nothing.
  const plan = planTailorBatch(rows ?? []);

  // The budget planned for the row in flight; set by the batch runner before each row and read
  // by callLlm below. Undefined until the first row, which falls back to the client defaults.
  let callBudget: CallOptions | undefined;

  // Bind the model to this master and version once, rather than per row.
  const tailor = createTailorer({
    master,
    masterVersion,
    // The seam the runner's tests replace. Here it is the real transport.
    callLlm: async (prompt) => {
      const outcome = await generateGeminiContent(db, {
        // The fenced prompt, passed through unchanged — the trust boundary was built in
        // prompt.ts and this function must not reshape it.
        prompt: {
          systemInstruction: prompt.systemInstruction,
          userContent: prompt.userContent,
          responseSchema: prompt.responseSchema,
        },
        // Spread only when set: exactOptionalPropertyTypes forbids passing `undefined`.
        ...(callBudget ? { timeoutMs: callBudget.timeoutMs, maxRetries: callBudget.maxRetries } : {}),
      });
      // A pool or transport failure is not a tailoring verdict. Thrown so the row is
      // recorded as an error rather than being persisted as a refusal, which would
      // blame the model for a quota problem.
      if (!outcome.ok) throw new Error(`gemini_call_failed: ${outcome.reason}`);
      // Optional chaining at every hop because `noUncheckedIndexedAccess` is on and each
      // of these may genuinely be absent in a safety-blocked response.
      const text = outcome.data.candidates?.[0]?.content?.parts?.[0]?.text;
      // A response carrying no text has not answered. Same rule as above: throw rather
      // than hand the runner an empty string it would report as malformed JSON.
      if (typeof text !== "string") throw new Error("gemini_returned_no_text");
      return text;
    },
  });

  // Counters, reported separately because they answer different questions: how many were
  // written, how many were honestly refused, and how many never reached the model.
  let tailored = 0;
  let refused = 0;
  // Per-row outcomes, so one failure is legible without reading the logs.
  const failures: Array<{ applicationId: string; error: string }> = [];

  // SKIPPED ROWS ARE FAILED, NOT LEFT. A row with no posting, title, company or
  // description will be just as untailorable next run — and because the queue is oldest
  // first, a handful of them would sit at the head forever and starve every row behind
  // them. These reasons are all properties of the stored data, never transient, so
  // `scored -> failed` (allowed for `tailor`, status_transition_guard.sql:118) is honest.
  for (const skip of plan.skipped) {
    // `malformed_row` has no id to fail; it cannot be moved and is only reported.
    if (skip.applicationId === null) continue;
    // EXCEPT liveness_unknown, which is LEFT at `scored`. It is not a property of the data
    // but of this function's own select, so the premise above is false for it: failing it
    // would turn one dropped column into every scored row stuck at `failed`, whose only exit
    // is a human. The run is marked failed below instead, loudly.
    // AND EXCEPT posting_disappeared, also LEFT at `scored`: a dead posting is NOT
    // permanent — planReappearances clears disappeared_at when the job is reposted, and a
    // row already at `failed` could not rejoin the queue. The query filter keeps these out
    // of the batch; reaching here means that filter was lost, and the skip still holds.
    if (skip.reason === "liveness_unknown" || skip.reason === "posting_disappeared") continue;
    // Through the RPC — a bare status update is refused by the guard with 42501.
    const { error } = await db.rpc("advance_application_status", {
      p_application_id: skip.applicationId,
      p_to_status: "failed",
      p_agent: "tailor",
      // The named skip reason, so the dashboard can say what was missing.
      p_detail: { reason: "tailor_input_unusable", skip_reason: skip.reason },
    });
    // A refused move leaves the row at `scored`; recorded so it is not invisible.
    if (error) failures.push({ applicationId: skip.applicationId, error: error.message });
  }

  // Sequential on purpose. The key pool paces itself, and firing ten concurrent calls
  // would race every one of them into the same 429 the pacer exists to avoid.
  // The deadline check lives in runBatchWithDeadline and runs only BETWEEN rows, so a row is
  // never stopped between persist's payload write and its status write. Unreached rows stay
  // at `scored` and the next run picks them up; they are not failures.
  const batch = await runBatchWithDeadline(plan.tailorable, async (job, call) => {
    // Hand this row's planned timeout/retries to callLlm through the closure above.
    callBudget = call;
      try {
        const outcome = await tailor(job.input);
        // Persist decides the write order; this loop only reports what it returned.
        const written = await persistTailorOutcome(db, job.applicationId, outcome);
        if (!written.ok) {
          failures.push({ applicationId: job.applicationId, error: written.message });
          return;
        }
        // Counted from what was actually persisted, not from the verdict — a verdict that
        // failed to write is not a row anyone can act on.
        if (written.status === "tailored") tailored += 1;
        else refused += 1;
      } catch (err) {
        // A throw here is a transport or schema failure, never a fabrication finding. The
        // row keeps its `scored` status and will be picked up by the next invocation.
        // Tagged when the deadline cut this row's Gemini budget, so a deadline-caused timeout
        // is distinguishable from a real model timeout.
        failures.push({ applicationId: job.applicationId, error: (err instanceof Error ? err.message : String(err)) + shortenedBudgetNote(call) });
      }
  }, { deadline, targeted: applicationId !== null });

  // HONEST FINAL STATUS. `failed` when there was work, none of it moved, and errors
  // explain why: the live matcher run seen 2026-10-04 (rows_in 10, rows_out 0,
  // error_count 10) was stamped `succeeded`, the silent stop agent_runs exists to catch.
  // Mixed results stay `succeeded` with error_count set: `agent_run_status` has no
  // `partial` (enums.sql:190), and an empty queue (rows_in 0) is idle, not broken.
  // A batch where EVERY row lacked disappeared_at is a select defect, not an empty queue;
  // without this it reads as "succeeded, nothing to tailor" on the health page.
  // Classified from the RAW rows rather than the plan, so any reader that adopts these
  // helpers can share one definition of "the column never arrived" without a Tailor plan.
  const queueRows = rows ?? [];
  // The exact shared wording, or null for an ordinary batch.
  const selectDefect = allLivenessUnknown(queueRows.map((row) => classifyJobLiveness(row?.jobs)))
    ? LIVENESS_UNKNOWN_DETAIL(queueRows.length)
    : null;
  // Failed on a select defect, or when there was work and none of it moved.
  const runStatus = selectDefect !== null || (plan.tailorable.length > 0 && tailored === 0 && failures.length > 0) ? "failed" : "succeeded";
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
  // The select defect leads, since it explains every other number in the run.
  const errorDetail = [selectDefect, failureDetail, stopNote].filter((x) => x !== null).join(" | ") || null;

  // Close the run. Partial failures stay `succeeded` with their count; a run that
  // tailored nothing because every row errored is `failed`.
  if (runId) {
    await db
      .from("agent_runs")
      .update({
        // Derived from the counters, never hard-coded: see runStatus above.
        status: runStatus,
        // Failure reasons plus, on an early stop, the `deadline:` note (see errorDetail above).
        error_detail: errorDetail,
        // When the run closed.
        finished_at: new Date().toISOString(),
        // What we looked at, and what we wrote. Two numbers because "read 10, wrote 0"
        // is the early warning that the pipeline is dry, and one total would hide it.
        rows_in: plan.tailorable.length,
        rows_out: tailored,
        // Transport, quota and write failures, so a run that wrote nothing because every
        // call failed does not read as a clean, idle success.
        error_count: failures.length,
      })
      .eq("id", runId);
  }

  return jsonResponse(200, {
    // The function ran to completion; per-row failures are in `failures` below.
    success: true,
    // The same status written to agent_runs, so the dashboard and health page agree.
    status: runStatus,
    // The same failure reasons and deadline note, so the operator sees them without a DB query.
    error_detail: errorDetail,
    // Which master every verdict in this run was judged against, so a later dispute
    // about a tailoring does not have to guess.
    master_version: masterVersion,
    // Only present on a targeted run, so the untargeted response shape is unchanged. `found: 0`
    // says "that id is not at this agent's input status", which an empty queue never could.
    ...(applicationId !== null ? { targeted: true, found: (rows ?? []).length } : {}),
    // Reached the model and produced a persisted resume.
    tailored,
    // Reached the model and were honestly refused by the validator. NOT an error —
    // this number being zero forever is the suspicious reading, not a high one.
    refused,
    // Never reached the model, with the reason each was skipped. Each one with an id has
    // now been moved to `failed` (unless listed in `failures`), except liveness_unknown
    // and posting_disappeared, which stay at `scored` by design.
    skipped: plan.skipped,
    // Transport, quota or write failures. These rows are still at `scored`.
    failures,
  });
}));
