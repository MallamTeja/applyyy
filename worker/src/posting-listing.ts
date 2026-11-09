// Is this posting still listed by its ATS? (2026-11-09.) The page signals in playwright-page.ts postingClosed()
// (an HTTP status >= 400, a "no longer available" sentence) are evidence only where the host's page status
// means "this job". On Ashby it does not: Cursor's whole hosted board (jobs.ashbyhq.com/cursor) answers 404
// while Ashby's public posting API lists its jobs, ce965450's among them (isListed: true). Reading that 404 as
// "closed" would park every live posting on such a board. So on Ashby the posting API is the evidence.
// Greenhouse and Lever are not judged here: no measured false case, and a closed Greenhouse posting redirects.
// FetchJson is the production JSON GET port (15 s timeout, non-JSON body reads as null), reused, not copied.
import type { FetchJson } from './form-url.ts';

/**
 * The verdict. A closed union, so a caller has to decide every case, and "could not ask" can never be
 * mistaken for "gone" (CLAUDE.md §6: a lenient reader's answer is not evidence).
 */
export type PostingListing =
  // The ATS's own board lists the job: open, whatever the hosted page answered.
  | { readonly kind: 'listed' }
  // A well-formed board listing without the job: closed, with the sentence that proves it.
  | { readonly kind: 'absent'; readonly evidence: string }
  // The API could not be read or did not have the listing shape: no verdict either way.
  | { readonly kind: 'unknown'; readonly reason: string }
  // Not a host with a posting API this module knows: the page's own signals decide.
  | { readonly kind: 'no_api' };

/** The port the page adapter takes: the opened URL in, a verdict out. Never throws. */
export type ListingCheck = (url: string) => Promise<PostingListing>;

// Ashby job ids are uuids. Checked as a whole segment, so nothing else is pasted into a lookup.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// A board name as it appears in Ashby URLs; anything else is never pasted into the API path.
const BOARD = /^[a-z0-9._-]{1,100}$/i;
// The public posting API (no key), the board-wide listing.
const ASHBY_POSTING_API = 'https://api.ashbyhq.com/posting-api/job-board';

/** The board and job id of a hosted Ashby job page or its /application form, else null. */
export function ashbyPostingRef(url: string): { board: string; id: string } | null {
  // The parser, never a regex over the raw string.
  let parsed: URL;
  try {
    // An unparseable URL names no job.
    parsed = new URL(url);
  } catch {
    // Not a URL.
    return null;
  }
  // Exactly Ashby's hosted-board host; a look-alike suffix is not Ashby.
  if (parsed.hostname !== 'jobs.ashbyhq.com') return null;
  // Path segments, empty ones dropped (a trailing slash).
  const parts = parsed.pathname.split('/').filter((part) => part !== '');
  // /<board>/<uuid> or /<board>/<uuid>/application, nothing else.
  const shapeOk = (parts.length === 2 || (parts.length === 3 && parts[2] === 'application'));
  // Both pieces checked before either is used.
  if (!shapeOk || !BOARD.test(parts[0] ?? '') || !UUID.test(parts[1] ?? '')) return null;
  // The ids, lowercased like the API returns them.
  return { board: parts[0]!, id: parts[1]!.toLowerCase() };
}

/** The production check over a JSON fetch. Ashby only; every other host is 'no_api'. */
export function createListingCheck(fetchJson: FetchJson): ListingCheck {
  return async (url) => {
    // Which job, if this is a hosted Ashby page.
    const ref = ashbyPostingRef(url);
    // Not Ashby: nothing to ask.
    if (ref === null) return { kind: 'no_api' };
    // The board's listing.
    let res: Awaited<ReturnType<FetchJson>>;
    try {
      // One GET per check.
      res = await fetchJson(`${ASHBY_POSTING_API}/${ref.board}`);
    } catch (error) {
      // A timeout or a network drop is "could not ask", never "gone".
      return { kind: 'unknown', reason: `Ashby posting API unreachable: ${String(error)}` };
    }
    // Only a 200 can carry a listing.
    if (res.status !== 200) return { kind: 'unknown', reason: `Ashby posting API answered HTTP ${res.status}` };
    // The POSITIVE shape: an object with a jobs array. Anything else (null, an error object) proves nothing.
    const jobs = (res.body as { jobs?: unknown } | null)?.jobs;
    // Not the listing shape: no verdict.
    if (!Array.isArray(jobs)) return { kind: 'unknown', reason: 'Ashby posting API body has no jobs array' };
    // The job's entry, matched on the whole id.
    const entry = jobs.find((job) => typeof job === 'object' && job !== null && String((job as { id?: unknown }).id).toLowerCase() === ref.id) as { isListed?: unknown } | undefined;
    // Present and not explicitly unlisted: open.
    if (entry !== undefined && entry.isListed !== false) return { kind: 'listed' };
    // A real listing that does not offer it: closed, said with its source.
    return { kind: 'absent', evidence: `Ashby's public posting API no longer lists ${ref.id} on board "${ref.board}"${entry === undefined ? '' : ' (isListed: false)'}` };
  };
}
