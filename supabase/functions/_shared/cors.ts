// Export standard CORS headers for edge functions
// Allows browser fetch requests from applyyy web UI
export const corsHeaders = {
  // Allow all origins for web app cross-origin fetch
  "Access-Control-Allow-Origin": "*",
  // Allow standard headers including authorization, apikey, and content-type
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  // Allow standard HTTP methods
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS, PUT, DELETE",
};

// Wraps a handler so an uncaught throw still answers with JSON AND CORS headers.
//
// WHY: the platform's own 500 for a crashed handler carries no CORS headers, so the
// browser reports it as a CORS failure and hides the status — the operator console then
// shows "Failed to fetch" for what is really a server bug. One wrapper, used by every
// pipeline function, instead of a try/catch each one would have to remember.
export function withErrorBoundary(
  // Prefixes the log line, so a stack in the function logs names its agent.
  name: string,
  handler: (req: Request) => Promise<Response>,
): (req: Request) => Promise<Response> {
  // The returned function is what Deno.serve receives.
  return async (req: Request): Promise<Response> => {
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
  };
}
