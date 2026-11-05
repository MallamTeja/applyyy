// SKILL-GAP AGGREGATOR — counts which required skills the candidate's master profile lacks,
// across the jobs the pipeline has scored or applied to, into `skill_gap_reports`.
//
// Rewritten 2026-10-04 after an audit found every query and write in the old version
// named a column that does not exist (`applications.job_description`,
// `applications.candidate_profile`, `last_calculated_at`, `agent_runs.agent_name`), so
// the function had never produced a single row.
//
// TELEMETRY RESTORED 2026-10-04 as agent 'skill_gap', the enum value migration
// 20261004210000 adds. It was removed earlier because no value existed and borrowing
// another agent's name would make the health page credit that agent with these runs.
// A failed agent_runs write is logged and never blocks the aggregation.
//
// SPLIT FROM index.ts 2026-11-01: index.ts calls Deno.serve at import and pulls in the
// jsr supabase client, neither of which `node --test` can load. Every decision now lives
// here behind one injected seam (`connect`), so handler.test.ts can drive the real code.

// CORS headers, so a browser-side caller can read failures as well as successes.
import { corsHeaders } from "../_shared/cors.ts";
// The sign-in result type only. A type import is erased under node, so the jsr client it
// names never loads in tests; index.ts passes the real createAppUserClient.
import type { DbClientResult } from "../_shared/db/client.ts";
// Caller auth (W14) plus the kill switch, both read through the shared helpers, so this
// function refuses and fails closed the same way every pipeline agent does instead of
// with its own `.single()` variant.
import { authorizeCaller, readKillSwitch, type CallerRefused } from "../_shared/db/gates.ts";
// Finds the skills a job description asks for.
import { extractRequiredSkills } from "../_shared/analytics/skill-extractor.ts";
// Diffs those skills against the candidate's profile.
import { computeSkillGaps } from "../_shared/analytics/skill-gap.ts";
// The profile type `computeSkillGaps` expects.
import type { MasterProfile } from "../_shared/contracts/shared-types.ts";

// Ceiling on applications read per run: extraction is pure CPU, so this bounds memory
// rather than LLM spend.
const APPLICATION_SCAN_LIMIT = 200;

// One JSON response shape for every exit, so callers parse a single format.
function jsonResponse(status: number, body: Record<string, unknown>): Response {
  // CORS on every response, or a browser hides the status behind a CORS error.
  return new Response(JSON.stringify(body), {
    // JSON content type plus the shared CORS headers.
    headers: { ...corsHeaders, "Content-Type": "application/json" },
    // The caller-chosen HTTP status.
    status,
  });
}

// Pulls `jobs.description_raw` out of the embedded relation by SHAPE. PostgREST returns a
// to-one embed as an object, but an untyped client cannot promise that, so anything else
// reads as "no description" rather than as a crash or a stringified object.
function descriptionOf(embedded: unknown): string | null {
  // Not an object: no usable embed.
  if (typeof embedded !== "object" || embedded === null) return null;
  // The one field this function needs.
  const raw = (embedded as { description_raw?: unknown }).description_raw;
  // Only a non-blank string is a description; "" would extract zero skills silently.
  return typeof raw === "string" && raw.trim().length > 0 ? raw : null;
}

// The whole request. Errors inside are caught below so the caller always gets JSON.
// `connect` signs in as the app user; injected so a test can hand in a fake client.
// `connect` verifies the caller BEFORE signing in (W15, 2026-11-05) and may answer CallerRefused.
export async function handleSkillGap(req: Request, connect: () => Promise<DbClientResult | CallerRefused>): Promise<Response> {
  // Preflight: answer before touching the database.
  if (req.method === "OPTIONS") {
    // 204 with CORS headers lets the browser send the real request.
    return new Response(null, { headers: corsHeaders, status: 204 });
  }

  // Verify the caller, then sign in as the app user so RLS scopes every row to them.
  const connection = await connect();
  // A refused caller, answered before any password grant was spent; same body as gate 1 below.
  if (!connection.ok && "status" in connection) return jsonResponse(connection.status, { success: false, error: connection.error });
  // Without a session there is nothing safe to do.
  if (!connection.ok) {
    // The reason stays in the server log; it may name env vars.
    console.error("[skill-gap] database connection failed:", connection.reason);
    // 503: a configuration fault, retryable once fixed.
    return jsonResponse(503, { error: "database_unavailable" });
  }
  // The authenticated client used for the rest of the run.
  const db = connection.db;

  // W14 (2026-11-01 wiring audit): only the app user may trigger a run under the app
  // user's session. The sign-in above never looks at the caller, and verify_jwt passes the
  // public anon key (a validly signed JWT), so without this any page visitor could write
  // skill_gap_reports. Same call, order and refusal body as follow-up/index.ts.
  const caller = await authorizeCaller(req, db, connection.userId);
  // 401 or 403, as the verdict says; a refused caller is not a run, so no agent_runs row.
  if (!caller.ok) return jsonResponse(caller.status, { success: false, error: caller.error });

  // Open the run row after auth and before any work, so a crash leaves a visible stuck
  // run rather than nothing.
  const { data: runRow, error: runError } = await db
    .from("agent_runs")
    // Its own identity; never borrowed.
    .insert({ agent: "skill_gap", status: "running", started_at: new Date().toISOString() })
    // Only the id is needed to close it.
    .select("id")
    // Exactly one row.
    .single();
  // Telemetry must not block the agent: a failed insert (e.g. the enum migration not
  // pushed yet) is logged and the aggregation still runs.
  if (runError) console.error("[skill-gap] agent_runs insert failed; continuing without telemetry:", runError.message);
  // Undefined when the insert failed; closeRun then does nothing.
  const runId: string | undefined = runRow?.id;
  // Closes the run row. Never throws: a failed close is logged for the same reason.
  async function closeRun(patch: Record<string, unknown>): Promise<void> {
    // No row to close.
    if (!runId) return;
    // Finish time plus the caller's verdict and counters.
    const { error } = await db.from("agent_runs").update({ finished_at: new Date().toISOString(), ...patch }).eq("id", runId);
    // Explains a row stuck at `running`.
    if (error) console.error("[skill-gap] agent_runs close failed:", error.message);
  }

  // Fail closed: only an explicit, readable "on" lets the run proceed.
  const killSwitch = await readKillSwitch(db);
  // Disabled and unreadable both halt, with different codes so the caller can tell.
  if (killSwitch.kind !== "enabled") {
    // The detail is operational, not secret, but still belongs in the log.
    console.warn("[skill-gap] kill switch:", killSwitch.kind, killSwitch.detail);
    // Off is a deliberate skip; an unreadable switch is a failure the health page must show.
    await closeRun({ status: killSwitch.kind === "disabled" ? "skipped_disabled" : "failed", error_detail: killSwitch.detail });
    // Unreadable: 503, retryable, and a red scheduled run, because the read itself broke.
    if (killSwitch.kind === "unreadable") return jsonResponse(503, { error: "settings_unreadable" });
    // Off: 200 skipped_disabled, the answer follow-up and cover-letter give (2026-11-01),
    // so the daily satellites workflow reads a deliberate halt the same way for every agent.
    return jsonResponse(200, { success: true, status: "skipped_disabled" });
  }

  try {
    // The candidate side of the diff: the newest master profile. Versions are immutable
    // and append-only, so the highest version is the current one.
    const { data: masterRow, error: masterError } = await db
      // Versioned profile table (core_tables.sql).
      .from("master_profiles")
      // Only the profile JSON is needed.
      .select("profile")
      // Newest first.
      .order("version", { ascending: false })
      // Just the current version.
      .limit(1)
      // Zero rows is a state, not an error.
      .maybeSingle();
    // A failed read must not be mistaken for "no profile".
    if (masterError) throw new Error(`master_profiles read failed: ${masterError.message}`);
    // No profile: every required skill would count as a gap, which is noise, not a report.
    if (!masterRow) {
      // Recorded so the health page names the missing prerequisite instead of "idle".
      await closeRun({ status: "failed", error_detail: "master_profiles is empty" });
      // A state the user must fix, not a transient fault.
      return jsonResponse(409, { error: "no_master_profile" });
    }
    // The stored JSON, typed for the diff helper.
    const candidateProfile = masterRow.profile as MasterProfile;

    // The job side: description text lives on `jobs`, reached through `applications.job_id`.
    const { data: applications, error: appsError } = await db
      // Applications carry the status filter.
      .from("applications")
      // Embed the parent job's raw description; applications has no description column.
      .select("id, jobs(description_raw)")
      // Jobs the pipeline judged worth pursuing, i.e. real demand signals.
      .in("status", ["scored", "applied"])
      // Bound memory per run.
      .limit(APPLICATION_SCAN_LIMIT);
    // A failed read aborts; an empty report would look like "no gaps".
    if (appsError) throw new Error(`applications read failed: ${appsError.message}`);

    // skill -> number of jobs that need it and the candidate lacks.
    const skillDemandMap = new Map<string, number>();
    // One pass over the applications.
    for (const app of applications ?? []) {
      // The job description, or null when the embed is missing or blank.
      const description = descriptionOf((app as { jobs?: unknown }).jobs);
      // Nothing to extract from; skipping beats counting an empty job.
      if (description === null) continue;
      // Skills the job asks for.
      const requiredSkills = extractRequiredSkills(description);
      // Those the profile does not cover.
      const gaps = computeSkillGaps({ requiredSkills, candidateProfile });
      // Tally each missing skill once per job.
      for (const gap of gaps) skillDemandMap.set(gap.skill, (skillDemandMap.get(gap.skill) ?? 0) + 1);
    }

    // One timestamp for the whole batch, so rows written together read as one report.
    const now = new Date().toISOString();
    // Rows for the upsert. `user_id` is explicit: the conflict target includes it, and the
    // table has no default for it.
    const upsertRecords = Array.from(skillDemandMap.entries()).map(([skill, count]) => ({
      // Tenant column, half of the unique key.
      user_id: connection.userId,
      // The other half of the unique key.
      skill_name: skill,
      // Demand within this scan.
      demand_count: count,
      // The real column name (phase3 migration); `last_calculated_at` never existed.
      last_seen_at: now,
      // No trigger maintains this column, so the writer must.
      updated_at: now,
    }));

    // Skip the round trip when there is nothing to write.
    if (upsertRecords.length > 0) {
      // Insert-or-update keyed on the table's actual unique constraint.
      const { error: upsertError } = await db
        // The report table.
        .from("skill_gap_reports")
        // `UNIQUE(user_id, skill_name)` — `skill_name` alone matches no constraint and
        // PostgREST rejects the upsert.
        .upsert(upsertRecords, { onConflict: "user_id,skill_name" });
      // A failed write is a failed run.
      if (upsertError) throw new Error(`skill_gap_reports upsert failed: ${upsertError.message}`);
    }

    // No per-row errors exist here — any failure throws to the catch — so the honest
    // pattern reduces to `succeeded` with the counters. rows_out is skills written, the
    // unit this aggregator produces.
    await closeRun({ status: "succeeded", error_detail: null, rows_in: (applications ?? []).length, rows_out: upsertRecords.length, error_count: 0 });
    // Success: report how many skills were written.
    return jsonResponse(200, { success: true, aggregatedSkills: upsertRecords.length });
  } catch (err) {
    // Full detail to the server log only; it can carry table and constraint names.
    console.error("[skill-gap] run failed:", err);
    // The health page's detail, capped like every agent's error_detail.
    await closeRun({ status: "failed", error_count: 1, error_detail: (err instanceof Error ? err.message : String(err)).slice(0, 500) });
    // A fixed code to the caller.
    return jsonResponse(500, { error: "skill_gap_failed" });
  }
}
