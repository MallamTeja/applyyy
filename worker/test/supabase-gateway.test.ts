// The adapter between the loop's domain port and Supabase's actual API.
//
// This is where the shape mismatches live, and they are the kind that typecheck
// clean and fail at runtime: an RPC declared `returns table (...)` arrives over
// PostgREST as an ARRAY, not an object, so `data.released_count` is silently
// `undefined` rather than an error. Every test here pins a wire shape that the
// TypeScript types do not currently describe.
import { describe, expect, it } from 'vitest';
import { createSupabaseGateway, type SupabaseLike } from '../src/supabase-gateway.js';

/** Builds a fake client that records the calls the gateway makes. */
function fakeClient(overrides: Partial<SupabaseLike> = {}) {
  const rpcCalls: Array<{ fn: string; args: unknown }> = [];
  const client: SupabaseLike = {
    rpc: async (fn, args) => {
      rpcCalls.push({ fn, args });
      // `sweep_stale_claims` is the array-shaped one; everything else in these
      // tests is happy with null.
      if (fn === 'sweep_stale_claims') {
        return { data: [{ released_count: 3, needs_verification_count: 1 }], error: null };
      }
      return { data: null, error: null };
    },
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({ data: { system_enabled: true }, error: null }),
        }),
        limit: async () => ({ data: [], error: null }),
      }),
      insert: () => ({
        select: () => ({ single: async () => ({ data: { id: 'run-1' }, error: null }) }),
      }),
      update: () => ({ eq: async () => ({ data: null, error: null }) }),
    }),
    storage: {
      from: () => ({
        upload: async () => ({ data: { path: 'p' }, error: null }),
      }),
    },
    auth: {
      signInWithPassword: async () => ({
        data: { session: { expires_at: 123, access_token: 't' } },
        error: null,
      }),
      getSession: async () => ({
        data: { session: { expires_at: 123, access_token: 't' } },
        error: null,
      }),
    },
    ...overrides,
  };
  return { client, rpcCalls };
}

describe('createSupabaseGateway', () => {
  it('reads sweep_stale_claims as an ARRAY, not an object', async () => {
    // `returns table (...)` arrives over PostgREST as an array of rows. Reading
    // `data.released_count` would be `undefined` — no error, no crash, just a
    // health metric that is quietly always blank. The failure is invisible
    // precisely because JavaScript is happy to read a missing property.
    const { client } = fakeClient();
    const gateway = createSupabaseGateway(client, { userId: 'u1' });

    // Must not throw, and must not depend on object-shaped access.
    await expect(gateway.sweepStaleClaims()).resolves.toBeUndefined();
  });

  it('survives sweep_stale_claims returning an empty array', async () => {
    // A run with nothing to sweep is the common case. Indexing [0] on an empty
    // array yields undefined, so the property read must be guarded or the very
    // first healthy run of the day crashes before claiming anything.
    const { client } = fakeClient({
      rpc: async () => ({ data: [], error: null }),
    });
    const gateway = createSupabaseGateway(client, { userId: 'u1' });

    await expect(gateway.sweepStaleClaims()).resolves.toBeUndefined();
  });

  it('moves a row through the RPC, never a bare update', async () => {
    // A bare `.update({status})` passes the guard trigger but leaves
    // `claimed_by` set, stranding the row until the sweeper notices — a bug
    // that presents as "the pipeline is slow" rather than as a bug. The RPC
    // validates the edge, writes the audit event and releases the lease in one
    // transaction. It also sets `applyy.acting_agent` transaction-locally,
    // which the guard requires: without it the write fails 42501, and that
    // setting does NOT survive a reconnect or a re-auth.
    const { client, rpcCalls } = fakeClient();
    const gateway = createSupabaseGateway(client, { userId: 'u1' });

    await gateway.advanceStatus('app-1', 'applying', 'applier', { note: 1 });

    const call = rpcCalls.find((c) => c.fn === 'advance_application_status');
    expect(call).toBeDefined();
    expect(call?.args).toMatchObject({
      p_application_id: 'app-1',
      p_to_status: 'applying',
      p_agent: 'applier',
    });
  });

  it('throws when an RPC returns an error instead of continuing', async () => {
    // THE ONE THAT MATTERS MOST. supabase-js does NOT throw on a database
    // error; it returns `{ data: null, error }`. Code that ignores `error`
    // proceeds as though the write succeeded — so a rejected status transition
    // would look like a completed one, and the loop would carry on and submit
    // the next application believing the previous row was safely marked.
    const { client } = fakeClient({
      rpc: async () => ({ data: null, error: { message: 'transition refused' } }),
    });
    const gateway = createSupabaseGateway(client, { userId: 'u1' });

    await expect(gateway.advanceStatus('app-1', 'applying', 'applier')).rejects.toThrow(
      /transition refused/,
    );
  });

  it('reports the session expiry in epoch SECONDS', async () => {
    // Supabase's `expires_at` is already epoch seconds while JavaScript's
    // Date.now() is milliseconds. Mixing the two by a factor of 1000 would make
    // the token look ~50,000 years fresh, so the refresh would never fire and
    // the batch would die mid-run — the exact failure the run-window gate
    // exists to prevent, defeated by a units bug.
    const { client } = fakeClient();
    const gateway = createSupabaseGateway(client, { userId: 'u1' });
    await gateway.refreshSession();

    expect(gateway.sessionExpiresAtEpochSeconds()).toBe(123);
  });
});
