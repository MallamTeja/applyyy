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

function jsonResponse(status: number, data: Record<string, unknown>): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

Deno.serve(async (req: Request): Promise<Response> => {
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

  // 1. Check Kill Switch
  const { data: settingsData, error: settingsError } = await db
    .from("system_settings")
    .select("system_enabled")
    .limit(1)
    .single();

  if (settingsError && settingsError.code !== "PGRST116") {
    return jsonResponse(500, {
      error: "kill_switch_read_failed",
      detail: settingsError.message,
    });
  }

  const systemEnabled = settingsData?.system_enabled ?? false;
  if (!systemEnabled && !force) {
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
    return jsonResponse(500, {
      error: "watchlist_query_failed",
      detail: boardsError.message,
    });
  }

  if (!boards || boards.length === 0) {
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

      let boardInserted = 0;

      for (const posting of parseResult.postings) {
        const jobRow: JobInsert = await toJobInsert(posting, adapter, context);

        // Upsert job by fingerprint (per-user)
        const { data: insertedJob, error: jobError } = await db
          .from("jobs")
          .upsert(jobRow, {
            onConflict: "user_id,fingerprint",
            ignoreDuplicates: false,
          })
          .select("id")
          .single();

        if (jobError) {
          // If upsert fails or conflict, query existing job id
          const { data: existingJob } = await db
            .from("jobs")
            .select("id")
            .eq("fingerprint", jobRow.fingerprint)
            .single();

          if (existingJob) {
            // Ensure application row exists at 'discovered'
            const { error: appErr } = await db
              .from("applications")
              .insert({
                job_id: existingJob.id,
                status: "discovered",
              })
              .select("id")
              .single();

            if (!appErr) totalApplicationsCreated++;
          }
          continue;
        }

        if (insertedJob) {
          boardInserted++;
          totalJobsDiscovered++;

          // Seed application row for the new job
          const { error: appError } = await db
            .from("applications")
            .insert({
              job_id: insertedJob.id,
              status: "discovered",
            })
            .select("id")
            .single();

          if (!appError) {
            totalApplicationsCreated++;
          }
        }
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

  return jsonResponse(200, {
    success: true,
    boards_polled: summaries.length,
    jobs_discovered: totalJobsDiscovered,
    applications_created: totalApplicationsCreated,
    results: summaries,
  });
});
