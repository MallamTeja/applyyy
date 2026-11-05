// job-link-intake — the human pastes ONE job link (a careers page, a LinkedIn/X post, an ATS
// posting) and the job enters the pipeline at `passed_filters`, skipping every filter.
//
// WHY IT SKIPS THE FILTERS: the filters exist to choose among thousands of scouted jobs on the
// human's behalf. A pasted link IS the human's choice (Teja, 2026-10-31: "no more filter"), so
// the screener, the matcher's pre-gate and its score floor all stand aside for it. The marker
// that tells them so is `jobs.discovered_via` containing 'manual', an enum value that has
// existed since 20260909234500_enums.sql for exactly this ("A human pasted a URL").
// WHAT IT DOES NOT SKIP: the human approval gate. The row stops at awaiting_approval like any other.
//
// Split from index.ts because index.ts calls Deno.serve at import, which `node --test` cannot
// import; every decision lives here behind injected seams.

// Gate 1 (the caller is the app user) and gate 2 (the kill switch), shared with every agent.
import { authorizeCaller, readKillSwitch, type CallerAuthClient, type KillSwitchClient } from "../_shared/db/gates.ts";
// CORS on every exit path, so the browser can read refusals too.
import { corsHeaders } from "../_shared/cors.ts";
// Board adapters: the ATS path builds rows from the board's own data, never the model's.
import { getAdapter, toJobInsert } from "../_shared/ats/registry.ts";
// The one fingerprint every source uses, so a pasted job dedupes against scouted ones.
import { jobFingerprint } from "../_shared/normalize/fingerprint.ts";
// Picks a trusted ATS apply link out of a social post, else falls back to the pasted URL.
import { resolveApplyUrl } from "../_shared/scout/apply-url.ts";
// Row and enum types shared with the DB contract.
import type { ApplicationStatus, JobInsert } from "../_shared/contracts/shared-types.ts";
// The Gemini outcome union, so the handler maps quota/upstream the way scout-web does.
import type { GeminiCallOutcome, GeminiResponseBody } from "../_shared/gemini/client.ts";
// scout-web's strict ATS-URL shape check, URL miner and board-name helpers: reused, not copied.
import { extractUrls, parseJobUrl, type ParsedJobUrl } from "../scout-web/urls.ts";
// Same naming rule scout-web uses, so a pasted ATS job fingerprints like the scouted copy.
import { companyFor, slugFromToken, type FetchBoardFn, type WatchlistName } from "../scout-web/core.ts";
// The URL rule shared by the pasted link and every redirect hop (SSRF guard).
import { checkPublicUrl } from "./fetch-page.ts";
// Page-to-text, the prompt, and the shape check on the model's answer.
import { buildExtractPrompt, MAX_SOURCE_CHARS, MIN_JOB_TEXT_CHARS, pageText, parseExtraction } from "./extract.ts";
// The readers past a plain fetch: LinkedIn's and X's public endpoints, and the browser render.
import { readSite, renderPage, type RenderFetch } from "./page-readers.ts";
// The pipeline engine's step tables (an import-free module), so "does this row need the chain" is
// the same rule the browser's Send button uses; a local copy would drift from it. Imported from
// _shared, never from apps/web (audit W26: import-graph.test.ts pins it).
import { PASSED_FILTERS_STEPS, STEP_INPUT_STATUS } from "../_shared/pipeline/row-pipeline.ts";

// Longest URL accepted: far above any real job link, low enough that the body stays tiny.
const MAX_URL_CHARS = 2_000;
// Longest pasted text accepted before trimming to MAX_SOURCE_CHARS: refuses an accidental megabyte paste.
const MAX_TEXT_CHARS = 100_000;

// Statuses a pasted link pulls back into the pipeline, as the human (migration 20261031200000
// adds the first three human edges into passed_filters). Every other status is left alone: rows
// already moving forward need nothing, and rows at awaiting_approval or later must not be reset.
// 'failed' since 2026-11-02 (Teja: a pasted link must RESTART a failed job). Its edge comes from
// migration 20261102203000, whose trigger guard_failed_rerun refuses a row that failed at or after
// approval (it may already have been submitted). That refusal is answered as cannot_restart, never
// as a 500 (restartRefusal below). Until that migration is live the graph guard refuses the edge
// itself, and that takes the same path.
export const REVIVE_FROM: readonly ApplicationStatus[] = ["discovered", "deduped", "dropped_filter", "failed"];

// The phrase guard_failed_rerun's exception carries (migration 20261102203000). Matched positively, so
// a refusal that does NOT say it is never worded as "failed after approval" (§6: no claimed cause).
const FAILED_AFTER_APPROVAL = /failed at or after approval/;

// The message the human sees when a paste cannot restart a failed row. Takes the database's refusal.
function restartRefusal(moveError: string): string {
  // The trigger's own reason: the row may already have been submitted, so it is checked by hand.
  if (FAILED_AFTER_APPROVAL.test(moveError)) return "This job failed after approval, so a pasted link cannot restart it: it may already have been submitted. Check it by hand.";
  // Any other refusal (e.g. the restart edge is not live yet): said as it is, with the reason.
  return `This failed job could not be restarted from a pasted link: ${moveError}`;
}

// True when matcher, tailor or auditor still has work on a row in this status. awaiting_approval
// and later match no step, so a re-pasted link never re-runs agents on a finished row.
export function needsChain(status: string): boolean {
  // Any step whose input status this is.
  return PASSED_FILTERS_STEPS.some((step) => STEP_INPUT_STATUS[step].includes(status));
}

// What the store hands back about the job row after the upsert.
export interface StoredJob {
  // jobs.id, for the applications row.
  readonly id: string;
  // Current sources; 'manual' missing means this posting was scouted first and must be tagged.
  readonly discoveredVia: readonly string[];
  // Non-null when a board stopped listing it; the tailor skips such rows, so a paste clears it.
  readonly disappearedAt: string | null;
  // The stored description (W3, 2026-11-01): a scouted row can have none (every live
  // SmartRecruiters row), and a paste that carries one must be able to fill it.
  readonly descriptionRaw: string | null;
}

// What the store hands back about the application row.
export interface StoredApplication {
  // applications.id, which the server then runs matcher -> tailor -> auditor on (Connection.runPipeline).
  readonly id: string;
  // Where the row stands now.
  readonly status: ApplicationStatus;
  // True only when this request created it.
  readonly created: boolean;
  // applications.drop_reason: the screener's or matcher's code for a dropped row, else null.
  // Read so a paste can say WHY a row was dropped before reviving it (leak 2, 2026-11-05).
  readonly dropReason: string | null;
}

// Every DB effect, implemented in index.ts over the signed-in client. Values, never throws.
export interface IntakeStore {
  // The user's own name for a tracked board, so fingerprints match scout-ats rows.
  watchlistName(provider: string, token: string): Promise<{ ok: true; name: WatchlistName | null } | { ok: false; reason: string }>;
  // Insert-if-absent on (user_id, fingerprint), then read the row back either way.
  upsertJob(row: JobInsert): Promise<{ ok: true; job: StoredJob } | { ok: false; reason: string }>;
  // Add 'manual' to discovered_via and clear disappeared_at, on a row that already existed.
  // `descriptionRaw` (W3) also replaces the stored description when non-null; null leaves it
  // untouched. REQUIRED, so a store cannot quietly drop the fill the handler decided on.
  tagManual(jobId: string, discoveredVia: readonly string[], descriptionRaw: string | null): Promise<string | null>;
  // Insert-if-absent at passed_filters on (user_id, job_id), then read the row back either way.
  upsertApplication(jobId: string): Promise<{ ok: true; application: StoredApplication } | { ok: false; reason: string }>;
  // advance_application_status(id, 'passed_filters', 'human', detail). Null on success.
  moveToPassedFilters(applicationId: string, detail: Record<string, unknown>): Promise<string | null>;
}

// What connect() yields: the signed-in client (for the gates and Gemini) and the store.
export type Connection =
  // Signed in as the app user.
  | {
      readonly ok: true;
      // The app user's id, for the caller check.
      readonly userId: string;
      // The signed-in client, for the gates and Gemini.
      readonly db: CallerAuthClient & KillSwitchClient;
      // Every write.
      readonly store: IntakeStore;
      // Starts matcher -> tailor -> auditor for one row on the SERVER, after the response is sent
      // (Teja, 2026-11-01: a pasted job runs through the pipeline with no button press). Never
      // awaited and never throws, so the outcome of the run can never change this response.
      readonly runPipeline: (applicationId: string) => void;
    }
  // Sign-in failed; the reason is logged, never returned.
  | { readonly ok: false; readonly reason: string };

// Everything impure, injected.
export interface IntakeDeps {
  // Signs in per request (isolates are stateless).
  connect(): Promise<Connection>;
  // Robots-gated whole-board fetch (scout-web's), for the ATS path.
  readonly fetchBoard: FetchBoardFn;
  // SSRF-guarded page fetch for the pasted link, its redirect hops and the site adapters' public
  // endpoints. Robots NOT checked: a pasted link is a user-triggered fetch (Teja, 2026-11-01;
  // index.ts carries the ruling where the check used to be). Never throws.
  fetchPage(url: string): Promise<{ ok: true; html: string } | { ok: false; reason: string }>;
  // The POST to the browser render service (page-readers.ts renderPage builds and checks it).
  readonly renderFetch: RenderFetch;
  // One JSON-mode Gemini call with the prompt from buildExtractPrompt.
  extract(db: unknown, prompt: ReturnType<typeof buildExtractPrompt>): Promise<GeminiCallOutcome<GeminiResponseBody>>;
  // The clock, injected so timestamps are testable.
  now(): Date;
}

// JSON + CORS on every exit, so no path can forget either.
function json(status: number, body: Record<string, unknown>): Response {
  // One place builds every response.
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", ...corsHeaders } });
}

// The validated request.
interface IntakeRequest {
  // The pasted link, trimmed, https, no userinfo/port, not an IP literal.
  readonly url: URL;
  // The pasted job text, trimmed; null when absent or blank.
  readonly text: string | null;
  // True only when the human saw why the row was dropped and chose "add anyway" (leak 2).
  readonly confirmRevive: boolean;
}

// Shape-check the body. Returns the message the UI shows verbatim on a refusal.
export function parseIntakeBody(raw: unknown): { ok: true; value: IntakeRequest } | { ok: false; message: string } {
  // Must be a plain JSON object.
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { ok: false, message: "body must be a JSON object" };
  // Loose view; each field checked below.
  const b = raw as Record<string, unknown>;
  // The link is required and bounded.
  if (typeof b["url"] !== "string" || b["url"].trim() === "" || b["url"].length > MAX_URL_CHARS) return { ok: false, message: "url is required (a link of at most 2000 characters)" };
  // Text is optional but, when present, a bounded string.
  if (b["text"] !== undefined && b["text"] !== null && (typeof b["text"] !== "string" || b["text"].length > MAX_TEXT_CHARS)) return { ok: false, message: "text must be a string of at most 100000 characters" };
  // new URL only splits the string; the checks below are the verdict.
  let url: URL;
  // A parse failure is the answer.
  try {
    // Trimmed so a pasted trailing space is not a different URL.
    url = new URL(b["url"].trim());
  } catch {
    // Not a URL at all.
    return { ok: false, message: "That is not a link. Paste the full https:// address." };
  }
  // https, no userinfo/port, no private name or bare IP: the same check every redirect hop gets.
  const refused = checkPublicUrl(url);
  // The message is written for the UI.
  if (refused !== null) return { ok: false, message: refused };
  // Blank text is absence.
  const text = typeof b["text"] === "string" && b["text"].trim() !== "" ? b["text"].trim() : null;
  // Validated. The confirm is the boolean true and nothing else: "true" or 1 is not a human's
  // decision to override a screener drop (CLAUDE.md §6).
  return { ok: true, value: { url, text, confirmRevive: b["confirm_revive"] === true } };
}

// The ATS posting this request points at: the link itself, else exactly ONE ATS posting link in
// the pasted text (a post listing several jobs is ambiguous, so it falls to the page path).
export function atsTarget(url: URL, text: string | null): ParsedJobUrl | null {
  // The pasted link wins.
  const direct = parseJobUrl(url.toString());
  // A board posting link: done.
  if (direct.ok) return direct.parsed;
  // No text, nothing else to look at.
  if (text === null) return null;
  // Every ATS posting link in the post, de-duplicated by provider/token/id.
  const found = new Map<string, ParsedJobUrl>();
  // extractUrls nominates; parseJobUrl decides.
  for (const candidate of extractUrls(text)) {
    // The same strict check as the direct link.
    const p = parseJobUrl(candidate);
    // Keyed so /apply and the posting page collapse to one.
    if (p.ok) found.set(`${p.parsed.provider}:${p.parsed.token}:${p.parsed.jobId.toLowerCase()}`, p.parsed);
  }
  // Exactly one is unambiguous; zero or several is not.
  return found.size === 1 ? [...found.values()][0] ?? null : null;
}

// A refusal the UI shows, with the HTTP status that fits it.
type Refusal = { readonly httpStatus: number; readonly body: Record<string, unknown> };
// A row ready to persist, plus where its data came from (shown to the human).
type Built = { readonly row: JobInsert; readonly source: "ats_board" | "page" | "pasted_text" };

// The ATS path: find the posting on the live board and build the row from the board's data.
// `pastedText` (W3): the human's text, used only when the board itself has no description.
// Null when the board itself could not be read or parsed: the caller then reads the pasted link
// through the page ladder instead (Teja, 2026-11-01), so a board outage no longer ends the request.
async function buildFromBoard(target: ParsedJobUrl, deps: IntakeDeps, store: IntakeStore, now: Date, pastedText: string | null): Promise<Built | Refusal | null> {
  // The adapter owns the board URL and parser.
  const adapter = getAdapter(target.provider);
  // Unreachable unless the registry and urls.ts disagree; refuse rather than guess.
  if (adapter === null) return { httpStatus: 500, body: { status: "error", message: `no adapter for ${target.provider}` } };
  // Robots-gated (the board API stays strict: the ruling covers only the pasted page), never throws.
  const fetched = await deps.fetchBoard(target.provider, target.token);
  // Robots refusal, dead board or network: logged for the operator, then the page ladder tries.
  if (!fetched.ok) {
    // The reason survives in the function logs; the human sees the page ladder's outcome.
    console.warn(`[job-link-intake] board_unreadable ${target.provider}/${target.token}: ${fetched.reason}`);
    // Fall through to the page path.
    return null;
  }
  // The adapter's own parser.
  const parsed = adapter.parse(fetched.payload);
  // A board we cannot parse cannot vouch for the posting, but the page itself may still say it.
  if (!parsed.ok) {
    // Same as above: logged, then the page ladder.
    console.warn(`[job-link-intake] board_unparseable ${target.provider}/${target.token}: ${parsed.reason}`);
    // Fall through to the page path.
    return null;
  }
  // Exact id match; UUID case carries no meaning.
  const posting = parsed.postings.find((p) => p.atsJobId !== null && p.atsJobId.toLowerCase() === target.jobId.toLowerCase());
  // The board no longer lists it: closed or never real. Nothing to apply to.
  if (posting === undefined) return { httpStatus: 422, body: { status: "posting_closed", message: "That posting is no longer on the company's board, so it is probably closed." } };
  // The user's own name for this board, when tracked.
  const watch = await store.watchlistName(target.provider, target.token);
  // A failed read must not silently produce a different fingerprint than scout-ats would.
  if (!watch.ok) return { httpStatus: 503, body: { status: "error", message: `watchlist read failed: ${watch.reason}` } };
  // Watchlist name, else the board's, else the token (scout-web's rule).
  const company = companyFor(watch.name, posting.rawPayload, target.token);
  // The shared row builder; isFirstPollOfBoard false because a human vouches the posting is current.
  const row = await toJobInsert(posting, adapter, { companyName: company.companyName, companySlug: company.companySlug, now, firstSeenAt: now, isFirstPollOfBoard: false });
  // W3 (2026-11-01): a board with no description (every SmartRecruiters posting: its list
  // endpoint carries none) takes the human's pasted text, by the page path's own rule (long
  // enough to be a description, capped). A board that HAS one keeps it: the tailor must read
  // what the employer wrote, not the post around the link.
  const pastedDescription = (row.description_raw ?? "").trim() === "" && pastedText !== null && pastedText.length >= MIN_JOB_TEXT_CHARS ? pastedText.slice(0, MAX_SOURCE_CHARS) : null;
  // Found by a human, whatever board hosts it: this tag is what the matcher's bypass reads.
  // The pasted description rides along only when the board had none; every other field is the board's.
  return { row: { ...row, discovered_via: ["manual"], ...(pastedDescription !== null ? { description_raw: pastedDescription } : {}) }, source: "ats_board" };
}

// How a link's text was read: the site's public endpoint, a plain fetch, or the browser. Kept in
// source_refs metadata. The response's `source` stays 'page' for all three: its closed union is a
// contract the web panel (parseIntakeOk) and ingest-links.yml both parse.
type ReadVia = "site" | "plain" | "render";

// The reading ladder (Teja, 2026-11-01: a link is read from the link alone, no pasted text): the
// site's public endpoint, then ONE plain fetch, then ONE browser render. Each rung's failure is
// kept, so the final refusal says what every rung hit.
async function readLink(url: URL, deps: IntakeDeps, authorization: string): Promise<{ ok: true; text: string; via: ReadVia } | { ok: false; reason: string }> {
  // Why each rung fell short, in order.
  const reasons: string[] = [];
  // b. A LinkedIn job or an X post through its public endpoint; null for every other site.
  const site = await readSite(url, deps.fetchPage);
  // Enough text from the adapter is the answer.
  if (site !== null && site.ok && site.text.length >= MIN_JOB_TEXT_CHARS) return { ok: true, text: site.text, via: "site" };
  // Recorded only when an adapter claimed the link.
  if (site !== null) reasons.push(site.ok ? "the site's public page had almost no text" : site.reason);
  // c. One plain fetch, robots not checked (see IntakeDeps.fetchPage).
  const page = await deps.fetchPage(url.toString());
  // Markup to readable text; a failed fetch has none.
  const plain = page.ok ? pageText(page.html) : null;
  // Enough text: the common case for an ordinary careers page.
  if (plain !== null && plain.length >= MIN_JOB_TEXT_CHARS) return { ok: true, text: plain, via: "plain" };
  // A login wall or a JS shell reads as almost nothing.
  reasons.push(page.ok ? "almost no readable text (it may need a login or JavaScript)" : page.reason);
  // d. The browser, once: it runs the page's scripts that a plain fetch cannot.
  const shown = await renderPage(url.toString(), authorization, deps.renderFetch);
  // Enough visible text once the scripts ran.
  if (shown.ok && shown.text.length >= MIN_JOB_TEXT_CHARS) return { ok: true, text: shown.text, via: "render" };
  // The browser's own shortfall.
  reasons.push(shown.ok ? "the browser saw almost no text either" : shown.reason);
  // f. Every rung fell short.
  return { ok: false, reason: reasons.join("; ") };
}

// True when the model read the text and said it is not one job posting.
function saysNotAJob(outcome: GeminiCallOutcome<GeminiResponseBody>): boolean {
  // A failed call said nothing about the page.
  if (!outcome.ok) return false;
  // The same shape check the row is built from, so "not a job" means exactly one thing.
  const verdict = parseExtraction(outcome.data.candidates?.[0]?.content?.parts?.[0]?.text);
  // Only the model's own refusal counts; a malformed answer is a defect, not a verdict.
  return !verdict.ok && verdict.reason === "not_a_job_posting";
}

// The page path: pasted text when given, else the reading ladder; then Gemini, then the shape check.
// Caps per request: at most ONE render and TWO Gemini calls.
// ponytail: no wall-clock guard. Worst case (plain fetch, a slow "not a job" extract, a 60 s
// render, a second extract) can approach the 150 s kill; add a deadline check before step e if
// function logs ever show this request timing out.
async function buildFromPage(req: IntakeRequest, deps: IntakeDeps, db: unknown, now: Date, authorization: string): Promise<Built | Refusal> {
  // a. Pasted text long enough to be a description is used as-is: no fetch needed (ingest-links.yml
  // still sends text for its listed links).
  const pasted = req.text !== null && req.text.length >= MIN_JOB_TEXT_CHARS ? req.text.slice(0, MAX_SOURCE_CHARS) : null;
  // Where the text came from, for the response.
  const source: Built["source"] = pasted !== null ? "pasted_text" : "page";
  // b-d. No usable paste: read the link.
  const read = pasted !== null ? { ok: true as const, text: pasted, via: null } : await readLink(req.url, deps, authorization);
  // f. Every rung failed. The UI has no paste box any more, so the message never asks for one.
  if (!read.ok) return { httpStatus: 422, body: { status: "needs_text", message: `Could not read that page, even with a browser (${read.reason}).` } };
  // The description the matcher and tailor will read.
  let text = read.text;
  // How it was read (null for pasted text), recorded on the row.
  let via: ReadVia | null = read.via;
  // One Gemini call, JSON mode.
  let outcome = await deps.extract(db, buildExtractPrompt(text, req.url.toString()));
  // e. A plain-fetched page the model calls "not a job" may be a JS shell around the posting (3 of
  // 21 links in CI ingest run 41294502085): render it ONCE and ask ONCE more. Only plain-fetched
  // text qualifies: rendered text already had its browser, and pasted or adapter text is not a shell.
  if (via === "plain" && saysNotAJob(outcome)) {
    // The only render on this branch: readLink returns "plain" only when it did not render.
    const shown = await renderPage(req.url.toString(), authorization, deps.renderFetch);
    // A failed or empty render leaves the first verdict standing.
    if (shown.ok && shown.text.length >= MIN_JOB_TEXT_CHARS) {
      // The rendered text replaces the shell's.
      text = shown.text;
      // Recorded honestly.
      via = "render";
      // The second and last Gemini call.
      outcome = await deps.extract(db, buildExtractPrompt(text, req.url.toString()));
    }
  }
  // Budget spent or every key cooling: normal quota behaviour, not a failure.
  if (!outcome.ok && outcome.reason === "all_keys_cooling") return { httpStatus: 429, body: { status: "quota", message: "Daily Gemini budget used up; try again later." } };
  // Gemini overloaded: heals on its own.
  if (!outcome.ok && outcome.reason === "upstream_unavailable") return { httpStatus: 503, body: { status: "upstream_unavailable", message: "Gemini is overloaded right now; try again in a few minutes." } };
  // Any other model failure, named.
  if (!outcome.ok) return { httpStatus: 502, body: { status: "error", message: `Reading the job failed: ${outcome.reason}` } };
  // The shape check decides; the model's words never reach the row unchecked.
  const verdict = parseExtraction(outcome.data.candidates?.[0]?.content?.parts?.[0]?.text);
  // The model says this is not one job. No paste box exists any more, so the remedy is a better link.
  if (!verdict.ok && verdict.reason === "not_a_job_posting") return { httpStatus: 422, body: { status: "not_a_job", message: "That does not look like a single job posting. Try the link to the job's own page instead." } };
  // Malformed answer: a defect, reported.
  if (!verdict.ok) return { httpStatus: 502, body: { status: "error", message: `Reading the job failed: ${verdict.reason}` } };
  // The validated fields.
  const job = verdict.job;
  // A trusted ATS link inside the post beats the post's own permalink as the place to apply.
  const apply = resolveApplyUrl({ structuredUrl: req.url.toString(), postText: text, fallbackUrl: req.url.toString() });
  // Same fingerprint rule as every scout, so a later scouted copy dedupes against this one.
  const fingerprint = await jobFingerprint({ company: job.companyName, title: job.title, location: job.locationRaw ?? undefined });
  // The run clock, once.
  const at = now.toISOString();
  // The row. ats_provider 'unknown': no Playwright adapter is claimed for an arbitrary page.
  const row: JobInsert = {
    // Dedupe key.
    fingerprint,
    // Model-copied, shape-checked, still UNTRUSTED.
    title: job.title,
    // Same.
    company_name: job.companyName,
    // Same slug rule scout-web uses for an untracked company.
    company_slug: slugFromToken(job.companyName),
    // Verbatim location text, or null.
    location_raw: job.locationRaw,
    // Left empty for the Normalizer, as every scout does.
    locations: [],
    // Closed enum, checked.
    work_arrangement: job.workArrangement,
    // Closed enum, checked.
    employment_type: job.employmentType,
    // The source text itself, not a model summary: the tailor must read what the employer wrote.
    description_raw: text,
    // A trusted ATS link from the post, else the pasted link. A LinkedIn permalink here never
    // auto-submits: the worker's robots gate refuses linkedin.com and parks the row for a human.
    apply_url: apply.url,
    // No adapter claimed.
    ats_provider: "unknown",
    // No board id.
    ats_job_id: null,
    // The tag the matcher's bypass reads.
    discovered_via: ["manual"],
    // The sighting, so the row says where it came from; read_via says which ladder rung read it.
    source_refs: [{ provider: "manual", url: req.url.toString(), ats_job_id: null, first_seen_at: at, last_seen_at: at, metadata: { type: source, read_via: via, apply_url_reason: apply.reason } }],
    // No posting date on an arbitrary page: today, marked as derived.
    posted_at: at,
    // `derived` = fell back to first sighting (never `unknown`, which means cold-start only).
    posted_at_source: "derived",
  };
  // Built.
  return { row, source };
}

// The pasted description when it says more than the stored one, else null (leave the stored
// one alone). Measured trimmed, so whitespace padding never wins, and a blank paste never
// replaces anything (§6: absence must not become an answer, here a wiped description).
function richerDescription(stored: string | null, pasted: string | null): string | null {
  // Nothing pasted, or only whitespace: nothing to fill with.
  if (pasted === null || pasted.trim() === "") return null;
  // No stored text, or less of it: the paste fills the gap. Otherwise the scouted text stays.
  return stored === null || stored.trim().length < pasted.trim().length ? pasted : null;
}

// Persist the row and make sure its application sits where the pipeline can carry it.
// confirmRevive is REQUIRED, so no caller can revive a dropped row by forgetting to ask.
export async function persistManualJob(store: IntakeStore, row: JobInsert, pastedUrl: string, confirmRevive: boolean): Promise<
  | { ok: true; application: StoredApplication; revivedFrom: ApplicationStatus | null }
  | { ok: false; reason: string }
  // A row the screener or matcher dropped, pasted without the human's confirm: nothing moved.
  // dropReason is the stored code, or null when none was stored (still asked: no reason stored
  // is not evidence the drop was harmless).
  | { ok: false; confirmNeeded: true; dropReason: string | null }
  // A failed row the database would not move: a refusal to report as such, not a failed write.
  // The job row (and any description it gained) is already saved by then.
  | { ok: false; reason: string; restartRefused: true }
> {
  // Insert-if-absent, then read back.
  const job = await store.upsertJob(row);
  // No job row, nothing to queue.
  if (!job.ok) return job;
  // W3 (2026-11-01): the upsert ignores duplicates, so a scouted row with no description kept
  // none and the paste's text was discarded; the matcher and tailor then refused the row.
  // Null when the stored description already says as much or more.
  const fill = richerDescription(job.job.descriptionRaw, row.description_raw ?? null);
  // A posting first found by a scout carries no 'manual' tag, so the matcher would still gate it.
  // Also clears disappeared_at: a human pasting the link is evidence it is live again.
  // And fills a missing or shorter description, the only other column a paste may change.
  if (!job.job.discoveredVia.includes("manual") || job.job.disappearedAt !== null || fill !== null) {
    // Tag (and un-disappear, and fill) before the application moves, so the matcher reads them.
    const tagError = await store.tagManual(job.job.id, [...new Set([...job.job.discoveredVia, "manual"])], fill);
    // Untagged, the row would be filtered: stop rather than queue it half-done.
    if (tagError !== null) return { ok: false, reason: `jobs_tag_manual: ${tagError}` };
  }
  // Insert-if-absent at passed_filters, then read back.
  const app = await store.upsertApplication(job.job.id);
  // No application row, nothing to run.
  if (!app.ok) return app;
  // Already moving forward, or past the queue: leave it exactly where it is.
  if (!REVIVE_FROM.includes(app.application.status)) return { ok: true, application: app.application, revivedFrom: null };
  // LEAK 2 (2026-11-05): a screener/matcher drop is a verdict, and a paste used to overturn it
  // silently (Scale AI 461f9f6b, dropped work_auth 10-25, revived 11-01, approved 11-05). Ask
  // first. The manual tag above is already written by now; harmless at dropped_filter, and
  // moving it after this read would let a running matcher gate a NEW row before it is tagged.
  if (app.application.status === "dropped_filter" && !confirmRevive) return { ok: false, confirmNeeded: true, dropReason: app.application.dropReason ?? null };
  // Upstream or dropped: the human pulls it into passed_filters through the guarded RPC.
  const moveError = await store.moveToPassedFilters(app.application.id, {
    // Why it moved.
    reason: "pasted_link",
    // What was pasted.
    url: pastedUrl,
    // Where it came from.
    from: app.application.status,
    // The verdict the human overrode, on the event record; only for a confirmed drop revive.
    ...(app.application.status === "dropped_filter" ? { overrode_drop_reason: app.application.dropReason ?? null } : {}),
  });
  // A failed row the database refused (failed after approval, or the edge not live yet): reported
  // as a refusal the human can read. The tag and description write above already happened.
  if (moveError !== null && app.application.status === "failed") return { ok: false, reason: restartRefusal(moveError), restartRefused: true };
  // The guard refused (e.g. the migration is not applied): say so, never pretend it moved.
  if (moveError !== null) return { ok: false, reason: `advance_to_passed_filters: ${moveError}` };
  // Moved; the handler then starts matcher -> tailor -> auditor on it, server-side.
  return { ok: true, application: { ...app.application, status: "passed_filters" }, revivedFrom: app.application.status };
}

// The whole request.
export async function handleJobLinkIntake(req: Request, deps: IntakeDeps): Promise<Response> {
  // Browser preflight needs no credentials.
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  // POST only: a GET must never spend a fetch or a Gemini call.
  if (req.method !== "POST") return json(405, { status: "error", message: "method_not_allowed" });
  // Sign in as the app user.
  const conn = await deps.connect();
  // Without a client nothing can run; the reason goes to the log only.
  if (!conn.ok) {
    // Distinguishes "no such user" from "wrong password" for the operator, not the caller.
    console.error(`[job-link-intake] db_client_failed: ${conn.reason}`);
    // Generic to the caller.
    return json(500, { status: "error", message: "db_client_failed" });
  }
  // GATE 1: only the app user's own session.
  const caller = await authorizeCaller(req, conn.db, conn.userId);
  // 401 and 403 stay distinct.
  if (!caller.ok) return json(caller.status, { status: "unauthorized", message: caller.error });
  // The verified "Bearer <jwt>" header, forwarded to the render service so it acts as the caller.
  const authorization = req.headers.get("authorization");
  // Unreachable after gate 1 (it parsed this header), but never defaulted to "" (§6).
  if (authorization === null) return json(401, { status: "unauthorized", message: "missing_bearer_token" });
  // Body parsed only after auth, so anonymous callers cannot probe the validator.
  let raw: unknown;
  // Malformed JSON is the caller's error.
  try {
    // Read as JSON.
    raw = await req.json();
  } catch {
    // 400, named.
    return json(400, { status: "error", message: "body is not valid JSON" });
  }
  // Shape check.
  const parsed = parseIntakeBody(raw);
  // The message is written for the UI.
  if (!parsed.ok) return json(400, { status: "error", message: parsed.message });
  // GATE 2: the kill switch. Unreadable halts too.
  const kill = await readKillSwitch(conn.db);
  // Off: nothing is fetched, nothing written.
  if (kill.kind !== "enabled") return json(409, { status: "disabled", message: `The system is switched off (${kill.detail}).` });
  // One clock for the whole request.
  const now = deps.now();
  // The board posting this points at, if any.
  const target = atsTarget(parsed.value.url, parsed.value.text);
  // Board data when there is a board. The pasted text goes to the board path too, for a board
  // with no description (W3). Null: no board, or one that could not be read or parsed.
  const fromBoard = target !== null ? await buildFromBoard(target, deps, conn.store, now, parsed.value.text) : null;
  // Otherwise the page ladder: the pasted text, the site's public endpoint, the page, the browser.
  const built = fromBoard ?? (await buildFromPage(parsed.value, deps, conn.db, now, authorization));
  // Refusals carry their own status.
  if ("httpStatus" in built) return json(built.httpStatus, built.body);
  // Write it.
  const saved = await persistManualJob(conn.store, built.row, parsed.value.url.toString(), parsed.value.confirmRevive);
  // A dropped row pasted without the confirm: 409 with the reason, so the web asks "add anyway?".
  // The message says it in words too, so a browser that does not know this status still shows why.
  if (!saved.ok && "confirmNeeded" in saved) {
    // The posting's location, the usual cause of a work_auth drop; omitted when unknown.
    const where = built.row.location_raw ? ` Location: "${built.row.location_raw}".` : "";
    // Machine-readable reason beside the words; nothing was moved and no pipeline runs.
    return json(409, { status: "confirm_revive", drop_reason: saved.dropReason, message: `This job was dropped earlier (${saved.dropReason ?? "no reason stored"}).${where} Add it anyway?` });
  }
  // A failed job the paste may not restart: 409, the refusal in words, no pipeline run.
  if (!saved.ok && "restartRefused" in saved) return json(409, { status: "cannot_restart", message: saved.reason });
  // A failed write is reported, never a quiet success.
  if (!saved.ok) return json(503, { status: "error", message: `Saving the job failed: ${saved.reason}` });
  // Only a row the agents can still move gets a run; the decision is reported, never guessed by the browser.
  const pipelineStarted = needsChain(saved.application.status);
  // Started only after the row is saved, so the agents never race the write they read.
  if (pipelineStarted) conn.runPipeline(saved.application.id);
  // What the browser needs to follow the run and show the human what was added.
  return json(200, {
    // Envelope.
    status: "ok",
    // The row the server is running matcher -> tailor -> auditor on.
    application_id: saved.application.id,
    // True when that server run was started; false for a row already at the queue or later.
    pipeline_started: pipelineStarted,
    // Where it stands now (passed_filters for a new or revived row).
    application_status: saved.application.status,
    // True only for a brand-new application.
    created: saved.application.created,
    // The status it was pulled back from, or null.
    revived_from: saved.revivedFrom,
    // Where the fields came from.
    source: built.source,
    // What was added, for the confirmation line.
    job: { title: built.row.title, company_name: built.row.company_name, location_raw: built.row.location_raw ?? null, apply_url: built.row.apply_url },
  });
}
