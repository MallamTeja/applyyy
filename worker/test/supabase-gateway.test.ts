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
      // company_name padded on purpose: the gateway must trim it before the planner compares names.
      { data: [{ id: 'job-1', apply_url: 'https://boards.example/apply/1', disappeared_at: null, company_name: ' GitLab ' }], error: null },
    );
    const gateway = createSupabaseGateway(client, { userId: 'u1' });

    const claimed = await gateway.claimApplications('applier:run-1', 5);

    // The URL must come from the join; '' here is the bug.
    expect(claimed).toEqual([
      // employerName is the trimmed jobs.company_name, the planner's "previously worked at" input.
      { id: 'app-1', status: 'approved', applyUrl: 'https://boards.example/apply/1', tailoredProfile: null, employerName: 'GitLab', atsProvider: null },
    ]);
    // Asked for by id, for exactly the claimed rows' jobs.
    // company_name rides the same read, so the employer costs no extra round trip.
    expect(jobQueries).toEqual([{ columns: 'id, apply_url, disappeared_at, company_name, ats_provider', column: 'id', ids: ['job-1'] }]);
  });

  // THE PROVIDER HALF OF THE WORKDAY GUARD (2026-11-01): apply-one parks a row whose job is
  // a Workday board even when its apply URL is on the company's own careers domain. That
  // only works if the gateway actually carries jobs.ats_provider onto the claimed row.
  it('carries jobs.ats_provider onto the claimed row, so the applier can refuse Workday', async () => {
    // A Workday job fronted on a careers domain: the provider is the only Workday signal.
    const { client } = claimClient(
      // The claimed row, real wire shape.
      [{ id: 'app-1', job_id: 'job-1', tailored_profile: null }],
      // The job row, read with its provider.
      { data: [{ id: 'job-1', apply_url: 'https://careers.acme.example/job/R-1', disappeared_at: null, company_name: 'Acme', ats_provider: 'workday' }], error: null },
    );
    // The gateway under test.
    const gateway = createSupabaseGateway(client, { userId: 'u1' });
    // One claim.
    const claimed = await gateway.claimApplications('applier:run-1', 5);
    // The provider arrives verbatim; the guard keys on exactly this value.
    // Narrowed first: an unusable entry has no provider, and this row must not be one.
    expect(claimed.map((row) => ('atsProvider' in row ? row.atsProvider : 'unusable'))).toEqual(['workday']);
  });

  it('W4: returns a no-apply_url row as UNUSABLE and keeps its lease, so the loop can hold or park it', async () => {
    // A row with nowhere to go must not reach `page.goto`. It used to be released here,
    // which made it the oldest claimable row again: five of them starved the queue (W4).
    // Now it comes back named, lease kept, and the claim loop decides hold vs park.
    const { client, rpcCalls } = claimClient(
      [
        { id: 'app-1', job_id: 'job-1', tailored_profile: null },
        { id: 'app-2', job_id: 'job-2', tailored_profile: null },
      ],
      { data: [{ id: 'job-1', apply_url: '', disappeared_at: null }, { id: 'job-2', apply_url: 'https://boards.example/2', disappeared_at: null }], error: null },
    );
    const gateway = createSupabaseGateway(client, { userId: 'u1' });

    const claimed = await gateway.claimApplications('applier:run-1', 5);

    // Both rows come back, in claim order; only the second carries a URL.
    expect(claimed.map((row) => row.id)).toEqual(['app-1', 'app-2']);
    // The empty-URL row is named unusable, with a reason naming the column and the job.
    expect(claimed[0]).toMatchObject({ id: 'app-1', unusable: 'no_apply_url', reason: expect.stringMatching(/apply_url.*job-1/) });
    // And it carries NO applyUrl, so it cannot be handed to the browser by mistake.
    expect(claimed[0]).not.toHaveProperty('applyUrl');
    // Lease kept: releasing here is exactly what put it back at the head of the queue.
    expect(rpcCalls.filter((call) => call.fn === 'release_application_claim')).toEqual([]);
  });

  it('W4: returns a disappeared posting as UNUSABLE and keeps its lease, keeps the live one usable', async () => {
    // Two rows, two jobs: one live (null), one dead (an ISO timestamp from scout-ats).
    // Arrange: one live and one dead job, so the test proves the filter splits them rather than blocking all.
    const { client, rpcCalls } = claimClient(
      [
        // Points at the live job: must survive the filter.
        { id: 'app-live', job_id: 'job-live', tailored_profile: null },
        // Points at the dead job: must be released.
        { id: 'app-dead', job_id: 'job-dead', tailored_profile: null },
      ],
      {
        // The jobs table answer, one row per job above.
        data: [
          // Explicit null is the 'alive' answer from scout-ats.
          { id: 'job-live', apply_url: 'https://boards.example/live', disappeared_at: null },
          // An ISO timestamp is how scout-ats records a posting that left its board.
          { id: 'job-dead', apply_url: 'https://boards.example/dead', disappeared_at: '2026-10-01T00:00:00Z' },
        ],
        // No read error, so the filter logic alone is under test.
        error: null,
      },
    );
    // The gateway under test, wired to the fake client seam.
    const gateway = createSupabaseGateway(client, { userId: 'u1' });

    // Act: claim, which does the jobs read and the release.
    const claimed = await gateway.claimApplications('applier:run-1', 5);

    // Only the live posting carries a URL for the browser.
    expect(claimed.filter((row) => 'applyUrl' in row).map((row) => row.id)).toEqual(['app-live']);
    // The dead one is named unusable; the reason keeps the token health queries count.
    expect(claimed.find((row) => row.id === 'app-dead')).toMatchObject({
      // Machine-readable cause, for the park detail.
      unusable: 'posting_disappeared',
      // The token and the timestamp, so 'why not attempted' is answerable later.
      reason: expect.stringMatching(/posting_disappeared.*2026-10-01/),
    });
    // Lease kept: the claim loop holds it (dry) or parks it (live).
    expect(rpcCalls.filter((call) => call.fn === 'release_application_claim')).toEqual([]);
  });

  it('fails closed when the job has no disappeared_at key at all', async () => {
    // An older schema or a dropped select column: liveness is unknowable, not "alive".
    // Arrange: a job with a good URL but NO disappeared_at key, the only variable under test.
    const { client, rpcCalls } = claimClient(
      // One claimed row pointing at the job below.
      [{ id: 'app-1', job_id: 'job-1', tailored_profile: null }],
      // No disappeared_at key at all: absence, not null.
      { data: [{ id: 'job-1', apply_url: 'https://boards.example/1' }], error: null },
    );
    // The gateway under test, wired to the fake client seam.
    const gateway = createSupabaseGateway(client, { userId: 'u1' });

    // Act: claim against the schema that lacks the column.
    const claimed = await gateway.claimApplications('applier:run-1', 5);

    // Never handed over.
    // Guards: nothing usable comes back.
    expect(claimed).toEqual([]);
    // Released with a reason naming the missing column.
    // Guards: absence is released, not treated as alive.
    const release = rpcCalls.find((call) => call.fn === 'release_application_claim');
    // Guards: the reason names the missing column so an operator can fix the schema.
    expect((release?.args as { p_reason: string }).p_reason).toMatch(/disappeared_at missing/);
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

// W10 (docs/audit/2026-11-01-wiring-audit.md): the Settings "Daily Application Cap" was
// written by the web app and read by nothing. The gateway now reads it and counts what
// entered `applying` in the window. Every failure must THROW: the loop treats a throw as
// "submit nothing", and any quiet default here would be "no cap".
describe('createSupabaseGateway.fetchDailyCap (W10)', () => {
  /** One application_events row, as the behavioural count below filters it. */
  type EventRow = Record<string, unknown>;
  /** A count answer: either canned, or computed from rows by the gateway's own filters. */
  type CountAnswer = { count: unknown; error: { message: string } | null } | { rows: readonly EventRow[] };

  /** A client answering the three reads, recording every filter the gateway applies. */
  function capClient(
    settings: { data: unknown; error: { message: string } | null },
    events: CountAnswer,
    // Rows sitting at `applying` right now. Defaults to none, so a test about the event
    // count is not disturbed by the in-flight read.
    inFlight: { count: unknown; error: { message: string } | null } = { count: 0, error: null },
  ) {
    // Every table read, with its columns, options and filters, in call order.
    const reads: Array<{ table: string; columns: string; options: unknown; filters: Array<[string, string, unknown]> }> = [];
    // The shared fake for everything else.
    const base = fakeClient();
    // Only `from` differs.
    const client: SupabaseLike = {
      // Inherits rpc, storage and auth.
      ...base.client,
      // A chain that records each filter and resolves at the terminal call.
      from: (table: string) => ({
        // The select starts a recorded read.
        select: (columns: string, options?: unknown) => {
          // One record per read.
          const read = { table, columns, options, filters: [] as Array<[string, string, unknown]> };
          // Stored before any filter, so a read with no filter still shows.
          reads.push(read);
          // The chain object; each filter returns it again.
          const chain = {
            // Equality filter.
            eq: (column: string, value: unknown) => {
              // Recorded with its operator.
              read.filters.push(['eq', column, value]);
              // Chainable.
              return chain;
            },
            // Lower bound filter: the window start.
            gte: (column: string, value: unknown) => {
              // Recorded with its operator.
              read.filters.push(['gte', column, value]);
              // Chainable.
              return chain;
            },
            // Set-membership filter: the submit edges' from/to statuses.
            in: (column: string, values: unknown) => {
              // Recorded with its operator.
              read.filters.push(['in', column, values]);
              // Chainable.
              return chain;
            },
            // The settings read ends here.
            maybeSingle: async () => settings,
            // The count reads are awaited directly, as supabase-js query builders are thenables.
            then: (resolve: (value: unknown) => void) => {
              // The in-flight read is the one on `applications`; its answer is canned.
              if (table === 'applications') return resolve({ data: null, ...inFlight });
              // A canned event answer is returned as given (errors and soft failures).
              if (!('rows' in events)) return resolve({ data: null, ...events });
              // Otherwise count the rows that pass EVERY recorded filter, the way Postgres
              // would: so the test checks which events count, not which filter calls were made.
              const count = events.rows.filter((row) =>
                // Every filter must hold for the row to count.
                read.filters.every(([op, column, value]) =>
                  // eq: exact match; in: membership; gte: ISO timestamps compare as strings.
                  op === 'eq' ? row[column] === value
                    : op === 'in' ? (value as unknown[]).includes(row[column])
                      : op === 'gte' ? String(row[column]) >= String(value)
                        // An operator this fake does not know fails the row, never passes it.
                        : false,
                ),
              ).length;
              // Shaped like a head-only exact count.
              return resolve({ data: null, count, error: null });
            },
          };
          // Handed to the gateway.
          return chain;
        },
      }),
    };
    // Both returned.
    return { client, reads };
  }

  // The window start every test passes.
  const since = '2026-10-31T08:00:00.000Z';

  it('W10 gateway: reads max_applications_per_day for this user and counts submit attempts (in flight + recorded) since the window start', async () => {
    // Cap 5, two submit edges in the window, one row mid-submit right now.
    const { client, reads } = capClient({ data: { max_applications_per_day: 5 }, error: null }, { count: 2, error: null }, { count: 1, error: null });
    // The gateway under test.
    const gateway = createSupabaseGateway(client, { userId: 'u1' });

    // Both halves come back as read; sent is the recorded edges plus the in-flight row.
    expect(await gateway.fetchDailyCap(since)).toEqual({ maxPerDay: 5, sentSince: 3 });
    // The setting, for THIS user (two users share the table live).
    expect(reads[0]).toMatchObject({ table: 'system_settings', columns: 'max_applications_per_day', filters: [['eq', 'user_id', 'u1']] });
    // In-flight BEFORE events: a row finishing between the two reads is then counted
    // twice (safe), never zero times (the reverse order would lose it).
    expect(reads.map((read) => read.table)).toEqual(['system_settings', 'applications', 'application_events']);
    // In flight: this user's rows at `applying`, as a head-only exact count.
    expect(reads[1]).toMatchObject({ options: { count: 'exact', head: true } });
    // Order-independent: the filter set is the contract, not the call order.
    expect(reads[1]?.filters).toEqual(expect.arrayContaining([['eq', 'user_id', 'u1'], ['eq', 'status', 'applying']]));
    // The recorded half: a head-only exact count, never a row download.
    expect(reads[2]).toMatchObject({ options: { count: 'exact', head: true } });
    // Filtered to this user's submit edges, inside the window.
    expect(reads[2]?.filters).toEqual(
      // Order-independent, as above.
      expect.arrayContaining([
        ['eq', 'user_id', 'u1'],
        ['eq', 'event_type', 'status_change'],
        ['in', 'from_status', ['applying', 'blocked_needs_human']],
        ['in', 'to_status', ['applied', 'needs_verification']],
        ['gte', 'created_at', since],
      ]),
    );
  });

  /** A status_change event for user u1 inside the window, unless a field overrides it. */
  function ev(from: string | null, to: string | null, extra: EventRow = {}): EventRow {
    // Every field the gateway filters on, defaulted to "counts if the edge counts".
    return { user_id: 'u1', event_type: 'status_change', from_status: from, to_status: to, created_at: '2026-10-31T12:00:00.000Z', ...extra };
  }

  it('blocked-before-submit rows do not count against the daily cap', async () => {
    // Code-review finding #10: five rows entered `applying` earlier today and were parked
    // before any submit click. Nothing was sent, so a cap of 5 must still have 5 left.
    const rows = [1, 2, 3, 4, 5].flatMap(() => [ev('approved', 'applying'), ev('applying', 'blocked_needs_human')]);
    // Cap 5, the live default region; no row is mid-submit right now.
    const { client } = capClient({ data: { max_applications_per_day: 5 }, error: null }, { rows });
    // THE assertion: zero sent, not five.
    expect(await createSupabaseGateway(client, { userId: 'u1' }).fetchDailyCap(since)).toEqual({ maxPerDay: 5, sentSince: 0 });
  });

  it('W10 gateway: each real submit attempt counts once, and nothing else counts', async () => {
    // The events the window can hold, live shapes from application_status_transitions.
    const rows = [
      // COUNTS: the applier's submit landed.
      ev('applying', 'applied'),
      // COUNTS: the sweeper found a stranded submit; the outcome is unknown, it may have been sent.
      ev('applying', 'needs_verification', { agent: 'sweeper' }),
      // COUNTS: assisted-submit (or a hand submit) of a parked row, recorded by the human.
      ev('blocked_needs_human', 'applied', { agent: 'human' }),
      // Not a new attempt: confirms an unknown that was counted when it reached needs_verification.
      ev('needs_verification', 'applied', { agent: 'human' }),
      // Not an attempt: entering `applying` is not sending (this was the bug).
      ev('approved', 'applying'),
      // Not an attempt: parked before submit.
      ev('applying', 'blocked_needs_human'),
      // Not a status change at all.
      ev(null, null, { event_type: 'note' }),
      // Another user's submit: two users share the table live.
      ev('applying', 'applied', { user_id: 'u2' }),
      // Before the window.
      ev('applying', 'applied', { created_at: '2026-10-30T12:00:00.000Z' }),
    ];
    // Cap 5, nothing in flight.
    const { client } = capClient({ data: { max_applications_per_day: 5 }, error: null }, { rows });
    // Exactly the three attempts.
    expect(await createSupabaseGateway(client, { userId: 'u1' }).fetchDailyCap(since)).toEqual({ maxPerDay: 5, sentSince: 3 });
  });

  it('W10 gateway: no settings row reads as no daily cap (the documented null)', async () => {
    // maybeSingle's "no row" answer.
    const { client } = capClient({ data: null, error: null }, { count: 0, error: null });
    // The gateway under test.
    const gateway = createSupabaseGateway(client, { userId: 'u1' });
    // Null cap, so only the per-run cap applies.
    expect(await gateway.fetchDailyCap(since)).toEqual({ maxPerDay: null, sentSince: 0 });
  });

  it('W10 gateway: a malformed cap throws instead of reading as a number', async () => {
    // Zero, a string, a fraction and a row whose select dropped the column: none is a cap.
    for (const data of [{ max_applications_per_day: 0 }, { max_applications_per_day: '35' }, { max_applications_per_day: 1.5 }, {}]) {
      // A fresh client per shape.
      const { client } = capClient({ data, error: null }, { count: 0, error: null });
      // Each must throw, naming the setting.
      await expect(createSupabaseGateway(client, { userId: 'u1' }).fetchDailyCap(since)).rejects.toThrow(/max_applications_per_day/);
    }
  });

  it('W10 gateway: a failed settings read throws', async () => {
    // supabase-js reports the failure as a VALUE, not a throw.
    const { client } = capClient({ data: null, error: { message: 'permission denied' } }, { count: 0, error: null });
    // Must surface as a throw.
    await expect(createSupabaseGateway(client, { userId: 'u1' }).fetchDailyCap(since)).rejects.toThrow(/permission denied/);
  });

  it('W10 gateway: a failed or missing count throws instead of reading as zero sent', async () => {
    // An {error} value, and a null count with no error (a soft failure).
    for (const events of [{ count: 3, error: { message: 'timeout' } }, { count: null, error: null }]) {
      // A fresh client per case, with a valid cap so only the count is under test.
      const { client } = capClient({ data: { max_applications_per_day: 5 }, error: null }, events);
      // Each must throw: zero sent would let the cap be blown past.
      await expect(createSupabaseGateway(client, { userId: 'u1' }).fetchDailyCap(since)).rejects.toThrow(/submit attempts/);
    }
  });

  it('W10 gateway: a failed or missing in-flight count throws instead of reading as nothing in flight', async () => {
    // The same two failure shapes, on the `applying` read this time.
    for (const inFlight of [{ count: 1, error: { message: 'timeout' } }, { count: null, error: null }]) {
      // A valid cap and a valid event count, so only the in-flight read is under test.
      const { client } = capClient({ data: { max_applications_per_day: 5 }, error: null }, { count: 0, error: null }, inFlight);
      // Each must throw, naming the in-flight read.
      await expect(createSupabaseGateway(client, { userId: 'u1' }).fetchDailyCap(since)).rejects.toThrow(/in flight/);
    }
  });
});
