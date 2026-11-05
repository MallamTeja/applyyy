// SKILL-GAP AGGREGATOR — Deno entry point. Every decision lives in handler.ts (node-testable);
// this file only plugs the real app-user sign-in into the handler's one seam.
//
// Contract: POST (no body, no query) with the app user's JWT. 200 { success, aggregatedSkills }
// or { success, status: "skipped_disabled" }; 401/403 for any other caller; 409/500/503 JSON errors.

// The app-user client: every read and write in the handler runs under RLS as that user.
import { createAuthorizedAppUserClient } from "../_shared/db/client.ts";
// The request logic, split out so node --test can import it without the jsr client.
import { handleSkillGap } from "./handler.ts";
// The per-request origin decision (P2 #3): handler.ts spreads the shared header list, and
// since 2026-11-05 the allow-origin header itself is added only by this wrapper.
import { withCors } from "../_shared/cors.ts";

// Entry point: the real sign-in into the tested handler.
// The caller is verified BEFORE the password sign-in (W15, 2026-11-05): a refused caller costs no grant.
// withCors so the browser sees the allowlisted origin on every response, preflight included.
Deno.serve(withCors((req: Request) => handleSkillGap(req, () => createAuthorizedAppUserClient(req))));
