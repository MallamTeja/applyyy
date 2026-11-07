// Tests for the rehearsal's password sign-in check (src/assist/sign-in-check.ts).
//
// WHY (2026-11-07 11:04 IST): the check called client.auth.signOut() with no options. supabase-js
// defaults that to scope 'global', which revokes EVERY session of the user, so Teja's browser was
// logged out and his AI resume chat failed with session_not_found. A check must only end its OWN session.
import { describe, expect, it, vi } from 'vitest';
// The check under test.
import { signInCheck, type SignInClientFactory } from '../src/assist/sign-in-check.ts';

/** A fake supabase client that signs in as `userId` and records every signOut argument. */
function fakeFactory(userId: string | null) {
  // Every argument signOut was called with, in order.
  const signOutArgs: unknown[] = [];
  // The factory the check calls; it never touches the network.
  const factory: SignInClientFactory = () => ({
    auth: {
      // A session for `userId`, or an auth error when null.
      signInWithPassword: vi.fn(async () => (userId === null
        ? { data: { session: null }, error: { message: 'Invalid login credentials' } }
        : { data: { session: { user: { id: userId } } }, error: null })),
      // Records the scope it was asked for.
      signOut: vi.fn(async (options?: unknown) => { signOutArgs.push(options); return { error: null }; }),
    },
  });
  // Both, so a test can inspect what signOut got.
  return { factory, signOutArgs };
}

// The four env values a sign-in needs.
const ENV = { SUPABASE_URL: 'https://x.supabase.co', SUPABASE_ANON_KEY: 'anon', APPLYY_APP_USER_EMAIL: 'e@x', APPLYY_APP_USER_PASSWORD: 'p' };

describe('signInCheck', () => {
  it('signs out with scope LOCAL only: never revokes the user\'s other sessions (browser logout, 11:04 IST)', async () => {
    // A successful sign-in as the row owner.
    const { factory, signOutArgs } = fakeFactory('owner-1');
    const lines = await signInCheck(ENV, 'owner-1', factory);
    // Exactly one sign-out, and it is local.
    expect(signOutArgs).toEqual([{ scope: 'local' }]);
    // And the check itself passed.
    expect(lines.map((l) => l.verdict)).toEqual(['PASS', 'PASS']);
  });

  it('a signed-in user who is not the row owner FAILs, and still signs out locally', async () => {
    // Two accounts share a prefix: the wrong one must be caught.
    const { factory, signOutArgs } = fakeFactory('someone-else');
    const lines = await signInCheck(ENV, 'owner-1', factory);
    // The owner line fails.
    expect(lines.find((l) => l.name === 'signed-in = owner')?.verdict).toBe('FAIL');
    // Still only its own session ended.
    expect(signOutArgs).toEqual([{ scope: 'local' }]);
  });

  it('a wrong password FAILs and calls no sign-out at all (there is no session to end)', async () => {
    // The auth error path.
    const { factory, signOutArgs } = fakeFactory(null);
    const lines = await signInCheck(ENV, 'owner-1', factory);
    // Failed, with the provider's message.
    expect(lines).toEqual([{ name: 'sign-in', verdict: 'FAIL', why: 'Invalid login credentials' }]);
    // Nothing to sign out.
    expect(signOutArgs).toEqual([]);
  });

  it('an unset password WAITs and never builds a client', async () => {
    // A factory that must not be called.
    const factory = vi.fn() as unknown as SignInClientFactory;
    const lines = await signInCheck({ ...ENV, APPLYY_APP_USER_PASSWORD: undefined }, 'owner-1', factory);
    // Teja's to fill.
    expect(lines.map((l) => l.verdict)).toEqual(['WAIT']);
    // No client, so no sign-in and no sign-out.
    expect(factory).not.toHaveBeenCalled();
  });
});
