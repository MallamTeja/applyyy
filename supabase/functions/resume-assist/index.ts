// RESUME-ASSIST entry point: wires the real seams into the pure handler in assist.ts.
// Kept to wiring only, because `createAppUserClient` imports jsr:@supabase/supabase-js,
// which node --test cannot load; every decision lives in assist.ts, where tests reach it.

// Preflight headers, and the wrapper that turns an uncaught throw into JSON with CORS.
import { corsHeaders, withErrorBoundary } from "../_shared/cors.ts";
// The same app-user sign-in every agent uses; queries run under that user's RLS.
import { createAppUserClient } from "../_shared/db/client.ts";
// The one Gemini client: key pool, pacing, failover, and now the cost controls.
import { generateGeminiContent } from "../_shared/gemini/client.ts";
// The gated, validated lifecycle.
import { handleResumeAssist } from "./assist.ts";

// Wrapped so a crash still answers with JSON and CORS headers.
Deno.serve(withErrorBoundary("resume-assist", async (req: Request): Promise<Response> => {
  // Preflight must not cost a database sign-in.
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  // Everything else goes through the handler with real seams.
  return await handleResumeAssist(req, {
    // Signs in per request, since isolates keep no state between calls.
    connect: async () => {
      // The app user's client.
      const client = await createAppUserClient();
      // The log-only reason travels up; the handler never returns it.
      if (!client.ok) return { ok: false, reason: client.reason };
      // The gates read through `db`; Gemini claims its key through the same client.
      return { ok: true, db: client.db, userId: client.userId, generate: (options) => generateGeminiContent(client.db, options) };
    },
  });
}));
