// The apply-kit SWEEP: the system builds manual-apply kits by itself (Teja, 2026-10-24
// 16:20: "the kits need to generated automatically by system, dynamically not by you").
//
// A kit is due when a row waits on Teja (KIT_STATUSES) and has no kit newer than its last
// status change: the row parked, got re-claimed, or moved lanes since it was kitted, so the
// old kit may describe a different situation. K1 (2026-11-06): it is also due when an answer was
// edited or a master version saved after its newest kit, since the kit was planned from both
// (Enterpret kept "needs your answer" after Teja answered). The sweep finds those rows, builds a capped
// few per run (one browser, rows in turn), and never lets one failure stop the others.
// It runs after every applier run (workflow_run) plus a daily backstop, so a parked row
// gets its kit minutes later without anyone dispatching anything.
//
// Two rules on top (wiring audit 2026-11-01):
// - W28: the kill switch. With system_settings.system_enabled off, the sweep reads no row
//   and opens no employer page; an unreadable switch throws (fail closed).
// - W29: a row parked because its form cannot be opened (robots_refused, no_apply_url) is
//   never due. The kit hits the same robots gate or the same missing URL, so it threw on
//   every run, stayed un-stamped, was retried oldest-first and kept the workflow red.
//   SKIPPED rather than stamped with a failure note: skipping writes nothing and leaves the
//   v1 note contract alone, while a failure stamp would also silence TRANSIENT failures
//   (robots "wait", a timeout) until the next status change. Teja still sees the row in
//   the human queue with its reason, and `--id` still builds its kit on demand.
// BlockReason types the park fact, so a typo in the skip list fails to compile.
import type { ApplicationStatus, BlockReason } from '@applyy/shared-types';
// The statuses that wait on Teja: the same list buildApplyKit re-checks per row.
import { KIT_STATUSES, KitSkip } from './apply-kit.ts';
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
  // applications.block_reason. KEPT after a row leaves blocked_needs_human (20261004220000),
  // so it describes the row now only together with that status (W29).
  readonly blockReason: BlockReason | null;
  // applications.block_detail->>unusable: the applier's W4 cause ('no_apply_url' |
  // 'posting_disappeared'), or null. Typed as text: it is read from jsonb, not an enum.
  readonly blockUnusable: string | null;
  // applications.block_detail->>code: e.g. 'posting_closed' from the applier's pre-submit re-check (B2).
  // Text, read from jsonb.
  readonly blockCode: string | null;
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
  // Due rows this run never tried (the batch or the run budget stopped it): eligible - attempted.
  // Failed rows are NOT in it; they were tried, and wait for the next trigger.
  readonly remaining: number;
  // Rows that got a kit.
  readonly built: number;
  // Rows refused for a reason that is the system working (robots refused, posting closed), each recorded
  // once as an apply_kit_skipped note so it is not retried until its status changes (B2). Never a failure.
  readonly skipped: ReadonlyArray<{ readonly id: string; readonly code: KitSkip['code']; readonly reason: string }>;
  // Rows that failed, each with its reason, so nothing is swallowed.
  readonly failed: ReadonlyArray<{ readonly id: string; readonly reason: string }>;
}

/** The sweep's inputs, injected so the selection and the loop are testable without a browser. */
export interface RunKitSweepInput {
  // system_settings.system_enabled (W28). REQUIRED, so a sweep that ignores the kill switch
  // does not compile. A missing row reads false; a refused read throws (supabase-gateway).
  readonly isSystemEnabled: () => Promise<boolean>;
  // Every row that could be waiting on Teja.
  readonly listRows: () => Promise<readonly SweepRow[]>;
  // The kit notes for exactly these ids.
  readonly listKits: (applicationIds: readonly string[]) => Promise<readonly KitStamp[]>;
  // K1: the newest answer_bank.updated_at and the newest master_profiles.created_at (absent tables give
  // nothing). REQUIRED, so a sweep that ignores changed answers does not compile.
  readonly listInputTimes: () => Promise<readonly string[]>;
  // Builds one kit; buildApplyKit re-checks the status and the robots gate per row.
  readonly buildOne: (applicationId: string) => Promise<void>;
  // The most kits one run builds (25 since 2026-11-05: a batch, not a throughput limit; the rest go to
  // the run this one re-dispatches).
  readonly cap: number;
  // The run budget (3000 s, run-window.ts), checked before each row: once spent, no new kit starts, so
  // the job timeout never kills a run mid-row. REQUIRED, so a sweep without a budget does not compile.
  readonly outOfTime: () => boolean;
  // Writes the apply_kit_skipped note for a KitSkip (B2). REQUIRED, so a sweep cannot skip silently: an
  // unrecorded skip would be retried every run, which is the starvation this exists to end.
  readonly recordSkip: (applicationId: string, code: KitSkip['code'], reason: string) => Promise<void>;
  // One line per event; values never appear in it, only ids and reasons.
  readonly log: (line: string) => void;
}

// An ISO-ish timestamp: the shape PostgREST returns for timestamptz. Checked BEFORE
// Date.parse, which reads "-5" as the year -5 (CLAUDE.md §6).
const TIMESTAMP_SHAPE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/;

// W29: the park causes under which a kit cannot open the form, so building one fails every run.
const UNOPENABLE_REASONS: readonly BlockReason[] = ['robots_refused'];
// The applier's W4 cause for a job with no form URL (claim-loop.ts UnusableClaim).
const UNOPENABLE_UNUSABLE: readonly string[] = ['no_apply_url'];
// B2: the applier's pre-submit re-check parks a closed posting with block_detail.code 'posting_closed'.
const UNOPENABLE_CODES: readonly string[] = ['posting_closed'];

/** True for a row parked RIGHT NOW for a cause no kit can get past (W29). */
function cannotOpenForm(row: SweepRow): boolean {
  // Only while parked: a re-approved row keeps its old block facts as history.
  if (row.status !== 'blocked_needs_human') return false;
  // Either cause is enough.
  return (row.blockReason !== null && UNOPENABLE_REASONS.includes(row.blockReason)) || (row.blockUnusable !== null && UNOPENABLE_UNUSABLE.includes(row.blockUnusable)) || (row.blockCode !== null && UNOPENABLE_CODES.includes(row.blockCode));
}

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
// K1: inputsChangedAt is the newest answer-bank edit or master version (ms), or null when neither exists.
// A kit not newer than it is due again: it was planned from answers or a master that have since changed.
export function selectKitCandidates(rows: readonly SweepRow[], kits: readonly KitStamp[], cap: number, inputsChangedAt: number | null = null): { eligible: string[]; selected: string[] } {
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
    // W29: a form no kit can open is never due, so it cannot keep the run red.
    if (cannotOpenForm(row)) continue;
    // When the current situation began.
    const changed = readTime(row.statusChangedAt);
    // Its newest kit, if any.
    const kitAt = newestKit.get(row.id);
    // Fresh only when both are readable, the kit came after the change, and (K1) after the inputs last changed.
    const fresh = changed !== null && kitAt !== undefined && kitAt > changed && (inputsChangedAt === null || kitAt > inputsChangedAt);
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

/**
 * One sweep: check the kill switch, read, select, build each selected row in turn, and
 * report every outcome. 'skipped_disabled' is its own closed outcome, never a zero summary,
 * so the caller cannot report an off switch as "nothing was due".
 */
export async function runKitSweep(input: RunKitSweepInput): Promise<SweepSummary | 'skipped_disabled'> {
  // W28: THE KILL SWITCH, before any read or page. A throw here (unreadable) ends the run red.
  if (!(await input.isSystemEnabled())) {
    // The agent_runs word, so a log search for a skipped run finds this one too.
    input.log('[apply-kit sweep] skipped_disabled: system_settings.system_enabled is false; no row read, no page opened');
    // Nothing was read, so there is nothing to count.
    return 'skipped_disabled';
  }
  // Every row that might wait on Teja.
  const rows = await input.listRows();
  // Kits are read only for the candidates, so the read stays small as history grows.
  const candidateIds = rows.filter((row) => KIT_STATUSES.includes(row.status)).map((row) => row.id);
  // No candidate, no second read.
  const kits = candidateIds.length === 0 ? [] : await input.listKits(candidateIds);
  // K1: when the kits' inputs last changed; null when there is no answer and no master yet.
  let inputsChangedAt: number | null = null;
  // Read only when some row could be due, like the kit notes.
  for (const raw of candidateIds.length === 0 ? [] : await input.listInputTimes()) {
    // Shape-checked, never a lenient parse.
    const at = readTime(raw);
    // Junk must stop the run: ignoring it leaves stale kits, and trusting it as "now" rebuilds every kit
    // on every run (a rebuilt kit is never newer than junk), which the self re-dispatch would chain forever.
    if (at === null) throw new Error(`apply kit sweep: unreadable kit inputs time ${JSON.stringify(raw)}`);
    // The newest of the two.
    if (inputsChangedAt === null || at > inputsChangedAt) inputsChangedAt = at;
  }
  // The due rows and this run's share.
  const { eligible, selected } = selectKitCandidates(rows, kits, input.cap, inputsChangedAt);
  // An empty sweep says so; a silent pass would look like a broken one.
  if (eligible.length === 0) {
    // The exact phrase a log search for "0 eligible" finds.
    input.log('[apply-kit sweep] 0 eligible: every row waiting on Teja has a current kit or a form no kit can open (robots_refused, no_apply_url)');
    // Nothing tried, nothing failed.
    return { eligible: 0, attempted: 0, remaining: 0, built: 0, skipped: [], failed: [] };
  }
  // The plan, before any page opens.
  input.log(`[apply-kit sweep] ${eligible.length} eligible, building ${selected.length} this run (cap ${input.cap})`);
  // Rows started, counted as they start, since the budget can stop the run before the batch ends.
  let attempted = 0;
  // Kits that landed.
  let built = 0;
  // Rows skipped for a reason that is the system working, recorded, in order (B2).
  const skipped: Array<{ id: string; code: KitSkip['code']; reason: string }> = [];
  // Rows that failed, with why, in order.
  const failed: Array<{ id: string; reason: string }> = [];
  // Serially: one browser, one form at a time, so a slow page cannot overlap another.
  for (const id of selected) {
    // The budget, before the row: a kit already started always finishes.
    if (input.outOfTime()) {
      // Said, so a short run is not read as a broken one.
      input.log(`[apply-kit sweep] run budget spent after ${attempted} of ${selected.length}; the rest go to the next run`);
      // No new page opens.
      break;
    }
    // Counted before the build, so a failure is still an attempt.
    attempted += 1;
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
      // B2: a refusal that is the gate working is recorded once and reported, never a failure.
      if (error instanceof KitSkip) {
        // Recorded first; an unrecorded skip would be retried every run, so a failed write IS a failure.
        try {
          // The note that takes the row out of the due set until its status changes.
          await input.recordSkip(id, error.code, reason);
          // Reported.
          skipped.push({ id, code: error.code, reason });
          // Said in the log with its code.
          input.log(`[apply-kit sweep] ${id}: SKIPPED (${error.code}): ${reason}`);
          // Next row.
          continue;
        } catch (writeError) {
          // Both causes in one reason, so the red run explains itself.
          const both = `${reason}; and the skip note was not written: ${writeError instanceof Error ? writeError.message : String(writeError)}`;
          // A failure.
          failed.push({ id, reason: both });
          // Named in the log.
          input.log(`[apply-kit sweep] ${id}: FAILED: ${both}`);
          // Next row.
          continue;
        }
      }
      // Recorded and skipped: one bad form must not starve the other rows of their kits.
      failed.push({ id, reason });
      // Named in the log, so a red run says which row and why.
      input.log(`[apply-kit sweep] ${id}: FAILED: ${reason}`);
    }
  }
  // The totals, for the run summary and the exit code.
  return { eligible: eligible.length, attempted, remaining: eligible.length - attempted, built, skipped, failed };
}

/**
 * Whether the workflow should start another sweep right away (2026-11-05: kits must keep up with the
 * queue, no fixed cap). Only when this run left due rows UNTRIED and BUILT at least one kit. Failed rows
 * stay due and sort first next time, so "tried" is not progress: 25+ rows that always fail would chain
 * runs forever. A built kit leaves the due set for good, so every chained run shrinks the backlog.
 */
export function shouldRedispatch(summary: SweepSummary | 'skipped_disabled'): boolean {
  // The kill switch is off: never.
  if (summary === 'skipped_disabled') return false;
  // Untried rows, and progress: a kit built OR a skip recorded (both leave the due set for good, B2), so
  // the chain always ends.
  return summary.remaining > 0 && summary.built + summary.skipped.length > 0;
}

/** The sweep's two reads over a supabase-js client; errors throw, since supabase-js returns them. */
export function createSweepReader(client: SupabaseLike): Pick<RunKitSweepInput, 'listRows' | 'listKits' | 'listInputTimes'> {
  // Two reads, both over the signed-in client, so RLS bounds them to Teja's rows.
  return {
    // Every row in a lane that waits on Teja.
    async listRows() {
      // The candidate lanes, with the stamp the transition trigger keeps (status_transition_guard),
      // and the two park facts W29 skips on: the enum column and the W4 cause inside block_detail.
      const result = await client.from('applications').select('id, status, status_changed_at, block_reason, unusable:block_detail->>unusable, code:block_detail->>code').in('status', [...KIT_STATUSES]);
      // A refused read must not look like "nothing to do".
      if (result.error) throw new Error(`apply kit sweep: read applications failed: ${result.error.message}`);
      // Narrowed to the sweep's shape.
      return (result.data ?? []).map((r: { id: string; status: ApplicationStatus; status_changed_at: string; block_reason: BlockReason | null; unusable: string | null; code?: string | null }) => ({
        // The row's id and lane, as before.
        id: r.id,
        status: r.status,
        statusChangedAt: r.status_changed_at,
        // Absent reads as null: "not parked for that cause", so the row is kitted as before W29.
        blockReason: r.block_reason ?? null,
        blockUnusable: r.unusable ?? null,
        // B2: the park code (posting_closed), absent reads as null.
        blockCode: r.code ?? null,
      }));
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
        // ...of these kinds, so unknown-cause notes are not mistaken for kits. A skip note (B2) counts like a
        // kit: either one newer than the status change means the row is done until it changes again.
        .in('detail->>kind', ['apply_kit', 'apply_kit_skipped'])
        // Bounded to the candidates, so the read stays small as history grows.
        .in('application_id', [...applicationIds]);
      // Same rule: an error is never "no kits" (which would re-kit everything silently).
      if (result.error) throw new Error(`apply kit sweep: read kit notes failed: ${result.error.message}`);
      // Narrowed to the sweep's shape.
      return (result.data ?? []).map((r: { application_id: string; created_at: string }) => ({ applicationId: r.application_id, createdAt: r.created_at }));
    },
    // K1: the newest answer edit and the newest master version, the two inputs every kit is planned from.
    async listInputTimes() {
      // Each table, its own time column; RLS bounds both to Teja's rows.
      const sources = [['answer_bank', 'updated_at'], ['master_profiles', 'created_at']] as const;
      // The times found, in that order.
      const times: string[] = [];
      // One small read per table: newest row only.
      for (const [table, column] of sources) {
        // Ordered newest-first so limit(1) sends one row.
        const result = await client.from(table).select(column).order(column, { ascending: false }).limit(1);
        // A refused read must not read as "never changed" (that leaves every stale kit in place).
        if (result.error) throw new Error(`apply kit sweep: read kit inputs failed: ${result.error.message}`);
        // The one row, if the table has any; an empty table adds nothing.
        const newest = (result.data as Array<Record<string, unknown>> | null)?.[0]?.[column];
        // Present: passed on as text for the caller's shape check; a non-string is reported, never dropped.
        if (newest !== undefined) times.push(typeof newest === 'string' ? newest : JSON.stringify(newest));
      }
      return times;
    },
  };
}
