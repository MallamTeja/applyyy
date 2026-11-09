// A per-request Gemini meter for the request-driven functions (job-link-intake, resume-assist).
//
// WHY: both spent Gemini quota with no agent_runs row until 2026-11-09, so their calls were
// invisible to the Health page and to every calls/min or 429-vs-503 measurement (peer 3 task 8).
// The scheduled agents open a 'running' row and close it; a request is short and a throw is
// answered by withErrorBoundary, so here the run is ONE insert after the answer, which the entry
// point hands to EdgeRuntime.waitUntil: the person waiting pays no extra round trip (~300 ms to Sydney).
// ponytail: an isolate killed mid-request leaves no row; switch to open-then-close if logs show that.
// Lives here, not _shared, only because of write ownership on 2026-11-09; resume-assist imports it
// by relative path, as this function already imports ../scout-web/fetch-board.ts. Move it to
// _shared/agent/ when that file can be touched. Type-only imports, so node --test loads it as is.

// The outcome union of the one Gemini client: the run's status is read from it.
import type { GeminiCallOutcome, GeminiResponseBody } from "../_shared/gemini/client.ts";

// One Gemini call's outcome, as both callers receive it.
type Outcome = GeminiCallOutcome<GeminiResponseBody>;

// The only database surface the meter needs: an insert into agent_runs that reports, never throws (supabase-js's shape).
type RunWriter = { from(table: "agent_runs"): { insert(row: Record<string, unknown>): PromiseLike<{ error: { message: string } | null }> } };

/** Counts a request's Gemini calls and writes them as one agent_runs row for `agent`. */
export function geminiMeter(agent: string, now: () => Date = () => new Date()) {
  // Calls made so far; counted BEFORE each call, so a call that throws is still one call (as in the matcher).
  let calls = 0;
  // When the first call started: the run's started_at, so duration_ms covers the Gemini part only.
  let startedAt: Date | null = null;
  // The client the first call went through; the row is written with it, under the app user's RLS.
  let db: RunWriter | null = null;
  // The last call's outcome decides the status; null while none has returned (or the last one threw).
  let last: Outcome | null = null;
  // The two operations the entry point uses.
  return {
    /** Runs one Gemini call through the meter; the outcome (or the throw) passes through unchanged. */
    async call(client: unknown, run: () => Promise<Outcome>): Promise<Outcome> {
      // Counted first, so a throw still counts.
      calls += 1;
      // The first call stamps the run's start and its client. The client is the signed-in
      // supabase-js client; `unknown` because job-link-intake's seam types it that way.
      if (startedAt === null) [startedAt, db] = [now(), client as RunWriter];
      // Cleared, so a call that throws is not reported with the previous call's outcome.
      last = null;
      // The call itself, unchanged.
      last = await run();
      // Handed back exactly as received.
      return last;
    },
    /** Writes the run row, or nothing when no Gemini call was made. Never throws: telemetry must not change an answer. */
    async record(): Promise<void> {
      // No call (a board link, a refusal, a GET): no row, since this row measures Gemini spend.
      if (db === null || startedAt === null) return;
      // Quota spent or every key cooling is normal behaviour, not a failure (AGENT_RUN_STATUSES).
      const status = last?.ok ? "succeeded" : last?.reason === "all_keys_cooling" ? "skipped_quota" : "failed";
      // The reason verbatim, so a 429 (rate_limited_all_retries_exhausted) and a 503 (upstream_unavailable)
      // stay apart in agent_runs; "gemini call threw" when the last call never returned.
      const detail = last === null ? "gemini call threw" : last.ok ? null : last.reason;
      // One insert; RLS stamps user_id from the signed-in client. Caught too: a rejected insert must not reach waitUntil.
      try {
        // The whole run in one row: duration_ms is generated from the two timestamps.
        const { error } = await db.from("agent_runs").insert({ agent, status, started_at: startedAt.toISOString(), finished_at: now().toISOString(), gemini_calls: calls, error_count: status === "failed" ? 1 : 0, error_detail: detail });
        // supabase-js reports a refusal as { error }; logged so a missing row has a trace.
        if (error) console.warn(`[${agent}] agent_runs insert failed: ${error.message}`);
      } catch (err) {
        // A network drop that threw: logged, never rethrown.
        console.warn(`[${agent}] agent_runs insert threw: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  };
}
