// The apply-kit SWEEP: the system builds manual-apply kits by itself (Teja, 2026-10-24
// 16:20: "the kits need to generated automatically by system, dynamically not by you").
//
// A kit is due when a row waits on Teja (KIT_STATUSES) and has no kit newer than its last
// status change: the row parked, got re-claimed, or moved lanes since it was kitted, so the
// old kit may describe a different situation. The sweep finds those rows, builds a capped
// few per run (one browser, rows in turn), and never lets one failure stop the others.
// It runs after every applier run (workflow_run) plus a daily backstop, so a parked row
// gets its kit minutes later without anyone dispatching anything.
import type { ApplicationStatus } from '@applyy/shared-types';
// The statuses that wait on Teja: the same list buildApplyKit re-checks per row.
import { KIT_STATUSES } from './apply-kit.ts';
// The client shape the production gateway accepts, so the reader runs on the same client.
import type { SupabaseLike } from './supabase-gateway.ts';
// The applier's UUID shape check, so a kit id and APPLY_ONLY_ID refuse the same junk.
import { parseOnlyApplicationId } from './claim-loop.ts';

/**
 * The CLI's mode: one application id, or undefined for the sweep. Lives here, not in the
 * CLI, because the CLI runs main() on import and so cannot be loaded by a test.
 */
export function parseKitTarget(raw: string | undefined): string | undefined {
  // Absent or blank selects the sweep: a scheduled or workflow_run trigger has no input, and
  // GitHub expands the missing input to ''. The applier's parser throws on '', so it is checked here.
  if (raw === undefined || raw.trim() === '') return undefined;
  // Anything else must be a UUID.
  try {
    // The applier's parser: trimmed, shape-checked, lower-cased.
    return parseOnlyApplicationId(raw);
  } catch {
    // Re-thrown under the kit's own names: the parser's message names APPLY_ONLY_ID.
    // A malformed id is refused, never read as "no id": that would silently run a sweep instead.
    throw new Error(`--id / APPLY_KIT_ID must be an application UUID; got ${JSON.stringify(raw)}`);
  }
}

/** One application as the sweep needs it: which lane it is in, and since when. */
export interface SweepRow {
  // applications.id
  readonly id: string;
  // Only KIT_STATUSES rows are candidates; the rest are filtered here, not trusted from the query.
  readonly status: ApplicationStatus;
  // applications.status_changed_at: set by the transition trigger whenever the status moves.
  readonly statusChangedAt: string;
}

/** One existing kit note: whose, and when it was written. */
export interface KitStamp {
  // application_events.application_id
  readonly applicationId: string;
  // application_events.created_at
  readonly createdAt: string;
}

/** What one sweep run did, for the log and the exit code. */
export interface SweepSummary {
  // Rows that needed a kit, including those the cap left for the next run.
  readonly eligible: number;
  // Rows this run tried.
  readonly attempted: number;
  // Rows that got a kit.
  readonly built: number;
  // Rows that failed, each with its reason, so nothing is swallowed.
  readonly failed: ReadonlyArray<{ readonly id: string; readonly reason: string }>;
}

/** The sweep's inputs, injected so the selection and the loop are testable without a browser. */
export interface RunKitSweepInput {
  // Every row that could be waiting on Teja.
  readonly listRows: () => Promise<readonly SweepRow[]>;
  // The kit notes for exactly these ids.
  readonly listKits: (applicationIds: readonly string[]) => Promise<readonly KitStamp[]>;
  // Builds one kit; buildApplyKit re-checks the status and the robots gate per row.
  readonly buildOne: (applicationId: string) => Promise<void>;
  // The most kits one run builds; a page load and a render each, so it is bounded.
  readonly cap: number;
  // One line per event; values never appear in it, only ids and reasons.
  readonly log: (line: string) => void;
}

// An ISO-ish timestamp: the shape PostgREST returns for timestamptz. Checked BEFORE
// Date.parse, which reads "-5" as the year -5 (CLAUDE.md §6).
const TIMESTAMP_SHAPE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/;

/** Milliseconds for a well-shaped timestamp, or null for anything else. */
function readTime(value: string): number | null {
  // Shape first: a lenient parser must not turn junk into a time.
  if (!TIMESTAMP_SHAPE.test(value)) return null;
  // Then the real parse, which may still refuse an impossible date.
  const ms = Date.parse(value);
  // NaN is "unreadable", never a time.
  return Number.isNaN(ms) ? null : ms;
}

/**
 * The rows that need a kit, longest-waiting first, and the capped few to build now.
 * A row is due when it is in KIT_STATUSES and its newest READABLE kit is not newer than
 * its status change. An unreadable status stamp makes it due (a kit we cannot prove fresh
 * is treated as missing); an unreadable kit stamp is ignored for the same reason.
 */
export function selectKitCandidates(rows: readonly SweepRow[], kits: readonly KitStamp[], cap: number): { eligible: string[]; selected: string[] } {
  // The newest readable kit per application; older and unreadable ones cannot make a row fresh.
  const newestKit = new Map<string, number>();
  // Every note, because the server's order is not trusted to be newest-first.
  for (const stamp of kits) {
    // The note's time, if it has a readable one.
    const at = readTime(stamp.createdAt);
    // Unreadable: skipped, so it never vouches for a row.
    if (at === null) continue;
    // The newest seen so far for this row.
    const seen = newestKit.get(stamp.applicationId);
    // Kept only if newer, whatever order the notes arrive in.
    if (seen === undefined || at > seen) newestKit.set(stamp.applicationId, at);
  }
  // The due rows with the time they started waiting (unreadable sorts first: it has waited unknowably long).
  const due: Array<{ id: string; since: number }> = [];
  // Each row decided on its own.
  for (const row of rows) {
    // Only rows waiting on Teja; the query is not trusted to have filtered.
    if (!KIT_STATUSES.includes(row.status)) continue;
    // When the current situation began.
    const changed = readTime(row.statusChangedAt);
    // Its newest kit, if any.
    const kitAt = newestKit.get(row.id);
    // Fresh only when both are readable and the kit came after the change.
    const fresh = changed !== null && kitAt !== undefined && kitAt > changed;
    // Not provably fresh means due; an unreadable change time sorts as the longest wait.
    if (!fresh) due.push({ id: row.id, since: changed ?? Number.NEGATIVE_INFINITY });
  }
  // Longest-waiting first; ties keep the input order (Array.prototype.sort is stable).
  due.sort((left, right) => left.since - right.since);
  // Every due id, so the log can say how many the cap left for later.
  const eligible = due.map((entry) => entry.id);
  // The few this run builds.
  return { eligible, selected: eligible.slice(0, Math.max(0, cap)) };
}

/** One sweep: read, select, build each selected row in turn, and report every outcome. */
export async function runKitSweep(input: RunKitSweepInput): Promise<SweepSummary> {
  // Every row that might wait on Teja.
  const rows = await input.listRows();
  // Kits are read only for the candidates, so the read stays small as history grows.
  const candidateIds = rows.filter((row) => KIT_STATUSES.includes(row.status)).map((row) => row.id);
  // No candidate, no second read.
  const kits = candidateIds.length === 0 ? [] : await input.listKits(candidateIds);
  // The due rows and this run's share.
  const { eligible, selected } = selectKitCandidates(rows, kits, input.cap);
  // An empty sweep says so; a silent pass would look like a broken one.
  if (eligible.length === 0) {
    // The exact phrase a log search for "0 eligible" finds.
    input.log('[apply-kit sweep] 0 eligible: every row waiting on Teja already has a current kit');
    // Nothing tried, nothing failed.
    return { eligible: 0, attempted: 0, built: 0, failed: [] };
  }
  // The plan, before any page opens.
  input.log(`[apply-kit sweep] ${eligible.length} eligible, building ${selected.length} this run (cap ${input.cap})`);
  // Kits that landed.
  let built = 0;
  // Rows that failed, with why, in order.
  const failed: Array<{ id: string; reason: string }> = [];
  // Serially: one browser, one form at a time, so a slow page cannot overlap another.
  for (const id of selected) {
    // Each row in its own try, so its failure stays its own.
    try {
      // One kit; any refusal inside (status, robots, missing master) throws.
      await input.buildOne(id);
      // Counted only after the note was written.
      built += 1;
      // Ids and outcomes only; values never reach the log.
      input.log(`[apply-kit sweep] ${id}: kit built`);
    } catch (error) {
      // The reason as text, whatever was thrown.
      const reason = error instanceof Error ? error.message : String(error);
      // Recorded and skipped: one bad form must not starve the other rows of their kits.
      failed.push({ id, reason });
      // Named in the log, so a red run says which row and why.
      input.log(`[apply-kit sweep] ${id}: FAILED: ${reason}`);
    }
  }
  // The totals, for the run summary and the exit code.
  return { eligible: eligible.length, attempted: selected.length, built, failed };
}

/** The sweep's two reads over a supabase-js client; errors throw, since supabase-js returns them. */
export function createSweepReader(client: SupabaseLike): Pick<RunKitSweepInput, 'listRows' | 'listKits'> {
  // Two reads, both over the signed-in client, so RLS bounds them to Teja's rows.
  return {
    // Every row in a lane that waits on Teja.
    async listRows() {
      // The candidate lanes, with the stamp the transition trigger keeps (status_transition_guard).
      const result = await client.from('applications').select('id, status, status_changed_at').in('status', [...KIT_STATUSES]);
      // A refused read must not look like "nothing to do".
      if (result.error) throw new Error(`apply kit sweep: read applications failed: ${result.error.message}`);
      // Narrowed to the sweep's shape.
      return (result.data ?? []).map((r: { id: string; status: ApplicationStatus; status_changed_at: string }) => ({ id: r.id, status: r.status, statusChangedAt: r.status_changed_at }));
    },
    // The kit notes of exactly these rows.
    async listKits(applicationIds) {
      // Only the kit notes of these rows: the note kind is the discriminator (contract v1).
      const result = await client
        // The append-only event log the kit writes into.
        .from('application_events')
        // Whose, and when: all the selection needs, never the kit's values.
        .select('application_id, created_at')
        // Kits are notes...
        .eq('event_type', 'note')
        // ...of this kind, so unknown-cause notes are not mistaken for kits.
        .eq('detail->>kind', 'apply_kit')
        // Bounded to the candidates, so the read stays small as history grows.
        .in('application_id', [...applicationIds]);
      // Same rule: an error is never "no kits" (which would re-kit everything silently).
      if (result.error) throw new Error(`apply kit sweep: read kit notes failed: ${result.error.message}`);
      // Narrowed to the sweep's shape.
      return (result.data ?? []).map((r: { application_id: string; created_at: string }) => ({ applicationId: r.application_id, createdAt: r.created_at }));
    },
  };
}
