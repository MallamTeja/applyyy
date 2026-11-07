// Feed liveness: an in-flight row with NO ATS is retired when its own posting page says gone, so a
// dead posting never reaches approval or the bot.
//
// WHY (2026-11-07). Queue liveness (queue-liveness.ts) covers only rows on a polled ATS board. Rows
// from the remote feeds (Arbeitnow mirrors, Jobicy: ats_provider 'other') and pasted/manual pages
// (EA, L&T, Revature, MongoDB: 'unknown') had no check at all; 11 such rows sat at
// passed_filters..approved, 3 of them approved, so the bot could open a dead posting.
//
// THE RULE (CLAUDE.md §6). An ATS row needs TWO proofs (absent from a complete listing AND the
// posting endpoint gone). These rows have no complete listing: a feed run reads only its ~100 newest
// postings, so absence from a feed proves nothing and is not used. The ONE proof is the posting
// page's own explicit 404 or 410 (measured 2026-11-07: a bogus id gave Arbeitnow 410, Jobicy, EA
// and Revature 404). Everything else (a 200, 403, 5xx, a bot challenge, a robots refusal, a network
// drop) is "unknown" or "open" and changes nothing.
//
// THE RESTRUCTURE GUARD. With one proof, a site that moves its URL scheme would 404 every row it
// hosts at once. So when a host has >= 2 rows probed in one run and EVERY one said gone, none is
// retired and the host is reported instead. A single-row host (most manual pages) is not guarded:
// one row cannot tell a restructure from a closed posting, and guarding it would switch the check
// off for exactly the approved rows it exists for.
//
// KNOWN GAP. There is no heal path: planReappearances (liveness.ts) clears a mark only for ATS
// rows a poll lists again. A wrong mark here stays until a human clears it; the web shows it as
// "Posting gone", so it is visible, not silent.

// The transport's typed errors: the status is read from a field, never parsed from a message.
import { BotProtectionError, HttpError } from "../http/errors.ts";
// The verdict shape queue liveness already uses, so both checks speak one language.
import type { PostingVerdict } from "./queue-liveness.ts";

// The in-flight statuses, passed_filters through approved: the rows that can still become work for
// Teja or the bot. Applied/failed/dropped rows are done; probing them buys nothing.
const IN_FLIGHT_STATUSES: ReadonlySet<string> = new Set([
  // Screened in, not yet scored.
  "passed_filters",
  // Scored by the matcher.
  "scored",
  // Tailored resume written.
  "tailored",
  // Auditor verdicts.
  "audit_clean",
  "audit_flagged",
  // The approval queue.
  "awaiting_approval",
  // What the bot submits: the row this check exists for.
  "approved",
]);

// The ats_provider values this check covers: no board to poll, so no queue liveness. The caller
// selects on these; exported so the select and the doc cannot drift apart.
export const FEED_LIVENESS_PROVIDERS = ["other", "unknown"] as const;

// The in-flight statuses as a list, for the caller's select.
export const FEED_LIVENESS_STATUSES: readonly string[] = [...IN_FLIGHT_STATUSES];

// ponytail: a fixed per-run cap, not a per-host limiter. Ceiling: past it, a row waits for the next
// run. 11 rows qualified on 2026-11-07 and scout-ats runs 1-3 times a day, so 20 covers them all.
export const FEED_LIVENESS_CAP = 20;

// One no-ATS job as the scout selects it.
export interface FeedLivenessRow {
  // The job to mark.
  readonly id: string;
  // The posting page that is probed.
  readonly apply_url: string | null;
  // Already gone: never re-probed.
  readonly disappeared_at: string | null;
  // The job's applications; only an in-flight one makes it a candidate.
  readonly applications: readonly { readonly id: string; readonly status: string }[] | null;
}

// What one run of the probe found.
export interface FeedProbeResult {
  // Requests made, so a run that hit the cap says so.
  readonly probed: number;
  // Jobs whose page said gone and survived the restructure guard.
  readonly closedIds: string[];
  // Hosts where every one of >= 2 probes said gone: not retired, reported.
  readonly refusedHosts: string[];
}

// The rows worth one request: live in storage, an http(s) link, and an in-flight application. Pure.
export function feedCandidates(rows: readonly FeedLivenessRow[]): FeedLivenessRow[] {
  // Input order, so a capped run probes the same rows first every time.
  return rows.filter((job) =>
    // Still live in storage.
    job.disappeared_at === null &&
    // A link the transport may fetch; anything else is never requested.
    job.apply_url !== null && hostOf(job.apply_url) !== null &&
    // Still work for someone. A null list (a select that lost the embed) is not a candidate.
    (job.applications ?? []).some((app) => IN_FLIGHT_STATUSES.has(app.status)));
}

// The job's in-flight applications: each gets a reason event when its posting is retired.
export function feedApplicationIds(job: FeedLivenessRow): string[] {
  // Same set as the candidates.
  return (job.applications ?? []).filter((app) => IN_FLIGHT_STATUSES.has(app.status)).map((app) => app.id);
}

// The lower-cased host of an http(s) URL, or null for anything else (the guard's grouping key).
function hostOf(url: string): string | null {
  // URL throws on garbage; garbage is "no host".
  try {
    // Parsed once.
    const parsed = new URL(url);
    // Only http(s) is ever fetched (a javascript: link from a feed must never be).
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.hostname.toLowerCase() : null;
  } catch {
    // Not a URL.
    return null;
  }
}

// One probe of a posting page. Never throws. Only an explicit 404 or 410 is "closed".
export async function checkPage(get: (url: string) => Promise<Response | null>, url: string): Promise<PostingVerdict> {
  // The response, or the transport's typed failure.
  let res: Response | null;
  try {
    // The robots-gated GET (fetchPage in production); a non-2xx THROWS HttpError.
    res = await get(url);
  } catch (e) {
    // First: a bot challenge is an HttpError too, and whatever its status it is the site refusing us.
    if (e instanceof BotProtectionError) return "unknown";
    // The two explicit "gone" answers a posting page gives.
    if (e instanceof HttpError && (e.status === 404 || e.status === 410)) return "closed";
    // 403, 5xx, network, timeout, robots refusal: unknown.
    return "unknown";
  }
  // No response at all: unknown. A 200 page is open (it may be an "expired" page, which is still
  // not proof of gone, so it changes nothing either way).
  return res === null ? "unknown" : "open";
}

// Probe the candidates (up to `cap` requests) and apply the restructure guard. Never throws.
export async function probeFeedRows(
  rows: readonly FeedLivenessRow[],
  get: (url: string) => Promise<Response | null>,
  cap: number,
): Promise<FeedProbeResult> {
  // Per host: every probed job id and the ones that said gone.
  const byHost = new Map<string, { probed: string[]; closed: string[] }>();
  // Requests made.
  let probed = 0;
  for (const job of feedCandidates(rows)) {
    // Out of requests: the rest wait for the next run.
    if (probed >= cap) break;
    // Non-null: feedCandidates kept only rows with an http(s) host.
    const url = job.apply_url as string;
    // The guard's grouping key, proven non-null by the same filter.
    const host = hostOf(url) as string;
    // One request spent.
    probed += 1;
    // The page's own answer.
    const verdict = await checkPage(get, url);
    // This host's tally, created on first sight.
    const tally = byHost.get(host) ?? { probed: [], closed: [] };
    // Counted as probed whatever it said: an unknown is what keeps the guard from firing.
    tally.probed.push(job.id);
    // Only an explicit gone.
    if (verdict === "closed") tally.closed.push(job.id);
    // Stored back (a no-op after the first sight).
    byHost.set(host, tally);
  }
  // The retired ids and the guarded hosts.
  const closedIds: string[] = [];
  const refusedHosts: string[] = [];
  for (const [host, tally] of byHost) {
    // >= 2 probes and every one gone: a restructure looks exactly like this, so retire none.
    if (tally.probed.length >= 2 && tally.closed.length === tally.probed.length) refusedHosts.push(host);
    // Otherwise each explicit gone stands, including a single-row host's.
    else closedIds.push(...tally.closed);
  }
  // The run's findings.
  return { probed, closedIds, refusedHosts };
}
