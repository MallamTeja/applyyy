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
import type { AgentName, ApplicationStatus, ResolvedResume } from '@applyy/shared-types';
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

  return {
    async openRun(agent: AgentName) {
      // Opened before any work, so a crash leaves a visible stuck row.
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
      // Deliberately not returned or recorded as a health metric yet: the
      // function's `released_count` currently DOUBLE-COUNTS, because the second
      // statement's predicate re-catches the rows the first just moved to
      // `needs_verification` while their lease is still set. Reading it is fine;
      // publishing it would put a wrong number on the health page.
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
        apply_url?: string;
        // `claim_applications` is declared `returns setof public.applications`
        // and returns `a.*`, so the pinned snapshot arrives with the claim and
        // needs no second query. That matters beyond round trips: a separate
        // read could see a DIFFERENT snapshot than the one that was claimed if
        // the row were re-approved in between, and the resume would then be
        // rendered from data this run never validated.
        tailored_profile?: ResolvedResume | null;
      }>;
      return rows.map(
        (row): ClaimedApplication => ({
          id: row.id,
          status: 'approved',
          // `jobs.apply_url` is the canonical submit target decided at
          // normalize time, which is what keeps a LinkedIn sighting from ever
          // becoming a submit path.
          applyUrl: row.apply_url ?? '',
          // Passed through UNVALIDATED and un-defaulted on purpose. Coercing a
          // missing snapshot to an empty resume here would produce a blank PDF
          // that renders, uploads and attaches without complaint; leaving the
          // null intact means the attachment planner refuses the application
          // and a human sees why. `??` rather than a bare read so `undefined`
          // (column absent from the payload) and SQL NULL mean the same thing.
          tailoredProfile: row.tailored_profile ?? null,
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

    async releaseClaim(applicationId, reason) {
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
