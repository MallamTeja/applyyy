/* Browser Discovery Service: the Watchlist ATS scan, triggered from the Application UI.
 *
 * Runs the scout-ats Edge Function (falling back to direct Ashby reads) against the
 * Company Watchlist, deduplicates by SHA-256 fingerprint and queues applications.
 *
 * REMOTE FEEDS ARE NOT HERE ANY MORE (retired 2026-10-24). The browser used to fetch
 * RemoteOK, Jobicy and Arbeitnow itself and insert every posting UNSCREENED at
 * 'discovered', with no apply-URL gate: the same backlog pile-up and javascript: link
 * surface the worker scout had. Those feeds now run once a day on
 * .github/workflows/scout-remote.yml through the shared safety and screening path
 * (worker/src/scout/remote-run.ts), and this file keeps only the sentence that says so.
 */

import { supabase } from './supabase';
// The one contract type the watchlist scan still builds rows with.
import type { EmploymentType } from './contract';

/* What every remote-feed button shows instead of a scan. One sentence, so the modal and the
   tests agree on it; the time matches the cron in .github/workflows/scout-remote.yml. */
export const REMOTE_FEEDS_SCHEDULE_NOTE =
  'Remote feeds (RemoteOK, Jobicy, Arbeitnow) are scouted automatically every day at 07:00 IST and screened as they arrive: jobs that pass appear in "Ready to tailor" on the Discovered page.';

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

function detectEmploymentType(text: string): EmploymentType {
  const lower = text.toLowerCase();
  if (lower.includes('intern') || lower.includes('co-op') || lower.includes('trainee')) return 'internship';
  if (lower.includes('contract') || lower.includes('freelance')) return 'contract';
  if (lower.includes('part-time') || lower.includes('part time')) return 'part_time';
  if (lower.includes('full-time') || lower.includes('full time') || lower.includes('permanent')) return 'full_time';
  return 'unknown';
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
