// The public surface of the shared HTTP transport.
//
// WHY A BARREL AT ALL, when Deno is perfectly happy importing the individual files:
// the module's callers are the Scout (an Edge Function) and the worker, and both
// should depend on ONE specifier. The internal split into transport / errors /
// retry-after / concurrency exists so each piece can be tested in isolation; it is not
// a shape callers should have to learn, and pinning it here means the files can be
// reorganised later without editing every call site.
//
// START HERE: `createHttpClient` for anything polling more than one host,
// `httpFetch` / `httpJson` / `httpText` for a single one-off request.

// The core loop and its per-request options.
export {
  DEFAULT_BASE_DELAY_MS,
  DEFAULT_JITTER_MS,
  DEFAULT_MAX_DELAY_MS,
  DEFAULT_MAX_RETRIES,
  DEFAULT_MAX_RETRY_AFTER_MS,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_USER_AGENT,
  defaultIsRetryableStatus,
  httpFetch,
  httpJson,
  httpText,
} from "./transport.ts";
// Types are re-exported separately because `verbatimModuleSyntax` is on: a type
// exported through a value export would survive into the emitted JS as a broken
// reference under Node's type stripper.
export type { HttpRequestOptions, NotFoundMode, RetryPolicy } from "./transport.ts";

// The typed failures callers branch on with `instanceof`.
export { BotProtectionError, HttpError, NetworkError, RetryAfterTooLongError } from "./errors.ts";

// The semaphore, exported because a caller that already has its own work queue may
// want to bound something other than HTTP with the same primitive.
export { createSemaphore } from "./concurrency.ts";
export type { Semaphore } from "./concurrency.ts";

// The header parser, exported mainly so a caller implementing its own scheduler can
// reuse the same two-wire-format handling rather than writing a second, subtly
// different one.
export { parseRetryAfterMs } from "./retry-after.ts";

// Imported (not just re-exported) because the client factory below composes them.
import { createSemaphore } from "./concurrency.ts";
import { httpFetch, httpJson, httpText, type HttpRequestOptions } from "./transport.ts";

// How many requests one client may have in flight at once.
//
// 4 is deliberately conservative. The Scout polls a watchlist that is tens of rows,
// not thousands, and the cost of being too polite is a slightly longer run while the
// cost of being too aggressive is a 429 storm from the very hosts whose 429s the retry
// loop exists to survive. A number that has to be wrong in one direction should be
// wrong in the direction that does not get us rate-limited.
export const DEFAULT_MAX_CONCURRENT = 4;

// Options for a client, as distinct from options for a single request.
export interface HttpClientOptions {
  // The concurrency cap shared by every request this client makes.
  readonly maxConcurrent?: number;
  // Request options applied to every call, which a per-call options object overrides
  // field by field. This is what lets a caller set its User-Agent or timeout once.
  readonly defaults?: HttpRequestOptions;
}

// A transport bound to one concurrency cap and one set of defaults.
export interface HttpClient {
  // Raw response, or null for a 404 under the 'null'/'empty' modes.
  fetch(url: string, options?: HttpRequestOptions): Promise<Response | null>;
  // Parsed JSON, or null for a 404 under the 'null'/'empty' modes.
  json<T>(url: string, options?: HttpRequestOptions): Promise<T | null>;
  // Body text; "" rather than null when the mode is 'empty'.
  text(url: string, options?: HttpRequestOptions): Promise<string | null>;
  // In-flight count, exposed ONLY so tests can assert the cap holds.
  readonly inFlight: number;
}

// Build a transport whose requests share one concurrency cap.
//
// WHY A FACTORY RATHER THAN A MODULE-LEVEL CAP: a module global would make two
// independent callers throttle each other invisibly — the robots.txt gate and a board
// poll would contend for the same slots despite having nothing to do with one another
// — and it would make tests order-dependent, because `node --test` runs files in one
// process and a leaked in-flight count would cross between them.
//
// A REQUEST HOLDS ITS SLOT ACROSS ITS OWN RETRIES. That is the correct reading of a
// concurrency cap (it bounds in-flight sockets, and a backing-off request still owns
// its conversation with the host), and it is also what stops a rate-limited host from
// being hammered by fresh requests while an earlier one waits out its backoff. Stated
// here because a later reader would otherwise reasonably assume it was an oversight
// and "fix" it by releasing around the sleep.
export function createHttpClient(options: HttpClientOptions = {}): HttpClient {
  // One semaphore per client, created here so it is captured by all three methods.
  const semaphore = createSemaphore(options.maxConcurrent ?? DEFAULT_MAX_CONCURRENT);
  // Client-wide defaults, normalised once so each method does not repeat the `?? {}`.
  const defaults = options.defaults ?? {};

  // Merge client defaults with per-call options.
  //
  // Headers are merged one level deeper than the rest: a caller adding an `Accept`
  // should not silently drop a User-Agent the client set for every request. Everything
  // else is a scalar where last-write-wins is the obvious reading.
  function merge(perCall: HttpRequestOptions | undefined): HttpRequestOptions {
    return {
      ...defaults,
      ...(perCall ?? {}),
      headers: { ...(defaults.headers ?? {}), ...(perCall?.headers ?? {}) },
      // Retry policy is merged field-wise for the same reason: a caller overriding
      // only `maxRetries` should keep the client's `timeoutMs` rather than reverting
      // the whole policy to defaults.
      retry: { ...(defaults.retry ?? {}), ...(perCall?.retry ?? {}) },
    };
  }

  return {
    get inFlight(): number {
      return semaphore.inFlight;
    },
    fetch(url, perCall) {
      return semaphore.run(() => httpFetch(url, merge(perCall)));
    },
    json<T>(url: string, perCall?: HttpRequestOptions) {
      return semaphore.run(() => httpJson<T>(url, merge(perCall)));
    },
    text(url, perCall) {
      return semaphore.run(() => httpText(url, merge(perCall)));
    },
  };
}
