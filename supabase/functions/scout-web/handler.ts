// The request handler, with every side effect behind an injected seam so tests can drive
// the full gate order (auth -> kill switch -> search -> verify -> insert) with no network
// and no database. `index.ts` wires the real seams.

// Same CORS headers every other function sends, so the browser can read our errors too.
import { corsHeaders } from "../_shared/cors.ts";
// The two mandatory gates; imported, never re-implemented, so a fix there reaches us.
import { authorizeCaller, readKillSwitch, type CallerAuthClient, type KillSwitchClient } from "../_shared/db/gates.ts";
// The shared row builder, so fingerprints match what scout-ats would have produced.
import { toJobInsert } from "../_shared/ats/registry.ts";
// Row shape from the schema owner; never redefined here.
import type { JobInsert } from "../_shared/contracts/shared-types.ts";
// The pure pipeline and its seam types.
import {
  // Prompt building, discovery and run accounting are pure and live in core.ts.
  buildSearchPrompt,
  // The propose -> shape check -> verify pipeline.
  discover,
  // The same cap the body validator enforces, so the two can never disagree.
  MAX_CANDIDATES,
  // Derives the honest agent_runs verdict.
  runOutcome,
  // Board key, shared with discover() so watchlist lookups use the same identity.
  boardKey,
  // Naming precedence for the employer name (watchlist, then board, then token).
  companyFor,
  // The search seam's signal for "no key available", which is not a failure.
  QuotaExhaustedError,
  // Shape of one watchlist naming record.
  type WatchlistName,
  // Seam type for the robots-gated board fetch.
  type FetchBoardFn,
  // Seam type for the one-hop grounding redirect resolver.
  type ResolveRedirectFn,
  // Seam type for the Gemini search.
  type SearchFn,
} from "./core.ts";

// What closing an agent_runs row writes.
export interface RunPatch {
  // The enum values agent_run_status actually has; no free-form strings.
  readonly status: "succeeded" | "failed" | "skipped_disabled" | "skipped_quota";
  // What we looked at.
  readonly rows_in: number;
  // What we created.
  readonly rows_out: number;
  // How many things went wrong, kept separate from the status so partial failure is visible.
  readonly error_count: number;
  // Why, or null only when nothing failed.
  readonly error_detail: string | null;
}

// Database side effects, narrowed to exactly what this function does.
export interface Store {
  // Latest master_profiles row's profile JSON, or null when none exists.
  loadProfile(): Promise<{ ok: true; profile: unknown } | { ok: false; reason: string }>;
  // Opens an agent_runs row at 'running'; null when the telemetry write itself failed.
  openRun(): Promise<string | null>;
  // Closes it. Must not throw: telemetry failure never changes the HTTP answer.
  closeRun(runId: string, patch: RunPatch): Promise<void>;
  // Watchlist names for the given boards, keyed by boardKey(). A closed result, because a failed
  // read must not look like "no board is tracked". Reports, never throws.
  loadWatchlistNames(
    // Each verified board once.
    boards: readonly { provider: string; token: string }[],
  ): Promise<{ ok: true; names: ReadonlyMap<string, WatchlistName> } | { ok: false; reason: string }>;
  // Upserts jobs then inserts applications at 'discovered'. Reports, never throws.
  persist(rows: readonly JobInsert[]): Promise<{ inserted: number; errors: string[] }>;
}

// An authenticated connection and everything bound to it.
export interface Connection {
  // The app user's id, which gate 1 compares the caller against.
  readonly userId: string;
  // Used by the two gates; a real SupabaseClient satisfies both slices.
  readonly db: CallerAuthClient & KillSwitchClient;
  // The database effects.
  readonly store: Store;
  // Bound to the same db so Gemini key failover uses the same session.
  readonly search: SearchFn;
}

// Everything the handler needs from the outside world.
export interface HandlerDeps {
  // Sign in and build a Connection; a union so a failure carries its log-only reason.
  readonly connect: () => Promise<({ ok: true } & Connection) | { ok: false; reason: string }>;
  // The robots-gated board fetch.
  readonly fetchBoard: FetchBoardFn;
  // The grounding-redirect resolver, injected so tests never touch the network.
  readonly resolveRedirect: ResolveRedirectFn;
  // Injected clock so a run's timestamps are testable.
  readonly now: () => Date;
}

// One JSON answer, CORS included so the browser can read errors too.
function json(status: number, body: Record<string, unknown>): Response {
  // The contract: every non-2xx carries `status` and `message`.
  return new Response(JSON.stringify(body), {
    // Caller-chosen HTTP status.
    status,
    // JSON plus CORS in one place so no exit path can forget either.
    headers: { "content-type": "application/json; charset=utf-8", ...corsHeaders },
  });
}

// Strict body validation: unknown keys are ignored, but wrong types are refused, not coerced.
function parseBody(raw: unknown): { ok: true; query: string | null; limit: number } | { ok: false; message: string } {
  // An empty body is allowed (profile-only search).
  if (raw === null || raw === undefined) return { ok: true, query: null, limit: MAX_CANDIDATES };
  // Anything but a plain object is a malformed request.
  if (typeof raw !== "object" || Array.isArray(raw)) return { ok: false, message: "body must be a JSON object" };
  // Read through a loose record because the JSON is untrusted.
  const b = raw as Record<string, unknown>;
  // `query` is optional but, when present, must be a short string: it goes into a paid prompt.
  if (b["query"] !== undefined && (typeof b["query"] !== "string" || b["query"].length > 200)) {
    // The message names the limit so the UI can show it verbatim.
    return { ok: false, message: "query must be a string of at most 200 characters" };
  }
  // `limit` is optional but, when present, an integer in range; a string "5" is refused rather than coerced.
  if (b["limit"] !== undefined && (!Number.isInteger(b["limit"]) || (b["limit"] as number) < 1 || (b["limit"] as number) > MAX_CANDIDATES)) {
    // Same: the range comes from the shared constant, not a literal that could drift.
    return { ok: false, message: `limit must be an integer between 1 and ${MAX_CANDIDATES}` };
  }
  // Validated values, defaults applied.
  return {
    // Reaching here means every present field passed its shape check.
    ok: true,
    // Absent query becomes null so downstream never sees undefined.
    query: typeof b["query"] === "string" ? b["query"] : null,
    // Absent limit means "as many as the cap allows".
    limit: typeof b["limit"] === "number" ? b["limit"] : MAX_CANDIDATES,
  };
}

// The whole request lifecycle.
export async function handleScoutWeb(req: Request, deps: HandlerDeps): Promise<Response> {
  // Browser preflight must succeed without credentials.
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  // The contract is POST-only; a GET must not trigger a paid Gemini call.
  if (req.method !== "POST") return json(405, { status: "error", message: "method_not_allowed" });

  // Sign in as the app user.
  const conn = await deps.connect();
  // Without a client nothing else can run.
  if (!conn.ok) {
    // The reason goes to the log only: it distinguishes "no such user" from "wrong password".
    console.error(`[scout-web] db_client_failed: ${conn.reason}`);
    // The response stays generic for the same reason.
    return json(500, { status: "error", message: "db_client_failed" });
  }

  // GATE 1 — who is calling. Fail closed before reading anything from the body.
  const caller = await authorizeCaller(req, conn.db, conn.userId);
  // The verdict carries its own HTTP status so 401 and 403 stay distinct.
  if (!caller.ok) return json(caller.status, { status: "unauthorized", message: caller.error });

  // Body is parsed only after auth so anonymous callers cannot probe the validator.
  let rawBody: unknown = null;
  // JSON.parse throws on malformed input; that is the 400 case below.
  try {
    // Read as text so an EMPTY body is distinguishable from a malformed one.
    const text = await req.text();
    // Empty means "no options", anything else must be valid JSON.
    rawBody = text.trim() === "" ? null : JSON.parse(text);
  // Any parse failure is the caller's, not ours.
  } catch {
    // Malformed JSON is the caller's mistake, not ours.
    return json(400, { status: "error", message: "body is not valid JSON" });
  }
  // Shape-check the parsed body.
  const body = parseBody(rawBody);
  // Surface exactly which field was wrong so the UI can say so.
  if (!body.ok) return json(400, { status: "error", message: body.message });

  // Open the telemetry row BEFORE work so a crash leaves a visible 'running' row.
  const runId = await conn.store.openRun();
  // Closing helper that tolerates a failed open, so telemetry trouble never blocks the answer.
  const close = async (patch: RunPatch) => {
    // No row id means the open failed; there is nothing to close.
    if (runId !== null) await conn.store.closeRun(runId, patch);
  };

  // GATE 2 — the kill switch. Fail closed: unreadable halts too.
  const kill = await readKillSwitch(conn.db);
  // Explicitly off (or no settings row): halt without spending a Gemini call.
  if (kill.kind === "disabled") {
    // 'skipped_disabled' tells the health page WHY nothing happened, unlike a silent return.
    await close({ status: "skipped_disabled", rows_in: 0, rows_out: 0, error_count: 0, error_detail: kill.detail });
    // 409: the request is fine but the system state forbids it.
    return json(409, { status: "disabled", message: kill.detail });
  }
  // A failed read is an error, not "off", so it is recorded as one.
  if (kill.kind === "unreadable") {
    // Failed run with the reason, so the incident is distinguishable on the health page.
    await close({ status: "failed", rows_in: 0, rows_out: 0, error_count: 1, error_detail: `kill_switch_unreadable: ${kill.detail}` });
    // 503: retryable infrastructure trouble.
    return json(503, { status: "error", message: "kill_switch_unreadable" });
  }

  // The master profile feeds the search; unreadable is a failure, absent is allowed if the caller gave a query.
  const profile = await conn.store.loadProfile();
  // A read failure must not silently become "no profile".
  if (!profile.ok) {
    // Recorded with its reason for the health page.
    await close({ status: "failed", rows_in: 0, rows_out: 0, error_count: 1, error_detail: `profile_unreadable: ${profile.reason}` });
    // The database detail stays out of the response.
    return json(503, { status: "error", message: "master_profile_unreadable" });
  }
  // Null means nothing to search for.
  const prompt = buildSearchPrompt(profile.profile, body.query);
  // Searching for nothing would make the model invent a topic, so refuse instead.
  if (prompt === null) {
    // A failed run, because the user asked for work we could not do.
    await close({ status: "failed", rows_in: 0, rows_out: 0, error_count: 1, error_detail: "no_master_profile_and_no_query" });
    // 409: the state (no profile) conflicts with the request (no query).
    return json(409, { status: "error", message: "no master profile and no query to search with" });
  }

  // Propose -> shape check -> verify. A throw here is the model call failing.
  let found;
  // discover() throws only when the search call fails; board failures are returned, not thrown.
  try {
    // The only place the model's output is consumed, and it comes out as verified data.
    found = await discover({ search: conn.search, fetchBoard: deps.fetchBoard, resolveRedirect: deps.resolveRedirect }, prompt, body.limit);
  // Treated as a failed run, never an empty success.
  } catch (err) {
    // No key could be claimed (all cooling, or the daily budget spent). Normal, self-healing,
    // and NOT a failure: recorded as skipped_quota so the health page stays quiet about it.
    if (err instanceof QuotaExhaustedError) {
      // error_count 0, because nothing went wrong. The detail still says why nothing ran.
      await close({ status: "skipped_quota", rows_in: 0, rows_out: 0, error_count: 0, error_detail: err.message });
      // 429: retry later. Distinct from 502, so the UI can say "quota" rather than "broken".
      return json(429, { status: "quota", message: "gemini quota or daily budget exhausted; try again later" });
    }
    // The detail goes to telemetry and log; the response stays generic.
    const detail = err instanceof Error ? err.message : String(err);
    // Server log keeps the specifics for debugging.
    console.error(`[scout-web] search_failed: ${detail}`);
    // A failed search is a failed run, never an empty success.
    await close({ status: "failed", rows_in: 0, rows_out: 0, error_count: 1, error_detail: `search_failed: ${detail}` });
    // 502: an upstream (Gemini) failure.
    return json(502, { status: "error", message: "search_failed" });
  }

  // One clock reading for every row in this run.
  const now = deps.now();
  // Each verified board once, for the watchlist naming lookup.
  const boards = [...new Map(found.verified.map((v) => [boardKey(v.parsedUrl.provider, v.parsedUrl.token), { provider: v.parsedUrl.provider, token: v.parsedUrl.token }])).values()];
  // Collected here and reported with persistence errors, so a naming failure is visible.
  const lookupErrors: string[] = [];
  // Empty until the lookup succeeds; an empty map means every board falls back to board/token naming.
  let names: ReadonlyMap<string, WatchlistName> = new Map();
  // Only look up when there is something to name, so an empty run spends no database read.
  if (boards.length > 0) {
    // The store's own failure is a value, not a throw.
    const looked = await conn.store.loadWatchlistNames(boards);
    // On success use the names.
    if (looked.ok) names = looked.names;
    // A failed read degrades dedupe, not correctness, so it is an error entry, not an abort.
    else lookupErrors.push(`watchlist_lookup: ${looked.reason}`);
  }
  // The name and slug each verified posting gets, computed once and shared by rows and response.
  const companies = found.verified.map((v) =>
    // Watchlist row, then the board's own field, then the token. See companyFor() for why.
    companyFor(names.get(boardKey(v.parsedUrl.provider, v.parsedUrl.token)) ?? null, v.posting.rawPayload, v.parsedUrl.token)
  );
  // Build job rows from the BOARD's data only; the model's words never reach here.
  const rows = await Promise.all(found.verified.map((v, i) =>
    // Verified postings only: this is the single place the board's data becomes a jobs row.
    toJobInsert(v.posting, v.adapter, {
      // Watchlist name when tracked (same fingerprint as scout-ats), else the board's, else the token.
      // companies[i] always exists (built from the same array); the fallback only satisfies the type.
      companyName: companies[i]?.companyName ?? v.parsedUrl.token,
      // The blocklist and weekly cap join on this slug.
      companySlug: companies[i]?.companySlug ?? v.parsedUrl.token,
      // The run clock.
      now,
      // We are seeing it for the first time right now.
      firstSeenAt: now,
      // We have never polled this board, so the cold-start guard must apply.
      isFirstPollOfBoard: true,
    })
  ));

  // Counters for the honest telemetry below.
  let inserted = 0;
  // Persistence failures are collected, not thrown, so they reach error_detail.
  let persistErrors: string[] = [...lookupErrors];
  // Persist only when there is something verified; applications go in at 'discovered' inside the store.
  if (rows.length > 0) {
    // The store is meant not to throw, but a defect there must not skip run accounting.
    try {
      // The store owns the upserts; the handler never builds an applications status.
      const saved = await conn.store.persist(rows);
      // How many applications rows are genuinely new.
      inserted = saved.inserted;
      // Whatever went wrong, verbatim.
      persistErrors = [...lookupErrors, ...saved.errors];
    // Convert the throw into a reported persistence failure.
    } catch (err) {
      // A throwing store is still a persistence failure, reported honestly.
      persistErrors = [...lookupErrors, `persist_threw: ${err instanceof Error ? err.message : String(err)}`];
    }
  }

  // Honest telemetry: failed when nothing worked, error_detail whenever anything failed.
  const outcome = runOutcome({
    // The search succeeded or we would have returned above.
    searchFailed: false,
    // Boards we tried to verify.
    boardsAttempted: found.boardsAttempted,
    // Boards that errored (not hallucinations).
    boardErrors: found.errorCount,
    // A few examples for the detail string.
    errorSamples: found.errorSamples,
    // Save failures.
    persistErrors,
    // What was available to save.
    verified: found.verified.length,
    // What was actually saved.
    inserted,
  });
  // Close the run with what really happened.
  await close({
    // Derived, never hard-coded 'succeeded'.
    status: outcome.status,
    // Candidates examined.
    rows_in: found.proposed,
    // Applications created.
    rows_out: inserted,
    // Total failures this run.
    error_count: outcome.errorCount,
    // Non-null whenever error_count is non-zero.
    error_detail: outcome.errorDetail,
  });

  // Everything verified failed to save: that is an error answer, not an empty success.
  if (found.verified.length > 0 && inserted === 0 && persistErrors.length > 0) {
    // 500: our persistence layer failed, not the caller's request.
    return json(500, { status: "error", message: "persist_failed" });
  }

  // The HTTP contract the UI is built against.
  return json(200, {
    // Discriminator the UI switches on.
    status: "ok",
    // Candidates examined.
    proposed: found.proposed,
    // Candidates confirmed in a live board.
    verified: found.verified.length,
    // Applications rows newly created (existing ones are never touched).
    inserted,
    // Display data comes from the board, never from the model.
    jobs: found.verified.map((v, i) => ({
      // Board's title.
      title: v.posting.title,
      // The same name the jobs row got, so the UI never shows a different employer than was stored.
      company_name: companies[i]?.companyName ?? v.parsedUrl.token,
      // The adapter's canonical submit target.
      apply_url: v.posting.applyUrl,
      // Which adapter submits it.
      ats_provider: v.parsedUrl.provider,
      // Board's location string, possibly null.
      location_raw: v.posting.locationRaw,
    })),
    // Every refused candidate with its reason, so nothing disappears silently.
    rejected: found.rejected,
  });
}
