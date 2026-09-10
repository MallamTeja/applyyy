// How every Edge Function in this stream reaches the database.
//
// THE DECISION THIS FILE ENCODES, because it is a security decision and not a wiring
// detail: Edge Functions sign in as the ORDINARY SUPABASE AUTH USER and run under
// normal RLS. There is no service-role key anywhere in this stream.
//
// SCHEMA_CONTRACT.md §8.3 already argued this for the GitHub Actions worker, and the
// argument transfers unchanged. Restated because it is the reasoning, not the
// conclusion, that has to survive:
//
//   - Service-role key leaked  = every table, RLS bypassed, and rotating it means
//                                redeploying every consumer.
//   - App-user password leaked = one account's data, revocable in the dashboard in
//                                seconds, ceiling is what that user could already do
//                                through the web UI.
//
// The blast radii are not close. And the resulting property is worth stating plainly:
// *an Edge Function cannot do anything Teja could not do from the dashboard.* On a
// system that submits applications to real employers, that is a property worth paying
// one sign-in round trip for.
//
// A NOTE ON THE ALTERNATIVE THAT SOUNDS SAFER AND IS NOT: a custom scoped Postgres
// role is reached by signing a JWT with the project JWT secret, so the function would
// have to hold that secret — and anyone holding it can mint a token claiming
// `role: service_role`. It would read as least privilege in the migration while being
// a god-mode key in the environment. That is the worst kind of control: one that reads
// as safe.

// The official client. Pinned to an exact version rather than a range: a floating
// range re-resolves on a redeploy nobody triggered, so the build would change for
// someone who edited nothing — the hardest kind of break to diagnose.
import { createClient, type SupabaseClient } from "jsr:@supabase/supabase-js@2.58.0";

// Supabase injects these two into every function's environment automatically, so they
// are the one pair Teja never has to set by hand.
const SUPABASE_URL_ENV_VAR = "SUPABASE_URL";
// The public, RLS-bound key. Safe to use here for the same reason it is safe in the
// browser bundle: on its own it grants nothing until a user session is attached.
const SUPABASE_ANON_KEY_ENV_VAR = "SUPABASE_ANON_KEY";

// The single application identity every component signs in as.
//
// WHY "APP_USER" AND NOT "WORKER": there is exactly ONE Supabase Auth user in this
// system, because RLS scopes every row by `auth.uid()` and a second auth user would be
// a second, disjoint `user_id` — the worker and the dashboard would silently stop
// seeing each other's rows. So this credential pair is not the worker's; the worker
// merely also uses it. SCHEMA_CONTRACT §8.3 calls the same pair `APPLYY_WORKER_*`,
// which names one thing after one of its several consumers. Flagged to the schema
// owner rather than silently duplicated: two names for one credential is how the two
// drift apart and someone rotates only one of them.
export const APP_USER_EMAIL_ENV_VAR = "APPLYY_APP_USER_EMAIL";
// The password for that same identity.
export const APP_USER_PASSWORD_ENV_VAR = "APPLYY_APP_USER_PASSWORD";

// Why a client could not be built, or the client itself. A union rather than a throw
// because a missing environment variable is an operational condition with a specific
// HTTP status, and an exception would flatten it into an unhelpful 500.
export type DbClientResult =
  // Signed in and ready. Every query through this client runs under the user's RLS.
  | { readonly ok: true; readonly db: SupabaseClient }
  // Could not sign in. `reason` is for the server log only — it must never reach a
  // response body, because it distinguishes "no such user" from "wrong password".
  | { readonly ok: false; readonly reason: string };

// Read an environment variable, treating whitespace as absence. A variable set to a
// space is the same operational mistake as an unset one, and a client built on it
// would fail later with a far less obvious error.
function readEnv(name: string): string | undefined {
  // `Deno.env.get` returns undefined for an unset variable.
  const raw = Deno.env.get(name);
  // Absent.
  if (raw === undefined) return undefined;
  // Present but empty of content is absence for our purposes.
  const trimmed = raw.trim();
  // Normalise both forms of absence to one, so callers test one condition.
  return trimmed.length === 0 ? undefined : trimmed;
}

// Build an authenticated client.
//
// A FRESH SIGN-IN PER INVOCATION IS DELIBERATE, not an oversight to optimise away.
// Edge Functions are stateless isolates: a module-level cached session would be
// re-created on most invocations anyway, and the invocations where it WAS reused would
// be the ones holding a token old enough to have expired. Paying one predictable round
// trip beats an intermittent 401 that only reproduces under load — the same class of
// mistake as the in-memory key cursor §6 warns about, in a different costume.
export async function createAppUserClient(): Promise<DbClientResult> {
  // The project URL, injected by the platform.
  const url = readEnv(SUPABASE_URL_ENV_VAR);
  // The public key, also injected.
  const anonKey = readEnv(SUPABASE_ANON_KEY_ENV_VAR);
  // Both are platform-provided, so their absence means the function is running
  // somewhere unexpected rather than that Teja forgot something.
  if (url === undefined || anonKey === undefined) {
    return { ok: false, reason: `${SUPABASE_URL_ENV_VAR} or ${SUPABASE_ANON_KEY_ENV_VAR} is not set` };
  }
  // The application identity, which Teja does set by hand.
  const email = readEnv(APP_USER_EMAIL_ENV_VAR);
  // And its password.
  const password = readEnv(APP_USER_PASSWORD_ENV_VAR);
  // FAIL CLOSED. Without credentials there is no anonymous fallback to degrade to —
  // an unauthenticated client would see nothing under RLS and every query would
  // return zero rows, which presents as "the system is idle" rather than as an error.
  // That is exactly the silent stop §14 warns about, so it must be loud here.
  if (email === undefined || password === undefined) {
    return { ok: false, reason: `${APP_USER_EMAIL_ENV_VAR} or ${APP_USER_PASSWORD_ENV_VAR} is not set` };
  }
  // Build the client with session persistence off: there is no storage to persist to
  // in an isolate that is about to be discarded, and leaving it on makes the client
  // reach for a `localStorage` that does not exist.
  const db = createClient(url, anonKey, {
    auth: {
      // Nothing to persist in a stateless isolate.
      persistSession: false,
      // No long-lived session means nothing to refresh; the sign-in above is the whole
      // lifetime of this token.
      autoRefreshToken: false,
      // There is no URL fragment to parse — this is a server, not a browser redirect.
      detectSessionInUrl: false,
    },
  });
  // Sign in. From here the client carries an `authenticated` JWT and every subsequent
  // query is filtered by the same RLS policies the dashboard runs under.
  const { error } = await db.auth.signInWithPassword({ email, password });
  // A failure here is almost always a wrong password or a user that was never created
  // (SCHEMA_CONTRACT §8.3 lists that as a pending manual setup step).
  if (error !== null) {
    return { ok: false, reason: `sign-in failed: ${error.message}` };
  }
  // Authenticated and RLS-bound.
  return { ok: true, db };
}
