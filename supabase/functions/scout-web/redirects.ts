// GROUNDING REDIRECT RESOLVER — recovers the real URL behind Gemini's search citations.
//
// WHY THIS EXISTS: with tools:[{google_search:{}}], groundingMetadata does not hand back the
// cited page. It hands back `https://vertexaisearch.cloud.google.com/grounding-api-redirect/…`,
// which urls.ts correctly refuses (host_not_allowed). So almost every grounded result was lost
// at the shape check. This module reads ONE redirect hop and hands the Location to that same
// strict check. It never replaces the check.
//
// WHAT IT DELIBERATELY DOES NOT DO:
// - It fetches nothing except the exact Google redirect host. Model text cannot point this
//   code at an arbitrary server, which keeps the resolver from becoming an SSRF primitive.
// - It never follows the Location. The board lookup in core.ts does the only fetch of the
//   ATS side, through robots and the shared transport. Following the hop here would skip both.
// - It never reads a response body. The header is the whole answer, and a body is bandwidth
//   spent inside an Edge Function's wall-clock budget.

// The one host whose URLs we resolve. Exact equality only, never a suffix or `includes`, so
// `vertexaisearch.cloud.google.com.evil.com` is not fetched (same rule as urls.ts RULES).
export const GROUNDING_REDIRECT_HOST = "vertexaisearch.cloud.google.com";

// Default per-request budget. Five seconds: a healthy redirect answers in well under one, and
// MAX_CANDIDATES of these behind a small semaphore must still fit the function's time budget.
export const REDIRECT_TIMEOUT_MS = 5_000;

// The injected fetch seam. Shaped like the global fetch so production passes `fetch` itself,
// and tests pass a fake that never touches the network.
export type RedirectFetch = (url: string, init: { redirect: "manual"; signal: AbortSignal }) => Promise<Response>;

// Closed result: a caller must handle the reason, not merely a null.
export type RedirectResult =
  // The Location, absolute and https, still UNVERIFIED. parseJobUrl decides if it is a posting.
  | { readonly ok: true; readonly url: string }
  // Refused, with a short machine-readable cause the UI displays like any other rejection.
  | { readonly ok: false; readonly reason: string };

// True only for a URL this module is allowed to fetch: https, exact host, no userinfo or port.
export function isGroundingRedirect(raw: string): boolean {
  // `new URL` only splits the string. The verdict is the exact checks below.
  let url: URL;
  // A throw means it is not a URL, so it is not one of ours.
  try {
    // May throw on garbage, which simply means "not a redirect".
    url = new URL(raw);
  // The failure is the answer: hand it to parseJobUrl, which reports not_a_url.
  } catch {
    // Not ours to resolve.
    return false;
  }
  // https only, so the request that leaves this function is never a plaintext one.
  if (url.protocol !== "https:") return false;
  // Userinfo and custom ports are the lookalike tricks urls.ts also refuses.
  if (url.username !== "" || url.password !== "" || url.port !== "") return false;
  // The SSRF guard: only this exact host is ever fetched. `hostname` is already lower-cased.
  return url.hostname === GROUNDING_REDIRECT_HOST;
}

// Read ONE redirect hop. Never throws: every failure becomes a reason.
export async function resolveGroundingRedirect(
  // A URL that already passed isGroundingRedirect. Re-checked below anyway.
  raw: string,
  // The network seam: global fetch in production, a fake in tests.
  fetchFn: RedirectFetch,
  // Injectable so the timeout test runs in milliseconds, not five seconds.
  timeoutMs: number = REDIRECT_TIMEOUT_MS,
): Promise<RedirectResult> {
  // Defense in depth: this function fetches, so it enforces its own precondition and does not
  // trust the caller to have filtered.
  if (!isGroundingRedirect(raw)) return { ok: false, reason: "redirect_host_not_allowed" };
  // One abort signal for the whole exchange. Fired by the timer, it ends a stuck connection.
  const signal = AbortSignal.timeout(timeoutMs);
  // Held outside the try so the body can be released after the header is read.
  let res: Response;
  // A network failure or timeout costs this one candidate, never the run.
  try {
    // redirect:'manual' gives us the 3xx itself rather than silently fetching the target.
    res = await fetchFn(raw, { redirect: "manual", signal });
  // Converted into a reason, as the contract promises.
  } catch {
    // Telling timeout apart from other failures shows whether Google is slow or unreachable.
    return { ok: false, reason: signal.aborted ? "redirect_timeout" : "redirect_fetch_failed" };
  }
  // Read the header before releasing the response.
  const location = res.headers.get("location");
  // Free the connection without reading it. A rejected cancel just means no body was open.
  await res.body?.cancel().catch(() => {});
  // Only a real redirect status counts. A 200 that happens to carry a Location is not a redirect.
  if (res.status < 300 || res.status > 399) return { ok: false, reason: `redirect_status_${res.status}` };
  // A 3xx with no target leaves nothing to check.
  if (location === null || location.trim() === "") return { ok: false, reason: "redirect_no_location" };
  // Resolve a relative Location against the redirect URL. A relative one lands back on the
  // Google host, which parseJobUrl then refuses. That is the max-one-hop rule in effect.
  let target: URL;
  // A malformed header must not throw out of a function that promises not to.
  try {
    // Absolute form, so the caller's shape check sees exactly what a browser would visit.
    target = new URL(location, raw);
  // The failure is the answer.
  } catch {
    // An unparseable Location is a refusal, not a crash.
    return { ok: false, reason: "redirect_bad_location" };
  }
  // Never hand on a downgraded or exotic scheme (http:, javascript:, data:).
  if (target.protocol !== "https:") return { ok: false, reason: "redirect_not_https" };
  // Still unverified. The caller MUST run parseJobUrl on it. We have only learned where it points.
  return { ok: true, url: target.href };
}
