// THE TWO GATES EVERY PIPELINE AGENT PASSES BEFORE IT DOES ANY WORK.
//
// Kept in one file, apart from `client.ts`, for a mechanical reason: `client.ts` imports
// `jsr:@supabase/supabase-js`, which `node --test` cannot resolve. These gates are pure
// over narrow seams, so their tests run in the same suite as everything else.
//
// GATE 1 — WHO IS CALLING. `createAppUserClient()` signs in with the app user's env
// credentials and never looks at the request, so before this gate ANYONE holding the
// public anon key (it ships in the browser bundle) could drive the pipeline: the
// platform's `verify_jwt` accepts the anon key because it is itself a valid JWT. The
// gate demands a real user session and that it be the one app user's session.
//
// GATE 2 — THE KILL SWITCH. Each agent used to read `system_settings` its own way: the
// screener halted on a missing row, the normalizer ran on one and ignored read errors,
// and the matcher, tailor and auditor never looked. One helper, one fail-closed rule.

// The slice of `supabase.auth` gate 1 needs. Narrow so a test can fake it.
export interface CallerAuthClient {
  readonly auth: {
    // `getUser(jwt)` asks the auth server, so an expired, forged or anon token fails here
    // — a local decode would happily accept a token signed for a different project.
    getUser(jwt: string): PromiseLike<{
      readonly data: { readonly user: { readonly id: string } | null };
      readonly error: { readonly message: string } | null;
    }>;
  };
}

// The verdict. A closed union rather than a boolean, so the HTTP status travels with it
// and no caller can collapse "no token" and "wrong user" into the same answer.
export type CallerVerdict =
  // A session belonging to the app user. The function may proceed.
  | { readonly ok: true; readonly userId: string }
  // 401: no credential, or one the auth server would not vouch for.
  | { readonly ok: false; readonly status: 401; readonly error: "missing_bearer_token" | "invalid_session" }
  // 403: a real user, but not the one whose data this function acts on.
  | { readonly ok: false; readonly status: 403; readonly error: "caller_is_not_app_user" };

// `Bearer <token>`, one token, nothing else. Validated by shape rather than by slicing
// a prefix off, because a header of just "Bearer " would otherwise yield an empty token
// that only fails one network round trip later.
const BEARER_SHAPE = /^Bearer\s+(\S+)\s*$/i;

// Gate 1. Run before any read or write on the app user's data.
export async function authorizeCaller(
  req: Request,
  client: CallerAuthClient,
  appUserId: string,
): Promise<CallerVerdict> {
  // Absent header and malformed header are the same failure to the caller.
  const match = BEARER_SHAPE.exec(req.headers.get("authorization") ?? "");
  // No token at all: refuse without spending a call on the auth server.
  if (!match) return { ok: false, status: 401, error: "missing_bearer_token" };
  // The captured token. Indexed access is checked because the regex group is optional
  // only in the type system's eyes; the shape above guarantees it.
  const token = match[1];
  // Unreachable by the regex, but the type says it could be undefined.
  if (token === undefined) return { ok: false, status: 401, error: "missing_bearer_token" };

  // Ask the auth server. The anon key has no `sub` claim and is refused here, which is
  // precisely the caller this gate exists to stop.
  const { data, error } = await client.auth.getUser(token);
  // Either an error or a null user is "not a session we can trust" — checked together so
  // a response carrying neither cannot slip through as success.
  if (error !== null || data.user === null) return { ok: false, status: 401, error: "invalid_session" };

  // A valid session for SOMEONE ELSE. RLS would already confine them, but these
  // functions act through the app user's own session, so their RLS is not the caller's.
  if (data.user.id !== appUserId) return { ok: false, status: 403, error: "caller_is_not_app_user" };

  // The app user, verified by the auth server.
  return { ok: true, userId: data.user.id };
}

// The slice of postgrest gate 2 needs — the same shape as `screen/supabase-queries.ts`.
export interface KillSwitchClient {
  from(table: string): {
    select(columns: string): PromiseLike<{ data: unknown[] | null; error: { message: string } | null }>;
  };
}

// What the switch says. Three states, not two: "unreadable" is NOT "off" — it is an
// error the health page must show as one, and NOT "on", because then a failing read
// would run the pipeline.
export type KillSwitchState =
  | { readonly kind: "enabled" }
  // Explicitly off, or no settings row at all. Both halt; neither is an error.
  | { readonly kind: "disabled"; readonly detail: string }
  // The read itself failed. Halts, and reports.
  | { readonly kind: "unreadable"; readonly detail: string };

// Gate 2. FAIL CLOSED: anything but a readable row saying exactly `true` halts.
export async function readKillSwitch(client: KillSwitchClient): Promise<KillSwitchState> {
  // No `.single()`: it turns "no row" into an error code callers then have to special
  // case (PGRST116), which is how the normalizer ended up ignoring every error.
  const { data, error } = await client.from("system_settings").select("system_enabled");
  // A failed read is reported as such, never mistaken for a decision.
  if (error !== null) return { kind: "unreadable", detail: error.message };
  // No row under RLS means bootstrap never ran for this user. The column defaults to
  // false (core_tables.sql:33), so "no row" honours the same default: off.
  if (data === null || data.length === 0) return { kind: "disabled", detail: "no system_settings row" };
  // Strict `=== true` on every row: a null, a string "true", or a second row saying
  // false all halt. §5 — validate the shape, never ask a lenient reader.
  const allOn = data.every((row) =>
    typeof row === "object" && row !== null && (row as { system_enabled?: unknown }).system_enabled === true
  );
  // Off, with the reason the health page shows.
  if (!allOn) return { kind: "disabled", detail: "system_settings.system_enabled is false" };
  // Readable, present, and explicitly on.
  return { kind: "enabled" };
}
