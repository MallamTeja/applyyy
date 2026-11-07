// Queue liveness: a posting in the approval queue (awaiting_approval, approved) that has left its
// board is confirmed closed on the SAME poll, so Teja never approves or applies to a dead job.
//
// WHY (2026-11-07). The 10:50 IST sweep found Thoughtworks 98c4d344 closed while awaiting approval:
// its job endpoint said 404 and a complete 200 listing no longer held it, but jobs.disappeared_at
// was null. planDisappearances (liveness.ts) marks a row outside the previous poll's basis only
// after 14 days (STALE_BACKLOG_MIN_AGE_MS), which protects the WHOLE backlog from a board that
// keeps truncating its list. That wait is right for the backlog and wrong for the few rows Teja is
// about to act on.
//
// THE RULE (CLAUDE.md §6). Closed needs TWO independent proofs: the row is absent from a complete,
// trusted 200 listing (the scout's own poll, which already ran) AND the provider's own posting
// endpoint says gone: an explicit 404, or Workday's `canApply: false`. Ashby has no per-posting
// endpoint, so its second proof is a fresh read of the whole board that, well-formed and non-empty,
// no longer holds the posting's id (added 2026-11-07). Everything else (a timeout,
// a 403, a 5xx, a bot challenge, a robots refusal, an odd body) is "unknown" and changes nothing.
// FIS answered 403 for a closed posting on 2026-11-07, and a WAF answers 403 for live ones too.
//
// WHAT A "CLOSED" DOES. The caller sets jobs.disappeared_at, the signal everything already reads:
// the worker refuses to apply (supabase-gateway.ts `posting_disappeared`), the matcher skips the row,
// and the web shows "Posting gone". planReappearances clears it if the posting is ever relisted, so
// a wrong mark heals on the next poll.

// The transport's typed errors: the status is read from a field, never parsed from a message.
import { BotProtectionError, HttpError } from "../http/errors.ts";
// Workday's detail endpoint, built from the apply link the same way the description read builds it.
import { workdayDetailUrl } from "./adapters/workday.ts";
// The shared object guard.
import { isRecord } from "../ats/types.ts";
// Ashby's board URL, built exactly as the poll builds it, so the second read hits the same listing.
import { ashbyAdapter } from "../ats/ashby.ts";

// The statuses whose postings are confirmed early: the rows Teja is about to act on.
const QUEUE_STATUSES: ReadonlySet<string> = new Set(["awaiting_approval", "approved"]);

// ponytail: a fixed per-run cap on confirmation requests, not a per-host limiter. Ceiling: past it,
// a queue row waits for the next poll (or the 14-day path). The queue held 21 rows on 2026-11-07, and
// only rows that ALSO left their board this poll spend a request, so a normal run spends 0-2.
export const QUEUE_LIVENESS_CAP = 20;

// One stored job on the polled board, as the board snapshot selects it.
export interface QueueSnapshotJob {
  // The row to mark.
  readonly id: string;
  // The identity the poll is compared on.
  readonly fingerprint: string;
  // Already gone: never re-confirmed.
  readonly disappeared_at: string | null;
  // The posting's id on its board (Greenhouse numeric, Lever uuid).
  readonly ats_job_id: string | null;
  // The apply link; Workday's detail endpoint is derived from it.
  readonly apply_url: string | null;
  // The job's applications; only a queue status makes it a candidate.
  readonly applications: readonly { readonly id: string; readonly status: string }[] | null;
}

// What one confirmation request says.
export type PostingVerdict = "closed" | "open" | "unknown";

// The queue rows that need a confirmation: live, absent from this poll, not already marked by the
// planner this poll, and with an application in the approval queue. Pure.
export function queueCandidates(
  snapshot: readonly QueueSnapshotJob[],
  polledFingerprints: readonly string[],
  markedIds: readonly string[],
): QueueSnapshotJob[] {
  // The poll's identity set.
  const listed = new Set(polledFingerprints);
  // The planner's marks, which already retire their rows.
  const marked = new Set(markedIds);
  // Board order, so a capped run confirms the same rows first every time.
  return snapshot.filter((job) =>
    // Still live in storage.
    job.disappeared_at === null &&
    // Absent from the complete listing this poll fetched.
    !listed.has(job.fingerprint) &&
    // Not retired by the planner already.
    !marked.has(job.id) &&
    // In the approval queue.
    (job.applications ?? []).some((app) => QUEUE_STATUSES.has(app.status)));
}

// The job's applications that are in the approval queue: each gets a reason event when its posting
// is retired, so the card and the history say WHY the row cannot be approved or applied.
export function queueApplicationIds(job: QueueSnapshotJob): string[] {
  // Same set as the candidates.
  return (job.applications ?? []).filter((app) => QUEUE_STATUSES.has(app.status)).map((app) => app.id);
}

// Greenhouse ids are numbers; anything else could steer the request elsewhere on the API.
const GREENHOUSE_ID = /^\d+$/;
// Lever ids are uuids, and so are Ashby's.
const LEVER_ID =/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The provider's own endpoint for ONE posting, or null when there is none (Ashby, any other
// provider) or the stored id is not the provider's shape. null means "cannot confirm", never "closed".
export function postingCheckUrl(provider: string, boardToken: string, job: QueueSnapshotJob): string | null {
  // Greenhouse: the board's job endpoint.
  if (provider === "greenhouse") {
    // Numeric id only.
    return job.ats_job_id !== null && GREENHOUSE_ID.test(job.ats_job_id)
      ? `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(boardToken)}/jobs/${job.ats_job_id}`
      : null;
  }
  // Lever: the postings endpoint.
  if (provider === "lever") {
    // Uuid only.
    return job.ats_job_id !== null && LEVER_ID.test(job.ats_job_id)
      ? `https://api.lever.co/v0/postings/${encodeURIComponent(boardToken)}/${job.ats_job_id}`
      : null;
  }
  // Workday: the detail endpoint from the apply link (anchored match; null for any other shape).
  if (provider === "workday") return job.apply_url === null ? null : workdayDetailUrl(job.apply_url);
  // Ashby has no per-posting endpoint, so its proof is a second read of the whole board, from the
  // adapter's own URL builder (2026-11-07). A uuid id is required to look for in that listing.
  if (provider === "ashby") return job.ats_job_id !== null && LEVER_ID.test(job.ats_job_id) ? ashbyAdapter.buildRequestUrl(boardToken) : null;
  // Any other provider: nothing to confirm with.
  return null;
}

// One confirmation request. Never throws. Only an explicit "gone" is "closed". `atsJobId` is what an
// Ashby listing is searched for; the per-posting providers do not read it.
export async function checkPosting(
  get: (url: string) => Promise<Response | null>,
  provider: string,
  url: string,
  atsJobId: string | null,
): Promise<PostingVerdict> {
  // The response, or the transport's typed failure.
  let res: Response | null;
  try {
    // The robots-gated GET (fetchBoard in production); a non-2xx THROWS HttpError.
    res = await get(url);
  } catch (e) {
    // A bot challenge is the site refusing us, whatever its status: not evidence.
    if (e instanceof BotProtectionError) return "unknown";
    // The one explicit "gone", for a POSTING endpoint. Ashby's URL is the whole board: a 404 there
    // says the board moved, not that this posting closed.
    if (e instanceof HttpError && e.status === 404 && provider !== "ashby") return "closed";
    // 403, 5xx, network, timeout, robots refusal: unknown.
    return "unknown";
  }
  // No response at all: unknown.
  if (res === null) return "unknown";
  // Ashby: the whole board, searched on the raw ids.
  if (provider === "ashby") return ashbyListingVerdict(res, atsJobId);
  // Greenhouse and Lever: a 200 for the posting is the posting.
  if (provider !== "workday") return "open";
  // Workday answers 200 for a posting it no longer takes applications for; its flag decides.
  try {
    // The parsed body.
    const payload: unknown = JSON.parse(await res.text());
    // The flag, only when it is really a boolean.
    const canApply = isRecord(payload) && isRecord(payload.jobPostingInfo) ? payload.jobPostingInfo.canApply : undefined;
    // An explicit false is closed, an explicit true is open, anything else is unknown.
    return canApply === false ? "closed" : canApply === true ? "open" : "unknown";
  } catch {
    // A soft-200 HTML page or an unreadable body.
    return "unknown";
  }
}

// An Ashby board listing read as proof for one posting. Closed ONLY when the body is a well-formed,
// NON-EMPTY `jobs` array whose every entry has a string id and none is this posting's id. Any
// listing entry counts as present, listed or not: the posting still exists. An empty list is what a
// truncated or broken answer looks like, and one entry without an id means the list cannot be
// trusted to be complete; both are unknown (CLAUDE.md §6).
async function ashbyListingVerdict(res: Response, atsJobId: string | null): Promise<PostingVerdict> {
  // Nothing to look for.
  if (atsJobId === null) return "unknown";
  try {
    // The parsed board.
    const payload: unknown = JSON.parse(await res.text());
    // The postings array, or nothing.
    const jobs = isRecord(payload) && Array.isArray(payload.jobs) ? (payload.jobs as unknown[]) : null;
    // No array, or an empty one: not evidence.
    if (jobs === null || jobs.length === 0) return "unknown";
    // Every id, or null when any entry lacks one.
    const ids = jobs.map((job) => (isRecord(job) && typeof job.id === "string" ? job.id : null));
    // One malformed entry: the listing is not trusted to be complete.
    if (ids.includes(null)) return "unknown";
    // Present means open; absent from a complete listing means closed.
    return ids.includes(atsJobId) ? "open" : "closed";
  } catch {
    // A soft-200 page or an unreadable body.
    return "unknown";
  }
}
