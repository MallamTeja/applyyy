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
import type { AgentName, ApplicationStatus, AtsProvider, MasterProfile, ResolvedResume } from '@applyy/shared-types';
// UnusableClaim is the W4 shape for a claimed row with nowhere to go (lease kept, never opened).
import type { RunGateway, UnusableClaim } from './claim-loop.ts';
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

  // Local functions for the same `this` reason as releaseApplierClaim above: the sweep
  // records its own sweeper run through these, and must not depend on how it was called.
  async function openRun(agent: AgentName): Promise<{ id: string }> {
    // Opened before any work, so a crash leaves a visible stuck row.
    // unwrap converts supabase-js's error-as-value into a throw, so a DB failure is not read as no profile.
    const data = unwrap(
      await client.from('agent_runs').insert({ agent }).select().single(),
      'openRun',
    );
    // Only the id leaves: it is all closeRun needs.
    return { id: (data as { id: string }).id };
  }

  // Closes a run by id. unwrap again, so a refused close throws instead of passing silently.
  async function closeRun(runId: string, update: Record<string, unknown>): Promise<void> {
    unwrap(await client.from('agent_runs').update(update).eq('id', runId), 'closeRun');
  }

  return {
    // The port's two run methods ARE the locals, so the loop and the sweep share one write path.
    openRun,
    closeRun,

    async appendApplicationNote(applicationId, detail) {
      // A plain INSERT: application_events is append-only (a trigger forbids update and delete), and its
      // "append own events" policy admits agent 'applier' only with a valid x-applyy-agent-key header,
      // which this client already sends. user_id is carried explicitly rather than left to auth.uid().
      unwrap(
        await client.from('application_events').insert({
          // The app user this worker signs in as; RLS requires it to equal auth.uid().
          user_id: config.userId,
          // The one application the note is about: the exact key the queue joins on.
          application_id: applicationId,
          // An existing application_event_type value; no migration.
          event_type: 'note',
          // Who wrote it, so the log separates the worker's notes from a person's.
          agent: 'applier',
          // The structured payload.
          detail,
        }),
        // Named in the thrown message, so a failure says which write failed.
        'appendApplicationNote',
      );
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
      // THE SWEEPER'S OWN agent_runs ROW (2026-11-01). The sweep_stale_claims RPC writes none,
      // so the Health page called the sweeper "never run" on every day it ran. Recorded HERE,
      // in the one function every sweep goes through, through the same openRun/closeRun the
      // applier uses. Opened BEFORE the RPC, like every run: a crash mid-sweep then leaves a
      // visible `running` row instead of nothing, and nothing reads the same as "never ran".
      const run = await openRun('sweeper');
      // Held outside the try so the failure branch can tell whether the RPC itself failed.
      let data: unknown;
      try {
        // unwrap turns supabase-js's error-as-value into a throw, so a refused sweep is a failure.
        data = unwrap(await client.rpc('sweep_stale_claims'), 'sweepStaleClaims');
      } catch (error) {
        // A FAILED row, with the database's own words: the page then reads "runs, fails"
        // and points at error_detail, rather than "never ran" or a false success.
        await closeRun(run.id, {
          // The outcome the page's success clock ignores.
          status: 'failed',
          // When it failed, so the heartbeat still advances: the scheduler did fire.
          finished_at: new Date().toISOString(),
          // One error: the RPC call.
          error_count: 1,
          // The message unwrap built, e.g. "sweepStaleClaims failed: permission denied ...".
          error_detail: error instanceof Error ? error.message : String(error),
        });
        // Rethrown unchanged: the applier run that called the sweep must still fail on it.
        throw error;
      }
      // `returns table (...)` arrives over PostgREST as an ARRAY OF ROWS, so
      // `data.released_count` would be `undefined` — no error, no crash, just a
      // metric that is quietly always blank. Indexed, and guarded because an
      // empty array is the normal case on a healthy day.
      const rows = Array.isArray(data) ? data : [];
      const summary = rows[0] as { released_count?: number; needs_verification_count?: number } | undefined;
      // The return shape is settled: 20261004200000 restored (released_count,
      // needs_verification_count) and 20261009130000 kept it (live, checked 2026-11-01).
      // The two counts are DISJOINT (rows handed back to the queue vs rows parked for a
      // human because they died mid-submit), so their sum is every row this sweep moved.
      // A missing field counts 0 rather than NaN, so a blank never reaches the row.
      const swept = (summary?.released_count ?? 0) + (summary?.needs_verification_count ?? 0);
      // Closed as a success carrying the count. A close failure throws out of here on purpose:
      // a run row that cannot be written is the same broken table the applier's own close needs.
      await closeRun(run.id, {
        // The sweep ran and returned.
        status: 'succeeded',
        // The heartbeat AND success clock the Health page reads.
        finished_at: new Date().toISOString(),
        // Every row the sweep moved; 0 is the normal healthy day.
        rows_out: swept,
        // Stated, not defaulted, so the row reads the same as the applier's.
        error_count: 0,
      });
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
        // ats_provider rides it too (2026-11-01): apply-one parks Workday jobs, and a tenant
        // fronted on careers.company.com is recognisable only by this column, not its URL.
        await client.from('jobs').select('id, apply_url, disappeared_at, company_name, ats_provider').in('id', jobIds),
        'claimApplications: read jobs.apply_url',
      ) as Array<{ id: string; apply_url: string | null; disappeared_at?: string | null; company_name?: string | null; ats_provider?: AtsProvider | null }> | null;
      // Keyed by job id so each claimed row finds its URL in one lookup.
      const urlByJobId = new Map((jobs ?? []).map((job) => [job.id, job.apply_url]));
      // Keyed the same way, whole record kept so the loop can test key PRESENCE.
      // A Map so each claimed row finds its job in one lookup, same as the URL map above.
      const jobById = new Map((jobs ?? []).map((job) => [job.id, job]));

      // Every claimed row, in claim order: workable ones paired with their URL, unusable
      // ones NAMED. Built in a loop rather than one filter, because the liveness-unknown
      // case below still needs an awaited release and a filter callback cannot await.
      const claimed: Array<{ row: (typeof rows)[number]; url: string } | UnusableClaim> = [];
      for (const row of rows) {
        // Trimmed so a whitespace-only URL counts as missing, not as a target.
        const url = urlByJobId.get(row.job_id)?.trim();
        // FAIL CLOSED: no URL means there is nowhere honest to go. Returned as UNUSABLE
        // with its lease still held (W4). It used to be released here, which made it the
        // oldest claimable row again: five of them at the head of the queue made every
        // claim look empty. The claim loop now holds it (dry) or parks it (live), and the
        // reason still lands in `application_events` either way.
        if (!url) {
          // Named, with the job, so "why was this never attempted" has an answer.
          claimed.push({ id: row.id, unusable: 'no_apply_url', reason: `no apply_url on job ${row.job_id}; not attempted` });
          // Not workable: on to the next row.
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
        // NOT the liveness-unknown case above: that one is a schema or select bug that would
        // hit EVERY row, so parking it would sweep the whole approved queue to the human lane.
        if (job?.disappeared_at != null) {
          // Same as the no-URL gap (W4): named and returned with its lease, never released here.
          claimed.push({
            // This row, whose lease the loop now owns.
            id: row.id,
            // The machine-readable cause for the park detail.
            unusable: 'posting_disappeared',
            // Distinct token so health queries can count dead postings; the timestamp shows how long it has been dead.
            reason: `posting_disappeared: job ${row.job_id} disappeared at ${job.disappeared_at}; not attempted`,
          });
          // Not workable: on to the next row.
          continue;
        }
        // Kept with its row so the mapping below needs no second lookup.
        claimed.push({ row, url });
      }

      return claimed.map(
        (entry): ClaimedApplication | UnusableClaim => {
          // Unusable entries pass through unchanged; only workable rows are mapped.
          if ('unusable' in entry) return entry;
          // The workable pair, unpacked for the mapping below.
          const { row, url } = entry;
          // The row the browser will open.
          return {
            id: row.id,
            status: 'approved',
            // Present and non-empty by construction: the loop above named
            // every row without one UNUSABLE, so no `?? ''` fallback can reintroduce the
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
            // The job's ATS, for the Workday guard. `??` so an absent key and SQL NULL both
            // read as null ("no provider"); the guard's host check still runs on null.
            atsProvider: jobById.get(row.job_id)?.ats_provider ?? null,
          };
        },
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

    // W10: the Settings daily cap and what already went out in the window. Every failure
    // THROWS, because the loop reads a throw as "submit nothing" and any quiet default here
    // would read as "no cap" (CLAUDE.md §6: validate the positive shape).
    async fetchDailyCap(sinceIso) {
      // This user's row only: two users share system_settings live.
      const settings = unwrap(
        // maybeSingle: no row is a legal answer (see DailyCap), more than one is an error.
        await client.from('system_settings').select('max_applications_per_day').eq('user_id', config.userId).maybeSingle(),
        // Names the setting, so the run's error_detail says which read failed.
        'fetchDailyCap: read max_applications_per_day',
      ) as Record<string, unknown> | null;
      // A row whose select dropped the column is a code bug, not "no cap": fail closed.
      if (settings !== null && !('max_applications_per_day' in settings)) {
        // Thrown, never defaulted.
        throw new Error('fetchDailyCap: max_applications_per_day missing from the settings read; refusing to submit');
      }
      // No row reads as null, the documented "no daily cap" (DailyCap.maxPerDay).
      const raw = settings === null ? null : settings['max_applications_per_day'];
      // The positive shape: null, or a positive safe integer. Zero, a string or a fraction is not a cap.
      if (raw !== null && !(typeof raw === 'number' && Number.isSafeInteger(raw) && raw > 0)) {
        // The value is quoted so the log shows exactly what was stored.
        throw new Error(`fetchDailyCap: max_applications_per_day is ${JSON.stringify(raw)}, not a positive integer; refusing to submit`);
      }
      // "Sent" means a SUBMIT ATTEMPT, the same thing the loop counts for its own run
      // (submitted + outcomeUnknown). It is NOT "entered `applying`": a row parked at
      // blocked_needs_human before any click went through `applying` too, and counting it
      // let five early blocks use up a cap of 5 with nothing sent (code-review finding #10).
      // Two halves, both head-only exact counts filtered to this user like the settings read.
      //
      // Half 1, IN FLIGHT: rows sitting at `applying` right now. Each is either a concurrent
      // run mid-submit or an earlier run's unknown outcome the sweeper has not reached yet
      // (the loop reads this cap BEFORE it sweeps, and the worker never writes
      // needs_verification itself). Either may have been sent, so both count: fail closed.
      // Read FIRST: a row that finishes between the two reads is then counted twice (safe),
      // never zero times. ponytail: no window here, so a row stuck at `applying` for days
      // costs one slot until the sweep that follows this read moves it on.
      const inFlight = await client
        // The live rows, not their history.
        .from('applications')
        // Count only; no rows come back.
        .select('id', { count: 'exact', head: true })
        // This user's rows.
        .eq('user_id', config.userId)
        // Mid-submit, or stranded mid-submit.
        .eq('status', 'applying');
      // Half 2, RECORDED: the submit edges in the window. from IN x to IN is a cross product,
      // and it is exactly the three submit edges because blocked_needs_human ->
      // needs_verification is not an edge (application_status_transitions; the BEFORE UPDATE
      // guard refuses it). The three: applying -> applied (the applier's submit landed),
      // applying -> needs_verification (the sweeper's "outcome unknown"), and
      // blocked_needs_human -> applied (a human's submit, e.g. assisted-submit, which parks
      // BEFORE the human clicks). needs_verification -> applied is left out: it confirms an
      // attempt already counted when it reached needs_verification.
      const recorded = await client
        // The append-only history: a status_change row is written by every transition.
        .from('application_events')
        // Count only; no rows come back.
        .select('id', { count: 'exact', head: true })
        // This user's history.
        .eq('user_id', config.userId)
        // Status changes only, not notes or LLM calls.
        .eq('event_type', 'status_change')
        // Out of the two states a submit is made from.
        .in('from_status', ['applying', 'blocked_needs_human'])
        // Into the two states a submit can end in.
        .in('to_status', ['applied', 'needs_verification'])
        // Inside the trailing window the loop computed.
        .gte('created_at', sinceIso);
      // Each half validated the same way, labelled so the log says which read failed.
      const counted = (label: string, result: { count: unknown; error: { message: string } | null }): number => {
        // supabase-js reports a failure as a value; surfaced as a throw.
        if (result.error) throw new Error(`fetchDailyCap: count ${label} failed: ${result.error.message}`);
        // A missing count with no error is still not zero: fail closed on the shape.
        if (typeof result.count !== 'number' || !Number.isSafeInteger(result.count) || result.count < 0) {
          // Quoted, so the log shows what came back.
          throw new Error(`fetchDailyCap: count ${label} is ${JSON.stringify(result.count)}; refusing to submit`);
        }
        // The validated count.
        return result.count;
      };
      // Both halves, validated; their sum is what may already have gone out.
      return { maxPerDay: raw, sentSince: counted('rows in flight at applying', inFlight) + counted('submit attempts', recorded) };
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
