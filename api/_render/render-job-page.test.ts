// Tests for api/render-job-page.ts. No network and no real browser: every effect is a fake seam,
// except where a test needs Node's REAL https client to prove the connect-time address check
// (those use a fake resolver, so the lookup refuses before any socket opens).
// Lives under api/_render/ because Vercel never turns an api/ path containing "/_" into a function.
// Run: node --test "api/_render/*.test.ts"

// node:test is the runner every test in this repo uses; no dependency.
import { describe, it } from "node:test";
// Strict assertions only.
import assert from "node:assert/strict";
// Watches every client socket Node creates, to prove none dials a refused address.
import { subscribe, unsubscribe } from "node:diagnostics_channel";
// The socket type for that watcher.
import type { Socket } from "node:net";
// The lookup hook type, for the spy that records which form net.connect asked for.
import type { LookupFunction } from "node:net";
// Types only: the fakes stand in for these.
import type { Browser, Route } from "playwright-core";
// The real sparticuz package, only to read the flags it emits (its binary is never launched here).
import serverlessChromium from "@sparticuz/chromium";
// The module under test.
import {
  APP_USER_ID,
  checkPublicUrl,
  chromiumLaunchOptions,
  followRedirects,
  guardedLookup,
  handleRenderRequest,
  httpsHop,
  isBlockedHost,
  isPublicAddress,
  MAX_RENDER_BYTES,
  MAX_TEXT_CHARS,
  PRIVATE_ADDRESS,
  routeThroughNode,
  verifySupabaseUser,
  WEBRTC_FLAG,
} from "../render-job-page.ts";
// Its seam and value types.
import type { HopInit, HopResponse, MainNavigation, RenderBudget, RenderDeps, Resolve } from "../render-job-page.ts";

// --- Fixtures --------------------------------------------------------------------------------------

// A public address (example.com's documented one).
const PUBLIC_V4 = { address: "93.184.216.34", family: 4 };
// A resolver that always answers with the public address.
const publicResolve: Resolve = async () => [PUBLIC_V4];
// A resolver answering with one fixed address.
const resolveTo = (address: string): Resolve => async () => [{ address, family: address.includes(":") ? 6 : 4 }];
// A plain GET with no headers, for followRedirects and httpsHop.
const GET: HopInit = { method: "GET", headers: {}, body: null };
// A 302 to `location`.
const redirect = (location: string): HopResponse => ({ status: 302, headers: { location }, body: Buffer.alloc(0) });
// A 200 HTML page.
const okPage = (html: string): HopResponse => ({ status: 200, headers: { "content-type": "text/html" }, body: Buffer.from(html) });
// A fresh render budget (a live signal, the full byte allowance unless a test shrinks it).
const budget = (bytesLeft = MAX_RENDER_BYTES): RenderBudget => ({ signal: new AbortController().signal, bytesLeft });
// What Supabase Auth's GET /auth/v1/user answers, for verifySupabaseUser.
const authAnswer = (status: number, user: unknown): typeof fetch => async () => Response.json(user, { status });
// The two env vars verifySupabaseUser reads (values are placeholders, nothing is called).
const AUTH_ENV = { VITE_SUPABASE_URL: "https://project.supabase.co", VITE_SUPABASE_ANON_KEY: "public-anon-key" };

// A POST to the function as job-link-intake sends it.
function post(body: unknown, authorization: string | null = "Bearer good-token"): Request {
  // Headers as the edge function sets them.
  const headers: Record<string, string> = { "content-type": "application/json" };
  // Omitted when a test needs a missing header.
  if (authorization !== null) headers["authorization"] = authorization;
  // Raw strings pass through so a test can send malformed JSON.
  return new Request("https://applyyy.vercel.app/api/render-job-page", { method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body) });
}

// What a fake route ended with.
interface RouteOutcome {
  // The abort error code, when aborted.
  aborted?: string;
  // The fulfilled response, when fulfilled.
  fulfilled?: { status: number; headers: Record<string, string>; body: Buffer };
}

// A Playwright Route stand-in carrying just what routeThroughNode reads.
function fakeRoute(url: string, options: { type?: string; main?: boolean } = {}): { route: Route; outcome: RouteOutcome } {
  // Filled in by abort/fulfill.
  const outcome: RouteOutcome = {};
  // The request the handler inspects.
  const request = {
    // The intercepted URL.
    url: () => url,
    // script unless a test says otherwise.
    resourceType: () => options.type ?? "script",
    // Plain GETs.
    method: () => "GET",
    // Only the main document is a navigation in these tests.
    isNavigationRequest: () => options.main === true,
    // A main-frame request has no parent frame.
    frame: () => ({ parentFrame: () => (options.main === true ? null : {}) }),
    // A browser always sends some headers.
    allHeaders: async () => ({ accept: "*/*" }),
    // No body.
    postDataBuffer: () => null,
  };
  // The route's two exits.
  const route = {
    // The intercepted request.
    request: () => request,
    // Records the error code.
    abort: async (code = "failed") => {
      // Kept for the assertion.
      outcome.aborted = code;
    },
    // Records the response.
    fulfill: async (response: { status: number; headers: Record<string, string>; body: Buffer }) => {
      // Kept for the assertion.
      outcome.fulfilled = response;
    },
  };
  // Cast once: the fake covers only what the handler calls.
  return { route: route as unknown as Route, outcome };
}

// What a fake browser saw.
interface BrowserLog {
  // close() was called.
  closed: boolean;
  // The options newContext got.
  contextOptions: unknown;
  // routeWebSocket was registered.
  webSocketsRouted: boolean;
  // Every goto target, in order.
  gotos: string[];
}

// A Browser stand-in whose goto drives the REAL route handler for the main document, the way
// Chromium would, so handler-level tests exercise routeThroughNode and followRedirects too.
function fakeBrowser(page: { text?: string; finalUrl?: string; gotoError?: Error } = {}): { browser: Browser; log: BrowserLog } {
  // Assertions read this.
  const log: BrowserLog = { closed: false, contextOptions: undefined, webSocketsRouted: false, gotos: [] };
  // The handler render-job-page registers with context.route.
  let handler: ((route: Route) => Promise<void>) | undefined;
  // page.url() before any navigation.
  let current = "about:blank";
  // The page.
  const fakePage = {
    // Mirrors Chromium: the document request goes through the route handler first.
    goto: async (url: string) => {
      // Recorded for the redirect tests.
      log.gotos.push(url);
      // A test-forced failure (a network error, a timeout).
      if (page.gotoError !== undefined) throw page.gotoError;
      // render-job-page registers the handler before opening the page.
      if (handler === undefined) throw new Error("no route handler registered");
      // The main document's request.
      const { route, outcome } = fakeRoute(url, { type: "document", main: true });
      // The real handler decides.
      await handler(route);
      // Anything but a fulfill fails the navigation, as in Chromium.
      if (outcome.fulfilled === undefined) throw new Error(`page.goto: net::ERR_${String(outcome.aborted).toUpperCase()}`);
      // Where the page ended up.
      current = page.finalUrl ?? url;
    },
    // Nothing to wait for.
    waitForLoadState: async () => {},
    // The body's innerText, read through a locator as the module does.
    locator: () => ({ innerText: async () => page.text ?? "Senior Engineer\nApply now" }),
    // The current URL.
    url: () => current,
  };
  // The context.
  const context = {
    // Captures the handler.
    route: async (_pattern: string, registered: (route: Route) => Promise<void>) => {
      // Used by goto.
      handler = registered;
    },
    // Records that WebSockets are closed.
    routeWebSocket: async () => {
      // Kept for the assertion.
      log.webSocketsRouted = true;
    },
    // The one page.
    newPage: async () => fakePage,
  };
  // The browser.
  const browser = {
    // Records the context options.
    newContext: async (options: unknown) => {
      // Kept for the assertion.
      log.contextOptions = options;
      // The context.
      return context;
    },
    // Records the close.
    close: async () => {
      // Kept for the assertion.
      log.closed = true;
    },
  };
  // Cast once: the fake covers only what the module calls.
  return { browser: browser as unknown as Browser, log };
}

// Seams that let a request through to a rendered page; each test overrides what it probes.
function deps(overrides: Partial<RenderDeps> = {}): RenderDeps {
  // Defaults: valid login, public DNS, a 200 page, a working browser.
  return { verifyUser: async () => true, resolve: publicResolve, hop: async () => okPage("<p>job</p>"), launchBrowser: async () => fakeBrowser().browser, ...overrides };
}

// The JSON body of a reply.
async function json(response: Response): Promise<Record<string, string>> {
  // Every reply is a flat string map.
  return (await response.json()) as Record<string, string>;
}

// Call a lookup hook the way net.connect does and capture what it answers.
function callLookup(lookup: LookupFunction, all: boolean): Promise<{ error: NodeJS.ErrnoException | null; address: unknown; family: unknown }> {
  // Callback to promise.
  return new Promise((resolve) => {
    // The two forms net.connect uses.
    lookup("jobs.example.com", { all }, (error, address, family) => resolve({ error, address, family }));
  });
}

// Record every address Node's sockets try to connect to while `run` executes.
async function watchConnections<T>(run: () => Promise<T>): Promise<{ result: T; attempts: string[] }> {
  // The dialled addresses.
  const attempts: string[] = [];
  // Each new client socket reports each address it tries (Node >= 20.12 / 21.6).
  const onSocket = (message: unknown) => (message as { socket: Socket }).socket.on("connectionAttempt", (ip: string) => attempts.push(ip));
  // Node publishes every net.connect socket here.
  subscribe("net.client.socket", onSocket);
  // Always unsubscribed.
  try {
    // The code under watch.
    return { result: await run(), attempts };
  } finally {
    // Leave no global listener behind for other tests.
    unsubscribe("net.client.socket", onSocket);
  }
}

// --- The HTTP contract ------------------------------------------------------------------------------

describe("handleRenderRequest: method, auth and body", () => {
  it("answers 405 to anything but POST", async () => {
    // A GET to the endpoint.
    const res = await handleRenderRequest(new Request("https://applyyy.vercel.app/api/render-job-page"), deps());
    // Per the contract.
    assert.equal(res.status, 405);
    // Tells the client what is allowed.
    assert.equal(res.headers.get("allow"), "POST");
  });

  it("answers 401 without a bearer token, and with a malformed one", async () => {
    // No authorization header.
    const missing = await handleRenderRequest(post({ url: "https://jobs.example.com/1" }, null), deps());
    // Per the contract.
    assert.equal(missing.status, 401);
    // The contract's status word.
    assert.equal((await json(missing)).status, "unauthorized");
    // Wrong scheme.
    const basic = await handleRenderRequest(post({ url: "https://jobs.example.com/1" }, "Basic abc"), deps());
    // Also refused.
    assert.equal(basic.status, 401);
  });

  it("answers 401 when Supabase Auth rejects the token (auth red-on-revert)", async () => {
    // A launch here would mean the auth check let the request through.
    let launched = false;
    // Auth says no.
    const res = await handleRenderRequest(post({ url: "https://jobs.example.com/1" }), deps({ verifyUser: async () => false, launchBrowser: async () => ((launched = true), fakeBrowser().browser) }));
    // Per the contract.
    assert.equal(res.status, 401);
    // The contract's status word.
    assert.equal((await json(res)).status, "unauthorized");
    // No browser for an unverified caller.
    assert.equal(launched, false);
  });

  it("answers 502 when Supabase Auth cannot be reached", async () => {
    // Auth is down.
    const res = await handleRenderRequest(post({ url: "https://jobs.example.com/1" }), deps({ verifyUser: async () => Promise.reject(new Error("ECONNRESET")) }));
    // Not the caller's fault, so not a 401.
    assert.equal(res.status, 502);
  });

  it("answers 400 refused to a body that is not {url: string <= 2000}", async () => {
    // Each malformed body.
    for (const body of ["not json", { link: "https://jobs.example.com/1" }, { url: 42 }, { url: "" }, { url: `https://jobs.example.com/${"a".repeat(2000)}` }]) {
      // The request.
      const res = await handleRenderRequest(post(body), deps());
      // Per the contract.
      assert.equal(res.status, 400, JSON.stringify(body).slice(0, 60));
      // The contract's status word.
      assert.equal((await json(res)).status, "refused");
    }
  });
});

describe("handleRenderRequest: the pasted link (layer 1 + pre-launch DNS)", () => {
  it("refuses non-https, IP literals, localhost, ports and userinfo before any DNS", async () => {
    // A DNS call would mean a refused link got past the shape check.
    let resolved = 0;
    // Each refused link.
    for (const url of ["http://jobs.example.com/1", "https://127.0.0.1/", "https://[::1]/", "https://localhost/", "https://localhost./", "https://jobs.example.com:8443/", "https://u:p@jobs.example.com/", "ftp://jobs.example.com/", "not a url"]) {
      // The request.
      const res = await handleRenderRequest(post({ url }), deps({ resolve: async () => ((resolved += 1), [PUBLIC_V4]) }));
      // Per the contract.
      assert.equal(res.status, 400, url);
      // The contract's status word.
      assert.equal((await json(res)).status, "refused", url);
    }
    // None reached DNS.
    assert.equal(resolved, 0);
  });

  it("refuses a name that resolves to a private address, or to nothing", async () => {
    // A public-looking name pointing into a private network.
    const priv = await handleRenderRequest(post({ url: "https://jobs.example.com/1" }), deps({ resolve: resolveTo("10.0.0.5") }));
    // Per the contract.
    assert.equal(priv.status, 400);
    // The reason names the problem.
    assert.match((await json(priv)).message ?? "", /private network/);
    // A name with no address.
    const none = await handleRenderRequest(post({ url: "https://jobs.example.com/1" }), deps({ resolve: async () => [] }));
    // Also refused.
    assert.equal(none.status, 400);
  });
});

describe("handleRenderRequest: render", () => {
  it("returns the 200 shape with the text trimmed and capped at 100000 chars", async () => {
    // A page with far more text than the cap, padded with whitespace.
    const { browser, log } = fakeBrowser({ text: `  ${"x".repeat(150_000)}  `, finalUrl: "https://jobs.example.com/1?ref=x" });
    // The render.
    const res = await handleRenderRequest(post({ url: "https://jobs.example.com/1" }), deps({ launchBrowser: async () => browser }));
    // Per the contract.
    assert.equal(res.status, 200);
    // The body.
    const body = await json(res);
    // The contract's status word.
    assert.equal(body.status, "ok");
    // Capped, and the leading spaces trimmed first.
    assert.equal(body.text, "x".repeat(MAX_TEXT_CHARS));
    // Where the page ended up.
    assert.equal(body.final_url, "https://jobs.example.com/1?ref=x");
    // Service workers bypass page.route, so they must be blocked; downloads never touch disk.
    assert.deepEqual(log.contextOptions, { serviceWorkers: "block", acceptDownloads: false });
    // WebSockets bypass page.route, so they must be closed.
    assert.equal(log.webSocketsRouted, true);
    // Never left running.
    assert.equal(log.closed, true);
  });

  it("answers 502 when the browser cannot launch", async () => {
    // The launch fails.
    const res = await handleRenderRequest(post({ url: "https://jobs.example.com/1" }), deps({ launchBrowser: async () => Promise.reject(new Error("spawn ENOENT")) }));
    // Per the contract.
    assert.equal(res.status, 502);
    // The contract's status word.
    assert.equal((await json(res)).status, "error");
  });

  it("answers 502 and closes the browser when the page fails to load", async () => {
    // A navigation timeout.
    const { browser, log } = fakeBrowser({ gotoError: new Error("page.goto: Timeout 25000ms exceeded.\nCall log: ...") });
    // The render.
    const res = await handleRenderRequest(post({ url: "https://jobs.example.com/1" }), deps({ launchBrowser: async () => browser }));
    // Per the contract.
    assert.equal(res.status, 502);
    // Only the first line of a Playwright error is passed on.
    assert.doesNotMatch((await json(res)).message ?? "", /Call log/);
    // Closed even on failure.
    assert.equal(log.closed, true);
  });

  it("refuses a page whose final URL left the public web", async () => {
    // A client-side navigation ended on a private address.
    const { browser, log } = fakeBrowser({ finalUrl: "http://169.254.169.254/latest/meta-data" });
    // The render.
    const res = await handleRenderRequest(post({ url: "https://jobs.example.com/1" }), deps({ launchBrowser: async () => browser }));
    // Refused, not returned.
    assert.equal(res.status, 400);
    // The contract's status word.
    assert.equal((await json(res)).status, "refused");
    // Closed.
    assert.equal(log.closed, true);
  });

  it("loads a redirected main document AT its final URL", async () => {
    // The hops Node made.
    const hops: string[] = [];
    // The pasted link redirects once.
    const hop = async (url: URL) => {
      // Recorded.
      hops.push(url.href);
      // First hop redirects, the final one is the page.
      return url.pathname === "/short" ? redirect("https://boards.example.com/job/42") : okPage("<p>job</p>");
    };
    // The browser.
    const { browser, log } = fakeBrowser();
    // The render.
    const res = await handleRenderRequest(post({ url: "https://jobs.example.com/short" }), deps({ hop, launchBrowser: async () => browser }));
    // Rendered.
    assert.equal(res.status, 200);
    // Re-navigated to the final URL, so relative links resolve there.
    assert.deepEqual(log.gotos, ["https://jobs.example.com/short", "https://boards.example.com/job/42"]);
    // The final URL is reported.
    assert.equal((await json(res)).final_url, "https://boards.example.com/job/42");
    // Node fetched short, then final (redirect), then final again for the re-navigation.
    assert.deepEqual(hops, ["https://jobs.example.com/short", "https://boards.example.com/job/42", "https://boards.example.com/job/42"]);
  });
});

// --- SSRF: the four coordinator-required cases plus rebinding --------------------------------------

describe("SSRF guards", () => {
  it("(a) refuses a pasted link that 302s to http://169.254.169.254, and never fetches the second hop", async () => {
    // Every hop Node made.
    const hops: string[] = [];
    // The pasted public page redirects to the metadata endpoint.
    const hop = async (url: URL) => {
      // Recorded.
      hops.push(url.href);
      // Always the same redirect.
      return redirect("http://169.254.169.254/latest/meta-data");
    };
    // The browser.
    const { browser, log } = fakeBrowser();
    // The render.
    const res = await handleRenderRequest(post({ url: "https://jobs.example.com/1" }), deps({ hop, launchBrowser: async () => browser }));
    // Refused with the contract's 400.
    assert.equal(res.status, 400);
    // The reason says a redirect was refused.
    assert.match((await json(res)).message ?? "", /redirect was refused/);
    // Only the pasted link was requested.
    assert.deepEqual(hops, ["https://jobs.example.com/1"]);
    // Closed.
    assert.equal(log.closed, true);
  });

  it("(b) aborts a subresource whose host resolves to 10.0.0.5, before any socket dials it", async () => {
    // Real Node https + the guarded lookup, with DNS answering a private address.
    const hop = (url: URL, init: HopInit, b: RenderBudget) => httpsHop(url, init, guardedLookup(resolveTo("10.0.0.5")), b.signal);
    // The route state.
    const nav: MainNavigation = { refused: null, movedTo: null };
    // A script from a public-looking host.
    const { route, outcome } = fakeRoute("https://cdn.attacker.example/x.js");
    // Through the real route handler, watching every socket.
    const { attempts } = await watchConnections(() => routeThroughNode(hop, nav, budget())(route));
    // Aborted as a refusal ("failed" would mean it was attempted and broke).
    assert.equal(outcome.aborted, "blockedbyclient");
    // Never fulfilled.
    assert.equal(outcome.fulfilled, undefined);
    // No socket dialled anything.
    assert.deepEqual(attempts, []);
  });

  it("(c) refuses a 302 to https://127.0.0.1.nip.io (a public-looking name for loopback)", async () => {
    // DNS: the attacker's name answers loopback.
    const lookup = guardedLookup(resolveTo("127.0.0.1"));
    // First hop is a fake redirect; the second goes through REAL Node https with the guarded lookup.
    const hop = (url: URL, init: HopInit, b: RenderBudget) => (url.hostname === "jobs.example.com" ? Promise.resolve(redirect("https://127.0.0.1.nip.io/")) : httpsHop(url, init, lookup, b.signal));
    // Follow it, watching every socket.
    const { result, attempts } = await watchConnections(() => followRedirects("https://jobs.example.com/1", GET, hop, budget()));
    // Refused at connect time, with the private-address reason.
    assert.deepEqual(result, { kind: "refused", reason: "A redirect was refused: That link points at a private network address." });
    // Nothing dialled 127.0.0.1.
    assert.deepEqual(attempts, []);
  });

  it("(d) refuses a 6th redirect; 5 are followed", async () => {
    // Hops made.
    let calls = 0;
    // Each hop redirects to the next numbered URL.
    const endless = async (url: URL) => ((calls += 1), redirect(`https://jobs.example.com/r${Number(url.pathname.slice(2)) + 1}`));
    // Six redirects in a row.
    const refused = await followRedirects("https://jobs.example.com/r0", GET, endless, budget());
    // Refused.
    assert.deepEqual(refused, { kind: "refused", reason: "A redirect was refused: too many redirects." });
    // The pasted link plus 5 followed redirects; the 7th URL is never requested.
    assert.equal(calls, 6);
    // Exactly 5 redirects, then a page: allowed (the boundary is not off by one the other way).
    const five = await followRedirects("https://jobs.example.com/r0", GET, async (url) => (url.pathname === "/r5" ? okPage("<p>job</p>") : redirect(`https://jobs.example.com/r${Number(url.pathname.slice(2)) + 1}`)), budget());
    // Followed to the page.
    assert.equal(five.kind, "ok");
  });

  it("closes DNS rebinding: public at the check, 169.254.169.254 at connect -> refused, nothing dialled (rebinding red-on-revert)", async () => {
    // Each resolver answer, in order.
    const answers = ["93.184.216.34", "169.254.169.254"];
    // Calls made to the resolver.
    let resolveCalls = 0;
    // A TTL-0 name: public for the pre-launch check, the metadata address for the connection.
    const rebinding: Resolve = async () => [{ address: answers[Math.min(resolveCalls++, 1)] ?? "", family: 4 }];
    // The `all` flag net.connect passed to the hook, per call.
    const forms: unknown[] = [];
    // The production hook, spied on to prove Node 24's autoSelectFamily array path is the one used.
    const inner = guardedLookup(rebinding);
    // Spy wrapper.
    const spy: LookupFunction = (hostname, options, callback) => {
      // Recorded.
      forms.push(options.all);
      // The real hook decides.
      inner(hostname, options, callback);
    };
    // The browser.
    const { browser, log } = fakeBrowser();
    // The whole request, with the main document going through REAL Node https (autoSelectFamily at its default).
    const { result: res, attempts } = await watchConnections(() =>
      handleRenderRequest(post({ url: "https://jobs.rebind.example/1" }), deps({ resolve: rebinding, hop: (url, init, b) => httpsHop(url, init, spy, b.signal), launchBrowser: async () => browser })),
    );
    // Refused with the contract's 400, not rendered and not a generic 502.
    assert.equal(res.status, 400);
    // The reason is the private-address refusal.
    assert.match((await json(res)).message ?? "", /private network/);
    // DNS was asked twice: the pre-check, then again AT CONNECT TIME.
    assert.equal(resolveCalls, 2);
    // net.connect asked for every address at once (Node 24's default autoSelectFamily).
    assert.deepEqual(forms, [true]);
    // No socket ever dialled the metadata address (or anything else).
    assert.deepEqual(attempts, []);
    // Closed.
    assert.equal(log.closed, true);
  });
});

describe("guardedLookup", () => {
  it("answers in both forms net.connect uses", async () => {
    // Two public addresses.
    const lookup = guardedLookup(async () => [PUBLIC_V4, { address: "2606:2800:220:1:248:1893:25c8:1946", family: 6 }]);
    // The autoSelectFamily form: every address, as objects.
    const all = await callLookup(lookup, true);
    // No error.
    assert.equal(all.error, null);
    // The whole answer.
    assert.deepEqual(all.address, [PUBLIC_V4, { address: "2606:2800:220:1:248:1893:25c8:1946", family: 6 }]);
    // The classic form: one address and its family.
    const one = await callLookup(lookup, false);
    // The first address.
    assert.equal(one.address, "93.184.216.34");
    // Its family.
    assert.equal(one.family, 4);
  });

  it("refuses the WHOLE answer when any address is private, never a filtered subset", async () => {
    // A mixed answer: a rebinding signal.
    const lookup = guardedLookup(async () => [PUBLIC_V4, { address: "169.254.169.254", family: 4 }]);
    // Both forms.
    for (const all of [true, false]) {
      // Ask.
      const answer = await callLookup(lookup, all);
      // Refused with the code followRedirects maps to a refusal.
      assert.equal(answer.error?.code, PRIVATE_ADDRESS);
    }
  });

  it("refuses an empty answer and a resolver failure", async () => {
    // No addresses.
    const empty = await callLookup(guardedLookup(async () => []), true);
    // Not found, not "connect anyway".
    assert.equal(empty.error?.code, "ENOTFOUND");
    // The resolver itself fails.
    const failed = await callLookup(guardedLookup(async () => Promise.reject(new Error("SERVFAIL"))), true);
    // Also not found.
    assert.equal(failed.error?.code, "ENOTFOUND");
  });
});

describe("routeThroughNode", () => {
  it("aborts http://127.0.0.1:9001 (the Lambda runtime API) without any request (route-filter red-on-revert)", async () => {
    // A hop would mean the shape check was skipped.
    let hops = 0;
    // The route state.
    const nav: MainNavigation = { refused: null, movedTo: null };
    // A page script trying to reach the runtime API.
    const { route, outcome } = fakeRoute("http://127.0.0.1:9001/2018-06-01/runtime/invocation/next", { type: "fetch" });
    // Through the handler.
    await routeThroughNode(async () => ((hops += 1), okPage("")), nav, budget())(route);
    // Refused.
    assert.equal(outcome.aborted, "blockedbyclient");
    // Never requested.
    assert.equal(hops, 0);
  });

  it("fulfils https://cdn.example.com/x.js from Node's response", async () => {
    // The route state.
    const nav: MainNavigation = { refused: null, movedTo: null };
    // A normal script.
    const { route, outcome } = fakeRoute("https://cdn.example.com/x.js");
    // Node's response for it, with a stray Location header.
    const script: HopResponse = { status: 200, headers: { "content-type": "text/javascript", location: "http://127.0.0.1/" }, body: Buffer.from("1") };
    // Through the handler.
    await routeThroughNode(async () => script, nav, budget())(route);
    // Served to Chromium.
    assert.equal(outcome.fulfilled?.status, 200);
    // With the bytes Node fetched.
    assert.equal(outcome.fulfilled?.body.toString(), "1");
    // Chromium is never handed a Location it could follow by itself.
    assert.equal(outcome.fulfilled?.headers["location"], undefined);
  });

  it("aborts images, media, fonts and event streams before any request", async () => {
    // A hop would mean the skip list was ignored.
    let hops = 0;
    // The route state.
    const nav: MainNavigation = { refused: null, movedTo: null };
    // Each skipped type.
    for (const type of ["image", "media", "font", "eventsource"]) {
      // A request of that type.
      const { route, outcome } = fakeRoute("https://cdn.example.com/asset", { type });
      // Through the handler.
      await routeThroughNode(async () => ((hops += 1), okPage("")), nav, budget())(route);
      // Aborted.
      assert.equal(outcome.aborted, "blockedbyclient", type);
    }
    // None requested.
    assert.equal(hops, 0);
  });

  it("drops cookies and authorization on a redirect to another host", async () => {
    // The headers each hop carried.
    const seen: Record<string, string>[] = [];
    // First hop redirects off-host.
    const hop = async (url: URL, init: HopInit) => {
      // Recorded.
      seen.push(init.headers);
      // Then a page.
      return url.hostname === "jobs.example.com" ? redirect("https://other.example.net/") : okPage("");
    };
    // A request carrying credentials.
    await followRedirects("https://jobs.example.com/1", { method: "GET", headers: { cookie: "sid=1", authorization: "Bearer x", accept: "*/*" }, body: null }, hop, budget());
    // The second hop kept only the harmless header.
    assert.deepEqual(seen[1], { accept: "*/*" });
  });
});

// --- Finding 1: the browser process ---------------------------------------------------------------

describe("chromiumLaunchOptions (hardened browser process)", () => {
  // sparticuz's real flags as the module reads them (WebGL off, as launchBrowser sets it).
  serverlessChromium.setGraphicsMode = false;
  // The env of a real function: sparticuz's three keys plus secrets that must not reach Chromium.
  const functionEnv = { HOME: "/tmp", LD_LIBRARY_PATH: "/tmp/al2023/lib", FONTCONFIG_PATH: "/tmp/fonts", VERCEL_OIDC_TOKEN: "oidc", SECRET_X: "x", VITE_SUPABASE_ANON_KEY: "anon", PATH: "/usr/bin" };
  // Built once from the real sparticuz 140.0.0 args.
  const options = chromiumLaunchOptions("/tmp/chromium", serverlessChromium.args, functionEnv);

  it("drops the isolation-weakening flags, keeps sparticuz's launch flags, adds the WebRTC flag (flag-filter red-on-revert)", () => {
    // The exact args, as a positive shape: a sparticuz bump that renames a flag fails here first.
    assert.deepEqual(options.args, [
      "--ash-no-nudges",
      "--disable-domain-reliability",
      "--disable-print-preview",
      "--disk-cache-size=33554432",
      "--no-default-browser-check",
      "--no-pings",
      "--single-process",
      "--font-render-hinting=none",
      "--disable-features=AudioServiceOutOfProcess",
      "--ignore-gpu-blocklist",
      "--in-process-gpu",
      "--disable-webgl",
      "--disable-setuid-sandbox",
      "--headless='shell'",
      "--no-sandbox",
      "--no-zygote",
      WEBRTC_FLAG,
    ]);
  });

  it("gives Chromium only HOME, LD_LIBRARY_PATH and FONTCONFIG_PATH, never a secret (env red-on-revert)", () => {
    // Exactly the three keys; VERCEL_OIDC_TOKEN, SECRET_X, the anon key and PATH are absent.
    assert.deepEqual(options.env, { HOME: "/tmp", LD_LIBRARY_PATH: "/tmp/al2023/lib", FONTCONFIG_PATH: "/tmp/fonts" });
    // Unset keys are left out, not passed as "undefined".
    assert.deepEqual(chromiumLaunchOptions("/x", [], { HOME: "/tmp", SECRET_X: "x" }).env, { HOME: "/tmp" });
  });

  it("sends loopback to the dead proxy explicitly", () => {
    // Spelled out, not left to Playwright's own default.
    assert.deepEqual(options.proxy, { server: "http://192.0.2.1:9", bypass: "<-loopback>" });
    // The unpacked binary.
    assert.equal(options.executablePath, "/tmp/chromium");
  });
});

// --- Finding 2: the token must be the app user's ---------------------------------------------------

describe("verifySupabaseUser (app-user pin)", () => {
  it("accepts only the app user's live session (pin red-on-revert)", async () => {
    // The app user.
    assert.equal(await verifySupabaseUser("t", AUTH_ENV, authAnswer(200, { id: APP_USER_ID })), true);
    // A live session of the project's OTHER user.
    assert.equal(await verifySupabaseUser("t", AUTH_ENV, authAnswer(200, { id: "11111111-2222-3333-4444-555555555555" })), false);
    // A 200 without a user shape.
    assert.equal(await verifySupabaseUser("t", AUTH_ENV, authAnswer(200, null)), false);
    // A rejected token.
    assert.equal(await verifySupabaseUser("t", AUTH_ENV, authAnswer(401, { msg: "invalid JWT" })), false);
  });

  it("throws (so the handler answers 502) when Auth is unwell or the env is missing", async () => {
    // Auth's own error.
    await assert.rejects(verifySupabaseUser("t", AUTH_ENV, authAnswer(500, {})));
    // No config is never "anyone may pass".
    await assert.rejects(verifySupabaseUser("t", {}, authAnswer(200, { id: APP_USER_ID })));
  });

  it("answers 401 to a valid JWT of another user, through the whole handler", async () => {
    // A launch would mean another user's token reached the browser.
    let launched = false;
    // Supabase says the token is live, but it belongs to someone else.
    const res = await handleRenderRequest(
      post({ url: "https://jobs.example.com/1" }),
      deps({ verifyUser: (token) => verifySupabaseUser(token, AUTH_ENV, authAnswer(200, { id: "11111111-2222-3333-4444-555555555555" })), launchBrowser: async () => ((launched = true), fakeBrowser().browser) }),
    );
    // Per the contract.
    assert.equal(res.status, 401);
    // No browser.
    assert.equal(launched, false);
  });
});

// --- Finding 3: resource limits --------------------------------------------------------------------

describe("resource limits", () => {
  it("refuses further requests once the render's byte budget is spent (byte-budget red-on-revert)", async () => {
    // Requests that reached the network.
    let hops = 0;
    // A budget smaller than one response.
    const shared = budget(100);
    // Every hop returns 150 bytes.
    const hop = async () => ((hops += 1), okPage("x".repeat(150)));
    // The route state.
    const nav: MainNavigation = { refused: null, movedTo: null };
    // The first request fits the (then unspent) budget.
    const first = fakeRoute("https://cdn.example.com/a.js");
    // Through the handler.
    await routeThroughNode(hop, nav, shared)(first.route);
    // Served, and charged: 100 - 150.
    assert.equal(first.outcome.fulfilled?.status, 200);
    // The budget is now overdrawn.
    assert.equal(shared.bytesLeft, -50);
    // A second request of the same render.
    const second = fakeRoute("https://cdn.example.com/b.js");
    // Through the handler.
    await routeThroughNode(hop, nav, shared)(second.route);
    // Aborted, never requested.
    assert.equal(second.outcome.aborted, "failed");
    // Only the first reached the network.
    assert.equal(hops, 1);
  });

  it("aborts the render's signal when the handler returns (abort-in-finally red-on-revert)", async () => {
    // The signal every hop of the render received.
    const signals: AbortSignal[] = [];
    // Records the signal, serves a page.
    const hop = async (_url: URL, _init: HopInit, b: RenderBudget) => (signals.push(b.signal), okPage("<p>job</p>"));
    // A full render.
    const res = await handleRenderRequest(post({ url: "https://jobs.example.com/1" }), deps({ hop }));
    // It rendered.
    assert.equal(res.status, 200);
    // The main document's hop got the render's signal.
    assert.equal(signals.length, 1);
    // And it is aborted now that the render is over.
    assert.equal(signals[0]?.aborted, true);
  });

  it("ends an in-flight Node request when the render's signal aborts (signal red-on-revert)", async () => {
    // The render's controller.
    const controller = new AbortController();
    // DNS that never answers keeps the request in flight until something ends it.
    const lookup = guardedLookup(() => new Promise(() => {}));
    // The request, started.
    const pending = httpsHop(new URL("https://jobs.example.com/1"), GET, lookup, controller.signal);
    // The render ends.
    controller.abort();
    // The request ends at once with an AbortError, not 15 s later with a timeout.
    await assert.rejects(pending, { name: "AbortError" });
  });
});

// --- Parity with the Deno copy ----------------------------------------------------------------------

// The job-link-intake module, loaded by URL so the typecheck does not pull a Deno file (it uses a
// DOM-only type) into this Node program. Node strips its types at load like any other .ts test import.
const denoModuleUrl = new URL("../../supabase/functions/job-link-intake/fetch-page.ts", import.meta.url).href;
// The three helpers this file copies.
const deno: { isBlockedHost(host: string): boolean; checkPublicUrl(url: URL): string | null; isPublicAddress(ip: string): boolean } = await import(denoModuleUrl);

describe("parity with supabase/functions/job-link-intake/fetch-page.ts", () => {
  it("gives identical verdicts on a table of hosts, links and addresses", () => {
    // Hosts across every branch of isBlockedHost.
    for (const host of ["localhost", "localhost.", "LOCALHOST", "jobs.lever.co", "intranet", "a.internal", "x.local", "h.home.arpa", "sub.localdomain", "127.0.0.1", "[::1]", "10.0.0.5", "127.0.0.1.nip.io", "example.com."]) {
      // Same verdict.
      assert.equal(isBlockedHost(host), deno.isBlockedHost(host), host);
    }
    // Links across every branch of checkPublicUrl.
    for (const link of ["https://jobs.lever.co/x", "http://jobs.lever.co/x", "https://u:p@jobs.lever.co/", "https://jobs.lever.co:8443/", "https://jobs.lever.co:443/", "https://127.0.0.1/", "https://localhost/", "ftp://x.com/", "https://[::1]/", "http://127.0.0.1:9001/2018-06-01/runtime/invocation/next"]) {
      // Same verdict.
      assert.equal(checkPublicUrl(new URL(link)), deno.checkPublicUrl(new URL(link)), link);
    }
    // Addresses across every range of isPublicAddress.
    for (const ip of ["93.184.216.34", "10.1.2.3", "127.0.0.1", "169.254.169.254", "172.16.0.1", "172.32.0.1", "192.168.1.1", "192.0.0.1", "192.0.2.1", "198.18.0.1", "100.64.0.1", "100.128.0.1", "224.0.0.1", "240.0.0.1", "0.0.0.0", "::1", "::ffff:127.0.0.1", "fc00::1", "fd12::1", "fe80::1", "ff02::1", "64:ff9b::1", "2002::1", "2001:0::1", "100::1", "2606:4700::1111", "garbage", ""]) {
      // Same verdict.
      assert.equal(isPublicAddress(ip), deno.isPublicAddress(ip), ip);
    }
  });
});
