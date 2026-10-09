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

/* How many rows one queue shows. One more is fetched, so "there are more" is a fact, not a guess. */
const QUEUE_LIMIT = 50;

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

/* The JD join can come back as an object, an array (a to-many shape) or null; this reads all three. */
function rowLabel(id: string, jobs: unknown): string {
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
        // Exactly what the table and the move need, plus the lease for the applying queue.
        .select('id, updated_at, claim_expires_at, jobs:job_id(title, company_name)')
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
      for (const raw of (data ?? []) as ReadonlyArray<{ id?: unknown; updated_at?: unknown; claim_expires_at?: unknown; jobs?: unknown }>) {
        // Both are required for a guarded move; a row missing either is skipped, not guessed.
        if (typeof raw.id !== 'string' || typeof raw.updated_at !== 'string') continue;
        // A lease is a string or absent; anything else is treated as no lease only when it is null.
        const leaseUntil = typeof raw.claim_expires_at === 'string' ? raw.claim_expires_at : null;
        // Shaped for the table.
        rows.push({ id: raw.id, stamp: raw.updated_at, label: rowLabel(raw.id, raw.jobs), leaseUntil });
      }
      // Counted on the raw answer, before validation, so a skipped row cannot hide the overflow.
      const more = (data ?? []).length > QUEUE_LIMIT;
      // The validated list, trimmed to the cap.
      apply({ kind: 'rows', rows: rows.slice(0, QUEUE_LIMIT), more });
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
                {read.rows.map((row) => {
                  // In flight, or frozen after an unknown outcome: every move on this row is off.
                  const locked = busy.has(row.id) || frozen.has(row.id);
                  // A live worker lease blocks every move on an applying row.
                  const lease = leaseBlock(status, row, now);
                  return (
                    /* Keyed by the row's id: the lock, the note and the stamp all follow the same row. */
                    <tr key={row.id}>
                      {/* The row in words; the id stays available in the title for anyone who copies it. */}
                      <th scope="row" className="table__id recovery__label" title={row.id}>
                        {/* The same label the confirm dialog and the outcome note use, so all three match. */}
                        {row.label}
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
                                  /* The write, through the confirm and the locks above. */
                                  onClick={() => void move(row, to)}
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
                          {frozen.has(row.id) ? <span className="recovery__held">Outcome unknown: reload before moving this row again.</span> : null}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </>
  );
}
