// The rehearsal's optional check that the app password works and belongs to the row owner.
//
// ITS OWN SESSION ONLY (2026-11-07 11:04 IST). This used to call client.auth.signOut() with no options.
// supabase-js defaults that to scope 'global': POST /auth/v1/logout?scope=global revoked EVERY session
// of the user, so Teja's browser was logged out and his AI resume chat failed with session_not_found.
// A check signs out with scope 'local', which ends only the session it just made.
// A module of its own (not the CLI file), so the scope is tested without running the CLI's main().

/** One line of the rehearsal table. */
export interface CheckLine {
  // The check's name in the table.
  readonly name: string;
  // PASS, WAIT (Teja's to do) or FAIL.
  readonly verdict: 'PASS' | 'WAIT' | 'FAIL';
  // Why, never a secret.
  readonly why: string;
}

/** The slice of a supabase-js client this check uses, so tests pass a fake that records signOut's argument. */
export interface SignInClient {
  readonly auth: {
    // The same sign-in assist does.
    signInWithPassword(credentials: { email: string; password: string }): Promise<{ data: { session: { user: { id: string } } | null }; error: { message: string } | null }>;
    // Must be called with { scope: 'local' }: see the header.
    signOut(options: { scope: 'local' }): Promise<unknown>;
  };
}

/** Builds the client; production passes supabase-js's createClient. */
export type SignInClientFactory = (url: string, anonKey: string) => SignInClient;

/** An environment, as process.env is; the check reads four names and never prints a value. */
export type SignInEnv = Readonly<Record<string, string | undefined>>;

/** Signs in when all four values are set, checks the owner, and ends only that session. */
export async function signInCheck(env: SignInEnv, ownerId: string, makeClient: SignInClientFactory): Promise<CheckLine[]> {
  // All four are needed for a sign-in.
  const { SUPABASE_URL: url, SUPABASE_ANON_KEY: anon, APPLYY_APP_USER_EMAIL: email, APPLYY_APP_USER_PASSWORD: password } = env;
  // Not set yet: Teja's to fill, and no client is built at all.
  if (!url || !anon || !email || !password) return [{ name: 'sign-in', verdict: 'WAIT', why: 'needs SUPABASE_URL, SUPABASE_ANON_KEY, APPLYY_APP_USER_EMAIL, APPLYY_APP_USER_PASSWORD' }];
  // The client, built only now.
  const client = makeClient(url, anon);
  // The sign-in assist would do.
  const auth = await client.auth.signInWithPassword({ email, password });
  // Who it signed in as.
  const signedIn = auth.data.session?.user.id ?? null;
  // A refused password: the provider's message, and no session to end.
  if (auth.error || signedIn === null) return [{ name: 'sign-in', verdict: 'FAIL', why: auth.error?.message ?? 'no session issued' }];
  try {
    // The password works, and it must be the row's owner: two accounts share a prefix.
    return [
      { name: 'sign-in', verdict: 'PASS', why: 'session issued, then ended (local scope)' },
      { name: 'signed-in = owner', verdict: signedIn === ownerId ? 'PASS' : 'FAIL', why: `signed in ${signedIn.slice(0, 8)}, owner ${ownerId.slice(0, 8)}` },
    ];
  } finally {
    // ONLY this session. Never the default: 'global' logs the user out everywhere (see header).
    await client.auth.signOut({ scope: 'local' });
  }
}
