/* Deciding what to do with the Supabase env vars we were handed.
 *
 * WHY THIS IS A SEPARATE, PURE MODULE. Same reason as `keyRole.ts`: the
 * decision is the part that can be subtly wrong, and the side effect - throwing
 * at import time, or constructing a client - is what makes the decision hard to
 * reach from a test. So this file decides and returns; `supabase.ts` acts.
 *
 * THE DISTINCTION THIS MODULE EXISTS TO DRAW, and it is a real design decision
 * rather than a refactor. The original guard treated three situations
 * identically and threw at import time for all of them:
 *
 *   1. No env vars at all.            <- an unconfigured machine
 *   2. Env vars present but blank.    <- a half-filled .env.local
 *   3. A key whose role is not anon.  <- A SECURITY FAILURE
 *
 * Only the third is dangerous. Cases 1 and 2 mean "nobody has set this up
 * yet", which is the normal state of a fresh clone - and crashing the entire
 * console for it has a cost that is easy to miss: every page, including the six
 * settings pages that need no database at all, goes blank. The console becomes
 * unopenable on any machine without a key.
 *
 * That matters because of what it does to the guard's own survival. If merely
 * IMPORTING the client costs you the whole app until you find a key, then the
 * cheapest way for a future developer to get their page back is to weaken or
 * bypass the check - and they will be doing it while annoyed, at the exact
 * moment they are least inclined to read the comment explaining why it is
 * there. A guard that only fires on the case it was built for is a guard that
 * stays in the codebase.
 *
 * So: case 3 stays maximally loud and fatal, unchanged. Cases 1 and 2 become a
 * reported, visible, non-fatal state. The security property is identical - a
 * service-role key still cannot reach a running bundle - and the pressure to
 * dilute it is gone.
 *
 * WHAT IS NOT SOFTENED, to be explicit: a key with a readable role that is not
 * "anon", and a key whose role cannot be read at all, both still refuse. "I
 * could not tell what this key is" is never treated as permission - see
 * `keyRole.ts`.
 */

/* EXPLICIT .ts EXTENSION, and it is required rather than stylistic. This is a
   VALUE import, so Node's ESM resolver has to resolve it when `node --test`
   runs the sources directly - and Node requires the extension where Vite's
   bundler resolution does not. `packages/resume-template` already writes its
   imports this way for the same class of reason (Deno), so this matches the
   repo rather than inventing a local rule.
   The rule that follows: any value import in a module reachable from a test
   needs the extension. A type-only import does not, because it is erased. */
import { readRoleClaim } from './keyRole.ts';

/* What the environment gave us, decided.
 *
 * A DISCRIMINATED UNION rather than a nullable client plus an error string,
 * because the caller has three genuinely different jobs - construct a client,
 * render an unconfigured notice, or refuse to run - and a union makes the
 * compiler insist all three are handled. */
export type SupabaseConfig =
  /* Everything present and the key is an anon key. */
  | {
      readonly kind: 'ready';
      readonly url: string;
      readonly anonKey: string;
    }
  /* Nothing dangerous, just not set up. The console should still open. */
  | {
      readonly kind: 'unconfigured';
      /* Which variables are missing or blank, named individually so the notice
         can tell the operator exactly what to add rather than "check your
         env". */
      readonly missing: readonly string[];
    }
  /* THE SECURITY CASE. The caller must throw on this and must not construct a
     client. Carried as data rather than thrown from here so that this module
     stays pure and this branch stays testable. */
  | {
      readonly kind: 'refused';
      /* The role that was actually read, or null when the token could not be
         decoded at all. Both refuse; they read differently in the message. */
      readonly role: string | null;
    };

/* Decide, from the two raw env values.
 *
 * Takes the values as parameters rather than reading `import.meta.env` itself,
 * which is what lets a test drive every branch. A module that reads its own
 * environment can only ever be tested in the environment it finds. */
export function resolveSupabaseConfig(
  rawUrl: string | undefined,
  rawAnonKey: string | undefined,
): SupabaseConfig {
  /* Blank counts as absent. An env var that exists with an empty value is the
     most common way a `.env.local` ends up half-filled - someone pastes the
     URL, means to come back for the key, and does not. Treating '' as set
     would hand an empty string to `createClient` and produce a confusing
     network error instead of a clear notice. */
  const missing: string[] = [];
  if (rawUrl === undefined || rawUrl.trim() === '') missing.push('VITE_SUPABASE_URL');
  if (rawAnonKey === undefined || rawAnonKey.trim() === '') {
    missing.push('VITE_SUPABASE_ANON_KEY');
  }

  /* Report BOTH missing variables in one go rather than stopping at the first.
     Two round trips to fix one file is a needless second trip. */
  if (missing.length > 0) {
    return { kind: 'unconfigured', missing };
  }

  /* Both are non-blank strings by here, but the compiler cannot see that
     through the array-push above, so narrow explicitly rather than asserting.
     An assertion would be the one place in this file where a mistake is
     invisible. */
  if (rawUrl === undefined || rawAnonKey === undefined) {
    return { kind: 'unconfigured', missing: ['VITE_SUPABASE_URL', 'VITE_SUPABASE_ANON_KEY'] };
  }

  /* THE LOAD-BEARING CHECK, unchanged in strictness. `service_role` bypasses
     RLS entirely, so a bundle carrying one would hand every visitor of the
     deployed URL full read and write access to a database holding a resume,
     CTC figures and personal answers. */
  const role = readRoleClaim(rawAnonKey);
  if (role !== 'anon') {
    /* Fails closed: an unreadable role arrives here as null and refuses, in
       exactly the same branch as an explicit `service_role`. */
    return { kind: 'refused', role };
  }

  return { kind: 'ready', url: rawUrl, anonKey: rawAnonKey };
}

/* The message for a refusal.
 *
 * Built here rather than in `supabase.ts` so the wording is covered by the same
 * tests as the decision - the text is the only thing the operator will actually
 * see, and a guard that fires with an unhelpful message gets worked around
 * rather than understood. */
export function describeRefusal(role: string | null): string {
  return (
    'applyy console cannot start: VITE_SUPABASE_ANON_KEY has role "' +
    /* `null` means the token could not be decoded. Saying "unreadable" rather
       than printing null tells the operator the shape is wrong, not that the
       claim said the word null. */
    (role ?? 'unreadable') +
    '", not "anon". The frontend gets the anon key only and relies on RLS ' +
    '(PROJECT_PLAN.md section 10 defense 4). If an operation needs the ' +
    'service-role key, that operation belongs in a Supabase Edge Function - ' +
    'do not weaken this check to make a build or a deploy succeed.'
  );
}
