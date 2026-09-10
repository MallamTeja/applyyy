/* The single Supabase client for the browser.
 *
 * PROJECT_PLAN.md section 10 defense 4 is absolute: the frontend gets the ANON
 * KEY ONLY and relies on RLS, which is enabled on every table from day one
 * specifically so this works. The service-role key must never enter a bundle
 * Vercel serves.
 *
 * A comment saying that would not stop a paste mistake, so this module enforces
 * it. A Supabase key is a JWT whose payload carries a `role` claim, and this
 * file refuses to construct a client unless that claim reads "anon".
 * Structural prevention over detection - the same reasoning as section 10
 * defense 1, applied to secret handling. A service-role key pasted into
 * .env.local now fails at boot on the developer's own machine, before it can
 * ever reach a deployment.
 */

import { createClient } from '@supabase/supabase-js';
import type { SupabaseClient } from '@supabase/supabase-js';

/* The pure role reader. Imported rather than redeclared - two copies of a
   security decision is how one of them ends up subtly wrong and nobody
   notices which one is live. */
import { readRoleClaim } from './keyRole';

/* Read through Vite's env rather than process.env: only VITE_-prefixed values
 * are exposed to the bundle, which is itself a guard against a stray
 * SUPABASE_SERVICE_ROLE_KEY in the shell leaking into the build. */
const url: string | undefined = import.meta.env['VITE_SUPABASE_URL'];
const anonKey: string | undefined = import.meta.env['VITE_SUPABASE_ANON_KEY'];

/* The role decision lives in its own side-effect-free module so it can be
 * tested directly. It could not be while it was private to this file: this
 * module throws at import time, so any test importing it had to satisfy the
 * guard before it could test the guard. See keyRole.ts for the full reasoning -
 * the short version is "separate the pure decision from the side effect". */

/* Thrown at import time. Failing to start is the correct response to a
 * misconfigured key: a console that silently renders empty tables because auth
 * failed is worse than one that will not open at all. */
function configurationError(detail: string): never {
  throw new Error(
    'applyy console cannot start: ' + detail + '. See apps/web/.env.example.',
  );
}

/* Explicit empty-string check as well as undefined: an env var present but
 * blank is the most common way a .env.local ends up half-filled. */
if (url === undefined || url === '') {
  configurationError('VITE_SUPABASE_URL is not set');
}
if (anonKey === undefined || anonKey === '') {
  configurationError('VITE_SUPABASE_ANON_KEY is not set');
}

/* The load-bearing check. `service_role` bypasses RLS entirely, so a bundle
 * carrying one would hand every visitor of the deployed URL full read and write
 * access to a database holding a resume, CTC figures and personal answers. */
const role = readRoleClaim(anonKey);
if (role !== 'anon') {
  configurationError(
    'VITE_SUPABASE_ANON_KEY has role "' +
      (role ?? 'unreadable') +
      '", not "anon". The frontend gets the anon key only and relies on RLS ' +
      '(PROJECT_PLAN.md section 10 defense 4). If an operation needs the ' +
      'service-role key, that operation belongs in a Supabase Edge Function',
  );
}

/* One client for the whole app. Two clients would mean two Realtime sockets and
 * two auth sessions racing each other to refresh the same token. */
export const supabase: SupabaseClient = createClient(url, anonKey, {
  auth: {
    /* Single-user console on a private repo, but the session still persists so
     * that a reload during a 12-minute review session does not sign the
     * operator out halfway through the queue. */
    persistSession: true,
    autoRefreshToken: true,
  },
  realtime: {
    /* Realtime is what makes the pipeline kanban live-track for free
     * (section 5). Ten events a second is far above this system's real rate of
     * ~35 applications a day, and caps a runaway agent from flooding the
     * browser with repaints. */
    params: { eventsPerSecond: 10 },
  },
});
