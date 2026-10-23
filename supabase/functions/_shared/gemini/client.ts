// The Gemini client middleware: in-flight multi-key retry and deterministic token pacer.
//
// DESIGN PRINCIPLES:
//
// 1. IN-FLIGHT MULTI-KEY RETRY (1a):
//    When an in-flight Gemini call encounters an HTTP 429 (Rate Limit / Quota Exhaustion),
//    the request must NEVER abort the tailoring or pipeline execution mid-way. Instead,
//    it parses `retry_after` from the response (via `parseRetryAfterSeconds`), reports the
//    cooling key back to Postgres (`reportResult`), immediately claims the NEXT active key
//    from the pool (`claimKey`), and retries the call transparently.
//    The same loop also retries TRANSIENT upstream failures (500/502/503/504, network errors
//    and per-attempt timeouts) on the next key. Between attempts it sleeps 1s/3s/7s (+0-25%
//    jitter) when it does not know the per-attempt timeout (a direct caller), and a longer,
//    BUDGET-CAPPED overload backoff (Retry-After, else ~2-4s/8-16s/24-48s) when it does (every
//    generateGeminiContent call). With GEMINI_FALLBACK_MODEL set, the primary's first 503
//    switches the remaining attempts to the fallback model after a brief wait.
//    One `maxRetries` budget covers both. Exhaustion reasons: `rate_limited_all_
//    retries_exhausted` (last failure was a 429) or `upstream_unavailable` (last was transient).
//    A 200 with no usable text part is `empty_response` (terminal, no retry, key not blamed).
//
// 2. DETERMINISTIC TOKEN PACER / SEQUENTIAL QUEUE (1c):
//    Free tier Gemini has strict Rate Per Minute (RPM) limits (e.g. 15 RPM). Rapid concurrent
//    bursts exhaust quotas instantaneously. The deterministic pacer serializes requests
//    through an internal queue and enforces a minimum spacing interval between calls.
//
// 3. ZERO UNCHECKED ASSUMPTIONS:
//    Pure dependency seams for network (`fetch`), clock (`now`, `sleep`), and database (`db`),
//    allowing 100% deterministic unit testing under Node and Deno without live network access.

import type { SupabaseClient } from "jsr:@supabase/supabase-js@2.58.0";
import {
  claimKey,
  reportResult,
  parseRetryAfterSeconds,
  type KeyClaim,
  type KeyReader,
  denoKeyReader,
} from "./pool.ts";

// Clock seam for deterministic pacer testing.
export interface PacerClock {
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
}

// Default real-world clock.
export const systemClock: PacerClock = {
  now: () => Date.now(),
  sleep: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
};

// Deterministic Token Pacer / Sequential Queue (1c).
// Serializes calls and enforces a minimum delay (in ms) between outbound dispatches.
export class GeminiPacer {
  private queue: Promise<void> = Promise.resolve();
  private lastDispatchTime = 0;
  private readonly minIntervalMs: number;
  private readonly clock: PacerClock;

  constructor(options?: { minIntervalMs?: number; clock?: PacerClock }) {
    // Default 500ms spacing between calls (safely within 15-60 RPM limits).
    this.minIntervalMs = Math.max(0, options?.minIntervalMs ?? 500);
    this.clock = options?.clock ?? systemClock;
  }

  // Execute a task sequentially, pacing its start relative to previous dispatches.
  async pace<T>(task: () => Promise<T>): Promise<T> {
    // Chain onto the serial queue so concurrent invocations execute strictly in order.
    const run = async (): Promise<T> => {
      const now = this.clock.now();
      const elapsed = now - this.lastDispatchTime;
      const waitTime = this.minIntervalMs - elapsed;

      if (waitTime > 0) {
        await this.clock.sleep(waitTime);
      }

      this.lastDispatchTime = this.clock.now();
      return await task();
    };

    // Append to queue, ensuring queue advances even if this task throws.
    const resultPromise = this.queue.then(run, run);
    this.queue = resultPromise.then(
      () => {},
      () => {},
    );
    return await resultPromise;
  }
}

// Global default singleton pacer instance for shared use in the Edge runtime.
export const defaultGeminiPacer = new GeminiPacer({ minIntervalMs: 500 });

// Execution result from a Gemini API invocation.
export type GeminiExecutionResult<T> =
  | { readonly ok: true; readonly data: T }
  | {
      readonly ok: false;
      readonly status: number;
      readonly statusText?: string;
      readonly errorBody?: unknown;
      readonly rawResponse?: Response;
    };

// Result returned to caller of `callGeminiWithFailover`.
export type GeminiCallOutcome<T> =
  | {
      readonly ok: true;
      readonly data: T;
      readonly keyIndex: number;
      readonly attempts: number;
    }
  | {
      readonly ok: false;
      readonly reason:
        | "all_keys_cooling"
        | "no_keys_configured"
        | "key_env_missing"
        | "claim_failed"
        | "rate_limited_all_retries_exhausted"
        // A 404 from generateContent: the MODEL ID or endpoint does not exist. A
        // configuration error, never a key problem, so it is named separately from
        // `http_error` and no key is blamed for it (see the 404 branch below).
        | "model_not_found"
        // The caller asked for something the client refuses to send (e.g. grounding tools
        // combined with a JSON response schema). Returned BEFORE a key is claimed, so a
        // malformed request costs no quota and touches no key's failure streak.
        | "invalid_request"
        // Every attempt in the loop ended in a TRANSIENT upstream failure (500/502/503/504 or a
        // network error / timeout) — the last one was not a 429. Named apart from `http_error`
        // (terminal, a retry cannot help) and from the 429 reason (quota, a key problem) because
        // the remedy differs: wait and re-run later, change nothing in config or keys.
        | "upstream_unavailable"
        // A 200 whose body carried no candidates (typically a safety block, see
        // `promptFeedback.blockReason` in `detail`). Terminal and key-blameless: a retry sends the
        // same prompt and gets the same block, and the key behaved correctly.
        | "empty_response"
        | "http_error";
      readonly status?: number;
      readonly detail?: string;
      readonly errorBody?: unknown;
      readonly attempts: number;
    };

export interface GeminiFailoverOptions<T> {
  // The actual execution function using the claimed key. The third argument is the model this
  // attempt must call (the primary, or the fallback after a switch), so the loop, not the URL
  // builder, owns the decision; existing two-argument executors simply ignore it.
  readonly execute: (apiKey: string, keyIndex: number, model: string | undefined) => Promise<GeminiExecutionResult<T>>;
  // Per-attempt abort timeout the executor enforces. Known => the loop can recompute the worst
  // case the caller budgeted (deadline.ts worstCaseCallMs) and spend unused time on longer
  // overload backoff without ever exceeding it. Unknown => the original short schedule, since
  // no longer sleep can be proven to fit.
  readonly attemptTimeoutMs?: number;
  // Clock seam for the budget arithmetic; tests advance a virtual clock instead of waiting.
  readonly now?: () => number;
  // Model to switch to after the primary's FIRST 503. One is enough: a controlled probe
  // (2026-10-06, same key, same body) showed the 503 is per MODEL and sustained, with a lighter
  // model answering the identical request. Absent (or equal to the primary) means the loop never
  // switches: today's model behaviour, exactly.
  readonly fallbackModel?: string;
  // Maximum number of RETRIES (default 3, so up to 4 attempts) shared by 429s and transient
  // upstream failures (5xx / network) as ONE budget, so a flapping upstream cannot loop forever.
  readonly maxRetries?: number;
  // Backoff sleep seam; defaults to setTimeout. Tests inject a recorder so they never really wait.
  readonly sleep?: (ms: number) => Promise<void>;
  // Jitter source in [0,1); defaults to Math.random. Tests inject a constant for exact bounds.
  readonly random?: () => number;
  // Key reader dependency seam (defaults to reading Deno.env).
  readonly readKey?: KeyReader;
  // Token pacer (defaults to global singleton pacer).
  readonly pacer?: GeminiPacer;
  // The model id this call targets, appended to every last_error this loop writes. Optional
  // because the loop itself never builds a URL; generateGeminiContent passes the one it resolved.
  // Without it a live 503 could only be pinned to a model by INFERRING which env was deployed.
  readonly model?: string;
  // Optional rotation hook for logging / metrics.
  readonly onKeyRotated?: (info: {
    readonly fromKeyIndex: number;
    readonly retryAfterSeconds: number | null;
    readonly attempt: number;
  }) => void;
}

// Statuses worth retrying on another key: gateway/overload errors and 0 (network/timeout).
const TRANSIENT_STATUSES: ReadonlySet<number> = new Set([0, 500, 502, 503, 504]);
// Cooldown for a key that got 401/403. The key, not the model, is at fault; an hour lets a human
// look while the LRU skips it and the rest of the pool keeps working.
const KEY_REJECTED_COOLDOWN_S = 3600;
// Appends Google's error.status and error.message to a last_error string: "HTTP 403: Forbidden"
// alone made a live 403 undiagnosable. Truncated to ~200 chars so one verbose body cannot bloat
// the row. Any 39-char `AIza...` key pattern is stripped defensively: the key now travels only in
// a header, but an upstream message can still echo a key, and last_error is shown on a health page.
function withGoogleError(base: string, errorBody: unknown): string {
  // errorBody is untrusted JSON (or text); only an object with an `error` object is usable.
  const err = typeof errorBody === "object" && errorBody !== null ? (errorBody as { error?: unknown }).error : undefined;
  if (typeof err !== "object" || err === null) return base;
  const { status, message } = err as { status?: unknown; message?: unknown };
  const parts = [typeof status === "string" ? status : "", typeof message === "string" ? message : ""].filter((x) => x.length > 0);
  if (parts.length === 0) return base;
  // Redact first, then truncate, so a key straddling the cut cannot survive as a prefix.
  const extra = parts.join(" - ").replace(/AIza[0-9A-Za-z_-]{35}/g, "[redacted-key]").slice(0, 200);
  return `${base} [${extra}]`;
}
// True only for Google's per-KEY 400: an expired or deleted key answers HTTP 400
// INVALID_ARGUMENT (not 403) with error.details[] carrying an ErrorInfo whose reason is
// exactly "API_KEY_INVALID". SHAPE-CHECKED at every step (CLAUDE.md §6: the lenient reader
// is the fail-open): a missing or malformed `details` means "ordinary 400", never "dead key" —
// rotating on a guess would park a healthy key for an hour on every malformed request.
function isApiKeyInvalid(errorBody: unknown): boolean {
  // Only an object body can carry Google's envelope; a text body is an ordinary 400.
  const err = typeof errorBody === "object" && errorBody !== null ? (errorBody as { error?: unknown }).error : undefined;
  // No `error` object, no verdict: fail closed.
  if (typeof err !== "object" || err === null) return false;
  const details = (err as { details?: unknown }).details;
  // Anything but an array fails closed — `details: "API_KEY_INVALID"` must not match.
  if (!Array.isArray(details)) return false;
  // Exact string match on each entry's `reason`; non-object entries are skipped, not trusted.
  return details.some((d) => typeof d === "object" && d !== null && (d as { reason?: unknown }).reason === "API_KEY_INVALID");
}
// Appends " model=<id>" to a last_error string, AFTER everything else, so the existing
// "HTTP 503: Service Unavailable [UNAVAILABLE - ...]" prefix the Health page and humans read stays
// byte-identical. No model (a direct caller that passed none) leaves the text untouched, so the
// tag is never a guess: it appears only when the URL was actually built from that id.
function withModel(text: string, model: string | undefined): string {
  // Blank counts as absent, so a stray "" can never write a bare "model=" that reads as an answer.
  return model !== undefined && model.trim().length > 0 ? `${text} model=${model.trim()}` : text;
}
// Base backoff per attempt. Worst case with defaults (3 sleeps): 1000+3000+7000 = 11000 ms,
// plus up to 25% jitter = 13750 ms, well under the 25 s budget an Edge Function can spare.
// ALSO THE RESERVATION TABLE: deadline.ts plans each gap at base x 1.25 and its tripwire test
// reads this exact literal, so the budgeted backoff below always leaves every FUTURE gap this
// much, which keeps deadline.ts's worst-case arithmetic true without touching that file.
const BACKOFF_BASE_MS: readonly number[] = [1000, 3000, 7000];
// Jitter ceiling deadline.ts assumes (MAX_JITTER there); named so the reservation reads it.
const BACKOFF_JITTER = 0.25;
// Overload backoff ceilings per gap, x4 each step. Live 2026-10-06: four 503s "high demand"
// came back within ~17 s on the short schedule, i.e. the retries were spent inside the same
// spike. Google's own text says spikes are "usually temporary", so the attempts are spread
// across the time the caller already budgeted instead of being burned in the first seconds.
const OVERLOAD_BACKOFF_MS: readonly number[] = [4000, 16000, 48000];

// The worst case deadline.ts budgets for one call (its worstCaseCallMs, restated here because
// that module imports nothing from this one): every attempt runs to its timeout and every gap
// sleeps base x 1.25. Total time is measured against this, so the call can never overrun it.
function plannedWorstCaseMs(attemptTimeoutMs: number, maxRetries: number): number {
  // All attempts at their full timeout.
  let total = (maxRetries + 1) * attemptTimeoutMs;
  // One gap before each retry, at its maximum jittered length.
  for (let gap = 0; gap < maxRetries; gap++) total += gapReserveMs(gap);
  // The budget end is the call's start plus this.
  return total;
}

// What deadline.ts reserves for one gap: the base delay at maximum jitter, clamped to the
// table's last entry exactly as the short schedule clamps it.
function gapReserveMs(gap: number): number {
  // Clamp so a maxRetries longer than the table reuses the last delay instead of reading undefined.
  return BACKOFF_BASE_MS[Math.min(gap, BACKOFF_BASE_MS.length - 1)]! * (1 + BACKOFF_JITTER);
}

// In-Flight Multi-Key Retry Middleware (1a) with Pacing (1c).
export async function callGeminiWithFailover<T>(
  db: SupabaseClient,
  options: GeminiFailoverOptions<T>,
): Promise<GeminiCallOutcome<T>> {
  const maxRetries = Math.max(0, options.maxRetries ?? 3);
  const readKey = options.readKey ?? denoKeyReader;
  const pacer = options.pacer ?? defaultGeminiPacer;
  // Resolved once so every backoff in this call uses the same seams.
  const sleep = options.sleep ?? systemClock.sleep;
  const random = options.random ?? Math.random;
  // Same clock seam for the budget arithmetic, so a virtual clock drives both in tests.
  const now = options.now ?? systemClock.now;
  // Budget end, only when the per-attempt timeout is known; null selects the short schedule.
  const budgetEndsAt =
    options.attemptTimeoutMs !== undefined ? now() + plannedWorstCaseMs(options.attemptTimeoutMs, maxRetries) : null;
  // Blank or same-as-primary fallback is treated as unset, so "configured" can never mean "no-op switch".
  const fallbackModel =
    options.fallbackModel !== undefined && options.fallbackModel.trim().length > 0 && options.fallbackModel.trim() !== options.model
      ? options.fallbackModel.trim()
      : undefined;
  // The model the NEXT attempt calls; starts at the primary and changes at most once.
  let currentModel = options.model;

  let attempt = 0;
  // Which kind of failure ended the LAST attempt decides the exhausted-loop reason, so both
  // kinds share one loop but are still reported honestly.
  let lastFailure: { readonly status: number; readonly detail: string } | null = null;
  // Which kind of failure came LAST (null before any). A 429, a transient and a key rejection
  // all share `lastFailure`/this loop, so this tag is the tiebreak that names the exhaustion
  // reason: an EARLIER failure of another kind must not mislabel the final one.
  let lastKind: "rate_limit" | "transient" | "key_rejected" | null = null;

  while (attempt <= maxRetries) {
    attempt += 1;

    // 1. Claim a key atomically from the Postgres pool.
    const claim: KeyClaim = await claimKey(db, readKey);

    if (!claim.ok) {
      // If no key is eligible (cooling, unconfigured, or db error), exit immediately.
      return {
        ok: false,
        reason: claim.reason,
        // Only the `claim_failed` variant of `KeyClaim` carries a `detail`; the other three
        // omit it *on purpose* — `pool.ts` says so in the type's own comment, because
        // `all_keys_cooling` is normal quota exhaustion and logging error text for it would
        // train us to ignore the log. Spreading the key in only when it exists preserves that
        // intent through the boundary: under `exactOptionalPropertyTypes` a literal
        // `detail: undefined` is a DIFFERENT type from an absent key, and it is the absent
        // key that means "this failure has nothing to say".
        // Not `?? ""`: an empty string is a detail that reads as present to `'detail' in x`
        // and to `Object.keys`, so it would turn "deliberately silent" into "failed silently".
        ...("detail" in claim ? { detail: claim.detail } : {}),
        attempts: attempt,
      };
    }

    const { index: keyIndex, apiKey } = claim;

    // 2. Execute the request through the deterministic token pacer.
    // The model is passed per attempt because a fallback switch changes it mid-call.
    const execResult = await pacer.pace(() => options.execute(apiKey, keyIndex, currentModel));

    // 3. On success: record positive outcome in Postgres and return.
    if (execResult.ok) {
      await reportResult(db, keyIndex, true);
      return {
        ok: true,
        data: execResult.data,
        keyIndex,
        attempts: attempt,
      };
    }

    // 4. On Rate Limit (HTTP 429): parse retry-after, report cooldown, and rotate key!
    if (execResult.status === 429) {
      const retryAfterSeconds = execResult.rawResponse
        ? parseRetryAfterSeconds(execResult.rawResponse, execResult.errorBody)
        : null;

      // Built like every other last_error: status line plus Google's error status/message via
      // withGoogleError, which redacts key shapes and caps at 200 chars. This branch used to
      // store JSON.stringify(errorBody) raw and uncapped — the one stored write that skipped
      // the redaction every other branch gets (reviewer finding N2, 2026-10-09). `||` (not
      // `??`) on statusText: HTTP/2 yields "", which would leave "HTTP 429: " bare.
      const errorText = withGoogleError(`HTTP 429: ${execResult.statusText || "Too Many Requests"}`, execResult.errorBody);

      // Tagged so a 429 names the model whose quota ran out (quotas are per model).
      await reportResult(db, keyIndex, false, retryAfterSeconds, withModel(errorText, currentModel));

      options.onKeyRotated?.({
        fromKeyIndex: keyIndex,
        retryAfterSeconds,
        attempt,
      });

      // The last failure is now a 429, so exhaustion must report the quota reason.
      lastKind = "rate_limit";
      // Continue to next iteration without aborting!
      continue;
    }

    // 4b. On 404: the model id (or endpoint path) does not exist. Checked BEFORE the
    // generic branch below because that branch calls `reportResult(…, false)`, which bumps
    // the claimed key's `consecutive_failures` and overwrites its `last_error`. Every key
    // is innocent here: a retired model 404s identically on all 40, so blaming one per
    // call walks the LRU through the whole pool and leaves 40 keys reading "HTTP 404" on
    // the health page — which is what happened live with `gemini-1.5-flash`, and sent the
    // investigation to the keys instead of the model id.
    if (execResult.status === 404) {
      // Fail fast without retrying: rotating keys cannot fix a model that does not exist.
      return {
        ok: false,
        reason: "model_not_found",
        status: 404,
        // A human-readable pointer to the fix, so a log line names the knob to turn.
        // Tagged with the model that 404'd: after a fallback switch it is GEMINI_FALLBACK_MODEL
        // that is wrong, and an untagged message would send the fix to the primary instead.
        detail: withModel("Gemini returned 404 for generateContent: the model id is retired or wrong; set GEMINI_MODEL / GEMINI_FALLBACK_MODEL or update GEMINI_DEFAULT_MODEL", currentModel),
        errorBody: execResult.errorBody,
        attempts: attempt,
      };
    }

    // 4a. KEY REJECTION (401/403, and the one per-KEY 400): most likely THIS key is bad
    // (revoked, restricted, wrong project — or deleted at Google, which answers 400
    // INVALID_ARGUMENT with details[].reason "API_KEY_INVALID", see isApiKeyInvalid) while the
    // rest of the pool is healthy, so one bad key must not end the call.
    // The key, not the model, is at fault: park it for an hour (KEY_REJECTED_COOLDOWN_S) so the
    // LRU skips it and a human has time to look, then rotate to the next key. NO backoff sleep:
    // this is not an overload, so waiting buys nothing. Same maxRetries budget as everything else.
    // Every OTHER 400 is deliberately NOT here: a malformed request fails identically on every
    // key, so it stays in the terminal branch below (fail closed on any odd error shape).
    if (execResult.status === 401 || execResult.status === 403 || (execResult.status === 400 && isApiKeyInvalid(execResult.errorBody))) {
      const detail = withGoogleError(`HTTP ${execResult.status}: ${execResult.statusText || "Key rejected"}`, execResult.errorBody);
      // Tagged at the write only; `detail` itself stays untagged for the returned outcome.
      await reportResult(db, keyIndex, false, KEY_REJECTED_COOLDOWN_S, withModel(detail, currentModel));
      lastFailure = { status: execResult.status, detail };
      lastKind = "key_rejected";
      options.onKeyRotated?.({ fromKeyIndex: keyIndex, retryAfterSeconds: KEY_REJECTED_COOLDOWN_S, attempt });
      continue;
    }

    // 4c. TRANSIENT upstream failure: 500/502/503/504, or status 0 (network error / timeout from
    // `execute`'s catch). Live evidence: gemini-3.8-flash intermittently answered 503 and the
    // old code gave up after one call. The outage is the MODEL's, not the key's, so NO cooldown
    // is applied: a NULL retry_after makes report_gemini_result leave cooldown_until alone. It
    // still increments consecutive_failures and overwrites last_error, kept ON PURPOSE because
    // last_error is how this 503 was diagnosed in the first place. The next iteration claims the
    // next key. Checked before the terminal branch below.
    if (TRANSIENT_STATUSES.has(execResult.status)) {
      // Status 0 has no HTTP line; say "network error" so the health page is not misleading.
      const detail =
        execResult.status === 0
          ? `network error: ${execResult.statusText || "unknown"}`
          : `HTTP ${execResult.status}: ${execResult.statusText || "Service error"}`;
      // Tagged last, after Google's bracket, so a 503 says WHICH model was overloaded.
      await reportResult(db, keyIndex, false, null, withModel(withGoogleError(detail, execResult.errorBody), currentModel));
      // Remembered for the exhausted-loop return at the bottom.
      lastFailure = { status: execResult.status, detail };
      lastKind = "transient";
      // THE NEXT ATTEMPT CLAIMS AGAIN, even though a 503 is per model and not per key. The claim
      // is not just key selection: claim_gemini_key is where the kill switch and the daily budget
      // are checked and where every call is counted, so reusing the key without it would let
      // retries bypass both. Rotation costs one RPC and a bump of the write-only
      // consecutive_failures; a true same-key retry needs a claim that accepts a preferred key.
      options.onKeyRotated?.({ fromKeyIndex: keyIndex, retryAfterSeconds: null, attempt });
      // Only a 503 ON THE PRIMARY switches: 500/502/504/0 are not "high demand", and a 503 on the
      // fallback has nowhere further to go. currentModel !== fallbackModel makes it happen once.
      const switching =
        fallbackModel !== undefined && execResult.status === 503 && currentModel === options.model;
      // Applied before the sleep decision, so the next attempt (and its last_error tag) uses it.
      if (switching) {
        // Logged because the switch changes which model answers, which a reader of the output must know.
        console.warn(`[gemini] ${options.model} returned 503; falling back to ${fallbackModel} for the remaining attempts`);
        // Every remaining attempt calls the fallback; the loop never switches back mid-call.
        currentModel = fallbackModel;
      }
      // Never sleep after the final attempt: nothing follows it, so waiting only delays the error.
      // `attempt <= maxRetries` is exactly "another attempt will follow".
      if (attempt <= maxRetries) {
        // Zero-based gap index between this attempt and the next.
        const gap = attempt - 1;
        // Clamp attempts past the table to the last delay, so a larger maxRetries cannot index
        // past the array (an undefined delay would become NaN and retry instantly).
        const base = BACKOFF_BASE_MS[Math.min(gap, BACKOFF_BASE_MS.length - 1)]!;
        // Short schedule: the original 0-25% jitter, used when the budget cannot be computed.
        let delay = base + base * BACKOFF_JITTER * random();
        // Budget known: aim for the overload backoff, then cap it to what provably fits.
        if (budgetEndsAt !== null) {
          // Google's own delay wins when it sends one (header or RetryInfo); null when absent,
          // so a missing hint falls through to our schedule instead of becoming a zero wait.
          const hinted = execResult.rawResponse ? parseRetryAfterSeconds(execResult.rawResponse, execResult.errorBody) : null;
          // Overload ceiling for this gap, clamped to the table's last entry like `base`.
          const ceiling = OVERLOAD_BACKOFF_MS[Math.min(gap, OVERLOAD_BACKOFF_MS.length - 1)]!;
          // "Equal jitter": half fixed, half random, so concurrent callers spread out but never
          // retry almost instantly the way full jitter can. Never below the short schedule's base.
          const wanted = hinted !== null ? hinted * 1000 : Math.max(base, ceiling / 2 + (ceiling / 2) * random());
          // A model switch gets only the brief short-schedule wait: the fallback is not the model
          // shedding load, so an overload wait would spend budget on the wrong model.
          const target = switching ? base + base * BACKOFF_JITTER * random() : wanted;
          // Attempts still to run after this sleep; each keeps its full timeout in reserve.
          const attemptsLeft = maxRetries + 1 - attempt;
          // Their gaps (all but the one being slept now) keep deadline.ts's reservation too.
          let reserve = attemptsLeft * options.attemptTimeoutMs!;
          // Future gaps start after this one.
          for (let later = gap + 1; later < maxRetries; later++) reserve += gapReserveMs(later);
          // What this gap may spend without the call outliving the caller's planned worst case.
          const allowed = budgetEndsAt - now() - reserve;
          // Capped by the budget and never negative: sleeping less is always safe, sleeping past
          // the plan is the one thing this must never do.
          delay = Math.max(0, Math.min(target, allowed));
        }
        // Zero (no budget left for this gap) is skipped rather than slept.
        if (delay > 0) await sleep(delay);
      }
      continue;
    }

    // 4d. A 200 whose body was not JSON (execute reports it as status 200 + "invalid JSON body").
    // The malformed body is the UPSTREAM's fault (a gateway error page), so no key is blamed:
    // reportResult(false) here would bump a different key's failure streak per call and walk the
    // pool, the same lesson as the 404 branch above. Terminal: a retry gets the same garbage.
    if (execResult.status === 200) {
      return {
        ok: false,
        reason: "http_error",
        status: 200,
        // Fixed wording, so a log line says what was wrong with the body.
        detail: "invalid JSON body",
        attempts: attempt,
      };
    }

    // 5. On 400 (except the per-key API_KEY_INVALID caught in 4a) and any other status that is
    // not a 429, 404, key rejection or transient failure: record the error against the key and
    // fail closed — rotating keys won't fix a malformed payload. `||` (not `??`) on statusText: HTTP/2 yields "", and an empty string
    // would otherwise leave a double space in last_error ("HTTP 403:  [...]").
    await reportResult(
      db,
      keyIndex,
      false,
      null,
      // Same tag as every other failure write, so no branch leaves last_error model-blind.
      withModel(withGoogleError(`HTTP ${execResult.status}: ${execResult.statusText || "Execution failed"}`, execResult.errorBody), currentModel),
    );

    return {
      ok: false,
      reason: "http_error",
      status: execResult.status,
      // `statusText` is optional on `GeminiExecutionResult` and genuinely goes missing: a test
      // double built through the `execute` seam can leave the field off entirely. Same rule as
      // the claim branch above — omit the key rather than forwarding a literal `undefined`, so
      // "no field was supplied" survives the boundary instead of being flattened into one.
      // Precise about what this does NOT do: the guard is `!== undefined`, so an empty
      // `statusText` — which is what HTTP/2 yields, having no reason phrase at all — still
      // forwards as `detail: ""`. A present-but-blank detail is left alone deliberately: it is
      // the transport's honest answer, and rewriting it here would be this file inventing a
      // story about a response it did not receive. `status` is always present and is the field
      // to branch on; `detail` is prose for a human reading a log.
      ...(execResult.statusText !== undefined ? { detail: execResult.statusText } : {}),
      errorBody: execResult.errorBody,
      attempts: attempt,
    };
  }

  // Loop exhausted. `lastFailure` is never cleared, so `lastKind` (set by each failure branch)
  // says which kind came LAST, and that kind names the exhaustion reason.
  if (lastKind === "key_rejected" && lastFailure !== null) {
    // Every attempt that ended the loop was a 401/403: report it as the terminal http_error.
    return {
      ok: false,
      reason: "http_error",
      status: lastFailure.status,
      detail: `every attempted key was rejected (last: ${lastFailure.detail})`,
      attempts: attempt,
    };
  }
  if (lastKind === "transient" && lastFailure !== null) {
    return {
      ok: false,
      reason: "upstream_unavailable",
      status: lastFailure.status,
      detail: lastFailure.detail,
      attempts: attempt,
    };
  }
  return {
    ok: false,
    reason: "rate_limited_all_retries_exhausted",
    attempts: attempt,
  };
}

// Standard helper to invoke Google Gemini REST API directly with failover.
// THE ONE PLACE THE DEFAULT MODEL ID LIVES. Every Gemini caller in the repo inherits it
// (none passes `model`), so a retired id here 404s the whole pipeline at once — the
// previous value, `gemini-1.5-flash`, was shut down 2025-09-29 and every call 404'd.
// `gemini-3.8-flash` is the current stable (GA) Flash text model as of 2026-10-04:
//   https://ai.google.dev/gemini-api/docs/models     (listed "Stable")
//   https://ai.google.dev/gemini-api/docs/changelog  (2026-09-02: "Released gemini-3.8-flash")
// Overridable per deployment with the GEMINI_MODEL secret, so the NEXT retirement is an
// env change and not a code deploy.
export const GEMINI_DEFAULT_MODEL = "gemini-3.8-flash";

// Resolve the model for one call: explicit option, then env, then the constant.
// A function rather than a module-level read because `Deno` does not exist under
// `node --test`, and the tests import this module.
function resolveModel(explicit: string | undefined): string {
  // An explicit per-call choice always wins — it is the most specific statement of intent.
  if (explicit !== undefined && explicit.trim().length > 0) return explicit.trim();
  // `globalThis.Deno` is absent under node, so probe it rather than reference it bare.
  const env = (globalThis as { Deno?: { env: { get(k: string): string | undefined } } }).Deno?.env.get("GEMINI_MODEL");
  // A blank secret must not become `models/:generateContent`, which would 404 as "model_not_found" for a reason nobody would guess.
  if (env !== undefined && env.trim().length > 0) return env.trim();
  // Nothing configured: the documented current default.
  return GEMINI_DEFAULT_MODEL;
}

// The optional fallback model: explicit option, then the GEMINI_FALLBACK_MODEL secret, else none.
// NO DEFAULT on purpose: an unset secret must mean "never switch" (today's behaviour), not a
// model id this file guessed, which is exactly how a retired id 404'd the pipeline before.
function resolveFallbackModel(explicit: string | undefined): string | undefined {
  // A per-call choice wins, as for the primary.
  if (explicit !== undefined && explicit.trim().length > 0) return explicit.trim();
  // Probed via globalThis because Deno is absent under node --test.
  const env = (globalThis as { Deno?: { env: { get(k: string): string | undefined } } }).Deno?.env.get("GEMINI_FALLBACK_MODEL");
  // Blank counts as unset, so an empty secret cannot become a model id.
  return env !== undefined && env.trim().length > 0 ? env.trim() : undefined;
}

export interface GenerateGeminiOptions {
  readonly model?: string;
  // Overrides GEMINI_FALLBACK_MODEL for this call; mainly a test seam, since no caller sets it.
  readonly fallbackModel?: string;
  // Clock seam for the backoff budget, forwarded to the failover loop.
  readonly now?: () => number;
  // Gemini `Tool` objects, forwarded VERBATIM as the request body's `tools` field —
  // e.g. `[{ google_search: {} }]` for Grounding with Google Search. Verbatim because the
  // Tool union is wide (googleSearch, urlContext, codeExecution, …) and a typed subset
  // here would be one more thing to fall out of date. REST field per
  // https://ai.google.dev/api/generate-content (Tool.googleSearch; the grounding guide's
  // curl spells it `google_search`, and the proto-JSON endpoint accepts both).
  readonly tools?: ReadonlyArray<Record<string, unknown>>;
  readonly prompt: {
    readonly systemInstruction: string;
    readonly userContent: string;
    readonly responseSchema?: Record<string, unknown>;
  };
  readonly fetchSeam?: typeof fetch;
  readonly maxRetries?: number;
  readonly readKey?: KeyReader;
  readonly pacer?: GeminiPacer;
  // Test seams forwarded to the failover loop (see GeminiFailoverOptions).
  readonly sleep?: (ms: number) => Promise<void>;
  readonly random?: () => number;
  // Per-attempt fetch timeout in ms (default 25000). Without one a hung upstream (gemini-3.7-flash
  // hung 60s instead of answering 503) would stall the whole Edge Function. Worst-case wall clock
  // with defaults: 4 attempts x 25s + 13.75s backoff = 113.75s, so callers on a short Edge budget
  // should pass a smaller `timeoutMs` and/or `maxRetries`.
  readonly timeoutMs?: number;
}

export interface GeminiResponseBody {
  readonly candidates?: Array<{
    readonly content?: {
      readonly parts?: Array<{
        readonly text?: string;
      }>;
    };
    readonly finishReason?: string;
    // Populated only on grounded calls (`tools: [{ google_search: {} }]`): the search
    // queries, sources and citation spans. Typed `unknown` on purpose — it is untrusted
    // API output, and the consumer must shape-check it rather than inherit a guess here.
    readonly groundingMetadata?: unknown;
  }>;
}

export async function generateGeminiContent(
  db: SupabaseClient,
  options: GenerateGeminiOptions,
): Promise<GeminiCallOutcome<GeminiResponseBody>> {
  // Explicit option, then GEMINI_MODEL, then GEMINI_DEFAULT_MODEL — see resolveModel.
  const model = resolveModel(options.model);
  // Resolved once per call, like the primary; undefined means no switch can happen.
  const fallbackModel = resolveFallbackModel(options.fallbackModel);
  // Network seam, so tests never reach Google.
  const fetchFn = options.fetchSeam ?? fetch;
  // Per-attempt timeout; see GenerateGeminiOptions.timeoutMs for the wall-clock arithmetic.
  const timeoutMs = options.timeoutMs ?? 25000;

  // REFUSE grounding + JSON schema rather than silently dropping one. Gemini 2.x rejects
  // the combination outright; the structured-output guide
  // (https://ai.google.dev/gemini-api/docs/structured-output) lists it for Gemini 3 only
  // as a PREVIEW feature. Fail closed until that is GA: dropping the schema would hand the
  // caller free text it will try to JSON.parse, and dropping the tools would return
  // ungrounded "facts" that look grounded. Checked before claiming a key, so it is free.
  if (options.tools !== undefined && options.tools.length > 0 && options.prompt.responseSchema !== undefined) {
    // A typed failure, not a throw: every caller already branches on `outcome.ok`.
    return {
      ok: false,
      reason: "invalid_request",
      detail: "tools (e.g. google_search grounding) cannot be combined with responseSchema / JSON mode; send one or the other",
      attempts: 0,
    };
  }

  const requestBody = {
    contents: [
      {
        role: "user",
        parts: [{ text: options.prompt.userContent }],
      },
    ],
    systemInstruction: {
      parts: [{ text: options.prompt.systemInstruction }],
    },
    generationConfig: options.prompt.responseSchema
      ? {
          responseMimeType: "application/json",
          responseSchema: options.prompt.responseSchema,
        }
      : undefined,
    // Forwarded only when given: an empty or absent `tools` key is an ungrounded call, and
    // omitting the key keeps every existing caller's request byte-identical.
    ...(options.tools !== undefined && options.tools.length > 0 ? { tools: options.tools } : {}),
  };

  const outcome = await callGeminiWithFailover<GeminiResponseBody>(db, {
    // All three of these are optional on BOTH sides: `GenerateGeminiOptions` lets a caller
    // leave them off, and `callGeminiWithFailover` supplies its own defaults for them
    // (`?? 3`, `?? denoKeyReader`, `?? defaultGeminiPacer`). Forwarding them unconditionally
    // says "I am passing a value, and that value is undefined", which under
    // `exactOptionalPropertyTypes` is a distinct type from passing nothing — hence TS2379.
    // Be explicit about what this is NOT: `??` collapses absent and present-and-undefined
    // identically, so behaviour is unchanged by this edit and there is no bug here to hunt
    // for. What changes is that the type now records the same thing the runtime does, which
    // is the whole point of the flag — a pass-through should not invent a value the caller
    // never gave, because the next optional we add here may not have a `??` waiting for it.
    ...(options.maxRetries !== undefined ? { maxRetries: options.maxRetries } : {}),
    ...(options.readKey !== undefined ? { readKey: options.readKey } : {}),
    ...(options.pacer !== undefined ? { pacer: options.pacer } : {}),
    // Same spread-only-when-defined rule for the backoff seams (exactOptionalPropertyTypes).
    ...(options.sleep !== undefined ? { sleep: options.sleep } : {}),
    ...(options.random !== undefined ? { random: options.random } : {}),
    // The id this call's URL is built from, so last_error records it MEASURED, not inferred.
    model,
    // Lets the loop size its backoff to the budget the caller planned with this same timeout.
    attemptTimeoutMs: timeoutMs,
    // Spread only when set (exactOptionalPropertyTypes); unset keeps the loop from ever switching.
    ...(fallbackModel !== undefined ? { fallbackModel } : {}),
    // Same spread rule for the clock seam.
    ...(options.now !== undefined ? { now: options.now } : {}),
    // `attemptModel` is the loop's per-attempt choice; `?? model` only satisfies the type, since
    // the loop always passes the primary or the fallback.
    execute: async (apiKey: string, _keyIndex: number, attemptModel: string | undefined) => {
      // NO key in the URL: a URL travels into error messages, stack traces, proxy/CDN logs and
      // `Response.url` (kept on `rawResponse`), while a header does not. The key goes only in
      // the `x-goog-api-key` header below.
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${attemptModel ?? model}:generateContent`;
      try {
        const response = await fetchFn(url, {
          method: "POST",
          // The API key rides in the header so no URL-derived string can ever carry it.
          headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
          body: JSON.stringify(requestBody),
          // Abort a hung attempt; the rejection lands in the catch below as status 0 (transient).
          signal: AbortSignal.timeout(timeoutMs),
        });

        if (response.ok) {
          // A malformed SUCCESS body is not an outage: parse separately so it does not fall into
          // the outer catch (status 0 = transient) and get retried 4x as a "network error".
          let json: GeminiResponseBody;
          try {
            json = (await response.json()) as GeminiResponseBody;
          } catch {
            // Status 200 is not transient, so the loop's terminal http_error branch takes it.
            return { ok: false, status: 200, statusText: "invalid JSON body" };
          }
          return { ok: true, data: json };
        }

        let errorBody: unknown = null;
        try {
          errorBody = await response.json();
        } catch {
          errorBody = await response.text();
        }

        return {
          ok: false,
          status: response.status,
          statusText: response.statusText,
          errorBody,
          rawResponse: response,
        };
      } catch (err) {
        // AbortSignal.timeout rejects with a TimeoutError (older runtimes: AbortError); name it so
        // the log says "timeout" instead of a cryptic "The operation was aborted due to timeout".
        const timedOut = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
        return {
          ok: false,
          status: 0,
          statusText: timedOut ? `timeout after ${timeoutMs}ms` : err instanceof Error ? err.message : String(err),
        };
      }
    },
  });

  // NO FAIL-OPEN ON AN EMPTY 200: `response.ok` says the transport worked, not that Gemini
  // answered. Every caller consumes TEXT (grounded scout-web included), so success requires
  // candidates[0].content.parts to hold at least one non-empty string `text`. `candidates: []`,
  // `[{}]`, `[null]` and `[{finishReason:"SAFETY"}]` are the usual shapes of a blocked or
  // truncated answer, and passing them on as ok:true lets callers parse "nothing" as an answer.
  // Terminal, and the key is not blamed (no reportResult(false)): a retry resends the same prompt.
  if (outcome.ok) {
    // The body is untrusted JSON and may be literally `null`: check it is an object BEFORE
    // reading `.candidates`, or the TypeError escapes a function that promises outcomes.
    const body = outcome.data as unknown;
    const record = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : null;
    // Anything but an array counts as "no candidates".
    const candidates = record !== null && Array.isArray(record.candidates) ? (record.candidates as unknown[]) : [];
    // `[null]` and `[{}]` both normalise to a candidate without content.
    const first = (candidates[0] ?? null) as { content?: { parts?: unknown }; finishReason?: unknown } | null;
    const parts = Array.isArray(first?.content?.parts) ? (first!.content!.parts as unknown[]) : [];
    // Only a part whose `text` is a non-empty string counts (`parts:[{text:""}]` is empty).
    const hasText = parts.some((part) => {
      const text = (part as { text?: unknown } | null)?.text;
      return typeof text === "string" && text.length > 0;
    });
    if (!hasText) {
      // finishReason and blockReason say WHY it is empty (SAFETY, MAX_TOKENS, ...); both are
      // untrusted, so only strings are echoed into the detail.
      const finish = typeof first?.finishReason === "string" ? ` (finishReason: ${first.finishReason})` : "";
      const feedback = record?.promptFeedback as { blockReason?: unknown } | null | undefined;
      const block = typeof feedback?.blockReason === "string" ? ` (promptFeedback.blockReason: ${feedback.blockReason})` : "";
      return {
        ok: false,
        reason: "empty_response",
        status: 200,
        detail: `Gemini returned 200 with no text part${finish}${block}`,
        attempts: outcome.attempts,
      };
    }
  }
  return outcome;
}
