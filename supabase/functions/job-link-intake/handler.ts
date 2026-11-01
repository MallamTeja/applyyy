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
// The web engine's step tables (an import-free module), so "does this row need the chain" is the
// same rule the browser's Send button uses; a local copy would drift from it.
import { PASSED_FILTERS_STEPS, STEP_INPUT_STATUS } from "../../../apps/web/src/features/pipeline/rowPipeline.ts";

// Longest URL accepted: far above any real job link, low enough that the body stays tiny.
const MAX_URL_CHARS = 2_000;
// Longest pasted text accepted before trimming to MAX_SOURCE_CHARS: refuses an accidental megabyte paste.
const MAX_TEXT_CHARS = 100_000;

// Statuses a pasted link pulls back into the pipeline, as the human (migration 20261031200000
// adds these three human edges into passed_filters). Every other status is left alone: rows
// already moving forward need nothing, and rows at awaiting_approval or later must not be reset.
export const REVIVE_FROM: readonly ApplicationStatus[] = ["discovered", "deduped", "dropped_filter"];

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
  // Robots-gated page fetch for every other link. Never throws.
  fetchPage(url: string): Promise<{ ok: true; html: string } | { ok: false; reason: string }>;
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
  // Validated.
  return { ok: true, value: { url, text } };
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
async function buildFromBoard(target: ParsedJobUrl, deps: IntakeDeps, store: IntakeStore, now: Date, pastedText: string | null): Promise<Built | Refusal> {
  // The adapter owns the board URL and parser.
  const adapter = getAdapter(target.provider);
  // Unreachable unless the registry and urls.ts disagree; refuse rather than guess.
  if (adapter === null) return { httpStatus: 500, body: { status: "error", message: `no adapter for ${target.provider}` } };
  // Robots-gated, never throws.
  const fetched = await deps.fetchBoard(target.provider, target.token);
  // Robots refusal, dead board or network: say which.
  if (!fetched.ok) return { httpStatus: 502, body: { status: "error", message: `Could not read the ${target.provider} board "${target.token}": ${fetched.reason}` } };
  // The adapter's own parser.
  const parsed = adapter.parse(fetched.payload);
  // A board we cannot parse cannot vouch for the posting.
  if (!parsed.ok) return { httpStatus: 502, body: { status: "error", message: `The ${target.provider} board could not be parsed: ${parsed.reason}` } };
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

// The page path: pasted text when given, else the fetched page; then Gemini, then the shape check.
async function buildFromPage(req: IntakeRequest, deps: IntakeDeps, db: unknown, now: Date): Promise<Built | Refusal> {
  // Pasted text long enough to be a description is used as-is: no fetch needed.
  const pasted = req.text !== null && req.text.length >= MIN_JOB_TEXT_CHARS ? req.text.slice(0, MAX_SOURCE_CHARS) : null;
  // Where the text came from, for the response.
  let source: Built["source"] = "pasted_text";
  // The description the matcher and tailor will read.
  let text = pasted;
  // No usable paste: read the page.
  if (text === null) {
    // Robots-gated; LinkedIn and most social sites refuse, which is the expected case for them.
    const page = await deps.fetchPage(req.url.toString());
    // The remedy is the same for every fetch failure: paste the text.
    if (!page.ok) return { httpStatus: 422, body: { status: "needs_text", message: `Could not read that page (${page.reason}). Paste the job description or post text and try again.` } };
    // Markup to readable text.
    text = pageText(page.html);
    // Marked as fetched.
    source = "page";
  }
  // A login wall or JS shell yields almost nothing readable.
  if (text === null || text.length < MIN_JOB_TEXT_CHARS) return { httpStatus: 422, body: { status: "needs_text", message: "That page has almost no readable text (it may need a login or JavaScript). Paste the job description or post text and try again." } };
  // One Gemini call, JSON mode.
  const outcome = await deps.extract(db, buildExtractPrompt(text, req.url.toString()));
  // Budget spent or every key cooling: normal quota behaviour, not a failure.
  if (!outcome.ok && outcome.reason === "all_keys_cooling") return { httpStatus: 429, body: { status: "quota", message: "Daily Gemini budget used up; try again later." } };
  // Gemini overloaded: heals on its own.
  if (!outcome.ok && outcome.reason === "upstream_unavailable") return { httpStatus: 503, body: { status: "upstream_unavailable", message: "Gemini is overloaded right now; try again in a few minutes." } };
  // Any other model failure, named.
  if (!outcome.ok) return { httpStatus: 502, body: { status: "error", message: `Reading the job failed: ${outcome.reason}` } };
  // The shape check decides; the model's words never reach the row unchecked.
  const verdict = parseExtraction(outcome.data.candidates?.[0]?.content?.parts?.[0]?.text);
  // The model says this is not one job.
  if (!verdict.ok && verdict.reason === "not_a_job_posting") return { httpStatus: 422, body: { status: "not_a_job", message: "That does not look like a single job posting. Paste the job's own link or its description." } };
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
    // The sighting, so the row says where it came from.
    source_refs: [{ provider: "manual", url: req.url.toString(), ats_job_id: null, first_seen_at: at, last_seen_at: at, metadata: { type: source, apply_url_reason: apply.reason } }],
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
export async function persistManualJob(store: IntakeStore, row: JobInsert, pastedUrl: string): Promise<
  | { ok: true; application: StoredApplication; revivedFrom: ApplicationStatus | null }
  | { ok: false; reason: string }
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
  // Upstream or dropped: the human pulls it into passed_filters through the guarded RPC.
  const moveError = await store.moveToPassedFilters(app.application.id, { reason: "pasted_link", url: pastedUrl, from: app.application.status });
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
  // Board data when there is a board; otherwise the page or the pasted text.
  // The pasted text goes to the board path too, for a board with no description (W3).
  const built = target !== null ? await buildFromBoard(target, deps, conn.store, now, parsed.value.text) : await buildFromPage(parsed.value, deps, conn.db, now);
  // Refusals carry their own status.
  if ("httpStatus" in built) return json(built.httpStatus, built.body);
  // Write it.
  const saved = await persistManualJob(conn.store, built.row, parsed.value.url.toString());
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
