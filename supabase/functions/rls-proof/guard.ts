// THE ENTRY GATE FOR rls-proof (W16 + W34, 2026-11-02). Pure, so node --test reaches it:
// index.ts runs Deno.serve on import.
//
// W16: rls-proof used EMAIL_INTAKE_SHARED_SECRET, the intake's secret, so one leak opened three
// entry points. It now has its own secret and refuses while that secret is unset.
// W34: its "refuse on a populated database" check counted rows UNDER RLS as a test user, who
// owns nothing, so it read 0 on prod and passed. A count that is not scoped by RLS needs the
// service_role key, which no function here holds by design. So the gate checks the PROJECT
// instead: never the production ref, and only a project an operator explicitly marked as a
// throwaway by naming its ref in APPLYY_RLS_PROOF_TARGET_REF.

// Constant-time comparison, reused from the intake's auth module rather than forked.
import { timingSafeEqual } from "../_shared/intake/auth.ts";

// This function's own secret (W16). Set only on a project where the proof may run.
export const RLS_PROOF_SECRET_ENV_VAR = "APPLYY_RLS_PROOF_SECRET";
// The header it travels in: its own name, so it can't be mistaken for the intake's.
export const RLS_PROOF_SECRET_HEADER = "X-Applyy-Rls-Proof-Secret";
// The throwaway marker (W34): must equal the running project's ref.
export const RLS_PROOF_TARGET_REF_ENV_VAR = "APPLYY_RLS_PROOF_TARGET_REF";
// The live project (CLAUDE.md §3). Refused outright, whatever the marker says: a marker is an
// operator's claim, and copying one into prod is exactly the mistake this refusal exists for.
export const PRODUCTION_PROJECT_REF = "xynqxekcqizwhtskzqrq";

// Hosted Supabase URLs only: https://<20 lowercase alphanumerics>.supabase.co.
// ponytail: a local `supabase start` stack (http://kong:8000) is refused too; add a local
// marker if the proof is ever run against one.
const HOSTED_URL = /^https:\/\/([a-z0-9]{20})\.supabase\.co\/?$/;

/** What the gate reads: the request's method and header, and four environment values. */
export interface GateInput {
  // The HTTP method.
  readonly method: string;
  // The secret header, or null when absent.
  readonly presentedSecret: string | null;
  // APPLYY_RLS_PROOF_SECRET, trimmed, or undefined when unset or blank.
  readonly configuredSecret: string | undefined;
  // SUPABASE_URL, platform-injected.
  readonly supabaseUrl: string | undefined;
  // APPLYY_RLS_PROOF_TARGET_REF, or undefined when unset.
  readonly targetRef: string | undefined;
}

/** Run, or refuse with the status and a fixed message. A union, so "refused" carries why. */
export type GateVerdict = { readonly ok: true } | { readonly ok: false; readonly status: 401 | 405 | 409 | 500; readonly error: string };

/** Every check before rls-proof may sign in or write a row. Order: cheapest refusal first. */
export function runGate(input: GateInput): GateVerdict {
  // A diagnostic that writes rows must not be triggerable by a link.
  if (input.method !== "POST") return { ok: false, status: 405, error: "method not allowed" };
  // Fail closed on missing configuration (W16): unset never means "allow".
  if (input.configuredSecret === undefined || input.configuredSecret.length === 0) return { ok: false, status: 500, error: `${RLS_PROOF_SECRET_ENV_VAR} is not set` };
  // Absent or wrong secret: the same 401, so a caller learns nothing about which.
  if (input.presentedSecret === null || !timingSafeEqual(input.presentedSecret, input.configuredSecret)) return { ok: false, status: 401, error: "unauthorized" };
  // The running project's ref; an unreadable URL means the project cannot be identified.
  const ref = HOSTED_URL.exec(input.supabaseUrl ?? "")?.[1];
  // Unidentified: refuse rather than guess.
  if (ref === undefined) return { ok: false, status: 500, error: "SUPABASE_URL does not name a hosted project" };
  // W34: never on the live project.
  if (ref === PRODUCTION_PROJECT_REF) return { ok: false, status: 409, error: "REFUSING TO RUN: this is the production project" };
  // W34: only on a project explicitly marked as a throwaway, by its own ref.
  if (input.targetRef !== ref) return { ok: false, status: 409, error: `REFUSING TO RUN: ${RLS_PROOF_TARGET_REF_ENV_VAR} does not name this project` };
  // Every gate passed.
  return { ok: true };
}
