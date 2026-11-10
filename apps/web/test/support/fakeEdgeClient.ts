/* The ONE fake edge client for web tests (W36, 2026-11-10).
   WHY: ~10 test files each hand-built `{ functions: { invoke } }` and had drifted from the real
   EdgeClient, which gained `auth` (refresh + sign-out) for the session-401 retry. `node --test`
   strips types without checking them, so the drift stayed invisible. Any fake that ever answered a
   session 401 would have made invokeEdge call `client.auth.refreshSession` on undefined: a
   TypeError, not the signed-out path the real client takes. Typing the return as the REAL
   EdgeClient makes the next drift a compile error in `tsc -p tsconfig.test.json` (run by CI). */
// Type-only import: the fake must match the shape the app actually calls, nothing looser.
import type { EdgeClient } from '../../src/data/edgeCall.ts';

// The invoke signature, taken from the real type so a test cannot pass one the app never would.
export type FakeInvoke = EdgeClient['functions']['invoke'];

/* Wraps a test's scripted invoke in a full EdgeClient.
   Default auth behaves like supabase-js with NO session (a fake has none to refresh):
   refreshSession RETURNS an error, signOut returns { error: null }. Neither throws, because the
   real auth-js never throws for an auth failure (repo CLAUDE.md §5); a throwing double would
   certify a path production never takes. A test that exercises the refresh passes its own `auth`. */
export function fakeEdgeClient(invoke: FakeInvoke, auth: Partial<EdgeClient['auth']> = {}): EdgeClient {
  // Built fresh per call, so one test's overrides never leak into another's client.
  return {
    // The test's script answers every function call.
    functions: { invoke },
    auth: {
      // No session to trade: the shape auth-js returns for a missing/revoked refresh token.
      refreshSession: async () => ({ error: new Error('fakeEdgeClient: no session to refresh') }),
      // Clearing a session that does not exist succeeds, as auth-js does for scope 'local'.
      signOut: async () => ({ error: null }),
      // A test's own auth methods win over the defaults above.
      ...auth,
    },
  };
}
