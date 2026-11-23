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
// S9i P2: the server-side apply of a chat answer (Teja 15:34: edits land even with the tab closed).
import { applyOnServer } from "./server-apply.ts";

// The apply's wall-clock budget: under the edge function's own limit, so it refuses and reports rather than being
// killed half-way (the orchestrator's note: finish inside the wall time). ponytail: a fixed guess; tune from logs.
const APPLY_BUDGET_MS = 60_000;

// Supabase's background-task hook. Deno's own types do not declare it.
declare const EdgeRuntime: { waitUntil(promise: Promise<unknown>): void };

// Wrapped so a crash still answers with JSON and CORS headers.
Deno.serve(withErrorBoundary("resume-assist", async (req: Request): Promise<Response> => {
  // Preflight must not cost a database sign-in.
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  // This request's Gemini meter: without it the AI editor spent quota with no agent_runs row (2026-11-09).
  const meter = geminiMeter("resume_assist");
  // The Gemini call in flight. A streamed answer (2026-11-18) returns its Response BEFORE the call ends, so the
  // run row must wait for the call itself, not for the Response; resolved already when no call is made.
  let call: Promise<unknown> = Promise.resolve();
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
      // The call is kept in `call` so the run row below is written only once it has settled.
      return {
        // The narrow client the gates read.
        ok: true, db: client.db, userId: client.userId,
        // The metered Gemini call.
        generate: (options) => (call = meter.call(client.db, () => generateGeminiContent(client.db, options))),
        // S9i P2: the apply under this same signed-in client, with a deadline counted from now.
        apply: async (args) => (await applyOnServer(client.db, { ...args, deadline: Date.now() + APPLY_BUDGET_MS }, { now: Date.now, uuid: () => crypto.randomUUID() })).outcomes,
        // S9i P2: the exchange under the same client; supabase-js reports a refusal as a value, so false then.
        saveChat: async (rows) => { try { const { error } = await client.db.from("resume_chat_messages").insert(rows); return !error; } catch { return false; } },
      };
    },
    // S9i P2: the answer-then-apply chain outlives the response, so a closed tab never stops an edit half-way.
    keepAlive: (work) => EdgeRuntime.waitUntil(work.catch(() => {})),
  });
  // The run row in the background, after the call settles (a throw too), so the person waiting pays no extra
  // round trip and a streamed call is metered with its real outcome; no call, no row.
  EdgeRuntime.waitUntil(call.catch(() => {}).then(() => meter.record()));
  // The handler's answer, untouched by the telemetry.
  return response;
}));
