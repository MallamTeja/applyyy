// Scout-ATS — Edge Function Entrypoint
//
// Polls registered company boards from `company_watchlist` using dedicated ATS
// adapters (Greenhouse, Lever, Ashby).
// Deduplicates postings by canonical fingerprint into `public.jobs`, creates initial
// `public.applications` records at status `discovered`, and updates polling telemetry.

import { createAppUserClient } from "../_shared/db/client.ts";
import { getAdapter, supportedProviders, toJobInsert, type JobInsertContext } from "../_shared/ats/registry.ts";
import type { AtsProvider, JobInsert } from "../_shared/contracts/shared-types.ts";

interface WatchlistRow {
  readonly id: string;
  readonly ats_provider: AtsProvider;
  readonly board_token: string;
  readonly company_name: string;
  readonly company_slug: string;
  readonly poll_count: number;
  readonly first_polled_at: string | null;
  readonly last_polled_at: string | null;
  readonly consecutive_failures: number;
}

interface PollSummary {
  readonly board: string;
  readonly provider: string;
  readonly status: "ok" | "skipped" | "failed";
  readonly fetched: number;
  readonly inserted: number;
  readonly error?: string;
}

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
};

function jsonResponse(status: number, data: Record<string, unknown>): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...corsHeaders,
    },
  });
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const url = new URL(req.url);
  const force = url.searchParams.get("force") === "true";
  const limitBoards = parseInt(url.searchParams.get("limit") || "10", 10);
  const specificBoard = url.searchParams.get("board");

  const clientResult = await createAppUserClient();
  if (!clientResult.ok) {
    return jsonResponse(500, {
      error: "db_client_failed",
      detail: clientResult.reason,
    });
  }

  const { db } = clientResult;

  // 1. Record run start in agent_runs
  const { data: runRow } = await db
    .from("agent_runs")
    .insert({
      agent: "scout_ats",
      status: "running",
      started_at: new Date().toISOString(),
    })
    .select("id")
    .single();

  const runId = runRow?.id;

  // 2. Check Kill Switch
  const { data: settingsData, error: settingsError } = await db
    .from("system_settings")
    .select("system_enabled")
    .limit(1)
    .single();

  if (settingsError && settingsError.code !== "PGRST116") {
    if (runId) {
      await db
        .from("agent_runs")
        .update({
          status: "failed",
          finished_at: new Date().toISOString(),
          error_detail: `kill_switch_read_failed: ${settingsError.message}`,
        })
        .eq("id", runId);
    }
    return jsonResponse(500, {
      error: "kill_switch_read_failed",
      detail: settingsError.message,
    });
  }

  const systemEnabled = settingsData?.system_enabled ?? false;
  if (!systemEnabled && !force) {
    if (runId) {
      await db
        .from("agent_runs")
        .update({
          status: "skipped_disabled",
          finished_at: new Date().toISOString(),
          error_detail: "system_settings.system_enabled is false",
        })
        .eq("id", runId);
    }
    return jsonResponse(200, {
      status: "halted_by_kill_switch",
      message: "system_settings.system_enabled is false. Set ?force=true to override for manual discovery.",
      boards_polled: 0,
      jobs_discovered: 0,
    });
  }

  // 2. Query active watchlist boards
  let query = db
    .from("company_watchlist")
    .select("id, ats_provider, board_token, company_name, company_slug, poll_count, first_polled_at, last_polled_at, consecutive_failures")
    .eq("enabled", true)
    .in("ats_provider", supportedProviders());

  if (specificBoard) {
    query = query.eq("board_token", specificBoard);
  } else {
    query = query.order("last_polled_at", { ascending: true, nullsFirst: true }).limit(limitBoards);
  }

  const { data: boards, error: boardsError } = await query;
  if (boardsError) {
    // Close the run as failed before returning. The two kill-switch exits above already
    // do this; these later exits did not, which meant the run row's status depended on
    // WHICH failure occurred rather than on whether the run failed — the same class of
    // defect as an exit code that describes a different program (docs/verification-traps.md §4).
    if (runId) {
      await db
        .from("agent_runs")
        .update({
          status: "failed",
          finished_at: new Date().toISOString(),
          // Carry the reason, not just the fact. "It failed" is the composite result
          // the traps doc warns about: a watchlist query failure and a kill-switch read
          // failure are different incidents and must not read identically on the health page.
          error_detail: `watchlist_query_failed: ${boardsError.message}`,
        })
        .eq("id", runId);
    }
    return jsonResponse(500, {
      error: "watchlist_query_failed",
      detail: boardsError.message,
    });
  }

  if (!boards || boards.length === 0) {
    // An empty watchlist is a successful no-op, NOT a crash. Recording it as 'succeeded'
    // with explicit zero counters is what lets the health page distinguish "ran, nothing
    // configured" from "never ran at all" — the precise distinction this table was created
    // for, since both a paused Supabase project and an empty watchlist produce no jobs.
    if (runId) {
      await db
        .from("agent_runs")
        .update({
          status: "succeeded",
          finished_at: new Date().toISOString(),
          rows_in: 0,
          rows_out: 0,
        })
        .eq("id", runId);
    }
    return jsonResponse(200, {
      status: "no_boards_due",
      message: "No enabled company boards matching supported ATS providers found.",
      boards_polled: 0,
      jobs_discovered: 0,
    });
  }

  const summaries: PollSummary[] = [];
  let totalJobsDiscovered = 0;
  let totalApplicationsCreated = 0;
  const now = new Date();

  // 3. Poll each board
  for (const board of boards as WatchlistRow[]) {
    const adapter = getAdapter(board.ats_provider);
    if (!adapter) {
      summaries.push({
        board: board.board_token,
        provider: board.ats_provider,
        status: "skipped",
        fetched: 0,
        inserted: 0,
        error: `No adapter available for provider ${board.ats_provider}`,
      });
      continue;
    }

    const requestUrl = adapter.buildRequestUrl(board.board_token);

    try {
      const response = await fetch(requestUrl, {
        headers: {
          "Accept": "application/json",
          "User-Agent": "applyy-scout/1.0 (+https://github.com/MallamTeja/applyyy)",
        },
      });

      if (!response.ok) {
        // Record failure against watchlist row
        await db
          .from("company_watchlist")
          .update({
            consecutive_failures: (board.consecutive_failures || 0) + 1,
            last_polled_at: now.toISOString(),
          })
          .eq("id", board.id);

        summaries.push({
          board: board.board_token,
          provider: board.ats_provider,
          status: "failed",
          fetched: 0,
          inserted: 0,
          error: `HTTP ${response.status}: ${response.statusText}`,
        });
        continue;
      }

      const payload = await response.json();
      const parseResult = adapter.parse(payload);

      if (!parseResult.ok) {
        await db
          .from("company_watchlist")
          .update({
            consecutive_failures: (board.consecutive_failures || 0) + 1,
            last_polled_at: now.toISOString(),
          })
          .eq("id", board.id);

        summaries.push({
          board: board.board_token,
          provider: board.ats_provider,
          status: "failed",
          fetched: 0,
          inserted: 0,
          error: `Parse error: ${parseResult.reason}`,
        });
        continue;
      }

      const context: JobInsertContext = {
        companyName: board.company_name,
        companySlug: board.company_slug,
        now,
        firstSeenAt: now,
        isFirstPollOfBoard: (board.poll_count === 0 || !board.first_polled_at),
      };

      const BATCH_SIZE = 50;
      const jobRows: JobInsert[] = await Promise.all(
        parseResult.postings.map((p) => toJobInsert(p, adapter, context))
      );

      let boardInserted = 0;
      let boardNewApps = 0;

      for (let i = 0; i < jobRows.length; i += BATCH_SIZE) {
        const batch = jobRows.slice(i, i + BATCH_SIZE);

        const { data: upsertedJobs, error: jobError } = await db
          .from("jobs")
          .upsert(batch, {
            onConflict: "user_id,fingerprint",
            ignoreDuplicates: false,
          })
          .select("id, fingerprint");

        let batchJobIds: string[] = [];

        if (!jobError && upsertedJobs && upsertedJobs.length > 0) {
          batchJobIds = upsertedJobs.map((j) => j.id);
        } else {
          const fps = batch.map((b) => b.fingerprint);
          const { data: existingJobs } = await db
            .from("jobs")
            .select("id")
            .in("fingerprint", fps);
          if (existingJobs) {
            batchJobIds = existingJobs.map((j) => j.id);
          }
        }

        if (batchJobIds.length > 0) {
          const appInserts = batchJobIds.map((job_id) => ({
            job_id,
            status: "discovered" as const,
          }));

          const { data: insertedApps, error: appErr } = await db
            .from("applications")
            .upsert(appInserts, {
              onConflict: "user_id,job_id",
              ignoreDuplicates: true,
            })
            .select("id");

          if (!appErr && insertedApps) {
            boardNewApps += insertedApps.length;
            totalApplicationsCreated += insertedApps.length;
          }
        }

        boardInserted += batchJobIds.length;
        totalJobsDiscovered += batchJobIds.length;
      }

      // Update watchlist success telemetry
      await db
        .from("company_watchlist")
        .update({
          poll_count: (board.poll_count || 0) + 1,
          first_polled_at: board.first_polled_at || now.toISOString(),
          last_polled_at: now.toISOString(),
          last_poll_job_count: parseResult.postings.length,
          consecutive_failures: 0,
        })
        .eq("id", board.id);

      summaries.push({
        board: board.board_token,
        provider: board.ats_provider,
        status: "ok",
        fetched: parseResult.postings.length,
        inserted: boardInserted,
      });
    } catch (fetchErr: unknown) {
      const msg = fetchErr instanceof Error ? fetchErr.message : String(fetchErr);
      await db
        .from("company_watchlist")
        .update({
          consecutive_failures: (board.consecutive_failures || 0) + 1,
          last_polled_at: now.toISOString(),
        })
        .eq("id", board.id);

      summaries.push({
        board: board.board_token,
        provider: board.ats_provider,
        status: "failed",
        fetched: 0,
        inserted: 0,
        error: msg,
      });
    }
  }

  // THE MOST IMPORTANT ONE OF THE THREE. Before this, the success path was the only
  // exit that never closed its run row, so every HEALTHY scout invocation left a row
  // stuck at 'running' — which the health page reads as the signature of a crash.
  // That inverts the single signal this table exists to carry: the more reliably the
  // function worked, the more broken it looked. A per-board failure inside the loop is
  // already captured in `summaries` and does not make the RUN a failure; the run
  // succeeded in doing its job of polling, so the row says so and the counters carry
  // the detail.
  if (runId) {
    await db
      .from("agent_runs")
      .update({
        status: "succeeded",
        finished_at: new Date().toISOString(),
        // rows_in is what we looked at, rows_out is what we created. Kept as two
        // numbers because "polled 40 boards, created 0 applications" is the early
        // warning that the pipeline is dry, and one combined total would hide it.
        rows_in: totalJobsDiscovered,
        rows_out: totalApplicationsCreated,
      })
      .eq("id", runId);
  }

  return jsonResponse(200, {
    success: true,
    boards_polled: summaries.length,
    jobs_discovered: totalJobsDiscovered,
    applications_created: totalApplicationsCreated,
    results: summaries,
  });
});
