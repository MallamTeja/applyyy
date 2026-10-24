/* RecoveryQueue - the rows stuck in one recovery status, with a working button per human move (2026-10-09).
 *
 * WHY IT REPLACES THE OLD TABLES: the four System health panels listed EDGES (applying -> X) with a
 * hard-coded `disabled` button, so the operator could see what was possible but not which rows were
 * stuck, and could move none of them. This lists the ROWS, and each button performs one move through
 * advanceRecovery (the only write path; see that file for the PT409 stamp and the lost-answer rules).
 *
 * RULES THIS COMPONENT OWNS (the engine owns the rest):
 *  - window.confirm names the row and the move before anything is written.
 *  - A row is locked from the click until its outcome is known, so a double click cannot send two
 *    moves. After an UNKNOWN outcome it stays locked until reload: retrying could double-apply.
 *  - After every move the queue is re-read, so what is on screen is what is stored.
 *  - A held edge (humanLanes.ts HELD_HUMAN_EDGES) renders disabled WITH its reason, never hidden:
 *    a missing button reads as "not possible", a disabled one with a reason reads as "deliberately off".
 *    The engine refuses it too, so the disabled attribute is not the only thing in the way.
 *  - A row at `applying` whose worker lease has not expired cannot be moved from here: the operator
 *    cannot see whether a live worker is mid-submit, and the stamp guard does not catch a live lease.
 *  - A capped read says it is capped: a list that silently stops at the limit looks complete.
 *  - Every row shows WHY it is waiting and its apply link (2026-10-24), because the two manual-action
 *    queues are where the operator finishes a captcha-blocked submit or checks an unconfirmed one by
 *    hand. The link goes through safeHref: apply_url is UNTRUSTED board data, and a javascript: URL
 *    must never become a clickable href.
 *  - A row the Gmail tracker matched to an "application received" email shows that receipt (2026-10-24),
 *    because it is the evidence for "I applied": the email page lists interview mail only, so this was
 *    the receipt's only possible screen. No match shows nothing; a malformed email row is dropped.
 */

// Hooks for the read, the per-row locks, the outcome notes and the stale-read guard.
import { useCallback, useEffect, useRef, useState } from 'react';
// The component's return type, as elsewhere on this page.
import type { ReactElement } from 'react';
// The page's shared client; null when the build has no Supabase config.
import { supabase } from '../../data/supabase';
// The graph: which moves a human may make out of a status.
import { nextStatuses } from '../../data/contract';
// The status union, so the props cannot name a status that does not exist.
import type { ApplicationStatus } from '../../data/contract';
// Which edges are deliberately off, and why.
import { heldReason } from '../../data/humanLanes';
// The write path, its outcome sentences and its confirm text.
import { advanceRecovery, confirmText, describeRecovery } from './advanceRecovery';
// The structural client type the engine takes, and the outcome kinds the strip colours by.
import type { RecoveryClient, RecoveryOutcome } from './advanceRecovery';
// The one gate between untrusted board URLs and an href: only http(s) passes, everything else is undefined.
import { safeHref } from '../../app/safeHref';

/* How many rows one queue shows. One more is fetched, so "there are more" is a fact, not a guess. */
const QUEUE_LIMIT = 50;

/* The queue's one read. email_events embeds through its only FK to applications
   (matched_application_id), so the receipts arrive with the rows: no second round trip, and RLS
   ("own email events") limits them to this user's mail. Exported so a test pins the embed. */
export const RECOVERY_SELECT = 'id, updated_at, claim_expires_at, block_reason, failure_reason, jobs:job_id(title, company_name, apply_url), email_events(subject, received_at, classification)';

// The start of an ISO timestamp as PostgREST writes timestamptz. Date.parse alone would read '-5' as year -5.
const ISO_STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

/* One stuck row, as much as the operator needs to recognise it and as the move needs to send it. */
interface QueueRow {
  // The row's id, also the lock key.
  readonly id: string;
  // updated_at exactly as returned: the move's stale-stamp guard (never parsed into a Date).
  readonly stamp: string;
  // "Title at Company", or the short id when the job join is empty.
  readonly label: string;
  // The worker lease's expiry exactly as returned, or null when there is no lease.
  readonly leaseUntil: string | null;
  // The posting's apply URL after safeHref; undefined when absent or not a safe http(s) URL.
  readonly applyHref: string | undefined;
  // Why the row is waiting, in one sentence (queueReason).
  readonly reason: string;
  // The newest matched "application received" email as "YYYY-MM-DD HH:MM UTC — subject", or null.
  // UTC is fixed so the screen and the tests agree; the subject is rendered as text, so React escapes it.
  readonly receipt: string | null;
}

/* The read's three honest states: an empty list is only ever shown after a SUCCESSFUL read. */
type QueueRead =
  // First load, nothing known.
  | { readonly kind: 'loading' }
  // The read failed; its reason is shown instead of an empty "nothing stuck" lie.
  | { readonly kind: 'error'; readonly message: string }
  // The read succeeded; zero rows really means zero, and `more` says whether the cap cut the list.
  | { readonly kind: 'rows'; readonly rows: readonly QueueRow[]; readonly more: boolean };

/* One outcome line in the queue's results strip. Kept after the row leaves the list, which a
   successful move always causes, so the operator can still read what happened. */
interface OutcomeNote {
  // Unique per click, so two moves on the same row are two lines.
  readonly key: number;
  // Which row, in words.
  readonly label: string;
  // describeRecovery's sentence.
  readonly text: string;
  // Drives the colour: only 'moved' is good news.
  readonly kind: RecoveryOutcome['kind'];
}

/* The JD join can come back as an object, an array (a to-many shape) or null; this reads all three.
   Exported so the Manual apply page names a row exactly as this queue and its confirm dialog do. */
export function rowLabel(id: string, jobs: unknown): string {
  // A to-many join shape still carries one job here; take the first.
  const job = (Array.isArray(jobs) ? jobs[0] : jobs) as { title?: unknown; company_name?: unknown } | null | undefined;
  // Only a real string counts; '{}' or a number must not become a label.
  const title = typeof job?.title === 'string' && job.title.trim() !== '' ? job.title : null;
  // Same rule for the company.
  const company = typeof job?.company_name === 'string' && job.company_name.trim() !== '' ? job.company_name : null;
  // Both: the natural sentence.
  if (title !== null && company !== null) return `${title} at ${company}`;
  // One of them, or the id prefix so the operator can still tell rows apart.
  return title ?? company ?? `application ${id.slice(0, 8)}`;
}

/* The job's apply URL through safeHref, from the same loose join shape rowLabel reads. */
function rowApplyHref(jobs: unknown): string | undefined {
  // Same to-many tolerance as rowLabel.
  const job = (Array.isArray(jobs) ? jobs[0] : jobs) as { apply_url?: unknown } | null | undefined;
  // Only a string can be a URL; safeHref then refuses anything that is not http(s).
  return typeof job?.apply_url === 'string' ? safeHref(job.apply_url) : undefined;
}

/* Why a row sits in this queue, in the operator's words. A missing reason is SAID, never left blank:
   an empty cell would read as "nothing wrong". */
function queueReason(status: ApplicationStatus, blockReason: unknown, failureReason: unknown): string {
  // The sweeper's lane: the worker reached the submit and nobody knows whether it landed (constraint 7).
  if (status === 'needs_verification') return 'Submit outcome unknown: the worker may already have submitted. Check the posting or your inbox before choosing; never resubmit blind.';
  // The worker stopped and handed over; block_reason is the enum value (captcha, mfa, ...).
  if (status === 'blocked_needs_human') return typeof blockReason === 'string' && blockReason !== '' ? `Blocked: ${blockReason.replace(/_/g, ' ')}` : 'Blocked: reason not recorded';
  // A failed row carries its failure_reason when the agent wrote one.
  if (status === 'failed') return typeof failureReason === 'string' && failureReason.trim() !== '' ? `Failed: ${failureReason}` : 'Failed: reason not recorded';
  // A row at applying is mid-submit, or its worker died before the sweeper ran.
  if (status === 'applying') return 'Submit in progress, or the worker died mid-submit.';
  // Any other status this component is pointed at: name it rather than invent a reason.
  return `At ${status}`;
}

/* The newest valid application_received email among a row's embedded email_events, or null. Each
   email proves its shape: a missing subject or date is dropped, never printed as "undefined". */
function newestReceipt(emails: unknown): string | null {
  // A to-many embed is an array; anything else (absent, null, an object) carries no receipt.
  if (!Array.isArray(emails)) return null;
  // The best so far, with its instant for the comparison.
  let best: { at: number; receipt: string } | null = null;
  // Each embedded email, proven field by field.
  for (const raw of emails) {
    // Loose read, then checks.
    const e = raw as { subject?: unknown; received_at?: unknown; classification?: unknown } | null;
    // Only the receipt kind; interview or rejection mail matched to the row is another screen's job.
    if (e?.classification !== 'application_received') continue;
    // A real, non-blank subject, or the sentence would have nothing to say.
    if (typeof e.subject !== 'string' || e.subject.trim() === '') continue;
    // The ISO shape first, then the parse: a lenient parse alone accepts '-5'.
    if (typeof e.received_at !== 'string' || !ISO_STAMP.test(e.received_at)) continue;
    // The instant, for "newest" and for the UTC rendering.
    const at = Date.parse(e.received_at);
    // An impossible date (month 13) passes the regex but not the parse.
    if (!Number.isFinite(at)) continue;
    // Newest wins, whatever order PostgREST returned the embed in.
    if (best === null || at > best.at) best = { at, receipt: `${new Date(at).toISOString().slice(0, 16).replace('T', ' ')} UTC — ${e.subject.trim()}` };
  }
  // Just the receipt.
  return best?.receipt ?? null;
}

/* One raw row of the queue's select, validated into a QueueRow, or null when it cannot be moved
   safely. Exported so a test parses exactly what the read parses. */
export function parseQueueRow(status: ApplicationStatus, raw: unknown): QueueRow | null {
  // Anything but an object has no fields to read.
  if (typeof raw !== 'object' || raw === null) return null;
  // Read loosely, then each field is proven below.
  const r = raw as { id?: unknown; updated_at?: unknown; claim_expires_at?: unknown; block_reason?: unknown; failure_reason?: unknown; jobs?: unknown; email_events?: unknown };
  // Both are required for a guarded move; a row missing either is skipped, not guessed.
  if (typeof r.id !== 'string' || typeof r.updated_at !== 'string') return null;
  // A lease is a string or absent; anything else counts as no lease.
  const leaseUntil = typeof r.claim_expires_at === 'string' ? r.claim_expires_at : null;
  // Shaped for the table; a bad email only loses the receipt, never the row.
  return { id: r.id, stamp: r.updated_at, label: rowLabel(r.id, r.jobs), leaseUntil, applyHref: rowApplyHref(r.jobs), reason: queueReason(status, r.block_reason, r.failure_reason), receipt: newestReceipt(r.email_events) };
}

/* The cause of an unknown submit, as the worker records it (claim-loop.ts, 2026-10-24): one 'note'
   in application_events per unknown outcome, detail {kind:'submit_outcome_unknown', detail, run_id}.
   Read by application_id, an exact join, so a row only ever shows ITS OWN cause. Returns the newest
   valid cause per application; malformed events are skipped, never guessed into a sentence. */
export function newestUnknownCauses(events: unknown): ReadonlyMap<string, string> {
  // Newest cause and its timestamp per application, while scanning.
  const best = new Map<string, { at: number; cause: string }>();
  // Not a list: no causes, rather than a crash on the health page.
  if (!Array.isArray(events)) return new Map();
  // Each event proven field by field.
  for (const raw of events) {
    // Loose read, then checks.
    const e = raw as { application_id?: unknown; created_at?: unknown; detail?: unknown } | null;
    // The join key must be a real string.
    if (typeof e?.application_id !== 'string') continue;
    // A timestamp is needed to pick the newest; an unparseable one cannot win.
    const at = typeof e.created_at === 'string' ? Date.parse(e.created_at) : Number.NaN;
    // Skipped rather than treated as oldest or newest.
    if (!Number.isFinite(at)) continue;
    // The payload, loosely.
    const d = e.detail as { kind?: unknown; detail?: unknown } | null | undefined;
    // Only this note kind, with a non-empty cause string.
    if (d?.kind !== 'submit_outcome_unknown' || typeof d.detail !== 'string' || d.detail.trim() === '') continue;
    // The current best for this application, if any.
    const prev = best.get(e.application_id);
    // Newest wins, whatever order the server returned.
    if (prev === undefined || at > prev.at) best.set(e.application_id, { at, cause: d.detail });
  }
  // Just the causes.
  return new Map([...best].map(([id, v]) => [id, v.cause]));
}

/* The needs_verification rows with their recorded cause folded into the reason line. A row with no
   cause keeps the generic sentence; `causeReadError` (the events read failed) is SAID on every row,
   so "no cause shown" is never mistaken for "no cause recorded". */
export function withUnknownCauses(rows: readonly QueueRow[], causes: ReadonlyMap<string, string>, causeReadError: string | null): QueueRow[] {
  // One pass; each row looks up only its own id.
  return rows.map((row) => {
    // This row's cause, by exact id.
    const cause = causes.get(row.id);
    // Found: the cause first, then the same instruction the generic line gives.
    if (cause !== undefined) return { ...row, reason: `Submit outcome unknown: ${cause}. Check the posting or your inbox before choosing; never resubmit blind.` };
    // The read failed: say so, keeping the generic line.
    if (causeReadError !== null) return { ...row, reason: `${row.reason} (The recorded cause could not be read: ${causeReadError})` };
    // No note for this row (e.g. swept before notes existed): the generic line stands.
    return row;
  });
}

/* Button text for the two manual-action queues (needs_verification, blocked_needs_human): the words
   the operator thinks in, not the status names. Exported so the page and the test share one wording. */
export function manualActionVerb(to: ApplicationStatus): string {
  // The resolve after finishing the application by hand, or confirming the worker's submit landed.
  if (to === 'applied') return 'I applied (mark applied)';
  // The give-up resolve.
  if (to === 'failed') return 'Failed / skip';
  // blocked_needs_human's third edge: not worth finishing.
  if (to === 'dropped_filter') return 'Drop (not worth finishing)';
  // Any other edge (needs_verification -> approved, held) keeps the plain form.
  return `Mark as ${to}`;
}

/* The one-line meaning under each manual-action button. */
export function manualActionMeaning(to: ApplicationStatus): string | null {
  // Says when "applied" is true, so it is never clicked on hope.
  if (to === 'applied') return 'You submitted it yourself, or checked the portal or your inbox and it went through.';
  // The terminal give-up.
  if (to === 'failed') return 'It did not go through and you are not finishing it.';
  // The blocked queue's abandon edge, in the words that queue already used.
  if (to === 'dropped_filter') return 'Abandoned: disqualified or unwanted portal requirements.';
  // The held edge shows its own reason instead.
  return null;
}

/* Why a row cannot be moved right now beyond the edge itself, or null. Only `applying` has a lease. */
function leaseBlock(status: ApplicationStatus, row: QueueRow, now: number): string | null {
  // Every other status has no live worker on it.
  if (status !== 'applying' || row.leaseUntil === null) return null;
  // Parsed only to compare with the clock; an unparseable stamp is treated as live (fail closed).
  const until = Date.parse(row.leaseUntil);
  // Expired: the worker is gone, which is exactly when this move is meant to be made.
  if (Number.isFinite(until) && until <= now) return null;
  // Live (or unreadable): a worker may be mid-submit, so the operator must wait.
  return `Worker lease live until ${row.leaseUntil}: wait for it to expire before moving this row.`;
}

export function RecoveryQueue(props: {
  // The status whose rows this queue lists.
  readonly status: ApplicationStatus;
  // The button text for a move, e.g. "Resolve as applied".
  readonly verb: (to: ApplicationStatus) => string;
  // Optional one-line meaning per move, shown beside the button (the blocked queue uses it).
  readonly meaning?: (to: ApplicationStatus) => string | null;
}): ReactElement {
  // Destructured once so the hooks below depend on the status, not the props object.
  const { status, verb, meaning } = props;
  // The moves out of this status a human may make, straight from the graph.
  const moves = nextStatuses(status, 'human');
  // The current read.
  const [read, setRead] = useState<QueueRead>({ kind: 'loading' });
  // Rows with a move in flight: every button on them renders disabled.
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  // Rows whose last move ended unknown: locked until reload, because a retry could double-apply.
  const [frozen, setFrozen] = useState<ReadonlySet<string>>(new Set());
  // The results strip, newest first.
  const [notes, setNotes] = useState<readonly OutcomeNote[]>([]);
  // Request sequence: only the newest read may land, so a slow early read cannot overwrite a fresh one.
  const readSeq = useRef(0);
  // Note keys, unique for the page's lifetime.
  const noteSeq = useRef(0);
  /* The REAL locks. `busy` / `frozen` state only drive rendering; a state read inside the click
     handler is the value from the last render, so two clicks in one tick would both see "free".
     Refs are read and written synchronously, so the second click sees the first one's claim. */
  const inflight = useRef(new Set<string>());
  // Same reasoning for rows frozen after an unknown outcome.
  const frozenRef = useRef(new Set<string>());

  // One read of this status's rows, oldest first (the longest-stuck row is the most urgent).
  const load = useCallback(async () => {
    // Claimed before the await, so a later call supersedes this one.
    const seq = ++readSeq.current;
    // Applies a result only if no newer read has started; used by every exit, the failure ones too.
    const apply = (next: QueueRead): void => {
      // A newer read owns the screen now.
      if (seq === readSeq.current) setRead(next);
    };
    // No client: say why instead of showing an empty queue.
    if (supabase === null) return apply({ kind: 'error', message: 'Not connected to the database.' });
    try {
      // supabase-js returns {data, error}; it does not throw on a refusal (the catch is for a broken client).
      const { data, error } = await supabase
        // The rows themselves, under RLS (only this user's).
        .from('applications')
        // What the table and the move need: the lease, the reasons, the apply URL and any receipt.
        .select(RECOVERY_SELECT)
        // This queue's status only.
        .eq('status', status)
        // Longest-stuck first.
        .order('updated_at', { ascending: true })
        // One past the cap, so a cut list is detected rather than assumed complete.
        .limit(QUEUE_LIMIT + 1);
      // The read failed: show the reason, never an empty list.
      if (error) return apply({ kind: 'error', message: error.message || 'The queue could not be read.' });
      // Validate the shape row by row: a row without a string id or stamp cannot be moved safely.
      const rows: QueueRow[] = [];
      // data is typed loosely by the select string, so each field is checked rather than trusted.
      for (const raw of (data ?? []) as readonly unknown[]) {
        // The same parse the test pins; null means the row cannot be moved safely.
        const row = parseQueueRow(status, raw);
        // Skipped, not guessed.
        if (row !== null) rows.push(row);
      }
      // Counted on the raw answer, before validation, so a skipped row cannot hide the overflow.
      const more = (data ?? []).length > QUEUE_LIMIT;
      // The validated list, trimmed to the cap.
      const shown = rows.slice(0, QUEUE_LIMIT);
      // Only the unknown-outcome lane has recorded causes, and only when it has rows to explain.
      if (status !== 'needs_verification' || shown.length === 0) return apply({ kind: 'rows', rows: shown, more });
      // The worker's notes for exactly these rows: an IN list of their ids, never a text search.
      const notes = await supabase
        // The append-only log, under RLS ("read own events").
        .from('application_events')
        // The join key, the timestamp that picks the newest, and the payload.
        .select('application_id, created_at, detail')
        // Exactly the rows on screen.
        .in('application_id', shown.map((r) => r.id))
        // Notes only; status changes and claims carry no cause.
        .eq('event_type', 'note')
        // This note kind only (a JSON path filter, evaluated by PostgREST).
        .eq('detail->>kind', 'submit_outcome_unknown')
        // Newest first, so the cap below keeps the useful end.
        .order('created_at', { ascending: false })
        // A few notes per row at most; the cap only bounds a pathological log.
        .limit(QUEUE_LIMIT * 4);
      // A failed cause read must not hide the rows: they show, each saying the cause could not be read.
      apply({ kind: 'rows', rows: withUnknownCauses(shown, notes.error ? new Map() : newestUnknownCauses(notes.data), notes.error ? notes.error.message || 'unknown error' : null), more });
    } catch {
      // A throwing client is a failed read, shown as one, and still only if this read is the newest.
      apply({ kind: 'error', message: 'The queue could not be read.' });
    }
  }, [status]);

  // First read on mount, and again if the status prop ever changes; load never throws.
  useEffect(() => {
    // Fire and forget: every failure is already a visible error state inside load.
    void load();
  }, [load]);

  // One click on one move: confirm, lock, write, record, unlock, re-read.
  async function move(row: QueueRow, to: ApplicationStatus): Promise<void> {
    // A second click while the first is in flight, or after an unknown outcome, does nothing.
    if (inflight.current.has(row.id) || frozenRef.current.has(row.id)) return;
    // Named row, named move, and the consequence, before anything is written.
    if (!window.confirm(confirmText(row.label, { from: status, to }))) return;
    // Claimed synchronously, after the (blocking) confirm and before the first await.
    inflight.current.add(row.id);
    // Mirrored into state so the buttons render disabled.
    setBusy((prev) => new Set(prev).add(row.id));
    // The only write; never throws. No client is reported as a refusal rather than skipped silently.
    const outcome: RecoveryOutcome =
      supabase === null
        ? { kind: 'refused', code: '', message: 'not connected to the database.' }
        : await advanceRecovery(supabase as unknown as RecoveryClient, { applicationId: row.id, from: status, to, stamp: row.stamp });
    // The sentence for this outcome, said once and stored.
    const text = describeRecovery(outcome, { from: status, to });
    // Newest first in the strip, capped so a long session does not grow it forever.
    setNotes((prev) => [{ key: ++noteSeq.current, label: row.label, text, kind: outcome.kind }, ...prev].slice(0, 10));
    // An unknown outcome keeps the row locked until reload (see the header).
    if (outcome.kind === 'unconfirmed' || outcome.kind === 'unknown') {
      // The real lock, read by the next click.
      frozenRef.current.add(row.id);
      // Its rendered mirror.
      setFrozen((prev) => new Set(prev).add(row.id));
    }
    // The in-flight lock is released on every path (advanceRecovery never throws).
    inflight.current.delete(row.id);
    // And its rendered mirror.
    setBusy((prev) => {
      // Copied so React sees a new set.
      const next = new Set(prev);
      // This row's move is over.
      next.delete(row.id);
      // The remaining in-flight rows.
      return next;
    });
    // What is stored now, so the list matches the database (a moved row leaves it).
    await load();
  }

  // Read once per render, so every lease on screen is judged against the same instant.
  const now = Date.now();

  return (
    <>
      {/* The results strip. ALWAYS mounted: a live region inserted together with its first line is
          often not announced, so the first outcome would go unheard. Empty, it renders nothing visible. */}
      <ul className="recovery__notes" aria-live="polite">
        {/* One line per click, newest first; keyed by the click, not the row, so repeats stay separate. */}
        {notes.map((note) => (
          /* Green only for a landed move: every other outcome needs the operator's eyes. */
          <li key={note.key} className={note.kind === 'moved' ? 'recovery__note recovery__note--ok' : 'recovery__note recovery__note--warn'}>
            {/* Which row first, then what happened to it. */}
            <strong>{note.label}:</strong> {note.text}
          </li>
        ))}
      </ul>
      {/* Three honest states; an empty list only after a successful read. */}
      {read.kind === 'loading' ? (
        /* Before the first answer: neither "nothing stuck" nor an error is known yet. */
        <p className="panel__note">Reading rows at <span className="identifier">{status}</span>…</p>
      ) : read.kind === 'error' ? (
        /* role=alert: a queue that cannot be read is exactly when stuck rows would go unseen. */
        <p className="panel__note" role="alert">Could not read rows at <span className="identifier">{status}</span>: {read.message}</p>
      ) : read.rows.length === 0 ? (
        /* Only reachable after a successful read, so this "none" is a measured fact. */
        <p className="panel__clear">No rows at <span className="identifier">{status}</span> right now.</p>
      ) : (
        /* A fragment: the cap notice and the table are siblings under one branch. */
        <>
          {/* Said whenever the cap cut the list, so the operator never takes 50 for all of them. */}
          {read.more ? (
            /* role=status: announced politely, since it qualifies the list rather than reporting a failure. */
            <p className="panel__note" role="status">
              Showing the {QUEUE_LIMIT} longest-stuck rows; more are waiting at <span className="identifier">{status}</span>.
            </p>
          ) : null}
          {/* The page's shared wrapper, kept so desktop tables on this page all scroll the same way. */}
          <div className="table-wrap">
            {/* recovery__table stacks each row's cells on a phone, so the move buttons sit under the
                label instead of starting off-screen inside a sideways scroll (render check, 390px). */}
            <table className="table recovery__table">
              {/* Headings for the desktop grid; hidden by the phone rule, where the stack needs none. */}
              <thead>
                {/* The single heading row. */}
                <tr>
                  {/* Two columns, not three: a separate stamp column pushed the buttons off a 390px screen. */}
                  <th scope="col">Application</th>
                  <th scope="col">Recovery moves</th>
                </tr>
              </thead>
              {/* One row per stuck application, oldest first, as read. */}
              <tbody>
                {read.rows.map((row) => (
                  /* Keyed by the row's id: the lock, the note and the stamp all follow the same row. */
                  <RecoveryRowView
                    key={row.id}
                    /* The queue's status: the held-edge lookup needs it. */
                    status={status}
                    /* The validated row. */
                    row={row}
                    /* The graph's human moves out of this status. */
                    moves={moves}
                    /* The page's button wording. */
                    verb={verb}
                    /* The optional meaning line per move. */
                    meaning={meaning}
                    /* In flight, or frozen after an unknown outcome: every move on this row is off. */
                    locked={busy.has(row.id) || frozen.has(row.id)}
                    /* Frozen alone, for its own explanation line. */
                    frozen={frozen.has(row.id)}
                    /* A live worker lease blocks every move on an applying row. */
                    lease={leaseBlock(status, row, now)}
                    /* The write, through the confirm and the locks in move(). */
                    onMove={(to) => void move(row, to)}
                  />
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </>
  );
}

/* One queue row, as drawn. Pure: everything it shows arrives as props, so a static render in a test
   draws exactly what the operator sees (no fetch, no effect). RecoveryQueue owns the state and locks. */
export function RecoveryRowView(props: {
  // The queue's status, for the held-edge lookup.
  readonly status: ApplicationStatus;
  // The validated row.
  readonly row: QueueRow;
  // The human moves out of this status, from the graph.
  readonly moves: readonly ApplicationStatus[];
  // Button text per move.
  readonly verb: (to: ApplicationStatus) => string;
  // Optional meaning line per move.
  readonly meaning?: ((to: ApplicationStatus) => string | null) | undefined;
  // True while a move is in flight or after an unknown outcome.
  readonly locked: boolean;
  // True after an unknown outcome only.
  readonly frozen: boolean;
  // The live-lease sentence, or null.
  readonly lease: string | null;
  // Called with the target status when a move's button is clicked.
  readonly onMove: (to: ApplicationStatus) => void;
}): ReactElement {
  // Destructured once for readability below.
  const { status, row, moves, verb, meaning, locked, frozen, lease, onMove } = props;
  return (
    /* One table row per application. */
    <tr>
      {/* The row in words; the id stays available in the title for anyone who copies it. */}
      <th scope="row" className="table__id recovery__label" title={row.id}>
        {/* The same label the confirm dialog and the outcome note use, so all three match. */}
        {row.label}
        {/* Why it is waiting, before anything else, so the operator knows what to check. */}
        <span className="recovery__reason">{row.reason}</span>
        {/* The tracker's evidence that the application landed, when an email matched; nothing otherwise. */}
        {row.receipt !== null ? (
          /* Same line style as the reason it qualifies; role=note so it reads as supporting evidence. */
          <span className="recovery__reason" role="note">
            {/* Date first (it answers "when"), then the subject (it answers "which email"). */}
            Receipt received {row.receipt}
          </span>
        ) : null}
        {/* The posting itself, to finish or check the application by hand; safeHref already vetted it. */}
        {row.applyHref !== undefined ? (
          /* New tab so the queue stays open; noopener noreferrer so the employer page gets no handle back. */
          <a className="recovery__apply" href={row.applyHref} target="_blank" rel="noopener noreferrer">
            {/* The action, in words. */}
            Open the application page
          </a>
        ) : (
          /* Said, not hidden: a row with no safe link must be found another way. */
          <span className="recovery__held">Apply link unavailable (missing, or not a safe http(s) URL).</span>
        )}
        {/* The raw stamp, under the label: the same string the move's guard compares. */}
        <span className="recovery__stamp identifier">changed {row.stamp}</span>
      </th>
      {/* The moves cell: one line per human edge out of this status. */}
      <td>
        {/* Stacked so a held move's reason sits under its own button. */}
        <div className="recovery__moves">
          {/* Built from the graph, so a new human edge appears here with no edit. */}
          {moves.map((to) => {
            // Deliberately off edges show their reason instead of firing.
            const held = heldReason(status, to);
            // The optional meaning line for this move.
            const why = meaning?.(to) ?? null;
            // One id per row and move, so the button can point at its own explanation.
            const noteId = `recovery-${row.id}-${to}`;
            // Whichever explanation applies, held first (it is permanent), then the lease.
            const blocker = held ?? lease;
            return (
              /* Keyed by target: a status has at most one edge to each target. */
              <div key={to} className="recovery__move">
                <button
                  /* type=button: never a form submit, whatever this is nested in later. */
                  type="button"
                  /* The page's existing recovery-button look, so the four queues match. */
                  className="health-recovery-button"
                  /* Off when held, while a lease is live, or while the row is locked. */
                  disabled={blocker !== null || locked}
                  /* A specific accessible name: every row has the same verbs, so the row is named too. */
                  aria-label={`${verb(to)}: ${row.label}`}
                  /* Ties the reason to the button, for screen readers that reach a disabled control. */
                  aria-describedby={blocker !== null || why !== null ? noteId : undefined}
                  /* The write, through the queue's confirm and locks. */
                  onClick={() => onMove(to)}
                >
                  {/* The visible verb; the row name is in aria-label, where the eye does not need it. */}
                  {verb(to)}
                </button>
                {/* Why it is off (HELD_HUMAN_EDGES' own words, or the lease), else what it means. */}
                {blocker !== null ? (
                  /* The reason the button is off; its id is what aria-describedby points at. */
                  <span id={noteId} className="recovery__held">{blocker}</span>
                ) : why !== null ? (
                  /* Otherwise the move's meaning, under the same id for the same reason. */
                  <span id={noteId} className="recovery__why">{why}</span>
                ) : null}
              </div>
            );
          })}
          {/* Said once per frozen row, so its disabled buttons are explained. */}
          {frozen ? <span className="recovery__held">Outcome unknown: reload before moving this row again.</span> : null}
        </div>
      </td>
    </tr>
  );
}
