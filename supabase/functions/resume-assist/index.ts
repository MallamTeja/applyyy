// RESUME-ASSIST entry point: wires the real seams into the pure handler in assist.ts.
// Kept to wiring only, because `createAuthorizedAppUserClient` (client.ts) imports jsr:@supabase/supabase-js,
// which node --test cannot load; every decision lives in assist.ts, where tests reach it.

// Preflight headers, and the wrapper that turns an uncaught throw into JSON with CORS.
import { corsHeaders, withErrorBoundary } from "../_shared/cors.ts";
// The app-user sign-in, run only after the caller is verified (W15); queries run under that user's RLS.
import { createAuthorizedAppUserClient } from "../_shared/db/client.ts";
// The one Gemini client: key pool, pacing, failover, and now the cost controls.
import { generateGeminiContent } from "../_shared/gemini/client.ts";
// The gated, validated lifecycle.
import { handleResumeAssist } from "./assist.ts";
// Counts this request's Gemini call into one agent_runs row. Imported from job-link-intake by relative
// path (as that function imports ../scout-web/fetch-board.ts); gemini-meter.ts says why it lives there.
import { geminiMeter } from "../job-link-intake/gemini-meter.ts";

// Supabase's background-task hook. Deno's own types do not declare it.
declare const EdgeRuntime: { waitUntil(promise: Promise<unknown>): void };

// Wrapped so a crash still answers with JSON and CORS headers.
Deno.serve(withErrorBoundary("resume-assist", async (req: Request): Promise<Response> => {
  // Preflight must not cost a database sign-in.
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  // This request's Gemini meter: without it the AI editor spent quota with no agent_runs row (2026-11-09).
  const meter = geminiMeter("resume_assist");
  // Everything else goes through the handler with real seams.
  const response = await handleResumeAssist(req, {
    // Signs in per request, since isolates keep no state between calls.
    connect: async () => {
      // The caller first, then the app user's client: a refused caller costs no password grant (W15, 2026-11-05).
      const client = await createAuthorizedAppUserClient(req);
      // Refused: handed up as is, so the handler answers 401/403. Unavailable: the log-only reason.
      if (!client.ok) return client.kind === "refused" ? client : { ok: false, reason: client.reason };
      // The gates read through `db`; Gemini claims its key through the same client.
      // The call goes through the meter, which writes gemini_calls into this request's run row.
      return { ok: true, db: client.db, userId: client.userId, generate: (options) => meter.call(client.db, () => generateGeminiContent(client.db, options)) };
    },
  });
  // The run row in the background, so the person waiting pays no extra round trip; no call, no row.
  EdgeRuntime.waitUntil(meter.record());
  // The handler's answer, untouched by the telemetry.
  return response;
}));
