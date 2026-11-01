/* Browser Discovery Service: the Watchlist ATS scan, triggered from the Application UI.
 *
 * Asks the scout-ats Edge Function to scan the Company Watchlist and reports what it said.
 * The function deduplicates, screens and queues; the browser reads nothing and writes nothing.
 *
 * THE BROWSER FALLBACK IS GONE (2026-11-01, wiring audit W8). On any scout-ats failure except
 * 401/403 this file used to scan Ashby boards itself. That path upserted `jobs` with ON CONFLICT
 * DO UPDATE and `posted_at = now`, `posted_at_source = 'unknown'`, so it overwrote real scout rows
 * (every live Ashby job had an 'exact' date) and made stale jobs look fresh. It also polled
 * disabled boards, never read the kill switch, and reported a failed watchlist read as "add
 * companies first". A failure now says what failed, and the server-side scan stays the only writer.
 *
 * REMOTE FEEDS ARE NOT HERE ANY MORE (retired 2026-10-24). The browser used to fetch
 * RemoteOK, Jobicy and Arbeitnow itself and insert every posting UNSCREENED at
 * 'discovered', with no apply-URL gate: the same backlog pile-up and javascript: link
 * surface the worker scout had. Those feeds now run once a day on
 * .github/workflows/scout-remote.yml through the shared safety and screening path
 * (worker/src/scout/remote-run.ts), and this file keeps only the sentence that says so.
 */

import { supabase } from './supabase';

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

/* The first 200 characters of a failed response's body, or '' when there is none to read.
 * FunctionsHttpError carries the raw Response as `context`; scout-ats puts its reason there
 * (e.g. `{"error":"kill_switch_read_failed"}`), which is the sentence the operator needs. */
async function responseTextOf(error: unknown): Promise<string> {
  // Only an object can carry a context.
  if (typeof error !== 'object' || error === null) return '';
  // The Response, when present.
  const context = (error as { context?: unknown }).context;
  // A fetch or relay error carries no readable body.
  if (!(context instanceof Response)) return '';
  try {
    // Trimmed so a large HTML error page cannot flood the modal.
    return (await context.text()).trim().slice(0, 200);
  } catch {
    // An already-read or broken body: fall back to the error's own message.
    return '';
  }
}

/**
 * Asks the scout-ats Edge Function to scan the Watchlist ATS boards (Greenhouse, Lever,
 * Ashby, SmartRecruiters) and reports what it said. Never scans or writes from the browser.
 */
export async function runWatchlistScan(
  onProgress?: (status: string) => void,
  // The app's client by default; a test passes a fake whose invoke answers { data, error }
  // like functions-js, since node --test has no module mocks without an experimental flag.
  client: typeof supabase = supabase,
): Promise<WatchlistScanResult> {
  // No client means no env: report it rather than call anything.
  if (client === null) {
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

  // invoke() attaches the session JWT, which scout-ats requires. It never throws: HTTP,
  // relay and network failures all come back as `error` (functions-js FunctionsClient).
  const { data, error } = await client.functions.invoke('scout-ats', {
    body: {},
  });

  // Non-2xx responses arrive as an error carrying the raw Response in `context`.
  if (error) {
    // Read the HTTP status defensively; not every invoke error carries a Response.
    const status = httpStatusOf(error);
    // Auth failures are the user's to fix (sign in again), so say exactly that.
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
    // 504 = the gateway stopped waiting; 546 = the function hit a resource limit. Either way the
    // server got the request and may have saved boards before the answer was lost, so "nothing
    // happened" would be wrong. The scan writes per board, so finished boards are already in.
    if (status === 504 || status === 546) {
      return {
        // Not a confirmed success: the outcome is unknown to the browser.
        ok: false,
        // Where to look, instead of a retry that would start a second scan on top of the first.
        message: `Scout-ATS did not answer in time (HTTP ${status}). The scan may still be running on the server, and boards it finished are already saved: check the Discovered page in a few minutes before scanning again.`,
        // Unknown, reported as zero alongside ok:false so nothing reads it as success.
        boardsScanned: 0,
        // Same.
        jobsInserted: 0,
        // Same.
        appsCreated: 0,
        // Machine-readable reason.
        error: 'server_timeout',
      };
    }
    // Every other failure is reported as it is: the function's own body when it sent one,
    // otherwise the client's message (a network failure has no status and no body).
    const detail = (await responseTextOf(error)) || (error instanceof Error ? error.message : String(error));
    return {
      // The scan failed; the browser does not try to do the server's job (W8).
      ok: false,
      // Status first, so 500 and a network drop read differently.
      message: `Scout-ATS failed${status === null ? '' : ` (HTTP ${status})`}: ${detail}`,
      // Nothing confirmed, so zero alongside ok:false.
      boardsScanned: 0,
      // Same.
      jobsInserted: 0,
      // Same.
      appsCreated: 0,
      // Machine-readable reason.
      error: 'scout_ats_failed',
    };
  }

  // A 2xx body is validated, never defaulted: the old code read fields scout-ats
  // never sends (summaries / total_*), defaulted them to 0, and reported a
  // successful "0 new applications" for every run.
  const parsed = parseScoutAtsResponse(data);
  // An unrecognised body is a failure to report, not zeros to display.
  if (parsed === null) {
    return {
      // We cannot say what happened, so it did not demonstrably succeed.
      ok: false,
      // Include the body so the mismatch is diagnosable. An empty body is named, not quoted:
      // JSON.stringify(undefined) is undefined, and its .slice threw out of a function the
      // modal trusts never to throw (code-review #9). `?? String(data)` covers any other
      // value JSON cannot serialise (a function, a symbol) the same way.
      message: `Scout-ATS returned an unrecognised response: ${
        data === undefined || data === null || data === ''
          ? 'an empty body'
          : (JSON.stringify(data) ?? String(data)).slice(0, 200)
      }`,
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
