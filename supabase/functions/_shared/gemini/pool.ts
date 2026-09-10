// The Gemini key pool client — PROJECT_PLAN.md §6.
//
// THE TRAP THIS EXISTS TO AVOID, stated first because it is the reason the pool lives
// in Postgres rather than in TypeScript: an in-memory round-robin cursor does not work
// here. Edge Functions are stateless, horizontally-scaled isolates, so every
// invocation may be a fresh isolate whose cursor points at key #1. Every agent then
// hammers key 1, exhausts it, and **six keys behave like one while looking perfectly
// healthy in code review.** There is no symptom until quota runs out five times
// earlier than expected.
//
// SO THE LRU LIVES IN SQL AND IS NOT REIMPLEMENTED HERE. `claim_gemini_key()` is one
// atomic `UPDATE … RETURNING` that picks the eligible key with the oldest
// `last_used_at`. This module is a thin, typed wrapper over that call plus the
// environment lookup that turns a key INDEX into a key VALUE. Anything resembling
// selection logic in this file would be a second, divergent implementation of the
// thing the database already does correctly.
//
// LEAST-RECENTLY-USED, NOT ROUND-ROBIN, and the distinction is load-bearing: LRU
// self-balances when calls have uneven cost. A Tailor call and an email
// classification are not the same size, and round-robin would hand them out evenly
// while consuming quota unevenly.
//
// NO HARDCODED QUOTA NUMBER ANYWHERE IN THIS FILE. Google no longer publishes
// free-tier limits (credible reports of Flash being cut 250 → 20 RPD), so any
// constant is a guess that breaks silently the day they change it. The pool is purely
// REACTIVE: use a key until it 429s, believe its own `retry_after`, move on. The only
// gate is `system_settings.gemini_daily_call_budget`, which a human set, and that
// check lives inside the SQL.

// The client type only — this module never creates one, so a caller cannot
// accidentally get an unauthenticated pool.
import type { SupabaseClient } from "jsr:@supabase/supabase-js@2.58.0";

// The environment-variable prefix keys are discovered under.
//
// ZERO-PADDED, AND THAT IS NOT COSMETIC: string sort must equal numeric sort, and
// `GEMINI_API_KEY_10` sorts before `GEMINI_API_KEY_2` without the pad. That bug
// appears at exactly ten keys — i.e. not during development, and not until the day
// someone scales up.
const KEY_ENV_PREFIX = "GEMINI_API_KEY_";

// How high the prefix scan looks. NOT a claim about how many keys exist — it is the
// upper bound of a scan, and the pool must be correct with exactly ONE configured.
// Teja currently has six. Adding a seventh needs no code change, which is the whole
// reason discovery is a scan rather than a list.
const MAX_KEY_INDEX = 99;

// Why a key could not be claimed. THE TWO NULLS ARE DIFFERENT AND THIS UNION EXISTS
// ENTIRELY TO SEPARATE THEM.
//
// `claim_gemini_key()` returns NULL for two situations that demand OPPOSITE responses,
// and the SQL cannot tell them apart:
//
//   - ALL KEYS COOLING (or the daily budget is spent). Completely normal, self-
//     healing, and must NOT be logged as unusual. A health page that cries wolf about
//     ordinary quota behaviour is a page Teja stops reading — which is the same
//     failure mode as an over-eager human-review queue.
//   - NO KEYS CONFIGURED AT ALL. `bootstrap_user_defaults()` does not seed
//     `gemini_key_state` and nothing else in the repo writes to it, so on a fresh
//     account this is the actual state. Every agent then dutifully releases its claim
//     and the pipeline **looks merely idle with no error anywhere** — precisely the
//     silent stop §14 exists to prevent. This one needs a human, immediately.
export type KeyClaim =
  // A key was claimed. `index` must be reported back via `reportResult` either way —
  // the pool learns its capacity from the API, never from a number we guessed.
  | { readonly ok: true; readonly index: number; readonly apiKey: string }
  // Normal quota exhaustion. Release the application claim and let the next run pick
  // it up. NOT an error, and deliberately carries no error text to log.
  | { readonly ok: false; readonly reason: "all_keys_cooling" }
  // No rows in `gemini_key_state`. Needs a human and must surface on the health page.
  | { readonly ok: false; readonly reason: "no_keys_configured" }
  // A key index was claimed but its environment variable is missing. A configuration
  // error distinct from both of the above: the database believes in a key the runtime
  // cannot see.
  | { readonly ok: false; readonly reason: "key_env_missing"; readonly index: number }
  // The claim call itself failed. A genuine error, unlike the two above.
  | { readonly ok: false; readonly reason: "claim_failed"; readonly detail: string };

// Which key indices this runtime actually has values for.
//
// DISCOVERY IS A PREFIX SCAN rather than a configured count, so adding key seven is an
// environment change and not a deploy. Returned sorted numerically so callers that
// display it are not surprised by string ordering.
export function discoverConfiguredKeyIndices(readKey: KeyReader = denoKeyReader): readonly number[] {
  // Accumulator.
  const found: number[] = [];
  // Walk the whole range rather than stopping at the first gap: a missing `_03` must
  // not hide a present `_04`, or removing one key would silently disable every key
  // after it.
  for (let index = 1; index <= MAX_KEY_INDEX; index += 1) {
    // Present and non-empty counts as configured. Uses the same reader as resolution,
    // so a key that is discoverable is guaranteed to be resolvable.
    if (readKey(index) !== null) found.push(index);
  }
  // Numerically ascending.
  return found;
}

// How a key index becomes a key value.
//
// A DEPENDENCY SEAM, for the same reason `posted-at.ts` injects its clock rather than
// reading one: a function that reaches for ambient global state cannot be tested
// without that global existing. `Deno.env` does not exist under `node --test`, and
// the pure logic in this module — above all the two-NULLs distinction — is exactly
// what most needs covering. Injecting the reader keeps the tests in the same runner
// as the rest of the stream instead of splitting the suite across two runtimes.
export type KeyReader = (index: number) => string | null;

// Turn an index into the zero-padded variable name. Shared by the scan and the
// lookup so discovery and resolution cannot disagree about the spelling.
function keyEnvName(index: number): string {
  return `${KEY_ENV_PREFIX}${String(index).padStart(2, "0")}`;
}

// The production reader. Reads `Deno.env`, which is what Edge Functions actually run
// against. Not used by the tests, which supply their own.
export const denoKeyReader: KeyReader = (index) => {
  // The variable for this index.
  const value = Deno.env.get(keyEnvName(index));
  // Absent, or set to whitespace — a variable set to a space would otherwise produce
  // a key that fails every call with an opaque 400.
  if (value === undefined || value.trim().length === 0) return null;
  // Usable.
  return value.trim();
};

// Claim one key.
//
// The `db` client must already be signed in as the app user: `claim_gemini_key()` is
// `security invoker` and resolves `auth.uid()` from the caller's session, so an
// unauthenticated client would claim nothing and look exactly like an empty pool.
export async function claimKey(db: SupabaseClient, readKey: KeyReader = denoKeyReader): Promise<KeyClaim> {
  // THE SQL RETURNS A BARE `smallint`, NOT AN OBJECT. `tables.ts` declares
  // `{ key_index: number }` and is wrong; `SCHEMA_CONTRACT.md` has it right. Reading
  // `data.key_index` here would yield `undefined` on every call and present as a
  // permanently empty pool — an error whose symptom is indistinguishable from the
  // normal cooling case, which is exactly the confusion this module exists to end.
  const { data, error } = await db.rpc("claim_gemini_key");
  // A genuine failure of the call itself.
  if (error !== null) return { ok: false, reason: "claim_failed", detail: error.message };

  // A number means a key was handed out.
  if (typeof data === "number") {
    // Turn the index into a value through the injected reader.
    const apiKey = readKey(data);
    // THE DATABASE BELIEVES IN A KEY THE RUNTIME CANNOT SEE. Distinct from both NULL
    // cases: the pool is not exhausted and not unconfigured, the environment is out of
    // step with `gemini_key_state`. Reported separately so the fix is obvious.
    if (apiKey === null) return { ok: false, reason: "key_env_missing", index: data };
    // Claimed.
    return { ok: true, index: data, apiKey };
  }

  // NULL. Now disambiguate the two very different meanings, which is the whole point
  // of this function existing rather than callers using `.rpc` directly.
  //
  // One extra round trip, taken ONLY on the NULL path, so it costs nothing in the
  // common case. Worth it because the alternative is a system that cannot distinguish
  // "waiting patiently" from "quietly dead".
  const { count, error: countError } = await db.from("gemini_key_state").select("*", { count: "exact", head: true });
  // If we cannot even count, report the claim as failed rather than guessing which
  // NULL this was — a wrong guess here sends a human to look at the wrong thing.
  if (countError !== null) return { ok: false, reason: "claim_failed", detail: `key claim returned null and the pool could not be counted: ${countError.message}` };
  // Zero rows: the pool was never seeded. Needs a human.
  if ((count ?? 0) === 0) return { ok: false, reason: "no_keys_configured" };
  // Rows exist, so they are all cooling or the budget is spent. Normal.
  return { ok: false, reason: "all_keys_cooling" };
}

// Close the loop after every call, success or failure.
//
// THIS IS WHAT MAKES THE POOL REACTIVE. The system discovers its own capacity from
// what the API actually says rather than from a threshold anyone guessed. Skipping
// the report on a success would leave `consecutive_failures` permanently non-zero
// after one bad call, so it is reported unconditionally.
export async function reportResult(
  db: SupabaseClient,
  keyIndex: number,
  success: boolean,
  // Straight from the 429's own `retry_after`. NULL for any non-quota failure — a
  // parse error must not idle a working key, which is why this is not defaulted to
  // some invented backoff.
  retryAfterSeconds: number | null = null,
  // Error text for the health page. Cleared by the SQL on a success.
  errorText: string | null = null,
): Promise<void> {
  // Fire and check. A failure to report is logged rather than thrown: it must not
  // fail the agent's actual work, which has already happened by this point.
  const { error } = await db.rpc("report_gemini_result", {
    p_key_index: keyIndex,
    p_success: success,
    p_retry_after_seconds: retryAfterSeconds,
    p_error: errorText,
  });
  // Visible in the function log without derailing the caller.
  if (error !== null) console.error(`[gemini-pool] report_gemini_result failed for key ${keyIndex}: ${error.message}`);
}

// Parse a `retry_after` out of a 429 response.
//
// BELIEVE THE SERVER, DO NOT INVENT A BACKOFF. Google's own value is the only
// trustworthy number available — anything we choose is a guess about a limit they no
// longer publish. Returns null when the server said nothing, and the SQL then leaves
// the existing cooldown alone rather than inventing one.
export function parseRetryAfterSeconds(response: Response, body?: unknown): number | null {
  // The standard header, which may be a delay in seconds or an HTTP date.
  const header = response.headers.get("retry-after");
  // Plain seconds is the common form.
  if (header !== null && /^\d+$/.test(header.trim())) return Number(header.trim());
  // An HTTP-date form is legal too; convert it to a delay from now.
  if (header !== null) {
    // Attempt the date parse.
    const at = Date.parse(header);
    // Only accept a future instant; a past date would produce a negative cooldown.
    if (!Number.isNaN(at)) {
      // Seconds from now, floored at zero.
      const delta = Math.ceil((at - Date.now()) / 1000);
      // A non-positive delta means it has already elapsed.
      if (delta > 0) return delta;
    }
  }
  // Google's JSON error body carries the delay in a `RetryInfo` detail rather than in
  // the header, so the header alone would miss it on exactly the responses that matter.
  if (typeof body === "object" && body !== null) {
    // Walk the documented shape defensively — this is an error payload, so it is
    // precisely the response least likely to have the structure we expect.
    const details = (body as { error?: { details?: unknown } }).error?.details;
    // The details array, when present.
    if (Array.isArray(details)) {
      // Look for the RetryInfo entry.
      for (const entry of details) {
        // Each entry is an object with a type marker.
        if (typeof entry !== "object" || entry === null) continue;
        // The delay field, formatted like "37s".
        const delay = (entry as { retryDelay?: unknown }).retryDelay;
        // Extract the leading integer from the duration string.
        if (typeof delay === "string") {
          // Match a whole or fractional number of seconds.
          const match = /^(\d+)(?:\.\d+)?s$/.exec(delay.trim());
          // Found one.
          if (match !== null) return Number(match[1]);
        }
      }
    }
  }
  // The server said nothing usable. Do not invent a number.
  return null;
}
