/* Browser Discovery Service — trigger job hunting directly from the Application UI.
 *
 * Runs international remote job discovery (RemoteOK, Jobicy, Arbeitnow, Ashby)
 * and Watchlist ATS board scans directly against Supabase.
 *
 * Automatically checks search_preferences, deduplicates by SHA-256 fingerprint,
 * inserts rows into `jobs`, and queues applications into `status = 'discovered'`.
 */

import { supabase } from './supabase';
import type { AtsProvider, EmploymentType } from './contract';

export interface DiscoveryResult {
  readonly ok: boolean;
  readonly message: string;
  readonly totalFetched: number;
  readonly matchedCount: number;
  readonly jobsInserted: number;
  readonly appsCreated: number;
  readonly error?: string;
}

export interface WatchlistScanResult {
  readonly ok: boolean;
  readonly message: string;
  readonly boardsScanned: number;
  readonly jobsInserted: number;
  readonly appsCreated: number;
  readonly error?: string;
}

const COMPANY_LEGAL_SUFFIXES: ReadonlySet<string> = new Set([
  'pvt', 'private', 'ltd', 'limited', 'llp',
  'inc', 'incorporated', 'corp', 'corporation', 'co', 'llc', 'plc', 'gmbh', 'bv', 'ag',
]);

const CITY_ALIASES: ReadonlyMap<string, string> = new Map([
  ['bengaluru', 'bangalore'],
  ['gurugram', 'gurgaon'],
  ['bombay', 'mumbai'],
  ['calcutta', 'kolkata'],
  ['madras', 'chennai'],
]);

const TRAILING_COUNTRY_TOKENS: ReadonlySet<string> = new Set(['india', 'bharat']);

function foldText(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeCompany(company: string): string {
  const tokens = foldText(company).split(' ');
  while (tokens.length > 1 && COMPANY_LEGAL_SUFFIXES.has(tokens[tokens.length - 1] as string)) {
    tokens.pop();
  }
  return tokens.join(' ');
}

function normalizeTitle(title: string): string {
  const withoutBrackets = title.replace(/[([{][^)\]}]*[)\]}]/g, ' ');
  return foldText(withoutBrackets);
}

function normalizeLocation(location: string | undefined): string {
  if (location === undefined) return '';
  const tokens = foldText(location).split(' ').filter((token) => token.length > 0);
  const aliased = tokens.map((token) => CITY_ALIASES.get(token) ?? token);
  while (aliased.length > 1 && TRAILING_COUNTRY_TOKENS.has(aliased[aliased.length - 1] as string)) {
    aliased.pop();
  }
  return aliased.join(' ');
}

function canonicalJobKey(company: string, title: string, location?: string): string {
  return [
    normalizeCompany(company),
    normalizeTitle(title),
    normalizeLocation(location),
  ].join('|');
}

async function computeJobFingerprint(company: string, title: string, location?: string): Promise<string> {
  const key = canonicalJobKey(company, title, location);
  const bytes = new TextEncoder().encode(key);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
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

/**
 * Executes International Remote & Web Job Discovery directly from the browser.
 */
export async function runRemoteDiscovery(
  onProgress?: (status: string) => void,
): Promise<DiscoveryResult> {
  if (supabase === null) {
    return {
      ok: false,
      message: 'Supabase client is not configured.',
      totalFetched: 0,
      matchedCount: 0,
      jobsInserted: 0,
      appsCreated: 0,
      error: 'unconfigured_client',
    };
  }

  onProgress?.('Fetching your search preferences...');

  // 1. Fetch user search preferences
  const { data: prefs } = await supabase
    .from('search_preferences')
    .select('*')
    .maybeSingle();

  const targetTitles: string[] = (prefs?.titles && prefs.titles.length > 0)
    ? prefs.titles.map((t: string) => t.toLowerCase().trim())
    : ['software', 'engineer', 'developer', 'intern', 'full stack', 'frontend', 'backend', 'python', 'react'];

  const excludedKeywords: string[] = (prefs?.excluded_keywords && prefs.excluded_keywords.length > 0)
    ? prefs.excluded_keywords.map((k: string) => k.toLowerCase().trim())
    : ['senior', 'staff', 'lead', 'principal', 'director', 'manager', '5+ years', '8+ years'];

  const allowedTypes = new Set(prefs?.employment_types ?? ['internship', 'full_time', 'unknown']);
  const maxExperienceYears = prefs?.max_experience_years ?? 2;

  onProgress?.('Connecting to global remote feeds (RemoteOK, Jobicy, Arbeitnow)...');

  // 2. Fetch raw feeds concurrently
  const rawJobs: RawRemoteJob[] = [];

  try {
    const [rokRes, jobicyRes, arbeitRes] = await Promise.allSettled([
      fetch('https://remoteok.com/api', { headers: { 'User-Agent': 'applyy-browser/1.0' } }),
      fetch('https://jobicy.com/api/v2/remote-jobs?count=50', { headers: { 'User-Agent': 'applyy-browser/1.0' } }),
      fetch('https://www.arbeitnow.com/api/job-board-api', { headers: { 'User-Agent': 'applyy-browser/1.0' } }),
    ]);

    if (rokRes.status === 'fulfilled' && rokRes.value.ok) {
      try {
        const data = (await rokRes.value.json()) as Array<Record<string, unknown>>;
        for (const item of data.slice(1)) {
          rawJobs.push({
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
          });
        }
      } catch {
        // ignore parse error
      }
    }

    if (jobicyRes.status === 'fulfilled' && jobicyRes.value.ok) {
      try {
        const data = (await jobicyRes.value.json()) as { jobs?: Array<Record<string, unknown>> };
        if (Array.isArray(data.jobs)) {
          for (const item of data.jobs) {
            rawJobs.push({
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
            });
          }
        }
      } catch {
        // ignore parse error
      }
    }

    if (arbeitRes.status === 'fulfilled' && arbeitRes.value.ok) {
      try {
        const data = (await arbeitRes.value.json()) as { data?: Array<Record<string, unknown>> };
        if (Array.isArray(data.data)) {
          for (const item of data.data.filter((d) => Boolean(d.remote))) {
            rawJobs.push({
              title: String(item.title ?? ''),
              company: String(item.company_name ?? ''),
              location: String(item.location || 'Remote (Europe/Global)'),
              url: String(item.url ?? ''),
              description: String(item.description ?? ''),
              source: 'arbeitnow',
              salaryCurrency: 'EUR',
              tags: Array.isArray(item.tags) ? item.tags.map(String) : [],
              postedAt: item.created_at ? new Date(Number(item.created_at) * 1000).toISOString() : new Date().toISOString(),
            });
          }
        }
      } catch {
        // ignore parse error
      }
    }
  } catch (err) {
    console.error('Remote fetch error:', err);
  }

  onProgress?.(`Fetched ${rawJobs.length} postings. Applying filter cascade...`);

  // 3. In-flight filtering
  const matchingJobs = [];
  for (const raw of rawJobs) {
    if (!raw.title || !raw.company || !raw.url) continue;

    const titleLower = raw.title.toLowerCase();
    const combined = `${raw.title} ${raw.tags?.join(' ') ?? ''} ${raw.description.slice(0, 300)}`.toLowerCase();

    // Excluded keywords check
    if (excludedKeywords.some((ex) => combined.includes(ex))) continue;

    // Experience bounds check
    if (maxExperienceYears <= 2 && (titleLower.includes('senior') || titleLower.includes('lead') || titleLower.includes('principal'))) {
      continue;
    }

    // Target titles check
    if (!targetTitles.some((t) => titleLower.includes(t) || combined.includes(t))) continue;

    // Employment type check
    const empType = detectEmploymentType(raw.title);
    if (empType !== 'unknown' && allowedTypes.size > 0 && !allowedTypes.has(empType)) {
      continue;
    }

    matchingJobs.push({ ...raw, empType });
  }

  onProgress?.(`Matched ${matchingJobs.length} relevant roles. Generating dedupe fingerprints...`);

  let jobsInserted = 0;
  let appsCreated = 0;

  // 4. Transform and Upsert
  const candidateRows = [];
  for (const job of matchingJobs) {
    const fingerprint = await computeJobFingerprint(job.company, job.title, job.location);
    const atsProvider = detectAtsProvider(job.url);

    candidateRows.push({
      fingerprint,
      title: job.title.trim(),
      company_name: job.company.trim(),
      company_slug: slugify(job.company),
      location_raw: job.location,
      locations: ['Remote'],
      work_arrangement: 'remote',
      employment_type: job.empType,
      description_raw: job.description,
      apply_url: job.url,
      ats_provider: atsProvider,
      discovered_via: ['other'],
      source_refs: [
        {
          provider: 'other',
          url: job.url,
          first_seen_at: new Date().toISOString(),
          last_seen_at: new Date().toISOString(),
          metadata: { tier: 3, source: job.source, ats: atsProvider },
        },
      ],
      posted_at: job.postedAt ?? new Date().toISOString(),
      posted_at_source: 'unknown',
      salary_min: job.salaryMin ?? null,
      salary_max: job.salaryMax ?? null,
      salary_currency: job.salaryCurrency ?? 'USD',
    });
  }

  onProgress?.(`Saving ${candidateRows.length} jobs to database...`);

  // Batch insert into Supabase
  const BATCH = 25;
  for (let i = 0; i < candidateRows.length; i += BATCH) {
    const batch = candidateRows.slice(i, i + BATCH);

    const { data: upsertedJobs, error: jobErr } = await supabase
      .from('jobs')
      .upsert(batch, { onConflict: 'user_id,fingerprint', ignoreDuplicates: false })
      .select('id, fingerprint');

    let batchJobIds: string[] = [];
    if (!jobErr && upsertedJobs && upsertedJobs.length > 0) {
      batchJobIds = upsertedJobs.map((j) => j.id);
    } else {
      const fps = batch.map((b) => b.fingerprint);
      const { data: existing } = await supabase
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
        status: 'discovered',
      }));

      const { data: insertedApps, error: appErr } = await supabase
        .from('applications')
        .upsert(appInserts, { onConflict: 'user_id,job_id', ignoreDuplicates: true })
        .select('id');

      if (!appErr && insertedApps) {
        appsCreated += insertedApps.length;
      }
    }

    jobsInserted += batchJobIds.length;
  }

  // Log in agent_runs
  try {
    await supabase.from('agent_runs').insert({
      agent: 'scout_aggregator',
      status: 'succeeded',
      rows_in: rawJobs.length,
      rows_out: appsCreated,
    });
  } catch {
    // optional telemetry
  }

  onProgress?.(`Completed! ${jobsInserted} jobs processed, ${appsCreated} new applications queued.`);

  return {
    ok: true,
    message: `Discovered ${matchingJobs.length} matching remote positions across global feeds (${appsCreated} new applications queued).`,
    totalFetched: rawJobs.length,
    matchedCount: matchingJobs.length,
    jobsInserted,
    appsCreated,
  };
}

/**
 * Scans Watchlist ATS Boards (Greenhouse, Lever, Ashby) via Edge Function or direct API.
 */
export async function runWatchlistScan(
  onProgress?: (status: string) => void,
): Promise<WatchlistScanResult> {
  if (supabase === null) {
    return {
      ok: false,
      message: 'Supabase client is not configured.',
      boardsScanned: 0,
      jobsInserted: 0,
      appsCreated: 0,
      error: 'unconfigured_client',
    };
  }

  onProgress?.('Contacting Scout-ATS Edge Function...');

  try {
    // Attempt invoking the Edge Function first
    const { data, error } = await supabase.functions.invoke('scout-ats', {
      body: {},
    });

    if (!error && data) {
      const boardsScanned = Array.isArray(data.summaries) ? data.summaries.length : 1;
      const jobsInserted = Number(data.total_jobs_discovered ?? 0);
      const appsCreated = Number(data.total_applications_created ?? 0);

      onProgress?.(`Scan complete! ${boardsScanned} boards checked, ${appsCreated} new applications added.`);

      return {
        ok: true,
        message: `Scanned ${boardsScanned} company boards. ${appsCreated} new applications queued.`,
        boardsScanned,
        jobsInserted,
        appsCreated,
      };
    }
  } catch {
    // Fall back to scanning public Ashby boards directly from browser
  }

  onProgress?.('Edge function busy; scanning active watchlist Ashby/Public boards directly...');

  // Fallback: Query active watchlist boards directly
  const { data: boards } = await supabase
    .from('company_watchlist')
    .select('*')
    .order('last_polled_at', { ascending: true, nullsFirst: true })
    .limit(10);

  if (!boards || boards.length === 0) {
    return {
      ok: true,
      message: 'No company boards in your watchlist. Add companies in the Watchlist page first.',
      boardsScanned: 0,
      jobsInserted: 0,
      appsCreated: 0,
    };
  }

  let totalJobs = 0;
  let totalApps = 0;

  for (const board of boards) {
    onProgress?.(`Scanning ${board.company_name} (${board.ats_provider})...`);

    // For Ashby boards, browser has direct CORS access
    if (board.ats_provider === 'ashby') {
      try {
        const res = await fetch(`https://api.ashbyhq.com/posting-api/job-board/${board.board_token}`);
        if (res.ok) {
          const body = (await res.json()) as { jobs?: Array<{ title: string; location?: string; jobUrl: string; isRemote?: boolean }> };
          const jobs = body.jobs ?? [];

          const inserts = [];
          for (const j of jobs) {
            const fingerprint = await computeJobFingerprint(board.company_name, j.title, j.location);
            inserts.push({
              fingerprint,
              title: j.title,
              company_name: board.company_name,
              company_slug: board.company_slug,
              location_raw: j.location ?? 'Unknown',
              locations: j.isRemote ? ['Remote'] : [j.location ?? 'Onsite'],
              work_arrangement: j.isRemote ? 'remote' : 'onsite',
              employment_type: detectEmploymentType(j.title),
              apply_url: j.jobUrl,
              ats_provider: 'ashby',
              discovered_via: ['ashby'],
              posted_at: new Date().toISOString(),
              posted_at_source: 'unknown',
            });
          }

          if (inserts.length > 0) {
            const { data: upserted } = await supabase
              .from('jobs')
              .upsert(inserts, { onConflict: 'user_id,fingerprint' })
              .select('id');

            if (upserted && upserted.length > 0) {
              const appInserts = upserted.map((u) => ({ job_id: u.id, status: 'discovered' }));
              const { data: created } = await supabase
                .from('applications')
                .upsert(appInserts, { onConflict: 'user_id,job_id', ignoreDuplicates: true })
                .select('id');

              totalJobs += upserted.length;
              totalApps += created?.length ?? 0;
            }
          }
        }
      } catch {
        // next board
      }
    }
  }

  return {
    ok: true,
    message: `Scanned ${boards.length} watchlist boards. ${totalApps} new applications created.`,
    boardsScanned: boards.length,
    jobsInserted: totalJobs,
    appsCreated: totalApps,
  };
}
