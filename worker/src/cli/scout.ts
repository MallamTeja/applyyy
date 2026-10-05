// Scout-ATS CLI Runner — `pnpm --filter '@applyy/worker' run scout`
//
// Polls registered company boards in `public.company_watchlist` using native ATS
// adapters (Greenhouse, Lever, Ashby).
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
}

const BATCH_SIZE = 50;

async function main(): Promise<void> {
  console.log('[applyy-scout] starting ATS job board discovery scan...');

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
    .select('id, ats_provider, board_token, company_name, company_slug, poll_count, first_polled_at, last_polled_at, consecutive_failures')
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
    console.log('[applyy-scout] no enabled company boards found for supported providers (greenhouse, lever, ashby).');
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
  if (!screenContext.ok) {
    console.warn(`[applyy-scout] ⚠️ screener context unavailable, inserting unscreened: ${screenContext.reason}`);
  } else {
    console.log('[applyy-scout] screener active: deterministic cascade will run before any job is queued.');
  }

  // Warnings across the whole run, de-duplicated. An unconfigured rule is otherwise
  // invisible: it passes jobs and says nothing, which reads exactly like a working rule.
  const screenWarnings = new Set<string>();
  // Counters. A screener that drops nothing and one that was never called leave identical
  // databases behind, so these are the only thing that distinguishes them.
  let totalPassed = 0;
  let totalDropped = 0;

  for (const board of boards as WatchlistRow[]) {
    const adapter = getAdapter(board.ats_provider);
    if (!adapter) {
      console.log(`[applyy-scout] skipping ${board.company_name} (${board.board_token}): no adapter for ${board.ats_provider}`);
      continue;
    }

    const requestUrl = adapter.buildRequestUrl(board.board_token);
    console.log(`[applyy-scout] polling ${board.company_name} on ${board.ats_provider} (${board.board_token})...`);

    try {
      const res = await fetch(requestUrl, {
        headers: {
          'Accept': 'application/json',
          'User-Agent': 'applyy-scout/1.0 (+https://github.com/MallamTeja/applyyy)',
        },
      });

      if (!res.ok) {
        console.warn(`[applyy-scout] ⚠️ ${board.company_name} returned HTTP ${res.status}: ${res.statusText}`);
        // Checked: an unrecorded failure leaves `consecutive_failures` low, so a
        // dead board never looks dead enough to disable.
        const { error: failMarkErr } = await client
          .from('company_watchlist')
          .update({
            consecutive_failures: (board.consecutive_failures || 0) + 1,
            last_polled_at: now.toISOString(),
          })
          .eq('id', board.id);
        noteError(`${board.company_name}: record poll failure`, failMarkErr);
        continue;
      }

      const payload = await res.json();
      const parseResult = adapter.parse(payload);

      if (!parseResult.ok) {
        console.warn(`[applyy-scout] ⚠️ ${board.company_name} parse failed: ${parseResult.reason}`);
        // Checked: an unrecorded failure leaves `consecutive_failures` low, so a
        // dead board never looks dead enough to disable.
        const { error: failMarkErr } = await client
          .from('company_watchlist')
          .update({
            consecutive_failures: (board.consecutive_failures || 0) + 1,
            last_polled_at: now.toISOString(),
          })
          .eq('id', board.id);
        noteError(`${board.company_name}: record poll failure`, failMarkErr);
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
        const persisted = await persistJobBatch(client, slice, now);
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

      console.log(`[applyy-scout] ✓ ${board.company_name}: processed ${boardNewJobs} jobs (${boardNewApps} new applications created).`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[applyy-scout] error polling ${board.company_name}: ${msg}`);
      // Checked like the other two failure marks, for the same reason.
      const { error: crashMarkErr } = await client
        .from('company_watchlist')
        .update({
          consecutive_failures: (board.consecutive_failures || 0) + 1,
          last_polled_at: now.toISOString(),
        })
        .eq('id', board.id);
      noteError(`${board.company_name}: record poll failure`, crashMarkErr);
    }
  }

  console.log('====================================================');
  console.log(`[applyy-scout] scan completed.`);
  console.log(`[applyy-scout] total jobs processed: ${totalDiscovered}`);
  console.log(`[applyy-scout] total new application rows created: ${totalApplications}`);
  // THE SCREENER'S OWN COUNTERS, reported separately from the discovery counters because
  // they answer a different question. The discovery numbers say the poll worked; these
  // say the CASCADE worked. With filter_rules currently unseeded, `dropped: 0` is the
  // expected reading — and printing it is what makes that visible rather than assumed.
  if (screenContext.ok) {
    console.log(`[applyy-scout] screener: ${totalPassed} passed, ${totalDropped} dropped.`);
    // An unconfigured rule announces itself here. Silence means the rules are configured
    // and nothing matched; a list means the filters are not actually protecting anything.
    for (const warning of screenWarnings) console.log(`[applyy-scout] ⚠️ screener warning: ${warning}`);
  } else {
    console.log('[applyy-scout] screener: NOT RUN — rows were created unscreened at status discovered.');
  }
  console.log('====================================================');

  // Printed beside the counters, so the log and the run row tell one story.
  if (dbErrors.length > 0) console.error(`[applyy-scout] ${dbErrors.length} database write(s) failed this run.`);

  // HONEST CLOSE, mirroring worker/src/claim-loop.ts: any error makes the run
  // `failed` (agent_run_status has no `partial`), with the count and the list.
  // Board HTTP/parse failures are NOT counted here — a 404 board token is the
  // board's state, already tracked in `consecutive_failures`, and counting it
  // would mark nearly every run failed and teach everyone to ignore the colour.
  await closeRun({
    status: dbErrors.length > 0 ? 'failed' : 'succeeded',
    finished_at: new Date().toISOString(),
    rows_in: totalDiscovered,
    rows_out: totalApplications,
    error_count: dbErrors.length,
    // Capped so one bad night cannot write an unbounded text blob into the row.
    error_detail: dbErrors.length > 0 ? dbErrors.slice(0, 20).join('\n') : null,
  });

  // Non-zero exit too, so the Actions tick is red — the run row alone is only
  // seen by someone who already suspects a problem.
  if (dbErrors.length > 0) process.exitCode = 1;
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
