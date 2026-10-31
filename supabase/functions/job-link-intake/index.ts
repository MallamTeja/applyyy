// job-link-intake — Deno entry point. All decisions live in handler.ts (node-testable);
// this file only plugs the real network, Gemini and database into the handler's seams.
//
// Contract: POST { url: string, text?: string } with the app user's JWT.
// 200 { status:'ok', application_id, application_status, created, revived_from, source, job }
// 4xx/5xx { status, message } where status is one of needs_text | not_a_job | posting_closed |
// quota | upstream_unavailable | disabled | unauthorized | error. The browser then runs
// matcher -> tailor -> auditor on application_id (apps/web AddJobLinkPanel).

// Signs in as the app user; every query below runs under that user's RLS.
import { createAppUserClient } from "../_shared/db/client.ts";
// A crash still answers JSON with CORS.
import { withErrorBoundary } from "../_shared/cors.ts";
// The shared Gemini client: key pool, pacing, failover.
import { generateGeminiContent } from "../_shared/gemini/client.ts";
// The robots-gated transport and its typed pre-contact refusal.
import { DEFAULT_USER_AGENT, httpFetch, RobotsDisallowedError } from "../_shared/http/index.ts";
// The robots gate itself, run here with a redirect-refusing fetcher.
import { checkRobots, tokenFromUserAgentHeader, type RobotsCache } from "../../../packages/master-robots/src/index.ts";
// The SSRF-safe page fetch: every redirect hop re-checked before it is requested.
import { fetchPublicPage } from "./fetch-page.ts";
// scout-web's robots-gated board fetch, reused for the ATS path.
import { makeFetchBoard } from "../scout-web/fetch-board.ts";
// The decisions and the seam types.
import { handleJobLinkIntake, type IntakeStore } from "./handler.ts";
// Row and status types for the narrow casts below.
import type { ApplicationStatus } from "../_shared/contracts/shared-types.ts";
// The client type the Gemini helper takes (scout-web reads it the same way; client.ts does not export it).
type SupabaseClient = Parameters<typeof generateGeminiContent>[0];

// One robots cache per isolate, as scout-web does.
const fetchBoard = makeFetchBoard();
// The page path's own robots cache (its checks bypass the transport's gate; see fetchPage).
const robotsCache: RobotsCache = new Map();
// The same product token the transport's gate derives, so sites see one consistent bot name.
const ROBOTS_TOKEN = tokenFromUserAgentHeader(DEFAULT_USER_AGENT);

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
      const { data, error: readError } = await db.from("jobs").select("id, discovered_via, disappeared_at").eq("fingerprint", row.fingerprint).maybeSingle();
      // A failed read is reported, never "not found".
      if (readError) return { ok: false, reason: `jobs_read: ${readError.message}` };
      // The upsert just ran, so absence means the insert was refused (e.g. RLS).
      if (!data) return { ok: false, reason: "jobs_read: row missing after upsert" };
      // discovered_via is a text[] enum array; anything else is a contract break.
      if (!Array.isArray(data.discovered_via)) return { ok: false, reason: "jobs_read: discovered_via is not an array" };
      // Narrowed to the three facts the handler uses.
      return { ok: true, job: { id: data.id as string, discoveredVia: data.discovered_via as string[], disappearedAt: (data.disappeared_at as string | null) ?? null } };
    },
    // Tag a pre-existing row as human-picked and live.
    async tagManual(jobId, discoveredVia) {
      // Both columns in one write.
      const { error } = await db.from("jobs").update({ discovered_via: discoveredVia, disappeared_at: null }).eq("id", jobId);
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
    // Robots-gated page fetch with every redirect hop DNS- and address-checked (fetch-page.ts).
    async fetchPage(url) {
      // Typed failures become a reason string; this seam never throws.
      try {
        // Hops are robots-checked GETs that hand redirects back; 'null' turns a 404 into null.
        return await fetchPublicPage(url, {
          // Robots asked HERE, not by the transport: the transport's robots fetch follows redirects,
          // so a robots.txt 302 could walk into a private host (security review, 2026-10-31).
          fetchHop: async (hop) => {
            // A null token fails closed, as in the transport: guessing one would match the "*" group.
            if (ROBOTS_TOKEN === null) throw new Error("no robots product token; refusing to fetch");
            // Same host as the hop, already DNS-checked; a redirecting robots.txt is "indeterminate" and refused.
            const verdict = await checkRobots(hop, ROBOTS_TOKEN, { cache: robotsCache, fetcher: (u, init) => fetch(u, { ...init, redirect: "manual" }) });
            // Only an explicit allow fetches the page (fail closed, like the transport's gate).
            if (verdict.kind !== "allow") throw new Error("the site does not allow automated reading");
            // No retries: each retry re-resolves DNS, widening the rebinding window the check cannot close.
            return await httpFetch(hop, { robots: false, redirect: "manual", notFound: "null", retry: { maxRetries: 0 } });
          },
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
        // The expected case for LinkedIn and most social sites.
        if (err instanceof RobotsDisallowedError) return { ok: false, reason: "the site does not allow automated reading" };
        // Bot walls, timeouts, network: named.
        return { ok: false, reason: err instanceof Error ? err.message : String(err) };
      }
    },
    // One JSON-mode call; a short budget, since a human is waiting on the response.
    extract: (db, prompt) => generateGeminiContent(db as SupabaseClient, { prompt, timeoutMs: 20_000, maxRetries: 2 }),
    // Lazy sign-in per request.
    async connect() {
      // Same sign-in every agent uses.
      const client = await createAppUserClient();
      // The reason stays in the log.
      if (!client.ok) return { ok: false, reason: client.reason };
      // Client for the gates and Gemini, store for the writes.
      return { ok: true, userId: client.userId, db: client.db, store: makeStore(client.db) };
    },
  })
));
