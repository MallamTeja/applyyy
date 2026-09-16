// Scout-ATS CLI Runner — `pnpm --filter '@applyy/worker' run scout`
//
// Polls registered company boards in `public.company_watchlist` using native ATS
// adapters (Greenhouse, Lever, Ashby).
// Deduplicates postings into `public.jobs` and seeds initial `public.applications`
// rows in status 'discovered'.

import { createClient } from '@supabase/supabase-js';
import { getAdapter, supportedProviders, toJobInsert, type JobInsertContext } from '../../../supabase/functions/_shared/ats/registry.ts';
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
  const { data: runRow } = await client
    .from('agent_runs')
    .insert({
      agent: 'scout_ats',
      status: 'running',
      started_at: new Date().toISOString(),
    })
    .select('id')
    .single();

  const runId = runRow?.id;

  // Check system kill switch
  const { data: settingsData } = await client
    .from('system_settings')
    .select('system_enabled')
    .limit(1)
    .single();

  const systemEnabled = settingsData?.system_enabled ?? false;
  if (!systemEnabled && !force) {
    console.log('[applyy-scout] ⏸️ system_settings.system_enabled is false (kill switch active).');
    console.log('[applyy-scout] Pass --force or SCOUT_FORCE=true to discover jobs while submissions are paused.');
    if (runId) {
      await client
        .from('agent_runs')
        .update({
          status: 'skipped_disabled',
          finished_at: new Date().toISOString(),
          error_detail: 'system_settings.system_enabled is false',
        })
        .eq('id', runId);
    }
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
    if (runId) {
      await client
        .from('agent_runs')
        .update({
          status: 'succeeded',
          finished_at: new Date().toISOString(),
          // Explicit zeros rather than leaving the defaults implicit: "polled nothing
          // because nothing was configured" and "polled boards and found nothing" are
          // different operational stories, and only the row's counters distinguish them.
          rows_in: 0,
          rows_out: 0,
        })
        .eq('id', runId);
    }
    return;
  }

  console.log(`[applyy-scout] found ${boards.length} enabled watchlist board(s) to poll.`);

  let totalDiscovered = 0;
  let totalApplications = 0;
  const now = new Date();

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
        await client
          .from('company_watchlist')
          .update({
            consecutive_failures: (board.consecutive_failures || 0) + 1,
            last_polled_at: now.toISOString(),
          })
          .eq('id', board.id);
        continue;
      }

      const payload = await res.json();
      const parseResult = adapter.parse(payload);

      if (!parseResult.ok) {
        console.warn(`[applyy-scout] ⚠️ ${board.company_name} parse failed: ${parseResult.reason}`);
        await client
          .from('company_watchlist')
          .update({
            consecutive_failures: (board.consecutive_failures || 0) + 1,
            last_polled_at: now.toISOString(),
          })
          .eq('id', board.id);
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

      // Convert postings into JobInsert rows with canonical fingerprint & freshness
      const jobRows: JobInsert[] = await Promise.all(
        parseResult.postings.map((p) => toJobInsert(p, adapter, context))
      );

      let boardNewJobs = 0;
      let boardNewApps = 0;

      // Upsert in batches of BATCH_SIZE for high throughput
      for (let i = 0; i < jobRows.length; i += BATCH_SIZE) {
        const batch = jobRows.slice(i, i + BATCH_SIZE);

        const { data: upsertedJobs, error: jobErr } = await client
          .from('jobs')
          .upsert(batch, {
            onConflict: 'user_id,fingerprint',
            ignoreDuplicates: false,
          })
          .select('id, fingerprint');

        let batchJobIds: string[] = [];

        if (!jobErr && upsertedJobs && upsertedJobs.length > 0) {
          batchJobIds = upsertedJobs.map((j) => j.id);
        } else {
          // Fallback: fetch existing job IDs by fingerprints
          const fps = batch.map((b) => b.fingerprint);
          const { data: existing } = await client
            .from('jobs')
            .select('id')
            .in('fingerprint', fps);
          if (existing) {
            batchJobIds = existing.map((j) => j.id);
          }
        }

        if (batchJobIds.length > 0) {
          const appInserts = batchJobIds.map((job_id) => ({
            job_id,
            status: 'discovered' as const,
          }));

          const { data: insertedApps, error: appErr } = await client
            .from('applications')
            .upsert(appInserts, {
              onConflict: 'user_id,job_id',
              ignoreDuplicates: true,
            })
            .select('id');

          if (!appErr && insertedApps) {
            boardNewApps += insertedApps.length;
            totalApplications += insertedApps.length;
          }
        }

        boardNewJobs += batchJobIds.length;
        totalDiscovered += batchJobIds.length;
      }

      // Update watchlist success telemetry
      await client
        .from('company_watchlist')
        .update({
          poll_count: (board.poll_count || 0) + 1,
          first_polled_at: board.first_polled_at || now.toISOString(),
          last_polled_at: now.toISOString(),
          last_poll_job_count: parseResult.postings.length,
          consecutive_failures: 0,
        })
        .eq('id', board.id);

      console.log(`[applyy-scout] ✓ ${board.company_name}: processed ${boardNewJobs} jobs (${boardNewApps} new applications created).`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[applyy-scout] error polling ${board.company_name}: ${msg}`);
      await client
        .from('company_watchlist')
        .update({
          consecutive_failures: (board.consecutive_failures || 0) + 1,
          last_polled_at: now.toISOString(),
        })
        .eq('id', board.id);
    }
  }

  console.log('====================================================');
  console.log(`[applyy-scout] scan completed.`);
  console.log(`[applyy-scout] total jobs processed: ${totalDiscovered}`);
  console.log(`[applyy-scout] total new application rows created: ${totalApplications}`);
  console.log('====================================================');

  if (runId) {
    await client
      .from('agent_runs')
      .update({
        status: 'succeeded',
        finished_at: new Date().toISOString(),
        rows_in: totalDiscovered,
        rows_out: totalApplications,
      })
      .eq('id', runId);
  }
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
