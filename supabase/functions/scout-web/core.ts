// THE LLM PROPOSES, DETERMINISTIC CODE DISPOSES.
//
// Everything here is pure over two injected seams (search and board fetch), so the whole
// proposal -> shape check -> live-board verification pipeline runs in tests with no network.

import { getAdapter } from "../_shared/ats/registry.ts";
// Types only: the adapter contract and the board's own posting record.
import type { AtsAdapter, ParsedPosting } from "../_shared/ats/types.ts";
// Counting semaphore, so board verification is bounded without a new dependency.
import { createSemaphore } from "../_shared/http/concurrency.ts";
// The strict shape check and URL mining live apart so they can be tested alone.
import { extractUrls, parseJobUrl, type ParsedJobUrl, type WebProvider } from "./urls.ts";
// Grounding citations arrive as Google redirect URLs; this tells us which ones to resolve.
import { isGroundingRedirect, type RedirectResult } from "./redirects.ts";

// Hard ceiling on candidate URLs per call: each distinct board costs a robots check plus
// a fetch, and an Edge Function has a wall-clock budget.
export const MAX_CANDIDATES = 20;
// How many boards are verified at once. Small, for the same politeness reason as http/index.ts.
const BOARD_CONCURRENCY = 3;
// How many grounding redirects are resolved at once. They all hit one Google host, so a small
// cap keeps us from bursting it while MAX_CANDIDATES lookups still finish well inside the budget.
const REDIRECT_CONCURRENCY = 5;

// The injected LLM seam. `urls` are machine-collected (e.g. grounding metadata); `text`
// is the model's prose, which we also mine for URLs.
export type SearchFn = (query: string) => Promise<{ text: string; urls: string[] }>;

// The injected board-fetch seam. Production wires robots + the shared transport behind it.
export type FetchBoardFn = (
  // Which adapter family to fetch.
  provider: WebProvider,
  // The board token, already charset-validated by the shape check.
  token: string,
// A closed result: callers must handle failure, a null would be ambiguous with 'empty board'.
) => Promise<{ readonly ok: true; readonly payload: unknown } | { readonly ok: false; readonly reason: string }>;

// The injected redirect seam. Production wires resolveGroundingRedirect over the global fetch.
// It reads one hop and never throws, so a dead redirect costs one candidate, not the run.
export type ResolveRedirectFn = (url: string) => Promise<RedirectResult>;

// A posting confirmed to exist on the live board, with the data WE read from the board.
export interface VerifiedPosting {
  // Which board it came from.
  readonly parsedUrl: ParsedJobUrl;
  // The adapter that parsed it, needed again by toJobInsert.
  readonly adapter: AtsAdapter;
  // The board's own record. The LLM's title/company never reach this.
  readonly posting: ParsedPosting;
}

// A candidate we refused, with the reason the UI shows.
export interface Rejection {
  // The model-supplied URL, echoed back so the UI can show what was refused.
  readonly url: string;
  // A short machine-readable cause.
  readonly reason: string;
}

// What discovery learned.
export interface DiscoveryResult {
  // Candidate URLs examined (after dedupe and the cap).
  readonly proposed: number;
  // Postings found in a live board.
  readonly verified: readonly VerifiedPosting[];
  // Everything refused.
  readonly rejected: readonly Rejection[];
  // Infrastructure failures (board unreachable/unparseable/robots-blocked); a hallucinated
  // URL is a rejection, NOT an error, so a bad model day does not read as an outage.
  readonly errorCount: number;
  // First few error strings, for agent_runs.error_detail.
  readonly errorSamples: readonly string[];
  // Boards that were attempted, so "every board failed" is decidable.
  readonly boardsAttempted: number;
}

// Turn the master profile (untrusted JSON from the DB) into a search prompt.
// Returns null when there is nothing to search for. Shapes are checked, never assumed.
export function buildSearchPrompt(profile: unknown, extra: string | null): string | null {
  // Roles and skills collected defensively; a malformed profile just contributes nothing.
  const roles: string[] = [];
  // Skill names, collected the same defensive way.
  const skills: string[] = [];
  // Only an object can have fields.
  if (typeof profile === "object" && profile !== null) {
    // Read through a loose record type because the JSON is untrusted.
    const p = profile as Record<string, unknown>;
    // Experience entries carry the role titles we want to search for.
    if (Array.isArray(p["experience"])) {
      // Each entry is untrusted JSON, so it is read field by field.
      for (const e of p["experience"]) {
        // Role must be a non-empty string; anything else is skipped.
        const role = (e as Record<string, unknown> | null)?.["role"];
        // Non-string or blank roles are ignored rather than coerced.
        if (typeof role === "string" && role.trim() !== "") roles.push(role.trim());
      }
    }
    // Skill names, same defensive read.
    if (Array.isArray(p["skills"])) {
      // Same loop shape as experience, for skills.
      for (const s of p["skills"]) {
        // Name must be a non-empty string; anything else is skipped.
        const name = (s as Record<string, unknown> | null)?.["name"];
        // Non-string or blank names are ignored rather than coerced.
        if (typeof name === "string" && name.trim() !== "") skills.push(name.trim());
      }
    }
  }
  // Bounded so a huge profile cannot blow up the prompt.
  const topRoles = [...new Set(roles)].slice(0, 3);
  // Ten skills is enough signal; more would dilute the query.
  const topSkills = [...new Set(skills)].slice(0, 10);
  // The caller's own free-text query, already length-checked by the handler.
  const hint = extra === null || extra.trim() === "" ? null : extra.trim();
  // Nothing to go on: refuse rather than search for something arbitrary.
  if (topRoles.length === 0 && topSkills.length === 0 && hint === null) return null;
  // Assembled line by line so absent parts simply drop out.
  const lines = [
    // Opening instruction: current postings only, on the three boards we can verify.
    "Find CURRENT open job postings hosted on Greenhouse, Lever or Ashby.",
    // Spelling the shapes out raises the share of URLs that survive the shape check.
    "Allowed URL shapes only: https://job-boards.greenhouse.io/<board>/jobs/<id>, https://boards.greenhouse.io/<board>/jobs/<id>, https://jobs.lever.co/<board>/<uuid>, https://jobs.ashbyhq.com/<board>/<uuid>.",
    // The user's stated target: India or remote-global, mid-to-senior.
    "Target roles located in India or fully remote worldwide, mid-to-senior level.",
  ];
  // Profile-derived hints, when present.
  if (topRoles.length > 0) lines.push(`Recent roles of the candidate: ${topRoles.join("; ")}.`);
  // Skills line, same condition.
  if (topSkills.length > 0) lines.push(`Key skills: ${topSkills.join(", ")}.`);
  // The user's explicit steer goes last so it wins ties.
  if (hint !== null) lines.push(`Extra focus: ${hint}.`);
  // The answer format: bare URLs are the only thing we will parse.
  lines.push("Reply with a list of posting URLs only, one per line, no commentary.");
  // One string for the model.
  return lines.join("\n");
}

// Propose -> shape check -> live verification.
export async function discover(
  // The two seams, so tests inject fakes and production injects Gemini and robots-gated fetch.
  // The redirect seam is required, not optional. An optional one would let a caller forget it
  // and silently fall back to dropping every grounded result.
  deps: { readonly search: SearchFn; readonly fetchBoard: FetchBoardFn; readonly resolveRedirect: ResolveRedirectFn },
  // The built prompt, already derived from the profile.
  prompt: string,
  // Caller's limit, clamped below to the hard cap.
  limit: number,
// Resolves to what was learned; rejects only if the search call itself fails.
): Promise<DiscoveryResult> {
  // The model call is the one step that can throw; the caller decides what that means.
  const proposal = await deps.search(prompt);
  // Text-mined and machine-collected URLs merged, de-duplicated, then capped.
  const cap = Math.min(Math.max(1, Math.trunc(limit)), MAX_CANDIDATES);
  // Merge, dedupe, cap: the cap is enforced BEFORE any network use of the URLs.
  const candidates = [...new Set([...extractUrls(proposal.text), ...proposal.urls])].slice(0, cap);

  // Shape check each candidate; survivors are grouped by board so each board is fetched once.
  const rejected: Rejection[] = [];
  // Resolve grounding redirects AFTER the cap, so the cap bounds these requests too. The result
  // is still unverified: every resolved URL goes through the same parseJobUrl gate below.
  const redirectGate = createSemaphore(REDIRECT_CONCURRENCY);
  // Order is kept, so the output lines up with candidates and stays stable for tests.
  const resolvedCandidates = await Promise.all(candidates.map((url) =>
    // Anything that is not the exact Google redirect host passes through untouched, unfetched.
    isGroundingRedirect(url) ? redirectGate.run(() => deps.resolveRedirect(url)).then((r) => ({ url, r })) : Promise.resolve({ url, r: null })
  ));
  // What actually reaches the shape check: original URLs, plus redirect targets that resolved.
  const toCheck: string[] = [];
  // Each candidate either contributes a URL to check or a rejection with its reason.
  for (const { url, r } of resolvedCandidates) {
    // Not a redirect: checked exactly as before.
    if (r === null) toCheck.push(url);
    // Resolved: the TARGET is what gets checked (and echoed in any later rejection).
    else if (r.ok) toCheck.push(r.url);
    // Unresolvable redirect: reported, never silently dropped.
    else rejected.push({ url, reason: r.reason });
  }
  // Grouping by board means one fetch serves every posting from that board.
  const byBoard = new Map<string, { provider: WebProvider; token: string; wanted: { url: string; jobId: string }[] }>();
  // Each candidate gets its own verdict. De-duplicated again, since two redirects can point at one posting.
  for (const url of new Set(toCheck)) {
    // The strict gate.
    const result = parseJobUrl(url);
    // Refused candidates are reported, never silently dropped.
    if (!result.ok) {
      // Record why, so the UI can show it.
      rejected.push({ url, reason: result.reason });
      // Skip the board grouping for refused URLs.
      continue;
    }
    // Board identity, via boardKey() so the watchlist lookup in handler.ts uses the same key.
    const key = boardKey(result.parsed.provider, result.parsed.token);
    // Reuse the board entry when a second posting from the same board appears.
    const entry = byBoard.get(key) ?? { provider: result.parsed.provider, token: result.parsed.token, wanted: [] };
    // Remember which posting ids this board must contain.
    entry.wanted.push({ url, jobId: result.parsed.jobId });
    // Store back (a no-op for existing entries, an insert for new ones).
    byBoard.set(key, entry);
  }

  // Verified postings and error bookkeeping, filled by the concurrent workers below.
  const verified: VerifiedPosting[] = [];
  // Up to three board errors are kept as examples for error_detail.
  const errorSamples: string[] = [];
  // Infrastructure failures only; hallucinated URLs are rejections, not errors.
  let errorCount = 0;
  // Bounded concurrency; JS is single-threaded between awaits so pushing to shared arrays is safe.
  const gate = createSemaphore(BOARD_CONCURRENCY);
  // One task per board, all gated.
  await Promise.all([...byBoard.values()].map((board) =>
    // The semaphore slot is held for the whole verification of one board.
    gate.run(async () => {
      // Records an infrastructure failure against every URL that needed this board.
      const fail = (reason: string) => {
        // Counted once per board, not per URL, so one dead board is one error.
        errorCount += 1;
        // Keep a few samples for error_detail without unbounded growth.
        if (errorSamples.length < 3) errorSamples.push(`${board.provider}/${board.token}: ${reason}`);
        // Each URL still gets its own visible rejection.
        for (const w of board.wanted) rejected.push({ url: w.url, reason });
      };
      // No adapter would be a build mismatch, but refuse rather than crash.
      const adapter = getAdapter(board.provider);
      // Reporting through fail() keeps the accounting in one place.
      if (adapter === null) return fail("no_adapter");
      // Fetch seam (robots-gated in production). Never throws by contract, but guard anyway.
      let fetched: Awaited<ReturnType<FetchBoardFn>>;
      // Guard the seam: a fetch that throws must cost one board, not the run.
      try {
        // Robots check plus transport happen behind this seam in production.
        fetched = await deps.fetchBoard(board.provider, board.token);
      // Convert the throw into a reported failure.
      } catch (err) {
        // A throwing seam is an infrastructure failure for this board only.
        return fail(`board_fetch_threw: ${err instanceof Error ? err.message : String(err)}`);
      }
      // A refused or failed fetch (robots, 404, network) carries its own reason.
      if (!fetched.ok) return fail(fetched.reason);
      // The adapter's own parser decides what the board contains.
      const parsed = adapter.parse(fetched.payload);
      // An unparseable body is the board's problem, not a hallucination.
      if (!parsed.ok) return fail(`board_parse_failed: ${parsed.reason}`);
      // Exact-id lookup per wanted posting.
      for (const w of board.wanted) {
        // Ids compared case-insensitively because UUID case carries no meaning.
        const hit = parsed.postings.find((p) => p.atsJobId !== null && p.atsJobId.toLowerCase() === w.jobId.toLowerCase());
        // The model named a posting the live board does not have: hallucinated or expired.
        if (hit === undefined) {
          // The reason the UI shows for a hallucinated or already-expired posting.
          rejected.push({ url: w.url, reason: "not_in_live_board" });
          // Nothing to verify, move on to the next wanted id.
          continue;
        }
        // Two URLs for one posting (e.g. the /apply variant) collapse to one verified row.
        if (verified.some((v) => v.adapter === adapter && v.posting.atsJobId === hit.atsJobId)) continue;
        // Keep the BOARD's record; the URL contributed only the id we looked up.
        verified.push({ parsedUrl: { provider: board.provider, token: board.token, jobId: w.jobId }, adapter, posting: hit });
      }
    })
  ));
  // Counts are what the HTTP contract and agent_runs report.
  return { proposed: candidates.length, verified, rejected, errorCount, errorSamples, boardsAttempted: byBoard.size };
}

// The ONLY status an applications row may be inserted at here. INSERT bypasses the status
// guard (it is BEFORE UPDATE only), so this literal constant is the control; no caller
// input can reach it.
export const INSERT_STATUS = "discovered" as const;

// Application rows for already-persisted job ids, mirroring scout-ats's unscreened shape.
export function buildApplicationRows(
  // Ids of jobs rows that exist (new or pre-existing) after the jobs upsert.
  jobIds: readonly string[],
// Rows shaped exactly like scout-ats's unscreened fallback, with the status type pinned to the literal.
): { job_id: string; status: typeof INSERT_STATUS; drop_reason: null }[] {
  // Same shape scout-ats writes on its unscreened fallback; status is never a parameter.
  return jobIds.map((job_id) => ({ job_id, status: INSERT_STATUS, drop_reason: null }));
}

// Lower-case, hyphen-separated slug from a board token, for the company blocklist join.
export function slugFromToken(token: string): string {
  // Tokens are already [A-Za-z0-9_-]; this only normalises case and underscores.
  return token.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

// Thrown by the search seam when no Gemini key can be claimed because every key is cooling
// or system_settings.gemini_daily_call_budget is spent. A class, not a reason string, so the
// handler tells it apart with instanceof rather than by matching message text.
// WHY IT IS SEPARATE FROM A FAILURE: the pool treats quota exhaustion as normal and
// self-healing (_shared/gemini/pool.ts). Recording it as 'failed' would make the health page
// cry wolf every time the budget did its job. agent_run_status has 'skipped_quota' for this.
export class QuotaExhaustedError extends Error {
  // A fixed message: there is no detail to carry, and inventing one would read as an error.
  constructor() {
    // The text the run detail and the log show.
    super("all_keys_cooling_or_daily_budget_spent");
    // Shows in stack traces, so a log reader knows the class without reading the message.
    this.name = "QuotaExhaustedError";
  }
}

// A watchlist row's naming facts for one board, when the user already tracks it.
export interface WatchlistName {
  // The human-entered employer name scout-ats uses for the same board.
  readonly companyName: string;
  // The slug the blocklist and weekly cap join on.
  readonly companySlug: string;
}

// Key for watchlist lookups. Provider is part of it because tokens are not unique across ATSes.
export function boardKey(provider: string, token: string): string {
  // Same shape discover() groups boards by, so the two can never disagree.
  return `${provider}:${token}`;
}

// The employer name and slug a jobs row gets. ORDER MATTERS because the name feeds the
// fingerprint (_shared/ats/registry.ts passes companyName into jobFingerprint):
//   1. the watchlist row: byte-identical to what scout-ats writes for this board, so the same
//      posting found by both scouts fingerprints once and dedupes, instead of becoming two jobs;
//   2. the board's own company_name field, when its payload carries one;
//   3. the board token, the only name left, as before this change.
export function companyFor(
  // The watchlist row for this board, or null when the user does not track it.
  watch: WatchlistName | null,
  // The board's raw JSON for this posting. Untrusted, so it is read by shape.
  rawPayload: unknown,
  // The URL's board token, already charset-validated by urls.ts.
  token: string,
// Both values the jobs row needs.
): WatchlistName {
  // A tracked board wins outright, slug included, so blocklist joins match scout-ats rows.
  if (watch !== null) return watch;
  // Board payloads are objects. Anything else simply has no name to offer.
  const raw = typeof rawPayload === "object" && rawPayload !== null ? (rawPayload as Record<string, unknown>)["company_name"] : undefined;
  // Board-supplied text must be a non-blank string, capped so a hostile payload cannot put a
  // novel in the company column.
  const named = typeof raw === "string" && raw.trim() !== "" && raw.trim().length <= 200 ? raw.trim() : null;
  // The slug stays token-derived either way: it is the URL slug, which is what the blocklist keys on.
  return { companyName: named ?? token, companySlug: slugFromToken(token) };
}

// Honest agent_runs verdict. 'failed' whenever nothing the run attempted worked.
export function runOutcome(args: {
  // True when the Gemini call itself failed.
  readonly searchFailed: boolean;
  // Boards we tried to verify.
  readonly boardsAttempted: number;
  // Boards whose fetch or parse failed.
  readonly boardErrors: number;
  // Example failure strings, for error_detail.
  readonly errorSamples: readonly string[];
  // Database write failures, collected rather than thrown.
  readonly persistErrors: readonly string[];
  // How many postings were available to save.
  readonly verified: number;
  // How many applications rows were actually created.
  readonly inserted: number;
// The pieces agent_runs needs, so the handler never derives them ad hoc.
}): { status: "succeeded" | "failed"; errorCount: number; errorDetail: string | null } {
  // Every kind of failure counts toward error_count.
  const errorCount = args.boardErrors + args.persistErrors.length + (args.searchFailed ? 1 : 0);
  // Total failure: search died, every board errored, or verified rows could not be saved.
  const allFailed = args.searchFailed ||
    // Every board failing means nothing could be checked, which is not success.
    (args.boardsAttempted > 0 && args.boardErrors >= args.boardsAttempted) ||
    // Verified rows that all failed to save mean the run produced nothing it set out to.
    (args.verified > 0 && args.inserted === 0 && args.persistErrors.length > 0);
  // Specifics, so the health page says WHAT failed and not just that something did.
  const detail = [...args.errorSamples, ...args.persistErrors, ...(args.searchFailed ? ["search_failed"] : [])]
    // Pipe-joined so one text column carries every cause.
    .join(" | ");
  // error_detail is non-null whenever anything failed, so a green row never hides a red count.
  return {
    // Derived from the facts above, never defaulted to succeeded.
    status: allFailed ? "failed" : "succeeded",
    // Total failures, matching what error_detail describes.
    errorCount,
    // Non-null whenever anything failed, so a green status never hides a red count.
    errorDetail: errorCount > 0 ? (detail === "" ? `${errorCount} error(s), no detail captured` : detail) : null,
  };
}
