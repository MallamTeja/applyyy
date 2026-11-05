// CORS for every edge function — the ONE source (P2 #3, 2026-11-05).
//
// WHAT CHANGED AND WHY. Until 2026-11-05 every function answered
// `Access-Control-Allow-Origin: *`. Auth is a bearer token, not a cookie, so this was not a
// CSRF hole, but it let ANY web origin holding a token call the functions from a browser. Now
// only the web app's own origins get an allow header, echoed back per request (a response can
// name exactly one origin, so a fixed header cannot serve both prod and dev), with
// `Vary: Origin` so a shared cache never replays one origin's answer to another.
//
// CORS IS A BROWSER CONTROL, NEVER A SERVER-CALL BLOCK. A request with NO Origin header is a
// server-to-server call (Teja's Apps Script calling gmail-sync / email-tracker-intake, GitHub
// Actions, curl): browsers always send Origin on cross-origin fetches, servers don't. Such a
// request is answered normally, just without an allow header, which a server ignores. A
// disallowed browser origin likewise gets its normal response minus the allow header, so the
// BROWSER refuses to hand it to the page. Nothing here ever returns 403 on Origin: that would
// turn a header policy into an outage for every server caller.
//
// Four functions (gmail-sync, interview-prep, referral, scout-ats) used to carry private copies
// of a `*` header; they now import this file, so there is one list to change.

// The browser origins allowed to read responses. Exact strings, compared exactly: no
// wildcards, no suffix matching ("*.vercel.app" would admit every Vercel customer's site).
export const ALLOWED_ORIGINS: ReadonlySet<string> = new Set([
  // The production web app (Vercel).
  "https://applyyy.vercel.app",
  // `vite dev` on its default port, for local development against the deployed functions.
  "http://localhost:5173",
]);

// The non-origin CORS headers, the same for every response. Spread into each function's
// response headers as before; the per-request allow header is added by `withCors` below.
export const corsHeaders = {
  // The headers supabase-js and our own fetches send.
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  // Every method a function here answers, plus the preflight itself.
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS, PUT, DELETE",
};

// The allow header for one request's Origin, or nothing.
//
// Exported so the tests can pin the decision without building a server. Returns an empty
// object (not a header with an empty value) when the origin is absent or not allowed, because
// an `Access-Control-Allow-Origin: ""` header is malformed rather than a refusal.
export function allowOriginFor(origin: string | null): Record<string, string> {
  // Absent (a server caller) or not on the list: no allow header at all.
  if (origin === null || !ALLOWED_ORIGINS.has(origin)) return {};
  // Allowed: echo exactly what the browser sent.
  return { "Access-Control-Allow-Origin": origin };
}

// Wraps a handler so EVERY response it returns, preflight included, carries the right
// per-request CORS headers. The handler keeps spreading `corsHeaders` as it always did;
// this adds the origin decision and `Vary: Origin` in one place, so no function can forget.
export function withCors(
  // The function's own request handler, unchanged.
  handler: (req: Request) => Promise<Response>,
): (req: Request) => Promise<Response> {
  // The returned function is what Deno.serve (or withErrorBoundary) receives.
  return async (req: Request): Promise<Response> => {
    // Whatever the handler decided: status, body and its own headers.
    const res = await handler(req);
    // Copied, because a Response's headers can be immutable (e.g. one returned from fetch()).
    const headers = new Headers(res.headers);
    // Remove any allow header a handler set itself, so this file is the only one that decides.
    headers.delete("Access-Control-Allow-Origin");
    // The per-request decision.
    for (const [name, value] of Object.entries(allowOriginFor(req.headers.get("origin")))) headers.set(name, value);
    // The answer depends on Origin, so caches must key on it.
    headers.append("Vary", "Origin");
    // Same body and status, new headers.
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  };
}

// Wraps a handler so an uncaught throw still answers with JSON AND CORS headers.
//
// WHY: the platform's own 500 for a crashed handler carries no CORS headers, so the
// browser reports it as a CORS failure and hides the status — the operator console then
// shows "Failed to fetch" for what is really a server bug. One wrapper, used by every
// pipeline function, instead of a try/catch each one would have to remember.
// The origin decision is applied by `withCors`, OUTSIDE the catch, so the 500 below gets it too.
export function withErrorBoundary(
  // Prefixes the log line, so a stack in the function logs names its agent.
  name: string,
  handler: (req: Request) => Promise<Response>,
): (req: Request) => Promise<Response> {
  // withCors wraps the try/catch, so both the handler's answer and the 500 get CORS.
  return withCors(async (req: Request): Promise<Response> => {
    try {
      // `await` inside the try, or a rejected promise would escape the catch.
      return await handler(req);
    } catch (err) {
      // The detail goes to the server log only — a stack trace in a response body
      // describes the internals to whoever is calling.
      console.error(`[${name}] unhandled error:`, err);
      // Same JSON shape as every other failure these functions return.
      return new Response(JSON.stringify({ success: false, error: "internal_error" }), {
        status: 500,
        // CORS is the whole point: without it the browser never shows this 500.
        headers: { "content-type": "application/json; charset=utf-8", ...corsHeaders },
      });
    }
  });
}
