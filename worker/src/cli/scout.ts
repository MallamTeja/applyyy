// Scout-ATS CLI Runner — `pnpm --filter '@applyy/worker' run scout`
//
// Polls registered company boards in `public.company_watchlist` using native ATS
// adapters (every provider `supportedProviders()` lists), reading every page of a
// paginated board.
// Deduplicates postings into `public.jobs` and seeds initial `public.applications`
// rows in status 'discovered'.

import { createClient } from '@supabase/supabase-js';
import { getAdapter, supportedProviders, toJobInsert, type JobInsertContext } from '../../../supabase/functions/_shared/ats/registry.ts';
// The screener glue, shared with the Edge Function rather than duplicated. THIS FILE IS
// THE ONE ON CRON (.github/workflows/scout.yml:61 -> package.json:13), so this import is
// what actually puts the cascade in front of Teja's queue.
import { planScreenedApplications } from '../../../supabase/functions/_shared/screen/screen-batch.ts';
// The Screener's database context, and the adapter that fetches it.
import { loadScreenContext } from '../../../supabase/functions/_shared/screen/context.ts';
import { supabaseScreenQueries } from '../../../supabase/functions/_shared/screen/supabase-queries.ts';
// The dedupe + insert/refresh split that keeps one fingerprint from poisoning a batch.
import { dedupeByFingerprint, persistJobBatch, watchlistPollUpdate, type PreparedJob } from '../scout/persist-jobs.ts';
// The board-identity guard, shared with scout-ats: a wrong token can answer 200 with a
// DIFFERENT company's jobs (2026-10-23 'tcs'→Thornbury), and this file is the one on cron.
import { evaluateBoardIdentity } from '../../../supabase/functions/_shared/ats/identity.ts';
// The one refuse-this-board decision and the one failed-poll update, shared with scout-ats
// so the two pollers cannot disagree about which board is failing. Pure and tested in
// _shared/ats/adapters.test.ts, since this file runs main() on import and cannot be.
import { boardRefusal, failureMark } from '../../../supabase/functions/_shared/ats/registry.ts';
// Every page of a board through plain HTTP, kept in its own module so it can be tested; and the
// same module's robots-gated single GET, for the Workday detail read.
import { readBoardPages, robotsGatedGet } from '../scout/board-pages.ts';
// Disappearance marking with the edge's own planner (2026-11-05): this cron scout never marked any.
import { applyBoardLiveness, readLivenessSnapshot } from '../scout/liveness-marking.ts';
// The Workday detail read (2026-11-05): one run per scout run, so its read cap spans every board.
import { newWorkdayDetailRun, WORKDAY_DETAIL_CAP, type WorkdayDetailRun } from '../../../supabase/functions/_shared/scout/workday-detail.ts';
// The title-only verdict decides which Workday postings are worth a detail read.
import { screenTechRole } from '../../../supabase/functions/_shared/screen/tech-gate.ts';
// The shared countdown, so this run's budget is measured the way the matcher's is.
import { createDeadline } from '../../../supabase/functions/_shared/agent/deadline.ts';
// How this run ends (W40 budget gate, W12 loud screener fallback), kept pure and tested
// in worker/test/scout-run-outcome.test.ts because this file cannot be imported by a test.
import { SCOUT_BUDGET_MS, boardsWithinBudget, scoutRunClose } from '../scout/run-outcome.ts';
import type { AtsProvider, JobInsert } from '../../../packages/shared-types/src/tables.ts';

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is not set. Required for Scout-ATS runner.`);
  }
  return value;
}

interface WatchlistRow {
  id: string;
  ats_provider: AtsProvider;
  board_token: string;
  company_name: string;
  company_slug: string;
  poll_count: number;
  first_polled_at: string | null;
  last_polled_at: string | null;
  consecutive_failures: number;
  // The last SUCCESSFUL poll's posting count, null before the first one: the baseline the
  // emptied-board gate compares against.
  last_poll_job_count: number | null;
}

const BATCH_SIZE = 50;

async function main(): Promise<void> {
  console.log('[applyy-scout] starting ATS job board discovery scan...');
  // THE RUN BUDGET (W40), started first so sign-in and the context load count against it:
  // the job timeout in scout.yml counts them too.
  const deadline = createDeadline({ budgetMs: SCOUT_BUDGET_MS });

  const supabaseUrl = required('SUPABASE_URL');
  const anonKey = required('SUPABASE_ANON_KEY');
  const email = required('APPLYY_APP_USER_EMAIL');
  const password = required('APPLYY_APP_USER_PASSWORD');
  const force = process.argv.includes('--force') || process.env.SCOUT_FORCE === 'true';

  const client = createClient(supabaseUrl, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const authResult = await client.auth.signInWithPassword({ email, password });
  if (authResult.error || !authResult.data.user) {
    throw new Error(`[applyy-scout] sign-in failed: ${authResult.error?.message ?? 'no user'}`);
  }

  const userId = authResult.data.user.id;
  console.log(`[applyy-scout] authenticated as operator ${email} (${userId})`);

  // 1. Record run start in agent_runs
  const { data: runRow, error: runErr } = await client
    .from('agent_runs')
    .insert({
      agent: 'scout_ats',
      status: 'running',
      started_at: new Date().toISOString(),
    })
    .select('id')
    .single();

  // FATAL, not skipped. A scout that cannot open its run row would do all its
  // work invisibly — the health page reads "no row" exactly like "cron is dead".
  // supabase-js returns errors as values, so without this check a refused
  // insert was silently a run with no record at all.
  if (runErr || !runRow) {
    throw new Error(`[applyy-scout] could not open agent_runs row: ${runErr?.message ?? 'no row returned'}`);
  }

  // Non-null from here on, so every close below writes to a row that exists.
  const runId: string = runRow.id;

  // Every DB write that failed this run, as "where: message". Counted rather
  // than thrown, so one refused upsert does not abandon the other boards — but
  // the run is closed `failed` with this list, never `succeeded` over it. Same
  // rule as worker/src/claim-loop.ts: any error means the run is not a success.
  const dbErrors: string[] = [];
  // Records one supabase-js error value, if there is one. Takes the error
  // rather than the whole result so every call site reads `noteError(..., x.error)`.
  function noteError(where: string, error: { message: string } | null): void {
    // No error means nothing to record; the common case.
    if (!error) return;
    // Logged as it happens, so the Actions log shows WHICH board it was.
    console.error(`[applyy-scout] ✗ ${where}: ${error.message}`);
    dbErrors.push(`${where}: ${error.message}`);
  }

  // Closes the run row and CHECKS that the close landed. An unchecked close
  // that fails leaves the row `running` forever — the signature of a crash —
  // so a failure here is thrown and the process exits non-zero.
  async function closeRun(update: Record<string, unknown>): Promise<void> {
    const { error } = await client.from('agent_runs').update(update).eq('id', runId);
    // Thrown rather than noted: there is no later write that could report it.
    if (error) throw new Error(`[applyy-scout] could not close agent_runs ${runId}: ${error.message}`);
  }

  // Check system kill switch. `maybeSingle` so a missing settings row is
  // `data: null` (read below as disabled — fail closed), while a real read
  // failure is an `error` that is no longer mistaken for "switch off".
  const { data: settingsData, error: settingsErr } = await client
    .from('system_settings')
    .select('system_enabled')
    .limit(1)
    .maybeSingle();

  // Unknown kill-switch state is a failed run, not a skipped one: "skipped"
  // would claim the switch was read as off, and nobody read it.
  if (settingsErr) {
    await closeRun({
      status: 'failed',
      finished_at: new Date().toISOString(),
      error_count: 1,
      error_detail: `system_settings read failed: ${settingsErr.message}`,
    });
    throw new Error(`[applyy-scout] system_settings read failed: ${settingsErr.message}`);
  }

  const systemEnabled = settingsData?.system_enabled ?? false;
  if (!systemEnabled && !force) {
    console.log('[applyy-scout] ⏸️ system_settings.system_enabled is false (kill switch active).');
    console.log('[applyy-scout] Pass --force or SCOUT_FORCE=true to discover jobs while submissions are paused.');
    // Checked close: a skip that fails to record itself would read as a crash.
    await closeRun({
      status: 'skipped_disabled',
      finished_at: new Date().toISOString(),
      error_detail: 'system_settings.system_enabled is false',
    });
    return;
  }

  if (!systemEnabled && force) {
    console.log('[applyy-scout] ⚡ force mode enabled: proceeding with discovery scan while applier remains paused.');
  }

  // Query active company watchlist boards
  const { data: boards, error: boardsErr } = await client
    .from('company_watchlist')
    // last_poll_job_count is read for the emptied-board gate; without it every board would
    // look "never polled" and the gate could never fire.
    .select('id, ats_provider, board_token, company_name, company_slug, poll_count, first_polled_at, last_polled_at, consecutive_failures, last_poll_job_count')
    .eq('enabled', true)
    .in('ats_provider', supportedProviders())
    .order('last_polled_at', { ascending: true, nullsFirst: true });

  if (boardsErr) {
    // Closed `failed` before throwing, so the health page shows a failed run
    // with its reason instead of a row stuck at `running`.
    await closeRun({
      status: 'failed',
      finished_at: new Date().toISOString(),
      error_count: 1,
      error_detail: `company_watchlist read failed: ${boardsErr.message}`,
    });
    throw new Error(`[applyy-scout] failed to query company_watchlist: ${boardsErr.message}`);
  }

  if (!boards || boards.length === 0) {
    // Derived from the registry, so the list cannot go stale when a provider is added (as SR was).
    console.log(`[applyy-scout] no enabled company boards found for supported providers (${supportedProviders().join(', ')}).`);
    // Close the run row before returning. Without this the row opened above stays
    // 'running' forever, and the health page reads a permanently-running row as the
    // signature of a CRASH — see 20260909234800_supporting_tables.sql, which opens
    // runs early on purpose so a death leaves a visible stuck row. An empty watchlist
    // is not a death: it is a successful no-op, and it has to be recorded as one or
    // the one table that exists to tell "working" from "silently dead" starts lying
    // in the dangerous direction — reporting failure for a healthy scheduled run.
    await closeRun({
      status: 'succeeded',
      finished_at: new Date().toISOString(),
      // Explicit zeros rather than leaving the defaults implicit: "polled nothing
      // because nothing was configured" and "polled boards and found nothing" are
      // different operational stories, and only the row's counters distinguish them.
      rows_in: 0,
      rows_out: 0,
    });
    return;
  }

  console.log(`[applyy-scout] found ${boards.length} enabled watchlist board(s) to poll.`);

  let totalDiscovered = 0;
  let totalApplications = 0;
  // Boards skipped because they answered as a different company. Log-only by design: the
  // durable record is each board's consecutive_failures, and agent_runs.error_detail is for
  // database errors, which a mis-tokened board is not.
  let totalIdentityMismatch = 0;
  // Boards that had postings last poll and none now; log-only for the same reason.
  let totalEmptiedBoards = 0;
  // Liveness tallies (2026-11-05): rows marked disappeared, rows cleared on a repost, and boards
  // whose plan refused or whose snapshot/write failed. Log-only, like the two counters above.
  let totalMarkedDisappeared = 0;
  // Disappeared rows this run's polls listed again.
  let totalReappeared = 0;
  // Boards where liveness wrote nothing for a reason (refusal or a failed read/write).
  let totalLivenessRefused = 0;
  const now = new Date();

  // THE SCREENER'S CONTEXT, LOADED ONCE FOR THE WHOLE RUN. The rules, the blocklist, the
  // application history and the stage-0 preferences are properties of the USER, not of
  // the board being polled, so re-reading them per board would pay forty times for one
  // answer. The clock is shared too, so a run spanning midnight applies the same
  // staleness window to its last board as to its first.
  const screenContext = await loadScreenContext(supabaseScreenQueries(client, now), now);

  // A FAILED CONTEXT LOAD MUST NOT SILENTLY BECOME AN EMPTY CONTEXT. Three cascade rules
  // read nothing but this context, so screening with an empty one would pass every job
  // while reporting a clean screen. When it fails we do not screen at all: rows are
  // created at 'discovered', exactly as before this change, which is a TRUE statement
  // about them and leaves them findable by a later backfill. Marking them
  // 'passed_filters' would be a lie that the Matcher would then act on.
  // LOUD, NOT SILENT (W12, 2026-11-02): the rows are still inserted, but the close below
  // counts this as `screener_not_run: <reason>`, closes the run `failed` and exits 1, so
  // the Health page and the Actions tick both go red instead of green over an unscreened queue.
  if (!screenContext.ok) {
    console.error(`[applyy-scout] ⚠️ screener context unavailable, inserting unscreened (run will close failed): ${screenContext.reason}`);
  } else {
    console.log('[applyy-scout] screener active: deterministic cascade will run before any job is queued.');
  }

  // WORKDAY DETAIL READS (2026-11-05): new title-passing Workday rows get the description the
  // list endpoint never carries, inside persistJobBatch. Only when the context loaded: the title
  // gate needs its preferences, and an unscreened run has no gate to spend reads on. The run
  // shares the scout's own deadline, so reads take board-polling time, never extra minutes.
  const workdayRun: WorkdayDetailRun | undefined = screenContext.ok
    ? newWorkdayDetailRun({
      // The board poll's robots gate ('scouting' policy), returning the raw Response.
      get: (url) => robotsGatedGet(url),
      // Title only (description null): the description is what this read is for.
      passesTitleGate: (title) => !screenTechRole(title, null, screenContext.value.preferences).drop,
      // The run's 12-min countdown; reads stop with 20 s left (WORKDAY_DETAIL_MIN_REMAINING_MS).
      deadline,
      // A real pause between reads.
      pause: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      // ponytail: a fixed per-run cap shared with scout-ats; raise it if `skipped` is often > 0.
    }, WORKDAY_DETAIL_CAP)
    : undefined;

  // Warnings across the whole run, de-duplicated. An unconfigured rule is otherwise
  // invisible: it passes jobs and says nothing, which reads exactly like a working rule.
  const screenWarnings = new Set<string>();
  // Counters. A screener that drops nothing and one that was never called leave identical
  // databases behind, so these are the only thing that distinguishes them.
  let totalPassed = 0;
  let totalDropped = 0;

  // THE BUDGET GATE (W40). Boards still unstarted when the budget runs out are left
  // untouched, so their older last_polled_at sorts them first next run (the order above);
  // every board this run does start gets last_polled_at = now from watchlistPollUpdate or
  // failureMark. The board in flight is always finished: the check is between boards.
  const budget = boardsWithinBudget(boards as WatchlistRow[], deadline);
  for (const board of budget.boards) {
    const adapter = getAdapter(board.ats_provider);
    if (!adapter) {
      console.log(`[applyy-scout] skipping ${board.company_name} (${board.board_token}): no adapter for ${board.ats_provider}`);
      continue;
    }

    console.log(`[applyy-scout] polling ${board.company_name} on ${board.ats_provider} (${board.board_token})...`);

    try {
      // EVERY PAGE, OR A FAILED BOARD. A paginated board (SmartRecruiters, 100 per page)
      // read as one response stored page one only. A non-ok page now THROWS into the
      // catch below, which records the failure exactly as the old non-ok branch did.
      const parseResult = await readBoardPages(adapter, board.board_token);

      if (!parseResult.ok) {
        // "Board read failed" rather than "parse failed": a stalled cursor or the page cap
        // lands here too, and the reason names which, and on which page.
        console.warn(`[applyy-scout] ⚠️ ${board.company_name} board read failed: ${parseResult.reason}`);
        // Checked: an unrecorded failure leaves `consecutive_failures` low, so a
        // dead board never looks dead enough to disable.
        const { error: failMarkErr } = await client.from('company_watchlist').update(failureMark(board, now)).eq('id', board.id);
        noteError(`${board.company_name}: record poll failure`, failMarkErr);
        continue;
      }

      // REFUSAL BEFORE ANY WRITE, the same decision scout-ats makes (boardRefusal): the
      // board answered as a different company, or had postings last poll and none now (a
      // dead SR token soft-200s as an empty board). Checked after the read so a malformed
      // payload is still recorded as the read failure it is; before toJobInsert so a
      // refused board's postings never reach jobs, applications, or the screener.
      const refusal = boardRefusal(
        // Page one's payload answers for the board: one board is one company. The token too, so a verified
        // board alias (identity.ts BOARD_IDENTITY_ALIASES, e.g. xai reporting "SpaceXSI") applies here as in scout-ats.
        evaluateBoardIdentity(adapter, parseResult.firstPayload, board.company_name, board.board_token),
        // The row's name and its last successful posting count.
        board,
        // This poll's count across every page.
        parseResult.postings.length,
      );
      if (refusal !== null) {
        // The diagnosis in the Actions log, so the token or the row can be fixed without re-polling.
        console.warn(`[applyy-scout] ⚠️ ${board.company_name}: ${refusal.warning}`);
        // Checked like every other mark: a lost write would leave a refused board looking
        // healthy. failureMark leaves last_poll_job_count as the non-zero baseline.
        const { error: refusalMarkErr } = await client.from('company_watchlist').update(failureMark(board, now)).eq('id', board.id);
        // Only a failed WRITE is a run error; the refusal itself is board state.
        const isMismatch = refusal.kind === 'identity_mismatch';
        // Each kind keeps its own label, so the run row says which refusal failed to record.
        noteError(`${board.company_name}: ${isMismatch ? 'record identity mismatch' : 'record emptied board'}`, refusalMarkErr);
        // Counted per kind for the closing summary lines.
        if (isMismatch) totalIdentityMismatch += 1;
        else totalEmptiedBoards += 1;
        // Skip every write for this board.
        continue;
      }

      console.log(`[applyy-scout] ✓ ${board.company_name}: fetched ${parseResult.postings.length} postings from ATS.`);

      const context: JobInsertContext = {
        companyName: board.company_name,
        companySlug: board.company_slug,
        now,
        firstSeenAt: now,
        isFirstPollOfBoard: (board.poll_count === 0 || !board.first_polled_at),
      };

      // Convert postings into JobInsert rows with canonical fingerprint & freshness. Each
      // keeps a rebuild hook so a re-sighted posting can be rebuilt with its STORED first_seen_at.
      // Built in parallel because toJobInsert is async and independent per posting.
      const built: PreparedJob[] = await Promise.all(
        parseResult.postings.map(async (p) => ({
          // First-sighting row, used for dedupe and as the insert payload.
          row: await toJobInsert(p, adapter, context),
          // Closure over the posting, so the refresh path can rebuild with the stored date without re-parsing.
          rebuild: (firstSeenAt: Date) => toJobInsert(p, adapter, { ...context, firstSeenAt }),
        })),
      );

      // ONE POSTING PER FINGERPRINT, for the whole board, before any batching. Two live
      // postings can share company+title+location, and a duplicate conflict key inside one
      // statement rejects it whole. Whole-board (not per-batch) so a twin in a later batch
      // is not mistaken for a re-sighting and does not double-count seen_count.
      // Destructured once so the log below and the batching share one result.
      const { kept: prepared, collisions } = dedupeByFingerprint(built);
      // Never silent: these postings are dropped from the write on purpose.
      if (collisions > 0) {
        console.warn(`[applyy-scout] ⚠️ ${board.company_name}: ${collisions} posting(s) shared a fingerprint with another; kept one each.`);
      }

      // LIVENESS SNAPSHOT, read BEFORE the first job write below: read after the inserts, a
      // fingerprint drift would make every posting a new row that "overlaps" 100% and the guards
      // would pass vacuously (liveness.ts). Scoped like scout-ats's snapshot.
      const livenessSnapshot = await readLivenessSnapshot(client, userId, board, adapter.discoverySource);

      // Per-board tally for the closing log line.
      let boardNewJobs = 0;
      // Counts only rows the insert actually created, since ignored duplicates return nothing.
      let boardNewApps = 0;
      // Job-write failures for THIS board only; decides healthy vs failed below.
      const boardErrors: string[] = [];

      // Upsert in batches of BATCH_SIZE for high throughput
      for (let i = 0; i < prepared.length; i += BATCH_SIZE) {
        // Slice keeps the postings paired with their rebuild hooks, which the plain rows lose.
        const slice = prepared.slice(i, i + BATCH_SIZE);
        // Plain rows are what the screener and the fallback matching read.
        const batch: JobInsert[] = slice.map((j) => j.row);

        // Insert-new / refresh-existing split; first_seen_at is never overwritten.
        // One call owns every jobs write, so the batch cannot be half-handled by this file.
        // The run's Workday detail reads ride along; persistJobBatch spends them on new rows only.
        const persisted = await persistJobBatch(client, slice, now, workdayRun);
        // Recorded on the run AND kept per board, so the board is marked failed too.
        for (const message of persisted.errors) {
          // Reuses the run-level error list so the run row closes failed.
          noteError(`${board.company_name}: ${message}`, { message });
          // Feeds watchlistPollUpdate, which decides whether the board may read healthy.
          boardErrors.push(message);
        }
        // Aliased to the name the unchanged screening code below already uses.
        const jobIdByFingerprint = persisted.idByFingerprint;

        // Pair each persisted job with the row it came from. Unresolved ids are skipped
        // rather than guessed at.
        const entries = batch
          .filter((row) => jobIdByFingerprint.has(row.fingerprint))
          .map((row) => ({ jobId: jobIdByFingerprint.get(row.fingerprint)!, row }));

        if (entries.length > 0) {
          // THE SEAM. Every posting is screened before its queue row exists, so a job
          // that fails a filter never becomes work for the Matcher — and therefore never
          // for the Tailor or Auditor either, which is where §8's 10x saving comes from.
          const appInserts = screenContext.ok
            ? (() => {
                const plan = planScreenedApplications(
                  entries,
                  screenContext.value.rules,
                  screenContext.value.context,
                  screenContext.value.preferences,
                );
                for (const warning of plan.warnings) screenWarnings.add(warning);
                totalPassed += plan.passedCount;
                totalDropped += plan.droppedCount;
                // Logged with the prose reason: `drop_reason` on the row names the rule so
                // it can be grouped, but only this says why THIS posting matched it.
                for (const drop of plan.dropped) {
                  console.log(`[applyy-scout] ✗ dropped "${drop.title}" — ${drop.ruleType}: ${drop.reason}`);
                }
                return plan.inserts;
              })()
            // The unscreened fallback: 'discovered' is the honest status for a row the
            // screener could not evaluate, and it is what this file wrote before today.
            : entries.map((entry) => ({ job_id: entry.jobId, status: 'discovered' as const, drop_reason: null }));

          const { data: insertedApps, error: appErr } = await client
            .from('applications')
            .upsert(appInserts, {
              onConflict: 'user_id,job_id',
              ignoreDuplicates: true,
            })
            .select('id');

          // Counted: a refused insert means screened jobs never reached the queue,
          // and the old code still reported the run as a success.
          noteError(`${board.company_name}: upsert applications`, appErr);
          if (!appErr && insertedApps) {
            boardNewApps += insertedApps.length;
            totalApplications += insertedApps.length;
          }
        }

        boardNewJobs += entries.length;
        totalDiscovered += entries.length;
      }

      // One decision point: failed job writes yield a failure update, never a healthy one.
      // Checked, because a lost telemetry write would leave the board stuck at the front of the rotation.
      const { error: pollMarkErr } = await client
        .from('company_watchlist')
        // The payload comes from one pure function, so failure and success cannot be mixed up here.
        .update(watchlistPollUpdate(board, boardErrors, parseResult.postings.length, now))
        .eq('id', board.id);
      // Counted with the rest, so the run cannot close `succeeded` over a lost write.
      noteError(`${board.company_name}: record poll result`, pollMarkErr);

      // LIVENESS, ONLY NOW (scout-ats's rule): every job write landed and the success record is
      // written, so this poll is a complete view of the board. `board` still holds the PREVIOUS
      // poll's last_polled_at and count, which the recent basis needs. Never a board failure.
      if (boardErrors.length === 0 && pollMarkErr === null) {
        // An unreadable snapshot skips liveness for this board; the next run asks again.
        if (!livenessSnapshot.ok) {
          // Named, so a persistent read failure is visible in the log.
          console.warn(`[applyy-scout] ⚠️ ${board.company_name}: liveness skipped, snapshot unreadable: ${livenessSnapshot.message}`);
          // Counted with the refusals.
          totalLivenessRefused += 1;
        } else {
          // Every fingerprint this poll produced (deduped), against the snapshot.
          const liveness = await applyBoardLiveness(client, userId, livenessSnapshot, prepared.map((j) => j.row.fingerprint), board, now);
          // Run totals.
          totalMarkedDisappeared += liveness.marked;
          // Same.
          totalReappeared += liveness.reappeared;
          // A refusal is board state, logged with its reason; not a run error.
          if (liveness.refused !== null) {
            // The planner's reason (identity_drift, mass_disappearance, ...) or the failed write.
            console.warn(`[applyy-scout] ⚠️ ${board.company_name}: liveness refused: ${liveness.refused}`);
            // Counted.
            totalLivenessRefused += 1;
          }
          // Only boards where something changed get a line, to keep the log readable.
          if (liveness.marked > 0 || liveness.reappeared > 0) console.log(`[applyy-scout] ✓ ${board.company_name}: ${liveness.marked} marked disappeared, ${liveness.reappeared} reappeared.`);
        }
      }

      console.log(`[applyy-scout] ✓ ${board.company_name}: processed ${boardNewJobs} jobs (${boardNewApps} new applications created).`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[applyy-scout] error polling ${board.company_name}: ${msg}`);
      // Checked like the other failure marks, for the same reason; same shared update.
      const { error: crashMarkErr } = await client.from('company_watchlist').update(failureMark(board, now)).eq('id', board.id);
      noteError(`${board.company_name}: record poll failure`, crashMarkErr);
    }
  }

  console.log('====================================================');
  console.log(`[applyy-scout] scan completed.`);
  console.log(`[applyy-scout] total jobs processed: ${totalDiscovered}`);
  console.log(`[applyy-scout] total new application rows created: ${totalApplications}`);
  // Always printed, zero included: "0 mismatches" and "guard never ran" must not look alike.
  console.log(`[applyy-scout] boards skipped for identity mismatch: ${totalIdentityMismatch}`);
  // Same always-print rule: "0 emptied" must not look like "gate never ran".
  console.log(`[applyy-scout] boards failed for going empty: ${totalEmptiedBoards}`);
  // Always printed, zero included: "0 marked" and "liveness never ran" must not look alike.
  console.log(`[applyy-scout] liveness: ${totalMarkedDisappeared} marked disappeared, ${totalReappeared} reappeared, ${totalLivenessRefused} board(s) refused or skipped.`);
  // THE SCREENER'S OWN COUNTERS, reported separately from the discovery counters because
  // they answer a different question. The discovery numbers say the poll worked; these
  // say the CASCADE worked. (Corrected 2026-10-23: this said "filter_rules currently
  // unseeded" — all nine rules ARE seeded per user since 20260909235100, most with {}
  // config, so `dropped: 0` usually means unconfigured thresholds, not missing rows.)
  if (screenContext.ok) {
    console.log(`[applyy-scout] screener: ${totalPassed} passed, ${totalDropped} dropped.`);
    // An unconfigured rule announces itself here. Silence means the rules are configured
    // and nothing matched; a list means the filters are not actually protecting anything.
    for (const warning of screenWarnings) console.log(`[applyy-scout] ⚠️ screener warning: ${warning}`);
    // Always printed when the run existed, so "0 fetched" reads as "no new Workday rows", not "never ran".
    // `skipped` > 0 means the cap or the deadline left title-passing postings blank (missing_description).
    if (workdayRun !== undefined) console.log(`[applyy-scout] workday detail: ${workdayRun.fetched} fetched, ${workdayRun.filled} filled, ${workdayRun.skipped} skipped.`);
  } else {
    // console.error, not log: since W12 this run closes `failed` and exits 1 for it.
    console.error('[applyy-scout] screener: NOT RUN — rows were created unscreened at status discovered; the run is closed failed (screener_not_run).');
  }
  // Read once: how far the board loop got before the budget.
  const budgetOutcome = budget.outcome();
  // A budget stop is said in the log as well as on the run row, with the counts.
  if (budgetOutcome.stoppedEarly) {
    console.log(`[applyy-scout] ⏱️ run budget (${SCOUT_BUDGET_MS / 60_000} min) reached after ${budgetOutcome.processed} of ${boards.length} boards; the other ${budgetOutcome.skippedForDeadline} go first next run.`);
  }
  console.log('====================================================');

  // Printed beside the counters, so the log and the run row tell one story.
  if (dbErrors.length > 0) console.error(`[applyy-scout] ${dbErrors.length} database write(s) failed this run.`);

  // HONEST CLOSE, mirroring worker/src/claim-loop.ts: any error makes the run
  // `failed` (agent_run_status has no `partial`), with the count and the list.
  // Board HTTP/parse failures are NOT counted here — a 404 board token is the
  // board's state, already tracked in `consecutive_failures`, and counting it
  // would mark nearly every run failed and teach everyone to ignore the colour.
  // The decision itself lives in scoutRunClose (pure, tested): db errors and, since W12,
  // the screener fallback make it `failed`; a budget stop alone stays `succeeded` with a
  // `deadline:` note. Capped and labelled as before: the db list keeps its 20-line cap
  // and the rule warnings ride along (B1, 2026-10-08); a warning is not an error.
  const close = scoutRunClose({
    // Every failed write, counted above.
    dbErrors,
    // The fallback's reason, so it reaches the row as `screener_not_run: <reason>`.
    screenerNotRun: screenContext.ok ? null : screenContext.reason,
    // The W40 tally, for the `deadline:` note.
    budget: budgetOutcome,
    // Rule warnings, de-duplicated across boards.
    screenWarnings,
    // Same counters as before.
    rowsIn: totalDiscovered,
    rowsOut: totalApplications,
    // The close's own clock, not the run's `now`, so duration_ms is real.
    finishedAt: new Date(),
  });
  // Checked close, as every other close in this file.
  await closeRun(close.update);

  // Non-zero exit too, so the Actions tick is red — the run row alone is only
  // seen by someone who already suspects a problem.
  process.exitCode = close.exitCode;
}

// Deliberately NOT async. An earlier edit marked this handler `async` without adding
// anything awaited inside it — the fingerprint of an abandoned attempt to write a
// 'failed' row here. Restored to sync because the async keyword advertised a
// guarantee the body never delivered, and a handler that LOOKS like it records the
// failure is worse than one that plainly does not: the next reader stops looking.
// Leaving the row 'running' on a crash is the documented design, not an oversight —
// 20260909234800_supporting_tables.sql opens the row before the work precisely so an
// uncatchable death leaves a visible stuck run. `runId` and `client` are scoped
// inside main(), so writing 'failed' here needs a hoist; flagged rather than taken.
main().catch((err) => {
  console.error('[applyy-scout] fatal error:', err);
  process.exit(1);
});
