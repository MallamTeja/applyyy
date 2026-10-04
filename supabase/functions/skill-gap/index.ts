// SKILL-GAP AGGREGATOR — counts which required skills the candidate's master profile lacks,
// across the jobs the pipeline has scored or applied to, into `skill_gap_reports`.
//
// Rewritten 2026-10-04 after an audit found every query and write in the old version
// named a column that does not exist (`applications.job_description`,
// `applications.candidate_profile`, `last_calculated_at`, `agent_runs.agent_name`), so
// the function had never produced a single row.
//
// NO `agent_runs` TELEMETRY, DELIBERATELY. The `agent_name` enum
// (20260909234500_enums.sql) has no value for this aggregator, and borrowing another
// agent's name would make the health page attribute these runs to that agent. The old
// insert named a missing column and so never wrote anything either; removing it changes
// no live behaviour. Restoring it needs an `alter type ... add value` migration first.

// CORS headers, so a browser-side caller can read failures as well as successes.
import { corsHeaders } from "../_shared/cors.ts";
// The app-user client: every read and write below runs under RLS as that user.
import { createAppUserClient } from "../_shared/db/client.ts";
// Kill switch read through the shared helper, so this function fails closed the same way
// every pipeline agent does instead of with its own `.single()` variant.
import { readKillSwitch } from "../_shared/db/gates.ts";
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

// Entry point. Errors inside are caught below so the caller always gets JSON.
Deno.serve(async (req: Request): Promise<Response> => {
  // Preflight: answer before touching the database.
  if (req.method === "OPTIONS") {
    // 204 with CORS headers lets the browser send the real request.
    return new Response(null, { headers: corsHeaders, status: 204 });
  }

  // Sign in as the app user so RLS scopes every row to them.
  const connection = await createAppUserClient();
  // Without a session there is nothing safe to do.
  if (!connection.ok) {
    // The reason stays in the server log; it may name env vars.
    console.error("[skill-gap] database connection failed:", connection.reason);
    // 503: a configuration fault, retryable once fixed.
    return jsonResponse(503, { error: "database_unavailable" });
  }
  // The authenticated client used for the rest of the run.
  const db = connection.db;

  // Fail closed: only an explicit, readable "on" lets the run proceed.
  const killSwitch = await readKillSwitch(db);
  // Disabled and unreadable both halt, with different codes so the caller can tell.
  if (killSwitch.kind !== "enabled") {
    // The detail is operational, not secret, but still belongs in the log.
    console.warn("[skill-gap] kill switch:", killSwitch.kind, killSwitch.detail);
    // 503 either way: the run did not happen.
    return jsonResponse(503, { error: killSwitch.kind === "unreadable" ? "settings_unreadable" : "system_disabled" });
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
    if (!masterRow) return jsonResponse(409, { error: "no_master_profile" });
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

    // Success: report how many skills were written.
    return jsonResponse(200, { success: true, aggregatedSkills: upsertRecords.length });
  } catch (err) {
    // Full detail to the server log only; it can carry table and constraint names.
    console.error("[skill-gap] run failed:", err);
    // A fixed code to the caller.
    return jsonResponse(500, { error: "skill_gap_failed" });
  }
});
