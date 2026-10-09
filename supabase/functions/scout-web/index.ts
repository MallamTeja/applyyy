// Scout-Web — Edge Function Entrypoint
//
// Asks Gemini (with web search) for Greenhouse/Lever/Ashby posting URLs matching the
// user, then verifies every one against the live board before anything is stored.
// THE LLM PROPOSES, DETERMINISTIC CODE DISPOSES: see core.ts and urls.ts.
// This file is only the wiring of real seams (database, Gemini, robots-gated fetch).

// The same sign-in every other agent uses, so RLS confines every query to the app user.
import { createAppUserClient } from "../_shared/db/client.ts";
// Shared CORS headers and the wrapper that keeps an uncaught throw visible to the browser.
import { corsHeaders, withErrorBoundary } from "../_shared/cors.ts";
// The adapter owns each board's API URL, so no URL is ever built from model output.
import { getAdapter } from "../_shared/ats/registry.ts";
// The shared retrying transport, so we do not hand-roll fetch.
import { httpJson } from "../_shared/http/transport.ts";
// Gemini with key failover; the model name is deliberately left to the client's default.
import { generateGeminiContent, type GenerateGeminiOptions } from "../_shared/gemini/client.ts";
// One failure line for every Gemini caller: reason, HTTP status, short redacted detail.
import { describeGeminiFailure, formatGeminiFailure } from "../_shared/gemini/failure-message.ts";
// The blanking guard scout-ats uses; keeps one upsert from erasing stored fields.
import { planJobUpsertGroups } from "../_shared/screen/upsert-plan.ts";
// The robots gate, reached by relative path (as master-robots itself reaches into
// _shared), so no package.json edit or pnpm install is needed.
import { checkRobots } from "../../../packages/master-robots/src/index.ts";
// The pure pipeline's seam types and the applications row builder.
import { buildApplicationRows, QuotaExhaustedError, UpstreamUnavailableError, type FetchBoardFn, type SearchFn, type WatchlistName } from "./core.ts";
// The lifecycle, and the Store contract this file implements.
import { handleScoutWeb, type Store } from "./handler.ts";
// One-hop resolver for the Google redirect URLs that grounding metadata returns.
import { resolveGroundingRedirect } from "./redirects.ts";

// The product token robots.txt groups are matched against; must equal the transport's UA product.
const ROBOTS_PRODUCT_TOKEN = "applyy-scout";

// Production board fetch: robots first, then the shared retrying transport.
const fetchBoard: FetchBoardFn = async (provider, token) => {
  // The adapter owns the board API URL; the token was charset-validated by urls.ts.
  const adapter = getAdapter(provider);
  // A missing adapter is a build mismatch; refuse rather than guess a URL.
  if (adapter === null) return { ok: false, reason: "no_adapter" };
  // The exact URL we are about to request, which is also what robots is asked about.
  const url = adapter.buildRequestUrl(token);
  // Fail closed: only an explicit 'allow' proceeds ('wait' and 'refuse' both stop).
  const verdict = await checkRobots(url, ROBOTS_PRODUCT_TOKEN);
  // Report the verdict kind so the UI can tell robots refusals from network failures.
  if (verdict.kind !== "allow") return { ok: false, reason: `robots_${verdict.kind}: ${verdict.reason}` };
  try {
    // 'null' mode turns a 404 (dead board token) into null instead of a throw; two retries
    // keep a rate-limited host from eating the whole function's wall-clock budget.
    const payload = await httpJson<unknown>(url, { notFound: "null", retry: { maxRetries: 2 } });
    // A dead board means the model's URL cannot be real.
    if (payload === null) return { ok: false, reason: "board_not_found" };
    // Hand the raw payload to the adapter's own parser (in core.ts).
    return { ok: true, payload };
  } catch (err) {
    // Typed transport errors (bot protection, retries exhausted) become a reason string.
    return { ok: false, reason: `fetch_failed: ${err instanceof Error ? err.message : String(err)}` };
  }
};

// Pull web URIs out of an unknown groundingMetadata value, ignoring anything misshapen.
function groundingUris(meta: unknown): string[] {
  // Only a plain object can carry groundingChunks.
  if (typeof meta !== "object" || meta === null) return [];
  // Read through a loose record because the shape is not guaranteed.
  const chunks = (meta as Record<string, unknown>)["groundingChunks"];
  // A non-array means no usable chunks.
  if (!Array.isArray(chunks)) return [];
  // Collect only string uris found at chunk.web.uri.
  return chunks.flatMap((c: unknown) => {
    // Each chunk must itself be an object.
    const web = typeof c === "object" && c !== null ? (c as Record<string, unknown>)["web"] : undefined;
    // And so must its web member.
    const uri = typeof web === "object" && web !== null ? (web as Record<string, unknown>)["uri"] : undefined;
    // Non-string uris are dropped, not coerced.
    return typeof uri === "string" ? [uri] : [];
  });
}

// Grounded Gemini search. The model is never named here: the client owns the default.
function makeSearch(db: Parameters<typeof generateGeminiContent>[0]): SearchFn {
  // The seam signature core.ts expects.
  return async (query) => {
    // Search grounding is what turns recalled URLs into current ones. NEVER add
    // responseSchema here: the client refuses tools + responseSchema as invalid_request.
    const options: GenerateGeminiOptions = {
      // System instruction pins the output format; the user content is the built prompt.
      prompt: { systemInstruction: "You find real, currently open job postings. Output URLs only.", userContent: query },
      // Forwarded verbatim by the client; no model is named, the client owns the default.
      tools: [{ google_search: {} }],
    };
    // Key failover and pacing live inside the shared client.
    const outcome = await generateGeminiContent(db, options);
    // Every key cooling, or the daily budget spent (claim_gemini_key enforces
    // system_settings.gemini_daily_call_budget). Normal quota behaviour, signalled as its own class.
    if (!outcome.ok && outcome.reason === "all_keys_cooling") throw new QuotaExhaustedError();
    // Gemini stayed overloaded or unreachable through every retry: its own class, because the
    // remedy ("try again in a few minutes") differs from both quota and a real failure.
    // The shared description (status + capped, redacted detail), so this branch's error_detail
    // goes through the same sanitising as every other Gemini failure line.
    if (!outcome.ok && outcome.reason === "upstream_unavailable") throw new UpstreamUnavailableError(describeGeminiFailure(outcome));
    // Any other failure is thrown so the handler records a failed run, not an empty success.
    // Same shared line as every other caller (reason, status, short redacted detail), so a
    // failed scout-web run says WHICH http_error it was.
    if (!outcome.ok) throw new Error(formatGeminiFailure(outcome));
    // First candidate only; absent means an empty answer, which the shape check will reject.
    const candidate = outcome.data.candidates?.[0];
    // All text parts joined; core.ts mines URLs from it.
    const text = (candidate?.content?.parts ?? []).map((p) => p.text ?? "").join("\n");
    // groundingMetadata is `unknown`, so narrow it by shape before reading any URI.
    const urls = groundingUris(candidate?.groundingMetadata);
    // Both sources go to the shape check; neither is trusted.
    return { text, urls };
  };
}

// Entry point, wrapped so a crash still answers with JSON and CORS headers.
Deno.serve(withErrorBoundary("scout-web", async (req: Request): Promise<Response> => {
  // Preflight must not need a database sign-in.
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  // Everything else is the handler, with real seams plugged in.
  return await handleScoutWeb(req, {
    // The wall clock.
    now: () => new Date(),
    // Robots-gated board fetch.
    fetchBoard,
    // The real network, used only for the exact Google redirect host (redirects.ts enforces it).
    resolveRedirect: (url) => resolveGroundingRedirect(url, fetch),
    // Lazily signs in per request, since isolates are stateless.
    connect: async () => {
      // Same sign-in every other agent uses.
      const client = await createAppUserClient();
      // Carry the log-only reason up to the handler.
      if (!client.ok) return { ok: false, reason: client.reason };
      // The RLS-bound client.
      const { db } = client;
      // The real Store over the signed-in client.
      const store: Store = {
        // Read the profile that seeds the search.
        async loadProfile() {
          // Latest version wins, as in the auditor and tailor.
          const { data, error } = await db.from("master_profiles").select("profile").order("version", { ascending: false }).limit(1).maybeSingle();
          // A failed read must not look like "no profile".
          if (error) return { ok: false, reason: error.message };
          // Null is a legitimate answer: the caller may supply a query instead.
          return { ok: true, profile: data?.profile ?? null };
        },
        // Telemetry open.
        async openRun() {
          // 'scout_aggregator' is the closest existing agent_name enum value (no 'scout_web' exists).
          const { data } = await db.from("agent_runs").insert({ agent: "scout_aggregator", status: "running", started_at: new Date().toISOString() }).select("id").single();
          // Null tells the handler there is no row to close.
          return data?.id ?? null;
        },
        // Telemetry close.
        async closeRun(runId, patch) {
          // Telemetry failure must not change the HTTP answer, so the result is not inspected.
          await db.from("agent_runs").update({ ...patch, finished_at: new Date().toISOString() }).eq("id", runId);
        },
        // Names for boards the user already tracks, so fingerprints match scout-ats's rows.
        async loadWatchlistNames(boards) {
          // One read for every board; RLS already confines it to this user's rows.
          const { data, error } = await db
            .from("company_watchlist")
            // Only the columns naming needs.
            .select("ats_provider, board_token, company_name, company_slug")
            // Narrowed by token here; provider is matched below, since tokens repeat across ATSes.
            .in("board_token", [...new Set(boards.map((b) => b.token))]);
          // A failed read is reported, never mistaken for "nothing tracked".
          if (error) return { ok: false, reason: error.message };
          // Keyed exactly as the handler looks them up.
          const names = new Map<string, WatchlistName>();
          // Untyped rows from PostgREST, read field by field.
          for (const r of (data ?? []) as { ats_provider: string; board_token: string; company_name: string; company_slug: string }[]) {
            // Same key builder as core.ts, so a provider mismatch can never match.
            names.set(`${r.ats_provider}:${r.board_token}`, { companyName: r.company_name, companySlug: r.company_slug });
          }
          // Possibly empty, which correctly means "none of these boards are tracked".
          return { ok: true, names };
        },
        // The only writes this function makes to pipeline tables.
        async persist(rows) {
          // Failures are collected so the handler can report them honestly.
          const errors: string[] = [];
          // One upsert per distinct key-set, so an omitted field cannot blank a stored one.
          for (const group of planJobUpsertGroups(rows)) {
            // ignoreDuplicates:true so an existing (richer) jobs row is never overwritten.
            const { error } = await db.from("jobs").upsert(group, { onConflict: "user_id,fingerprint", ignoreDuplicates: true });
            // Keep going: another group may still succeed.
            if (error) errors.push(`jobs_upsert: ${error.message}`);
          }
          // Resolve ids by fingerprint: ignored (already existing) rows are not returned by the upsert.
          const { data: jobs, error: lookupError } = await db.from("jobs").select("id").in("fingerprint", rows.map((r) => r.fingerprint));
          // A failed lookup means no applications can be linked.
          if (lookupError) errors.push(`jobs_lookup: ${lookupError.message}`);
          // Nothing resolved means nothing can be queued.
          if (!jobs || jobs.length === 0) return { inserted: 0, errors };
          // Status is the constant inside buildApplicationRows, never caller-supplied.
          const { data: apps, error: appError } = await db
            .from("applications")
            // ignoreDuplicates leaves any existing application (at any status) untouched.
            .upsert(buildApplicationRows(jobs.map((j: { id: string }) => j.id)), { onConflict: "user_id,job_id", ignoreDuplicates: true })
            // Only genuinely new rows come back, which is what `inserted` counts.
            .select("id");
          // Surface the failure instead of reporting zero as if it were clean.
          if (appError) errors.push(`applications_upsert: ${appError.message}`);
          // Count of new applications plus any errors.
          return { inserted: apps?.length ?? 0, errors };
        },
      };
      // Everything the handler needs, with search bound to the same session.
      return { ok: true, userId: client.userId, db, store, search: makeSearch(db) };
    },
  });
}));
