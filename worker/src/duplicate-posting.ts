// A second copy of an already-applied posting, refused by the database (round 7, 2026-11-21).
//
// WHY IT EXISTS: Canonical's greenhouse posting 5150422 was applied to twice (11-11 and 11-18), the
// second time through a retitled twin row. The migration <ts>_guard_one_application_per_posting.sql
// makes the DB refuse status -> 'applying' with errcode 23505 when the same user already has an
// application for the same provider + ats_job_id at applying | blocked_needs_human | applied.
// supabase-js RETURNS that as { error: { code: '23505' } } (it does not throw); the gateway maps it
// to this type so the applier branches on a class, never on a message (CLAUDE.md §6).
//
// Its own tiny module, not supabase-gateway.ts: apply-one.ts (the applier) and the gateway both need
// the class, and the gateway already imports apply-one's types, so a value import the other way
// would load the Supabase layer into the applier at runtime.

// The refusal itself: certain no-send, because the move into 'applying' comes before any click.
export class DuplicatePostingAppliedError extends Error {
  // The row the DB refused to move, so the log and the release name it.
  readonly applicationId: string;

  constructor(applicationId: string, dbMessage: string) {
    // The DB's own words kept in the message, for a human reading the log.
    super(`duplicate posting already applied: application ${applicationId} refused entering applying (${dbMessage})`);
    // Its own name, so a stack or log line says which refusal this was.
    this.name = 'DuplicatePostingAppliedError';
    // Kept for callers.
    this.applicationId = applicationId;
  }
}

// The Postgres unique_violation errcode the trigger raises for this refusal.
export const DUPLICATE_POSTING_ERRCODE = '23505';
