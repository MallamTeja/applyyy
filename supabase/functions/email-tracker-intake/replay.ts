// THE TRACKER'S REPLAY SWEEP (W6, 2026-11-01): every run re-drives stored outcome emails
// whose status move never happened. The I/O half; the decisions are decide.ts's
// replayQueue (which emails are owed) and statusMoveFor (where each one moves), the SAME
// function the first try always used, so the replay can't drift from it.
//
// A separate module from index.ts because index.ts calls Deno.serve on import, so nothing
// in it can run under `node --test`. W6 itself was a glue bug (moves tried once, refusals
// only logged), so the glue is what replay.test.ts exercises, against a supabase-js double.

// Type only: erased under node --test, so the jsr specifier is never resolved there.
import type { SupabaseClient } from "jsr:@supabase/supabase-js@2.58.0";
// The pure decisions the sweep composes. Reused, never forked.
import {
  // Statuses whose non-tracker entry makes older emails stale.
  EMPLOYER_STAGES,
  // The kill-switch verdict every status-writing path consults.
  mayAdvanceStatus,
  // The verdicts worth reading back.
  REPLAYABLE_CLASSIFICATIONS,
  // Which stored emails are owed.
  replayQueue,
  // Where an owed email moves its row, if anywhere: the first-try rule.
  statusMoveFor,
  // The rows the tracker follows; the same list index.ts loads.
  // The match pool (tracked + match-only, 2026-11-05); moves still go through statusMoveFor, which refuses match-only rows.
  MATCH_POOL_STATUSES,
  // Which stored, unmatched emails now match a tracked row (2026-11-04).
  rematchUnmatched,
  // The matcher's application shape, for the re-match candidates.
  type ActiveApplication,
  // A fresh verdict's shape, for the evidence it carries.
  type MessageDecision,
} from "./decide.ts";
// The status enum, for the running status map.
import type { ApplicationStatus } from "../_shared/contracts/shared-types.ts";

// The newest stored outcome emails read per run. NEWEST, not oldest: rows the replay can
// never move (a low-confidence rejection, a second interview invite) stay in the candidate
// set while their row is active, and an oldest-first window would let them starve every
// newer email, the W2/W4 starvation pattern. The emails pushed out of a newest-first window
// are the oldest, which a newer settled email usually supersedes anyway.
// ponytail: one fixed page; a full page is reported as a run error, paginate if that ever fires.
export const REPLAY_WINDOW = 200;

// Ids per `.in()` filter (Review #3, 2026-11-02). Every read used to send ONE filter over
// every tracked row, and applied rows only pile up, so the request URL grew without bound.
// 100 UUIDs is about 3.7 KB of filter, well under the ~8 KB request-line limits common in
// front of PostgREST.
export const ID_CHUNK_SIZE = 100;

// Rows asked for per page of a history read: PostgREST's max_rows (supabase/config.toml).
// Until Review #3 a read that returned this many refused EVERY move, as possibly truncated.
export const HISTORY_PAGE_SIZE = 1000;

// Pages per paged read before the sweep refuses (50 000 rows per id chunk). A ceiling on
// work, so a runaway history fails closed with an error instead of reading forever.
export const MAX_HISTORY_PAGES = 50;

// One awaited page: supabase-js resolves `{ data, error }` and never throws (CLAUDE.md §5).
type Page = PromiseLike<{ data: unknown; error: { message: string } | null }>;

/**
 * Every row of one filtered read, paged until an EMPTY page. WHY NOT "until a short page":
 * a server cap below HISTORY_PAGE_SIZE would make page 1 look short, and the read would stop
 * early, the truncated-history case this sweep refuses to act on. Each page starts where the
 * rows actually received end, so a lower cap only costs requests, never rows. Offset paging is
 * safe on application_events because it is append-only (no row can shift out of a page) and
 * the caller orders by its monotonic id, so new rows land after the last page. Returns the
 * rows, or the error string that refuses the sweep.
 */
async function readAllPages(page: (from: number, to: number) => Page): Promise<Record<string, unknown>[] | string> {
  // Accumulated across pages.
  const rows: Record<string, unknown>[] = [];
  // One request per page, bounded.
  for (let pages = 0; ; pages += 1) {
    // Past the ceiling: refuse, named so the operator knows which bound fired.
    if (pages >= MAX_HISTORY_PAGES) return `read exceeded ${MAX_HISTORY_PAGES} pages of ${HISTORY_PAGE_SIZE} rows`;
    // The next page, starting after the rows already received.
    const { data, error } = await page(rows.length, rows.length + HISTORY_PAGE_SIZE - 1);
    // An unreadable page is an unreadable history.
    if (error !== null) return error.message;
    // §6: a non-array is not "no rows", it is a broken answer.
    if (!Array.isArray(data)) return "page was not an array";
    // The empty page is the only proof the read is complete.
    if (data.length === 0) return rows;
    // Collected.
    rows.push(...(data as Record<string, unknown>[]));
  }
}

/** The same paged read once per id chunk, concatenated; the first error refuses the whole read. */
async function readChunked(ids: readonly string[], page: (chunk: string[], from: number, to: number) => Page): Promise<Record<string, unknown>[] | string> {
  // Every chunk's rows.
  const rows: Record<string, unknown>[] = [];
  // Bounded filters, in order.
  for (let start = 0; start < ids.length; start += ID_CHUNK_SIZE) {
    // This chunk's ids.
    const chunk = ids.slice(start, start + ID_CHUNK_SIZE);
    // Every page of it.
    const got = await readAllPages((from, to) => page(chunk, from, to));
    // One failed chunk means the history is incomplete: refuse it all.
    if (typeof got === "string") return got;
    // Collected.
    rows.push(...got);
  }
  // Complete.
  return rows;
}

/**
 * THE RE-MATCH WRITE (2026-11-04): link stored, still-unmatched emails to the tracked row they
 * now match. The decision is decide.ts's rematchUnmatched; this is only its reads and writes.
 * Returns its errors; never throws (the caller's try covers a client that throws anyway).
 */
async function linkUnmatchedEmails(db: SupabaseClient, apps: readonly ActiveApplication[]): Promise<string[]> {
  // Each candidate's FIRST entry into approved, so an older email can't attach to a newer row.
  const approvals = await readChunked(apps.map((app) => app.id), (chunk, from, to) =>
    db
      // The append-only event log; read only.
      .from("application_events")
      // The two fields the guard reads.
      .select("application_id, created_at")
      // Written by the log_status_change trigger, one per move.
      .eq("event_type", "status_change")
      // Only entries INTO approved.
      .eq("to_status", "approved")
      // Scoped to the candidates, one chunk at a time.
      .in("application_id", chunk)
      // Stable pages on an append-only table.
      .order("id")
      // One page.
      .range(from, to)
  );
  // Unreadable history: link nothing, and say so (fail closed, §6).
  if (typeof approvals === "string") return [`rematch: approvals read failed: ${approvals}`];
  // Earliest approval per application.
  const firstApprovedAt = new Map<string, string>();
  // Shape-checked; a malformed row is skipped, and its application then simply has no candidacy.
  for (const row of approvals) {
    // Only string fields are a usable approval.
    if (typeof row.application_id !== "string" || typeof row.created_at !== "string") continue;
    // The one already kept, if any.
    const kept = firstApprovedAt.get(row.application_id);
    // Keep the earlier one.
    if (kept === undefined || Date.parse(row.created_at) < Date.parse(kept)) firstApprovedAt.set(row.application_id, row.created_at);
  }
  // The newest still-unmatched emails, with the fields the matcher reads.
  // ponytail: newest REPLAY_WINDOW only, and unmatched noise accumulates, so an email older than the
  // newest 200 unmatched is never re-matched; page this read if job mail ever falls out of the window.
  const { data, error } = await db
    // RLS scopes it to Teja's rows.
    .from("email_events")
    // Sender, subject and body are what matchApplication reads; the rest are the link and the guard.
    .select("id, matched_application_id, from_address, subject, snippet, received_at")
    // Still unmatched.
    .is("matched_application_id", null)
    // Newest first.
    .order("received_at", { ascending: false })
    // The per-run bound.
    .limit(REPLAY_WINDOW);
  // Without the emails there is nothing to link.
  if (error !== null) return [`rematch: email_events read failed: ${error.message}`];
  // §6: a non-array is a broken answer, not "no emails".
  if (!Array.isArray(data)) return ["rematch: email_events read was not an array"];
  // The pure decision.
  const links = rematchUnmatched(data as Record<string, unknown>[], apps, firstApprovedAt);
  // Collected per link.
  const errors: string[] = [];
  // One guarded write per link.
  for (const link of links) {
    // `is null` again on the write: a row matched meanwhile (by an ingest) is never re-pointed.
    // The verdict rides in the SAME write (Q3), the two columns the ingest row stores, so a link never lands
    // with a stale verdict the replay could move on, and a refused write leaves both as they were.
    const { error: linkError } = await db.from("email_events").update(link.verdict === null ? { matched_application_id: link.applicationId } : { matched_application_id: link.applicationId, classification: link.verdict.classification, classification_confidence: link.verdict.confidence }).eq("id", link.eventId).is("matched_application_id", null);
    // A refused write is a run error; the email stays unmatched and is retried next run.
    if (linkError !== null) errors.push(`rematch: link ${link.eventId} -> ${link.applicationId} failed: ${linkError.message}`);
    // Operational trace.
    else console.info(`[email-tracker-intake] re-matched email ${link.eventId} to app ${link.applicationId}`);
  }
  // Everything that went wrong.
  return errors;
}

/** What one sweep did: moves made, and every error, each of which the run row counts. */
export interface ReplayResult {
  // Moves that committed.
  readonly moved: number;
  // One line per failure; non-empty means Health shows "succeeded with N errors".
  readonly errors: string[];
}

/**
 * Re-drives every owed move once. Never throws, and a failed read refuses ALL moves (an
 * unreadable history must never become "move anyway", CLAUDE.md §6). `liveDecisions` holds
 * the in-memory verdicts for emails stored in THIS call, so their notes keep the
 * classifier's signals and reasoning, which email_events does not store.
 */
export async function replayStoredMoves(
  db: SupabaseClient,
  systemEnabled: boolean | null,
  liveDecisions: ReadonlyMap<string, MessageDecision>,
): Promise<ReplayResult> {
  // Off (false) is a deliberate pause: no reads, no moves, no error. Unreadable (null) is a
  // fault: still no move, but counted, so a broken settings read can't look like a quiet day.
  if (!mayAdvanceStatus(systemEnabled)) {
    // The pause/fault split is the only difference between the two refusals.
    return { moved: 0, errors: systemEnabled === null ? ["kill switch unreadable: no status moves this run"] : [] };
  }
  // Collected across the sweep; returned whole even after an exception.
  const errors: string[] = [];
  // Moves that committed.
  let moved = 0;
  // Exceptions (a client that throws despite its contract) are an error, never a crash.
  try {
    // Fresh statuses, read AFTER this call's receipt confirmations, so a row the receipt
    // just moved to applied is seen at applied.
    // Paged (Review #3): applied rows pile up past PostgREST's 1000-row cap, and a cut-short
    // read would silently leave rows out of the sweep. Ordered by id so the pages are stable.
    // The joined job (2026-11-04) is what the re-match below matches on, the same fields index.ts loads.
    const apps = await readAllPages((from, to) => db.from("applications").select("id, status, jobs(company_name, company_slug, title)").in("status", [...MATCH_POOL_STATUSES]).order("id").range(from, to));
    // No statuses, no decisions.
    if (typeof apps === "string") return { moved, errors: [...errors, `replay: applications read failed: ${apps}`] };
    // Shape-checked: only a string id with a tracked status becomes a candidate row.
    const statusById = new Map<string, ApplicationStatus>();
    // The same rows in the matcher's shape, only those whose joined job has a string slug and name.
    const matchable: ActiveApplication[] = [];
    // One entry per tracked row.
    for (const row of apps as { id?: unknown; status?: unknown; jobs?: { company_name?: unknown; company_slug?: unknown; title?: unknown } | null }[]) {
      // Anything else is skipped; skipped rows can't be moved.
      if (typeof row.id !== "string" || !MATCH_POOL_STATUSES.includes(row.status as ApplicationStatus)) continue;
      // A move candidate.
      statusById.set(row.id, row.status as ApplicationStatus);
      // A re-match candidate too, when its job can be matched on (§6: no slug, no match).
      if (typeof row.jobs?.company_slug === "string" && typeof row.jobs.company_name === "string") {
        // job_id is not read by the matcher, so it is not selected; the title is optional there.
        matchable.push({ id: row.id, status: row.status as ApplicationStatus, job_id: "", jobs: { company_name: row.jobs.company_name, company_slug: row.jobs.company_slug, title: typeof row.jobs.title === "string" ? row.jobs.title : null } });
      }
    }
    // Nothing tracked: nothing to replay.
    if (statusById.size === 0) return { moved, errors };
    // The ids every read below is scoped to.
    const ids = [...statusById.keys()];

    // RE-MATCH FIRST (2026-11-04), so an email linked here is read as owed just below and moves in
    // this same run. Its errors are counted but never refuse the moves: they are a separate write.
    if (matchable.length > 0) errors.push(...(await linkUnmatchedEmails(db, matchable)));

    // Stored, matched, move-capable emails of tracked rows, moved and pending alike (the
    // moved ones tell replayQueue what is already settled). Newest first; see REPLAY_WINDOW.
    // One query per id chunk (Review #3), each bounded by the window; merged below.
    const emailChunks: Record<string, unknown>[] = [];
    // Bounded filters, in order.
    for (let start = 0; start < ids.length; start += ID_CHUNK_SIZE) {
      // This chunk's newest emails.
      const { data: chunkEmails, error: emailsError } = await db
        // RLS scopes it to Teja's rows.
        .from("email_events")
        // Exactly the fields replayQueue shape-checks; no untrusted subject or body text.
        .select("id, provider_message_id, matched_application_id, classification, classification_confidence, received_at")
        // Only rows matched to an application the tracker still follows, one chunk at a time.
        .in("matched_application_id", ids.slice(start, start + ID_CHUNK_SIZE))
        // Only verdicts that can move a status (receipts, other, unclassified never replay).
        .in("classification", [...REPLAYABLE_CLASSIFICATIONS])
        // Newest first, so a cap never starves fresh mail.
        .order("received_at", { ascending: false })
        // The per-run bound; no chunk needs more than the whole window.
        .limit(REPLAY_WINDOW);
      // Without the emails there is nothing to plan from.
      if (emailsError !== null) return { moved, errors: [...errors, `replay: email_events read failed: ${emailsError.message}`] };
      // Collected; replayQueue shape-checks every row.
      emailChunks.push(...((chunkEmails ?? []) as Record<string, unknown>[]));
    }
    // The window stays GLOBAL across chunks: newest first by the ISO text PostgREST returns
    // (one fixed format, so text order is time order), then cut to REPLAY_WINDOW.
    const byNewest = emailChunks.sort((a, b) => (String(a.received_at) < String(b.received_at) ? 1 : String(a.received_at) > String(b.received_at) ? -1 : 0));
    // The emails this run plans from.
    const emails = byNewest.slice(0, REPLAY_WINDOW);

    // The tracker's own notes: the done-marker. Projected to the one field the planner reads.
    // Chunked and paged (Review #3): a done-marker past row 1000 used to refuse every move.
    const notes = await readChunked(ids, (chunk, from, to) =>
      db
        // The append-only event log; read only, never written here.
        .from("application_events")
        // PostgREST's JSON path projection: the id alone, not the whole detail blob.
        .select("provider_message_id:detail->>provider_message_id")
        // advance_application_status writes p_detail as a 'note', beside the trigger's status_change.
        .eq("event_type", "note")
        // Only the tracker's notes carry an email's message id.
        .eq("agent", "tracker")
        // Scoped to the rows this sweep could move, one chunk at a time.
        .in("application_id", chunk)
        // The monotonic bigint key: stable pages on an append-only table.
        .order("id")
        // One page.
        .range(from, to)
    );
    // Unreadable history: every email would look owed. Refuse every move (fail closed, §6).
    if (typeof notes === "string") return { moved, errors: [...errors, `replay: application_events read failed: ${notes}`] };
    // Moves by anyone into an employer stage; the planner keeps the non-tracker ones.
    const stageMoves = await readChunked(ids, (chunk, from, to) =>
      db
        // Same log.
        .from("application_events")
        // The fields the staleness rule reads; agent is null-able, and the planner handles null.
        .select("application_id, agent, to_status, created_at")
        // Written by the log_status_change trigger, one per move, with the acting agent.
        .eq("event_type", "status_change")
        // Only employer stages supersede; submit bookkeeping moves never do.
        .in("to_status", [...EMPLOYER_STAGES])
        // Scoped to the rows this sweep could move, one chunk at a time.
        .in("application_id", chunk)
        // Stable pages, as above.
        .order("id")
        // One page.
        .range(from, to)
    );
    // Unreadable history: a human move could make an email stale. Refuse every move.
    if (typeof stageMoves === "string") return { moved, errors: [...errors, `replay: application_events read failed: ${stageMoves}`] };
    // A full window is not a refusal (the newest emails are all in it), but it is reported.
    if (emailChunks.length >= REPLAY_WINDOW) errors.push(`replay: window full (${REPLAY_WINDOW} newest stored outcome emails); older ones were not considered`);

    // The owed emails, oldest first.
    const queue = replayQueue({ emails, trackerNotes: notes, stageMoves });
    // One move attempt per owed email.
    for (const email of queue) {
      // Where the row is now, as far as this sweep knows.
      const current = statusById.get(email.applicationId);
      // Not tracked any more: leave it.
      if (current === undefined) continue;
      // The first-try rule, unchanged: a target exists, the graph lets the tracker walk the
      // edge, AND the confidence gate passes. A low-confidence verdict, a duplicate invite,
      // or a row still in needs_verification all return null here and simply wait.
      const target = statusMoveFor(email, current);
      // Nothing owed at this status.
      if (target === null) continue;
      // Fresh emails keep the classifier evidence the first-try note always carried.
      const live = liveDecisions.get(email.messageId);
      // The only correct way to change status.
      const { error: moveError } = await db.rpc("advance_application_status", {
        // Application UUID.
        p_application_id: email.applicationId,
        // Destination status.
        p_to_status: target,
        // Acting agent; the guard checks the edge allows it.
        p_agent: "tracker",
        // Becomes the note that marks this email done, in the move's own transaction.
        p_detail: {
          // The done-marker key: which email caused it.
          provider_message_id: email.messageId,
          // How it was read.
          classification: email.classification,
          // With what confidence.
          confidence: email.confidence,
          // The stored row, for a human audit.
          email_event_id: email.eventId,
          // When the employer sent it.
          received_at: email.receivedAt,
          // On which signals, and in words, when this call decided it.
          ...(live === undefined ? {} : { matched_signals: live.matchedSignals, reasoning: live.reasoning }),
        },
      });
      // A refusal is a run error now, not just a log line: it stays owed and is retried
      // next run, and Health stops showing green meanwhile.
      if (moveError !== null) {
        // Detail to the log.
        console.error(`[email-tracker-intake] replay move failed for app ${email.applicationId}: ${moveError.message}`);
        // And to the run row.
        errors.push(`advance ${email.applicationId} ${current}->${target} failed: ${moveError.message}`);
      } else {
        // Later emails for the same row see the new status.
        statusById.set(email.applicationId, target);
        // Counted.
        moved += 1;
        // Operational trace.
        console.info(`[email-tracker-intake] advanced app ${email.applicationId} from ${current} to ${target}`);
      }
    }
  } catch (err) {
    // Same handling as an error result.
    errors.push(`replay exception: ${String(err)}`);
  }
  // Everything that happened.
  return { moved, errors };
}
