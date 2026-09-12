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
        | "http_error";
      readonly status?: number;
      readonly detail?: string;
      readonly errorBody?: unknown;
      readonly attempts: number;
    };

export interface GeminiFailoverOptions<T> {
  // The actual execution function using the claimed key.
  readonly execute: (apiKey: string, keyIndex: number) => Promise<GeminiExecutionResult<T>>;
  // Maximum number of 429 failover attempts before giving up (default 3).
  readonly maxRetries?: number;
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

// In-Flight Multi-Key Retry Middleware (1a) with Pacing (1c).
export async function callGeminiWithFailover<T>(
  db: SupabaseClient,
  options: GeminiFailoverOptions<T>,
): Promise<GeminiCallOutcome<T>> {
  const maxRetries = Math.max(0, options.maxRetries ?? 3);
  const readKey = options.readKey ?? denoKeyReader;
  const pacer = options.pacer ?? defaultGeminiPacer;

  let attempt = 0;

  while (attempt <= maxRetries) {
    attempt += 1;

    // 1. Claim a key atomically from the Postgres pool.
    const claim: KeyClaim = await claimKey(db, readKey);

    if (!claim.ok) {
      // If no key is eligible (cooling, unconfigured, or db error), exit immediately.
      return {
        ok: false,
        reason: claim.reason,
        detail: "detail" in claim ? claim.detail : undefined,
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

      // Continue to next iteration without aborting!
      continue;
    }

    // 5. On other non-429 HTTP errors (e.g. 400 Bad Request, 500 Internal Error):
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
      detail: execResult.statusText,
      errorBody: execResult.errorBody,
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
export interface GenerateGeminiOptions {
  readonly model?: string;
  readonly prompt: {
    readonly systemInstruction: string;
    readonly userContent: string;
    readonly responseSchema?: Record<string, unknown>;
  };
  readonly fetchSeam?: typeof fetch;
  readonly maxRetries?: number;
  readonly readKey?: KeyReader;
  readonly pacer?: GeminiPacer;
}

export interface GeminiResponseBody {
  readonly candidates?: Array<{
    readonly content?: {
      readonly parts?: Array<{
        readonly text?: string;
      }>;
    };
    readonly finishReason?: string;
  }>;
}

export async function generateGeminiContent(
  db: SupabaseClient,
  options: GenerateGeminiOptions,
): Promise<GeminiCallOutcome<GeminiResponseBody>> {
  const model = options.model ?? "gemini-1.5-flash";
  const fetchFn = options.fetchSeam ?? fetch;

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
  };

  return await callGeminiWithFailover<GeminiResponseBody>(db, {
    maxRetries: options.maxRetries,
    readKey: options.readKey,
    pacer: options.pacer,
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
}
