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

// Wrapped so a crash still answers with JSON and CORS headers.
Deno.serve(withErrorBoundary("resume-assist", async (req: Request): Promise<Response> => {
  // Preflight must not cost a database sign-in.
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  // Everything else goes through the handler with real seams.
  return await handleResumeAssist(req, {
    // Signs in per request, since isolates keep no state between calls.
    connect: async () => {
      // The caller first, then the app user's client: a refused caller costs no password grant (W15, 2026-11-05).
      const client = await createAuthorizedAppUserClient(req);
      // Refused: handed up as is, so the handler answers 401/403. Unavailable: the log-only reason.
      if (!client.ok) return client.kind === "refused" ? client : { ok: false, reason: client.reason };
      // The gates read through `db`; Gemini claims its key through the same client.
      return { ok: true, db: client.db, userId: client.userId, generate: (options) => generateGeminiContent(client.db, options) };
    },
  });
}));
