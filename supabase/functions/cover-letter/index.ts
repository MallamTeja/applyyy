// COVER LETTER — Edge Function entrypoint.
//
// Writes `applications.cover_letter` for rows that have a tailored resume and no letter
// yet. That is ALL it writes. Rewritten 2026-10-04; the old version had three defects:
//   1. it consumed `tailored` rows and advanced them through audit_clean/audit_flagged
//      -> awaiting_approval as p_agent 'auditor', racing the real Auditor and forging
//      its verdict into the append-only event log;
//   2. it stored the letter by overwriting `applications.block_detail`, erasing a
//      blocked row's explanation (migration 20261004210000 adds a dedicated column);
//   3. it stored the raw Gemini text when the JSON was malformed, and logged its runs as
//      agent 'tailor', crediting the Tailor on the health page.
// The batch itself lives in run.ts so a test can prove no status RPC is ever made.
//
// Nothing invokes this function today (no caller in apps/web/src, .github, worker/src
// or config.toml); it is safe to deploy and inert until something does.

// Signs in as the app user, so every query runs under RLS.
import { createAppUserClient } from "../_shared/db/client.ts";
// Gemini key-pool transport with 429 rotation.
import { generateGeminiContent } from "../_shared/gemini/client.ts";
// Caller auth and the fail-closed kill switch, shared by every agent that spends quota.
import { authorizeCaller, readKillSwitch } from "../_shared/db/gates.ts";
// Shared CORS headers, plus the boundary that keeps them on an uncaught 500.
import { corsHeaders, withErrorBoundary } from "../_shared/cors.ts";
// The profile type the prompt reads identity from.
import type { MasterProfile } from "../_shared/contracts/shared-types.ts";
// The batch: select, generate, validate, write.
import { runCoverLetterBatch, type CoverLetterClient } from "./run.ts";

// Default rows per invocation; each one is a Gemini call.
const DEFAULT_BATCH_SIZE = 10;
// Ceiling, so a caller cannot ask for an unsustainable spend.
const MAX_BATCH_SIZE = 25;

// Marks a failed master_profiles read, so the catch around the batch can tell it from a
// failed queue read by type instead of by sniffing message text.
class MasterProfileUnreadable extends Error {}

// One JSON response shape for every exit.
function jsonResponse(status: number, data: Record<string, unknown>): Response {
  // CORS on every response, or the browser hides the status behind a CORS error.
  return new Response(JSON.stringify(data, null, 2), {
    // The caller-chosen status.
    status,
    // JSON with an explicit charset, so model-written text is not mangled.
    headers: { "content-type": "application/json; charset=utf-8", ...corsHeaders },
  });
}

// Parses `?limit` by shape — `Number("abc")` is NaN and `Number("2.5")` a fraction,
// and neither may reach `.limit()`. Same rule as the matcher's.
function resolveBatchSize(raw: string | null): number {
  // Absent parameter: the default.
  if (raw === null) return DEFAULT_BATCH_SIZE;
  // `Number("")` is 0, rejected below with NaN and fractions.
  const parsed = Number(raw);
  // Only a positive whole number is a batch size.
  if (!Number.isInteger(parsed) || parsed < 1) return DEFAULT_BATCH_SIZE;
  // Clamp to the ceiling.
  return Math.min(parsed, MAX_BATCH_SIZE);
}

// Wrapped so a throw anywhere below still answers with CORS headers.
Deno.serve(withErrorBoundary("applyy-cover-letter", async (req: Request): Promise<Response> => {
  // Preflight, before any work.
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  // Sign in; a missing credential is an operational 503, not a bug.
  const connection = await createAppUserClient();
  // Without a session nothing below is safe.
  if (!connection.ok) {
    // `reason` stays in the log — it distinguishes "no user" from "wrong password".
    console.error("[applyy-cover-letter] could not sign in:", connection.reason);
    // Retryable once configuration is fixed.
    return jsonResponse(503, { success: false, error: "database_unavailable" });
  }
  // Unpacked once for readability.
  const db = connection.db;

  // Refuse anyone but the app user BEFORE any write or Gemini spend: the sign-in above
  // never looks at the caller, so the public anon key alone would otherwise suffice.
  const caller = await authorizeCaller(req, db, connection.userId);
  // 401 or 403, as the verdict says.
  if (!caller.ok) return jsonResponse(caller.status, { success: false, error: caller.error });

  // Open the run row FIRST, so a crash leaves a visible stuck run instead of nothing.
  const { data: runRow, error: runError } = await db
    .from("agent_runs")
    // Its own identity (migration 20261004210000), never 'tailor' again.
    .insert({ agent: "cover_letter", status: "running", started_at: new Date().toISOString() })
    // Only the id is needed to close it later.
    .select("id")
    // Exactly one row was inserted.
    .single();
  // Telemetry must not block the agent: a failed insert (e.g. the migration not yet
  // pushed, so 'cover_letter' is not an enum value) is logged and the work continues.
  if (runError) console.error("[applyy-cover-letter] agent_runs insert failed; continuing without telemetry:", runError.message);
  // Undefined when the insert failed; every close below is then skipped.
  const runId: string | undefined = runRow?.id;

  // Closes the run row; a failed close is logged, never thrown, for the same reason.
  async function closeRun(patch: Record<string, unknown>): Promise<void> {
    // No row to close.
    if (!runId) return;
    // Stamp the finish time with whatever the caller decided.
    const { error } = await db.from("agent_runs").update({ finished_at: new Date().toISOString(), ...patch }).eq("id", runId);
    // Logged so a stuck `running` row has an explanation in the function log.
    if (error) console.error("[applyy-cover-letter] agent_runs close failed:", error.message);
  }

  // Fail closed: only an explicit, readable "on" proceeds.
  const killSwitch = await readKillSwitch(db);
  // A failed read is an error, not a decision.
  if (killSwitch.kind === "unreadable") {
    // Recorded as a failure so the health page shows it.
    await closeRun({ status: "failed", error_detail: killSwitch.detail });
    // Retryable.
    return jsonResponse(503, { success: false, error: "kill_switch_read_failed" });
  }
  // Off: a deliberate halt, recorded so the health page can say WHY nothing ran.
  if (killSwitch.kind === "disabled") {
    // Distinct from a dead cron.
    await closeRun({ status: "skipped_disabled", error_detail: killSwitch.detail });
    // 200: the system did what it was told.
    return jsonResponse(200, { success: true, status: "skipped_disabled", detail: killSwitch.detail });
  }

  // Identity for each letter comes from the master version THAT row was tailored against,
  // loaded per batch by run.ts once the pins are known. The old newest-master read (and its
  // 409 no_master_profile) is gone: a master uploaded after tailoring put an identity the
  // resume never came from into the letter. Same fix as the auditor (c209921).
  async function loadMasters(versions: readonly number[]): Promise<ReadonlyMap<number, MasterProfile>> {
    // Filled from the query; a version the database lacks stays absent and that row fails closed.
    const byVersion = new Map<number, MasterProfile>();
    // Nothing pinned: skip the round trip, `.in()` with an empty list is pointless.
    if (versions.length === 0) return byVersion;
    // Exactly the pinned versions, one query. RLS scopes master_profiles to the signed-in
    // owner, and versions are immutable, so a version number names one fixed profile.
    const { data, error } = await db.from("master_profiles").select("profile, version").in("version", [...versions]);
    // Thrown as its own type so the catch below answers master_profile_unreadable, not
    // queue_unreadable — and never treats a failed read as "no such version".
    if (error) throw new MasterProfileUnreadable(error.message);
    // Index by version so each row resolves its own pin with an exact lookup.
    for (const m of data ?? []) byVersion.set(m.version as number, m.profile as MasterProfile);
    // Stored JSON is unchecked; the prompt builder reads it defensively.
    return byVersion;
  }

  // The batch; throws only when the queue read or the master load fails.
  let result;
  try {
    // Adapts the pool client to the injected seam run.ts expects.
    result = await runCoverLetterBatch(
      // Cast, because comparing SupabaseClient's generic builder chain to the narrow
      // interface overflows tsc (TS2589). The interface is the contract; run.test.ts
      // exercises it with a fake shaped exactly like the real chain.
      db as unknown as CoverLetterClient,
      async (prompt) => {
        // The pool call; never throws for an HTTP failure, returns a reason instead.
        const outcome = await generateGeminiContent(db, { prompt });
        // Reason code only; `detail` can carry upstream bodies and stays in the log.
        if (!outcome.ok) {
          console.warn("[applyy-cover-letter] gemini failure:", outcome.reason, outcome.detail);
          return { ok: false, reason: outcome.reason };
        }
        // The schema-constrained reply is in the first candidate's first part.
        return { ok: true, text: outcome.data.candidates?.[0]?.content?.parts?.[0]?.text };
      },
      // Pinned-master loader, defined above.
      loadMasters,
      // Validated above.
      resolveBatchSize(new URL(req.url).searchParams.get("limit")),
    );
  } catch (err) {
    // Either read failed: a failed run, not an empty one.
    const detail = err instanceof Error ? err.message : String(err);
    // The master read keeps its own error name, as the pre-pin version answered it.
    if (err instanceof MasterProfileUnreadable) {
      // Recorded with the reason.
      await closeRun({ status: "failed", error_detail: detail.slice(0, 500) });
      // Retryable.
      return jsonResponse(503, { success: false, error: "master_profile_unreadable" });
    }
    // Recorded with the reason.
    await closeRun({ status: "failed", error_detail: detail.slice(0, 500) });
    // Retryable.
    return jsonResponse(503, { success: false, error: "queue_unreadable" });
  }

  // HONEST FINAL STATUS (copied from matcher): `failed` when there was work, none of it
  // landed, and errors explain why. Mixed results stay `succeeded` with error_count set —
  // agent_run_status has no `partial` — and an empty queue is idle, not broken.
  const runStatus = result.rowsIn > 0 && result.generated === 0 && result.failures.length > 0 ? "failed" : "succeeded";
  // First three DISTINCT reasons, capped: ten rows failing one way is one fact. Null on a
  // clean run so a stale reason never sits beside error_count 0.
  const errorDetail = result.failures.length > 0
    ? [...new Set(result.failures.map((f) => f.error))].slice(0, 3).join(" | ").slice(0, 500)
    : null;

  // Close the run with the counters the health page reads.
  await closeRun({
    // Derived from the counters, never hard-coded.
    status: runStatus,
    // Why, not just how many.
    error_detail: errorDetail,
    // Rows the queue returned.
    rows_in: result.rowsIn,
    // Letters written.
    rows_out: result.generated,
    // Rows attempted that wrote nothing.
    error_count: result.failures.length,
    // Quota spent.
    gemini_calls: result.geminiCalls,
  });

  // The same numbers to the caller, so dashboard and health page agree.
  return jsonResponse(200, {
    // The function ran to completion; `status` carries the verdict.
    success: true,
    // Same status as agent_runs.
    status: runStatus,
    // Same summary as agent_runs.
    error_detail: errorDetail,
    // Rows considered.
    rows_in: result.rowsIn,
    // Letters written.
    generated: result.generated,
    // Quota spent.
    gemini_calls: result.geminiCalls,
    // Rows refused before any spend.
    skipped: result.skipped,
    // Rows attempted that wrote nothing; they stay queued.
    failures: result.failures,
  });
}));
