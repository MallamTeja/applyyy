/* THE AI CHAT on the review page (2026-10-31; a chat with memory since 2026-11-01).
 *
 * The operator types what to change; the AI replies (answering any question) and the SERVER makes the edits.
 * Since S9i P2 (Teja 2026-11-21 15:34: "every edit he prompts in the resume chat is applied and done … NO Apply
 * button") each ask goes out withServerApply: resume-assist applies the answer through the shared edit engine,
 * writes the row and (usually) the chat exchange, and this panel shows the reply, which leads with what landed and
 * what did not (replyText, S45), then asks the page to re-read the row. The row still needs Approve before anything
 * is submitted, and every edited or removed line keeps its Reset in Changes by AI below.
 *
 * S44a (2026-11-24, Teja: "rm The old Apply / 'Apply all' cards in resume chat"). The browser-side apply path went:
 * no op cards, no Apply / Apply all / Retry, no skill-group picker, no overflow or Apply-all previews. A reply that
 * still carries ops (a chat stored before S9i P2, or an answer from an old server deploy with no `applied` field)
 * renders those ops as a plain-text list that says they were proposed and not applied by this page. This page
 * applies NOTHING itself any more; the server is the one writer of AI edits.
 *
 * CHATS AND MEMORY. Every exchange is stored (resumeChat.ts, table resume_chat_messages), several
 * chats per resume, picked from a native <select>. The next ask carries the active chat's last
 * messages, each earlier reply led by what its changes amount to NOW, read from the resume
 * (aiEdit.historyTurnText / outcomeNote), so "make that shorter" works and the model never believes
 * its own claims.
 *
 * The chat also offers starter questions, takes messages up to 1500 characters with a visible count
 * (a pasted JD used to be cut at 500 without a word), and queues prompts sent while one is in flight.
 *
 * Pure presentation: the ask, the row re-read and the chat store are all injected; no client here. */

// useId ties labels to inputs; useState holds local state; useEffect loads and scrolls; useRef holds the log.
import { useEffect, useId, useRef, useState } from 'react';
// The return type of every component here.
import type { ReactElement } from 'react';

// Type only: the diff this chat reads its context from.
import type { ResumeDiff } from './diffModel';
// The pure halves: build the ask, read the server's record, resolve stored ops, word them, format the bill.
import { replyText, withServerApply, buildAssistDraft, describeOp, historyTurnText, isServerRecord, readStoredOp, removedInChat, replyNote, resolveOps } from './aiEdit';
// Types for the ask and its parts.
import type { AssistBody, AssistProgress, AssistResult, AssistStructure, StoredOp } from './aiEdit';
// The memory: grouping into chats and the window sent back as context.
import { groupThreads, historyFor } from './resumeChat';
// Types for stored messages and the injected store.
import type { ChatMessage, ChatStore, NewChatMessage } from './resumeChat';

// The chat's own styles, beside it, like DiffView.css beside DiffView.
import './AiEditPanel.css';

/* Unsent drafts by application, kept OUTSIDE the component (2026-11-09). An auto-applied edit can move the card to
   another bucket, which remounts this panel and would reset its state: a next prompt typed while the edit was being
   applied vanished with it (the chat e2e caught exactly that). Module scope lives as long as the tab, like the page's
   own row cache; nothing is persisted, so a reload still starts empty. */
const drafts = new Map<string, string>();
/* Queued prompts and their pause flag by application, outside the component for the same reason as drafts
   (2026-11-12): turn 1's auto-applied edit moves the card and remounts the panel, and a queue held in state died
   with it, so turn 2 was never served (the chat e2e caught it). */
const queues = new Map<string, { readonly queue: readonly string[]; readonly paused: boolean }>();
/* The ask running for each application, if any. A remounted panel starts with asking=false while the OLD instance's
   ask may still be applying its edits; the drain waits on this promise instead, so two asks never overlap on one resume. */
const inFlight = new Map<string, Promise<void>>();

// The edge function's instruction cap (resume-assist MAX_INSTRUCTION); longer is refused there.
const MAX_MESSAGE = 1500;
// The count appears from here on, so a long paste is never cut without the operator seeing it.
const SHOW_COUNT_FROM = 1200;

/* Starter messages for an empty chat (2026-11-04): two questions the AI could not answer before it
   read the posting, and two edits that stay within what the master supports. A click only fills the
   composer; nothing is sent until the operator presses Send. */
const SUGGESTIONS = [
  'Which keywords from this job is my resume missing?',
  'Where is this role based, and is it remote?',
  'Tighten my summary for this job without adding new claims.',
  'Remove skills that do not matter for this job.',
] as const;

/* S44a: the line that leads a reply's leftover ops. Worded so it never reads as "this landed": the page applied none
   of them, and only the resume (and Changes by AI below) says what is on it now. Exported for the render test. */
export const PROPOSED_LEAD = 'Proposed, not applied by this page (the resume shows what is on it now):';

/* S44a: the line for a stored op this build cannot read (a kind it no longer knows, or a drifted shape). A row from
   the database is untrusted, so a bad one is named generically, never thrown on and never shown as blank. */
export const UNKNOWN_PROPOSAL = 'A change in a format this page no longer reads.';

/* S44a: one stored op as one plain sentence. readStoredOp is the table's own shape check, so describeOp only ever
   sees a shape it knows; anything else becomes UNKNOWN_PROPOSAL. Takes unknown because a stored row can hold anything. */
export function proposalLine(raw: unknown): string {
  // Re-read through the same reader the chat store uses, so a malformed op is caught here, not deep in describeOp.
  const op = readStoredOp(raw);
  // Unreadable: the generic line, so the bubble is never blank and never crashes.
  if (op === null) return UNKNOWN_PROPOSAL;
  // A refusal carries its reason; said as such, so it never reads as a pending change.
  if (op.op === 'rejected') return `Could not do: ${op.what} (${op.why})`;
  // The outcome history's own wording ("add skill \"Kafka\"", lower-case first so it reads inside a sentence).
  const text = describeOp(op);
  // Capitalised, since here it starts its own line; an empty label falls back rather than showing nothing.
  return text.trim() === '' ? UNKNOWN_PROPOSAL : text.charAt(0).toUpperCase() + text.slice(1);
}

/* S44a: one assistant bubble, as plain text only: the AI's words, then either the "no changes" line or the list of
   leftover proposals, then the bill. No button anywhere: this page applies nothing. Exported for the render test
   (the panel itself loads its messages in an effect, which a static render never runs). */
export function AssistantReply({ message }: { readonly message: ChatMessage }): ReactElement {
  // A stored row is untrusted: anything but an array of objects reads as "no ops", never as a crash.
  const ops: readonly StoredOp[] = Array.isArray(message.ops) ? message.ops.filter((op): op is StoredOp => typeof op === 'object' && op !== null) : [];
  // The AI's words, with a change claim hidden when nothing in the reply could ever land (aiEdit.replyNote).
  const note = replyNote(message.content, ops);
  // One sentence per leftover op, in the order the AI proposed them.
  const lines = ops.map(proposalLine);
  // The bubble.
  return (
    <>
      {/* The AI's reply, as it wrote it (a server-applied reply leads with the server's own record). */}
      {note !== '' ? <p className="ai-chat__note">{note}</p> : null}
      {/* No ops and no server record: said in so many words, so the bubble is never blank and never implies a change. */}
      {lines.length === 0 && !isServerRecord(message.content) ? <p className="ai-chat__summary">No changes made to the resume.</p> : null}
      {/* Leftover proposals (an old stored chat, or an old server): text only, led by a line saying none was applied here. */}
      {lines.length > 0 ? <p className="ai-chat__summary">{PROPOSED_LEAD}</p> : null}
      {lines.length > 0 ? (
        <ul className="ai-chat__proposals">
          {/* Keyed by position: two proposals can share a sentence, and the list never reorders. */}
          {lines.map((line, index) => (
            <li key={index}>{line}</li>
          ))}
        </ul>
      ) : null}
      {/* S45 (Teja 13:42): no token bill under a reply; it is noise to the owner. Only an unsaved reply gets a footer. */}
      {message.id === null ? (
        <div className="ai-chat__foot">
          <span className="ai-chat__meta">
            {/* An exchange the save did not land says so, since tomorrow it will be gone. */}
            Not saved to history.
          </span>
        </div>
      ) : null}
    </>
  );
}

/* The chat itself. Mounted by DiffView only where an edit could land (a save path, editing on). */
export function AiEditPanel({
  // Read for the context of every ask, and for applied state.
  diff,
  // Called once per ask.
  onAssist,
  // Disables every control while a save runs.
  busy,
  // Where a new skill may be filed.
  categories,
  // Where chats are kept; absent means this session only (tests, a screen without a client).
  chat,
  // The current resume's structure; absent means no structural ops (the pre-2026-11-01 chat).
  structure,
  // A prompt the card's ATS panel asks to pre-fill; absent until a suggestion chip is clicked.
  seed,
  // S9i P2: the page re-reads this row after the server applied an answer (optional: DiffView passes it optional).
  onReloadRow,
}: {
  // The rendered diff: the AI's context is built from it, so it sees what the operator sees.
  readonly diff: ResumeDiff;
  // The ask; injected so this component never holds a client.
  // onProgress (2026-11-18) gets the live status and the reply so far; a caller that drops it still works, just without them.
  readonly onAssist: (body: AssistBody, onProgress?: (progress: AssistProgress) => void) => Promise<AssistResult>;
  // A save is in flight somewhere in this diff; one write at a time per resume.
  readonly busy: boolean;
  // The master's skill groups, the only places a new skill may be filed.
  readonly categories: readonly string[];
  // The chat store; optional so render-only callers need not fake one.
  readonly chat?: ChatStore | undefined;
  // Section order, entries and master items not on the resume, built by the page from the current
  // resume (aiEdit.AssistStructure explains how); optional so the page can wire it separately.
  readonly structure?: AssistStructure | undefined;
  // One pre-fill request; a fresh object per click so a repeated keyword still fills (see the effect).
  readonly seed?: { readonly text: string } | null | undefined;
  /* S9i P2 (Teja 2026-11-21 15:34: "every edit he prompts in the resume chat is applied and done … NO Apply button …
     even if he closes the chat, the tab or the job"). When the page passes this, the SERVER applies each answer
     (withServerApply) and the panel only shows what landed, then asks the page to re-read the row the server wrote.
     S44a (2026-11-24): every ask goes withServerApply now; absent only means no re-read (a test, or a screen that
     cannot re-read a row): the browser never applies an answer itself any more. */
  readonly onReloadRow?: (() => Promise<void>) | undefined;
}): ReactElement {
  // Ties labels to controls and the heading to the region.
  const baseId = useId();
  // Every message of this resume's chats, oldest first.
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  // The chat being shown; a fresh id until the stored chats load.
  const [chatId, setChatId] = useState<string>(() => crypto.randomUUID());
  // The stored chats are loading; the composer waits so a first ask cannot land in a stale chat.
  const [loading, setLoading] = useState<boolean>(chat !== undefined);
  // What the operator is typing.
  const [instruction, setInstruction] = useState<string>(() => drafts.get(diff.applicationId) ?? '');
  /* Every change mirrored into drafts, so a remount picks up what was typed. Empty removes the entry, so a sent
     message never comes back after a remount. */
  useEffect(() => {
    // Nothing typed: no draft to keep.
    if (instruction === '') drafts.delete(diff.applicationId);
    // Otherwise the latest text, for whichever instance mounts next.
    else drafts.set(diff.applicationId, instruction);
  }, [instruction, diff.applicationId]);
  // An ask is in flight.
  const [asking, setAsking] = useState<boolean>(false);
  /* What the streamed ask has said so far (2026-11-18): the server's stage line and the reply as Gemini writes it.
     Empty when nothing streamed (an old server's JSON answer), so the pending line falls back to "Thinking…". */
  const [progress, setProgress] = useState<AssistProgress>({});
  /* Prompts sent while another was still being answered or applied (Teja, 2026-11-12: "if I send multiple
     prompts they need to be queued, applied and served by the AI"). Oldest first; the drain effect below sends
     the head only once the panel is idle, so each prompt is built from the resume AFTER the previous one's
     edits landed, never from a stale copy. */
  // Seeded from the module store, so a remount picks up what was queued.
  const [queue, setQueue] = useState<readonly string[]>(() => queues.get(diff.applicationId)?.queue ?? []);
  /* A failed ask stops the drain: its prompt goes back to the head and waits for Resume. Without the pause, a
     down AI would fail every queued prompt in a row, each error hiding the last. */
  const [paused, setPaused] = useState<boolean>(() => queues.get(diff.applicationId)?.paused ?? false);
  /* Mirrored into the store on every change. The panel is keyed by application (DiffView), so another row is a new
     instance reading its OWN entry: one row's prompts are never sent against another's resume. */
  useEffect(() => {
    // Nothing queued and not paused: no entry to keep.
    if (queue.length === 0 && !paused) queues.delete(diff.applicationId);
    // Otherwise the latest, for whichever instance mounts next.
    else queues.set(diff.applicationId, { queue, paused });
  }, [queue, paused, diff.applicationId]);
  // Bumped when an earlier instance's ask ends, so the drain looks again (nothing else re-renders this one then).
  const [settled, setSettled] = useState<number>(0);
  // The last failure (an ask, a load or a save), in plain words.
  const [error, setError] = useState<string | null>(null);
  // The scrolling log, kept at its newest message.
  const logRef = useRef<HTMLOListElement | null>(null);
  // The message box, focused after a starter message fills it so Enter sends it.
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  // Load this resume's stored chats once per application.
  useEffect(() => {
    // No store: a session-only chat, nothing to load.
    if (chat === undefined) return;
    // Set when the row changes or the panel unmounts, so a late answer is ignored.
    let stale = false;
    // The read; never throws.
    void chat.load(diff.applicationId).then((result) => {
      // A newer row owns the panel now.
      if (stale) return;
      // Loading ends either way.
      setLoading(false);
      // A failed read is said; the chat still works for new messages.
      if (result.kind === 'error') {
        // Shown above the composer.
        setError(result.message);
        // Nothing to adopt.
        return;
      }
      // Every stored message.
      setMessages(result.messages);
      // Open the most recently used chat, if any; otherwise keep the fresh id.
      const newest = groupThreads(result.messages)[0];
      // Only when a stored chat exists.
      if (newest !== undefined) setChatId(newest.chatId);
    });
    // Cleanup marks the read stale.
    return () => {
      // Ignore whatever comes back.
      stale = true;
    };
    // Re-run only when the store or the row changes.
  }, [chat, diff.applicationId]);

  // The active chat's messages, oldest first.
  const active = messages.filter((m) => m.chatId === chatId);

  // Keep the newest message in view whenever the active chat grows.
  useEffect(() => {
    // The log element, once rendered.
    const log = logRef.current;
    // Scrolled to the bottom: chat apps show the newest message.
    if (log !== null) log.scrollTop = log.scrollHeight;
    // A new message or a different chat.
  }, [active.length, chatId]);

  /* Queue what is typed and empty the box. Send never waits any more: the drain effect asks when the panel is
     idle. The job description and the stored chats must have loaded first, as before, so the button holds then. */
  function send(): void {
    // The operator's words, trimmed.
    const text = instruction.trim();
    // Blank, or the chats or the job description not loaded yet: nothing to queue.
    if (text === '' || loading || jdPending) return;
    // Appended, so prompts are served in the order they were sent.
    setQueue((current) => [...current, text]);
    // The box is free for the next prompt at once.
    setInstruction('');
  }

  /* Send one queued instruction, with this chat's memory, and store the exchange. Called only by the drain. */
  async function ask(text: string): Promise<void> {
    // Mid-ask, mid-load, mid-save, or the job description not loaded yet: the drain never calls then; kept as a guard.
    if (text === '' || asking || loading || busy || jdPending) return;
    // Locks the composer.
    setAsking(true);
    // A new ask clears the old failure.
    setError(null);
    /* The chat's last turns, each earlier reply led by what its changes amount to NOW, read from the
       resume (aiEdit.outcomeNote). First, because historyFor cuts each turn at 500 characters, and
       the outcome is the part the model must not lose: "I added C" alone was resent as a fact. */
    // S9b (2026-11-21): historyTurnText also drops the server's empty "Proposed N change" line from each turn.
    const turns = active.map((m) => (m.role === 'assistant' && m.ops !== null ? { ...m, content: historyTurnText(m.ops, m.content, diff, structure ?? null) } : m));
    // Built from the diff as it is NOW (every applied edit included), its structure, those turns, and (S9b) the skills
    // this chat removed and that are still off, so the server never re-proposes them.
    const draft = buildAssistDraft(diff, categories, text, historyFor(turns), structure ?? null, removedInChat(active.map((m) => m.ops), diff));
    // A fresh ask starts with no stale stage line or half reply from the last one.
    setProgress({});
    // The call; never throws. Each streamed update replaces the whole progress view.
    // S9i P2 / S44a: the server applies every answer; the browser no longer has an apply path to fall back to.
    const sent = withServerApply(draft, diff.applicationId, chatId);
    // The call; never throws. Each streamed update replaces the whole progress view.
    const result = await onAssist(sent.body, setProgress);
    // The answer is in: the final reply renders from the result, so the streamed draft goes.
    setProgress({});
    // A failed ask is said and nothing is stored; the prompt goes back to the head of the queue for a retry.
    if (result.kind === 'error') {
      // Shown above the composer.
      setError(result.message);
      /* First again, so order holds when the owner resumes.
         ponytail: if the panel remounted while this ask ran, these sets reach the old instance and the failed
         prompt is lost (its error too); write through the queues store if that ever bites. */
      setQueue((current) => [text, ...current]);
      // The drain stops until Resume.
      setPaused(true);
      // Unlocks.
      setAsking(false);
      // Nothing else changes.
      return;
    }
    /* S9i P2: the server already applied this answer. One reply that leads with what
       landed, what did not and why (replyText, the server's own wording), then the AI's note. The server wrote the
       exchange when it says chat_saved; otherwise this page writes it, ops [] like the server's. Then the row is
       re-read, so the resume on screen is the one the server saved. */
    if (result.applied !== undefined) {
      // The reply text, inside the table's 2000-character check.
      // S45: the server's own readable wording (server-plan.ts replyText), so a page-written bubble reads like a server-written one.
      const reply = replyText(result.applied, result.note).slice(0, 2000);
      // The exchange as the server stores it.
      const pair: NewChatMessage[] = [
        // The owner's words.
        { chatId, role: 'user', content: text, ops: null, usage: null },
        // The answer, with no ops: the server already applied them.
        { chatId, role: 'assistant', content: reply, ops: [], usage: result.usage },
      ];
      // Stored here only when the server did not store it.
      const stored = result.chatSaved === true || chat === undefined ? null : await chat.save(diff.applicationId, pair);
      /* The server stored it: the history is re-read, so the bubbles carry their stored ids. Local copies (id null) read
         "Not saved to history" over an exchange that WAS saved (found by aiEditServerApplyE2e, 2026-11-23). */
      const reread = result.chatSaved === true && chat !== undefined ? await chat.load(diff.applicationId) : null;
      // The stored history when the re-read worked; else the page's own rows, or local copies.
      if (reread !== null && reread.kind === 'ok') setMessages(reread.messages);
      // Otherwise appended as before.
      else setMessages((current) => [...current, ...(stored !== null && stored.kind === 'ok' ? stored.messages : pair.map((m) => ({ ...m, id: null, createdAt: new Date().toISOString() })))]);
      // A failed write is said.
      if (stored !== null && stored.kind === 'error') setError(stored.message);
      // The row the server wrote, adopted by the page when it passed onReloadRow (a test may not).
      await onReloadRow?.();
      // The composer unlocks.
      setAsking(false);
      // Nothing for the browser to apply.
      return;
    }
    /* Each op resolved to this resume's targets, in order (so repeated moves pass different siblings);
       one that cannot land here comes back as a "Could not do" entry with its reason. The server's own
       refusals follow too, so nothing the AI proposed is ever silently left out of the history (2026-11-04). */
    const ops: StoredOp[] = [...resolveOps(result.ops, draft), ...result.rejected.map((r) => ({ op: 'rejected' as const, what: r.what, why: r.why }))];
    // The AI's reply as it wrote it; the bubble's proposal list says none of it was applied here.
    const content = (result.note !== '' ? result.note : 'The AI sent no reply text.').slice(0, 2000);
    // The exchange, question and answer together.
    const exchange: NewChatMessage[] = [
      // The operator's message; no ops, no usage (the table check requires it).
      { chatId, role: 'user', content: text, ops: null, usage: null },
      // The reply, with its resolved ops and its bill.
      { chatId, role: 'assistant', content, ops, usage: result.usage },
    ];
    // Stored when there is a store; the rows come back with ids and times.
    const saved = chat === undefined ? null : await chat.save(diff.applicationId, exchange);
    // The stored rows, or local copies (ids null: not in the database, so not in tomorrow's history).
    const shown: ChatMessage[] =
      saved !== null && saved.kind === 'ok' ? saved.messages : exchange.map((m) => ({ ...m, id: null, createdAt: new Date().toISOString() }));
    // Shown either way: a failed save keeps the answer usable, marked as unsaved.
    setMessages((current) => [...current, ...shown]);
    // Said, so the operator knows this exchange will not be remembered.
    if (saved !== null && saved.kind === 'error') setError(saved.message);
    /* No box clearing here (2026-11-12): send() emptied it when the prompt was queued, so whatever the box
       holds now is the owner's next message and must survive this reply (the 2026-11-09 rule). */
    /* S44a (2026-11-24): an answer WITHOUT `applied` (an old server deploy) is stored above so its proposals stay in
       the history and render as plain text, but nothing is applied: the browser-side apply path (auto-apply, cards,
       Apply, Apply all) is gone, and the server is the one writer of AI edits. */
    // Unlocks.
    setAsking(false);
  }

  /* Put a starter message in the composer and focus it; the operator still presses Send. */
  function suggest(text: string): void {
    // Filled, replacing whatever was half-typed (the operator chose this one).
    setInstruction(text);
    // Focused, so Enter sends it or the operator edits it first.
    inputRef.current?.focus();
  }

  /* An ATS-panel suggestion chip was clicked (2026-11-07): fill the composer the same way a starter does.
     Keyed on the seed OBJECT, so clicking the same keyword twice (a new object) fills it again. */
  useEffect(() => {
    // Nothing seeded yet, or the card cleared it.
    if (seed === null || seed === undefined) return;
    // The starter path: fill and focus, never send.
    suggest(seed.text);
    // suggest only sets state and focuses; it is redefined each render but behaves the same, so only seed is a dep.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seed]);

  /* Start an empty chat; stored chats stay in the picker. */
  function newChat(): void {
    // A fresh id; it becomes a stored chat with its first message.
    setChatId(crypto.randomUUID());
    // A stale failure belongs to the old chat.
    setError(null);
  }

  // Stored and local chats, most recently used first.
  const threads = groupThreads(messages);
  // Every control waits while anything is in flight.
  const locked = busy || asking || loading;
  /* The job description has not reached this diff yet (2026-11-09: the queue reads it after the first
     paint). Only SENDING waits on it: the AI tailors against the JD, and an ask built now would go out
     with an empty one that looks, to the model, like a job with no description. undefined = not loaded;
     null = loaded, none stored, which may be sent. */
  const jdPending = diff.jobDescription === undefined;
  /* The drain: when nothing is in flight, take the oldest queued prompt and ask it. ask() sets `asking` in the
     same batch as the shift, so the next run of this effect sees the panel locked and waits; it fires again once
     the reply has landed and the row is re-read (asking and the page's busy both clear). */
  useEffect(() => {
    // Paused after a failure, nothing queued, something in flight, or the description not loaded: wait.
    if (paused || queue.length === 0 || locked || jdPending) return;
    // An ask started by an earlier instance of this panel (before a remount) is still running.
    const earlier = inFlight.get(diff.applicationId);
    if (earlier !== undefined) {
      // Set on unmount, so a gone panel does not re-render.
      let live = true;
      // Look again once it ends; its edits have landed by then.
      void earlier.then(() => {
        // Only a mounted panel.
        if (live) setSettled((n) => n + 1);
      });
      // Cleanup: this run's wait is no longer wanted.
      return () => {
        // Ignore the settle.
        live = false;
      };
    }
    // The oldest prompt.
    const [next, ...rest] = queue;
    // Taken off the queue before it is asked, so a re-render cannot send it twice.
    setQueue(rest);
    // Nothing to ask (the length check above makes this unreachable; it narrows the type).
    if (next === undefined) return;
    // Asked with this render's ask, which reads the resume as it is now; ask never throws.
    const run = ask(next);
    // Registered for this application, so a remounted panel waits for it.
    inFlight.set(diff.applicationId, run);
    // Cleared when it ends, unless a newer ask already replaced it.
    void run.then(() => {
      // Only our own entry.
      if (inFlight.get(diff.applicationId) === run) inFlight.delete(diff.applicationId);
    });
    // ask is redefined each render; the state it reads is listed, so it is not.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queue, paused, locked, jdPending, settled, diff.applicationId]);
  /* Remove one queued prompt before it is sent (the owner changed their mind). By position, since two
     prompts can share a text. */
  function unqueue(index: number): void {
    // Every other prompt stays, in order.
    setQueue((current) => current.filter((_, i) => i !== index));
  }
  // Switching or starting a chat waits for the queue too: queued prompts belong to the chat they were typed in.
  const switchLocked = locked || queue.length > 0;

  // A labelled region, so a screen reader can jump to the chat by name.
  return (
    <section className="ai-chat" aria-labelledby={`${baseId}-title`}>
      {/* Title, chat picker and New chat on one bar. */}
      <div className="ai-chat__bar">
        <h3 id={`${baseId}-title`} className="ai-chat__title">
          AI resume chat
        </h3>
        {/* A real label, hidden: the select's value says which chat is open. */}
        <label className="visually-hidden" htmlFor={`${baseId}-chats`}>
          Past chats
        </label>
        {/* Native select: keyboard and screen-reader support for free, no custom dropdown. */}
        <select id={`${baseId}-chats`} className="ai-chat__picker" value={chatId} onChange={(event) => setChatId(event.target.value)} disabled={switchLocked}>
          {/* The open chat before its first message is not stored yet, so it is listed by hand. */}
          {/* Worded apart from the "New chat" button beside it (2026-11-07 audit: two "New chat" side by side). */}
          {threads.some((t) => t.chatId === chatId) ? null : <option value={chatId}>Current chat (not started)</option>}
          {/* Every stored chat, titled by its first instruction. */}
          {threads.map((thread) => (
            <option key={thread.chatId} value={thread.chatId}>
              {thread.title}
            </option>
          ))}
        </select>
        {/* Starts a clean chat; earlier ones stay in the picker. */}
        <button type="button" className="button button--secondary button--small" onClick={newChat} disabled={switchLocked || active.length === 0}>
          New chat
        </button>
      </div>

      {/* The conversation; polite live region so a new reply is announced without stealing focus. */}
      <ol ref={logRef} className="ai-chat__log" aria-live="polite">
        {/* An empty chat explains itself instead of showing blank space. */}
        {active.length === 0 ? (
          <li className="ai-chat__empty">
            {loading ? 'Loading chats…' : 'Say what to change, or ask about this job. The AI makes each edit for you, and its reply says what changed and what could not be done. Reset in Changes by AI below undoes an edited or removed line.'}
            {/* Starter messages, once the chats have loaded: a click fills the box, Send still sends. */}
            {loading ? null : (
              <div className="ai-chat__suggestions">
                {SUGGESTIONS.map((text) => (
                  <button type="button" className="ai-chat__suggestion" key={text} onClick={() => suggest(text)} disabled={locked}>
                    {text}
                  </button>
                ))}
              </div>
            )}
          </li>
        ) : null}
        {/* Each message in order. */}
        {active.map((message) => {
          // The operator's message: a bubble on the right.
          if (message.role === 'user') {
            return (
              // Keyed by time and role: unique per exchange even before a row id exists.
              <li key={`${message.createdAt}|user`} className="ai-chat__msg ai-chat__msg--user">
                {message.content}
              </li>
            );
          }
          // The AI's reply: a bubble on the left, plain text only (S44a: no cards, no buttons).
          return (
            // Same keying as the user bubble.
            <li key={`${message.createdAt}|assistant`} className="ai-chat__msg ai-chat__msg--ai">
              {/* The words, any leftover proposals as text, and the bill: AssistantReply above. */}
              <AssistantReply message={message} />
            </li>
          );
        })}
        {/* The pending reply, so the operator sees the ask is in flight. */}
        {asking ? (
          // The server's latest stage, else the old fixed word; the reply so far under it, as plain text (React escapes it).
          <li className="ai-chat__msg ai-chat__msg--ai" aria-live="polite">
            {/* The stage line, muted like before, so it reads as status, not as the AI talking. */}
            <span className="ai-chat__meta">{progress.status ?? 'Thinking…'}</span>
            {/* The reply as it is written; hidden until the first words arrive. */}
            {progress.note !== undefined && progress.note !== '' ? <p className="ai-chat__note">{progress.note}</p> : null}
          </li>
        ) : null}
        {/* Prompts waiting their turn, oldest first, after the one being answered: the order they will be served in. */}
        {queue.map((text, index) => (
          // Keyed by position and text: two queued prompts may share a text.
          <li key={`queued|${index}|${text}`} className="ai-chat__msg ai-chat__msg--user ai-chat__msg--queued">
            {text}
            {/* Says it has not been sent yet, so the bubble is not read as answered. */}
            <span className="ai-chat__meta"> · Queued</span>
            {/* A way out before it is sent; named by its text so each Remove is distinguishable to a screen reader. */}
            <button type="button" className="button button--secondary button--small" aria-label={`Remove queued prompt: ${text}`} onClick={() => unqueue(index)}>
              Remove
            </button>
          </li>
        ))}
      </ol>

      {/* Any failure, polite: news, not an emergency. */}
      <p className="ai-chat__error" role="status" aria-live="polite">
        {/* Empty when nothing failed; the live region stays for the next announcement. */}
        {error ?? ''}
      </p>
      {/* The drain stopped on a failure: the failed prompt is first in the queue again, sent on Resume. */}
      {paused && queue.length > 0 ? (
        <button
          type="button"
          className="button button--secondary button--small"
          /* Clears the old failure and lets the drain run. */
          onClick={() => {
            // The failure was about the last try.
            setError(null);
            // The drain picks the head up on its next run.
            setPaused(false);
          }}
        >
          {/* Says how much will be sent. */}
          Resume queue ({queue.length})
        </button>
      ) : null}

      {/* The composer: a form, so Enter-to-submit semantics and the button agree. */}
      <form
        className="ai-chat__composer"
        /* The button and Ctrl/Cmd+Enter both end here. */
        onSubmit={(event) => {
          // No page reload.
          event.preventDefault();
          // Queued; the drain sends it when the panel is idle.
          send();
        }}
      >
        {/* A real label, hidden: the placeholder vanishes on typing and is no label. */}
        <label className="visually-hidden" htmlFor={`${baseId}-input`}>
          Message to the AI
        </label>
        <textarea
          /* Read by suggest() to focus the box after a starter fills it. */
          ref={inputRef}
          /* Matches the label. */
          id={`${baseId}-input`}
          /* Styled in AiEditPanel.css, which also grows it with its content. */
          className="ai-chat__input"
          /* Short until typed into. */
          rows={2}
          /* The edge function's cap (1500 since 2026-11-04, was 500); the count below shows before it bites. */
          maxLength={MAX_MESSAGE}
          /* Short, since the empty chat already shows an example. */
          placeholder="Message the AI about this resume"
          /* Controlled, so send() queues exactly what is shown. */
          value={instruction}
          /* Every keystroke kept. */
          onChange={(event) => setInstruction(event.target.value)}
          /* Enter sends, Shift+Enter is a newline: the chat convention. */
          onKeyDown={(event) => {
            // Plain Enter only; Shift+Enter falls through as a newline, and IME composition is left alone.
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              // No newline inserted.
              event.preventDefault();
              // Same as the button: queued.
              send();
            }
          }}
          /* Never disabled (2026-11-09, Teja): it used to freeze for the whole ask, auto-applied saves included,
             so the next prompt could not be typed while an edit landed. Typing stays open; SENDING still waits
             (the Send button's `locked`, and ask()'s own guard on Enter), and the typed text is kept, never dropped.
             2026-11-12: SENDING no longer waits either: a prompt sent mid-ask is queued and served in order. */
        />
        {/* The length near the cap: maxLength cuts a paste silently, so the count makes the cut visible. */}
        {instruction.length >= SHOW_COUNT_FROM ? (
          <span className="ai-chat__meta">
            {instruction.length}/{MAX_MESSAGE}
          </span>
        ) : null}
        {/* Why Send is off while the description loads, so a disabled button is never unexplained. */}
        {jdPending ? <span className="ai-chat__meta" role="status">Loading the job description…</span> : null}
        {/* Primary: the one action the composer exists for. */}
        <button type="submit" className="button button--primary button--small" disabled={loading || jdPending || instruction.trim() === ''}>
          {/* Always Send: a prompt sent mid-ask is queued, shown in the log as Queued (2026-11-12). */}
          Send
        </button>
      </form>
    </section>
  );
}
