// jd-refetch — Deno entry point (S8, 2026-11-21). All decisions live in handler.ts (node-tested);
// this file only plugs the real network, render service and database into its seams.
//
// Teja, 2026-11-21 14:41 IST: "no-description jobs: Playwright confirm + read JD + tailor straight into
// the approval queue, on a cron." handler.ts's header has the whole flow and why each step is there.
//
// Contract: POST { skip_ids?: string[] } with the app user's JWT (the workflow signs in as that user).
// ONE row per call, on purpose: the pipeline runs in this isolate's background and shares its 150 s wall
// clock with the page read and the render (up to 60 s), so a second row would cut the first one's chain.
// .github/workflows/jd-refetch.yml loops calls and sends the ids it already tried as skip_ids.
// ponytail: one row per call; move to one invocation per pipeline step if a chain gets cut off.
// 200 { status:'ok', outcome: RefetchOutcome | { kind:'none' }, application_id: string | null }
// 4xx/5xx { status:'error', message }.

// Signs in as the app user WITH the agent key header (client.ts), so `matcher` moves pass the guard.
import { createAuthorizedAppUserClient } from "../_shared/db/client.ts";
// A crash still answers JSON with CORS.
import { withErrorBoundary } from "../_shared/cors.ts";
// The robots-gated text GET (robots checked inside the transport before the site is contacted).
import { httpText } from "../_shared/http/index.ts";
// The browser render service (Vercel); robots is checked by the plain GET first, in handler.ts.
import { renderPage } from "../job-link-intake/page-readers.ts";
// The provider API liveness check and its URL builder, as scout-ats's queue sweep uses them.
import { checkPosting, postingCheckUrl } from "../_shared/scout/queue-liveness.ts";
// scout-ats's robots-gated board GET: the liveness endpoints are board-API URLs.
import { fetchBoard } from "../scout-ats/poll-fetch.ts";
// The matcher's own pre-gate: the re-screen is the matcher's gate, so the two can never disagree.
import { preGateRow } from "../matcher/tech-pregate.ts";
// Its client shape (supabase-js satisfies it structurally).
import type { MatchScoreClient } from "../matcher/write-score.ts";
// Today's gate config, the same two reads the matcher and auditor make.
import { loadPreGatePreferences, type ConfigReader } from "../_shared/pregate-config-loader.ts";
// The Ashby location hints, selected the way the matcher selects them.
import { BOARD_HINT_SELECT, boardHintsFromSelect } from "../_shared/screen/work-auth-gate.ts";
// The server pipeline engine job-link-intake uses (matcher -> tailor -> auditor).
import { PASSED_FILTERS_STEPS, runRowPipeline, type RowPipelineDeps } from "../_shared/pipeline/row-pipeline.ts";
// The decisions.
import { pickCandidate, readJobDescription, refetchOne, type Candidate } from "./handler.ts";
// Supabase's background-task hook. Deno's own types do not declare it.
declare const EdgeRuntime: { waitUntil(promise: Promise<unknown>): void };

// The signed-in client type, as createAuthorizedAppUserClient returns it.
type Db = Extract<Awaited<ReturnType<typeof createAuthorizedAppUserClient>>, { ok: true }>["db"];

// How many passed_filters rows one call scans for a thin one, oldest first. The scan reads only
// description_preview (600 chars), never the full text.
// ponytail: a fixed window; if over 1000 non-thin rows sit at passed_filters, the newest thin ones wait.
const SCAN_LIMIT = 1000;
// How many picks one call may try before it gives up (a preview that looked thin but a full text that is not).
const MAX_PICKS = 5;
// skip_ids above this is a caller bug, refused rather than turned into a huge filter.
const MAX_SKIP_IDS = 200;
// A uuid, the only shape an application id has.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// One JSON answer.
function json(status: number, body: unknown): Response {
  // CORS is added by withErrorBoundary.
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

// The request body: an optional list of uuids. Anything else is refused, never read as "no skips".
function parseSkipIds(raw: unknown): Set<string> | null {
  // An empty body or {} is no skips.
  if (raw === null || raw === undefined) return new Set();
  // Must be an object.
  if (typeof raw !== "object" || Array.isArray(raw)) return null;
  // The one field.
  const ids = (raw as { skip_ids?: unknown }).skip_ids;
  // Absent: no skips.
  if (ids === undefined) return new Set();
  // An array of uuids, capped.
  if (!Array.isArray(ids) || ids.length > MAX_SKIP_IDS || !ids.every((id) => typeof id === "string" && UUID.test(id))) return null;
  // The set.
  return new Set(ids as string[]);
}

// The pipeline engine's two effects over the app-user client. A copy of job-link-intake/index.ts
// makeChainDeps (that file runs Deno.serve on import, so it cannot be imported).
// ponytail: two copies; move both into _shared/pipeline/ when one of them changes.
function makeChainDeps(db: Db): RowPipelineDeps {
  // The deps object.
  return {
    // One agent call for one row, the id in the query string as the browser sends it.
    async invoke(step, applicationId) {
      // A throw is a failed call, never an escape from the engine.
      try {
        // The client carries the app user's session, which each agent's caller gate requires.
        const { data, error } = await db.functions.invoke(`${step}?application_id=${encodeURIComponent(applicationId)}`);
        // supabase-js reports HTTP failures in `error`; the engine stops on ok:false.
        if (error) return { ok: false, httpStatus: null, body: { error: error.message } };
        // The body goes to the engine, which checks it for halts and per-row failures.
        return { ok: true, httpStatus: null, body: data };
      } catch (err) {
        // No response at all.
        return { ok: false, httpStatus: null, body: { error: err instanceof Error ? err.message : String(err) } };
      }
    },
    // The database is the only judge of where the row went.
    async readStatus(applicationId) {
      // RLS scopes the read to the app user's own rows.
      const { data, error } = await db.from("applications").select("status").eq("id", applicationId).maybeSingle();
      // Only a string is a status.
      return error === null && typeof data?.status === "string" ? data.status : null;
    },
  };
}

// The selected row, as PostgREST returns it. Every field is checked before use.
type ScanRow = { id?: unknown; jobs?: Record<string, unknown> | null };

// One scanned row as a candidate, or null when a field has the wrong shape (missing data is not an answer).
function toCandidate(row: ScanRow, description: string | null, boardToken: string | null): Candidate | null {
  // The embedded job.
  const job = row.jobs;
  // Required shapes only.
  if (typeof row.id !== "string" || job === null || job === undefined || typeof job.id !== "string" || typeof job.title !== "string" || !Array.isArray(job.discovered_via) || typeof job.ats_provider !== "string") return null;
  // The candidate.
  return {
    applicationId: row.id,
    jobId: job.id,
    discoveredVia: job.discovered_via as string[],
    job: {
      title: job.title,
      descriptionRaw: description,
      locationRaw: typeof job.location_raw === "string" ? job.location_raw : null,
      board: boardHintsFromSelect(job),
      minExperienceYears: typeof job.min_experience_years === "number" || typeof job.min_experience_years === "string" ? job.min_experience_years : null,
    },
    atsProvider: job.ats_provider,
    atsJobId: typeof job.ats_job_id === "string" ? job.ats_job_id : null,
    applyUrl: typeof job.apply_url === "string" ? job.apply_url : null,
    boardToken,
  };
}

// Entry point.
Deno.serve(withErrorBoundary("jd-refetch", async (req) => {
  // POST only.
  if (req.method !== "POST") return json(405, { status: "error", message: "POST only" });
  // The body; an unreadable one is refused.
  let body: unknown = null;
  try {
    // An empty body is allowed.
    const text = await req.text();
    // Parsed when present.
    body = text.trim() === "" ? null : JSON.parse(text);
  } catch {
    // Not JSON.
    return json(400, { status: "error", message: "body must be JSON" });
  }
  // The skip list.
  const skipIds = parseSkipIds(body);
  // Wrong shape.
  if (skipIds === null) return json(400, { status: "error", message: `skip_ids must be an array of at most ${MAX_SKIP_IDS} uuids` });
  // The caller first, then the sign-in (W15): a refused caller costs no password grant.
  const client = await createAuthorizedAppUserClient(req);
  // Refused caller.
  if (!client.ok && client.kind === "refused") return json(client.status, { status: "error", message: client.error });
  // Our failure.
  if (!client.ok) return json(503, { status: "error", message: "sign-in unavailable" });
  // The signed-in client.
  const db = client.db;
  // Today's gate config; a failed read stops the call (read as "no config" it would pass everything).
  const prefs = await loadPreGatePreferences(db as unknown as ConfigReader);
  // Stop.
  if (prefs.kind === "error") return json(503, { status: "error", message: `${prefs.code}: ${prefs.message}` });
  // The scan: oldest passed_filters rows, preview only.
  const scan = await db
    .from("applications")
    .select(`id, jobs!inner(id, title, description_preview, location_raw, min_experience_years, discovered_via, ats_job_id, apply_url, company_slug, ${BOARD_HINT_SELECT})`)
    .eq("status", "passed_filters")
    .order("updated_at", { ascending: true })
    .limit(SCAN_LIMIT);
  // A failed read is an error, never "nothing to do".
  if (scan.error) return json(503, { status: "error", message: `scan: ${scan.error.message}` });
  // Candidates on the preview; the full text is read only for the one picked.
  const scanned = ((scan.data ?? []) as unknown as ScanRow[])
    .map((row) => toCandidate(row, typeof row.jobs?.description_preview === "string" ? row.jobs.description_preview : null, null))
    .filter((c): c is Candidate => c !== null);
  // The ids this call looked at and rejected, on top of the caller's.
  const tried = new Set(skipIds);
  // Up to MAX_PICKS picks.
  for (let pick = 0; pick < MAX_PICKS; pick += 1) {
    // The next thin row by its preview.
    const preview = pickCandidate(scanned, tried);
    // None left.
    if (preview === null) break;
    // Not picked again in this call.
    tried.add(preview.applicationId);
    // The full description and the board token, for this one row.
    const full = await db.from("jobs").select("description_raw, company_slug").eq("id", preview.jobId).maybeSingle();
    // A failed read is this row's error.
    if (full.error || !full.data) return json(200, { status: "ok", application_id: preview.applicationId, outcome: { kind: "error", message: `job read: ${full.error?.message ?? "missing"}` } });
    // The full text (null stays null).
    const description = typeof full.data.description_raw === "string" ? full.data.description_raw : null;
    // The board token from the watchlist (provider + slug); untracked = null = liveness "unknown".
    const watch = await db.from("company_watchlist").select("board_token").eq("ats_provider", preview.atsProvider).eq("company_slug", full.data.company_slug).limit(1);
    // A failed read is treated as untracked: liveness then says "unknown", which never closes anything.
    const boardToken = !watch.error && typeof watch.data?.[0]?.board_token === "string" ? watch.data[0].board_token as string : null;
    // The real candidate, on the full text.
    const row: Candidate = { ...preview, job: { ...preview.job, descriptionRaw: description }, boardToken };
    // The full text is not thin after all: next pick.
    if (pickCandidate([row], skipIds) === null) continue;
    // The caller's JWT, forwarded to the render service (it accepts only the app user).
    const authorization = req.headers.get("authorization") ?? "";
    // The flow.
    const outcome = await refetchOne(row, {
      // Provider API liveness; anything without an API or a usable id is "unknown".
      async liveness(c) {
        // The provider's per-posting URL (Workday from the apply link, which needs no token).
        const url = c.boardToken === null && c.atsProvider !== "workday"
          ? null
          : postingCheckUrl(c.atsProvider, c.boardToken ?? "", { id: c.jobId, fingerprint: "", disappeared_at: null, ats_job_id: c.atsJobId, apply_url: c.applyUrl, applications: null });
        // No API: the page read decides (its own 404 closes).
        if (url === null) return "unknown";
        // Robots-gated; never throws.
        return await checkPosting((u) => fetchBoard(u), c.atsProvider, url, c.atsJobId);
      },
      // The page, robots-gated, then the render.
      readJd: (url) => readJobDescription(url, {
        // 404 -> null; other failures throw typed errors handler.ts classifies.
        getPage: (u) => httpText(u, { notFound: "null", headers: { "Accept": "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8" }, retry: { maxRetries: 1 } }),
        // One render.
        render: (u) => renderPage(u, authorization, fetch),
      }),
      // passed_filters -> failed (posting_closed) as `matcher`; the RPC copies reason into failure_reason.
      async closeRow(applicationId, evidence) {
        // The only route that changes a status (repo CLAUDE.md §7).
        const { error } = await db.rpc("advance_application_status", { p_application_id: applicationId, p_to_status: "failed", p_agent: "matcher", p_detail: { reason: "posting_closed", stage: "jd_refetch", evidence } });
        // null = moved.
        return error ? error.message : null;
      },
      // The JD, and tombstoned_at cleared so the slim-tombstone trigger keeps it (job-link-intake does the same).
      async writeDescription(jobId, text) {
        // One write.
        const { error } = await db.from("jobs").update({ description_raw: text, tombstoned_at: null }).eq("id", jobId);
        // null = written.
        return error ? error.message : null;
      },
      // The matcher's own gate.
      preGate: (applicationId, job) => preGateRow(db as unknown as MatchScoreClient, applicationId, job, prefs.preferences),
      // matcher -> tailor -> auditor in the background.
      runPipeline(applicationId) {
        // Built eagerly, so it proceeds even where waitUntil is missing.
        const run = runRowPipeline(makeChainDeps(db), applicationId, PASSED_FILTERS_STEPS)
          // The end lands in the function logs.
          .then((result) => console.log(JSON.stringify({ event: "jd_refetch_pipeline", application_id: applicationId, outcome: result })))
          // The engine does not throw; a backstop.
          .catch((err) => console.error(JSON.stringify({ event: "jd_refetch_pipeline_crashed", application_id: applicationId, error: String(err) })));
        // Keeps the isolate alive past the response.
        try {
          // Supabase edge runtime.
          EdgeRuntime.waitUntil(run);
        } catch {
          // Plain Deno: the run already started.
        }
      },
    });
    // One log line per row.
    console.log(JSON.stringify({ event: "jd_refetch", application_id: row.applicationId, outcome }));
    // One row per call.
    return json(200, { status: "ok", application_id: row.applicationId, outcome });
  }
  // Nothing thin left to try.
  return json(200, { status: "ok", application_id: null, outcome: { kind: "none" } });
}));
