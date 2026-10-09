// The adapter: the loop's domain port, implemented over Supabase.
//
// THE CLIENT IS STRUCTURALLY TYPED HERE RATHER THAN IMPORTED. That is not
// squeamishness about a dependency — it is what keeps every module in this
// package testable with a plain object instead of a mocked SDK, and it means
// the claim loop has no idea it is talking to Supabase at all. The one file
// that constructs a real client is `supabase-client.ts`; everything else in the
// worker depends on the interface below.
//
// AUTH, DECIDED AND WORTH INTERNALISING: the worker signs in as an ORDINARY
// Supabase Auth user (`signInWithPassword`), yielding a normal `authenticated`
// JWT. No service-role key, no custom Postgres role. Two reasons, and the
// second is the one that is easy to get backwards:
//
//   1. Blast radius. A leaked service-role key means every table with RLS
//      bypassed and a rotation that redeploys every consumer. A leaked app-user
//      password means one account, revocable in the dashboard in seconds.
//   2. A "scoped Postgres role" SOUNDS like least privilege and is not. Such a
//      role is reached by signing a JWT with the PROJECT'S JWT SECRET, and
//      anyone holding that secret can mint a token claiming `role:
//      service_role`. It would read as least privilege in the migration while
//      being a god-mode key in the runner — the worst kind of control, one that
//      reads as safe.
//
// The property this buys, on the one component that touches real employers:
// THE WORKER CANNOT DO ANYTHING TEJA COULD NOT DO FROM THE DASHBOARD.
// MasterProfile types the return value so callers get the real shape, not any.
import type { AgentName, ApplicationStatus, MasterProfile, ResolvedResume } from '@applyy/shared-types';
import type { RunGateway } from './claim-loop.ts';
import type { ClaimedApplication } from './apply-one.ts';

/** What a Supabase-shaped client must offer. Deliberately minimal. */
export interface SupabaseLike {
  // Loosely typed on purpose: applyyy-98 is adding real return aliases for
  // `claim_applications` and `advance_application_status`, which today hand
  // back `any`. Writing a local cast to paper over that would create exactly
  // the drift the shared-types stream exists to prevent, so this stays honest
  // until those aliases land and can be imported.
  rpc(fn: string, args?: Record<string, unknown>): Promise<{ data: unknown; error: { message: string } | null }>;
  from(table: string): any;
  storage: { from(bucket: string): { upload(path: string, body: unknown, opts?: unknown): Promise<{ data: unknown; error: { message: string } | null }> } };
  auth: {
    signInWithPassword(credentials: { email: string; password: string }): Promise<{
      data: { session: { expires_at?: number; access_token: string } | null };
      error: { message: string } | null;
    }>;
    getSession(): Promise<{
      data: { session: { expires_at?: number; access_token: string } | null };
      error: { message: string } | null;
    }>;
  };
}

/** Credentials and identity the gateway needs beyond the client itself. */
export interface GatewayConfig {
  readonly userId: string;
  // Held so the session can be renewed mid-run. Batching made one run longer
  // than one token, so a single sign-in at the start is no longer sufficient.
  readonly email?: string;
  readonly password?: string;
  // Storage bucket for blocked-page and dry-run screenshots.
  readonly screenshotBucket?: string;
  // Storage bucket for the rendered resumes that were actually attached. A
  // SEPARATE bucket from screenshots rather than a folder inside it, because the
  // two have different sensitivities: a screenshot is evidence of a form, while
  // a resume is Teja's personal data and the artifact an employer received, so
  // they want their own access policy.
  readonly resumeBucket?: string;
}

/**
 * Unwrap a supabase-js result, throwing on error.
 *
 * SUPABASE-JS DOES NOT THROW ON A DATABASE ERROR — it returns
 * `{ data: null, error }`. Code that forgets to check `error` proceeds as
 * though the write succeeded, so a REJECTED STATUS TRANSITION would look like a
 * completed one and the loop would submit the next application believing the
 * previous row was safely marked. Funnelling every call through here makes that
 * mistake impossible to make once rather than possible to make at each call.
 */
function unwrap<T>(result: { data: T; error: { message: string } | null }, operation: string): T {
  if (result.error) {
    throw new Error(`${operation} failed: ${result.error.message}`);
  }
  return result.data;
}

export function createSupabaseGateway(client: SupabaseLike, config: GatewayConfig): RunGateway {
  // Cached expiry, refreshed whenever we sign in. Held here rather than read
  // from the client on every check so the hot path is synchronous.
  let expiresAtEpochSeconds = 0;
  const bucket = config.screenshotBucket ?? 'screenshots';
  const resumeBucket = config.resumeBucket ?? 'resumes';

  // A local function rather than a method reached through `this`, because the
  // claim needs it too and `this` inside an object literal breaks the moment a
  // caller destructures the gateway.
  async function releaseApplierClaim(applicationId: string, reason: string): Promise<void> {
    // Drops the lease WITHOUT touching status. That is the whole point: a
    // dry run must be incapable of moving a row, and the function has no
    // status assignment anywhere in it.
    unwrap(
      await client.rpc('release_application_claim', {
        p_application_id: applicationId,
        p_agent: 'applier',
        p_reason: reason,
      }),
      'releaseClaim',
    );
  }

  return {
    async openRun(agent: AgentName) {
      // Opened before any work, so a crash leaves a visible stuck row.
      // unwrap converts supabase-js's error-as-value into a throw, so a DB failure is not read as no profile.
      const data = unwrap(
        await client.from('agent_runs').insert({ agent }).select().single(),
        'openRun',
      );
      return { id: (data as { id: string }).id };
    },

    async closeRun(runId, update) {
      unwrap(await client.from('agent_runs').update(update).eq('id', runId), 'closeRun');
    },

    async isSystemEnabled() {
      const data = unwrap(
        await client
          .from('system_settings')
          .select('system_enabled')
          .eq('user_id', config.userId)
          .maybeSingle(),
        'isSystemEnabled',
      );
      // FAIL CLOSED. A missing settings row means the account was never
      // bootstrapped, and a missing kill switch must read as "off", never as
      // "no objection" — the same rule the claim RPC applies internally.
      return (data as { system_enabled?: boolean } | null)?.system_enabled === true;
    },

    async sweepStaleClaims() {
      const data = unwrap(await client.rpc('sweep_stale_claims'), 'sweepStaleClaims');
      // `returns table (...)` arrives over PostgREST as an ARRAY OF ROWS, so
      // `data.released_count` would be `undefined` — no error, no crash, just a
      // metric that is quietly always blank. Indexed, and guarded because an
      // empty array is the normal case on a healthy day.
      const rows = Array.isArray(data) ? data : [];
      const summary = rows[0] as { released_count?: number } | undefined;
      // Read but not yet published as a health metric. The double-count this
      // comment used to warn about was fixed in
      // 20260910190000_fix_sweep_count_bootstrap_seed_and_blocked_edge.sql;
      // 20260918213000 then replaced the function and a later migration is
      // restoring it, so the RETURN SHAPE is in flux. Publishing a field name
      // from a signature that is still moving would put a blank on the health
      // page the day it changes — wire it once the restored sweep has landed.
      void summary;
    },

    async claimApplications(claimedBy, limit) {
      const data = unwrap(
        await client.rpc('claim_applications', {
          // The status is fixed: this worker only ever takes approved rows, and
          // `approved -> applying` is the single edge it may walk.
          p_status: 'approved',
          p_claimed_by: claimedBy,
          p_limit: limit,
        }),
        'claimApplications',
      );
      // Zero rows is the kill switch or an empty queue, and neither is an error.
      const rows = (Array.isArray(data) ? data : []) as Array<{
        id: string;
        // The link to `jobs`, which is where the apply URL actually lives. An
        // `apply_url` field was once read off this row; the RPC returns
        // `applications.*` and that table has no such column, so it was always
        // '' and every claimed row died on `page.goto('')`.
        job_id: string;
        // `claim_applications` is declared `returns setof public.applications`
        // and returns `a.*`, so the pinned snapshot arrives with the claim and
        // needs no second query. That matters beyond round trips: a separate
        // read could see a DIFFERENT snapshot than the one that was claimed if
        // the row were re-approved in between, and the resume would then be
        // rendered from data this run never validated.
        tailored_profile?: ResolvedResume | null;
      }>;

      // Nothing claimed means nothing to look up; skipping the read also keeps
      // PostgREST from being sent an empty `in.()` filter.
      if (rows.length === 0) return [];

      // THE MISSING JOIN, as a second read. `jobs.apply_url` is the canonical
      // submit target decided at normalize time, which is what keeps a LinkedIn
      // sighting from ever becoming a submit path. De-duplicated because two
      // applications can share a job, and one id per job is all the read needs.
      const jobIds = [...new Set(rows.map((row) => row.job_id))];
      // Through `unwrap`, so a failed read THROWS rather than reading as "no URL"
      // — releasing every row on a transient error would disguise an outage as
      // an empty queue, and the rows keep their leases for the sweeper instead.
      // disappeared_at rides the same read so liveness costs no extra round trip; unwrapped so a
      // failed read throws instead of looking like dead rows. `disappeared_at?` is optional in the
      // cast because the key can be absent at runtime, and the loop below tests its PRESENCE.
      const jobs = unwrap(
        // company_name rides the same read: the planner needs it to answer "previously worked at
        // <company>?", and a second round trip per batch would buy nothing.
        await client.from('jobs').select('id, apply_url, disappeared_at, company_name').in('id', jobIds),
        'claimApplications: read jobs.apply_url',
      ) as Array<{ id: string; apply_url: string | null; disappeared_at?: string | null; company_name?: string | null }> | null;
      // Keyed by job id so each claimed row finds its URL in one lookup.
      const urlByJobId = new Map((jobs ?? []).map((job) => [job.id, job.apply_url]));
      // Keyed the same way, whole record kept so the loop can test key PRESENCE.
      // A Map so each claimed row finds its job in one lookup, same as the URL map above.
      const jobById = new Map((jobs ?? []).map((job) => [job.id, job]));

      // Rows that can actually be navigated to, each paired with its URL. Built
      // in a loop rather than one filter, because the rejected rows need an
      // awaited release and a filter callback cannot await.
      const usable: Array<{ row: (typeof rows)[number]; url: string }> = [];
      for (const row of rows) {
        // Trimmed so a whitespace-only URL counts as missing, not as a target.
        const url = urlByJobId.get(row.job_id)?.trim();
        // FAIL CLOSED: no URL means there is nowhere honest to go. Released, not
        // failed — a status write needs a legal edge, and this is a data gap a
        // human can fix, not a verdict on the application. The reason lands in
        // `application_events` so "why was this never attempted" has an answer.
        if (!url) {
          await releaseApplierClaim(row.id, `no apply_url on job ${row.job_id}; not attempted`);
          continue;
        }
        // Always defined here: a job missing from the map had no URL and already took the no-URL release above.
        const job = jobById.get(row.job_id);
        // FAIL CLOSED on a missing key: an older schema or a select that dropped the column must
        // not read as "alive". `in` tests PRESENCE, because null is a valid answer (alive).
        // Released, not failed, like the no-URL gap.
        if (job && !('disappeared_at' in job)) {
          // Lease returned with a reason, so the event log answers 'why not attempted'.
          await releaseApplierClaim(
            // Targets exactly this row's lease.
            row.id,
            // Names the missing column (never the word 'alive') and the job, so the log is traceable.
            `jobs.disappeared_at missing from read for job ${row.job_id}; liveness unknown, not attempted`,
          );
          // Skip to the next row; this one must not reach the usable list.
          continue;
        }
        // A non-null timestamp means the posting dropped off its board: nowhere live to go.
        // `!= null` (loose) so only a real timestamp trips it; null and undefined both mean not dead.
        if (job?.disappeared_at != null) {
          // Same release path as the no-URL gap: a status write needs a legal edge.
          await releaseApplierClaim(
            // Targets exactly this row's lease.
            row.id,
            // Distinct token so health queries can count dead postings; the timestamp shows how long it has been dead.
            `posting_disappeared: job ${row.job_id} disappeared at ${job.disappeared_at}; not attempted`,
          );
          // Not usable, so skipped like the other release cases.
          continue;
        }
        // Kept with its row so the mapping below needs no second lookup.
        usable.push({ row, url });
      }

      return usable.map(
        ({ row, url }): ClaimedApplication => ({
          id: row.id,
          status: 'approved',
          // Present and non-empty by construction: the loop above dropped
          // every row without one, so no `?? ''` fallback can reintroduce the
          // empty string that `page.goto` throws on.
          applyUrl: url,
          // Passed through UNVALIDATED and un-defaulted on purpose. Coercing a
          // missing snapshot to an empty resume here would produce a blank PDF
          // that renders, uploads and attaches without complaint; leaving the
          // null intact means the attachment planner refuses the application
          // and a human sees why. `??` rather than a bare read so `undefined`
          // (column absent from the payload) and SQL NULL mean the same thing.
          tailoredProfile: row.tailored_profile ?? null,
          // The employer's name, for the planner's "previously worked at <company>" check.
          // Null when absent, never "": the planner REFUSES that question on null, which is
          // the safe answer when we do not know who the employer is.
          employerName: jobById.get(row.job_id)?.company_name?.trim() || null,
        }),
      );
    },

    async advanceStatus(
      applicationId: string,
      to: ApplicationStatus,
      agent: AgentName,
      detail?: Record<string, unknown>,
    ) {
      // The RPC, never a bare update. It validates the edge, writes the audit
      // event and releases the lease in ONE transaction — and it sets
      // `applyy.acting_agent` transaction-locally, which the guard trigger
      // requires. That setting is per-connection state: anything that silently
      // reconnects (a pool, a retry, a re-auth) drops it, and every subsequent
      // status write would fail 42501. Going through the RPC means the setting
      // is re-established on every call rather than assumed from setup.
      unwrap(
        await client.rpc('advance_application_status', {
          p_application_id: applicationId,
          p_to_status: to,
          p_agent: agent,
          p_detail: detail ?? {},
        }),
        'advanceStatus',
      );
    },

    // Delegates to the one local implementation, which the claim also uses.
    releaseClaim: releaseApplierClaim,

    // Highest version wins (consumers order version desc limit 1); null when no profile exists yet.
    // A method on the gateway so tests can fake it and the CLI never touches the client directly.
    async fetchLatestProfile(): Promise<MasterProfile | null> {
      // limit(1) after ordering so only the newest row crosses the wire; errors throw via unwrap.
      const data = unwrap(
        // Selects only the profile column: the version is used for ordering, not returned.
        await client.from('master_profiles').select('profile').order('version', { ascending: false }).limit(1),
        // Names the operation so a thrown error says which query failed.
        'fetchLatestProfile',
      );
      // Shape guard: supabase-js types this loosely, so confirm an array before indexing.
      // No rows means "no profile", which the planner treats as nothing to copy.
      // Returning null (not throwing) lets a fresh account run with blockers instead of crashing.
      if (!Array.isArray(data) || data.length === 0) return null;
      // Only the profile column was selected; a null jsonb column still reads as "no profile".
      // The cast is the one trust boundary: the table's jsonb is declared MasterProfile by contract.
      return (data[0] as { profile: MasterProfile }).profile ?? null;
    },

    async fetchAnswers() {
      const data = unwrap(await client.from('answer_bank').select('*').limit(1000), 'fetchAnswers');
      return (Array.isArray(data) ? data : []) as never[];
    },

    async uploadScreenshot(applicationId, bytes) {
      // Path includes the application id so the dashboard can find it, and a
      // timestamp so a re-run during the dry-run period does not overwrite the
      // evidence Teja has not reviewed yet.
      const path = `${config.userId}/${applicationId}/${Date.now()}.png`;
      unwrap(
        await client.storage.from(bucket).upload(path, bytes, { contentType: 'image/png' }),
        'uploadScreenshot',
      );
      return path;
    },

    async uploadResume(applicationId, bytes) {
      // Same path shape as the screenshot — user, application, timestamp — so
      // one storage-policy rule covers both and the two artifacts of a single
      // application sit under the same prefix.
      //
      // TIMESTAMPED RATHER THAN CONTENT-ADDRESSED. Naming the object after its
      // sha256 would deduplicate identical renders, which sounds like a win and
      // is the wrong trade here: two applications sending the identical resume
      // to different employers would share one object, and deleting one row's
      // artifact would silently remove the other's evidence of what it sent.
      const path = `${config.userId}/${applicationId}/${Date.now()}.pdf`;
      unwrap(
        await client.storage
          .from(resumeBucket)
          // Declared explicitly: Supabase Storage infers from the extension but
          // an object served as octet-stream downloads instead of previewing,
          // and Teja opens these from the dashboard to check what went out.
          .upload(path, bytes, { contentType: 'application/pdf' }),
        'uploadResume',
      );
      return path;
    },

    async setArtifactPaths(applicationId, paths) {
      // A BARE UPDATE, AND THAT IS THE WHOLE POINT — read this before "fixing"
      // it to go through advance_application_status like every other write in
      // this file.
      //
      // Storage paths are not a status change. Routing them through the RPC
      // would make recording WHERE A FILE WENT require a legal status edge, and
      // the only edge out of `approved` is `approved -> applying` — so a dry
      // run, which must move nothing, could never record anything. That
      // coupling is the defect this method was written to remove, not a safety
      // property to preserve.
      //
      // AND THE TRIGGER PERMITS IT, verified in
      // supabase/migrations/20260909234900_status_transition_guard.sql rather
      // than assumed: `guard_status_transition()` opens with
      //
      //     if new.status is not distinct from old.status then return new; end if;
      //
      // and the comment above that line names "an agent writing a score or a
      // storage path" as exactly the case it exists to wave through. So no
      // `applyy.acting_agent` GUC is needed here and no 42501 is possible — the
      // guard never reaches its actor check. `log_status_change()` short-
      // circuits identically, so this write also correctly produces NO audit
      // event: nothing about the workflow happened.
      //
      // An earlier session refused to build this believing the trigger would
      // reject it. It does not. The belief was worth checking and wrong.
      const update: Record<string, string> = {};

      // SKIP NULLS, DO NOT WRITE THEM. The trap this guards is destructive and
      // silent: `resumePath` is legitimately null whenever the form asked for
      // no document (plan-resume-attachment returns a null target), so a
      // re-run of an application that DID attach a resume would overwrite the
      // recorded path with null and destroy the only pointer to the artifact an
      // employer actually received. Null here means "this run learned nothing
      // about that artifact", which is not the same claim as "there is none".
      if (paths.resumePath !== null && paths.resumePath !== undefined) {
        update.resume_storage_path = paths.resumePath;
      }

      // Same rule, same reason. Written as a second independent check rather
      // than a loop over the object so that a future field cannot be added to
      // the payload without someone deciding what its null means.
      if (paths.screenshotPath !== null && paths.screenshotPath !== undefined) {
        update.screenshot_storage_path = paths.screenshotPath;
      }

      // THE DIGEST. Same skip-nulls rule, and it earns it twice over: a
      // resume-less application has no digest to record, and a re-run that
      // wrote null over a recorded one would destroy the only thing that can
      // ever answer "is the file in that bucket the file that was approved?".
      // The path proves something was uploaded; only the digest proves WHAT.
      //
      // !! DO NOT DELETE THIS AS REDUNDANT WITH apply-one.ts's p_detail. !!
      //
      // `apply-one.ts` also passes a `resume_sha256` key into the
      // `advance_application_status` p_detail, and JSONB ACCEPTS ANY KEY — so
      // that write appeared to succeed for as long as no column existed, which
      // is exactly why it reads as proof that this one is superfluous. It is
      // not. THEY ARE DIFFERENT THINGS:
      //
      //   * the p_detail key is an EVENT PAYLOAD attached to one status
      //     transition. It lands in `application_events.detail`, is reachable
      //     only by digging through that table, describes a moment rather than
      //     the row — and in dry run is never written at all, because no
      //     transition happens. That absence IS the defect this method fixes.
      //   * this column is a DURABLE PROPERTY OF THE APPLICATION, queryable,
      //     indexable and true for as long as the row exists.
      //
      // Neither covers the other. Deleting either one loses something real.
      //
      // SHAPE IS ENFORCED IN THE DATABASE, not here:
      // `applications_resume_sha256_is_hex` checks `^[0-9a-f]{64}$` or null
      // (supabase/migrations/20260911114300_add_resume_sha256_to_applications
      // .sql), so a truncated or uppercased digest fails with 23514 rather than
      // being stored. Not re-checked in TypeScript, because a second copy of
      // the rule here would be one that can drift from the authority — and the
      // check is about legibility anyway: it cannot catch a well-formed digest
      // of the WRONG BYTES, which has already happened once on this project.
      if (paths.resumeSha256 !== null && paths.resumeSha256 !== undefined) {
        update.resume_sha256 = paths.resumeSha256;
      }

      // NOTHING TO SAY, SO SAY NOTHING. With every field null the payload is
      // `{}`, and PostgREST rejects an empty update rather than no-opping — a
      // 400 on a call that had no work to do. Returning early also means the
      // common "form wanted no document" case costs zero round trips.
      if (Object.keys(update).length === 0) {
        return;
      }

      // Matched on `id` alone, exactly as closeRun does. The user scoping is not
      // omitted, it is delegated: the "own applications" RLS policy
      // (migration 05) restricts every authenticated write to
      // `auth.uid() = user_id`, so a second `.eq('user_id', ...)` would
      // duplicate the database's own answer in a place that can drift from it.
      unwrap(
        await client.from('applications').update(update).eq('id', applicationId),
        'setArtifactPaths',
      );
    },

    sessionExpiresAtEpochSeconds() {
      return expiresAtEpochSeconds;
    },

    async refreshSession() {
      // Re-authenticating from credentials rather than rotating a refresh
      // token: the failure mode we need is "stop cleanly and leave the row
      // claimable", and a fresh password sign-in either works or throws, with
      // no half-state where the client believes it is authenticated and is not.
      if (config.email && config.password) {
        const data = unwrap(
          await client.auth.signInWithPassword({ email: config.email, password: config.password }),
          'refreshSession',
        );
        // Supabase's `expires_at` is ALREADY epoch seconds, while Date.now() is
        // milliseconds. Multiplying here by 1000 would make the token look
        // ~50,000 years fresh, the refresh would never fire, and the batch
        // would die mid-run — the exact failure the run-window gate exists to
        // prevent, defeated by a units bug.
        expiresAtEpochSeconds = data.session?.expires_at ?? 0;
        return;
      }
      // No credentials supplied: read whatever session the client already
      // holds. Used by tests and by any caller that signed in elsewhere.
      const data = unwrap(await client.auth.getSession(), 'refreshSession');
      expiresAtEpochSeconds = data.session?.expires_at ?? 0;
    },
  };
}
