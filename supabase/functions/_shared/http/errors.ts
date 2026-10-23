// Typed errors for the shared HTTP transport.
//
// WHY CLASSES RATHER THAN ERROR CODES OR MESSAGE MATCHING — this is the load-bearing
// decision of this file. The Scout has to branch on WHAT went wrong, across a module
// boundary. If the transport signalled "this was bot protection" by wording its
// message a particular way, every caller would be coupled to that wording, and the
// first person to improve the sentence would silently break the branch with a change
// that looks purely cosmetic and passes review. `instanceof` couples the caller to a
// type instead, which the compiler keeps honest.
//
// The hierarchy is deliberate: `BotProtectionError extends HttpError`, so a caller
// that only cares "the request failed with a status" catches the parent and still
// sees WAF refusals, while a caller that wants to route them somewhere specific can
// narrow. Making them siblings would have forced every generic handler to list both.

// A non-2xx response the transport decided not to retry past, or exhausted retries on.
//
// Carries the status and the URL rather than only a message because the Scout records
// polling telemetry per board: a caller that has to regex the status back out of a
// sentence cannot write that row without re-parsing our prose.
export class HttpError extends Error {
  // The HTTP status that ended the request. Kept as a number so a caller can compare
  // ranges (`>= 500`) instead of string-matching what we happened to print.
  readonly status: number;
  // The reason phrase as served. Frequently empty on HTTP/2, which is why it is never
  // the thing anyone branches on — it is here for diagnostics only.
  readonly statusText: string;
  // The URL that produced this. Present because one Scout run polls many boards and a
  // bare "HTTP 503" in a log tells nobody which board is down.
  readonly url: string;
  // How many attempts were actually spent. This is what distinguishes "failed fast on
  // a 400" from "ground through all seven on a 500", which read identically otherwise
  // and imply completely different follow-up.
  readonly attempts: number;

  constructor(url: string, status: number, statusText: string, attempts: number) {
    // The message keeps upstream's shape (status + statusText) because the exhaustion
    // and 4xx tests match on the status appearing in the message, and because a human
    // reading a log wants it inline rather than having to inspect properties.
    super(`HTTP request failed: ${status} ${statusText} (${url}, ${attempts} attempt(s))`);
    // Set explicitly: subclassing Error does not set `name` from the class, and an
    // error whose name is the generic "Error" is worse in a log than one that says
    // what kind of failure it was.
    this.name = 'HttpError';
    this.status = status;
    this.statusText = statusText;
    this.url = url;
    this.attempts = attempts;
  }
}

// A WAF or bot-protection challenge, detected from the status plus the body.
//
// WHY THIS IS NOT A RETRYABLE FAILURE, even though it arrives on statuses (429, 503)
// that normally are: a challenge page is not a transient server state. The server is
// working perfectly and is telling us no. Retrying it seven times over ~30s of backoff
// produces seven identical challenge pages and then reports a generic 503 — which
// tells the operator nothing about what to do. Upstream checked for this only AFTER
// its loop finished and only on 403, so a WAF-driven 503 burned its whole budget.
export class BotProtectionError extends HttpError {
  constructor(url: string, status: number, statusText: string, attempts: number) {
    // The parent builds the status-bearing message; we replace it with an ACTIONABLE
    // one. Upstream's voice is worth keeping: say what the operator should do next,
    // not merely that something failed.
    super(url, status, statusText, attempts);
    this.name = 'BotProtectionError';
    // Overwritten after `super` because the parent's constructor owns the base
    // message and we want the actionable text to be what surfaces in a log line.
    this.message =
      `bot protection challenge from ${url} (HTTP ${status}). This host is refusing ` +
      `automated requests. Do NOT retry and do NOT present a browser User-Agent — ` +
      `skip this source and record it as unavailable.`;
  }
}

// A `fetch` that threw rather than responding: DNS failure, connection refused, or an
// AbortSignal firing (our own timeout, or a caller cancelling).
//
// WHY THIS IS SEPARATE FROM HttpError: there is no status. Forcing it into HttpError
// would mean inventing one (0? 599?), and an invented status is a number a caller will
// eventually compare against a real range and get a wrong answer from.
export class NetworkError extends Error {
  // The URL that could not be reached, for the same per-board diagnostic reason.
  readonly url: string;
  // Attempts spent before giving up. Normally 1, because the default is fail-fast.
  readonly attempts: number;

  constructor(url: string, attempts: number, cause: unknown) {
    // The underlying message is interpolated rather than only attached as `cause`,
    // because Deno and Node print `cause` differently and a log line that omits it
    // leaves the reader with "could not reach X" and no reason.
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(`could not reach ${url} after ${attempts} attempt(s): ${detail}`);
    this.name = 'NetworkError';
    this.url = url;
    this.attempts = attempts;
    // Standard ES2022 `cause`, available in both runtimes. Kept so a caller that wants
    // the original AbortError (to distinguish a timeout from a DNS failure) still can.
    this.cause = cause;
  }
}

// The robots.txt gate refused this URL, so the transport never sent the request.
//
// WHY THIS IS SEPARATE FROM HttpError: there is no status from the TARGET — the target
// was never contacted, which is the entire point. Inventing a status (0? 999?) would
// hand callers a number they will eventually compare against a real range. Like
// NetworkError, it stands alone and carries structured fields instead.
//
// WHY REFUSAL IS AN ERROR AND NOT A null/empty RETURN: a silent empty result reads as
// "the board had nothing today", which hides a policy refusal inside a normal outcome —
// exactly the missing-data-becomes-an-answer pattern (CLAUDE.md §6). A thrown, typed
// refusal forces every caller to decide what a refusal means for ITS domain.
export class RobotsDisallowedError extends Error {
  // The URL the gate refused, for per-board diagnostics like every sibling error.
  readonly url: string;
  // 'refuse' = the policy (or its absence of an answer) forbids the fetch;
  // 'wait' = the host rate-limited the robots fetch and asked us to come back.
  // The union mirrors RobotsVerdict's non-allow arms so nothing is flattened away.
  readonly verdict: "refuse" | "wait";
  // The machine-readable RobotsSource kind behind a refusal (e.g. 'not-robots-txt',
  // 'refused-by-host'), or null for a 'wait'. `null`, not optional: under
  // `exactOptionalPropertyTypes` an optional field invites `undefined` writes, and a
  // reader branching on it should see an explicit "no source" rather than a hole.
  readonly source: string | null;

  constructor(url: string, verdict: "refuse" | "wait", reason: string, source: string | null) {
    // The gate's own reason is the message: it already names the rule or the failure
    // (master-robots writes them for humans), so wrapping it would only add noise.
    super(`robots.txt gate refused ${url}: ${reason}`);
    this.name = "RobotsDisallowedError";
    this.url = url;
    this.verdict = verdict;
    this.source = source;
  }
}

// A server-supplied `Retry-After` longer than we are willing to wait.
//
// WHY THIS IS AN ERROR RATHER THAN A CLAMP — the tempting alternative is to wait the
// maximum we allow and try anyway. That is strictly worse: the server told us exactly
// how long it needs, so retrying sooner than asked GUARANTEES another 429 and pushes
// us toward a ban. Giving up and surfacing the requested delay lets the caller
// reschedule honestly instead of burning goodwill.
export class RetryAfterTooLongError extends HttpError {
  // What the server actually asked for, in ms, so a scheduler can use it.
  readonly retryAfterMs: number;

  constructor(url: string, status: number, statusText: string, attempts: number, retryAfterMs: number, capMs: number) {
    super(url, status, statusText, attempts);
    this.name = 'RetryAfterTooLongError';
    this.retryAfterMs = retryAfterMs;
    this.message =
      `${url} returned HTTP ${status} and asked us to wait ${retryAfterMs}ms, which ` +
      `exceeds the ${capMs}ms cap. Not retrying: waiting less than asked would only ` +
      `earn another ${status}. Reschedule this source instead.`;
  }
}
