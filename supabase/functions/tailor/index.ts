// Tailor — Edge Function Entrypoint
//
// Reads `applications` sitting at status `scored`, rewrites the master resume against
// each posting through Gemini, validates every claim back to a master node, and writes
// the surviving `ResolvedResume` into `applications.tailored_profile`.
//
// WHY THIS LIVES IN DENO AND NOT IN THE NODE WORKER, because the obvious place was the
// worker and it does not work: `_shared/gemini/` imports `jsr:@supabase/supabase-js` and
// reads `Deno.env` (pool.ts:119). Importing it from `worker/` fails with TS2307 and
// TS2304 — measured, not assumed.
//
// That is a RUNTIME boundary, and it is worth separating from the type errors the same
// file used to carry: `db98d6e` closed all four of those on 2026-09-18 and this import
// still cannot cross into Node. Fixing the types was never what stood in the way. The
// Tailor belongs next to the key pool it depends on.
//
// THIS FILE IS GLUE AND HOLDS NO LOGIC WORTH TESTING, deliberately. Every decision it
// could get wrong has been pushed into a pure module with its own tests:
// `tailor-batch.ts` decides which rows are even tailorable, `tailorer.ts` decides the
// verdict, `persist.ts` decides the write order. What is left here is I/O and wiring,
// which is why no `index.ts` in this repo has a test file.

// Signs in as the ordinary app user, so every query below runs under normal RLS. There
// is no service-role key in this stream — see _shared/db/client.ts for the argument.
import { createAppUserClient } from "../_shared/db/client.ts";
// The model transport, with key-pool claiming, 429 failover and pacing already handled.
import { generateGeminiContent } from "../_shared/gemini/client.ts";
// Which rows may be tailored at all. The guard against tailoring an empty posting.
import { planTailorBatch } from "../_shared/tailor/tailor-batch.ts";
// The runner: prompt -> model -> validate -> verdict.
import { createTailorer } from "../_shared/tailor/tailorer.ts";
// The write: payload first, status second, never the reverse.
import { persistTailorOutcome } from "../_shared/tailor/persist.ts";
// The master shape, so the stored JSON is cast against the contract rather than inferred.
import type { MasterProfile } from "../_shared/contracts/shared-types.ts";

// How many rows one invocation will attempt. Bounded because each row is a Gemini call
// against a shared key pool, and an unbounded batch would drain the quota that every
// other agent shares. A caller wanting more invokes again.
const DEFAULT_BATCH_SIZE = 10;
// Hard ceiling, so a caller-supplied value cannot turn one request into a quota outage.
const MAX_BATCH_SIZE = 25;

// Copied from scout-ats rather than shared, matching this repo's existing habit for
// per-function CORS. A wildcard origin is safe here only because the function grants
// nothing on its own: every query runs under the caller's RLS session, so an origin that
// cannot authenticate cannot read a row.
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  // `authorization` and `apikey` are the two Supabase actually needs; the other two are
  // what the JS client sends unprompted, and omitting them fails the preflight.
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  // GET as well as POST, so this is drivable from a browser address bar while it has no
  // scheduled caller — which is the whole point of it being manually invokable today.
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
};

// One JSON response shape for every exit, so a caller never has to branch on content type.
function jsonResponse(status: number, data: Record<string, unknown>): Response {
  // Indented output: this endpoint is read by a human far more often than by a program,
  // and will be for as long as nothing schedules it.
  return new Response(JSON.stringify(data, null, 2), {
    status,
    // Charset stated explicitly — the tailored text is user-facing and may carry
    // non-ASCII, and a sniffed encoding is a silent corruption rather than an error.
    headers: { "content-type": "application/json; charset=utf-8", ...corsHeaders },
  });
}

// Clamp the requested batch size into something the key pool can survive.
function resolveBatchSize(raw: string | null): number {
  // Absent is the common case and means "use the default", not "use zero".
  if (raw === null) return DEFAULT_BATCH_SIZE;
  const parsed = Number(raw);
  // `Number("")` is 0 and `Number("abc")` is NaN — both would silently mean "do nothing"
  // if passed through. Validating the shape rather than trusting the parser is CLAUDE.md
  // §5, and this is the exact trap it names.
  if (!Number.isInteger(parsed) || parsed < 1) return DEFAULT_BATCH_SIZE;
  return Math.min(parsed, MAX_BATCH_SIZE);
}

Deno.serve(async (req: Request): Promise<Response> => {
  // Preflight, before any work or any database connection.
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  // Sign in. A missing environment variable is an operational condition with its own
  // status code, not a 500 — the client returns it as data for exactly that reason.
  const connection = await createAppUserClient();
  if (!connection.ok) {
    // `reason` distinguishes "no such user" from "wrong password" and so stays in the
    // log, never in the body.
    console.error("[applyy-tailor] could not sign in:", connection.reason);
    // 503 rather than 500: this is "come back later", and a caller retrying on it is
    // behaving correctly. A 500 would invite someone to go looking for a bug in here.
    return jsonResponse(503, { success: false, error: "database_unavailable" });
  }
  // Unpacked once so the rest of the handler reads as ordinary queries rather than
  // threading the result union through every call.
  const db = connection.db;

  // Open the run row BEFORE the work, so an uncatchable death leaves a visible stuck
  // run rather than no trace at all — the documented design in supporting_tables.sql.
  const { data: runRow } = await db
    .from("agent_runs")
    // `tailor` is a real `agent_name` enum member (enums.sql:173), not a free string;
    // a typo here is refused by the column type rather than logged under a ghost agent.
    .insert({ agent: "tailor", status: "running", started_at: new Date().toISOString() })
    .select("id")
    .single();
  // Error deliberately not checked: failing to OPEN a run row must not stop the run.
  // Telemetry is the observer of the work, never a precondition for it — and `runId`
  // being undefined already makes every write below a no-op.
  const runId: string | undefined = runRow?.id;

  // Close the run row with a failure, then answer. Folded into one helper because every
  // early exit below has to do both and forgetting the first leaves a phantom run.
  async function failRun(status: number, error: string, detail: string): Promise<Response> {
    if (runId) {
      await db
        .from("agent_runs")
        .update({ status: "failed", finished_at: new Date().toISOString(), error_detail: detail })
        .eq("id", runId);
    }
    return jsonResponse(status, { success: false, error });
  }

  // THE PINNED MASTER. Highest version wins; the trigger assigns version as max+1.
  const { data: masterRow, error: masterError } = await db
    .from("master_profiles")
    .select("profile, version")
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle();

  // A read failure and an empty table are different facts and get different answers.
  if (masterError) return await failRun(503, "master_profile_unreadable", masterError.message);
  // NO MASTER MEANS NO TAILORING, and refusing here is the point. Every honesty check
  // downstream resolves refs against this profile; without one there is nothing for a
  // tailoring to be faithful to, and the validator would refuse every row anyway — but
  // only after paying for a Gemini call per row to find out.
  if (!masterRow) return await failRun(409, "no_master_profile", "master_profiles is empty");

  // Cast once, against the contract. The column is `jsonb`, so this is the boundary
  // where stored JSON becomes a typed profile.
  //
  // UNVALIDATED ON PURPOSE, and worth saying out loud rather than leaving as an
  // omission: the validator refuses a tailoring whose master has duplicate node ids
  // (`validator.ts:415`), which is the failure this cast could otherwise hide. A shape
  // check here would duplicate a control that already exists one layer down and answers
  // the same question — and the known bad master today is not malformed, it is the
  // hardcoded placeholder the broken PDF path writes, which no shape check can detect.
  const master = masterRow.profile as MasterProfile;
  // The pin, kept separate from the profile because it lives in a column and not in the
  // JSON — `MasterProfile` carries `schema_version`, never the row version.
  const masterVersion: number = masterRow.version;

  // The work queue. `scored` is the Tailor's only legal source
  // (status_transition_guard.sql:116), so this select IS the edge, expressed as a query.
  const batchSize = resolveBatchSize(new URL(req.url).searchParams.get("limit"));
  const { data: rows, error: rowsError } = await db
    .from("applications")
    // The embedded resource is the posting itself. Fetched in one round trip rather than
    // per row: N+1 against a shared Postgres is how a batch of ten becomes a timeout.
    .select("id, jobs (title, company_name, description_raw)")
    // No `user_id` filter, and that is deliberate — RLS already scopes this to the signed
    // -in user. Adding one would read as defence in depth while actually being a second
    // place for the tenant rule to drift out of step with the policy.
    .eq("status", "scored")
    // Oldest first, so a persistent failure at the head of the queue is visible rather
    // than being skipped over by newer rows every run.
    .order("created_at", { ascending: true })
    .limit(batchSize);

  if (rowsError) return await failRun(503, "queue_unreadable", rowsError.message);

  // Decide what is actually tailorable. Rows missing a posting are skipped with a named
  // reason rather than sent to the model as a well-formed request about nothing.
  const plan = planTailorBatch(rows ?? []);

  // Bind the model to this master and version once, rather than per row.
  const tailor = createTailorer({
    master,
    masterVersion,
    // The seam the runner's tests replace. Here it is the real transport.
    callLlm: async (prompt) => {
      const outcome = await generateGeminiContent(db, {
        // The fenced prompt, passed through unchanged — the trust boundary was built in
        // prompt.ts and this function must not reshape it.
        prompt: {
          systemInstruction: prompt.systemInstruction,
          userContent: prompt.userContent,
          responseSchema: prompt.responseSchema,
        },
      });
      // A pool or transport failure is not a tailoring verdict. Thrown so the row is
      // recorded as an error rather than being persisted as a refusal, which would
      // blame the model for a quota problem.
      if (!outcome.ok) throw new Error(`gemini_call_failed: ${outcome.reason}`);
      // Optional chaining at every hop because `noUncheckedIndexedAccess` is on and each
      // of these may genuinely be absent in a safety-blocked response.
      const text = outcome.data.candidates?.[0]?.content?.parts?.[0]?.text;
      // A response carrying no text has not answered. Same rule as above: throw rather
      // than hand the runner an empty string it would report as malformed JSON.
      if (typeof text !== "string") throw new Error("gemini_returned_no_text");
      return text;
    },
  });

  // Counters, reported separately because they answer different questions: how many were
  // written, how many were honestly refused, and how many never reached the model.
  let tailored = 0;
  let refused = 0;
  // Per-row outcomes, so one failure is legible without reading the logs.
  const failures: Array<{ applicationId: string; error: string }> = [];

  // Sequential on purpose. The key pool paces itself, and firing ten concurrent calls
  // would race every one of them into the same 429 the pacer exists to avoid.
  for (const job of plan.tailorable) {
    try {
      const outcome = await tailor(job.input);
      // Persist decides the write order; this loop only reports what it returned.
      const written = await persistTailorOutcome(db, job.applicationId, outcome);
      if (!written.ok) {
        failures.push({ applicationId: job.applicationId, error: written.message });
        continue;
      }
      // Counted from what was actually persisted, not from the verdict — a verdict that
      // failed to write is not a row anyone can act on.
      if (written.status === "tailored") tailored += 1;
      else refused += 1;
    } catch (err) {
      // A throw here is a transport or schema failure, never a fabrication finding. The
      // row keeps its `scored` status and will be picked up by the next invocation.
      failures.push({ applicationId: job.applicationId, error: err instanceof Error ? err.message : String(err) });
    }
  }

  // Close the run. The run SUCCEEDED at doing its job even when individual rows failed —
  // those are carried in the counters, the same split scout-ats uses.
  if (runId) {
    await db
      .from("agent_runs")
      .update({
        status: "succeeded",
        finished_at: new Date().toISOString(),
        // What we looked at, and what we wrote. Two numbers because "read 10, wrote 0"
        // is the early warning that the pipeline is dry, and one total would hide it.
        rows_in: plan.tailorable.length,
        rows_out: tailored,
      })
      .eq("id", runId);
  }

  return jsonResponse(200, {
    success: true,
    // Which master every verdict in this run was judged against, so a later dispute
    // about a tailoring does not have to guess.
    master_version: masterVersion,
    // Reached the model and produced a persisted resume.
    tailored,
    // Reached the model and were honestly refused by the validator. NOT an error —
    // this number being zero forever is the suspicious reading, not a high one.
    refused,
    // Never reached the model, with the reason each was skipped.
    skipped: plan.skipped,
    // Transport, quota or write failures. These rows are still at `scored`.
    failures,
  });
});
