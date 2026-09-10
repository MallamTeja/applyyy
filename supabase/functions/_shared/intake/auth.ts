// Shared-secret authentication for the Gmail intake endpoint.
//
// WHY A SHARED SECRET AND NOT A SUPABASE JWT: Apps Script runs inside Google's
// infrastructure as Teja, with no Supabase session and no way to mint a project JWT.
// So the function must run with `verify_jwt = false`, which makes it publicly
// reachable — and a publicly reachable ingest that anyone can POST to is an open relay
// into the Gemini quota. One forged batch of fifty messages is fifty classifications
// Teja did not ask for, on six keys of unmeasured capacity (§18.2).
//
// WHY NOT SHIP THE ANON KEY INSTEAD, which is the obvious alternative: the anon key is
// already published — it is compiled into the Vercel bundle every visitor downloads.
// Requiring it would authenticate nobody while LOOKING like authentication, which is
// the worst property a control can have. The secret here is one Teja generates and
// puts in exactly two places: Apps Script's script properties, and the Supabase
// function's environment.

// The environment variable holding the expected secret. Named as a constant so the
// handler, the tests and the Apps Script setup instructions cannot drift apart — a
// mismatch here presents as a permanent 401 with no clue which side is wrong.
export const INTAKE_SECRET_ENV_VAR = "EMAIL_INTAKE_SHARED_SECRET";

// The header Apps Script sends it in. A custom header rather than `Authorization`
// because Supabase's gateway has its own opinions about `Authorization`, and a value
// that two layers both want to interpret is a debugging session waiting to happen.
export const INTAKE_SECRET_HEADER = "X-Applyy-Intake-Secret";

// Why a request was refused, or that it was not. A union rather than a boolean because
// "no secret is configured" and "the wrong secret was sent" are different operational
// problems with different fixes, and collapsing them into `false` loses that.
export type IntakeAuthResult =
  // The presented secret matched.
  | { readonly ok: true }
  // Refused. `status` is the code to return; `reason` is for the server log ONLY.
  | { readonly ok: false; readonly status: 401 | 500; readonly reason: string };

// Constant-time comparison of two strings.
//
// WHY NOT `a === b`: string equality short-circuits at the first differing byte, so how
// long it takes to fail leaks how many leading bytes were correct. That turns guessing
// a secret from an exhaustive search into a per-character one — feasible against an
// endpoint an attacker can call as often as they like. This is a textbook timing side
// channel and the mitigation is cheap, so there is no reason to accept the risk.
export function timingSafeEqual(presented: string, expected: string): boolean {
  // Compare bytes, not code units: two different strings can share a UTF-16 length
  // while differing in encoded size, and the byte view is what actually crossed the wire.
  const encoder = new TextEncoder();
  // The value the caller supplied.
  const presentedBytes = encoder.encode(presented);
  // The value we expect.
  const expectedBytes = encoder.encode(expected);
  // Length is not secret — it is observable from the request anyway — but the loop
  // below must still run a fixed number of iterations, so bound it on the EXPECTED
  // length rather than returning early on a mismatch.
  let difference = presentedBytes.length ^ expectedBytes.length;
  // Walk the full expected length every time, regardless of where the first difference
  // is. Accumulating with OR means the result depends on the data but the TIMING does not.
  for (let index = 0; index < expectedBytes.length; index += 1) {
    // Out-of-range reads on the shorter array yield undefined, so coerce to 0 — the
    // length XOR above has already guaranteed a mismatch in that case.
    const presentedByte = presentedBytes[index] ?? 0;
    // The expected byte at the same position.
    const expectedByte = expectedBytes[index] ?? 0;
    // OR the XOR in: any differing byte leaves a permanent non-zero bit.
    difference |= presentedByte ^ expectedByte;
  }
  // Zero means every byte and the length matched.
  return difference === 0;
}

// Decide whether a request may proceed. Takes the presented header and the configured
// secret as plain arguments rather than reading the environment itself — that is what
// makes the whole decision table testable without a live Deno environment.
export function authenticateIntake(presented: string | null, configured: string | undefined): IntakeAuthResult {
  // FAIL CLOSED ON MISSING CONFIGURATION. An unset secret must never mean "allow
  // everything": that is precisely how a hardening step gets skipped in an environment
  // nobody re-checked. 500 rather than 401 because the fault is ours, not the caller's,
  // and the distinction is what tells Teja to go set the variable.
  if (configured === undefined || configured.trim().length === 0) {
    return { ok: false, status: 500, reason: `${INTAKE_SECRET_ENV_VAR} is not set` };
  }
  // A missing header is an unauthenticated caller — most likely a scanner, since the
  // URL is public. Same response as a wrong secret, deliberately: telling an attacker
  // whether the header name was right is free reconnaissance.
  if (presented === null || presented.length === 0) {
    return { ok: false, status: 401, reason: `${INTAKE_SECRET_HEADER} header absent` };
  }
  // The comparison itself, in constant time.
  if (!timingSafeEqual(presented, configured)) {
    return { ok: false, status: 401, reason: "presented secret did not match" };
  }
  // Authenticated.
  return { ok: true };
}
