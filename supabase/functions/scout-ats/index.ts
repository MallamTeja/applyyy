// Scout-ATS — Edge Function Entrypoint
//
// Polls registered company boards from `company_watchlist` using dedicated ATS
// adapters (Greenhouse, Lever, Ashby).
// Deduplicates postings by canonical fingerprint into `public.jobs`, creates initial
// `public.applications` records at status `discovered`, and updates polling telemetry.

import { createAppUserClient } from "../_shared/db/client.ts";
// Caller authentication shared with the pipeline agents; this function is browser-invoked.
import { authorizeCaller } from "../_shared/db/gates.ts";
import { getAdapter, supportedProviders, toJobInsert, type JobInsertContext } from "../_shared/ats/registry.ts";
// The blanking guard. Splits one batch into the fewest upserts that cannot let an
// omitted field overwrite a stored one — see _shared/screen/upsert-plan.ts for why
// stripping nulls per row does NOT work.
import { planJobUpsertGroups } from "../_shared/screen/upsert-plan.ts";
// The screener glue. This import is the entire point of the parcel: before it, the
// deterministic cascade had no caller anywhere in the repo.
import { planScreenedApplications } from "../_shared/screen/screen-batch.ts";
// The Screener's database context, and the adapter that fetches it.
import { loadScreenContext } from "../_shared/screen/context.ts";
import { supabaseScreenQueries } from "../_shared/screen/supabase-queries.ts";
// Persists the cascade's "rule skipped" warnings into the run row (B1, 2026-10-08).
import { withRuleWarnings } from "../_shared/screen/run-summary.ts";
import type { AtsProvider, JobInsert } from "../_shared/contracts/shared-types.ts";
// The liveness guards and the fingerprint dedupe. Pure, so the rules that stop a bad poll
// wiping the inventory are tested in liveness.test.ts rather than trusted from here.
import {
  firstPerFingerprint,
  planDisappearances,
  planReappearances,
  type DisappearedJob,
  type StoredJob,
} from "../_shared/scout/liveness.ts";

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
  // Liveness outcome, present only on an "ok" board (a failed poll never reaches it).
  readonly liveness?: {
    // Stored-live jobs marked disappeared by this poll.
    readonly disappeared_marked: number;
    // Disappeared jobs this poll listed again, cleared and repost_count bumped.
    readonly reappeared: number;
    // Why marking was refused or failed, null when it ran. A refusal is NOT a board
    // failure: the poll worked, it just was not evidence of closures.
    readonly disappearance_refused_reason: string | null;
  };
}

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
};

// Default and ceiling for boards polled per run.
const DEFAULT_BOARD_LIMIT = 10;
// Each board is a network fetch plus several writes; this bounds wall-clock time.
const MAX_BOARD_LIMIT = 50;

// Parses `?limit` the same way the pipeline agents parse their batch size.
function resolveBoardLimit(raw: string | null): number {
  // Absent parameter: the default.
  if (raw === null) return DEFAULT_BOARD_LIMIT;
  // `Number("")` is 0 and is rejected below with NaN and fractions.
  const parsed = Number(raw);
  // Only a positive whole number is a limit.
  if (!Number.isInteger(parsed) || parsed < 1) return DEFAULT_BOARD_LIMIT;
  // Clamp to the ceiling.
  return Math.min(parsed, MAX_BOARD_LIMIT);
}

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
  // Validated: `parseInt("abc")` is NaN and `parseInt("2.5")` silently truncates.
  const limitBoards = resolveBoardLimit(url.searchParams.get("limit"));
  const specificBoard = url.searchParams.get("board");

  const clientResult = await createAppUserClient();
  if (!clientResult.ok) {
    // The reason can name env vars; it belongs in the log, not the response.
    console.error("[scout-ats] database connection failed:", clientResult.reason);
    return jsonResponse(500, { error: "db_client_failed" });
  }

  const { db } = clientResult;

  // GATE 1 — WHO IS CALLING. The browser invokes this function (discoveryService.ts), and
  // the platform's verify_jwt accepts the public anon key, so without this anyone holding
  // the bundle's key could trigger polls — including `?force=true` past the kill switch.
  const caller = await authorizeCaller(req, db, clientResult.userId);
  // 401 for no/invalid session, 403 for someone else's; the verdict carries which.
  if (!caller.ok) return jsonResponse(caller.status, { error: caller.error });

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

  // THE SCREENER'S CONTEXT, LOADED ONCE FOR THE WHOLE RUN rather than per board. The
  // rules, the blocklist and the application history are properties of the USER, not of
  // the board being polled, so re-reading them forty times would be forty times the cost
  // for the same answer. The clock is passed in so every board in one run screens
  // against the same instant — otherwise a run spanning midnight would apply a different
  // staleness window to its last board than to its first.
  const screenContext = await loadScreenContext(supabaseScreenQueries(db, now), now);

  // A FAILED CONTEXT LOAD MUST NOT SILENTLY BECOME AN EMPTY CONTEXT. Three rules
  // (already_applied, company_blocklist, per_company_weekly_cap) read nothing but this
  // context, so screening with an empty one would pass every job while reporting a clean
  // screen — the precise failure this parcel exists to remove. When it fails we do not
  // screen at all: rows are created at 'discovered', exactly as before this change, which
  // is a TRUE statement about them (they have not been screened) and leaves them
  // findable by a later backfill. Recording them as 'passed_filters' would be a lie.
  if (!screenContext.ok) {
    console.warn(`[scout-ats] screener context unavailable, inserting unscreened: ${screenContext.reason}`);
  }

  // Warnings accumulated across every board, de-duplicated by the planner. Surfaced in
  // the response because an unconfigured rule is invisible otherwise — it passes jobs
  // and says nothing, which reads exactly like a rule that is working.
  const screenWarnings = new Set<string>();
  // Counters. A screener that drops nothing and a screener that was never called produce
  // identical databases, so these are the only thing that tells them apart.
  let totalPassed = 0;
  let totalDropped = 0;

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

      // LIVENESS SNAPSHOT, READ BEFORE THIS POLL WRITES ANYTHING. Order is the guard: read
      // after the inserts, a fingerprint drift would insert every posting as a NEW row, the
      // new rows would overlap the poll 100%, and the drift check would pass vacuously while
      // every old row was marked dead. Scoped to THIS board: same owner, provider and company,
      // and discovered through this adapter's source -- an aggregator-found job with the same
      // provider and slug may not be on this board, so its absence here says nothing.
      // Deliberately NOT using last_seen_at age: it is untrustworthy on existing rows
      // (2026-10-05 diagnosis); only a successful poll's fingerprint set is evidence.
      // ponytail: postgrest caps at 1000 rows; a truncated snapshot can only under-mark,
      // never over-mark. Page it if a board ever exceeds 1000 stored jobs.
      const { data: boardJobs, error: boardJobsError } = await db
        .from("jobs")
        .select("id, fingerprint, disappeared_at, repost_count")
        // Explicit owner scope, not only RLS: the update below must never cross users.
        .eq("user_id", clientResult.userId)
        // Provider + slug identify the board's company (core_tables.sql jobs columns).
        .eq("ats_provider", board.ats_provider)
        .eq("company_slug", board.company_slug)
        // Only rows this board's adapter has ever reported can drop off this board.
        .contains("discovered_via", [adapter.discoverySource]);
      // The snapshot's row shape; postgrest hands back loosely typed rows.
      type BoardJob = { id: string; fingerprint: string; disappeared_at: string | null; repost_count: number };
      // Typed once for both splits below.
      const snapshot = (boardJobs ?? []) as BoardJob[];
      // Live jobs: the candidates for marking.
      const storedLive: StoredJob[] = snapshot.filter((j) => j.disappeared_at === null);
      // Disappeared jobs: the candidates for clearing.
      const storedDisappeared: DisappearedJob[] = snapshot.filter((j) => j.disappeared_at !== null);

      const BATCH_SIZE = 50;
      // Postings stay paired with their rows: a re-sighted posting is rebuilt below with
      // its STORED first_seen_at, which needs the posting, not just the row.
      const prepared = await Promise.all(
        parseResult.postings.map(async (posting) => ({ posting, row: await toJobInsert(posting, adapter, context) })),
      );

      // ONE ROW PER FINGERPRINT before any write. The fingerprint is company+title+location,
      // not the posting id, so two live postings can share one; the re-sighting upsert below
      // is ON CONFLICT DO UPDATE, and a batch holding both fails whole with "cannot affect
      // row a second time" -- failing the board. First wins; see firstPerFingerprint.
      const unique = firstPerFingerprint(prepared, (p) => p.row.fingerprint);

      let boardInserted = 0;
      let boardNewApps = 0;

      for (let i = 0; i < unique.length; i += BATCH_SIZE) {
        // This slice of postings and the rows built for them, one per fingerprint.
        const slice = unique.slice(i, i + BATCH_SIZE);
        // Rows alone, for the planner and the fallback lookup.
        const batch: JobInsert[] = slice.map((p) => p.row);

        // WHICH OF THESE ALREADY EXIST, and when were they first seen? Read BEFORE writing
        // so `first_seen_at` is write-once. The old single upsert built every row with
        // `firstSeenAt: now`, so on every poll an undated job's `posted_at` and its
        // source_refs `first_seen_at` were reset to the poll time — the staleness rule
        // never saw it age — and `seen_count` never moved off 1.
        const { data: storedRows, error: storedError } = await db
          .from("jobs")
          .select("id, fingerprint, first_seen_at, seen_count")
          .in("fingerprint", batch.map((row) => row.fingerprint));
        // An unreadable lookup would make every job look new; fail the board instead.
        if (storedError) throw new Error(`jobs lookup failed: ${storedError.message}`);
        // fingerprint -> stored sighting facts.
        const storedByFingerprint = new Map(
          (storedRows ?? []).map((r: { id: string; fingerprint: string; first_seen_at: string; seen_count: number }) => [r.fingerprint, r]),
        );

        // Fingerprint -> job id, because the applications rows have to link to the job
        // AND the screener needs the row the id came from.
        const jobIdByFingerprint = new Map<string, string>();
        // Existing rows already have their id.
        for (const stored of storedByFingerprint.values()) jobIdByFingerprint.set(stored.fingerprint, stored.id);

        // NEW ROWS: insert-only. `ignoreDuplicates` means a row that appeared between the
        // lookup and this write (a concurrent run) is left alone rather than overwritten
        // with a fresh first sighting. `first_seen_at` takes its column default.
        const newRows = slice.filter((p) => !storedByFingerprint.has(p.row.fingerprint)).map((p) => p.row);
        // ONE UPSERT PER DISTINCT KEY-SET, not one per batch. postgrest-js sends the
        // UNION of keys across the whole array as `columns=`, so a single request cannot
        // express "this row omits description_raw but that one sets it". See
        // _shared/screen/upsert-plan.ts.
        for (const group of planJobUpsertGroups(newRows)) {
          const { data: insertedJobs, error: insertError } = await db
            .from("jobs")
            .upsert(group, { onConflict: "user_id,fingerprint", ignoreDuplicates: true })
            .select("id, fingerprint");
          // A failed write is a failed board, never a healthy one.
          if (insertError) throw new Error(`jobs insert failed: ${insertError.message}`);
          // Only rows actually inserted come back.
          for (const job of insertedJobs ?? []) jobIdByFingerprint.set(job.fingerprint, job.id);
        }

        // EXISTING ROWS: rebuilt with their stored first sighting, so the derived
        // `posted_at` and the source_refs `first_seen_at` keep their original value.
        // `first_seen_at` itself is never in the payload, so the upsert cannot touch it.
        const resighted = await Promise.all(
          slice
            .filter((p) => storedByFingerprint.has(p.row.fingerprint))
            .map(async (p) => {
              // Narrowed by the filter.
              const stored = storedByFingerprint.get(p.row.fingerprint)!;
              // Same posting, same board, original first sighting.
              const row = await toJobInsert(p.posting, adapter, { ...context, firstSeenAt: new Date(stored.first_seen_at) });
              // ponytail: read-then-write increment; two concurrent polls of one board can
              // lose a count. An RPC doing `seen_count = seen_count + 1` fixes it.
              return { ...row, seen_count: stored.seen_count + 1, last_seen_at: now.toISOString() };
            }),
        );
        // Same blanking guard as the insert path.
        for (const group of planJobUpsertGroups(resighted)) {
          const { error: updateError } = await db
            .from("jobs")
            .upsert(group, { onConflict: "user_id,fingerprint", ignoreDuplicates: false });
          // A failed refresh is a failed board.
          if (updateError) throw new Error(`jobs refresh failed: ${updateError.message}`);
        }

        // Fallback for rows inserted by a concurrent run between our lookup and insert.
        const missing = batch.filter((row) => !jobIdByFingerprint.has(row.fingerprint)).map((row) => row.fingerprint);
        if (missing.length > 0) {
          const { data: existingJobs, error: existingError } = await db
            .from("jobs")
            .select("id, fingerprint")
            .in("fingerprint", missing);
          // Unresolvable ids would silently drop applications; fail the board.
          if (existingError) throw new Error(`jobs fallback lookup failed: ${existingError.message}`);
          for (const job of existingJobs ?? []) jobIdByFingerprint.set(job.fingerprint, job.id);
        }

        // Pair each persisted job with the row it was built from. Rows whose id could not
        // be resolved are skipped rather than guessed at.
        const entries = batch
          .filter((row) => jobIdByFingerprint.has(row.fingerprint))
          .map((row) => ({ jobId: jobIdByFingerprint.get(row.fingerprint)!, row }));

        if (entries.length > 0) {
          // THE SEAM. Every posting is screened against the deterministic cascade before
          // its queue row exists, so a job that fails a filter never becomes work for the
          // Matcher — which is the saving §8 is built on, since the Tailor and Auditor
          // only ever see what the Matcher saw.
          //
          // The row is BORN at its verdict rather than inserted at 'discovered' and then
          // transitioned, because the verdict is already computed here. Reaching it through
          // UPDATEs would take two guarded hops, discovered -> deduped (agent 'normalizer')
          // and deduped -> verdict (agent 'screener'), so this function would have to act
          // as the Normalizer, which runs separately (supabase/functions/normalizer/). The
          // INSERT allowlist (20260917130000) admits passed_filters/dropped_filter for
          // exactly this. 'discovered' remains only as the screener-unavailable fallback
          // below, and the Normalizer picks those rows up. Corrected 2026-10-08: this
          // previously said nothing writes 'deduped'. See docs/screener/.
          const appInserts = screenContext.ok
            ? (() => {
                const plan = planScreenedApplications(
                  entries,
                  screenContext.value.rules,
                  screenContext.value.context,
                  // Stage 0's config, loaded in the same round as the rules so the gate
                  // and the cascade cannot be run against settings read at two moments.
                  screenContext.value.preferences,
                );
                // Carry the counters and warnings up to the run summary.
                for (const warning of plan.warnings) screenWarnings.add(warning);
                totalPassed += plan.passedCount;
                totalDropped += plan.droppedCount;
                // Log each drop with its prose reason: `drop_reason` on the row names the
                // rule so it can be grouped, but only this says why THIS posting matched.
                for (const drop of plan.dropped) {
                  console.log(`[scout-ats] dropped "${drop.title}" — ${drop.ruleType}: ${drop.reason}`);
                }
                return plan.inserts;
              })()
            // The unscreened fallback. 'discovered' is the honest status for a row the
            // screener could not evaluate, and it is what this function wrote before the
            // screener existed.
            : entries.map((entry) => ({ job_id: entry.jobId, status: "discovered" as const, drop_reason: null }));

          const { data: insertedApps, error: appErr } = await db
            .from("applications")
            .upsert(appInserts, {
              onConflict: "user_id,job_id",
              ignoreDuplicates: true,
            })
            .select("id");

          // A failed queue write means jobs exist with no application row; the board
          // failed, and the catch below records it so the next poll retries.
          if (appErr) throw new Error(`applications upsert failed: ${appErr.message}`);
          // Only rows actually inserted come back (ignoreDuplicates).
          boardNewApps += (insertedApps ?? []).length;
          // Run-level total.
          totalApplicationsCreated += (insertedApps ?? []).length;
        }

        boardInserted += entries.length;
        totalJobsDiscovered += entries.length;
      }

      // Update watchlist success telemetry. Checked: a board whose success record did
      // not land would be re-polled as "never polled" and its cold-start guard re-armed.
      const { error: watchlistError } = await db
        .from("company_watchlist")
        .update({
          poll_count: (board.poll_count || 0) + 1,
          first_polled_at: board.first_polled_at || now.toISOString(),
          last_polled_at: now.toISOString(),
          last_poll_job_count: parseResult.postings.length,
          consecutive_failures: 0,
        })
        .eq("id", board.id);
      // Reported as a failed board by the catch below.
      if (watchlistError) throw new Error(`watchlist update failed: ${watchlistError.message}`);

      // LIVENESS, ONLY NOW: every batch landed and the success record is written, so this
      // poll is a complete view of the board. Every throw above skips this block entirely.
      // The poll's identity set; duplicates are harmless, the planner takes a Set.
      const polledFingerprints = unique.map((p) => p.row.fingerprint);
      // Why marking did not run, if it did not. Null means it ran.
      let refusedReason: string | null = null;
      // Rows actually marked, counted only when the write landed.
      let markedCount = 0;
      // Rows actually cleared, counted only when the write landed.
      let reappearedCount = 0;
      if (boardJobsError) {
        // An unreadable snapshot is "no evidence", never "no stored jobs": refuse, don't fail.
        refusedReason = `snapshot_failed: ${boardJobsError.message}`;
      } else {
        // pollOk and batchErrors are literals because reaching this line PROVES them: a
        // failed fetch/parse `continue`s, and every per-board write error (lookup, insert,
        // refresh, fallback, applications, watchlist) THROWS to the catch, which skips this
        // block. A board with any write error therefore never marks. Kept as inputs so the
        // pure planner still refuses if this call site is ever restructured to collect
        // errors instead of throwing.
        const plan = planDisappearances({ storedLive, polledFingerprints, pollOk: true, batchErrors: 0 });
        if (plan.kind === "refuse") {
          // Logged with its numbers so a drift or WAF page is diagnosable without a re-poll.
          console.warn(`[scout-ats] ${board.ats_provider}/${board.board_token} liveness refused: ${plan.reason} (${plan.detail})`);
          // Recorded on the summary and the run row; not an error.
          refusedReason = plan.reason;
        } else if (plan.ids.length > 0) {
          // Owner-scoped as well as id-scoped, and only rows still live, so a concurrent
          // run's mark is not overwritten with a later timestamp.
          const { error: markError } = await db
            .from("jobs")
            .update({ disappeared_at: now.toISOString() })
            .eq("user_id", clientResult.userId)
            .in("id", plan.ids)
            .is("disappeared_at", null);
          // The jobs were polled fine; a failed mark is a liveness gap, not a failed board.
          if (markError) refusedReason = `mark_write_failed: ${markError.message}`;
          // Counted only when the write landed.
          else markedCount = plan.ids.length;
        }

        // Reposts: cleared and counted. Per row because repost_count is per-row + 1.
        // ponytail: read-then-write increment, same ceiling as seen_count above.
        for (const job of planReappearances({ storedDisappeared, polledFingerprints, pollOk: true })) {
          const { error: reappearError } = await db
            .from("jobs")
            .update({ disappeared_at: null, repost_count: job.repost_count + 1 })
            .eq("user_id", clientResult.userId)
            .eq("id", job.id);
          // Logged, not thrown: the posting is listed either way; next poll retries the clear.
          if (reappearError) console.warn(`[scout-ats] reappearance clear failed for ${job.id}: ${reappearError.message}`);
          // Counted only when it landed.
          else reappearedCount += 1;
        }
      }

      summaries.push({
        board: board.board_token,
        provider: board.ats_provider,
        status: "ok",
        fetched: parseResult.postings.length,
        inserted: boardInserted,
        // Per board, because a refusal on one board says nothing about the others.
        liveness: {
          disappeared_marked: markedCount,
          reappeared: reappearedCount,
          disappearance_refused_reason: refusedReason,
        },
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
  //
  // HONEST CLOSE (2026-10-04): per-board failures are now COUNTED on the run row, and a
  // run in which every attempted board failed is `failed` — "succeeded, 0 errors" over a
  // run that wrote nothing was the old reading whenever every jobs upsert errored.
  const failedBoards = summaries.filter((s) => s.status === "failed");
  // Boards actually attempted; skipped ones (no adapter) are neither success nor failure.
  const attemptedBoards = summaries.filter((s) => s.status !== "skipped").length;
  // All attempted boards failed: the run did not do its job.
  const runFailed = attemptedBoards > 0 && failedBoards.length === attemptedBoards;
  // Liveness refusals, recorded on the run but NOT counted as errors: the boards polled fine.
  const livenessRefusals = summaries
    .filter((s) => s.liveness?.disappearance_refused_reason)
    .map((s) => `${s.provider}/${s.board}: ${s.liveness?.disappearance_refused_reason}`);
  // Run-level total for the response.
  const totalDisappearedMarked = summaries.reduce((n, s) => n + (s.liveness?.disappeared_marked ?? 0), 0);
  if (runId) {
    await db
      .from("agent_runs")
      .update({
        status: runFailed ? "failed" : "succeeded",
        // How many boards failed, so a partial failure is visible on the health page.
        error_count: failedBoards.length,
        // The first few reasons; enough to diagnose without unbounded text.
        // Board failures first, then liveness refusals in their own labelled segment, so a
        // refusal can never be mistaken for one of the error_count failures.
        // Then the cascade's rule warnings, labelled the same way (B1, 2026-10-08): this scout
        // screens most rows, and its warnings were only in the HTTP response.
        error_detail: withRuleWarnings([
          ...failedBoards.slice(0, 5).map((s) => `${s.provider}/${s.board}: ${s.error ?? "unknown"}`),
          ...(livenessRefusals.length > 0 ? [`liveness_refused: ${livenessRefusals.slice(0, 5).join(", ")}`] : []),
        ].join("; ") || null, screenWarnings),
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
    // THE SCREENER'S OWN COUNTERS, reported separately from the discovery counters
    // because they answer a different question. `jobs_discovered` says the poll worked;
    // these say the CASCADE worked. Without them a screener enforcing nothing is
    // indistinguishable from a screener that was never called — and with filter_rules
    // currently unseeded, `screened_dropped: 0` is the expected reading today.
    screened_passed: totalPassed,
    screened_dropped: totalDropped,
    // False when the context load failed and rows were written unscreened at
    // 'discovered'. Explicit, so a consumer never has to infer it from zero drops.
    screening_applied: screenContext.ok,
    // Unconfigured rules announce themselves here. An empty array with zero drops means
    // the rules are configured and nothing matched; a populated one means the filters are
    // not actually protecting anything yet.
    screen_warnings: [...screenWarnings],
    // Run total of jobs marked disappeared; per-board detail is in `results`.
    disappeared_marked: totalDisappearedMarked,
    // Boards whose marking was refused, with why. Empty means every ok board was evaluated.
    disappearance_refused_reason: livenessRefusals,
    results: summaries,
  });
});
