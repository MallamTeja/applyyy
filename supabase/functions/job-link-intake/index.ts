// job-link-intake — Deno entry point. All decisions live in handler.ts (node-testable);
// this file only plugs the real network, Gemini and database into the handler's seams.
//
// Contract: POST { url: string, text?: string } with the app user's JWT.
// 200 { status:'ok', application_id, pipeline_started, application_status, created, revived_from, source, job }
// 4xx/5xx { status, message } where status is one of needs_text | not_a_job | posting_closed |
// quota | upstream_unavailable | disabled | unauthorized | cannot_restart (409: a failed row the
// database will not move back, e.g. it failed after approval) | error. After a 200 with
// pipeline_started, THIS function runs matcher -> tailor -> auditor on application_id in the
// background (EdgeRuntime.waitUntil), so the run survives the tab closing (Teja, 2026-11-01:
// "no need of me pressing that button"). The browser only watches the row's status.

// Signs in as the app user; every query below runs under that user's RLS.
import { createAppUserClient } from "../_shared/db/client.ts";
// A crash still answers JSON with CORS.
import { withErrorBoundary } from "../_shared/cors.ts";
// The shared Gemini client: key pool, pacing, failover.
import { generateGeminiContent } from "../_shared/gemini/client.ts";
// The SSRF-safe page fetch: every redirect hop re-checked before it is requested.
import { fetchPublicPage } from "./fetch-page.ts";
// The hop that connects to the checked IP instead of re-resolving the name (audit W17). It replaced
// httpFetch here, keeping that call's deadline, User-Agent and status mapping.
import { fetchPinnedHop } from "./pinned-get.ts";
// scout-web's robots-gated board fetch, reused for the ATS path.
import { makeFetchBoard } from "../scout-web/fetch-board.ts";
// The decisions and the seam types.
import { handleJobLinkIntake, type IntakeStore } from "./handler.ts";
// Row and status types for the narrow casts below.
import type { ApplicationStatus } from "../_shared/contracts/shared-types.ts";
// The engine behind the web's "Send through pipeline", reused so the server run and a manual
// click share every stop rule (skip, halt, no progress). It imports nothing, so Deno loads it as is.
// From _shared, never apps/web: the web auto-deploys and this function does not (audit W26).
import { PASSED_FILTERS_STEPS, runRowPipeline, type RowPipelineDeps } from "../_shared/pipeline/row-pipeline.ts";
// The client type the Gemini helper takes (scout-web reads it the same way; client.ts does not export it).
type SupabaseClient = Parameters<typeof generateGeminiContent>[0];
// Supabase's background-task hook. Deno's own types do not declare it.
declare const EdgeRuntime: { waitUntil(promise: Promise<unknown>): void };

// The engine's two effects over the signed-in app-user client: the same calls the browser deps
// make (apps/web rowPipelineDeps.ts), so each agent sees an identical request. Neither throws.
function makeChainDeps(db: SupabaseClient): RowPipelineDeps {
  // The deps object.
  return {
    // One agent call for one row; the id rides in the query string, as the browser sends it.
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
      // Only a string is a status; an error or a missing row is "could not read".
      return error === null && typeof data?.status === "string" ? data.status : null;
    },
  };
}

// Runs matcher -> tailor -> auditor for one row after the response, and logs where it ended.
// ponytail: one isolate runs all three agents, so the whole chain shares this request's 150 s wall
// clock (_shared/agent/deadline.ts). A slow tailor can be cut off mid-chain; the row then waits at
// scored/tailored and the panel offers "Send through pipeline". Upgrade: one invocation per step.
function startServerPipeline(db: SupabaseClient, applicationId: string): void {
  // Built eagerly, so the run proceeds even where waitUntil is missing (it just is not kept alive).
  const run = runRowPipeline(makeChainDeps(db), applicationId, PASSED_FILTERS_STEPS)
    // The outcome lands in the function logs, the one place a background run can report to.
    .then((outcome) => console.log(JSON.stringify({ event: "job_link_pipeline", application_id: applicationId, outcome })))
    // The engine does not throw; this is the backstop that keeps an unhandled rejection out of the isolate.
    .catch((err) => console.error(JSON.stringify({ event: "job_link_pipeline_crashed", application_id: applicationId, error: String(err) })));
  // Keeps the isolate alive past the response until the run settles.
  try {
    // Supabase edge runtime: the documented background-task hook.
    EdgeRuntime.waitUntil(run);
  } catch {
    // Plain Deno (local tooling) has no EdgeRuntime; the run above already started.
  }
}

// One robots cache per isolate, as scout-web does. The ATS board path stays robots-gated.
const fetchBoard = makeFetchBoard();

// "No records of this type" is an empty answer; every other resolver failure must refuse the fetch.
function noRecords(err: unknown): string[] {
  // NXDOMAIN / NODATA for one family is normal (an IPv4-only host has no AAAA).
  if (err instanceof Deno.errors.NotFound) return [];
  // SERVFAIL, timeouts, an unsupported runtime: rethrown, so fetchPage reports and refuses.
  throw err;
}

// The real store over one signed-in client. Every method returns values, never throws.
function makeStore(db: SupabaseClient): IntakeStore {
  // The store.
  return {
    // The tracked board's name, or null when untracked.
    async watchlistName(provider, token) {
      // Provider AND token: tokens repeat across ATSes.
      const { data, error } = await db.from("company_watchlist").select("company_name, company_slug").eq("ats_provider", provider).eq("board_token", token).maybeSingle();
      // Reported, never mistaken for "untracked".
      if (error) return { ok: false, reason: error.message };
      // Untracked is a legitimate answer.
      return { ok: true, name: data ? { companyName: data.company_name as string, companySlug: data.company_slug as string } : null };
    },
    // Insert-if-absent, then read back (an ignored duplicate returns nothing from the upsert).
    async upsertJob(row) {
      // ignoreDuplicates: an existing (scouted, richer) row is never overwritten.
      const { error } = await db.from("jobs").upsert(row, { onConflict: "user_id,fingerprint", ignoreDuplicates: true });
      // Stop: nothing to link an application to.
      if (error) return { ok: false, reason: `jobs_upsert: ${error.message}` };
      // Either the new row or the pre-existing one; (user_id, fingerprint) is unique, so at most one.
      // description_raw (W3): the handler compares it with the paste to decide a fill.
      const { data, error: readError } = await db.from("jobs").select("id, discovered_via, disappeared_at, description_raw").eq("fingerprint", row.fingerprint).maybeSingle();
      // A failed read is reported, never "not found".
      if (readError) return { ok: false, reason: `jobs_read: ${readError.message}` };
      // The upsert just ran, so absence means the insert was refused (e.g. RLS).
      if (!data) return { ok: false, reason: "jobs_read: row missing after upsert" };
      // discovered_via is a text[] enum array; anything else is a contract break.
      if (!Array.isArray(data.discovered_via)) return { ok: false, reason: "jobs_read: discovered_via is not an array" };
      // A text column: a string or null, nothing else. An absent key (undefined) is a select
      // that lost the column, and read as "no description" it would turn every paste into a fill.
      if (data.description_raw !== null && typeof data.description_raw !== "string") return { ok: false, reason: "jobs_read: description_raw is neither text nor null" };
      // Narrowed to the four facts the handler uses.
      return { ok: true, job: { id: data.id as string, discoveredVia: data.discovered_via as string[], disappearedAt: (data.disappeared_at as string | null) ?? null, descriptionRaw: data.description_raw } };
    },
    // Tag a pre-existing row as human-picked and live, and fill its description when told to.
    async tagManual(jobId, discoveredVia, descriptionRaw) {
      // One write. description_raw is named only for a fill (W3), so a plain tag can never
      // null out a scouted description; every other scouted column is left as it was.
      const { error } = await db.from("jobs").update({ discovered_via: discoveredVia, disappeared_at: null, ...(descriptionRaw !== null ? { description_raw: descriptionRaw } : {}) }).eq("id", jobId);
      // Null means it landed.
      return error ? error.message : null;
    },
    // Insert-if-absent at passed_filters, then read back.
    async upsertApplication(jobId) {
      // The insert guard allows passed_filters (20260917130000); a literal, never caller input.
      const { data: inserted, error } = await db.from("applications").upsert({ job_id: jobId, status: "passed_filters", drop_reason: null }, { onConflict: "user_id,job_id", ignoreDuplicates: true }).select("id");
      // Stop: nothing to run.
      if (error) return { ok: false, reason: `applications_upsert: ${error.message}` };
      // The row as it stands, new or old.
      const { data, error: readError } = await db.from("applications").select("id, status").eq("job_id", jobId).maybeSingle();
      // Reported, never "not found".
      if (readError) return { ok: false, reason: `applications_read: ${readError.message}` };
      // Absent right after the upsert means it was refused.
      if (!data) return { ok: false, reason: "applications_read: row missing after upsert" };
      // created is true only when the upsert returned the row.
      return { ok: true, application: { id: data.id as string, status: data.status as ApplicationStatus, created: (inserted?.length ?? 0) > 0 } };
    },
    // The guarded move, as the human: the human pasted the link.
    async moveToPassedFilters(applicationId, detail) {
      // The only route that changes a status (repo CLAUDE.md §7).
      const { error } = await db.rpc("advance_application_status", { p_application_id: applicationId, p_to_status: "passed_filters", p_agent: "human", p_detail: detail });
      // Null means it moved.
      return error ? error.message : null;
    },
  };
}

// Entry point.
Deno.serve(withErrorBoundary("job-link-intake", (req) =>
  // Real seams into the tested handler.
  handleJobLinkIntake(req, {
    // The wall clock.
    now: () => new Date(),
    // Robots-gated board fetch.
    fetchBoard,
    // The pasted page (and the LinkedIn/X public endpoints) with every redirect hop DNS- and
    // address-checked (fetch-page.ts). Robots NOT checked; see fetchHop.
    async fetchPage(url) {
      // Typed failures become a reason string; this seam never throws.
      try {
        // Hops are plain GETs that hand redirects back; 'null' turns a 404 into null.
        return await fetchPublicPage(url, {
          // ROBOTS IS DELIBERATELY NOT CHECKED HERE. Teja's ruling, 2026-11-01 ~17:19 IST: a link
          // the human pastes is a USER-TRIGGERED fetch (one page, read once, because a person asked),
          // not crawling, so robots.txt does not apply to it or its redirect hops. Do not "restore"
          // the check: it made Tower Research and Databricks links unreadable (CI ingest run
          // 41294502085). Scouts, scout-web, the ATS board path (fetchBoard above) and the worker
          // stay robots-strict. The SSRF guard is untouched: fetchPublicPage still shape-, DNS- and
          // address-checks every hop, caps redirects and bytes. `robots: false` also means the
          // transport never fetches a robots.txt, whose own redirects could reach a private host.
          // DNS REBINDING CLOSED (audit W17, 2026-11-02): the hop connects to the address the guard
          // just checked, by IP literal, and runs TLS with the real name for SNI and the certificate
          // check. fetch() would resolve the name again, which a zero-TTL answer can point at
          // 10.x, 127.x or 169.254.169.254. One attempt, no retries, as before (pinned-get.ts).
          fetchHop: (hop, address) => fetchPinnedHop(hop, address, {
            // TCP to the checked IP; TLS verifies the certificate against serverName, not the IP.
            openTls: async (address, serverName) => await Deno.startTls(await Deno.connect({ hostname: address, port: 443 }), { hostname: serverName }),
          }),
          // A and AAAA looked up separately: a host with only one family answers NotFound for the other.
          // Any OTHER resolver error throws, so the fetch is refused rather than checked on half the answer.
          resolve: async (host) => [
            // IPv4 addresses, or none.
            ...(await Deno.resolveDns(host, "A").catch(noRecords)),
            // IPv6 addresses, or none.
            ...(await Deno.resolveDns(host, "AAAA").catch(noRecords)),
          ],
        });
      } catch (err) {
        // Bot walls, HTTP errors, timeouts, network: named, and the ladder moves to the browser.
        return { ok: false, reason: err instanceof Error ? err.message : String(err) };
      }
    },
    // The browser render service's POST; page-readers.ts builds the request and shape-checks the answer.
    renderFetch: fetch,
    // One JSON-mode call; a short budget, since a human is waiting on the response.
    extract: (db, prompt) => generateGeminiContent(db as SupabaseClient, { prompt, timeoutMs: 20_000, maxRetries: 2 }),
    // Lazy sign-in per request.
    async connect() {
      // Same sign-in every agent uses.
      const client = await createAppUserClient();
      // The reason stays in the log.
      if (!client.ok) return { ok: false, reason: client.reason };
      // Client for the gates and Gemini, store for the writes, and the server pipeline run.
      return { ok: true, userId: client.userId, db: client.db, store: makeStore(client.db), runPipeline: (id) => startServerPipeline(client.db, id) };
    },
  })
));
