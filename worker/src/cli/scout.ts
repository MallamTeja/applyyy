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

async function main(): Promise<void> {
  console.log('[applyy-scout] starting ATS job board discovery scan...');

  const supabaseUrl = required('SUPABASE_URL');
  const anonKey = required('SUPABASE_ANON_KEY');
  const email = required('APPLYY_APP_USER_EMAIL');
  const password = required('APPLYY_APP_USER_PASSWORD');

  const client = createClient(supabaseUrl, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const authResult = await client.auth.signInWithPassword({ email, password });
  if (authResult.error || !authResult.data.user) {
    throw new Error(`[applyy-scout] sign-in failed: ${authResult.error?.message ?? 'no user'}`);
  }

  const userId = authResult.data.user.id;
  console.log(`[applyy-scout] authenticated as operator ${email} (${userId})`);

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

      let boardNewJobs = 0;

      for (const posting of parseResult.postings) {
        const jobRow: JobInsert = await toJobInsert(posting, adapter, context);

        // Upsert job by user_id and fingerprint
        const { data: jobData, error: jobErr } = await client
          .from('jobs')
          .upsert(jobRow, {
            onConflict: 'user_id,fingerprint',
            ignoreDuplicates: false,
          })
          .select('id')
          .single();

        let jobId: string | null = jobData?.id ?? null;

        if (jobErr) {
          // If conflict or constraint, fetch existing job id
          const { data: existing } = await client
            .from('jobs')
            .select('id')
            .eq('fingerprint', jobRow.fingerprint)
            .single();
          jobId = existing?.id ?? null;
        } else {
          boardNewJobs++;
          totalDiscovered++;
        }

        if (jobId) {
          // Seed applications row if none exists
          const { error: appErr } = await client
            .from('applications')
            .upsert(
              {
                job_id: jobId,
                status: 'discovered',
              },
              {
                onConflict: 'user_id,job_id',
                ignoreDuplicates: true,
              },
            );

          if (!appErr) {
            totalApplications++;
          }
        }
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

      console.log(`[applyy-scout] ✓ ${board.company_name}: saved ${boardNewJobs} new unique jobs to database.`);
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
  console.log(`[applyy-scout] total new jobs discovered: ${totalDiscovered}`);
  console.log(`[applyy-scout] total application rows created: ${totalApplications}`);
  console.log('====================================================');
}

main().catch((err) => {
  console.error('[applyy-scout] fatal error:', err);
  process.exit(1);
});
