// Disappearance marking for the scheduled (worker) scout (2026-11-05).
//
// WHY THIS EXISTS. Only the edge scout-ats marked jobs.disappeared_at, and it runs only on a
// Scan-button pass. The scout on cron is the worker (scout.yml -> cli/scout.ts): it re-sighted
// rows (last_seen_at) and recorded polls (last_polled_at) but never marked the postings a poll no
// longer listed. 7,592 stale live rows piled up (GitLab 267, Databricks 364, measured 2026-11-05),
// and closed postings reached Teja's approval queue (GitLab 267dcfcd, approved, closed in September).
//
// NO SECOND PLANNER: the decision is the edge's own planDisappearances/planReappearances, imported
// by relative path (as persist-jobs.ts imports the Workday detail module), so both scouts mark by
// one rule: the recent-basis guards and the 14-day stale bar (liveness.ts). The writes below are
// scout-ats/index.ts's, statement for statement.

// Type only: the real client is injected, so tests pass a fake and no network is touched.
import type { SupabaseClient } from '@supabase/supabase-js';
// The one shared planner, its input shapes, and the reappearance rule.
import {
  planDisappearances,
  planReappearances,
  type DisappearedJob,
  type LiveStoredJob,
} from '../../../supabase/functions/_shared/scout/liveness.ts';

// What the snapshot read hands back: the board's rows split by liveness, or why it failed.
export type LivenessSnapshot =
  // Read; the two sets the planners take.
  | { readonly ok: true; readonly storedLive: readonly LiveStoredJob[]; readonly storedDisappeared: readonly DisappearedJob[] }
  // Unreadable: liveness is skipped for this board, never run against an "empty" board.
  | { readonly ok: false; readonly message: string };

// The board fields liveness reads, as the CLI holds the watchlist row in memory.
export interface LivenessBoard {
  // Provider + slug identify the company's rows (core_tables.sql jobs columns).
  readonly ats_provider: string;
  // Same.
  readonly company_slug: string;
  // The PREVIOUS poll's time: the CLI's in-memory row is read before this poll's update.
  readonly last_polled_at: string | null;
  // The PREVIOUS poll's posting count.
  readonly last_poll_job_count: number | null;
}

// Read the board's stored rows BEFORE this poll writes anything. Read after the inserts, a
// fingerprint drift would add every posting as a new row, the new rows would overlap the poll 100%,
// and the guards would pass vacuously (liveness.ts DisappearanceInput.storedLive).
// ponytail: PostgREST caps the read at 1000 rows; a truncated snapshot can only under-mark. Page it
// if a board ever stores more (largest today: Databricks, ~600).
export async function readLivenessSnapshot(db: SupabaseClient, userId: string, board: LivenessBoard, discoverySource: string): Promise<LivenessSnapshot> {
  // The same select and scope as scout-ats's snapshot.
  const { data, error } = await db
    .from('jobs')
    // last_seen_at for the recent basis; repost_count for a reappearance's + 1.
    .select('id, fingerprint, disappeared_at, repost_count, last_seen_at')
    // Explicit owner scope, not only RLS: the update below must never cross users.
    .eq('user_id', userId)
    // This company's rows on this provider.
    .eq('ats_provider', board.ats_provider)
    // Same.
    .eq('company_slug', board.company_slug)
    // Only rows this board's adapter reported: an aggregator-found twin may not be on this board.
    .contains('discovered_via', [discoverySource]);
  // Reported, never an empty board (an empty snapshot would only refuse, but say why anyway).
  if (error) return { ok: false, message: error.message };
  // The row shape the select returns.
  const rows = (data ?? []) as Array<{ id: string; fingerprint: string; disappeared_at: string | null; repost_count: number; last_seen_at: string | null }>;
  // Split once.
  return {
    // Read.
    ok: true,
    // Live rows: the marking candidates, with the sighting the recent basis reads.
    storedLive: rows.filter((r) => r.disappeared_at === null).map((r) => ({ id: r.id, fingerprint: r.fingerprint, lastSeenAt: r.last_seen_at })),
    // Disappeared rows: the reappearance candidates.
    storedDisappeared: rows.filter((r) => r.disappeared_at !== null).map((r) => ({ id: r.id, fingerprint: r.fingerprint, repost_count: r.repost_count })),
  };
}

// What one board's liveness pass did, for the run's closing log lines.
export interface LivenessResult {
  // Rows marked disappeared by this poll (0 when refused or nothing absent).
  readonly marked: number;
  // Disappeared rows this poll listed again, cleared.
  readonly reappeared: number;
  // The planner's refusal reason, or a failed write; null when the plan ran clean.
  readonly refused: string | null;
}

// Plan and write one board's disappearances and reappearances. Call it ONLY after every job write
// and the watchlist success write landed (scout-ats's rule: then the poll is a complete view).
export async function applyBoardLiveness(
  db: SupabaseClient,
  userId: string,
  snapshot: Extract<LivenessSnapshot, { ok: true }>,
  polledFingerprints: readonly string[],
  board: LivenessBoard,
  now: Date,
): Promise<LivenessResult> {
  // The previous poll, when the board has one with a count; null keeps the whole-set rule.
  const previousPoll = board.last_polled_at !== null && board.last_poll_job_count !== null ? { at: board.last_polled_at, jobCount: board.last_poll_job_count } : null;
  // The shared verdict. pollOk/batchErrors are fixed because the caller only gets here on a clean poll.
  const plan = planDisappearances({ storedLive: snapshot.storedLive, polledFingerprints, pollOk: true, batchErrors: 0, previousPoll });
  // Counted below.
  let marked = 0;
  // The refusal or write failure, for the log.
  let refused: string | null = null;
  // A refusal writes nothing; the next poll asks again.
  if (plan.kind === 'refuse') refused = plan.reason;
  // Something to mark.
  else if (plan.ids.length > 0) {
    // Owner- and id-scoped, and only rows still live, so a concurrent run's mark keeps its time.
    const { error } = await db.from('jobs').update({ disappeared_at: now.toISOString() }).eq('user_id', userId).in('id', plan.ids).is('disappeared_at', null);
    // The jobs were polled fine; a failed mark is a liveness gap, not a failed board.
    if (error) refused = `mark_write_failed: ${error.message}`;
    // Counted only when the write landed.
    else marked = plan.ids.length;
  }
  // Reposts: cleared and counted, per row because repost_count is per-row + 1.
  let reappeared = 0;
  // ponytail: read-then-write increment, the same ceiling as seen_count in persist-jobs.ts.
  for (const job of planReappearances({ storedDisappeared: snapshot.storedDisappeared, polledFingerprints, pollOk: true })) {
    // Cleared, owner- and id-scoped.
    const { error } = await db.from('jobs').update({ disappeared_at: null, repost_count: job.repost_count + 1 }).eq('user_id', userId).eq('id', job.id);
    // Logged, not thrown: the posting is listed either way, and the next poll retries the clear.
    if (error) console.warn(`[applyy-scout] reappearance clear failed for ${job.id}: ${error.message}`);
    // Counted only when it landed.
    else reappeared += 1;
  }
  // The board's tally.
  return { marked, reappeared, refused };
}
