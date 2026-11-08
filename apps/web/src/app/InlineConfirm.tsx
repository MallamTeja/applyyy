/* InlineConfirm - an in-place "are you sure?" that replaces the browser's confirm popup (2026-11-01).
 *
 * WHY IT EXISTS. Teja's order (2026-11-01 14:04 IST): no browser popups. Two writes keep a confirm step
 * because neither has an undo: a recovery move (applied, failed and dropped_filter have no human edge
 * back) and deleting a custom Answer Bank question. The guard stays; only its surface changes.
 *
 * HOW IT BEHAVES.
 *  - A trigger's click calls armConfirm(id, request). The guarded controls stay rendered but hidden
 *    (visibility:hidden), and the question is stacked over them in the SAME grid cell, so the row keeps
 *    its height. A popover would be clipped by .table-wrap's overflow-x on the last row.
 *  - ONE pending confirm in the whole app. The slot is module-level, so arming one closes any other,
 *    across every RecoveryQueue on a page and the Answer Bank: two open questions invite answering the
 *    wrong one. A confirm closed that way takes no focus, so it never steals it from the new one.
 *  - Confirm runs the request's action AT MOST ONCE: the slot is emptied before the action runs, so a
 *    double click finds nothing left to run.
 *  - Cancel and Escape write nothing and return focus to the button that opened the confirm. That
 *    button is recorded from the click event, because Safari does not focus a button on click.
 *  - Focus starts on Cancel: the safe default for a write with no undo.
 *  - The sentence is announced through an ALWAYS-MOUNTED aria-live="polite" region. Polite, not
 *    role=alert: focus lands on Cancel at the same moment, and an assertive alert would talk over that
 *    button's name; polite queues behind it. Always mounted, because a live region inserted together
 *    with its first text is often not announced (the same reason RecoveryQueue's notes strip is).
 *
 * TESTABLE WITHOUT A DOM. apps/web has no DOM renderer, so the slot is plain exported functions and the
 * two buttons live in the hook-free ConfirmActions: test/inlineConfirm.test.ts calls their real click
 * handlers by value, and a static render after armConfirm draws the armed state. */

// The slot is read through React's external-store hook, so every instance re-renders when it changes;
// the layout effect and ref make the controls' hide/show instant (see InlineConfirm).
import { useEffect, useLayoutEffect, useRef, useSyncExternalStore } from 'react';
// Types only: the component returns and children shapes.
import type { KeyboardEvent, ReactElement, ReactNode } from 'react';
// Commits the closing render synchronously, so focus can go back to a control that is visible again.
import { flushSync } from 'react-dom';
// The layout: one grid cell, two stacked layers.
import './InlineConfirm.css';

/* What one confirm asks and does. Built by the trigger at click time. */
export interface ConfirmRequest {
  // The question, shown and announced; a blank line in it renders as a paragraph break (pre-line).
  readonly message: string;
  // The action and its subject ("I applied (mark applied): Title at Company"), for the buttons' names:
  // every row has the same two buttons, so the row must be in the name.
  readonly action: string;
  // The guarded write. Called at most once, and only by Confirm.
  readonly onConfirm: () => void;
  // The button that opened the confirm, for focus on Cancel; null when there is none to return to.
  readonly trigger: HTMLElement | null;
}

// The one pending confirm in the app, keyed by the instance's id, or null when none is open.
let slot: { readonly id: string; readonly request: ConfirmRequest } | null = null;
// Every mounted InlineConfirm's re-render callback.
const listeners = new Set<() => void>();
// The layout effect in the browser; useEffect where there is no document (the static test renders),
// which runs neither and so skips React's "useLayoutEffect does nothing on the server" warning.
const useCommitEffect = typeof document === 'undefined' ? useEffect : useLayoutEffect;

/* Replaces the slot and tells every instance, so the one that lost the slot closes and the one that won it opens. */
function setSlot(next: typeof slot): void {
  // The new state first, so a listener reading it sees the change.
  slot = next;
  // Each instance re-reads its own pending request.
  for (const listener of listeners) listener();
}

/* useSyncExternalStore's subscribe: registers one instance, and its return unregisters it on unmount. */
function subscribe(listener: () => void): () => void {
  // Called on every slot change.
  listeners.add(listener);
  // React calls this on unmount.
  return () => {
    // No calls to an unmounted instance.
    listeners.delete(listener);
  };
}

/* Opens the confirm for instance `id`; any other open confirm closes, without moving focus. */
export function armConfirm(id: string, request: ConfirmRequest): void {
  // Replacing, not adding: one question at a time across the app.
  setSlot({ id, request });
}

/* The request open on instance `id`, or null. Returns the same object until the slot changes, which
   useSyncExternalStore requires of a snapshot. */
export function pendingConfirm(id: string): ConfirmRequest | null {
  // Only the owner sees its request; every other instance sees nothing open.
  return slot !== null && slot.id === id ? slot.request : null;
}

/* Confirm: runs the pending action once and closes. Returns false when nothing was open (a second click). */
export function confirmPending(id: string): boolean {
  // Read before clearing; the action needs it.
  const request = pendingConfirm(id);
  // Nothing open for this instance: a double click, or another confirm took the slot. No write.
  if (request === null) return false;
  // Emptied BEFORE the write, so a re-entrant or second click finds nothing to run.
  setSlot(null);
  // The one guarded write.
  request.onConfirm();
  // Tells a caller the write was started.
  return true;
}

/* Cancel: closes without writing. Returns what was open, so the caller can move focus back to its trigger. */
export function cancelPending(id: string): ConfirmRequest | null {
  // What was open on this instance, if anything.
  const request = pendingConfirm(id);
  // Only the owner's own confirm is closed; another instance's stays open.
  if (request !== null) setSlot(null);
  // onConfirm is deliberately never called here.
  return request;
}

/* Cancel and Escape: close, let the controls render visible again, then focus the trigger. */
function cancelAndRefocus(id: string): void {
  // Flushed, so the hidden controls are visible before focus(): a visibility:hidden button ignores focus().
  const request = flushSync(() => cancelPending(id));
  // Back to the button the operator started from, so a keyboard user does not land on <body>.
  request?.trigger?.focus();
}

/* Confirm and Cancel for one open request. Hook-free and exported, so a test calls these exact click
   handlers by value. */
export function ConfirmActions(props: {
  // The InlineConfirm instance this request belongs to.
  readonly id: string;
  // The open request; it names the buttons.
  readonly request: ConfirmRequest;
}): ReactElement {
  // Destructured once for the handlers below.
  const { id, request } = props;
  return (
    <div
      /* Side by side, wrapping in a narrow cell. */
      className="inline-confirm__actions"
      /* Escape is the universal cancel; caught here because focus is always on one of these two buttons. */
      onKeyDown={(e: KeyboardEvent<HTMLDivElement>) => {
        // Every other key keeps its meaning.
        if (e.key !== 'Escape') return;
        // Cancels the browser's own default; propagation is untouched, as DiffView's inline editor does.
        e.preventDefault();
        // Same path as the Cancel button, focus return included.
        cancelAndRefocus(id);
      }}
    >
      <button
        /* type=button: never a form submit. */
        type="button"
        /* The app's danger outline: both guarded writes have no undo. */
        className="button button--small button--reject"
        /* Starts with the visible word (label-in-name), then which action on which row. */
        aria-label={`Confirm: ${request.action}`}
        /* The only door to the write. */
        onClick={() => void confirmPending(id)}
      >
        {/* The visible word; the subject is in the sentence above it. */}
        Confirm
      </button>
      <button
        /* type=button: never a form submit. */
        type="button"
        /* Quieter than Confirm: the safe choice does not need to shout. */
        className="button button--small button--secondary"
        /* Same naming rule as Confirm. */
        aria-label={`Cancel: ${request.action}`}
        /* Focused when the confirm opens: the safe default for a write with no undo. React calls focus()
           when this button mounts, which is exactly when the confirm opens. */
        autoFocus
        /* Writes nothing; returns focus to the trigger. */
        onClick={() => cancelAndRefocus(id)}
      >
        {/* The visible word. */}
        Cancel
      </button>
    </div>
  );
}

/* Wraps the controls a confirm guards. A trigger inside calls armConfirm(id, ...); the question then
   shows in place of `children` until Confirm, Cancel or Escape. */
export function InlineConfirm(props: {
  // Unique among mounted instances: the slot is keyed by it.
  readonly id: string;
  // The guarded controls (and anything drawn with them), hidden while the confirm is open.
  readonly children: ReactNode;
}): ReactElement {
  // Destructured once so the effect depends on the id alone.
  const { id, children } = props;
  // This instance's open request, or null. The same read serves the server render, so a static test
  // render after armConfirm draws the armed state.
  const request = useSyncExternalStore(subscribe, () => pendingConfirm(id), () => pendingConfirm(id));
  // An instance that unmounts (its row was re-read away) must not leave a confirm that no one can see.
  useEffect(() => () => {
    // Closes only this instance's own confirm; no focus move, there is nothing left to focus.
    cancelPending(id);
  }, [id]);
  // The guarded controls' box, for the effect below.
  const controlsRef = useRef<HTMLDivElement>(null);
  /* Hide and show must be INSTANT. A guarded control with `transition: all` (19 rules in src, e.g.
     settings.css .answer-bank__action-btn) animates its inherited visibility: on Cancel it is still
     hidden at the moment focus() runs, so focus fell to <body> (e2e test 16, measured 2026-11-02);
     on arm it stays visible and clickable under the question for the transition's length. A layout
     effect runs inside the commit, so inside cancelAndRefocus's flushSync, before its focus(). */
  // Whether this instance has committed once. The mount commit toggles nothing (the controls start shown and
  // stay shown), so it has no visibility transition to finish. But getAnimations() forces a style recalc,
  // and a page draws many confirms (one per row): 68 ms of it on Answer bank alone (2026-11-08 profile).
  const committed = useRef(false);
  useCommitEffect(() => {
    // The mount commit: remembered, then skipped. Every later commit is an arm, cancel or confirm.
    if (!committed.current) { committed.current = true; return; }
    // Every animation under the controls; getAnimations() flushes pending style first, so the
    // transitions this commit just started are included.
    for (const animation of controlsRef.current?.getAnimations({ subtree: true }) ?? []) {
      // Only visibility transitions: hover colours and the like keep animating as designed.
      if (animation instanceof CSSTransition && animation.transitionProperty === 'visibility') animation.finish();
    }
  }, [request]);
  return (
    /* One grid cell for both layers: the cell is as tall as the taller one, so nothing below moves. */
    <div className="inline-confirm">
      {/* The guarded controls. Hidden, not removed, while asking: their box keeps the row's height, and
          visibility:hidden also takes them out of the tab order and the accessibility tree. */}
      <div ref={controlsRef} className={request === null ? 'inline-confirm__controls' : 'inline-confirm__controls inline-confirm__controls--hidden'}>
        {children}
      </div>
      {/* The question layer, stacked over the controls; always mounted for its live region. */}
      <div className="inline-confirm__panel">
        {/* Polite live region (see the header): empty while closed, the question while open. */}
        <p className="inline-confirm__sentence" aria-live="polite">
          {request?.message ?? ''}
        </p>
        {/* The two buttons, only while a question is open, so Cancel mounts (and takes focus) on open. */}
        {request !== null ? <ConfirmActions id={id} request={request} /> : null}
      </div>
    </div>
  );
}
