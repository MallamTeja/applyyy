// Ported from MadsLorentzen/ai-job-search @ 968fb1bd (MIT, © 2026 Mads Lorentzen).
//
// TAKEN: the retry loop's shape and constants — 1 initial attempt plus 6 retries on
// 429/5xx only, 500ms delay doubling with additive `Math.floor(Math.random() * 500)`
// jitter, a per-attempt `AbortSignal.timeout`, an explicit User-Agent, fail-fast on a
// thrown fetch (freehire's graceful-degradation rule), and jobbank's Cloudflare
// challenge regex `/just a moment|cloudflare|cf-chl/i` with its `response.clone()`
// body read.
//
// CHANGED: upstream carries FOUR divergent copies of this loop across four CLIs
// (jobdanmark alone has three in one file) — collapsed here to one core with
// per-caller options, which is the entire reason this module exists. The backoff cap
// is 8000ms uniformly; upstream disagrees with itself (jobdanmark and jobbank cap at
// 5000, linkedin and freehire at 8000) and 8000 is the value our contract pins.
// ADDED, none of which upstream has: `Retry-After` is honoured on a 429 and overrides
// the computed backoff (bounded, so a hostile header cannot park an Edge Function);
// a concurrency cap, because we poll many boards where upstream polled one; a
// configurable timeout in place of a hard-coded 15000; and Cloudflare/WAF detection
// moved INSIDE the loop so a challenge served as 429 or 503 raises an actionable
// error immediately instead of burning all seven attempts on identical challenge
// pages. 404 handling is caller-chosen rather than baked in — upstream varies it per
// adapter (null / "" / throw / raw Response) and every one of those is right for its
// own caller. Node-only surfaces are dropped: `process.stderr.write` (writeError) and
// the `node-html-parser` import, neither of which can cross into Deno, and the latter
// of which would touch a single-owner lockfile.
//
// ADDED BEYOND THE PORT BRIEF, ruled by the orchestrator 2026-09-16: the retry policy
// is a PARAMETER with defaults, not hardcoded constants. Upstream only ever fetched
// job boards, so its shape could not have accounted for a caller needing different
// semantics. Ours has one — the robots.txt gate in `packages/master-robots` must NOT
// retry a 5xx six times, because RFC 9309 assigns MEANING to a 5xx on robots.txt
// ("unavailable", which a crawler may treat as complete disallow) rather than treating
// it as a transient error to grind past. Same mechanism, different policy, so the
// policy is injected and the mechanism is written once.

// Typed failures. See errors.ts for why these are classes and not message strings.
import { BotProtectionError, HttpError, NetworkError, RetryAfterTooLongError, RobotsDisallowedError } from "./errors.ts";
// The one pure, exhaustively-testable piece of wire-format handling.
import { parseRetryAfterMs } from "./retry-after.ts";
// The robots.txt gate, by RELATIVE path exactly as scout-web/index.ts already imports it
// (a bare '@applyy/master-robots' specifier would need a package.json entry and a
// lockfile write). Gating lives HERE because this is the one function every Deno fetch
// path crosses (docs/robots/2026-09-17-robots-gate-first-caller.md §6.1): a gate each
// caller must remember to call is a comment, not a control. No recursion hazard: the
// gate fetches robots.txt through its OWN default fetcher (bare global fetch), never
// back through this transport.
import { checkRobots, tokenFromUserAgentHeader, type RobotsCache } from "../../../../packages/master-robots/src/index.ts";

// Identifies this tool honestly. Matches the string `scout-ats/index.ts` already
// sends, so a board operator reading their logs sees one identity for this system
// rather than two that look like separate crawlers.
//
// NEVER replace this with a browser User-Agent. PROJECT_PLAN.md constraint #5 —
// "DON'T bypass CAPTCHAs, MFA, authentication controls, robots restrictions, or
// anti-bot mechanisms" — puts UA spoofing to get past a bot filter out of bounds, and
// `worker/scripts/capture-fixture.ts` already records the same rule at its own fetch
// site. Exported so tests assert it rather than duplicating the literal.
export const DEFAULT_USER_AGENT = "applyy-scout/1.0 (+https://github.com/MallamTeja/applyyy)";

// Upstream's hard-coded value, kept as the default so the port behaves identically out
// of the box and differs only where a caller deliberately asks it to.
export const DEFAULT_TIMEOUT_MS = 15_000;
// 6 retries after the initial attempt = 7 total (invariant I1).
export const DEFAULT_MAX_RETRIES = 6;
// First backoff, doubling from here.
export const DEFAULT_BASE_DELAY_MS = 500;
// The ruled cap. Upstream contradicts itself (5000 in jobdanmark/jobbank, 8000 in
// linkedin/freehire); 8000 is ours, and it comes from the UNTESTED side of upstream,
// so the test below is the first one that has ever pinned it.
export const DEFAULT_MAX_DELAY_MS = 8_000;
// Jitter is ADDED to the delay, never multiplied (invariant I5). Multiplying would
// change the schedule's shape rather than merely de-synchronising callers.
export const DEFAULT_JITTER_MS = 500;
// Ceiling on a server-supplied `Retry-After`. Beyond this we refuse rather than wait:
// an Edge Function has a wall-clock budget, and a hostile or buggy `Retry-After: 86400`
// would otherwise park the Scout for a day.
export const DEFAULT_MAX_RETRY_AFTER_MS = 60_000;

// What a 404 MEANS is the caller's business, not the transport's.
//
// WHY CALLER-CHOSEN: whether a 404 is an error or a normal outcome is a fact about the
// caller's domain, not about HTTP. A deleted job posting returning 404 is the system
// working correctly; a 404 on a board's LIST endpoint means we have the wrong URL and
// the Scout should shout. A shared transport that picks one for everybody forces half
// its callers to wrap a non-error in try/catch, or to read a real misconfiguration as
// "no results today" — and that second failure mode is silent, the expensive kind.
//
// A string-literal union rather than an enum: `erasableSyntaxOnly` is set in
// tsconfig.base.json and bans `enum` outright, because an enum runs under Deno and
// THROWS at parse under Node's type stripper.
export type NotFoundMode =
  // A missing path is a bug (the JSON API callers).
  | "throw"
  // A job that no longer exists is a normal, expected state (detail lookups).
  | "null"
  // The caller parses text and an empty document already means "nothing found".
  | "empty";

// The retry half of the configuration, separated from the request half because it is
// the part a caller swaps wholesale. `master-robots` passes a different policy with the
// same request options; one flat bag would make that swap edit unrelated fields.
export interface RetryPolicy {
  // Retries AFTER the initial attempt. 6 gives the contract's 7 total.
  readonly maxRetries?: number;
  // First delay, doubling from here.
  readonly baseDelayMs?: number;
  // Ceiling on the computed (not server-supplied) delay.
  readonly maxDelayMs?: number;
  // Upper bound of the additive random jitter.
  readonly jitterMs?: number;
  // Ceiling on a server-supplied `Retry-After` before we refuse instead of waiting.
  readonly maxRetryAfterMs?: number;
  // Whether a thrown fetch (DNS failure, connection refused, abort) is retried.
  //
  // DEFAULT FALSE, matching upstream freehire: an unreachable host should drop out of
  // the run quickly rather than hold a seven-attempt budget open. An AbortError from
  // our own timeout arrives through the same catch, and the conservative reading is
  // that a host which just failed to answer within the timeout will not answer six
  // more times.
  readonly retryOnNetworkError?: boolean;
  // Which statuses are worth another attempt.
  //
  // THIS IS THE INJECTION POINT the robots gate needs. The default is upstream's rule
  // (429 or >= 500); `master-robots` overrides it to 429-only, because on robots.txt a
  // 5xx is a meaningful answer under RFC 9309, not a transient error.
  readonly isRetryableStatus?: (status: number) => boolean;
}

// Per-request options. Everything here is about THIS call rather than about policy.
export interface HttpRequestOptions {
  // GET unless a caller says otherwise; the port's `apiPost` case.
  readonly method?: string;
  // Arbitrary extra headers, so a caller needing linkedin's `Accept-Language` /
  // `X-Requested-With` does not have to fork the loop to get them.
  readonly headers?: Readonly<Record<string, string>>;
  // Request body for non-GET methods. Typed as string rather than BodyInit because
  // every caller in this repo sends JSON text, and the wider type would drag in
  // stream shapes that differ between the two runtimes.
  readonly body?: string;
  // linkedin and freehire both set `redirect: "follow"`; exposed rather than assumed.
  readonly redirect?: RequestRedirect;
  // A caller's own cancellation signal, COMBINED with (not replaced by) our per-attempt
  // timeout.
  readonly signal?: AbortSignal;
  // Per-attempt timeout. One number cannot serve both callers: an Edge Function's
  // wall-clock budget is eaten by a 15s hang, while a slow HTML detail page
  // legitimately needs longer than a JSON list endpoint.
  readonly timeoutMs?: number;
  // Override the identity we present. Still honest — this exists for a caller that
  // wants to name itself more specifically, NOT to impersonate a browser.
  readonly userAgent?: string;
  // See NotFoundMode.
  readonly notFound?: NotFoundMode;
  // See RetryPolicy.
  readonly retry?: RetryPolicy;
  // Robots gate control. ON BY DEFAULT: every request this transport sends is checked
  // against the target's robots.txt first, and a non-allow verdict throws
  // RobotsDisallowedError before the target is ever contacted. `false` opts out — only
  // for a caller provably not crawling a third-party site (none exists today; the
  // production callers are board harvesters, which is exactly what robots governs).
  // `cache` overrides the module-level verdict cache; it exists for tests, which need
  // isolation from each other, and for a caller that wants its own TTL scope.
  readonly robots?: false | { readonly cache?: RobotsCache };
}

// Every option resolved to a concrete value.
//
// WHY A SEPARATE FULLY-REQUIRED TYPE: `exactOptionalPropertyTypes` is on in
// supabase/functions/deno.json, which makes "absent" and "present but undefined" two
// DIFFERENT types. Spreading possibly-undefined properties downstream would force
// every consumer to handle both states. Normalising once here means the loop reads
// plain numbers and never a `number | undefined`.
interface ResolvedConfig {
  readonly method: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly redirect: RequestRedirect;
  readonly timeoutMs: number;
  readonly userAgent: string;
  readonly notFound: NotFoundMode;
  readonly maxRetries: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  readonly jitterMs: number;
  readonly maxRetryAfterMs: number;
  readonly retryOnNetworkError: boolean;
  readonly isRetryableStatus: (status: number) => boolean;
}

// Upstream's retryability rule, exported so a caller can compose with it rather than
// re-deriving the ranges and getting one boundary wrong.
export function defaultIsRetryableStatus(status: number): boolean {
  // 429 is the server asking us to slow down; 5xx is the server being broken. Both are
  // states that can plausibly differ on the next attempt. Nothing else is: a 400 will
  // be a 400 forever, and retrying it only spends budget.
  return status === 429 || status >= 500;
}

// Collapse the optional surface into concrete values exactly once.
function resolveConfig(options: HttpRequestOptions): ResolvedConfig {
  // Pulled out because every retry field reads from it, and `options.retry?.x ?? d`
  // repeated seven times is harder to scan for a missing default than this is.
  const retry = options.retry;
  return {
    method: options.method ?? "GET",
    headers: options.headers ?? {},
    redirect: options.redirect ?? "follow",
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    userAgent: options.userAgent ?? DEFAULT_USER_AGENT,
    // 'throw' is the conservative default: a caller that has not thought about 404s
    // gets an error it must notice, rather than a silent null it may not handle.
    notFound: options.notFound ?? "throw",
    maxRetries: retry?.maxRetries ?? DEFAULT_MAX_RETRIES,
    baseDelayMs: retry?.baseDelayMs ?? DEFAULT_BASE_DELAY_MS,
    maxDelayMs: retry?.maxDelayMs ?? DEFAULT_MAX_DELAY_MS,
    jitterMs: retry?.jitterMs ?? DEFAULT_JITTER_MS,
    maxRetryAfterMs: retry?.maxRetryAfterMs ?? DEFAULT_MAX_RETRY_AFTER_MS,
    retryOnNetworkError: retry?.retryOnNetworkError ?? false,
    isRetryableStatus: retry?.isRetryableStatus ?? defaultIsRetryableStatus,
  };
}

// Statuses on which a WAF challenge is plausible enough to be worth a body sniff.
//
// 403 is upstream's case; 429 and 503 are the ones upstream MISSES, and they are the
// expensive ones precisely because they are also retryable — upstream's jobbank never
// reaches its own check on those, so a WAF-driven 503 burns all seven attempts.
const CHALLENGE_STATUSES: ReadonlySet<number> = new Set([403, 429, 503]);

// The challenge-page signature.
//
// The first three alternatives are upstream's and are the load-bearing ones; the rest
// are added coverage. Kept as one regex rather than a list of includes() calls so the
// whole signature is visible in one place when someone has to extend it.
const CHALLENGE_BODY_PATTERN =
  /just a moment|cloudflare|cf-chl|attention required|cdn-cgi\/challenge-platform|access denied/i;

// Is a body sniff cheap and plausible for this response?
//
// WHY GATE THE SNIFF AT ALL: reading the body costs a full transfer, and doing it on
// every retryable failure would double the cost of an ordinary flaky-server run. The
// header hints below are free and are almost always present when a WAF is involved.
function looksLikeChallenge(response: Response): boolean {
  // Only these statuses are ever challenges; anything else is not worth a read.
  if (!CHALLENGE_STATUSES.has(response.status)) return false;
  // Cloudflare names itself in `server` and stamps `cf-ray` on everything it fronts.
  const server = response.headers.get("server") ?? "";
  if (/cloudflare/i.test(server)) return true;
  if (response.headers.get("cf-ray") !== null) return true;
  // An HTML body on a failure is the generic tell: an endpoint that should have
  // answered JSON and instead served a document is usually serving an interstitial.
  const contentType = response.headers.get("content-type") ?? "";
  return /text\/html/i.test(contentType);
}

// Sleep, resolving `setTimeout` from the global AT CALL TIME.
//
// THIS SPELLING IS LOAD-BEARING FOR THE TEST SUITE, not a style choice. The tests
// replace `globalThis.setTimeout` with an instant version so the seven-attempt
// exhaustion case runs in milliseconds instead of really sleeping through
// 500+1000+2000+4000+8000+8000ms of backoff. That substitution only works if the
// lookup happens when this function is CALLED. A `const sleep = globalThis.setTimeout`
// at module scope, or an import from `node:timers`, captures the real timer before the
// test can patch it — and the exhaustion test then takes ~24 real seconds or times
// out, with nothing in the failure output pointing at the cause.
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Build the signal for one attempt.
//
// PER ATTEMPT, NOT PER BUDGET (invariant I6). Hoisting this above the loop is a subtle,
// plausible-looking bug: the signal's clock starts once, so after the first backoff
// every later attempt inherits an almost-expired signal and aborts instantly. The loop
// would still run seven times and still report a failure, so a test that only counts
// calls stays green while every retry after the first becomes worthless. This is the
// single most likely regression a future editor introduces here.
function attemptSignal(timeoutMs: number, callerSignal: AbortSignal | undefined): AbortSignal {
  // A fresh timeout for THIS attempt.
  const timeout = AbortSignal.timeout(timeoutMs);
  // With no caller signal there is nothing to combine and the timeout stands alone.
  if (callerSignal === undefined) return timeout;
  // Combine rather than choose, so caller cancellation still works while our timeout
  // remains enforced. `AbortSignal.any` exists in both Node 24 and Deno 2, so no
  // polyfill and no feature check — a check here would be dead code pretending to be
  // caution.
  return AbortSignal.any([callerSignal, timeout]);
}

// The core: one request, with retry, backoff, timeout and WAF detection.
//
// Returns the `Response` on success. Returns null ONLY for a 404 under the 'null' or
// 'empty' modes — see NotFoundMode. Throws HttpError or a subclass otherwise.
// One robots-verdict cache per isolate, so a 40-board poll asks each origin once per
// TTL instead of once per request. Verdicts, not bodies, are cached (master-robots'
// CacheEntry holds the classified source), and the gate's own TTLs apply: 1h for a
// real answer, 5min for a failure.
const defaultRobotsCache: RobotsCache = new Map();

export async function httpFetch(
  url: string,
  options: HttpRequestOptions = {},
): Promise<Response | null> {
  // One normalisation pass; everything below reads concrete values.
  const cfg = resolveConfig(options);

  // THE ROBOTS GATE, BEFORE THE FIRST ATTEMPT. Checked once per call, not per retry:
  // the verdict cannot change between attempts of the same call, and re-checking would
  // multiply robots traffic by the retry budget.
  if (options.robots !== false) {
    // The gate matches robots groups against the PRODUCT TOKEN ("applyy-scout"), not
    // the full User-Agent header; the conversion is the package's own, so the token
    // can never drift from the header we actually send.
    const productToken = tokenFromUserAgentHeader(cfg.userAgent);
    // A null token FAILS CLOSED (CLAUDE.md §6): guessing one would silently select the
    // wildcard group — the exact fail-open tokenFromUserAgentHeader refuses to commit.
    if (productToken === null) {
      throw new RobotsDisallowedError(url, "refuse", `cannot derive a robots product token from User-Agent ${JSON.stringify(cfg.userAgent)}; refusing rather than matching as "*"`, null);
    }
    // The verdict logic (shape-checked parse, soft-200 refusal, 4xx/5xx semantics) all
    // lives in master-robots; this transport only acts on the verdict.
    const verdict = await checkRobots(url, productToken, { cache: options.robots?.cache ?? defaultRobotsCache });
    // Anything but an explicit allow refuses — 'wait' included, mirroring scout-web's
    // own gate: a transport that slept here would spend an Edge Function's wall clock
    // on one slow host's robots rate limit. crawlDelayMs on an allow is deliberately
    // NOT enforced here: pacing across requests is the caller's loop, not one call's.
    if (verdict.kind !== "allow") {
      throw new RobotsDisallowedError(url, verdict.kind, verdict.reason, verdict.kind === "refuse" ? verdict.source : null);
    }
  }
  // The computed backoff, doubling each retry. Reassigned in the loop, which is why it
  // is `let` and lives outside it.
  let delay = cfg.baseDelayMs;

  // `attempt <= maxRetries` gives 1 initial + maxRetries retries = 7 by default.
  for (let attempt = 0; attempt <= cfg.maxRetries; attempt++) {
    // Human-facing count: attempt 0 is the 1st attempt. Computed once so the several
    // error constructors below cannot disagree about it.
    const attemptNumber = attempt + 1;
    // Declared before the try so code after it can see the response; assigning inside
    // and using outside is what lets the catch handle transport failure separately
    // from HTTP failure.
    let response: Response;

    try {
      // BARE GLOBAL `fetch`, for the same reason `sleep` resolves setTimeout late: the
      // tests replace `globalThis.fetch`, and a module-scope capture would defeat the
      // stub silently.
      response = await fetch(url, {
        method: cfg.method,
        headers: {
          // Caller headers first so our identity header below cannot be silently
          // clobbered by a spread-ordering accident.
          ...cfg.headers,
          "User-Agent": cfg.userAgent,
        },
        redirect: cfg.redirect,
        // Fresh per attempt — see attemptSignal.
        signal: attemptSignal(cfg.timeoutMs, options.signal),
        // Only attach a body when there is one: passing `body: undefined` on a GET is
        // rejected by some runtimes rather than ignored, and `exactOptionalPropertyTypes`
        // makes the explicit-undefined spelling a type error anyway.
        ...(options.body === undefined ? {} : { body: options.body }),
      });
    } catch (cause) {
      // A thrown fetch is DNS failure, connection refused, or an abort (our timeout or
      // the caller's cancellation).
      //
      // FAIL FAST BY DEFAULT, carried across from upstream freehire: an unreachable
      // host should drop out of the run quickly rather than hold a seven-attempt budget
      // open. Retrying is available but off, because the conservative reading is that a
      // host which did not answer within the timeout will not answer six more times.
      if (!cfg.retryOnNetworkError || attempt === cfg.maxRetries) {
        throw new NetworkError(url, attemptNumber, cause);
      }
      // Opted in and budget remains: back off on the same schedule a retryable status
      // would use, so one policy governs the pacing rather than two.
      await sleep(delay + Math.floor(Math.random() * cfg.jitterMs));
      delay = Math.min(delay * 2, cfg.maxDelayMs);
      continue;
    }

    // WAF DETECTION, INSIDE THE LOOP AND BEFORE THE RETRY DECISION.
    //
    // This ordering is the improvement over upstream, which checked only 403 and only
    // AFTER its loop had finished. A challenge served as 429 or 503 is retryable by
    // status, so upstream ground through all seven attempts producing seven identical
    // challenge pages and then reported a generic status telling the operator nothing
    // actionable.
    if (looksLikeChallenge(response)) {
      // CLONE BEFORE READING. A Response body is a one-shot stream; reading the
      // original to sniff it would hand the real caller a consumed body.
      const sniffed = await response
        .clone()
        .text()
        // A body that cannot be read is not evidence of a challenge. Falling back to an
        // empty string keeps a broken body from crashing the poll.
        .catch(() => "");
      if (CHALLENGE_BODY_PATTERN.test(sniffed)) {
        // Thrown immediately, with calls === 1. Retrying a refusal is pointless, and
        // per constraint #5 the answer is never to disguise ourselves and try again.
        throw new BotProtectionError(url, response.status, response.statusText, attemptNumber);
      }
    }

    // 404 handling, BEFORE the retryable check so a policy that somehow made 404
    // retryable still cannot spin on a genuinely missing resource (invariant I3).
    if (response.status === 404) {
      // 'throw' deliberately falls through to the generic !ok branch below, which
      // builds the same HttpError every other 4xx gets — one error shape, not a
      // special case that a caller has to learn separately.
      if (cfg.notFound === "null" || cfg.notFound === "empty") return null;
    }

    // Is another attempt worth making? The predicate is injected; see RetryPolicy.
    if (cfg.isRetryableStatus(response.status)) {
      // Budget exhausted: report the status that beat us, with the attempt count so a
      // reader can tell this apart from a fail-fast.
      if (attempt === cfg.maxRetries) {
        throw new HttpError(url, response.status, response.statusText, attemptNumber);
      }

      // `Retry-After` OVERRIDES the computed backoff when present and parseable.
      // Accepted on 503 as well as 429: the RFC allows it there and real WAFs send it.
      // `Date.now()` is passed in rather than read inside the parser so the date-form
      // case is testable against a pinned clock.
      const serverDelay = parseRetryAfterMs(response.headers.get("retry-after"), Date.now());

      if (serverDelay !== null) {
        // Bounded, or a hostile `Retry-After: 86400` parks an Edge Function for a day.
        if (serverDelay > cfg.maxRetryAfterMs) {
          // Refuse rather than clamp. Waiting LESS than asked is strictly worse than
          // giving up: it guarantees another 429 and pushes us toward a ban. The error
          // carries the requested delay so a scheduler can honour it properly.
          throw new RetryAfterTooLongError(
            url,
            response.status,
            response.statusText,
            attemptNumber,
            serverDelay,
            cfg.maxRetryAfterMs,
          );
        }
        // Jitter is still added on top of a server-supplied delay, because it stops our
        // own parallel requests from re-colliding at the same instant — the server told
        // us WHEN, not that every one of our sockets should fire together.
        await sleep(serverDelay + Math.floor(Math.random() * cfg.jitterMs));
        // The computed schedule still advances underneath, so if the next response
        // carries no header we resume where the doubling had got to rather than
        // restarting at the base delay.
        delay = Math.min(delay * 2, cfg.maxDelayMs);
        continue;
      }

      // No usable header: upstream's computed schedule. Jitter is ADDED (I5) — a
      // multiplicative form would change the shape of the schedule rather than merely
      // de-synchronising callers that backed off together.
      await sleep(delay + Math.floor(Math.random() * cfg.jitterMs));
      // Double, capped (I4). The cap is ours; upstream disagrees with itself.
      delay = Math.min(delay * 2, cfg.maxDelayMs);
      continue;
    }

    // Any other non-2xx is terminal: a 400 will still be a 400 next time.
    if (!response.ok) {
      throw new HttpError(url, response.status, response.statusText, attemptNumber);
    }

    // Success.
    return response;
  }

  // Unreachable: the loop either returns or throws on its final iteration. Kept because
  // TypeScript cannot prove that, and an explicit throw is a better thing to fall out
  // of than an implicit `undefined` if the loop bounds are ever edited.
  throw new HttpError(url, 0, "retry loop exited without a result", cfg.maxRetries + 1);
}

// Fetch and parse JSON.
//
// Returns null on a 404 under the 'null'/'empty' modes, matching freehire's
// `Envelope<T> | null` shape. The generic is unchecked by design — validating the body
// against a schema is the caller's job, and a transport that tried would need to know
// every caller's shape.
export async function httpJson<T>(url: string, options: HttpRequestOptions = {}): Promise<T | null> {
  // Ask for JSON, but let a caller's own Accept win by spreading theirs last: a board
  // that content-negotiates would otherwise serve HTML to a default Accept header.
  const response = await httpFetch(url, {
    ...options,
    headers: { Accept: "application/json", ...(options.headers ?? {}) },
  });
  // The 404-as-null path; nothing to parse.
  if (response === null) return null;
  // Parsed here rather than handed back as a Response so the common caller does not
  // repeat the await-and-cast dance at every call site.
  return (await response.json()) as T;
}

// Fetch and read text.
//
// The 'empty' NotFoundMode resolves HERE rather than in httpFetch, because "" is a
// text-shaped answer that has no meaning for a Response or for JSON. linkedin's
// upstream variant returns "" on a 404 precisely so its caller can pipe the result
// straight into a parser that reads an empty document as zero results.
export async function httpText(url: string, options: HttpRequestOptions = {}): Promise<string | null> {
  const response = await httpFetch(url, options);
  if (response === null) {
    // 'empty' asked for a string; 'null' asked for a null. Both arrive here as null
    // from httpFetch, and only the caller's declared mode distinguishes them.
    return options.notFound === "empty" ? "" : null;
  }
  return await response.text();
}
