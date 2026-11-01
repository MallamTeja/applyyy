// POST /api/render-job-page — render ONE public job page in headless Chromium and return its text.
//
// WHY THIS EXISTS (Teja, 2026-11-01 ~17:19 IST): the paste-the-job-text box is gone, so when the
// job-link-intake Edge Function cannot read a page with a plain fetch (a JavaScript-only board), it
// forwards the caller's login JWT here. Supabase Edge Functions cannot run a browser; a Vercel Node
// function can (playwright-core + @sparticuz/chromium). No new secret: the caller's own JWT is
// checked against Supabase Auth with the PUBLIC anon key the web bundle already ships.
//
// CONTRACT (job-link-intake is built against it; do not change it here alone):
//   POST, authorization: Bearer <Supabase user JWT>, body {"url": "<https url, <= 2000 chars>"}
//   200 {"status":"ok","text","final_url"} | 400 {"status":"refused","message"}
//   401 {"status":"unauthorized","message"} | 405 non-POST | 502 {"status":"error","message"}
//
// SECURITY (SSRF): a stranger's link makes OUR server run a full browser, so four layers, each of
// which refuses the Lambda runtime API (http://127.0.0.1:9001) and 169.254.169.254 on its own:
//   1. SHAPE: https only, no port, no userinfo, no IP literal, no private name (checkPublicUrl),
//      for the pasted link, every redirect hop and every subresource. The http + IP-literal + port
//      rule alone already stops http://127.0.0.1:9001.
//   2. ADDRESS AT CONNECT TIME: Chromium never fetches anything itself. Every request is
//      intercepted (context.route) and re-made by Node over node:https, whose `lookup` hook refuses
//      the WHOLE DNS answer if any address is private. The address that was checked is the address
//      the socket connects to, so a DNS-rebinding (TTL-0) name has no window between check and use.
//   3. REDIRECTS BY HAND: Playwright calls a route handler only for the first url of a redirect
//      chain (playwright-core 1.55.1 types.d.ts:3923, "The handler will only be called for the
//      first url if the response is a redirect"; reproduced locally 2026-11-01, and a FULFILLED
//      3xx is followed unseen too). So Chromium is never shown a 3xx: Node follows each hop and
//      re-checks it, and a redirected main document is re-navigated to its final URL.
//   4. NO NETWORK OF ITS OWN: Chromium launches behind a dead proxy, so anything route never sees
//      (a preconnect, a WebSocket, WebRTC over TCP) dead-ends. Service workers are blocked and
//      WebSockets closed because route does not see them either (both reproduced locally).
//      WebRTC UDP, which ignores proxies, is forced through the proxy by a launch flag.
//   5. A HARDENED BROWSER PROCESS (security review, 2026-11-01): on Vercel/Lambda Chromium must run
//      --no-sandbox --single-process, so a renderer exploit IS native code in this process and
//      could open raw sockets past layers 1-4. So: sparticuz's insecure flags are stripped
//      (--disable-web-security, insecure content, site-isolation-off, SharedArrayBuffer), WebGL
//      is off, and Chromium gets ONLY the three env vars it needs, never VERCEL_OIDC_TOKEN or any
//      other secret in this function's environment.
//   PATCH OBLIGATION: the browser is pinned (Chromium 140 via @sparticuz/chromium 140.0.0, driven
//   by playwright-core 1.55.1). Every Chromium security release is a reason to bump; bump
//   @sparticuz/chromium and playwright-core TOGETHER to matching majors, and with them the
//   `playwright` pins in apps/web and worker (CLAUDE.md §8 bumps all playwright pins at once).
//
// AUTH: a valid Supabase session is not enough. auth.users holds 2 users (measured 2026-11-01),
// so the token must belong to the app user (APP_USER_ID), who owns every applications row.
//
// DEPLOY NOTES (vercel.json cannot carry comments, so they live here):
//   - Every helper lives in THIS file on purpose: no relative import means nothing depends on how
//     Vercel's TypeScript step rewrites `.ts` specifiers. Tests sit in api/_render/, which Vercel
//     never turns into functions (its builder skips any api/ path containing "/_").
//   - includeFiles names the REAL pnpm path of @sparticuz/chromium/bin: the package finds bin/ from
//     import.meta.url at runtime, which file tracing cannot follow, and the traced
//     node_modules/@sparticuz/chromium is kept as a symlink, so a glob through it would collide.
//   - memory is NOT in vercel.json: with Fluid compute it may only be set in the dashboard
//     (Fluid's default is 2 GB; the chromium README asks for >= 1600 MB).
//
// IO sits behind four injected seams (verifyUser, resolve, hop, launchBrowser) so `node --test`
// covers every branch on Windows, where the sparticuz binary (Linux-only) cannot run.

// Promise DNS: every A and AAAA answer for a name, used for the cheap pre-launch check.
import { lookup as dnsLookup } from "node:dns/promises";
// The shape of one DNS answer, shared by the pre-check and the connect-time hook.
import type { LookupAddress } from "node:dns";
// Node's own HTTPS client: the only thing in this file that opens a socket to a job site.
import { request as httpsRequest } from "node:https";
// The `lookup` hook signature node:https hands to net.connect.
import type { LookupFunction } from "node:net";
// A server may compress even when asked not to; these decode it before Chromium sees the bytes.
import { brotliDecompressSync, gunzipSync, inflateSync } from "node:zlib";
// Types only (erased at runtime): the real modules load lazily inside launchBrowser.
import type { Browser, LaunchOptions, Route } from "playwright-core";

// Longest pasted link accepted, per the contract.
export const MAX_URL_LENGTH = 2000;
// Characters of page text returned, per the contract.
export const MAX_TEXT_CHARS = 100_000;
// The whole render, launch included, per the contract.
export const RENDER_BUDGET_MS = 45_000;
// Waiting for the first document; leaves room for launch and the idle wait inside the budget.
const GOTO_TIMEOUT_MS = 25_000;
// Extra wait for a JavaScript board to finish fetching its job data; a timeout is not an error.
const IDLE_TIMEOUT_MS = 8_000;
// A cold launch unpacks ~65 MB of brotli into /tmp; Playwright's own default (180 s) is too long.
const LAUNCH_TIMEOUT_MS = 20_000;
// One Node-side request; a site that hangs must not hold a route handler for the whole budget.
const HOP_TIMEOUT_MS = 15_000;
// The Supabase Auth check; a slow auth server must not eat the render budget.
const VERIFY_TIMEOUT_MS = 5_000;
// Hops followed after the first request, the same allowance as job-link-intake's fetch-page.ts.
export const MAX_REDIRECTS = 5;
// One response's size cap. Bigger than fetch-page's 2 MB HTML cap on purpose: this path also
// carries uncompressed JavaScript bundles, and a truncated script breaks the page it was for.
export const MAX_RESPONSE_BYTES = 15_000_000;
// Statuses Chromium would follow as a redirect; Node follows them instead (layer 3).
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
// Request types never fetched: pixels, sound and fonts add no text, and an event stream never
// ends, so its Node-side request would hold a route handler until the hop timeout.
const SKIPPED_TYPES = new Set(["image", "media", "font", "eventsource"]);
// The dead proxy for layer 4. 192.0.2.0/24 is TEST-NET-1 (RFC 5737): never routed, so nothing
// can ever answer there, unlike a loopback port some other process might own.
const DEAD_PROXY = "http://192.0.2.1:9";
// The error code our lookup hook uses for "a private address"; followRedirects maps it to a refusal.
export const PRIVATE_ADDRESS = "EPRIVATEADDR";
// The refusal text for a name that resolves into a private network.
const PRIVATE_REASON = "That link points at a private network address.";
// Bytes ONE render may pull across all its hops; past it, further requests are refused, so a page
// that loads asset after asset cannot run the instance out of memory (self-DoS).
export const MAX_RENDER_BYTES = 50_000_000;
// Reading the text; runs in Playwright's isolated world, so page scripts cannot hang or spoof it.
const TEXT_TIMEOUT_MS = 5_000;
// The app user (Teja's account, owner of every applications row; checked live 2026-11-01). Not a
// secret: a user id grants nothing without that user's own session token.
export const APP_USER_ID = "0f4b24da-e85b-40bb-8606-c81824493b45";
// sparticuz flags that weaken the web's own isolation and buy nothing for reading a job page:
// same-origin policy off, mixed content on, site isolation off, SharedArrayBuffer (a timer for
// Spectre-style reads) on. Matched as exact strings, as sparticuz 140.0.0 emits them.
export const UNSAFE_CHROMIUM_FLAGS = new Set(["--disable-web-security", "--allow-running-insecure-content", "--disable-site-isolation-trials", "--enable-features=SharedArrayBuffer"]);
// Entries removed from sparticuz's --disable-features list, so site isolation is not switched off
// on purpose (it launched and rendered a cross-origin iframe without them, chromium-1193 locally).
const ISOLATION_FEATURES = new Set(["IsolateOrigins", "site-per-process"]);
// WebRTC UDP does not go through proxies by default; this makes it, so it hits the dead proxy too.
export const WEBRTC_FLAG = "--force-webrtc-ip-handling-policy=disable_non_proxied_udp";
// The only environment Chromium gets: what sparticuz's setup writes (home dir, its bundled
// libraries, its fonts). Everything else in this function's env, secrets included, stays out.
const CHROMIUM_ENV_KEYS = ["HOME", "LD_LIBRARY_PATH", "FONTCONFIG_PATH"];

// --- Layer 1: the SAME rules as supabase/functions/job-link-intake/fetch-page.ts -----------------
// Copied, not imported: that file belongs to the Deno tree and a cross-tree import would make this
// function's build depend on it. api/_render/render-job-page.test.ts pins identical verdicts on a
// table of inputs, so the two copies cannot drift apart silently.

// True for hosts a server-side fetch must never reach: loopback, private names and bare IPs.
export function isBlockedHost(hostname: string): boolean {
  // `localhost.` is the same host as `localhost`; strip the root dot(s) before any check.
  const host = hostname.replace(/\.+$/, "").toLowerCase();
  // IPv6 literals arrive bracketed; any of them is refused (no job board is a bare IP).
  if (host.startsWith("[")) return true;
  // Dotted IPv4 literal of any range: refused for the same reason.
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return true;
  // A single-label name (no dot) only resolves inside a private network.
  if (!host.includes(".")) return true;
  // Names reserved for local or internal use.
  return /(^|\.)(localhost|local|internal|localdomain|home\.arpa)$/.test(host);
}

// The refusal for a URL we will not fetch, or null when it may be fetched.
export function checkPublicUrl(url: URL): string | null {
  // https only, like every board this repo talks to.
  if (url.protocol !== "https:") return "Only https:// links are accepted.";
  // Userinfo and custom ports are lookalike and SSRF tricks.
  if (url.username !== "" || url.password !== "" || url.port !== "") return "Links with a username or port are not accepted.";
  // Never a private name or a bare IP.
  if (isBlockedHost(url.hostname)) return "That host cannot be fetched.";
  // Fetchable, subject to the address check.
  return null;
}

// True only for an address on the public internet. Anything unparseable is NOT public.
export function isPublicAddress(ip: string): boolean {
  // Dotted IPv4.
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  // IPv4 ranges that are not the public internet.
  if (v4 !== null) {
    // The first two octets decide every range below.
    const a = Number(v4[1]);
    // Second octet.
    const b = Number(v4[2]);
    // "This network", RFC1918 10/8, loopback 127/8.
    if (a === 0 || a === 10 || a === 127) return false;
    // CGNAT 100.64/10.
    if (a === 100 && b >= 64 && b <= 127) return false;
    // Link-local 169.254/16, which holds the cloud metadata endpoint 169.254.169.254.
    if (a === 169 && b === 254) return false;
    // RFC1918 172.16/12.
    if (a === 172 && b >= 16 && b <= 31) return false;
    // RFC1918 192.168/16 and IETF 192.0.0/24.
    if (a === 192 && (b === 168 || (b === 0 && Number(v4[3]) === 0))) return false;
    // Benchmarking 198.18/15.
    if (a === 198 && (b === 18 || b === 19)) return false;
    // Multicast 224/4 and reserved 240/4.
    return a < 224;
  }
  // Lower-cased once for the IPv6 prefixes.
  const v6 = ip.toLowerCase();
  // Neither family: not an address we can vouch for.
  if (!v6.includes(":")) return false;
  // Unspecified, loopback, v4-mapped and v4-compatible forms all start with "::"; no public one does.
  if (v6.startsWith("::")) return false;
  // ULA fc00::/7, link-local fe80::/10, multicast ff00::/8, NAT64 64:ff9b::/96 and 64:ff9b:1::/48,
  // 6to4 2002::/16 and Teredo 2001:0::/32 (all three can carry a private v4), discard 100::/64.
  return !/^(f[cd]|fe[89ab]|ff|64:ff9b:|2002:|2001:0:|2001::|100::|100:0:0:0:)/.test(v6);
}

// --- Layer 2: the address check at connect time ---------------------------------------------------

// Every A and AAAA answer for a name; empty when it has none or cannot be resolved.
export type Resolve = (hostname: string) => Promise<LookupAddress[]>;

// An errno-style error, so callers can branch on `code` instead of parsing a message.
function lookupError(code: string, message: string): NodeJS.ErrnoException {
  // Error + code is the shape net.connect reports for a failed lookup.
  return Object.assign(new Error(message), { code });
}

// A `lookup` hook for node:https that refuses private networks. net.connect calls it right before
// it connects and dials ONLY the addresses it returns, so the check and the connection cannot
// disagree (no DNS-rebinding window).
export function guardedLookup(resolve: Resolve): LookupFunction {
  // The signature net.connect calls.
  return (hostname, options, callback) => {
    // Resolve through the seam; tests answer with fixed addresses.
    resolve(hostname).then(
      // The full answer for this name.
      (addresses) => {
        // The first answer, for the single-address form below.
        const first = addresses[0];
        // No address: nothing safe to connect to (also the fail-closed answer when DNS is down).
        if (first === undefined) return callback(lookupError("ENOTFOUND", `${hostname} has no address`), "", 0);
        // ANY private address refuses the WHOLE answer. Never filter down to the public ones: a
        // mixed answer is itself a rebinding signal, and the socket may pick any address it gets.
        if (!addresses.every((entry) => isPublicAddress(entry.address))) return callback(lookupError(PRIVATE_ADDRESS, `${hostname} resolves to a private network address`), "", 0);
        // Node 24 enables autoSelectFamily by default, which asks for every address at once.
        if (options.all === true) return callback(null, addresses);
        // The classic single-address form.
        callback(null, first.address, first.family);
      },
      // A resolver failure is "no address", never "try anyway".
      (error: unknown) => callback(lookupError("ENOTFOUND", `${hostname} could not be resolved: ${String(error)}`), "", 0),
    );
  };
}

// --- One Node-side request, and the redirect loop over it -----------------------------------------

// What the browser asked for, forwarded by Node.
export interface HopInit {
  // GET for documents; scripts may also POST (an API call the job page makes).
  method: string;
  // The browser's own request headers (cookies included, so a session cookie still works).
  headers: Record<string, string>;
  // A POST body, or null.
  body: Buffer | null;
}

// One response, fully read, ready to hand to Chromium.
export interface HopResponse {
  // The HTTP status.
  status: number;
  // Lower-cased headers; Set-Cookie lines joined by "\n", which is how Playwright carries several.
  headers: Record<string, string>;
  // The decoded body.
  body: Buffer;
}

// What one render may still spend, shared by every request of that render.
export interface RenderBudget {
  // Aborted when the render ends, so no request outlives the reply.
  signal: AbortSignal;
  // Bytes left before further requests are refused (MAX_RENDER_BYTES at the start).
  bytesLeft: number;
}

// One request with redirects NOT followed; the redirect loop is followRedirects' job.
export type Hop = (url: URL, init: HopInit, budget: RenderBudget) => Promise<HopResponse>;

// Request headers Node must not copy from the browser: connection-level ones, ones Node computes,
// and accept-encoding, which is replaced by "identity" below.
const UNFORWARDED_REQUEST_HEADERS = new Set(["host", "connection", "keep-alive", "transfer-encoding", "content-length", "accept-encoding", "upgrade", "te"]);
// Response headers Chromium must not see: the body is re-framed and decoded, so the original
// length/encoding would lie; connection-level ones do not apply to a fulfilled response.
const UNFORWARDED_RESPONSE_HEADERS = new Set(["content-length", "content-encoding", "transfer-encoding", "connection", "keep-alive"]);

// The body decoded per Content-Encoding. We ask for "identity", so this only runs for a server
// that compresses anyway; an unknown encoding is an error, never garbage handed to the page.
function decodeBody(body: Buffer, encoding: string | undefined): Buffer {
  // A decompression bomb stops at the same cap as a plain body.
  const limit = { maxOutputLength: MAX_RESPONSE_BYTES };
  // Header values are case-insensitive and may carry spaces.
  switch ((encoding ?? "").trim().toLowerCase()) {
    // Absent or identity: the bytes as sent.
    case "":
    case "identity":
      // Nothing to undo.
      return body;
    // gzip, plus its legacy alias.
    case "gzip":
    case "x-gzip":
      // Gunzip, capped.
      return gunzipSync(body, limit);
    // zlib-wrapped deflate.
    case "deflate":
      // Inflate, capped.
      return inflateSync(body, limit);
    // Brotli.
    case "br":
      // Decompress, capped.
      return brotliDecompressSync(body, limit);
    // Anything else (zstd, stacked encodings) is refused rather than guessed at.
    default:
      // The route handler aborts the request on this.
      throw new Error(`unsupported content-encoding ${encoding}`);
  }
}

// One HTTPS request made by Node with the guarded lookup. Never follows redirects. `signal` is the
// render's: when the render ends, this request ends with it.
export function httpsHop(url: URL, init: HopInit, lookup: LookupFunction, signal: AbortSignal): Promise<HopResponse> {
  // node:https is callback-based; wrap it once.
  return new Promise((resolve, reject) => {
    // The browser's headers minus the ones Node owns.
    const headers: Record<string, string> = {};
    // Copy each forwardable header.
    for (const [name, value] of Object.entries(init.headers)) {
      // HTTP/2 pseudo-headers (":authority") are rejected by node:https; the rest are listed above.
      if (!name.startsWith(":") && !UNFORWARDED_REQUEST_HEADERS.has(name.toLowerCase())) headers[name] = value;
    }
    // Uncompressed, so the body needs no decoding in the usual case.
    headers["accept-encoding"] = "identity";
    // A body's length is set by us, from the bytes actually sent.
    if (init.body !== null) headers["content-length"] = String(init.body.length);
    // THE layer-2 line: `lookup` is where the connected address gets checked. Without it, Node
    // re-resolves the name itself and a rebinding name can answer differently than the check did.
    // `signal` ties the request to the render; `timeout` cuts a socket that goes silent.
    const req = httpsRequest(url, { method: init.method, headers, lookup, signal, timeout: HOP_TIMEOUT_MS }, (res) => {
      // The body, kept in chunks until the end.
      const chunks: Buffer[] = [];
      // Bytes received so far.
      let total = 0;
      // Each chunk as it arrives.
      res.on("data", (chunk: Buffer) => {
        // Counted before it is kept.
        total += chunk.length;
        // Over the cap: stop the download rather than hold a huge response in memory.
        if (total > MAX_RESPONSE_BYTES) return req.destroy(new Error("response too large"));
        // Kept.
        chunks.push(chunk);
      });
      // The whole body arrived.
      res.on("end", () => {
        // decodeBody throws on an unknown encoding; turn that into a rejection.
        try {
          // Headers flattened to strings, minus the ones that would lie after re-framing.
          const flat: Record<string, string> = {};
          // Each response header.
          for (const [name, value] of Object.entries(res.headers)) {
            // Absent values and the unforwarded ones are skipped.
            if (value === undefined || UNFORWARDED_RESPONSE_HEADERS.has(name)) continue;
            // Several Set-Cookie lines are "\n"-joined, which Playwright splits back apart.
            flat[name] = Array.isArray(value) ? value.join(name === "set-cookie" ? "\n" : ", ") : value;
          }
          // The response, decoded.
          resolve({ status: res.statusCode ?? 0, headers: flat, body: decodeBody(Buffer.concat(chunks), res.headers["content-encoding"]) });
        } catch (error) {
          // An undecodable body fails this request only.
          reject(error);
        }
      });
      // A connection dropped mid-body.
      res.on("error", reject);
    });
    // A site that stops answering is cut off at the hop timeout.
    req.on("timeout", () => req.destroy(new Error("request timed out")));
    // The idle timeout above never fires for a site that trickles one byte at a time, so a
    // wall-clock limit caps the whole request too.
    const wallClock = setTimeout(() => req.destroy(new Error("request took too long")), HOP_TIMEOUT_MS);
    // Cleared however the request ends (response read, error, abort).
    req.once("close", () => clearTimeout(wallClock));
    // Connect, TLS, lookup refusal and size-cap errors all land here.
    req.on("error", reject);
    // A POST body, when the page sent one.
    if (init.body !== null) req.write(init.body);
    // Send.
    req.end();
  });
}

// The outcome of following one request to its end.
export type FollowResult =
  // A final non-redirect response, the URL it came from, and whether any redirect was followed.
  | { kind: "ok"; url: string; redirected: boolean; response: HopResponse }
  // A refused hop: the reason is shown to the person who pasted the link.
  | { kind: "refused"; reason: string };

// Request headers a redirect must not carry: the browser attached them for the FIRST host, and a
// redirect may point at a different one.
function withoutCredentials(headers: Record<string, string>): Record<string, string> {
  // A copy, so the original request is untouched.
  const kept: Record<string, string> = {};
  // Every header except cookies and authorization.
  for (const [name, value] of Object.entries(headers)) {
    // Credentials stay with the host they were sent to.
    if (!["cookie", "authorization"].includes(name.toLowerCase())) kept[name] = value;
  }
  // The safe remainder.
  return kept;
}

// Follow one request through its redirects, checking EVERY hop with the same rules as the pasted
// link before it is requested (layer 3). Throws only for network failures, which the caller maps.
// ponytail: the byte budget is checked BEFORE a hop and charged AFTER it, so parallel requests that
// all start under the budget can overshoot it by up to MAX_RESPONSE_BYTES each; peak memory is
// (requests in flight) x 15 MB. Add an in-flight request cap if a real page ever gets close.
export async function followRedirects(start: string, init: HopInit, hop: Hop, budget: RenderBudget): Promise<FollowResult> {
  // The URL about to be requested.
  let current = start;
  // The request for this hop; redirects drop the body and the credentials.
  let request = init;
  // The first request plus MAX_REDIRECTS followed redirects.
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
    // Prefix that tells the person a redirect, not their link, was refused.
    const prefix = redirects === 0 ? "" : "A redirect was refused: ";
    // Parsed for the checks; a hop that is not a URL is refused, never guessed at.
    let url: URL;
    // new URL only splits the string.
    try {
      // The current hop.
      url = new URL(current);
    } catch {
      // A garbled Location header.
      return { kind: "refused", reason: `${prefix}it pointed at an invalid link.` };
    }
    // THE layer-1 line for redirects and subresources: shape before any request.
    const refused = checkPublicUrl(url);
    // Named so the person sees why.
    if (refused !== null) return { kind: "refused", reason: `${prefix}${refused}` };
    // The response, or a refusal from the guarded lookup.
    let response: HopResponse;
    // THE byte-budget line: a render that has pulled MAX_RENDER_BYTES makes no further requests.
    if (budget.bytesLeft <= 0) throw new Error("the render's byte budget is spent");
    // Only the private-address error is a refusal; anything else is a network failure.
    try {
      // One request, redirects not followed.
      response = await hop(url, request, budget);
    } catch (error) {
      // The connect-time check refused this name.
      if ((error as NodeJS.ErrnoException).code === PRIVATE_ADDRESS) return { kind: "refused", reason: `${prefix}${PRIVATE_REASON}` };
      // Timeouts, resets, TLS errors: the caller aborts the request.
      throw error;
    }
    // Charged as soon as the body is held, redirect bodies included.
    budget.bytesLeft -= response.body.length;
    // Not a redirect: this is the response the browser gets.
    if (!REDIRECT_STATUSES.has(response.status)) return { kind: "ok", url: url.toString(), redirected: redirects > 0, response };
    // Where the redirect points.
    const location = response.headers["location"];
    // A redirect without a target cannot be followed and must not reach Chromium as a 3xx.
    if (location === undefined) return { kind: "refused", reason: `${prefix}a redirect had no target.` };
    // ponytail: only GET/HEAD redirects are followed; a redirected POST is refused. Add the
    // 303-becomes-GET / 307-keeps-POST rules if a job board ever needs a redirected POST.
    if (request.method !== "GET" && request.method !== "HEAD") return { kind: "refused", reason: `${prefix}a non-GET request was redirected.` };
    // Relative Locations resolve against this hop; the loop re-checks the result.
    try {
      // Absolute URL of the next hop.
      current = new URL(location, url).toString();
    } catch {
      // An unparseable target is refused like any other bad hop.
      return { kind: "refused", reason: `A redirect was refused: it pointed at an invalid link.` };
    }
    // ponytail: cookies set by a 3xx are not carried to the next hop (the browser never sees that
    // response). Carry them if a board's redirect chain ever depends on one.
    request = { method: request.method, headers: withoutCredentials(request.headers), body: null };
  }
  // A redirect loop or a very long chain.
  return { kind: "refused", reason: "A redirect was refused: too many redirects." };
}

// --- The browser side ------------------------------------------------------------------------------

// What happened to the main document's request, read by the navigation loop.
export interface MainNavigation {
  // Why the main document was refused, or null.
  refused: string | null;
  // The final URL of a redirected main document, to re-navigate to, or null.
  movedTo: string | null;
}

// The context-wide route handler: no request reaches the network from Chromium. Each one is made
// by Node (layers 1-3) and handed back with route.fulfill, or aborted.
export function routeThroughNode(hop: Hop, nav: MainNavigation, budget: RenderBudget): (route: Route) => Promise<void> {
  // One handler for every request in the context.
  return async (route) => {
    // Any failure below ends in an abort, never in Chromium fetching the URL itself.
    try {
      // The intercepted request.
      const request = route.request();
      // Nothing to gain from these; they are aborted before any network work.
      if (SKIPPED_TYPES.has(request.resourceType())) return await route.abort("blockedbyclient");
      // The top-level page itself (not an iframe): its outcome decides the response.
      const isMainDocument = request.isNavigationRequest() && request.frame().parentFrame() === null;
      // Node makes the request and follows any redirect, checking every hop.
      const result = await followRedirects(request.url(), { method: request.method(), headers: await request.allHeaders(), body: request.postDataBuffer() }, hop, budget);
      // A refused hop.
      if (result.kind === "refused") {
        // Recorded so the caller gets a 400 with the reason, not a generic render failure.
        if (isMainDocument) nav.refused = result.reason;
        // Chromium gets an error, never the refused URL.
        return await route.abort("blockedbyclient");
      }
      // A redirected main document must load AT its final URL, or relative links and SPA routers
      // would resolve against the pasted one. "aborted" leaves no error page to interrupt the
      // re-navigation (a "blockedbyclient" abort commits chrome-error:// and does).
      if (isMainDocument && result.redirected) {
        // The navigation loop goes there next.
        nav.movedTo = result.url;
        // This navigation ends here.
        return await route.abort("aborted");
      }
      // A copy, so the Location line can be dropped.
      const headers = { ...result.response.headers };
      // Chromium is never shown anything it could follow by itself (layer 3).
      delete headers["location"];
      // The page or subresource, served from Node's response.
      await route.fulfill({ status: result.response.status, headers, body: result.response.body });
    } catch {
      // A network failure (or a page already closed): the request fails, nothing leaks.
      await route.abort("failed").catch(() => {});
    }
  };
}

// The result of one render.
type RenderOutcome =
  // The page's text and where it ended up.
  | { kind: "ok"; text: string; finalUrl: string }
  // A hop the security rules refused.
  | { kind: "refused"; reason: string };

// Load the page in an already-launched browser and read its visible text.
async function renderInBrowser(browser: Browser, url: string, hop: Hop, budget: RenderBudget): Promise<RenderOutcome> {
  // Service workers fetch outside page.route, so none may register (layer 4); a link that turns
  // out to be a file download must not land on this instance's disk.
  const context = await browser.newContext({ serviceWorkers: "block", acceptDownloads: false });
  // WebSockets bypass page.route too; registered BEFORE the page opens, or it does not apply.
  await context.routeWebSocket(/.*/, (ws) => ws.close());
  // Shared with the route handler.
  const nav: MainNavigation = { refused: null, movedTo: null };
  // Every request through Node (layers 1-3).
  await context.route("**/*", routeThroughNode(hop, nav, budget));
  // One page.
  const page = await context.newPage();
  // The URL to load; replaced once if the main document redirects.
  let target = url;
  // At most two navigations: the pasted URL, then its final URL.
  for (let attempt = 0; ; attempt++) {
    // Fresh outcome for this navigation.
    nav.refused = null;
    // Fresh redirect target.
    nav.movedTo = null;
    // goto throws when the route handler aborted the document.
    try {
      // The HTML is enough to start; the idle wait below lets scripts fill in the job.
      await page.goto(target, { waitUntil: "domcontentloaded", timeout: GOTO_TIMEOUT_MS });
      // Loaded.
      break;
    } catch (error) {
      // The security rules refused the document or a redirect of it.
      if (nav.refused !== null) return { kind: "refused", reason: nav.refused };
      // A redirected document: load it at its final URL, once.
      if (nav.movedTo !== null && attempt === 0) {
        // The final URL Node already checked.
        target = nav.movedTo;
        // Navigate again.
        continue;
      }
      // A network failure, a timeout, or a page that keeps redirecting.
      throw error;
    }
  }
  // JavaScript boards fetch the job after load; this wait is best effort, never an error.
  await page.waitForLoadState("networkidle", { timeout: IDLE_TIMEOUT_MS }).catch(() => {});
  // Read in Playwright's isolated world, not the page's: page scripts cannot override innerText or
  // the reader, and a page stuck in an endless script cannot hold this past the timeout.
  const text = await page.locator("body").innerText({ timeout: TEXT_TIMEOUT_MS });
  // Where the page ended up (client-side navigation included).
  const finalUrl = page.url();
  // A page that ended off the public web is refused even after loading.
  const refused = checkPublicUrl(new URL(finalUrl));
  // Named for the person.
  if (refused !== null) return { kind: "refused", reason: `The page ended on a refused link: ${refused}` };
  // The contract's text: trimmed, capped.
  return { kind: "ok", text: text.trim().slice(0, MAX_TEXT_CHARS), finalUrl };
}

// --- The HTTP handler ------------------------------------------------------------------------------

// Every effect, injected.
export interface RenderDeps {
  // True when the bearer token is a live Supabase session; throws when Auth cannot be reached.
  verifyUser(token: string): Promise<boolean>;
  // DNS for the pre-launch check (and, in production, the guarded lookup behind `hop`).
  resolve: Resolve;
  // One Node-side request, redirects not followed.
  hop: Hop;
  // A launched headless Chromium.
  launchBrowser(): Promise<Browser>;
}

// A JSON reply that no cache keeps.
function reply(status: number, body: Record<string, string>, headers: Record<string, string> = {}): Response {
  // no-store: a rendered page is per-request data.
  return Response.json(body, { status, headers: { "cache-control": "no-store", ...headers } });
}

// The 400 shape, used for every bad body and refused link.
function refusedReply(message: string): Response {
  // Per the contract.
  return reply(400, { status: "refused", message });
}

// The whole request: method, auth, body, link checks, then the render under its budget.
export async function handleRenderRequest(request: Request, deps: RenderDeps): Promise<Response> {
  // POST only, per the contract.
  if (request.method !== "POST") return reply(405, { status: "error", message: "Use POST." }, { allow: "POST" });
  // The bearer token, or undefined when the header is missing or malformed.
  const token = /^Bearer\s+(\S+)$/i.exec(request.headers.get("authorization") ?? "")?.[1];
  // No token, no browser.
  if (token === undefined) return reply(401, { status: "unauthorized", message: "A Bearer token is required." });
  // Auth's answer; an unreachable Auth is a server error, not the caller's fault.
  let verified: boolean;
  // verifyUser throws only when Auth cannot answer.
  try {
    // Supabase decides whether this token is a live session.
    verified = await deps.verifyUser(token);
  } catch {
    // 502: the caller's token may be fine.
    return reply(502, { status: "error", message: "The login could not be verified right now." });
  }
  // THE auth line: only a verified session reaches the browser.
  if (!verified) return reply(401, { status: "unauthorized", message: "The login is not valid." });
  // The JSON body.
  let body: unknown;
  // request.json throws on anything that is not JSON.
  try {
    // Parsed once.
    body = await request.json();
  } catch {
    // Not JSON at all.
    return refusedReply('The body must be JSON: {"url": "https://..."}.');
  }
  // The url field, if the body is an object.
  const raw = typeof body === "object" && body !== null ? (body as { url?: unknown }).url : undefined;
  // A non-empty string within the contract's length.
  if (typeof raw !== "string" || raw === "" || raw.length > MAX_URL_LENGTH) return refusedReply(`"url" must be a link of 1 to ${MAX_URL_LENGTH} characters.`);
  // Parsed for the checks.
  let url: URL;
  // new URL throws on anything that is not a URL.
  try {
    // The pasted link.
    url = new URL(raw);
  } catch {
    // Not a link.
    return refusedReply("That is not a valid link.");
  }
  // Layer 1 for the pasted link.
  const shape = checkPublicUrl(url);
  // Refused before any DNS or browser work.
  if (shape !== null) return refusedReply(shape);
  // A cheap DNS look before paying for a browser launch; layer 2 re-checks at connect time anyway.
  const addresses = await deps.resolve(url.hostname.replace(/\.+$/, ""));
  // No address: nothing to render.
  if (addresses.length === 0) return refusedReply("The site's address could not be looked up.");
  // A name pointing into a private network is refused here with a clear 400.
  if (!addresses.every((entry) => isPublicAddress(entry.address))) return refusedReply(PRIVATE_REASON);
  // Holds the browser so the finally below can close it, whichever branch ends the render.
  const held: { browser?: Browser; timedOut: boolean } = { timedOut: false };
  // Ends every Node-side request of this render when the render ends (the finally below).
  const controller = new AbortController();
  // Shared by every request of this render: the abort signal and the byte budget.
  const budget: RenderBudget = { signal: controller.signal, bytesLeft: MAX_RENDER_BYTES };
  // The budget timer, cleared when the render ends first.
  let timer: ReturnType<typeof setTimeout> | undefined;
  // Any throw below (launch, network, timeout) is a 502.
  try {
    // The render, raced against the contract's 45 s budget.
    const outcome = await Promise.race([
      // Launch, then render.
      (async () => {
        // A cold launch can be slow.
        const browser = await deps.launchBrowser();
        // Kept for the finally.
        held.browser = browser;
        // The budget ran out mid-launch: the finally already ran without this browser.
        if (held.timedOut) {
          // So it is closed here instead of leaking into the next request on this instance.
          await browser.close();
          // And the render stops.
          throw new Error("render budget spent during launch");
        }
        // The page.
        return await renderInBrowser(browser, url.toString(), deps.hop, budget);
      })(),
      // The budget.
      new Promise<never>((_, reject) => {
        // Fires once.
        timer = setTimeout(() => {
          // Seen by the launch branch above.
          held.timedOut = true;
          // Ends the race.
          reject(new Error(`the render took longer than ${RENDER_BUDGET_MS / 1000} s`));
        }, RENDER_BUDGET_MS);
      }),
    ]);
    // A hop the rules refused.
    if (outcome.kind === "refused") return refusedReply(outcome.reason);
    // Per the contract.
    return reply(200, { status: "ok", text: outcome.text, final_url: outcome.finalUrl });
  } catch (error) {
    // First line only: Playwright errors carry multi-line call logs.
    const detail = (error instanceof Error ? error.message : String(error)).split("\n")[0]?.slice(0, 300) ?? "";
    // Per the contract.
    return reply(502, { status: "error", message: `The page could not be rendered: ${detail}` });
  } finally {
    // The timer must not keep the instance busy after the reply.
    clearTimeout(timer);
    // THE abort line: requests still in flight (a timed-out render, a page still loading) stop now
    // instead of downloading into an instance that has already replied.
    controller.abort();
    // Always closed, success or not; a second close is a no-op.
    await held.browser?.close().catch(() => {});
  }
}

// --- Production wiring -----------------------------------------------------------------------------

// True only when the token is a live session of THE app user. Throws when Auth cannot answer.
// The env and fetch are parameters so the pin is tested without a network.
export async function verifySupabaseUser(token: string, env: Record<string, string | undefined>, fetchImpl: typeof fetch): Promise<boolean> {
  // The project URL and PUBLIC anon key the web bundle already ships (Vercel env, all targets).
  const base = env["VITE_SUPABASE_URL"];
  // Public by design: it identifies the project, it grants nothing on its own.
  const anonKey = env["VITE_SUPABASE_ANON_KEY"];
  // Missing config is a server error (502), never "anyone may pass".
  if (!base || !anonKey) throw new Error("VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY are not set");
  // GET /auth/v1/user answers 200 with the user only for a live session token.
  const res = await fetchImpl(new URL("/auth/v1/user", base), { headers: { apikey: anonKey, authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS) });
  // A rejected token.
  if (res.status === 401 || res.status === 403) return false;
  // Anything else but 200 means Auth itself is unwell.
  if (res.status !== 200) throw new Error(`Supabase Auth answered ${res.status}`);
  // The user record, shape-checked rather than trusted.
  const user: unknown = await res.json();
  // THE pin line: a live session of any OTHER user of this project (there are 2) is not enough.
  return typeof user === "object" && user !== null && (user as { id?: unknown }).id === APP_USER_ID;
}

// The launch options for the serverless Chromium (layer 5): sparticuz's args minus the unsafe ones
// plus the WebRTC flag, the dead proxy, and ONLY the env vars Chromium needs. Pure, so it is tested.
export function chromiumLaunchOptions(executablePath: string, baseArgs: readonly string[], env: Record<string, string | undefined>): LaunchOptions {
  // The args Chromium gets.
  const args: string[] = [];
  // Each sparticuz arg, filtered.
  for (const arg of baseArgs) {
    // THE flag-filter line: the isolation-weakening flags never reach Chromium.
    if (UNSAFE_CHROMIUM_FLAGS.has(arg)) continue;
    // sparticuz turns site isolation off through --disable-features too.
    if (arg.startsWith("--disable-features=")) {
      // The list without the isolation entries (AudioServiceOutOfProcess stays: Lambda needs it).
      const kept = arg.slice("--disable-features=".length).split(",").filter((feature) => !ISOLATION_FEATURES.has(feature));
      // An emptied list is dropped rather than passed as a bare "--disable-features=".
      if (kept.length > 0) args.push(`--disable-features=${kept.join(",")}`);
      // Handled.
      continue;
    }
    // Every other sparticuz flag is kept: launch on Lambda depends on them (--no-sandbox,
    // --single-process, --no-zygote, --headless='shell').
    args.push(arg);
  }
  // WebRTC UDP goes through the (dead) proxy like everything else.
  args.push(WEBRTC_FLAG);
  // The child's environment, built from nothing.
  const childEnv: Record<string, string> = {};
  // THE env line: only the keys sparticuz's setup needs, so VERCEL_OIDC_TOKEN and every other
  // secret of this function stay out of a process that runs untrusted pages without a sandbox.
  for (const key of CHROMIUM_ENV_KEYS) {
    // Whichever of them is set.
    const value = env[key];
    // Copied as is.
    if (value !== undefined) childEnv[key] = value;
  }
  // `env` REPLACES process.env for the child (Playwright's default is to pass all of it). The
  // bypass is spelled out so loopback goes to the dead proxy too, even if Playwright's own
  // forced "<-loopback>" is ever switched off (PLAYWRIGHT_DISABLE_FORCED_CHROMIUM_PROXIED_LOOPBACK).
  return { executablePath, args, env: childEnv, headless: true, proxy: { server: DEAD_PROXY, bypass: "<-loopback>" }, timeout: LAUNCH_TIMEOUT_MS };
}

// Real DNS. A failed lookup is an empty answer, which every caller treats as "refuse".
const resolve: Resolve = (hostname) => dnsLookup(hostname, { all: true }).catch(() => []);

// The real seams.
const realDeps: RenderDeps = {
  // Supabase Auth decides, pinned to the app user.
  verifyUser: (token) => verifySupabaseUser(token, process.env, fetch),
  // Real DNS.
  resolve,
  // Node's HTTPS client with the connect-time address check, ended with the render.
  hop: (url, init, budget) => httpsHop(url, init, guardedLookup(resolve), budget.signal),
  // Loaded lazily: tests never touch the Linux-only binary, and a cold start pays for it only here.
  async launchBrowser() {
    // Both modules at once.
    const [{ chromium }, { default: serverlessChromium }] = await Promise.all([import("playwright-core"), import("@sparticuz/chromium")]);
    // WebGL off (sparticuz's documented switch): its SwiftShader path is GPU attack surface and a
    // job page needs no 3D. Set before .args is read, because it changes the flags.
    serverlessChromium.setGraphicsMode = false;
    // FIRST: unpacking Chromium completes sparticuz's setup of HOME, LD_LIBRARY_PATH and
    // FONTCONFIG_PATH in process.env, which chromiumLaunchOptions copies from.
    const executablePath = await serverlessChromium.executablePath();
    // Launched with the hardened options (layers 4 and 5).
    return chromium.launch(chromiumLaunchOptions(executablePath, serverlessChromium.args, process.env));
  },
};

// Vercel's Web-standard handler: one `fetch` export receives every method; non-POST gets a 405.
export default {
  // Each request.
  fetch(request: Request): Promise<Response> {
    // The real seams.
    return handleRenderRequest(request, realDeps);
  },
};
