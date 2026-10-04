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

  // Every failed write, by batch, so the run can be closed honestly. Until
  // 2026-10-04 upsert errors were skipped silently and agent_runs said 'succeeded'
  // regardless, so a run that wrote nothing looked identical to a healthy one.
  const failures: string[] = [];

  // Batch insert into Supabase
  const BATCH = 25;
  for (let i = 0; i < candidateRows.length; i += BATCH) {
    // One batch keeps each request under PostgREST's comfortable payload size.
    const batch = candidateRows.slice(i, i + BATCH);
    // Human-readable batch label for the failure list.
    const label = `batch ${i / BATCH + 1}`;

    const { data: upsertedJobs, error: jobErr } = await supabase
      .from('jobs')
      .upsert(batch, { onConflict: 'user_id,fingerprint', ignoreDuplicates: false })
      .select('id, fingerprint');

    // A failed jobs upsert is a failure of this batch. No fallback lookup: the old
    // one re-read EXISTING jobs and counted them as inserted, hiding the error.
    if (jobErr) {
      // Record and move on; later batches may still succeed.
      failures.push(`${label} jobs upsert: ${jobErr.message}`);
      // Nothing to attach applications to.
      continue;
    }

    // Ids of the rows the upsert actually wrote or updated.
    const batchJobIds: string[] = (upsertedJobs ?? []).map((j) => j.id);
    // Only those count as processed.
    jobsInserted += batchJobIds.length;

    // An empty batch result needs no application insert.
    if (batchJobIds.length > 0) {
      // NOTE: rows land at `discovered` with no Screener pass. Nothing writes
      // `deduped`, so these rows cannot advance (CLAUDE.md §8). Recorded, not fixed
      // here: changing the insert status is a pipeline decision, not a UI one.
      const appInserts = batchJobIds.map((job_id) => ({
        // The job this application is for.
        job_id,
        // The only pre-gate status the insert guard admits for a fresh scout row.
        status: 'discovered',
      }));

      const { data: insertedApps, error: appErr } = await supabase
        .from('applications')
        .upsert(appInserts, { onConflict: 'user_id,job_id', ignoreDuplicates: true })
        .select('id');

      // Checked, not skipped: a refused insert means jobs exist with no application.
      if (appErr) {
        // Record it against this batch.
        failures.push(`${label} applications upsert: ${appErr.message}`);
      } else {
        // ignoreDuplicates returns only NEW rows, so this is the real "created" count.
        appsCreated += (insertedApps ?? []).length;
      }
    }
  }

  // Close the run with the status the work earned. agent_run_status has no
  // 'partial' (20260909234500_enums.sql:190), so any failure is 'failed', with the
  // error count and detail saying how partial it was.
  const runStatus = failures.length === 0 ? 'succeeded' : 'failed';
  // A telemetry write that fails must not fail the scan, but it must not vanish either.
  try {
    const { error: runErr } = await supabase.from('agent_runs').insert({
      // The aggregator lane, a real agent_name value.
      agent: 'scout_aggregator',
      // Earned status, not a constant.
      status: runStatus,
      // Without finished_at the run reads as still running and duration_ms stays null.
      finished_at: new Date().toISOString(),
      // Everything fetched from the feeds.
      rows_in: rawJobs.length,
      // Applications actually created.
      rows_out: appsCreated,
      // How many writes failed.
      error_count: failures.length,
      // The failures themselves, or null on a clean run.
      error_detail: failures.length > 0 ? failures.join('; ') : null,
    });
    // Visible in the console for whoever is debugging the health page.
    if (runErr) console.warn('agent_runs insert failed:', runErr.message);
  } catch (err) {
    // Same: logged, not swallowed.
    console.warn('agent_runs insert threw:', err);
  }

  // A run with failures is reported as one, with the count, to the modal.
  if (failures.length > 0) {
    // Partial progress is still stated, so the user knows what did land.
    onProgress?.(`Finished with ${failures.length} failed write(s). ${jobsInserted} jobs saved, ${appsCreated} new applications.`);
    return {
      // Not ok: the user asked for all of these and some were refused.
      ok: false,
      // The first failure is usually the cause of the rest (RLS, schema).
      message: `${failures.length} database write(s) failed (${failures[0]}). ${jobsInserted} jobs saved, ${appsCreated} new applications.`,
      // Totals still reported, so the partial work is visible.
      totalFetched: rawJobs.length,
      // How many passed the browser-side relevance filter.
      matchedCount: matchingJobs.length,
      // Jobs that really landed.
      jobsInserted,
      // Applications that really landed.
      appsCreated,
      // Machine-readable reason for callers that branch on it.
      error: 'partial_write_failure',
    };
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

/* HTTP status of a functions.invoke error, or null. FunctionsHttpError carries the
 * raw Response as `context`; other error kinds (relay, fetch) do not. */
function httpStatusOf(error: unknown): number | null {
  // Only an object can carry a context.
  if (typeof error !== 'object' || error === null) return null;
  // The Response, when present.
  const context = (error as { context?: unknown }).context;
  // Must itself be an object with a numeric status.
  if (typeof context !== 'object' || context === null) return null;
  // Read the status without trusting its type.
  const status = (context as { status?: unknown }).status;
  // Numeric statuses only.
  return typeof status === 'number' ? status : null;
}

/* A count field must be a real non-negative integer. `Number(undefined ?? 0)` made a
 * missing field read as a confident 0; this makes it a parse failure instead. */
function isCount(value: unknown): value is number {
  // Integers only; NaN, strings and negatives are not counts.
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

/** Validates a scout-ats 200 body (supabase/functions/scout-ats/index.ts) and maps it
 *  to a scan result. Returns null for ANY shape it does not recognise. Three 200 shapes
 *  exist: the full run (`success: true`), `halted_by_kill_switch` and `no_boards_due`. */
export function parseScoutAtsResponse(body: unknown): WatchlistScanResult | null {
  // A non-object is not any of the three shapes.
  if (typeof body !== 'object' || body === null) return null;
  // Index without widening to any.
  const b = body as Record<string, unknown>;
  // Read once into locals so the type guards narrow them.
  const boards = b['boards_polled'];
  // Same.
  const jobs = b['jobs_discovered'];
  // The two short-circuit answers: nothing ran, for a stated reason.
  if (b['status'] === 'halted_by_kill_switch' || b['status'] === 'no_boards_due') {
    // Both send boards_polled and jobs_discovered; require them so a rename is caught.
    if (!isCount(boards) || !isCount(jobs)) return null;
    // A halt is not a success: the user asked for a scan and none happened.
    const halted = b['status'] === 'halted_by_kill_switch';
    return {
      // The kill switch is a failure to scan; "no boards due" is a correct, empty answer.
      ok: !halted,
      // The function's own sentence when it sent one.
      message: typeof b['message'] === 'string' ? b['message'] : String(b['status']),
      // From the response, not assumed.
      boardsScanned: boards,
      // Same.
      jobsInserted: jobs,
      // Neither shape creates applications.
      appsCreated: 0,
      // Machine-readable reason only for the halt.
      ...(halted ? { error: 'halted_by_kill_switch' } : {}),
    };
  }
  // Read into locals for narrowing.
  const apps = b['applications_created'];
  // Same.
  const results = b['results'];
  // The full run must say success:true and carry all three counts plus the results array.
  if (b['success'] !== true || !isCount(boards) || !isCount(jobs) || !isCount(apps) || !Array.isArray(results)) {
    // Anything else is unrecognised.
    return null;
  }
  // Boards whose own poll failed, so a run with failures is not reported as clean.
  const failedBoards = results.filter(
    // Each summary carries status "ok" | "skipped" | "failed".
    (r: unknown) => typeof r === 'object' && r !== null && (r as { status?: unknown }).status === 'failed',
  ).length;
  return {
    // Every board failing is a failed scan; some failing is reported in the message.
    ok: !(failedBoards > 0 && failedBoards === results.length),
    // States the numbers, and failed boards when there were any.
    message:
      `Scanned ${boards} company boards: ${jobs} jobs discovered, ${apps} new applications.` +
      (failedBoards > 0 ? ` ${failedBoards} board(s) failed to poll.` : ''),
    // Real field boards_polled, not the never-sent `summaries`.
    boardsScanned: boards,
    // Real field jobs_discovered, not `total_jobs_discovered`.
    jobsInserted: jobs,
    // Real field applications_created, not `total_applications_created`.
    appsCreated: apps,
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
    // Attempt invoking the Edge Function first. invoke() attaches the session JWT,
    // which scout-ats now requires.
    const { data, error } = await supabase.functions.invoke('scout-ats', {
      body: {},
    });

    // Non-2xx responses arrive as an error carrying the raw Response in `context`.
    if (error) {
      // Read the HTTP status defensively; not every invoke error carries a Response.
      const status = httpStatusOf(error);
      // Auth failures are not "busy": the browser fallback would hit the same wall,
      // and the fix is the user's (sign in again), so say so instead of falling back.
      if (status === 401 || status === 403) {
        return {
          // A refused call scanned nothing.
          ok: false,
          // 401 = no/expired session; 403 = authenticated but not allowed.
          message:
            status === 401
              ? 'Scout-ATS refused the request: your session is missing or expired. Sign in again and retry.'
              : 'Scout-ATS refused the request (403): this account is not allowed to run it.',
          // Nothing ran, so every count is zero by fact, not by default.
          boardsScanned: 0,
          // Same: nothing was inserted.
          jobsInserted: 0,
          // Same: nothing was created.
          appsCreated: 0,
          // Machine-readable reason.
          error: status === 401 ? 'unauthenticated' : 'forbidden',
        };
      }
      // Any other failure falls through to the direct-scan fallback below, as before.
    } else {
      // A 2xx body is validated, never defaulted: the old code read fields scout-ats
      // never sends (summaries / total_*), defaulted them to 0, and reported a
      // successful "0 new applications" for every run.
      const parsed = parseScoutAtsResponse(data);
      // An unrecognised body is a failure to report, not zeros to display.
      if (parsed === null) {
        return {
          // We cannot say what happened, so it did not demonstrably succeed.
          ok: false,
          // Include the body so the mismatch is diagnosable.
          message: `Scout-ATS returned an unrecognised response: ${JSON.stringify(data).slice(0, 200)}`,
          // Unknown, reported as zero alongside ok:false so nothing reads it as success.
          boardsScanned: 0,
          // Same.
          jobsInserted: 0,
          // Same.
          appsCreated: 0,
          // Machine-readable reason.
          error: 'unrecognised_response',
        };
      }
      // Recognised: report it in the modal's progress line too.
      onProgress?.(parsed.message);
      // The validated result, success or a stated halt.
      return parsed;
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
