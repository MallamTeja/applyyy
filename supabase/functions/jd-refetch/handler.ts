// jd-refetch: the decisions for ONE "No description" row, node-testable (index.ts plugs in the network
// and the database through the seams below, and runs Deno.serve on import, so it cannot be tested).
//
// WHY THIS EXISTS (S8, 2026-11-21). Teja, 2026-11-21 14:41 IST (quoted from the orchestrator handoff
// docs/handoff/2026-11-21-1455-orchestrator-handoff.md:55): "no-description jobs: Playwright confirm +
// read JD + tailor straight into the approval queue, on a cron." It is newer than, and written for exactly
// these rows, the 2026-11-18 21:45 ruling that scouted rows stop at Ready to tailor; that rule still holds
// for every OTHER scouted row (the orch's S8 ruling, 2026-11-21 ~18:40).
//
// A row is "No description" when its application sits at passed_filters and isThinDescription() says its
// job's description_raw has under 100 characters of role text (jd-substance.ts). There is no held status:
// the screener lets thin rows through at passed_filters (11-18) and the verdict is computed on read.
//
// The flow for one row, in order:
//   1. Liveness via the provider's public API (queue-liveness.ts / feed-liveness.ts). Only an explicit
//      "gone" closes; 0 form fields or a soft page is never "closed" (Ashby renders late).
//   2. Read the posting page, robots-gated (a scheduled bot obeys robots.txt). A robots 429/5xx is
//      "retry later", never a failure. Too little text falls back to the browser render service.
//   3. The new text must itself pass isThinDescription, or the row stays where it is, counted.
//   4. Write description_raw, then RE-SCREEN with the matcher's own pre-gate (tech, work-auth,
//      experience_ceiling) on the new JD. A drop stays a drop.
//   5. A pass runs matcher -> tailor -> auditor (the job-link-intake server pipeline) to awaiting_approval.
// Every status move goes through advance_application_status as `matcher` (the only machine agent the
// passed_filters -> failed / dropped_filter edges allow), on a client that carries the agent key.

// The one thin-description predicate the screener and the web both use; never a second copy.
import { isThinDescription } from "../_shared/screen/jd-substance.ts";
// The rung threshold job-link-intake uses: a page shorter than this is not a job description.
import { MIN_JOB_TEXT_CHARS, pageText } from "../job-link-intake/extract.ts";
// The render service's answer shape.
import type { ReadText } from "../job-link-intake/page-readers.ts";
// The liveness verdict the shared checkers return.
import type { PostingVerdict } from "../_shared/scout/queue-liveness.ts";
// The matcher's pre-gate input and outcome: the re-screen IS the matcher's own gate, not a copy.
import type { PreGateJob, PreGateOutcome } from "../matcher/tech-pregate.ts";
// The typed transport failures the page read classifies.
import { BotProtectionError, HttpError, RobotsDisallowedError } from "../_shared/http/index.ts";
// The robots "unknown" (429/5xx/wait) error: retry later, never a refusal. Not re-exported by index.ts.
import { RobotsUnavailableError } from "../_shared/http/robots-unavailable.ts";

// The facts about one candidate the flow reads. Built by index.ts from one applications+jobs select.
export interface Candidate {
  // applications.id.
  readonly applicationId: string;
  // jobs.id, for the description write.
  readonly jobId: string;
  // jobs.discovered_via: a row a human pasted is never re-gated by a bot (matcher skipGate does the same).
  readonly discoveredVia: readonly string[];
  // The gate's input, with the CURRENT (thin) description; the new text replaces it in step 4.
  readonly job: PreGateJob;
  // jobs.ats_provider, for the liveness check.
  readonly atsProvider: string;
  // jobs.ats_job_id.
  readonly atsJobId: string | null;
  // jobs.apply_url: the page that is read, and Workday's liveness endpoint is derived from it.
  readonly applyUrl: string | null;
  // The board token from company_watchlist, or null when untracked (then liveness is "unknown").
  readonly boardToken: string | null;
}

// The first row this call should work on, or null. Pure so the selection is pinned by tests.
export function pickCandidate(rows: readonly Candidate[], skipIds: ReadonlySet<string>): Candidate | null {
  // Oldest first is the caller's order; this only filters.
  for (const row of rows) {
    // Already tried in this workflow run: the run's loop moves on instead of retrying the same row.
    if (skipIds.has(row.applicationId)) continue;
    // A human-picked row is the human's call, not the bot's (matcher withTechPreGate skips it too).
    if (row.discoveredVia.includes("manual")) continue;
    // Only a row that is still thin: a description filled since the select is no longer this job's work.
    if (!isThinDescription(row.job.descriptionRaw)) continue;
    // The one row.
    return row;
  }
  // Nothing to do.
  return null;
}

// What one page read gives. Closed: every branch below maps to exactly one outcome.
export type JdRead =
  // Enough role text to replace the thin description.
  | { readonly kind: "text"; readonly text: string }
  // Read, but still too little text (or not readable at all): the row stays, counted.
  | { readonly kind: "thin"; readonly reason: string }
  // The site said "not now" (robots 429/5xx, HTTP 429/5xx): the row stays for a later run.
  | { readonly kind: "retry_later"; readonly reason: string }
  // The page itself answered 404 or 410: the posting is gone.
  | { readonly kind: "closed"; readonly reason: string };

// The page-read seams: the robots-gated GET and the browser render.
export interface PageIo {
  // The robots-gated page GET (httpText in production): HTML, null for a 404, a typed throw otherwise.
  getPage(url: string): Promise<string | null>;
  // The Vercel render service (renderPage). Only called AFTER getPage passed the robots gate.
  render(url: string): Promise<ReadText>;
}

// Enough real role text to count as a description: long enough for job-link-intake, and not thin.
function usable(text: string | null): text is string {
  // Both thresholds: the intake's 200 characters, and the screener's role-text check.
  return text !== null && text.length >= MIN_JOB_TEXT_CHARS && !isThinDescription(text);
}

// Read one posting page: plain GET first, then the render. Never throws.
export async function readJobDescription(url: string, io: PageIo): Promise<JdRead> {
  // The plain page, or why not.
  let html: string | null;
  try {
    // Robots is checked inside the transport BEFORE the site is contacted.
    html = await io.getPage(url);
  } catch (err) {
    // FIRST, before its parent class: robots.txt answered 429/5xx (Cloudflare) = retry later, never a fail.
    if (err instanceof RobotsUnavailableError) return { kind: "retry_later", reason: `robots_unavailable: ${err.message}` };
    // robots.txt disallows us: a bot does not read it, and the renderer (no robots check) must not either.
    if (err instanceof RobotsDisallowedError) return { kind: "thin", reason: `robots_disallowed: ${err.message}` };
    // A bot wall is not a robots rule: the browser render is the next rung, as job-link-intake does.
    if (err instanceof BotProtectionError) return await renderRung(url, io, "bot_protection");
    // The page's own "gone".
    if (err instanceof HttpError && (err.status === 404 || err.status === 410)) return { kind: "closed", reason: `page_${err.status}` };
    // Rate limit or a server error: the site is there, just not now.
    if (err instanceof HttpError && (err.status === 429 || err.status >= 500)) return { kind: "retry_later", reason: `http_${err.status}` };
    // Anything else (403, network, timeout): try the browser.
    return await renderRung(url, io, err instanceof Error ? err.message : String(err));
  }
  // notFound:"null" turns a 404 into null: gone.
  if (html === null) return { kind: "closed", reason: "page_404" };
  // The visible text plus any JobPosting JSON-LD.
  const text = pageText(html);
  // Enough text on the plain page: done, no render spent.
  if (usable(text)) return { kind: "text", text };
  // A client-rendered page (Workday, Ashby): the browser rung.
  return await renderRung(url, io, "plain_page_thin");
}

// The render rung: one render, then the same thresholds.
async function renderRung(url: string, io: PageIo, plainReason: string): Promise<JdRead> {
  // One render per row (the service's own budget is 45 s).
  const rendered = await io.render(url);
  // The render failed: still thin, with both reasons for the log.
  if (!rendered.ok) return { kind: "thin", reason: `${plainReason}; render: ${rendered.reason}` };
  // Rendered, and enough text.
  if (usable(rendered.text)) return { kind: "text", text: rendered.text };
  // Rendered, still too little.
  return { kind: "thin", reason: `${plainReason}; render_thin` };
}

// The database and pipeline seams. Every method returns values; none throws.
export interface RefetchDeps {
  // The provider API's verdict for this posting ("unknown" when there is no API or no token).
  liveness(row: Candidate): Promise<PostingVerdict>;
  // The page read above, bound to its IO.
  readJd(url: string): Promise<JdRead>;
  // passed_filters -> failed with reason posting_closed, as `matcher`, with the agent key. null = moved.
  closeRow(applicationId: string, evidence: string): Promise<string | null>;
  // jobs.description_raw (and tombstoned_at cleared). null = written.
  writeDescription(jobId: string, text: string): Promise<string | null>;
  // The matcher's own preGateRow: drop_reason write, then the stamp-guarded move to dropped_filter.
  preGate(applicationId: string, job: PreGateJob): Promise<PreGateOutcome>;
  // matcher -> tailor -> auditor in the background (job-link-intake startServerPipeline pattern).
  runPipeline(applicationId: string): void;
}

// What happened to the row. Closed: the workflow counts each kind.
export type RefetchOutcome =
  // The posting is gone: moved to failed (posting_closed).
  | { readonly kind: "closed"; readonly evidence: string }
  // Not now; nothing written.
  | { readonly kind: "retry_later"; readonly reason: string }
  // No usable JD yet; nothing written, the row stays at passed_filters.
  | { readonly kind: "still_thin"; readonly reason: string }
  // JD written; the re-screen dropped it.
  | { readonly kind: "dropped"; readonly code: string; readonly reason: string }
  // JD written, re-screen passed, pipeline started toward awaiting_approval.
  | { readonly kind: "pipeline_started" }
  // Another run moved or wrote the row first.
  | { readonly kind: "skipped_stale" }
  // A write or move failed; the row is left for the next run.
  | { readonly kind: "error"; readonly message: string };

// Close the row, as an outcome.
async function close(row: Candidate, deps: RefetchDeps, evidence: string): Promise<RefetchOutcome> {
  // The guarded move; its error is the row's error.
  const failed = await deps.closeRow(row.applicationId, evidence);
  // Moved, or why not.
  return failed === null ? { kind: "closed", evidence } : { kind: "error", message: `close: ${failed}` };
}

// The whole flow for one row.
export async function refetchOne(row: Candidate, deps: RefetchDeps): Promise<RefetchOutcome> {
  // Step 1: the provider's own answer. Only "closed" acts; "open" and "unknown" both go on to read.
  const verdict = await deps.liveness(row);
  // Gone by the API: no page read spent.
  if (verdict === "closed") return await close(row, deps, `ats_api_${row.atsProvider}`);
  // Nothing to read from.
  if (row.applyUrl === null) return { kind: "still_thin", reason: "no_apply_url" };
  // Step 2: the page.
  const read = await deps.readJd(row.applyUrl);
  // The page's own 404/410.
  if (read.kind === "closed") return await close(row, deps, read.reason);
  // Not now: untouched.
  if (read.kind === "retry_later") return { kind: "retry_later", reason: read.reason };
  // Step 3: still no JD, untouched and counted.
  if (read.kind === "thin") return { kind: "still_thin", reason: read.reason };
  // Step 4a: the JD lands first, so the re-screen and the pipeline read what the employer wrote.
  const written = await deps.writeDescription(row.jobId, read.text);
  // A failed write leaves the row thin for the next run.
  if (written !== null) return { kind: "error", message: `write: ${written}` };
  // Step 4b: re-screen on the NEW text (the JD is new information: work-auth, experience_ceiling, tech).
  const gate = await deps.preGate(row.applicationId, { ...row.job, descriptionRaw: read.text });
  // A drop stays a drop.
  if (gate.kind === "dropped") return { kind: "dropped", code: gate.code, reason: gate.reason };
  // Another run got there first.
  if (gate.kind === "skipped_stale") return { kind: "skipped_stale" };
  // The drop write failed; the JD is written, so the matcher's own gate re-judges it next time.
  if (gate.kind === "error") return { kind: "error", message: `pre-gate: ${gate.message}` };
  // Step 5: a pass goes through the pipeline to awaiting_approval.
  deps.runPipeline(row.applicationId);
  // Started; its end lands in the function logs.
  return { kind: "pipeline_started" };
}
