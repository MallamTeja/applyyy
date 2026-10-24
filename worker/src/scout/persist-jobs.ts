// Job persistence for the scheduled scout: dedupe -> insert-new -> refresh-existing.
//
// WHY THIS EXISTS. cli/scout.ts used one `upsert ... ON CONFLICT DO UPDATE` per batch.
// The fingerprint is company+title+location, NOT the posting id, so two live postings can
// share one (10 pairs on Stripe's board alone). Postgres rejects the WHOLE statement when
// one batch holds the same conflict key twice ("cannot affect row a second time"), which
// failed 4 of the last 5 scheduled runs. The same DO UPDATE also overwrote first_seen_at
// on every poll and never moved seen_count. Mirrors the edge twin (scout-ats/index.ts).

// Type only: the real client is injected, so tests pass a fake and no network is touched.
// The client is only used for its type, so this import is erased at runtime and tests stay offline.
import type { SupabaseClient } from '@supabase/supabase-js';
// Row shape from the schema owner; redefining it would drift rather than fail.
// The shared row type keeps this module in step with the schema owner instead of drifting.
import type { JobInsert } from '../../../packages/shared-types/src/tables.ts';
// The blanking guard: an omitted field must never overwrite a stored one.
// Reused rather than rewritten: one blanking guard for every scout path means one place to fix.
import { planJobUpsertGroups } from '../../../supabase/functions/_shared/screen/upsert-plan.ts';
// The failed-poll update every scout path writes; shared so a job-write failure and a
// refused board can never mark a board two different ways.
import { failureMark } from '../../../supabase/functions/_shared/ats/registry.ts';

// A posting paired with how to rebuild its row against a STORED first sighting.
// Exported because the CLI builds these and the tests build fakes of them.
// What toJobInsert really emits: the shared JobInsert type omits the sighting columns, so
// they are declared here instead of being hidden behind a cast.
// A refresh payload: a job row with write-once first_seen_at gone and sighting counters set.
export type JobRefresh = JobInsert & { seen_count: number; last_seen_at: string };

export interface PreparedJob {
  // The row as built for a first sighting (first_seen_at = now).
  // Needed as-is for dedupe, screening and the insert path.
  row: JobInsert;
  // Rebuilds the row with the stored first_seen_at so derived posted_at stays stable.
  // A function, not a second row, because the rebuilt row depends on a stored value known only after the lookup.
  rebuild: (firstSeenAt: Date) => Promise<JobInsert & { first_seen_at?: string }>;
}

// What one persist call learned; the caller owns logging and the watchlist write.
// Returned as a value so the caller decides how loudly each failure is reported.
export interface PersistResult {
  // fingerprint -> job id, for the applications insert.
  // The applications insert needs job ids and the upsert response omits ignored rows.
  idByFingerprint: Map<string, string>;
  // Write failures as messages; non-empty means the board must count as failed.
  // Strings, not throws, so one bad group does not abandon the other boards' work.
  errors: string[];
}

// Keeps ONE posting per fingerprint, chosen deterministically so reruns agree:
// latest posted_at wins, then the lowest ats_job_id. Collisions are returned, never silent.
// Pure and synchronous so the collision rule can be tested without a client.
export function dedupeByFingerprint(jobs: readonly PreparedJob[]): { kept: PreparedJob[]; collisions: number } {
  // fingerprint -> current winner.
  const winners = new Map<string, PreparedJob>();
  // Counted so the caller can log it; a dropped row nobody hears about is data loss.
  let collisions = 0;
  for (const job of jobs) {
    const current = winners.get(job.row.fingerprint);
    // First sighting of this fingerprint in the poll.
    // Distinguishes 'no winner yet' from a real collision.
    if (current === undefined) {
      // Stored before continuing so the loop never counts the first posting as a collision.
      winners.set(job.row.fingerprint, job);
      continue;
    }
    // Every second sighting is one collision, whichever side loses.
    collisions += 1;
    // Replacement is decided by the total order, so the result does not depend on adapter output order.
    if (beats(job.row, current.row)) winners.set(job.row.fingerprint, job);
  }
  // Map insertion order keeps the output stable between runs.
  return { kept: [...winners.values()], collisions };
}

// Whether `a` is the more informative posting. Total order, so input order cannot matter.
// Not exported: the ordering is an implementation detail of dedupe.
function beats(a: JobInsert, b: JobInsert): boolean {
  // ISO-8601 strings compare correctly as text; a later posting is the fresher listing.
  if (a.posted_at !== b.posted_at) return a.posted_at > b.posted_at;
  // Tie-break on the lowest posting id; a missing id sorts last so a real id wins.
  return (a.ats_job_id ?? '￿') < (b.ats_job_id ?? '￿');
}

// Writes one batch. Rows are assumed already deduped (see dedupeByFingerprint).
// Takes the client as a parameter so it can be faked.
export async function persistJobBatch(
  db: SupabaseClient,
  batch: readonly PreparedJob[],
  now: Date,
): Promise<PersistResult> {
  // Result accumulators, returned even on failure so the caller can still log.
  const idByFingerprint = new Map<string, string>();
  const errors: string[] = [];
  // Nothing to write; an empty .in() list is a pointless round trip.
  if (batch.length === 0) return { idByFingerprint, errors };

  // WHICH FINGERPRINTS EXIST, read before writing so first_seen_at is write-once.
  // A single lookup per batch keeps the cost at one round trip however many rows exist.
  const { data: stored, error: storedErr } = await db
    .from('jobs')
    .select('id, fingerprint, first_seen_at, seen_count')
    .in('fingerprint', batch.map((j) => j.row.fingerprint));
  // An unreadable lookup would make every job look new and rewrite history; stop here.
  if (storedErr) return { idByFingerprint, errors: [`look up stored jobs: ${storedErr.message}`] };
  // fingerprint -> stored sighting facts.
  // A Map gives O(1) membership tests for the insert/refresh split below.
  const storedByFingerprint = new Map(
    (stored ?? []).map((r: { id: string; fingerprint: string; first_seen_at: string; seen_count: number }) => [r.fingerprint, r]),
  );
  // Existing rows already have their id.
  // Seeded first so existing jobs resolve to ids even if no write happens.
  for (const r of storedByFingerprint.values()) idByFingerprint.set(r.fingerprint, r.id);

  // NEW fingerprints: insert-only, so a row a concurrent run just created is left alone.
  // Only genuinely new fingerprints may take the insert path, or first_seen_at would be rewritten.
  const fresh = batch.filter((j) => !storedByFingerprint.has(j.row.fingerprint)).map((j) => j.row);
  // One request per key-set, as the blanking guard requires.
  // Per group, because the guard can split a batch by key-set.
  for (const group of planJobUpsertGroups(fresh)) {
    // Chained select asks Postgres for the ids the applications insert needs.
    const { data, error } = await db
      .from('jobs')
      .upsert(group, { onConflict: 'user_id,fingerprint', ignoreDuplicates: true })
      .select('id, fingerprint');
    // Recorded, not thrown: the other groups and the id fallback should still run.
    if (error) errors.push(`insert jobs: ${error.message}`);
    // Only rows actually inserted come back.
    else for (const j of data ?? []) idByFingerprint.set(j.fingerprint, j.id);
  }

  // EXISTING fingerprints: refresh only. first_seen_at is stripped so DO UPDATE cannot touch it.
  // Collected first so the guard sees every refresh row and can group them.
  const refreshed: JobRefresh[] = [];
  for (const j of batch) {
    // Absent means the row is new and was handled above.
    const s = storedByFingerprint.get(j.row.fingerprint);
    // Skipping here keeps new rows out of the refresh payload.
    if (s === undefined) continue;
    // Rebuilt against the stored first sighting so posted_at and source_refs stay stable.
    // Typed destructure: first_seen_at is named only to be discarded, so it can never reach DO UPDATE.
    const { first_seen_at: _dropped, ...rest } = await j.rebuild(new Date(s.first_seen_at));
    // ponytail: read-then-write increment; two concurrent polls of one board can lose a count.
    // Ceiling: concurrent polls undercount. Upgrade: an atomic RPC doing `seen_count = seen_count + 1`; none exists yet.
    refreshed.push({ ...rest, seen_count: s.seen_count + 1, last_seen_at: now.toISOString() });
  }
  // Same guard as inserts, so a thin re-poll cannot blank a stored description.
  for (const group of planJobUpsertGroups(refreshed)) {
    // ignoreDuplicates false is deliberate: refreshing an existing row is the point of this write.
    const { error } = await db.from('jobs').upsert(group, { onConflict: 'user_id,fingerprint', ignoreDuplicates: false });
    // A failed refresh makes the board failed, same as a failed insert.
    if (error) errors.push(`refresh jobs: ${error.message}`);
  }

  // Fallback for rows a concurrent run inserted between our lookup and our insert.
  // Anything still unresolved was raced or ignored, and needs its id looked up.
  const missing = batch.map((j) => j.row.fingerprint).filter((f) => !idByFingerprint.has(f));
  // Skips the query in the common case where nothing raced.
  if (missing.length > 0) {
    // Selects only the two columns the caller consumes.
    const { data, error } = await db.from('jobs').select('id, fingerprint').in('fingerprint', missing);
    // Unresolved ids would silently drop applications, so this counts as a failure.
    if (error) errors.push(`look up raced jobs: ${error.message}`);
    else for (const j of data ?? []) idByFingerprint.set(j.fingerprint, j.id);
  }
  // Always returns both parts so a partial failure still yields usable ids.
  return { idByFingerprint, errors };
}

// The company_watchlist update for a finished poll. Pure so "a board whose job writes
// failed is not marked healthy" is testable without running the whole CLI.
// Takes the board's counters rather than the whole row so the contract with the CLI is explicit.
export function watchlistPollUpdate(
  board: { poll_count: number; first_polled_at: string | null; consecutive_failures: number },
  jobWriteErrors: readonly string[],
  postingCount: number,
  now: Date,
): Record<string, unknown> {
  // Failure: count it and move the board back in the rotation, but write NO success field.
  // The shared failed-poll update, so this cannot drift from the scouts' refusal marks.
  if (jobWriteErrors.length > 0) return failureMark(board, now);
  // Success: the only path allowed to reset consecutive_failures.
  return {
    poll_count: (board.poll_count || 0) + 1,
    first_polled_at: board.first_polled_at || now.toISOString(),
    last_polled_at: now.toISOString(),
    last_poll_job_count: postingCount,
    consecutive_failures: 0,
  };
}
