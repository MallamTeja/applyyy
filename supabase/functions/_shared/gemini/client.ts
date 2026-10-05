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
  // The actual execution function using the claimed key.
  readonly execute: (apiKey: string, keyIndex: number) => Promise<GeminiExecutionResult<T>>;
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
  // Optional rotation hook for logging / metrics.
  readonly onKeyRotated?: (info: {
    readonly fromKeyIndex: number;
    readonly retryAfterSeconds: number | null;
    readonly attempt: number;
  }) => void;
}

// Statuses worth retrying on another key: gateway/overload errors and 0 (network/timeout).
const TRANSIENT_STATUSES: ReadonlySet<number> = new Set([0, 500, 502, 503, 504]);
// Base backoff per attempt. Worst case with defaults (3 sleeps): 1000+3000+7000 = 11000 ms,
// plus up to 25% jitter = 13750 ms, well under the 25 s budget an Edge Function can spare.
const BACKOFF_BASE_MS: readonly number[] = [1000, 3000, 7000];

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

  let attempt = 0;
  // Which kind of failure ended the LAST attempt decides the exhausted-loop reason, so both
  // kinds share one loop but are still reported honestly.
  let lastFailure: { readonly status: number; readonly detail: string } | null = null;
  // True when the most recent failure was a 429 (overrides an earlier transient one).
  let lastWasRateLimit = false;

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
    const execResult = await pacer.pace(() => options.execute(apiKey, keyIndex));

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

      const errorText =
        typeof execResult.errorBody === "object" && execResult.errorBody !== null
          ? JSON.stringify(execResult.errorBody)
          : execResult.statusText ?? "429 Too Many Requests";

      await reportResult(db, keyIndex, false, retryAfterSeconds, `HTTP 429: ${errorText}`);

      options.onKeyRotated?.({
        fromKeyIndex: keyIndex,
        retryAfterSeconds,
        attempt,
      });

      // The last failure is now a 429, so exhaustion must report the quota reason.
      lastWasRateLimit = true;
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
        detail: "Gemini returned 404 for generateContent: the model id is retired or wrong; set GEMINI_MODEL or update GEMINI_DEFAULT_MODEL",
        errorBody: execResult.errorBody,
        attempts: attempt,
      };
    }

    // 4c. TRANSIENT upstream failure: 500/502/503/504, or status 0 (network error / timeout from
    // `execute`'s catch). Live evidence: gemini-3.8-flash intermittently answered 503 and the
    // old code gave up after one call. The outage is the MODEL's, not the key's, so the key is
    // reported with a NULL retry_after (the SQL then leaves cooldown_until alone) and the next
    // iteration claims the next key. Checked before the terminal branch below.
    if (TRANSIENT_STATUSES.has(execResult.status)) {
      // Status 0 has no HTTP line; say "network error" so the health page is not misleading.
      const detail =
        execResult.status === 0
          ? `network error: ${execResult.statusText ?? "unknown"}`
          : `HTTP ${execResult.status}: ${execResult.statusText ?? "Service error"}`;
      await reportResult(db, keyIndex, false, null, detail);
      // Remembered for the exhausted-loop return at the bottom.
      lastFailure = { status: execResult.status, detail };
      lastWasRateLimit = false;
      options.onKeyRotated?.({ fromKeyIndex: keyIndex, retryAfterSeconds: null, attempt });
      // Never sleep after the final attempt: nothing follows it, so waiting only delays the error.
      if (attempt <= maxRetries) {
        // Clamp attempts past the table to the last delay.
        const base = BACKOFF_BASE_MS[Math.min(attempt, BACKOFF_BASE_MS.length) - 1]!;
        // 0-25% jitter so concurrent callers do not retry the overloaded model in lockstep.
        await sleep(base + base * 0.25 * random());
      }
      continue;
    }

    // 5. On other NON-TRANSIENT, non-429, non-404 HTTP errors (e.g. 400 Bad Request, 401/403):
    // Record error against key and fail closed — rotating keys won't fix a malformed payload.
    await reportResult(
      db,
      keyIndex,
      false,
      null,
      `HTTP ${execResult.status}: ${execResult.statusText ?? "Execution failed"}`,
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

  // Loop exhausted. Only transient failures set `lastFailure`, and a later 429 must win the
  // label, so clear-on-429 is done here by checking which branch ran last (see 429 branch).
  if (lastFailure !== null && !lastWasRateLimit) {
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

export interface GenerateGeminiOptions {
  readonly model?: string;
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
  // Network seam, so tests never reach Google.
  const fetchFn = options.fetchSeam ?? fetch;

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
    execute: async (apiKey: string) => {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
      try {
        const response = await fetchFn(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(requestBody),
        });

        if (response.ok) {
          const json = (await response.json()) as GeminiResponseBody;
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
        return {
          ok: false,
          status: 0,
          statusText: err instanceof Error ? err.message : String(err),
        };
      }
    },
  });

  // NO FAIL-OPEN ON AN EMPTY 200: `response.ok` says the transport worked, not that Gemini
  // answered. A body without a non-empty `candidates` array is usually a safety block, and
  // handing it on as ok:true would let callers parse "nothing" as an answer. Terminal, and the
  // key is not blamed (no reportResult(false)): a retry resends the same prompt to the same block.
  if (outcome.ok && !(Array.isArray(outcome.data.candidates) && outcome.data.candidates.length > 0)) {
    // `promptFeedback` is untrusted API output, so probe it defensively.
    const feedback = (outcome.data as { promptFeedback?: { blockReason?: unknown } }).promptFeedback;
    const block = typeof feedback?.blockReason === "string" ? ` (promptFeedback.blockReason: ${feedback.blockReason})` : "";
    return {
      ok: false,
      reason: "empty_response",
      status: 200,
      detail: `Gemini returned 200 with no candidates${block}`,
      attempts: outcome.attempts,
    };
  }
  return outcome;
}
