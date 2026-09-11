/* The single Supabase client for the browser.
 *
 * PROJECT_PLAN.md section 10 defense 4 is absolute: the frontend gets the ANON
 * KEY ONLY and relies on RLS, which is enabled on every table from day one
 * specifically so this works. The service-role key must never enter a bundle
 * Vercel serves.
 *
 * A comment saying that would not stop a paste mistake, so this module enforces
 * it. A Supabase key is a JWT whose payload carries a `role` claim, and this
 * file refuses to construct a client - and throws, loudly, at import time -
 * unless that claim reads "anon". Structural prevention over detection, the
 * same reasoning as section 10 defense 1 applied to secret handling. A
 * service-role key pasted into .env.local fails on the developer's own machine
 * before it can ever reach a deployment.
 *
 * WHERE THE DECISION LIVES. `supabaseConfig.ts` decides and this file acts. The
 * split is what makes the decision testable: this module has an import-time
 * side effect, so anything private to it can only be tested by a test that
 * first satisfies the very check it is trying to test. See `keyRole.ts` for the
 * longer version of that argument.
 *
 * ABSENT IS NOT THE SAME AS WRONG, and the distinction is deliberate. A key
 * with a non-anon role is a security failure and still kills the app on sight.
 * NO key at all is just an unconfigured machine - the normal state of a fresh
 * clone - and it leaves the console openable, with the six settings pages that
 * need no database working normally and a visible notice where data would be.
 * The reasoning is in `supabaseConfig.ts`: if importing this module cost the
 * whole app until you found a key, the cheapest fix for an annoyed developer
 * would be to weaken the check, at the exact moment they are least likely to
 * read this comment.
 */

import { createClient } from '@supabase/supabase-js';
import type { SupabaseClient } from '@supabase/supabase-js';

/* The decision, imported rather than redeclared - two copies of a security
   decision is how one of them ends up subtly wrong and nobody notices which
   one is live. */
import { describeRefusal, resolveSupabaseConfig } from './supabaseConfig.ts';
import type { SupabaseConfig } from './supabaseConfig.ts';

/* Read through Vite's env rather than process.env: only VITE_-prefixed values
 * are exposed to the bundle, which is itself a guard against a stray
 * SUPABASE_SERVICE_ROLE_KEY in the shell leaking into the build. */
const config: SupabaseConfig = resolveSupabaseConfig(
  import.meta.env?.['VITE_SUPABASE_URL'],
  import.meta.env?.['VITE_SUPABASE_ANON_KEY'],
);

/* THE FATAL BRANCH, and the only one. Thrown at module scope so it fires the
 * instant anything imports this file - there is no code path that reaches a
 * rendered page with a non-anon key in the bundle. */
if (config.kind === 'refused') {
  throw new Error(describeRefusal(config.role));
}

/* One client for the whole app, or null when nothing is configured.
 *
 * NULL RATHER THAN A STUB CLIENT that returns empty results. A stub would make
 * an unconfigured console indistinguishable from a configured one with no rows
 * - and "empty tables" versus "not connected" are the two readings this whole
 * project works hardest to keep apart. A null forces every caller to say which
 * it is showing. */
export const supabase: SupabaseClient | null =
  config.kind === 'ready'
    ? createClient(config.url, config.anonKey, {
        auth: {
          /* Single-user console on a private repo, but the session still
             persists so that a reload during a 12-minute review session does
             not sign the operator out halfway through the queue. */
          persistSession: true,
          autoRefreshToken: true,
        },
        realtime: {
          /* Realtime is what makes the pipeline kanban live-track for free
             (section 5). Ten events a second is far above this system's real
             rate of ~35 applications a day, and caps a runaway agent from
             flooding the browser with repaints. */
          params: { eventsPerSecond: 10 },
        },
      })
    : null;

/* Whether the console can talk to a database, and why not if it cannot.
 *
 * Exported so a page can render an accurate notice instead of an empty table.
 * `refused` never appears here - that branch threw above - so the type has only
 * the two states a running app can actually be in. */
export type SupabaseStatus =
  | { readonly connected: true }
  | { readonly connected: false; readonly missing: readonly string[] };

export const supabaseStatus: SupabaseStatus =
  config.kind === 'ready'
    ? { connected: true }
    : /* `config.kind` is narrowed to 'unconfigured' here: 'ready' is handled
         above and 'refused' threw, so this is the only remaining case and the
         compiler agrees. */
      { connected: false, missing: config.missing };

/* The client, or a thrown error naming what is missing.
 *
 * For callers that genuinely cannot proceed without data. Kept separate from
 * the nullable export so that the common case - render a notice - does not need
 * a try/catch, while a data-fetching hook that would otherwise dereference null
 * gets a clear message instead of `Cannot read properties of null`. */
export function requireSupabase(): SupabaseClient {
  if (supabase === null) {
    /* Narrow before reading `missing`: the status union only carries it on the
       disconnected branch, and a null client always means disconnected - but
       the compiler wants that connection made explicitly rather than assumed
       from the null. */
    const missing = supabaseStatus.connected
      ? []
      : supabaseStatus.missing;
    throw new Error(
      'applyy console is not connected to Supabase. Set ' +
        /* Named individually, because "check your environment" sends someone
           to a file to guess which line is wrong. */
        missing.join(' and ') +
        ' in apps/web/.env.local. See apps/web/.env.example.',
    );
  }
  return supabase;
}
