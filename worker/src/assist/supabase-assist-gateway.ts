// The real AssistGateway: the existing worker gateway for everything it already does,
// plus the two operations it lacks (read ONE row, claim ONE row by id). block_reason is
// no longer set here: the status RPC writes it from the park detail (20261004220000).
//
// WHY NOT EXTEND supabase-gateway.ts: it is owned by the scheduled applier and stable.
// `claim_applications` can only claim "the oldest N approved rows", which is exactly the
// wrong tool for "this one row, which I chose", so the by-id claim is done here with a
// conditional UPDATE instead.
import type { AnswerBankRow, ResolvedResume } from '@applyy/shared-types';
// The existing gateway supplies advance/release/answers; only the missing parts are written here.
import { createSupabaseGateway, type SupabaseLike } from '../supabase-gateway.ts';
// The port this file implements, declared beside the logic that consumes it.
import type { AssistGateway, AssistRow } from './assisted-submit.ts';

// How long the lease lasts. Only matters while the row is `approved` (the first status
// write clears it), so it just needs to outlast a page load; the sweeper handles the rest.
// A named constant so the lease length is a decision with a name, not a magic number.
const LEASE_SECONDS = 900;
// Stamped into claimed_by so the events/health views show who held the row.
// Prefixed `applier:` to match the scheduled worker's `applier:<runId>` convention.
const CLAIMED_BY = 'applier:assist';

/** supabase-js returns errors instead of throwing; this turns them back into throws. */
// Local copy because the gateway's own helper is not exported and is not mine to change.
function unwrap<T>(result: { data: T; error: { message: string } | null }, operation: string): T {
  // Without this a rejected write looks like a successful one and the flow carries on.
  // Checked first because supabase-js reports failure through this field, not by throwing.
  if (result.error) throw new Error(`${operation} failed: ${result.error.message}`);
  // Only reached on success, so callers can use the data without re-checking.
  return result.data;
}

// A factory over an injected client, so nothing here reads the environment.
export function createSupabaseAssistGateway(
  client: SupabaseLike,
  // The same three values the scheduled applier passes to its gateway.
  config: { userId: string; email: string; password: string },
): AssistGateway & { isSystemEnabled(): Promise<boolean>; refreshSession(): Promise<void> } {
  // Reused for advanceStatus / releaseClaim / fetchAnswers so the RPC call shapes live in
  // exactly one place.
  // One instance, shared by the delegating members below.
  const base = createSupabaseGateway(client, config);

  // One object literal, so every member of the port is visible in one place.
  return {
    // The RPC call shape, owned by the existing gateway.
    advanceStatus: base.advanceStatus,
    // Calls release_application_claim with agent `applier`.
    releaseClaim: base.releaseClaim,
    // Exposed so the CLI can honour the kill switch before launching a browser.
    isSystemEnabled: base.isSystemEnabled,
    // Exposed so the CLI primes the session the gateway checks.
    refreshSession: base.refreshSession,
    // Re-declared (not just assigned) to narrow the base gateway's loose return type.
    async fetchAnswers(): Promise<readonly AnswerBankRow[]> {
      // Delegated: the answer-bank query already exists and is tested.
      return base.fetchAnswers();
    },

    // Two queries because the apply URL lives on a different table.
    async loadApplication(id: string): Promise<AssistRow | null> {
      // Two reads, because `applications` has NO apply_url column: it lives on `jobs`.
      // First read: the application itself.
      const app = unwrap(
        await client
          // The table that holds status and the approved snapshot.
          .from('applications')
          // Only the four columns this flow needs.
          .select('id, status, job_id, tailored_profile')
          // The one row asked for.
          .eq('id', id)
          // Zero rows is a normal answer (RLS), so not an error.
          .maybeSingle(),
        // Names the operation in any thrown message.
        'loadApplication',
      ) as { id: string; status: string; job_id: string; tailored_profile: ResolvedResume | null } | null;
      // Not found, or hidden by RLS.
      // Mapped to null so the flow refuses with a plain message.
      if (app === null) return null;
      // Second read, keyed by the job id the application points at.
      const job = unwrap(
        await client
          // Where the canonical apply URL lives.
          .from('jobs')
          // The URL for navigation, the rest for the printed summary.
          .select('apply_url, title, company_name')
          // The job this application points at.
          .eq('id', app.job_id)
          // A missing job is handled by the null fallbacks below.
          .maybeSingle(),
        // Distinct label, so a failure says which of the two reads broke.
        'loadApplication: job',
      ) as { apply_url: string | null; title: string; company_name: string } | null;
      // Flattened into the shape the pure core expects.
      return {
        // Echoed from the row actually read.
        id: app.id,
        // Passed through as a plain string; the core decides if it is acceptable.
        status: app.status,
        // Null if the job row is missing, which the core treats as a refusal.
        applyUrl: job?.apply_url ?? null,
        // Normalised so undefined and null mean the same thing downstream.
        tailoredProfile: app.tailored_profile ?? null,
        // Display only; a placeholder is fine because no decision reads it.
        company: job?.company_name ?? '(unknown company)',
        // Same: display only.
        title: job?.title ?? '(unknown title)',
      };
    },

    // A conditional UPDATE, because claim_applications cannot target one id.
    async claim(id: string): Promise<boolean> {
      // Read once so claimed_at and the expiry are computed from the same instant.
      const now = Date.now();
      // The WHERE clause is the lock: it matches only an approved, unclaimed row, so two
      // claimers cannot both win. A same-status update passes the transition guard.
      const rows = unwrap(
        await client
          // Same table as the read; RLS scopes it to this user's rows.
          .from('applications')
          // A same-status update, which the transition guard permits.
          .update({
            // Who holds the lease.
            claimed_by: CLAIMED_BY,
            // When it was taken.
            claimed_at: new Date(now).toISOString(),
            // When the sweeper may reclaim it if we crash.
            claim_expires_at: new Date(now + LEASE_SECONDS * 1000).toISOString(),
          })
          // Only the one row chosen on the command line.
          .eq('id', id)
          // Only while still approved, so a moved row is never leased.
          .eq('status', 'approved')
          // Only if nobody else holds it, which is what makes this a lock.
          .is('claimed_by', null)
          // Returns the affected rows so the count can be checked.
          .select('id'),
        // The operation name appears in the thrown message.
        'claim',
        // Cast to the shape the .select('id') above returns.
      ) as Array<{ id: string }> | null;
      // Shape check, not truthiness: exactly one row means we hold the lease.
      // Exactly one: zero means we lost or it moved; more would mean a broken filter.
      return Array.isArray(rows) && rows.length === 1;
    },
  };
}
