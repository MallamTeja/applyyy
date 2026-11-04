/* THE AI CHAT on the review page (2026-10-31; a chat with memory since 2026-11-01).
 *
 * The operator types what to change; the AI replies (answering any question) and makes the edits.
 * Since 2026-11-01 THE AI PERFORMS THE ACTIONS: each edit is applied right after the answer, through
 * the same guarded save path as a hand edit (aiEdit.ts explains why that path). The one exception is
 * shouldAutoApply's: a skill the master lacks and the operator did not name waits for a click, so
 * the AI cannot write a claim into the master on its own. The row still needs Approve before anything
 * is submitted, every edited line keeps its Reset in the diff, and the preview / "Download PDF"
 * follow every applied edit because the page re-renders the saved resume.
 *
 * CHATS AND MEMORY. Every exchange is stored (resumeChat.ts, table resume_chat_messages), several
 * chats per resume, picked from a native <select>. The next ask carries the active chat's last
 * messages, so "make that shorter" works. Applied state is never stored: each card asks the
 * resume (isApplied), so a reopened chat, or one after a Reset, tells the truth.
 *
 * THE AUDIT AS ADVICE, ON THE CARD (2026-11-01). Each bullet edit is run through the auditor's own
 * rule 5 (detector.ts bulletGroundingGaps) before Apply, and the card says which numbers and words
 * the master does not supply; a skill the master lacks says Apply saves it there too. Every apply
 * is one click: no popup, no block, no status change. Teja ruled native confirms out, since a
 * dialog on every click trains a reflex OK; the card is read before the click instead. Each reply
 * counts its flagged edits, so whether the audit should ever BLOCK is decided on measured numbers.
 *
 * STRUCTURE EDITS (2026-11-01). Given the optional `structure` prop, the AI can also move a bullet or
 * a section, add a master bullet or entry back, and write a new bullet. Moves and add-backs apply by
 * themselves (true master text, reordered or restored); a new bullet always waits for a click, since
 * applying it writes a new claim into the master (aiEdit.shouldAutoApply). Without the prop the chat
 * behaves exactly as before.
 *
 * WHAT THE CHAT SAYS IS WHAT THE RESUME SHOWS (2026-11-04). Teja found replies saying "I have added C"
 * over a resume that never changed: the reply is the model's prose, written before the server
 * dropped its op, and a dropped op used to vanish into a "(1 proposed edit did not fit)" suffix. Now:
 * every op that cannot land is its own "Could not do" card with the reason (aiEdit `rejected`);
 * right under the reply, a status line counts what is applied, what is not yet, and what could not
 * be done, read from the resume (isApplied), never from the reply; and the model reads the same
 * outcome ahead of its earlier replies (aiEdit.outcomeNote), so it stops believing its own claims.
 * The chat also offers starter questions, takes messages up to 1500 characters with a visible count
 * (a pasted JD used to be cut at 500 without a word), and the AI can now remove skills and entries.
 *
 * Pure presentation: the ask, the save and the chat store are all injected; no client here. */

// useId ties labels to inputs; useState holds local state; useEffect loads and scrolls; useRef holds the log.
import { useEffect, useId, useRef, useState } from 'react';
// The return type of every component here.
import type { ReactElement } from 'react';

// Type only: the diff this chat reads its context from, and checks applied state against.
import type { ResumeDiff } from './diffModel';
// Type only: the action vocabulary and save result the page already understands.
import type { EditAction, EditResult } from './DiffView';
// The pure halves: build the ask, resolve and apply ops, read applied state and outcomes, format the bill.
import { buildAssistDraft, formatUsage, holdReason, isApplied, outcomeNote, resolveOps, sectionTitle, shouldAutoApply, toEditAction } from './aiEdit';
// Types for the ask and its parts.
import type { ApplicableOp, AssistBody, AssistResult, AssistStructure, AuditAdvice, StoredOp } from './aiEdit';
// The memory: grouping into chats and the window sent back as context.
import { groupThreads, historyFor } from './resumeChat';
// Types for stored messages and the injected store.
import type { ChatMessage, ChatStore, NewChatMessage } from './resumeChat';

// The chat's own styles, beside it, like DiffView.css beside DiffView.
import './AiEditPanel.css';

/* An Apply in flight or refused; applied state itself is derived from the resume. */
type OpState = { readonly status: 'applying' } | { readonly status: 'failed'; readonly reason: string };

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

/* One reply's status line, read from the resume (never from the reply's text). */
function replySummary(ops: readonly StoredOp[], diff: ResumeDiff, structure: AssistStructure | null): string {
  // A reply with no ops changed nothing, whatever its text says: said in so many words.
  if (ops.length === 0) return 'No changes made to the resume.';
  // Cards that can never land.
  const impossible = ops.filter((op) => op.op === 'rejected').length;
  // Cards that can land.
  const possible = ops.length - impossible;
  // Of those, the ones on the resume now.
  const applied = ops.filter((op) => isApplied(op, diff, structure)).length;
  // The parts that are not zero, most important first.
  const parts = [
    // Done, out of what could be done.
    possible > 0 ? `${applied} of ${possible} change${possible === 1 ? '' : 's'} applied` : null,
    // Waiting for a click, failed, or undone since.
    possible - applied > 0 ? `${possible - applied} not applied yet` : null,
    // Refused, each with its reason on its card.
    impossible > 0 ? `${impossible} could not be done` : null,
  ].filter((part): part is string => part !== null);
  // One line.
  return `${parts.join(' · ')}.`;
}

/* A key for one op of one message, stable across renders. */
function opKey(message: ChatMessage, index: number): string {
  // createdAt + role identifies a message even before it has a row id.
  return `${message.createdAt}|${message.role}|${index}`;
}

/* The audit's advice on one card. Words and numbers are listed so the operator judges each. */
function AdviceLine({ advice }: { readonly advice: AuditAdvice }): ReactElement {
  // No rule for this edit: said, never shown as a pass.
  if (advice.kind === 'not_checked') return <p className="ai-chat__meta">{advice.why}</p>;
  // The flagged parts, each list only when non-empty.
  const parts: string[] = [];
  // Numbers first: the costlier lie.
  if (advice.metrics.length > 0) parts.push(`numbers not in your master: ${advice.metrics.join(', ')}`);
  // Then words.
  if (advice.terms.length > 0) parts.push(`words not in your master: ${advice.terms.join(', ')}`);
  // Grounded: said plainly, in the traced green.
  if (parts.length === 0) return <p className="ai-chat__audit ai-chat__audit--clean">Audit: grounded in your master.</p>;
  // Flagged: what the audit would mark, in the fabrication colour.
  return <p className="ai-chat__audit">Audit would flag {parts.join('; ')}.</p>;
}

/* A section key as a heading word ("projects" -> "Projects"): aiEdit's own, so a card and the
   outcome line the model reads always spell a section the same way. */
const sectionName = sectionTitle;

/* What one stored op changes, with what the audit would say. Exported for the render test. */
export function OpBody({
  // The proposal.
  op,
  // The master's skill groups, offered on a skill card.
  categories = [],
  // The group chosen on this card; the AI's pick until changed.
  group,
  // Called when the operator picks another group; absent renders the group as text.
  onGroup,
  // The card is applied or busy: the picker cannot change what was saved.
  locked = false,
}: {
  // One of the stored op kinds; the card shape follows it.
  readonly op: StoredOp;
  // Optional: only a skill card offers groups.
  readonly categories?: readonly string[];
  // The operator's pick; undefined means the AI's pick stands.
  readonly group?: string | undefined;
  // Absent renders the group as plain text (read-only cards, tests).
  readonly onGroup?: ((group: string) => void) | undefined;
  // Defaults to editable.
  readonly locked?: boolean;
}): ReactElement {
  // A new skill: name, group, and whether Apply also makes it a master claim.
  if (op.op === 'add_skill') {
    // The group shown: the operator's pick, else the AI's.
    const chosen = group ?? op.category;
    // Every master group, plus the AI's pick if the list somehow lacks it, so the select can show it.
    const options = categories.includes(chosen) ? categories : [chosen, ...categories];
    // Stacked: the add, then what else Apply does.
    return (
      // The card root: ai-chat__change stacks the change and its notes.
      <div className="ai-chat__change">
        {/* The name in bold, since that is the claim being made; the group is a picker (2026-11-01)
            because the AI must choose among the master's groups and none may fit (OS under Frameworks). */}
        <span>
          Add skill <strong>{op.name}</strong> under{' '}
          {onGroup === undefined ? (
            chosen
          ) : (
            <select className="ai-chat__group" aria-label={`Skill group for ${op.name}`} value={chosen} onChange={(event) => onGroup(event.target.value)} disabled={locked}>
              {/* One option per master group. */}
              {options.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          )}
        </span>
        {/* Said before the click, where the popup used to ask it. */}
        {op.inMaster ? null : <p className="ai-chat__audit">Not in your master profile yet: Apply saves it there too. Only apply if you have it.</p>}
      </div>
    );
  }
  // A bullet move: which way, and the bullet, so the operator sees what shifts.
  if (op.op === 'move') {
    // Stacked like an edit card.
    return (
      // The card root: ai-chat__change stacks the change and its notes.
      <div className="ai-chat__change">
        {/* The direction is the change. */}
        <span className="ai-chat__where">Move bullet {op.direction}</span>
        {/* The bullet's text as it was when asked; unchanged by a move. */}
        <span>{op.before}</span>
      </div>
    );
  }
  // A section move: one line says it all.
  if (op.op === 'move_section') {
    // The section in bold, since that is what moves in the PDF.
    return (
      // The card root: ai-chat__change stacks the change and its notes.
      <p className="ai-chat__change">
        Move section <strong>{sectionName(op.section)}</strong> {op.direction}
      </p>
    );
  }
  // A master bullet back: where it lands, and its master words.
  if (op.op === 'add_bullet') {
    // Stacked like an edit card; <ins> carries "added" to screen readers.
    return (
      // The card root: ai-chat__change stacks the change and its notes.
      <div className="ai-chat__change">
        {/* The entry it goes under. */}
        <span className="ai-chat__where">Add back under {op.parentLabel}</span>
        {/* The master's own text: nothing new is claimed. */}
        <ins className="ai-chat__new">{op.text}</ins>
      </div>
    );
  }
  // A master entry back: its section and name.
  if (op.op === 'add_entry') {
    // Stacked like the others.
    return (
      // The card root: ai-chat__change stacks the change and its notes.
      <div className="ai-chat__change">
        {/* The section it lands in. */}
        <span className="ai-chat__where">Add back to {sectionName(op.section)}</span>
        {/* The entry, with all its master bullets. */}
        <ins className="ai-chat__new">{op.label}</ins>
      </div>
    );
  }
  // A new bullet: where, what, and that Apply writes it into the master.
  if (op.op === 'new_bullet') {
    // Stacked like an edit card.
    return (
      // The card root: ai-chat__change stacks the change and its notes.
      <div className="ai-chat__change">
        {/* The entry it goes under. */}
        <span className="ai-chat__where">New bullet under {op.parentLabel}</span>
        {/* The proposed wording. */}
        <ins className="ai-chat__new">{op.text}</ins>
        {/* Said before the click: this card never applies itself (shouldAutoApply). */}
        <p className="ai-chat__audit">Not in your master profile yet: Apply saves it there too. Only apply if it is true.</p>
      </div>
    );
  }
  // A change that could not be made: what was asked, and why, in place of any Apply.
  if (op.op === 'rejected') {
    // Stacked like an edit card.
    return (
      // The card root: ai-chat__change stacks the change and its notes.
      <div className="ai-chat__change">
        {/* Labelled first, so the card is never read as a proposal. */}
        <span className="ai-chat__where">Could not do</span>
        {/* The change as the AI proposed it. */}
        <span>{op.what}</span>
        {/* The one check it failed, in the warning colour. */}
        <p className="ai-chat__audit">{op.why}</p>
      </div>
    );
  }
  // A skill off the resume: its name, struck.
  if (op.op === 'remove_skill') {
    // One line; <del> carries "removed" to screen readers.
    return (
      // The card root: ai-chat__change stacks the change and its notes.
      <p className="ai-chat__change">
        Remove skill <del className="ai-chat__old">{op.name}</del>
      </p>
    );
  }
  // A whole entry off the resume: its section and label, struck.
  if (op.op === 'remove_entry') {
    // Stacked like the add-back card it mirrors.
    return (
      // The card root: ai-chat__change stacks the change and its notes.
      <div className="ai-chat__change">
        {/* The section it leaves. */}
        <span className="ai-chat__where">Remove from {sectionName(op.section)}</span>
        {/* The entry, with all its bullets. */}
        <del className="ai-chat__old">{op.label}</del>
      </div>
    );
  }
  // A removal: the bullet that goes.
  if (op.op === 'remove') {
    // The whole bullet, struck, so the operator sees exactly what leaves the PDF.
    return (
      // The card root: ai-chat__change stacks the change and its notes.
      <p className="ai-chat__change">
        {/* <del> carries "removed" to screen readers, not only to the eye. */}
        Remove bullet: <del className="ai-chat__old">{op.before}</del>
      </p>
    );
  }
  // An edit: old struck through, new beneath it, then the audit's advice.
  return (
    // Stacked, so a long bullet wraps instead of squeezing the button.
    <div className="ai-chat__change">
      {/* Which part of the resume the edit lands on. */}
      <span className="ai-chat__where">{op.target.kind === 'summary' ? 'Summary' : 'Bullet'}</span>
      {/* Absent old text (a new summary) shows nothing struck. */}
      {op.before !== null ? <del className="ai-chat__old">{op.before}</del> : null}
      {/* The proposed wording. */}
      <ins className="ai-chat__new">{op.text}</ins>
      {/* What the audit would say, read before Apply instead of asked in a popup. */}
      {op.advice !== null ? <AdviceLine advice={op.advice} /> : null}
    </div>
  );
}

/* The chat itself. Mounted by DiffView only where an edit could land (a save path, editing on). */
export function AiEditPanel({
  // Read for the context of every ask, and for applied state.
  diff,
  // Called once per applied edit.
  onEdit,
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
}: {
  // The rendered diff: the AI's context is built from it, so it sees what the operator sees.
  readonly diff: ResumeDiff;
  // The page's guarded save; one call per applied edit.
  readonly onEdit: (action: EditAction) => Promise<EditResult>;
  // The ask; injected so this component never holds a client.
  readonly onAssist: (body: AssistBody) => Promise<AssistResult>;
  // A save is in flight somewhere in this diff; one write at a time per resume.
  readonly busy: boolean;
  // The master's skill groups, the only places a new skill may be filed.
  readonly categories: readonly string[];
  // The chat store; optional so render-only callers need not fake one.
  readonly chat?: ChatStore | undefined;
  // Section order, entries and master items not on the resume, built by the page from the current
  // resume (aiEdit.AssistStructure explains how); optional so the page can wire it separately.
  readonly structure?: AssistStructure | undefined;
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
  const [instruction, setInstruction] = useState<string>('');
  // An ask is in flight.
  const [asking, setAsking] = useState<boolean>(false);
  // The last failure (an ask, a load or a save), in plain words.
  const [error, setError] = useState<string | null>(null);
  // Applies in flight or refused, by op key.
  const [opStates, setOpStates] = useState<ReadonlyMap<string, OpState>>(new Map());
  // An Apply-all run is in progress, so its buttons wait.
  const [applyingAll, setApplyingAll] = useState<boolean>(false);
  // Skill groups the operator picked on a card, by op key; absent means the AI's pick stands.
  const [groups, setGroups] = useState<ReadonlyMap<string, string>>(new Map());
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

  /* Send the instruction, with this chat's memory, and store the exchange. */
  async function ask(): Promise<void> {
    // The operator's words, trimmed.
    const text = instruction.trim();
    // Blank, mid-ask, mid-load or mid-save: nothing to send.
    if (text === '' || asking || loading || busy) return;
    // Locks the composer.
    setAsking(true);
    // A new ask clears the old failure.
    setError(null);
    /* The chat's last turns, each earlier reply led by what its changes amount to NOW, read from the
       resume (aiEdit.outcomeNote). First, because historyFor cuts each turn at 500 characters, and
       the outcome is the part the model must not lose: "I added C" alone was resent as a fact. */
    const turns = active.map((m) => (m.role === 'assistant' && m.ops !== null ? { ...m, content: [outcomeNote(m.ops, diff, structure ?? null), m.content].filter((part) => part !== '').join(' ') } : m));
    // Built from the diff as it is NOW (every applied edit included), its structure, and those turns.
    const draft = buildAssistDraft(diff, categories, text, historyFor(turns), structure ?? null);
    // The call; never throws.
    const result = await onAssist(draft.body);
    // A failed ask is said and nothing is stored; the instruction stays for a retry.
    if (result.kind === 'error') {
      // Shown above the composer.
      setError(result.message);
      // Unlocks.
      setAsking(false);
      // Nothing else changes.
      return;
    }
    /* Each op resolved to this resume's targets, in order (so repeated moves pass different siblings);
       one that cannot land here comes back as a "Could not do" card with its reason. The server's own
       refusals follow as cards too, so nothing the AI proposed is ever silently left out (2026-11-04). */
    const ops: StoredOp[] = [...resolveOps(result.ops, draft), ...result.rejected.map((r) => ({ op: 'rejected' as const, what: r.what, why: r.why }))];
    // The AI's reply as it wrote it; the status line under it says what actually happened.
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
    // The composer empties for the next message.
    setInstruction('');
    // The reply whose ops are applied now.
    const reply = shown.find((m) => m.role === 'assistant');
    /* THE AI PERFORMS THE ACTIONS (2026-11-01): each op that shouldAutoApply allows is applied in
       order through the page's guarded save, exactly as a click would; the composer stays locked
       until they land. A skill the operator did not name stays a card. First failure stops the run,
       since the row probably changed and later saves would fail the same way. */
    for (const [index, op] of (reply?.ops ?? []).entries()) {
      // Left as a card for a click (or a "Could not do" card, which has nothing to apply).
      if (op.op === 'rejected' || !shouldAutoApply(op, text)) continue;
      // Applied; a refusal shows on its card with Retry.
      if (reply !== undefined && !(await apply(op, opKey(reply, index)))) break;
    }
    // Unlocks.
    setAsking(false);
  }

  /* Change one op's in-flight state; undefined clears it. */
  function setOpState(key: string, state: OpState | undefined): void {
    // Functional update: several applies can resolve between renders.
    setOpStates((current) => {
      // Copied, never mutated.
      const next = new Map(current);
      // Cleared or set.
      if (state === undefined) next.delete(key);
      // Otherwise set.
      else next.set(key, state);
      // The new map.
      return next;
    });
  }

  /* Apply one op through the page's guarded save. Answers whether it landed. ApplicableOp, so a
     "Could not do" card cannot reach a save even by mistake. */
  async function apply(op: ApplicableOp, key: string): Promise<boolean> {
    // Shown as in progress. No popup: the card already showed every flag before this click.
    setOpState(key, { status: 'applying' });
    // The page's save; a refusal comes back as a reason.
    const result = await onEdit(toEditAction(op.op === 'add_skill' ? { ...op, category: groups.get(key) ?? op.category } : op));
    // Landed: the diff re-renders and isApplied turns the card to "Applied".
    if (result.ok) setOpState(key, undefined);
    // Refused or unknown, in the save path's words.
    else setOpState(key, { status: 'failed', reason: result.reason });
    // Reported for Apply all.
    return result.ok;
  }

  /* Apply every not-yet-applied op of one reply in order; stop at the first failure. */
  async function applyAll(message: ChatMessage): Promise<void> {
    // Locks the buttons.
    setApplyingAll(true);
    // One at a time: each save writes the whole resume, so two in flight would race.
    for (const [index, op] of (message.ops ?? []).entries()) {
      // Nothing to apply on a "Could not do" card.
      if (op.op === 'rejected') continue;
      // Already on the resume: skipped.
      if (isApplied(op, diff, structure ?? null)) continue;
      /* A new bullet writes a new claim into the MASTER, so it always takes its own click, never a
         batch (review finding, 2026-11-01): a hostile job text that induces one cannot ride along. */
      if (op.op === 'new_bullet') continue;
      // A failure usually means the row changed; later saves would fail the same way.
      if (!(await apply(op, opKey(message, index)))) break;
    }
    // Unlocks.
    setApplyingAll(false);
  }

  /* Put a starter message in the composer and focus it; the operator still presses Send. */
  function suggest(text: string): void {
    // Filled, replacing whatever was half-typed (the operator chose this one).
    setInstruction(text);
    // Focused, so Enter sends it or the operator edits it first.
    inputRef.current?.focus();
  }

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
  const locked = busy || asking || applyingAll || loading;

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
        <select id={`${baseId}-chats`} className="ai-chat__picker" value={chatId} onChange={(event) => setChatId(event.target.value)} disabled={locked}>
          {/* The open chat before its first message is not stored yet, so it is listed by hand. */}
          {threads.some((t) => t.chatId === chatId) ? null : <option value={chatId}>New chat</option>}
          {/* Every stored chat, titled by its first instruction. */}
          {threads.map((thread) => (
            <option key={thread.chatId} value={thread.chatId}>
              {thread.title}
            </option>
          ))}
        </select>
        {/* Starts a clean chat; earlier ones stay in the picker. */}
        <button type="button" className="button button--secondary button--small" onClick={newChat} disabled={locked || active.length === 0}>
          New chat
        </button>
      </div>

      {/* The conversation; polite live region so a new reply is announced without stealing focus. */}
      <ol ref={logRef} className="ai-chat__log" aria-live="polite">
        {/* An empty chat explains itself instead of showing blank space. */}
        {active.length === 0 ? (
          <li className="ai-chat__empty">
            {loading ? 'Loading chats…' : 'Say what to change, or ask about this job. The AI applies edits your master profile backs up; anything else waits for your click, and each card says whether it landed. Reset in the comparison below undoes any of them.'}
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
          // The reply's proposals, with their applied state read from the resume.
          const ops = message.ops ?? [];
          // Ops not yet on the resume that Apply all will take (a new bullet always needs its own click; a rejected card has none).
          const open = ops.filter((op) => op.op !== 'new_bullet' && op.op !== 'rejected' && !isApplied(op, diff, structure ?? null)).length;
          // Bullet edits the audit rule ran on: the denominator of the flag count.
          const audited = ops.filter((op) => op.op === 'edit' && op.advice?.kind === 'checked');
          // Of those, the ones it would flag: the number that decides whether the audit should ever block.
          const flagged = audited.filter((op) => op.op === 'edit' && op.advice?.kind === 'checked' && (op.advice.metrics.length > 0 || op.advice.terms.length > 0));
          // The AI's reply: a bubble on the left with its cards.
          return (
            // Same keying as the user bubble.
            <li key={`${message.createdAt}|assistant`} className="ai-chat__msg ai-chat__msg--ai">
              {/* The AI's reply, as it wrote it: its answer, never the record of what changed. */}
              <p className="ai-chat__note">{message.content}</p>
              {/* The record, read from the resume right now: what is applied, what is not, what could not be done. */}
              <p className="ai-chat__summary">{replySummary(ops, diff, structure ?? null)}</p>
              {/* The proposals, each with its own Apply. */}
              {ops.length > 0 ? (
                <ol className="ai-chat__ops">
                  {ops.map((op, index) => {
                    // This op's key for in-flight state.
                    const key = opKey(message, index);
                    // In flight or refused, if either.
                    const state = opStates.get(key);
                    // On the resume now: read from the diff, never stored.
                    const applied = isApplied(op, diff, structure ?? null);
                    // One card; a "Could not do" card is marked so it never reads as a pending proposal.
                    return (
                      <li key={key} className={`ai-chat__op${applied ? ' ai-chat__op--applied' : ''}${op.op === 'rejected' ? ' ai-chat__op--rejected' : ''}`}>
                        <OpBody
                          op={op}
                          /* The master's groups, the only ones a skill may print under. */
                          categories={categories}
                          /* The operator's pick for this card, if any. */
                          group={groups.get(key)}
                          /* Remembered per card; Apply reads it. */
                          onGroup={(name) => setGroups((current) => new Map(current).set(key, name))}
                          /* Applied or in flight: the group is settled. */
                          locked={applied || locked || state?.status === 'applying'}
                        />
                        {/* Applied items say so; a "Could not do" card says that instead of offering a button. */}
                        {applied ? (
                          <span className="ai-chat__done">Applied</span>
                        ) : op.op === 'rejected' ? (
                          <span className="ai-chat__not-done">Not done</span>
                        ) : (
                          <button
                            type="button"
                            /* Secondary: the primary action here is sending. */
                            className="button button--secondary button--small"
                            /* One guarded save through the page. */
                            onClick={() => void apply(op, key)}
                            /* Waits for any save, ask or batch. */
                            disabled={locked || state?.status === 'applying'}
                          >
                            {/* A failed one is retried by the same button. */}
                            {state?.status === 'applying' ? 'Applying…' : state?.status === 'failed' ? 'Retry' : 'Apply'}
                          </button>
                        )}
                        {/* The save path's refusal, verbatim. */}
                        {state?.status === 'failed' ? <p className="ai-chat__error">{state.reason}</p> : null}
                        {/* Why a card that is not applied waits for a click (2026-11-04, audit-gated), so "not applied yet" is never unexplained. */}
                        {!applied && state === undefined && holdReason(op) !== null ? <p className="ai-chat__meta ai-chat__hold">{holdReason(op)}</p> : null}
                      </li>
                    );
                  })}
                </ol>
              ) : null}
              {/* The reply's footer: batch apply, flag count, bill. */}
              <div className="ai-chat__foot">
                {/* Offered only when more than one edit still waits. */}
                {open > 1 ? (
                  <button type="button" className="button button--secondary button--small" onClick={() => void applyAll(message)} disabled={locked}>
                    {/* The count, so the operator knows how many saves one click makes. */}
                    Apply all ({open})
                  </button>
                ) : null}
                {/* The measurement: how many bullet edits the audit would flag. */}
                {audited.length > 0 ? <span className="ai-chat__meta">Audit would flag {flagged.length} of {audited.length} bullet edits.</span> : null}
                {/* What this ask cost; an unsaved reply says so. */}
                <span className="ai-chat__meta">
                  {/* The bill, only when Google reported it. */}
                  {message.usage !== null ? formatUsage(message.usage) : ''}
                  {/* An exchange the save did not land says so, since tomorrow it will be gone. */}
                  {message.id === null ? ' Not saved to history.' : ''}
                </span>
              </div>
            </li>
          );
        })}
        {/* The pending reply, so the operator sees the ask is in flight. */}
        {asking ? <li className="ai-chat__msg ai-chat__msg--ai ai-chat__meta">Thinking…</li> : null}
      </ol>

      {/* Any failure, polite: news, not an emergency. */}
      <p className="ai-chat__error" role="status" aria-live="polite">
        {/* Empty when nothing failed; the live region stays for the next announcement. */}
        {error ?? ''}
      </p>

      {/* The composer: a form, so Enter-to-submit semantics and the button agree. */}
      <form
        className="ai-chat__composer"
        /* The button and Ctrl/Cmd+Enter both end here. */
        onSubmit={(event) => {
          // No page reload.
          event.preventDefault();
          // Same guards as everywhere.
          void ask();
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
          /* Controlled, so ask() reads exactly what is shown. */
          value={instruction}
          /* Every keystroke kept. */
          onChange={(event) => setInstruction(event.target.value)}
          /* Enter sends, Shift+Enter is a newline: the chat convention. */
          onKeyDown={(event) => {
            // Plain Enter only; Shift+Enter falls through as a newline, and IME composition is left alone.
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              // No newline inserted.
              event.preventDefault();
              // Same guards as the button.
              void ask();
            }
          }}
          /* Frozen while asking, so the text shown is the text that was sent. */
          disabled={asking}
        />
        {/* The length near the cap: maxLength cuts a paste silently, so the count makes the cut visible. */}
        {instruction.length >= SHOW_COUNT_FROM ? (
          <span className="ai-chat__meta">
            {instruction.length}/{MAX_MESSAGE}
          </span>
        ) : null}
        {/* Primary: the one action the composer exists for. */}
        <button type="submit" className="button button--primary button--small" disabled={locked || instruction.trim() === ''}>
          {/* The label says when an ask is in flight. */}
          {asking ? 'Sending…' : 'Send'}
        </button>
      </form>
    </section>
  );
}
