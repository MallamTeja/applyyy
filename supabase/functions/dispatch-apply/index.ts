// dispatch-apply: Deno entry point. Every decision lives in handler.ts (node-testable); this file
// only plugs the real sign-in, the real secret and the real fetch into the handler's three seams.
//
// Contract: POST (no body) with the app user's JWT, sent once by the approval page after a
// successful approve. 200 {status:"ok", dispatched:true, approved:N} or {dispatched:false, reason};
// 401/403 for any other caller; 503 for a missing token or an unreadable read; 502 when GitHub refuses.

// The shared CORS headers and the uncaught-throw boundary every function uses.
import { withErrorBoundary } from "../_shared/cors.ts";
// Verify the caller FIRST, then sign in as the app user (W15): a refused caller costs no password grant.
import { createAuthorizedAppUserClient } from "../_shared/db/client.ts";
// The request logic and the secret's name.
import { DISPATCH_TOKEN_ENV_VAR, handleDispatchApply } from "./handler.ts";

// Entry point: the real seams into the tested handler.
Deno.serve(withErrorBoundary("dispatch-apply", (req: Request) =>
  // The three seams: the caller-checked sign-in, the PAT from the function's secrets, and the global fetch.
  handleDispatchApply(req, { connect: createAuthorizedAppUserClient, token: () => Deno.env.get(DISPATCH_TOKEN_ENV_VAR), fetch: (url, init) => fetch(url, init) })
));
