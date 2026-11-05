// SKILL-GAP AGGREGATOR — Deno entry point. Every decision lives in handler.ts (node-testable);
// this file only plugs the real app-user sign-in into the handler's one seam.
//
// Contract: POST (no body, no query) with the app user's JWT. 200 { success, aggregatedSkills }
// or { success, status: "skipped_disabled" }; 401/403 for any other caller; 409/500/503 JSON errors.

// The app-user client: every read and write in the handler runs under RLS as that user.
import { createAuthorizedAppUserClient } from "../_shared/db/client.ts";
// The request logic, split out so node --test can import it without the jsr client.
import { handleSkillGap } from "./handler.ts";

// Entry point: the real sign-in into the tested handler.
// The caller is verified BEFORE the password sign-in (W15, 2026-11-05): a refused caller costs no grant.
Deno.serve((req: Request) => handleSkillGap(req, () => createAuthorizedAppUserClient(req)));
