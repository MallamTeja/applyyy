// gmail-sync — Edge Function Entrypoint
//
// Proxies the dashboard's "sync now" click to the Gmail Apps Script Web App, so the
// shared secret stays server-side (the old route compiled the /exec URL with ?secret=
// into the public browser bundle via a VITE_ env var). The Apps Script enforces its own
// 60-second cooldown; this function only authenticates the caller, makes the call and
// shapes the reply. Contract with apps/web (2026-10-23):
//   POST /functions/v1/gmail-sync, Authorization: Bearer <user JWT>
//   -> { ok: boolean, cooldown?: boolean, details?: unknown, error?: string }

// The RLS-authenticated client; also yields the app user's id for the caller gate.
import { createAppUserClient } from "../_shared/db/client.ts";
// Gate 1: only the app user's own session may trigger a sync (the anon key is public).
import { authorizeCaller } from "../_shared/db/gates.ts";
// Pure response shaping, node-tested in respond.test.ts.
import { configVerdict, upstreamVerdict } from "./respond.ts";

// Browser-invoked, so the standard CORS trio (same values as the other functions).
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// JSON response helper, CORS included on every path.
function json(status: number, data: Record<string, unknown>): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...corsHeaders },
  });
}

Deno.serve(async (req: Request): Promise<Response> => {
  // Preflight for the browser's Authorization header.
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  // The contract is POST-only; anything else is a caller bug.
  if (req.method !== "POST") return json(405, { ok: false, error: "method not allowed" });

  // The app-user client; its userId anchors the caller gate.
  const client = await createAppUserClient();
  // No client means no way to verify the caller: refuse.
  if (!client.ok) {
    // Reason can name env vars; it belongs in the log, not the response.
    console.error(`[gmail-sync] database connection failed: ${client.reason}`);
    return json(500, { ok: false, error: "storage unavailable" });
  }

  // GATE: a real session belonging to the app user (same pattern as every pipeline
  // agent) — without it anyone holding the public anon key could drain the sync quota.
  const caller = await authorizeCaller(req, client.db, client.userId);
  // 401 or 403, stated by the verdict.
  if (!caller.ok) return json(caller.status, { ok: false, error: caller.error });

  // Config gate: a plain 503 until Teja deploys the Web App and sets the URL secret.
  const config = configVerdict(
    Deno.env.get("APPLYY_GMAIL_SYNC_URL") ?? null,
    Deno.env.get("EMAIL_INTAKE_SHARED_SECRET") ?? null,
  );
  // Not configured yet: the dashboard shows this verbatim; nothing crashed.
  if (!config.ok) return json(config.verdict.status, { ...config.verdict.body });

  // The upstream call. BARE fetch, deliberately not the robots-gated transport: this is
  // an authenticated request to our own deployed Web App, not a crawl of a third-party
  // site (the transport's own `robots: false` escape names exactly this case), and the
  // script's JSON must be read even on odd statuses rather than thrown as HttpError.
  let upstreamStatus: number;
  let upstreamText: string;
  try {
    const response = await fetch(`${config.url}?secret=${encodeURIComponent(config.secret)}`, {
      // The Web App answers GET; redirects to script.googleusercontent.com are normal.
      method: "GET",
      redirect: "follow",
      // A hung script must not hold the Edge Function's wall clock past 30s.
      signal: AbortSignal.timeout(30_000),
    });
    // Status and body captured together for the pure mapper.
    upstreamStatus = response.status;
    upstreamText = await response.text();
  } catch (cause) {
    // The thrown error can quote the request URL — secret included — so it is scrubbed
    // before logging and NEVER forwarded to the browser.
    console.error(`[gmail-sync] upstream fetch failed: ${String(cause).split(config.secret).join("[redacted]")}`);
    return json(502, { ok: false, error: "upstream sync failed" });
  }

  // Pure shaping: shape-checked pass-through, secret-leak check last (respond.ts).
  const verdict = upstreamVerdict(upstreamStatus, upstreamText, config.secret);
  // One exit for the success and failure shapes alike.
  return json(verdict.status, { ...verdict.body });
});
