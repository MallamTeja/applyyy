// scout-ats `?mode=liveness` (2026-11-18, D4 of docs/audit/2026-11-18-discovery-channels.md): the
// pure decisions, kept out of index.ts because index.ts runs Deno.serve on import and node --test
// cannot reach logic inside it (same split as gate.ts).
//
// WHY THE MODE EXISTS. Queue and feed liveness only ran inside scout-ats, and scout-ats only ran on a
// button Scan; the scheduled scout (worker/src/cli/scout.ts) has neither check. So a posting that
// closed while its row sat in awaiting_approval/approved stayed approvable until Teja clicked Scan.
// The daily workflow (.github/workflows/scout-ats-daily.yml) calls this mode, which runs the two
// checks WITHOUT the scan's work (no upserts, no screener, no watchlist telemetry).
//
// WHY IT STILL READS BOARDS. Queue liveness retires a row only on TWO proofs (queue-liveness.ts):
// absent from a complete, trusted listing AND the posting endpoint says gone. The listing is what
// stops a renamed or dead board token (every posting 404s) from retiring the whole queue on one
// proof, so this mode reads the listing, but only for the boards that hold queue rows.

// The queue statuses the sweep reads rows for: the same set queue-liveness.ts confirms (its
// QUEUE_STATUSES is module-private). liveness-mode.test.ts pins the two against each other through
// queueApplicationIds, so a status added there without here fails a named test instead of drifting.
export const SWEEP_QUEUE_STATUSES = ["awaiting_approval", "approved"] as const;

// What the caller asked for. Absent means the full scan, which the web Scan button sends.
export type ScoutMode = "scan" | "liveness";

// The `?mode` parameter, or null for anything unknown. Null must be refused by the caller: an
// unknown mode falling through to a full scan is the permissive-reader bug (CLAUDE.md §6), and a
// typo in a scheduled caller would then silently poll boards and upsert jobs every day.
export function resolveScoutMode(raw: string | null): ScoutMode | null {
  // No parameter: the scan, unchanged for every existing caller.
  if (raw === null) return "scan";
  // The one other accepted value, exact (no trimming, no case folding).
  if (raw === "liveness") return "liveness";
  // Everything else, the empty string and "scan" itself included: refused.
  return null;
}

// Whether the queue read returned every row. postgrest caps a read (1000 by default) without an
// error, so a short read looks exactly like a small queue; only the exact count can tell them apart.
// A null count is not evidence of anything.
export function queueReadComplete(count: number | null, rows: number): boolean {
  // Complete only when the database's own count equals what came back.
  return count !== null && count === rows;
}

// One queue job's board identity: the columns the watchlist row is matched on.
export interface QueueJobBoardKey {
  // The job's ATS.
  readonly ats_provider: string;
  // The job's company slug, as the board poll stores it.
  readonly company_slug: string;
}

// The fields of a watchlist row the grouping reads; the caller's full row type passes through.
export interface BoardKey {
  // The board's ATS.
  readonly ats_provider: string;
  // The board's company slug.
  readonly company_slug: string;
}

// The boards the sweep reads, and the queue rows it could not place on one.
export interface QueueBoardsPlan<B> {
  // Watchlist boards holding at least one queue row, each once, in watchlist order.
  readonly boards: readonly B[];
  // Queue jobs whose provider+slug matches no enabled watchlist board (a pasted link, a removed board).
  readonly unmatched: number;
  // Queue jobs whose provider+slug matches more than one board: absence from one twin is not proof.
  readonly ambiguous: number;
}

// The watchlist boards worth reading for the queue. Pure. Matching is on provider AND slug, the same
// pair the board poll's snapshot scopes on (index.ts: ats_provider + company_slug).
export function queueBoards<B extends BoardKey>(queueJobs: readonly QueueJobBoardKey[], watchlist: readonly B[]): QueueBoardsPlan<B> {
  // One key per pair; slugs are lowercase slugs and providers a closed enum, so a separator cannot collide.
  const key = (provider: string, slug: string) => `${provider}/${slug}`;
  // Board rows by pair; more than one row per pair makes the pair ambiguous.
  const byKey = new Map<string, B[]>();
  // Index the watchlist.
  for (const b of watchlist) byKey.set(key(b.ats_provider, b.company_slug), [...(byKey.get(key(b.ats_provider, b.company_slug)) ?? []), b]);
  // The pairs that hold queue rows, and the skip counts.
  const wanted = new Set<string>();
  // Counted per queue job, so the report reads in rows.
  let unmatched = 0;
  let ambiguous = 0;
  // Place each queue job.
  for (const job of queueJobs) {
    // The boards this job could belong to.
    const matches = byKey.get(key(job.ats_provider, job.company_slug)) ?? [];
    // None: the sweep cannot read a listing for it.
    if (matches.length === 0) unmatched += 1;
    // Several: not one listing to judge absence against.
    else if (matches.length > 1) ambiguous += 1;
    // Exactly one: read it.
    else wanted.add(key(job.ats_provider, job.company_slug));
  }
  // Watchlist order, so a capped or deadline-cut run reads the same boards first every time.
  return { boards: watchlist.filter((b) => wanted.has(key(b.ats_provider, b.company_slug))), unmatched, ambiguous };
}
