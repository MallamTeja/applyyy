// The form URL to open for an application: the stored apply URL, or, for a company careers
// page that only iframes Greenhouse, the Greenhouse embed form itself (2026-10-24).
//
// WHY. Greenhouse's job JSON gives `absolute_url`, which for a board with a custom careers
// site is the COMPANY page (aiven.io/careers/job/<id>?gh_jid=<id>). That page builds its
// form inside a cross-origin iframe, so the kit read 0 fields and the applier found
// "0 submit controls" and parked the row as unsupported_form. The hosted job page
// (job-boards.greenhouse.io/<token>/jobs/<id>) is no escape: for such boards it redirects
// straight back to the company page (measured: Aiven, 302). The embed form
// (job-boards.greenhouse.io/embed/job_app?for=<token>&token=<id>) is what the iframe loads,
// and it serves the real form with no redirect (measured: 200, "Job Application for ... at Aiven").
//
// THE RULE: NEVER A GUESS. The board token comes from company_watchlist, and catalog tokens
// have been guessed wrong before (greenhouse 'tcs' is Thornbury, not Tata). So before the
// form is used, Greenhouse's own API must confirm that exact job id is on that board under
// the same company name, or with an absolute_url that is the very page we hold (T4: Rubrik's
// board is named "Rubrik Job Board"). Unknown token, a failed check, or any error: the stored URL is
// returned unchanged, which is today's behaviour (the row parks for a human).
//
// ONE RESOLVER, TWO CALLERS: apply-one (the applier) and apply-kit (the manual kit) both call
// it before the robots gate, so robots.txt is asked about the URL that is actually opened.

// The loose client type every worker gateway uses.
import type { SupabaseLike } from './supabase-gateway.ts';

// A JSON GET: the status, and the parsed body or null when it is not JSON. A function type
// so tests answer with a fake and never touch the network.
export type FetchJson = (url: string) => Promise<{ readonly status: number; readonly body: unknown }>;

// What the watchlist knows about the row's company: its Greenhouse board token and the
// company name the job row carries (the identity Greenhouse must agree with).
export interface GreenhouseBoard {
  // company_watchlist.board_token, untrusted until the API confirms it.
  readonly token: string;
  // jobs.company_name for this application.
  readonly companyName: string;
}

// The board for one application, or null when none is known. May throw on a read failure;
// the resolver treats a throw as "unknown".
export type BoardLookup = (applicationId: string) => Promise<GreenhouseBoard | null>;

// The port the applier and the kit take: one row in, the URL to open out. Never throws.
export type FormUrlResolver = (row: { readonly id: string; readonly applyUrl: string }) => Promise<string>;

// Greenhouse job ids are plain decimal digits. Checked as a whole string: Number() would
// accept '1e5', ' 123' and '0x10', and a template would paste '123/../x' into a path.
const GH_JOB_ID = /^\d{1,20}$/;
// A board token as Greenhouse issues them; anything else is never pasted into a URL path.
const BOARD_TOKEN = /^[a-z0-9_-]{1,100}$/i;
// The public job-board API, the same origin the scout polls (ats/greenhouse.ts).
const GREENHOUSE_API = 'https://boards-api.greenhouse.io/v1/boards';
// The embed form host. The global host serves EU boards too (measured: aiven36 is EU, 200).
const GREENHOUSE_EMBED = 'https://job-boards.greenhouse.io/embed/job_app';
// One slow API call must not stall a batch; past this the row keeps its stored URL.
const FETCH_TIMEOUT_MS = 15_000;

/** The gh_jid query value when it is a well-formed job id, else null. */
function ghJobId(applyUrl: string): string | null {
  // An unparseable URL has no query to read.
  let parsed: URL;
  try {
    // The parser, never a regex over the raw string.
    parsed = new URL(applyUrl);
  } catch {
    // Not a URL: nothing to resolve.
    return null;
  }
  // A Greenhouse host already serves its own page; only a foreign page that embeds one needs this.
  if (parsed.hostname === 'greenhouse.io' || parsed.hostname.endsWith('.greenhouse.io')) return null;
  // The id the embed script reads.
  const jid = parsed.searchParams.get('gh_jid');
  // Digits only, or nothing.
  return jid !== null && GH_JOB_ID.test(jid) ? jid : null;
}

/** Lowercased and trimmed, so ' Aiven' and 'aiven' are one company. Equality, never substring. */
function sameCompany(a: string, b: string): boolean {
  // Both sides normalised the same way.
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/**
 * Whether Greenhouse's own `absolute_url` for the job is the page we hold: same host, same path,
 * same gh_jid. Parsed, never compared as raw strings, so a tracking parameter or the order of the
 * query does not matter, but a different company's site always does.
 */
function sameJobPage(absoluteUrl: unknown, applyUrl: string): boolean {
  // The API field may be missing or not a string; that proves nothing.
  if (typeof absoluteUrl !== 'string') return false;
  try {
    // Both through the parser.
    const theirs = new URL(absoluteUrl);
    // Ours parsed before (ghJobId), so this cannot throw for a URL that reached here.
    const ours = new URL(applyUrl);
    // Host (case-insensitive by the parser), path, and the job id the embed reads.
    return theirs.hostname === ours.hostname && theirs.pathname === ours.pathname && theirs.searchParams.get('gh_jid') === ours.searchParams.get('gh_jid');
  } catch {
    // An unparseable absolute_url confirms nothing.
    return false;
  }
}

/**
 * The production resolver over a board lookup and a JSON fetch.
 *
 * The lookup runs only for a URL with a valid gh_jid, so the common case costs no read.
 */
export function createFormUrlResolver(lookup: BoardLookup, fetchJson: FetchJson): FormUrlResolver {
  return async (row) => {
    // No embedded-Greenhouse id: the stored URL is the form (or as close as we know).
    const jid = ghJobId(row.applyUrl);
    // Nothing to resolve.
    if (jid === null) return row.applyUrl;
    try {
      // The watchlist's board for this row's company.
      const board = await lookup(row.id);
      // Unknown, or a token that could not be a real one: never guessed.
      if (board === null || !BOARD_TOKEN.test(board.token) || board.companyName.trim() === '') return row.applyUrl;
      // Greenhouse's own record of that job on that board.
      const res = await fetchJson(`${GREENHOUSE_API}/${board.token}/jobs/${jid}`);
      // Loose read of the body, proven below.
      const job = res.body as { id?: unknown; company_name?: unknown; absolute_url?: unknown } | null;
      // Only a 200 can confirm; a 404 means the job is not on this board.
      if (res.status !== 200 || typeof job !== 'object' || job === null) return row.applyUrl;
      // The same job: a number whose digits are exactly the gh_jid.
      if (typeof job.id !== 'number' || String(job.id) !== jid) return row.applyUrl;
      // The same company, by either of two proofs. A guessed token on another company's board fails both.
      // (1) The board's name equals the job's company name.
      const nameMatches = typeof job.company_name === 'string' && sameCompany(job.company_name, board.companyName);
      // (2) Greenhouse's own public URL for this job IS the page we hold (T4, 2026-11-05). Needed because
      // some boards are named differently from the company: Rubrik's API says "Rubrik Job Board", so
      // check (1) refused every Rubrik row although absolute_url was our apply_url character for character.
      if (!nameMatches && !sameJobPage(job.absolute_url, row.applyUrl)) return row.applyUrl;
      // Confirmed: the form the company's iframe would load.
      return `${GREENHOUSE_EMBED}?for=${board.token}&token=${jid}`;
    } catch {
      // A read failure or a network drop is "could not confirm": the stored URL stands.
      return row.applyUrl;
    }
  };
}

/** The board lookup over supabase-js: the row's job, then exactly one enabled Greenhouse watchlist row. */
export function supabaseBoardLookup(client: SupabaseLike): BoardLookup {
  return async (applicationId) => {
    // The job's company identity, through the application (RLS: only this user's rows).
    const app = await client.from('applications').select('jobs:job_id(company_slug, company_name)').eq('id', applicationId).maybeSingle();
    // supabase-js returns errors rather than throwing; the resolver reads a throw as "unknown".
    if (app.error) throw new Error(`form url: read application failed: ${app.error.message}`);
    // The embedded job, object or one-element array.
    const job = (Array.isArray(app.data?.jobs) ? app.data.jobs[0] : app.data?.jobs) as { company_slug?: unknown; company_name?: unknown } | null | undefined;
    // Both are needed: the slug finds the watchlist row, the name is what Greenhouse must match.
    if (typeof job?.company_slug !== 'string' || typeof job.company_name !== 'string') return null;
    // The company's Greenhouse board(s); two rows is ambiguous, so up to two are read.
    const rows = await client.from('company_watchlist').select('board_token').eq('company_slug', job.company_slug).eq('ats_provider', 'greenhouse').eq('enabled', true).limit(2);
    // Same error rule.
    if (rows.error) throw new Error(`form url: read watchlist failed: ${rows.error.message}`);
    // Exactly one board, or no answer: two candidates would be a guess.
    if (!Array.isArray(rows.data) || rows.data.length !== 1 || typeof rows.data[0]?.board_token !== 'string') return null;
    // The candidate, still to be confirmed by the API.
    return { token: rows.data[0].board_token, companyName: job.company_name };
  };
}

/** The production JSON GET: bounded by a timeout; a non-JSON body reads as null. */
export const fetchJson: FetchJson = async (url) => {
  // Aborts a hung connection so one row cannot stall the batch.
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), headers: { accept: 'application/json' } });
  // The body as text first, so an HTML soft-200 becomes null rather than a throw.
  const text = await res.text();
  try {
    // JSON when it is JSON.
    return { status: res.status, body: JSON.parse(text) as unknown };
  } catch {
    // Anything else proves nothing.
    return { status: res.status, body: null };
  }
};
