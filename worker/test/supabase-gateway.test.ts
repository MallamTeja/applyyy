// The adapter between the loop's domain port and Supabase's actual API.
//
// This is where the shape mismatches live, and they are the kind that typecheck
// clean and fail at runtime: an RPC declared `returns table (...)` arrives over
// PostgREST as an ARRAY, not an object, so `data.released_count` is silently
// `undefined` rather than an error. Every test here pins a wire shape that the
// TypeScript types do not currently describe.
import { describe, expect, it } from 'vitest';
import { createSupabaseGateway, type SupabaseLike } from '../src/supabase-gateway.ts';

/** Builds a fake client that records the calls the gateway makes. */
function fakeClient(overrides: Partial<SupabaseLike> = {}) {
  const rpcCalls: Array<{ fn: string; args: unknown }> = [];
  // Every bare UPDATE the gateway issues, recorded with the TABLE, the exact
  // PAYLOAD OBJECT and the filter. The payload is kept by reference and
  // inspected key-by-key rather than compared with toMatchObject, because the
  // property under test for setArtifactPaths is which keys are ABSENT — and a
  // partial match cannot see an absence.
  const updateCalls: Array<{
    table: string;
    payload: Record<string, unknown>;
    eq: Array<[string, unknown]>;
  }> = [];
  // Error injected into the UPDATE leg only, so the unwrap test can fail a bare
  // update without also failing every RPC the same fake serves.
  let updateError: { message: string } | null = null;
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
    // Takes the table name now, because "which table did the write land on" is
    // an assertion these tests make: a storage path belongs on `applications`
    // and nowhere else.
    from: (table: string) => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({ data: { system_enabled: true }, error: null }),
        }),
        limit: async () => ({ data: [], error: null }),
      }),
      insert: () => ({
        select: () => ({ single: async () => ({ data: { id: 'run-1' }, error: null }) }),
      }),
      update: (payload: Record<string, unknown>) => ({
        eq: async (column: string, value: unknown) => {
          updateCalls.push({ table, payload, eq: [[column, value]] });
          // Mirrors supabase-js: a database error arrives as a VALUE, not a
          // throw, which is the whole reason `unwrap` exists.
          return { data: null, error: updateError };
        },
      }),
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
  // `failUpdates` is a setter rather than a constructor argument so the SAME
  // fake can serve a healthy call and then a failing one, which is what lets
  // the unwrap test differ from the happy-path test in exactly one dimension.
  return { client, rpcCalls, updateCalls, failUpdates: (message: string) => { updateError = { message }; } };
}

/** Every field present. Tests below vary ONE field from this at a time. */
const allPaths = {
  resumePath: 'u1/app-1/1.pdf',
  screenshotPath: 'u1/app-1/1.png',
  resumeSha256: 'a'.repeat(64),
} as const;

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

/**
 * setArtifactPaths — the evidence write.
 *
 * THE DEFECT THIS BLOCK EXISTS TO PREVENT: `uploadScreenshot` and
 * `uploadResume` both upload real bytes and return a path, and until this
 * method existed NOTHING persisted either path except the
 * `applying -> applied` transition detail — which DRY_RUN, being absolute,
 * guarantees is never reached. Real artifacts in storage, two permanently empty
 * columns, and a green suite throughout, because every test asserted on the
 * upload rather than on the record.
 */
describe('createSupabaseGateway — setArtifactPaths', () => {
  it('writes both paths to `applications` with a bare UPDATE, never a status RPC', async () => {
    // THE CENTRAL ASSERTION. Routing this through advance_application_status
    // would make recording where a file went require a legal status edge, and
    // the only edge out of `approved` is `approved -> applying` — so a dry run,
    // which must move nothing, could never record anything. That coupling IS
    // the bug. The database agrees: guard_status_transition() returns early on
    // `new.status is not distinct from old.status`.
    const { client, updateCalls, rpcCalls } = fakeClient();
    const gateway = createSupabaseGateway(client, { userId: 'u1' });

    await gateway.setArtifactPaths('app-1', allPaths);

    // Exactly one write, on the applications row, filtered by its id.
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0]?.table).toBe('applications');
    expect(updateCalls[0]?.eq).toEqual([['id', 'app-1']]);
    expect(updateCalls[0]?.payload).toEqual({
      resume_storage_path: 'u1/app-1/1.pdf',
      screenshot_storage_path: 'u1/app-1/1.png',
      resume_sha256: 'a'.repeat(64),
    });
    // THE SHAPE, asserted separately from the value. The live column carries
    // `applications_resume_sha256_is_hex` (`^[0-9a-f]{64}$` or null), and this
    // fake client accepts anything — so a placeholder like 'abc123' would pass
    // a value assertion here and fail against the real database with 23514.
    // Pinning the shape is what stops this suite from certifying a digest the
    // database will reject.
    expect(updateCalls[0]?.payload.resume_sha256).toMatch(/^[0-9a-f]{64}$/);
    // And NO transition was requested. Asserted explicitly rather than implied
    // by the update above, because an implementation that did both would
    // satisfy every other assertion here while reintroducing the coupling.
    expect(rpcCalls.filter((call) => call.fn === 'advance_application_status')).toHaveLength(0);
  });

  it('omits a null resumePath rather than overwriting a recorded one with null', async () => {
    // THE DESTRUCTIVE TRAP, and the reason the guard is a skip and not a write.
    // `resumePath` is legitimately null whenever the form asked for no document
    // — planResumeAttachment returns a null target — so a re-run of an
    // application that DID attach a resume would blank out the only pointer to
    // the artifact an employer actually received. Null means "this run learned
    // nothing about that artifact", never "there is none".
    //
    // Asserting on KEY ABSENCE, not on value: `{resume_storage_path: null}` and
    // `{}` are different UPDATE statements and only the second is safe, yet a
    // toMatchObject on the screenshot key would pass for both.
    const { client, updateCalls } = fakeClient();
    const gateway = createSupabaseGateway(client, { userId: 'u1' });

    await gateway.setArtifactPaths('app-1', { ...allPaths, resumePath: null });

    expect('resume_storage_path' in (updateCalls[0]?.payload ?? {})).toBe(false);
    // The other two keys survive. Pairs the absence with a presence, so
    // "omits the resume path" cannot be satisfied by omitting everything.
    expect(Object.keys(updateCalls[0]?.payload ?? {}).sort()).toEqual([
      'resume_sha256',
      'screenshot_storage_path',
    ]);
  });

  it('DOES write the resumePath when there is one', async () => {
    // NON-VACUITY TWIN for the test above, differing in exactly one dimension:
    // the same call with a real path instead of null. Without it, a guard that
    // dropped `resume_storage_path` unconditionally — or dropped every key —
    // would satisfy the rejection test perfectly.
    const { client, updateCalls } = fakeClient();
    const gateway = createSupabaseGateway(client, { userId: 'u1' });

    await gateway.setArtifactPaths('app-1', { ...allPaths, resumePath: 'u1/app-1/9.pdf' });

    expect(updateCalls[0]?.payload.resume_storage_path).toBe('u1/app-1/9.pdf');
  });

  it('omits a null screenshotPath too', async () => {
    // The same rule on the other field, tested separately because the
    // implementation checks the two independently — a single shared check could
    // pass one field and fail the other, and one test could not tell which.
    const { client, updateCalls } = fakeClient();
    const gateway = createSupabaseGateway(client, { userId: 'u1' });

    await gateway.setArtifactPaths('app-1', { ...allPaths, screenshotPath: null });

    expect('screenshot_storage_path' in (updateCalls[0]?.payload ?? {})).toBe(false);
    expect(Object.keys(updateCalls[0]?.payload ?? {}).sort()).toEqual([
      'resume_sha256',
      'resume_storage_path',
    ]);
  });

  it('issues NO update at all when every path is null', async () => {
    // An all-null input produces the payload `{}`, and PostgREST answers an
    // empty update with a 400 rather than a no-op. So the skip-nulls rule needs
    // a floor: a call with nothing to say must make no round trip, not a
    // failing one.
    const { client, updateCalls } = fakeClient();
    const gateway = createSupabaseGateway(client, { userId: 'u1' });

    await gateway.setArtifactPaths('app-1', {
      resumePath: null,
      screenshotPath: null,
      resumeSha256: null,
    });

    expect(updateCalls).toHaveLength(0);
  });

  it('issues exactly one update when a single path is present', async () => {
    // NON-VACUITY TWIN for the empty-payload guard, one field away from the
    // test above. Without it, an early return that fired on every call would
    // pass "no update when all null" while silently persisting nothing, ever —
    // which is indistinguishable from the original defect.
    const { client, updateCalls } = fakeClient();
    const gateway = createSupabaseGateway(client, { userId: 'u1' });

    await gateway.setArtifactPaths('app-1', {
      resumePath: null,
      screenshotPath: 'u1/app-1/1.png',
      resumeSha256: null,
    });

    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0]?.payload).toEqual({ screenshot_storage_path: 'u1/app-1/1.png' });
  });

  it('omits a null resumeSha256 rather than erasing a recorded digest', async () => {
    // The same destructive trap as the paths, and the digest is the field it
    // costs most to lose: the path only proves something was uploaded, while
    // the digest is the one thing that can ever answer "is the file in that
    // bucket the file that was approved?" — the question actually asked months
    // later when a recruiter quotes a line back. A resume-less application
    // legitimately has no digest, so null must mean "omit", never "clear".
    const { client, updateCalls } = fakeClient();
    const gateway = createSupabaseGateway(client, { userId: 'u1' });

    await gateway.setArtifactPaths('app-1', { ...allPaths, resumeSha256: null });

    expect('resume_sha256' in (updateCalls[0]?.payload ?? {})).toBe(false);
    // NON-VACUITY HALF: the other two keys still went. Without this, a guard
    // that dropped the whole payload would satisfy the line above.
    expect(Object.keys(updateCalls[0]?.payload ?? {}).sort()).toEqual([
      'resume_storage_path',
      'screenshot_storage_path',
    ]);
  });

  it('writes the digest under its own column, NOT only inside a status detail', async () => {
    // NON-VACUITY TWIN for the test above, and a guard against a specific
    // deletion. `apply-one.ts` also puts a `resume_sha256` key into the
    // advance_application_status p_detail, and jsonb accepts any key — so a
    // reader can easily conclude this column write is redundant and remove it.
    // It is not: the p_detail key is an event payload attached to one status
    // transition, reachable only through `application_events` and NEVER written
    // in dry run, which is the only mode this system runs in. This test fails
    // the moment the column write is dropped in favour of the jsonb one.
    const { client, updateCalls, rpcCalls } = fakeClient();
    const gateway = createSupabaseGateway(client, { userId: 'u1' });

    await gateway.setArtifactPaths('app-1', allPaths);

    expect(updateCalls[0]?.payload.resume_sha256).toBe('a'.repeat(64));
    // On the `applications` row itself, not on an event, and with no
    // transition involved.
    expect(updateCalls[0]?.table).toBe('applications');
    expect(rpcCalls).toHaveLength(0);
  });

  it('throws when the UPDATE returns an error instead of reporting success', async () => {
    // supabase-js does NOT throw on a database error; it returns
    // `{data: null, error}`. An unwrapped bare update would let a REFUSED
    // evidence write look like a recorded one — the dry run would report a
    // screenshot path the row never received, which is worse than the empty
    // column it replaced, because it reads as verified.
    const { client, failUpdates } = fakeClient();
    failUpdates('permission denied for table applications');
    const gateway = createSupabaseGateway(client, { userId: 'u1' });

    await expect(gateway.setArtifactPaths('app-1', allPaths)).rejects.toThrow(
      /setArtifactPaths failed: permission denied/,
    );
  });
});

// The claim's apply URL. `claim_applications` returns `setof applications`, and
// `apply_url` lives on `jobs` — so reading it off the claimed row always gave ''
// and every application died on `page.goto('')`. The existing loop tests could
// not see this because their fake gateway hands over a URL directly; only a fake
// at the CLIENT seam reproduces the missing join.
describe('createSupabaseGateway.claimApplications', () => {
  /** A client whose claim returns `rows` and whose jobs table returns `jobs`. */
  function claimClient(
    rows: Array<Record<string, unknown>>,
    jobs: { data: unknown; error: { message: string } | null },
  ) {
    // Reuse the shared fake for every other call, so only the two legs under test differ.
    const base = fakeClient();
    // Recorded so a test can assert which job ids the follow-up read asked for.
    const jobQueries: Array<{ columns: string; column: string; ids: unknown }> = [];
    const client: SupabaseLike = {
      ...base.client,
      // The claim returns application rows ONLY — no apply_url, exactly as the
      // real RPC does. Every other RPC falls through to the shared fake.
      rpc: async (fn, args) => {
        base.rpcCalls.push({ fn, args });
        if (fn === 'claim_applications') return { data: rows, error: null };
        return { data: null, error: null };
      },
      // `jobs` is answered here; any other table goes to the shared fake.
      from: (table: string) =>
        table === 'jobs'
          ? {
              select: (columns: string) => ({
                in: async (column: string, ids: unknown) => {
                  jobQueries.push({ columns, column, ids });
                  return jobs;
                },
              }),
            }
          : base.client.from(table),
    };
    return { client, rpcCalls: base.rpcCalls, jobQueries };
  }

  it('takes applyUrl from jobs.apply_url, because the claimed row has none', async () => {
    // The claimed row carries `job_id` and no `apply_url` — the real wire shape.
    const { client, jobQueries } = claimClient(
      [{ id: 'app-1', job_id: 'job-1', tailored_profile: null }],
      { data: [{ id: 'job-1', apply_url: 'https://boards.example/apply/1' }], error: null },
    );
    const gateway = createSupabaseGateway(client, { userId: 'u1' });

    const claimed = await gateway.claimApplications('applier:run-1', 5);

    // The URL must come from the join; '' here is the bug.
    expect(claimed).toEqual([
      { id: 'app-1', status: 'approved', applyUrl: 'https://boards.example/apply/1', tailoredProfile: null },
    ]);
    // Asked for by id, for exactly the claimed rows' jobs.
    expect(jobQueries).toEqual([{ columns: 'id, apply_url', column: 'id', ids: ['job-1'] }]);
  });

  it('releases, and never returns, a row whose job has no apply_url', async () => {
    // A row with nowhere to go must not reach `page.goto`. Released with a reason
    // so the row stays `approved` and a human can see why it was not attempted.
    const { client, rpcCalls } = claimClient(
      [
        { id: 'app-1', job_id: 'job-1', tailored_profile: null },
        { id: 'app-2', job_id: 'job-2', tailored_profile: null },
      ],
      { data: [{ id: 'job-1', apply_url: '' }, { id: 'job-2', apply_url: 'https://boards.example/2' }], error: null },
    );
    const gateway = createSupabaseGateway(client, { userId: 'u1' });

    const claimed = await gateway.claimApplications('applier:run-1', 5);

    // Only the row with a real URL survives.
    expect(claimed.map((row) => row.id)).toEqual(['app-2']);
    // The empty-URL row got its lease back, with the reason naming the column.
    const release = rpcCalls.find((call) => call.fn === 'release_application_claim');
    expect(release?.args).toMatchObject({ p_application_id: 'app-1', p_agent: 'applier' });
    expect((release?.args as { p_reason: string }).p_reason).toMatch(/apply_url/);
  });

  it('throws when the jobs read fails, rather than treating every URL as missing', async () => {
    // A failed read is not "no URL": releasing every row on a transient error
    // would hide the outage behind a run that looks like an empty queue.
    const { client } = claimClient(
      [{ id: 'app-1', job_id: 'job-1', tailored_profile: null }],
      { data: null, error: { message: 'permission denied for table jobs' } },
    );
    const gateway = createSupabaseGateway(client, { userId: 'u1' });

    await expect(gateway.claimApplications('applier:run-1', 5)).rejects.toThrow(/permission denied for table jobs/);
  });
});

// fetchLatestProfile: the planner's only source of profile facts. The fake records the query
// shape because "highest version, one row" is the contract, not just "returns something".
describe('createSupabaseGateway.fetchLatestProfile', () => {
  /** A client whose master_profiles query yields `result` and logs the table/order/limit used. */
  function profileClient(result: { data: unknown; error: { message: string } | null }) {
    // Records what the gateway asked for, so the test can assert the ordering contract.
    const seen: { table?: string; order?: [string, unknown]; limit?: number } = {};
    // Reuses the shared fake and overrides only `from`, the one seam this query touches.
    const { client } = fakeClient({
      // The table name is captured because reading the wrong table is a plausible regression.
      from: (table: string) => ({
        // Selected columns are not asserted: the contract is table, order and limit.
        select: () => ({
          order: (column: string, opts: unknown) => ({
            limit: async (n: number) => {
              // Captured at the last link of the chain so every step of the query is recorded.
              seen.table = table;
              seen.order = [column, opts];
              seen.limit = n;
              // The canned result drives the happy, empty and error cases from one fake.
              return result;
            },
          }),
        }),
      }),
    });
    // Both returned so each test can call the gateway and inspect the query.
    return { client, seen };
  }

  it('reads master_profiles ordered by version descending, limit 1, and returns .profile', async () => {
    // One row in the shape the table returns: the profile sits inside a `profile` column.
    const { client, seen } = profileClient({ data: [{ profile: { identity: { email: 'a@b.c' } } }], error: null });
    // Non-null assertion because the method is optional on the port but always present on the real gateway.
    const profile = await createSupabaseGateway(client, { userId: 'u1' }).fetchLatestProfile!();
    // The identity object proves .profile (not the whole row) came back.
    expect(profile).toEqual({ identity: { email: 'a@b.c' } });
    // Highest version wins; a changed order would silently serve a stale profile.
    // Table, descending version order and limit 1 together are the highest-version-wins contract.
    expect(seen).toEqual({ table: 'master_profiles', order: ['version', { ascending: false }], limit: 1 });
  });

  it('returns null when there are no rows', async () => {
    // A fresh account has no master profile yet; that must read as "none", not as an error.
    const { client } = profileClient({ data: [], error: null });
    expect(await createSupabaseGateway(client, { userId: 'u1' }).fetchLatestProfile!()).toBeNull();
  });

  it('throws on a database error rather than reporting "no profile"', async () => {
    // supabase-js returns errors as values, so unwrap must convert this into a throw.
    const { client } = profileClient({ data: null, error: { message: 'boom' } });
    // A swallowed error would quietly drop every profile fill and look like an empty profile.
    await expect(createSupabaseGateway(client, { userId: 'u1' }).fetchLatestProfile!()).rejects.toThrow(/boom/);
  });
});
