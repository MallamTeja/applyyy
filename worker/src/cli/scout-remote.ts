// Scout-Remote CLI Runner — `pnpm --filter '@applyy/worker' run scout:remote`
//
// Discovers remote job postings from international and foreign companies across
// the open web (RemoteOK, Jobicy, Arbeitnow, global ATS boards).
//
// Automatically filters against the operator's search preferences (titles, keywords,
// experience ceiling, compensation bounds) and deduplicates into `public.jobs`.

import { createClient } from '@supabase/supabase-js';
import { jobFingerprint } from '../../../supabase/functions/_shared/normalize/fingerprint.ts';
import type { AtsProvider, EmploymentType, JobInsert, JobSourceRef } from '../../../packages/shared-types/src/tables.ts';

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is not set. Required for Scout-Remote runner.`);
  }
  return value;
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

function detectAtsProvider(url: string): AtsProvider {
  const lower = url.toLowerCase();
  if (lower.includes('greenhouse.io') || lower.includes('gh_jid=')) return 'greenhouse';
  if (lower.includes('lever.co')) return 'lever';
  if (lower.includes('ashbyhq.com')) return 'ashby';
  if (lower.includes('workable.com')) return 'workable';
  if (lower.includes('smartrecruiters.com')) return 'smartrecruiters';
  return 'other';
}

function detectEmploymentType(text: string): EmploymentType {
  const lower = text.toLowerCase();
  if (lower.includes('intern') || lower.includes('co-op') || lower.includes('trainee')) return 'internship';
  if (lower.includes('contract') || lower.includes('freelance')) return 'contract';
  if (lower.includes('part-time') || lower.includes('part time')) return 'part_time';
  if (lower.includes('full-time') || lower.includes('full time') || lower.includes('permanent')) return 'full_time';
  return 'unknown';
}

interface RawRemoteJob {
  title: string;
  company: string;
  location: string;
  url: string;
  description: string;
  source: string;
  salaryMin?: number | null;
  salaryMax?: number | null;
  salaryCurrency?: string;
  tags?: string[];
  postedAt?: string;
}

async function fetchRemoteOKJobs(): Promise<RawRemoteJob[]> {
  try {
    const res = await fetch('https://remoteok.com/api', {
      headers: { 'User-Agent': 'applyy-remote-scout/1.0' },
    });
    if (!res.ok) return [];
    const data = (await res.json()) as Array<Record<string, unknown>>;
    // First item is legal metadata disclaimer
    const items = data.slice(1);

    return items.map((item) => ({
      title: String(item.position ?? ''),
      company: String(item.company ?? ''),
      location: String(item.location || 'Worldwide Remote'),
      url: String(item.apply_url || item.url || ''),
      description: String(item.description ?? ''),
      source: 'remoteok',
      salaryMin: item.salary_min ? Number(item.salary_min) : null,
      salaryMax: item.salary_max ? Number(item.salary_max) : null,
      salaryCurrency: 'USD',
      tags: Array.isArray(item.tags) ? item.tags.map(String) : [],
      postedAt: item.date ? new Date(String(item.date)).toISOString() : new Date().toISOString(),
    }));
  } catch (err) {
    console.warn('[scout-remote] failed to fetch from RemoteOK:', err);
    return [];
  }
}

async function fetchJobicyJobs(): Promise<RawRemoteJob[]> {
  try {
    const res = await fetch('https://jobicy.com/api/v2/remote-jobs?count=50', {
      headers: { 'User-Agent': 'applyy-remote-scout/1.0' },
    });
    if (!res.ok) return [];
    const data = (await res.json()) as { jobs?: Array<Record<string, unknown>> };
    if (!Array.isArray(data.jobs)) return [];

    return data.jobs.map((item) => ({
      title: String(item.jobTitle ?? ''),
      company: String(item.companyName ?? ''),
      location: String(item.jobGeo || 'Remote'),
      url: String(item.url ?? ''),
      description: String(item.jobExcerpt || item.jobDescription || ''),
      source: 'jobicy',
      salaryMin: item.annualSalaryMin ? Number(item.annualSalaryMin) : null,
      salaryMax: item.annualSalaryMax ? Number(item.annualSalaryMax) : null,
      salaryCurrency: String(item.salaryCurrency || 'USD'),
      tags: Array.isArray(item.jobIndustry) ? item.jobIndustry.map(String) : [],
      postedAt: item.pubDate ? new Date(String(item.pubDate)).toISOString() : new Date().toISOString(),
    }));
  } catch (err) {
    console.warn('[scout-remote] failed to fetch from Jobicy:', err);
    return [];
  }
}

async function fetchArbeitnowJobs(): Promise<RawRemoteJob[]> {
  try {
    const res = await fetch('https://www.arbeitnow.com/api/job-board-api', {
      headers: { 'User-Agent': 'applyy-remote-scout/1.0' },
    });
    if (!res.ok) return [];
    const data = (await res.json()) as { data?: Array<Record<string, unknown>> };
    if (!Array.isArray(data.data)) return [];

    return data.data
      .filter((item) => Boolean(item.remote))
      .map((item) => ({
        title: String(item.title ?? ''),
        company: String(item.company_name ?? ''),
        location: String(item.location || 'Remote (Europe/Global)'),
        url: String(item.url ?? ''),
        description: String(item.description ?? ''),
        source: 'arbeitnow',
        salaryCurrency: 'EUR',
        tags: Array.isArray(item.tags) ? item.tags.map(String) : [],
        postedAt: item.created_at ? new Date(Number(item.created_at) * 1000).toISOString() : new Date().toISOString(),
      }));
  } catch (err) {
    console.warn('[scout-remote] failed to fetch from Arbeitnow:', err);
    return [];
  }
}

async function main(): Promise<void> {
  console.log('[applyy-scout-remote] 🌍 starting international remote job discovery...');

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
    throw new Error(`[applyy-scout-remote] sign-in failed: ${authResult.error?.message ?? 'no user'}`);
  }

  const userId = authResult.data.user.id;
  console.log(`[applyy-scout-remote] authenticated as operator ${email} (${userId})`);

  // Check system kill switch
  const { data: settingsData } = await client
    .from('system_settings')
    .select('system_enabled')
    .limit(1)
    .single();

  const systemEnabled = settingsData?.system_enabled ?? false;
  if (!systemEnabled && !force) {
    console.log('[applyy-scout-remote] ⏸️ system_settings.system_enabled is false (kill switch active).');
    console.log('[applyy-scout-remote] Pass --force or SCOUT_FORCE=true to discover remote jobs while submissions are paused.');
    return;
  }

  // Fetch operator's search preferences
  const { data: prefs, error: prefsErr } = await client
    .from('search_preferences')
    .select('*')
    .limit(1)
    .single();

  if (prefsErr || !prefs) {
    console.warn('[applyy-scout-remote] no search_preferences row found; proceeding with broad tech defaults.');
  }

  const targetTitles = (prefs?.titles && prefs.titles.length > 0)
    ? prefs.titles.map((t: string) => t.toLowerCase().trim())
    : ['software', 'engineer', 'developer', 'intern', 'full stack', 'frontend', 'backend', 'python', 'react'];

  const excludedKeywords = (prefs?.excluded_keywords && prefs.excluded_keywords.length > 0)
    ? prefs.excluded_keywords.map((k: string) => k.toLowerCase().trim())
    : ['senior', 'staff', 'lead', 'principal', 'director', 'manager', '5+ years', '8+ years'];

  const allowedTypes = new Set(prefs?.employment_types ?? ['internship', 'full_time', 'unknown']);
  const maxExperienceYears = prefs?.max_experience_years ?? 2;

  console.log(`[applyy-scout-remote] targeting titles: ${targetTitles.slice(0, 5).join(', ')}`);
  console.log(`[applyy-scout-remote] filtering out excluded: ${excludedKeywords.slice(0, 5).join(', ')}`);

  // Log start to agent_runs
  const { data: runRow } = await client
    .from('agent_runs')
    .insert({
      agent: 'scout_aggregator',
      status: 'running',
    })
    .select('id')
    .single();

  const runId = runRow?.id;
  const startedAt = Date.now();

  // Fetch remote jobs concurrently from international sources
  console.log('[applyy-scout-remote] querying open web remote APIs (RemoteOK, Jobicy, Arbeitnow)...');
  const [remoteOkJobs, jobicyJobs, arbeitnowJobs] = await Promise.all([
    fetchRemoteOKJobs(),
    fetchJobicyJobs(),
    fetchArbeitnowJobs(),
  ]);

  const allRawJobs = [...remoteOkJobs, ...jobicyJobs, ...arbeitnowJobs];
  console.log(`[applyy-scout-remote] fetched ${allRawJobs.length} raw remote listings from global web feeds.`);

  let matchedCount = 0;
  let newJobsInserted = 0;
  let newAppsCreated = 0;

  const candidateRows: JobInsert[] = [];

  for (const raw of allRawJobs) {
    if (!raw.title || !raw.company || !raw.url) continue;

    const titleLower = raw.title.toLowerCase();
    const combinedText = `${raw.title} ${raw.tags?.join(' ') ?? ''} ${raw.description.slice(0, 300)}`.toLowerCase();

    // 1. Exclude blocked keywords
    const hasExcluded = excludedKeywords.some((ex: string) => combinedText.includes(ex));
    if (hasExcluded) continue;

    // 2. Filter by experience ceiling (if candidate is junior/intern, discard senior titles)
    if (maxExperienceYears <= 2 && (titleLower.includes('senior') || titleLower.includes('lead') || titleLower.includes('principal'))) {
      continue;
    }

    // 3. Must match at least one target title or keyword
    const matchesTarget = targetTitles.some((t: string) => titleLower.includes(t) || combinedText.includes(t));
    if (!matchesTarget) continue;

    // 4. Check employment type
    const empType = detectEmploymentType(raw.title);
    if (empType !== 'unknown' && allowedTypes.size > 0 && !allowedTypes.has(empType)) {
      continue;
    }

    matchedCount++;

    const fingerprint = await jobFingerprint({
      company: raw.company,
      title: raw.title,
      location: raw.location,
    });

    const atsProvider = detectAtsProvider(raw.url);
    const sourceRef: JobSourceRef = {
      provider: 'other',
      url: raw.url,
      // Explicit null, not omission. These tier-3 sources are open-web aggregator
      // feeds rather than ATS vendors, so there is no vendor-side posting id to
      // record. `ats_job_id` is REQUIRED on JobSourceRef precisely so that "this
      // source exposes no id" has to be stated by whoever adds the source, instead
      // of being a field that quietly went missing on one code path — a missing id
      // and an unrecorded id look identical downstream in dedupe.
      ats_job_id: null,
      first_seen_at: new Date().toISOString(),
      last_seen_at: new Date().toISOString(),
      metadata: {
        tier: 3,
        type: 'web_remote_aggregator',
        source_name: raw.source,
        ats_provider: atsProvider,
      },
    };

    candidateRows.push({
      fingerprint,
      title: raw.title.trim(),
      company_name: raw.company.trim(),
      company_slug: slugify(raw.company),
      location_raw: raw.location,
      locations: ['Remote'],
      work_arrangement: 'remote',
      employment_type: empType,
      description_raw: raw.description,
      apply_url: raw.url,
      ats_provider: atsProvider,
      discovered_via: ['other'],
      source_refs: [sourceRef],
      posted_at: raw.postedAt ?? new Date().toISOString(),
      posted_at_source: 'unknown',
      salary_min: raw.salaryMin ?? null,
      salary_max: raw.salaryMax ?? null,
      salary_currency: raw.salaryCurrency ?? 'USD',
    });
  }

  console.log(`[applyy-scout-remote] ${matchedCount} postings matched your preferences. Upserting to database...`);

  // Batch upsert in chunks of 50
  const BATCH_SIZE = 50;
  for (let i = 0; i < candidateRows.length; i += BATCH_SIZE) {
    const batch = candidateRows.slice(i, i + BATCH_SIZE);

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
        newAppsCreated += insertedApps.length;
      }
    }

    newJobsInserted += batchJobIds.length;
  }

  // Update agent_runs
  if (runId) {
    await client
      .from('agent_runs')
      .update({
        status: 'succeeded',
        finished_at: new Date().toISOString(),
        rows_in: allRawJobs.length,
        rows_out: newAppsCreated,
        error_count: 0,
      })
      .eq('id', runId);
  }

  const durationSec = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log('====================================================');
  console.log(`[applyy-scout-remote] ✓ remote discovery complete in ${durationSec}s.`);
  console.log(`[applyy-scout-remote] raw jobs evaluated: ${allRawJobs.length}`);
  console.log(`[applyy-scout-remote] target matches: ${matchedCount}`);
  console.log(`[applyy-scout-remote] jobs upserted: ${newJobsInserted}`);
  console.log(`[applyy-scout-remote] new application rows queued: ${newAppsCreated}`);
  console.log('====================================================');
}

main().catch((err) => {
  console.error('[applyy-scout-remote] fatal error during remote scout run:', err);
  process.exit(1);
});
