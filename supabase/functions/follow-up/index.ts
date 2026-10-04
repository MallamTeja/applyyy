// Follow-up — Edge Function that drafts follow-up nudge emails for stale applications.
//
// Reads applications at status `applied` older than seven days, drafts one nudge each
// through Gemini (falling back to a template), and inserts it into `follow_up_nudges`
// for the user to review.
//
// REWRITTEN 2026-10-04. Before this, every insert failed: it wrote `subject`/`body`/
// `status:'draft'` into a table whose NOT NULL columns are `user_id`, `job_id`,
// `draft_subject` and `draft_body`; it selected `company_name`/`job_title` from
// `applications`, which has neither; and it logged agent runs under a column
// (`agent_name`) that does not exist. All three errors were logged and swallowed.
//
// NO agent_runs ROW, DELIBERATELY: `agent_runs.agent` is the `agent_name` enum and no
// member names this function (enums.sql:165 + keepalive). Borrowing `tracker` would make
// the health page report the email tracker alive when it is not. Telemetry returns when
// a migration adds an enum value; the old insert never landed anyway.

// Signs in as the app user, so every query runs under RLS.
import { createAppUserClient } from "../_shared/db/client.ts";
// Caller auth and the fail-closed kill switch, shared with the pipeline agents.
import { authorizeCaller, readKillSwitch } from "../_shared/db/gates.ts";
// Shared CORS headers, plus the boundary that keeps them on an uncaught 500.
import { corsHeaders, withErrorBoundary } from "../_shared/cors.ts";
// Draft generation (Gemini with template fallback).
import { generateFollowUpNudge } from "../_shared/follow-up/nudge.ts";
// Row validation and the insert's exact column names, pinned by nudge-row.test.ts.
import { readNudgeSource, toNudgeInsert } from "../_shared/follow-up/nudge-row.ts";

// How many nudges one invocation drafts. Small: each one may be a Gemini call.
const BATCH_SIZE = 5;
// An application must have gone quiet this long before nudging is polite.
const FOLLOW_UP_AFTER_DAYS = 7;

// One JSON response shape for every exit.
function jsonResponse(status: number, data: Record<string, unknown>): Response {
  // CORS on every response, or the browser hides the status from the page.
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...corsHeaders },
  });
}

// Wrapped so a throw anywhere below still answers with CORS headers.
Deno.serve(withErrorBoundary("applyy-follow-up", async (req: Request): Promise<Response> => {
  // Preflight, before any work.
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  // Sign in; a missing credential is an operational 503, not a bug.
  const connection = await createAppUserClient();
  if (!connection.ok) {
    // `reason` stays in the log — it distinguishes "no user" from "wrong password".
    console.error("[applyy-follow-up] could not sign in:", connection.reason);
    return jsonResponse(503, { success: false, error: "database_unavailable" });
  }
  // Unpacked once for readability.
  const db = connection.db;

  // Only the app user may trigger drafting under the app user's session.
  const caller = await authorizeCaller(req, db, connection.userId);
  // 401 or 403, as the verdict says.
  if (!caller.ok) return jsonResponse(caller.status, { success: false, error: caller.error });

  // Same fail-closed switch as the pipeline agents.
  const killSwitch = await readKillSwitch(db);
  // A broken read is retryable, so 503.
  if (killSwitch.kind === "unreadable") return jsonResponse(503, { success: false, error: "kill_switch_read_failed" });
  // Off: a deliberate halt, not an error.
  if (killSwitch.kind === "disabled") return jsonResponse(200, { success: true, status: "skipped_disabled" });

  // Applications that already have a nudge. Excluded up front, because now that
  // inserts succeed, re-running would otherwise draft a duplicate every invocation —
  // and filtering after the `limit` would starve the queue on the same five rows.
  const { data: existing, error: existingError } = await db.from("follow_up_nudges").select("application_id");
  // Without this list we cannot avoid duplicates, so stop rather than guess.
  if (existingError) return jsonResponse(503, { success: false, error: "nudges_unreadable" });
  // The ids to skip, as strings for the postgrest `in` list.
  const nudgedIds = (existing ?? []).map((r) => String((r as { application_id: unknown }).application_id));

  // The cut-off: applied at least FOLLOW_UP_AFTER_DAYS ago.
  const cutoff = new Date(Date.now() - FOLLOW_UP_AFTER_DAYS * 24 * 60 * 60 * 1000).toISOString();
  // Company and title live on `jobs` (core_tables.sql:190-192), so they come via the join.
  let query = db
    .from("applications")
    .select("id, user_id, job_id, applied_at, jobs ( title, company_name )")
    .eq("status", "applied")
    .lte("applied_at", cutoff)
    // Oldest first: the longest-silent application is the one most worth a nudge.
    .order("applied_at", { ascending: true })
    .limit(BATCH_SIZE);
  // Skip already-nudged rows. Only applied when non-empty: `not in ()` is a syntax error.
  if (nudgedIds.length > 0) query = query.not("id", "in", `(${nudgedIds.join(",")})`);
  // Run it.
  const { data: applications, error: appsError } = await query;
  // A failed read is reported, not mistaken for "nothing to do".
  if (appsError) return jsonResponse(503, { success: false, error: "applications_unreadable" });

  // Counters reported back so a run that wrote nothing is visible as such.
  let drafted = 0;
  // Per-row failures with their reason.
  const failures: Array<{ applicationId: string; error: string }> = [];

  // Sequential: each may be a Gemini call against the shared key pool.
  for (const row of applications ?? []) {
    // Validate the row's shape before anything reaches the prompt or the insert.
    const source = readNudgeSource(row);
    // Incomplete row (no posting joined, missing id): reported, never half-written.
    if (!source) {
      failures.push({ applicationId: String((row as { id?: unknown }).id), error: "incomplete_application_row" });
      continue;
    }

    // Draft; never throws — falls back to a template on any model failure.
    const draft = await generateFollowUpNudge(db, {
      companyName: source.companyName,
      jobTitle: source.jobTitle,
      applicationDate: source.appliedAt,
    });

    // Insert with the migration's real column names, and CHECK the error.
    const { error: insertError } = await db.from("follow_up_nudges").insert(toNudgeInsert(source, draft));
    // A failed insert is counted and reported, not just logged.
    if (insertError) failures.push({ applicationId: source.applicationId, error: insertError.message });
    // Landed.
    else drafted += 1;
  }

  // The summary a caller can act on.
  return jsonResponse(200, { success: true, drafted, failures });
}));
