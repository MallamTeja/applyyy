/* Email Sync and Interview Helper Utilities.
 *
 * PURPOSE:
 * Provides pure logic and the edge-function call for triggering on-demand Gmail sync
 * when the operator opens the Email Monitoring screen or clicks "Refresh Interviews".
 *
 * ZERO CRON INVARIANT:
 * Replaces continuous 15-minute background polling triggers with on-demand sync.
 * Prevents quota exhaustion and ensures fresh email intake without delay.
 *
 * TRANSPORT (changed 2026-10-23, Teja's ruling): the sync is the `gmail-sync` edge
 * function, invoked with the session JWT like every other function this app calls.
 * The earlier bare-GET Apps Script webhook path (VITE_EMAIL_SYNC_WEBHOOK_URL plus a
 * localStorage URL the settings drawer edited) is REMOVED with its only caller — an
 * unauthenticated URL in localStorage was a weaker contract than the JWT the rest of
 * the app already holds.
 */

/* Storage key for the instant the last sync call STARTED (ms since epoch, as a string); stamped at the call, not on success (P3 #3).
   localStorage rather than state so the once-a-minute cap survives route changes. */
export const GMAIL_SYNC_LAST_MS_KEY = 'applyy_gmail_sync_last_ms';

/* The on-open debounce window Teja ruled: at most one auto-sync per minute.
   ADVISORY ONLY — the gmail-sync function's own cooldown is the authoritative gate. */
export const GMAIL_SYNC_DEBOUNCE_MS = 60_000;

/* The email_events row comes from the schema seam, never a local copy (W21, 2026-11-02).
   The copy that lived here typed `classification` as `string`, so isInterviewEmail could
   compare it to 'interview' — a value the enum does not have — and tsc said nothing.
   Imported for this file's own use, and re-exported so EmailMonitoringPage's existing
   `import { type EmailEventRow } from './emailSync.ts'` keeps resolving to the shared one. */
import type { EmailEventRow } from '../../data/contract.ts';
// Every browser edge call goes through it: a revoked session refreshes once, else signs out with a plain sentence.
import { invokeEdge, type EdgeClient } from '../../data/edgeCall.ts';
export type { EmailEventRow };

/* The sync outcomes the page renders — a closed union, not a boolean pair, so the
   "skipped because it just ran" case can never be conflated with success or failure. */
export type GmailSyncOutcome =
  /* The function ran a sync (or had nothing new); events may have changed. */
  | { readonly kind: 'ok' }
  /* The function refused because ITS cooldown is active — normal, not an error. */
  | { readonly kind: 'cooldown' }
  /* Anything else: not configured (503), auth, network, malformed body. Events shown
     from the store are still valid, just possibly stale — the page must say so quietly
     and render them anyway. */
  | { readonly kind: 'failed'; readonly message: string };

/* The slice of supabase-js the sync needs; injected so tests never touch a network.
   Same seam shape as pipelineRunner's FunctionsInvoker. */
export type GmailSyncClient = EdgeClient;

/**
 * Decide whether the on-open auto-sync should call the function at all.
 * PURE — the clock is a parameter — so the one-minute boundary is testable exactly.
 * Advisory only: a stale or cleared timestamp just means one extra call, which the
 * server-side cooldown absorbs; it can never cause a double send of anything.
 */
export function shouldAutoSync(lastSyncMs: number | null, nowMs: number, debounceMs: number = GMAIL_SYNC_DEBOUNCE_MS): boolean {
  /* Never synced (or storage unreadable): go. */
  if (lastSyncMs === null) return true;
  /* A FUTURE timestamp is garbage (clock change, hand-edited storage): treat as never
     synced rather than silently skipping syncs until the clock catches up. */
  if (lastSyncMs > nowMs) return true;
  /* Inside the window: skip; at or past it: go. */
  return nowMs - lastSyncMs >= debounceMs;
}

/**
 * Read the last-sync instant from storage. SHAPE-CHECKED (CLAUDE.md §6): only a
 * non-empty all-digits string becomes a number — `Number('')` is 0 and would read as
 * "synced in 1970", which shouldAutoSync would then treat as long-ago and always sync.
 * Any unreadable or odd value is null ("never synced"), the fail-open that only costs
 * one extra server-absorbed call.
 */
export function readLastGmailSyncMs(storage: Pick<Storage, 'getItem'> | undefined): number | null {
  try {
    /* The raw stored string, or null when the key is absent. An undefined storage
       (SSR, node tests) falls into the catch via the property access and reads null. */
    const raw = storage!.getItem(GMAIL_SYNC_LAST_MS_KEY);
    /* Digits only — rejects '', '-5', '1.5e3' and anything hand-mangled. */
    if (raw === null || !/^[0-9]{1,16}$/.test(raw)) return null;
    return Number(raw);
  } catch {
    /* Blocked storage (private mode, locked-down profile) throws; the page must work. */
    return null;
  }
}

/** Record a successful sync instant; a blocked storage write is silently fine. */
export function writeLastGmailSyncMs(storage: Pick<Storage, 'setItem'> | undefined, nowMs: number): void {
  try {
    storage!.setItem(GMAIL_SYNC_LAST_MS_KEY, String(nowMs));
  } catch {
    /* Advisory cap only: losing the write means one extra call next visit, nothing worse. */
  }
}

/**
 * Call the gmail-sync edge function as the signed-in user.
 * `invoke` attaches the session JWT (the same pattern every other function call in
 * this app uses), so no header is built by hand. Contract (fixed by the function):
 * `{ ok: boolean, cooldown?: boolean, details?: unknown, error?: string }`.
 * Never throws; every path collapses into the closed GmailSyncOutcome union, and the
 * body is SHAPE-CHECKED — a malformed answer is 'failed', never a guessed success.
 */
export async function syncGmailInbox(client: GmailSyncClient): Promise<GmailSyncOutcome> {
  /* Declared here so both the error and the shape branches can read it. */
  let data: unknown;
  let error: unknown;
  try {
    /* POST with an empty body; the function reads everything from the JWT. */
    const answer = await invokeEdge(client, 'gmail-sync', { body: {} });
    /* The session is gone and this browser is signed out (the app then shows sign-in): the quiet
       status line gets the plain sentence; the stored events stay on screen as for any failure. */
    if (answer.kind === 'signed_out') return { kind: 'failed', message: answer.message };
    /* The function answered: its own data and error. */
    ({ data, error } = answer);
  } catch (err) {
    /* supabase-js reports failures in `error`, not by throwing — but a seam double or a
       network layer might throw anyway, and a gate that can crash its caller gets
       wrapped in a try/catch that swallows it. */
    return { kind: 'failed', message: err instanceof Error ? err.message : 'gmail-sync call threw' };
  }
  if (error) {
    /* A non-2xx (the 503 "not configured" case included) lands here. The message is for
       the quiet status line only; the status line never blocks the stored events. */
    const message = error instanceof Error ? error.message : 'gmail-sync returned an error';
    return { kind: 'failed', message };
  }
  /* Only an object body can carry the contract. */
  const body = typeof data === 'object' && data !== null ? (data as { ok?: unknown; cooldown?: unknown; error?: unknown }) : null;
  /* Exact true, not truthiness — `cooldown: "no"` must not read as a cooldown. */
  if (body?.cooldown === true) return { kind: 'cooldown' };
  if (body?.ok === true) return { kind: 'ok' };
  /* ok !== true: the function's own error string when it sent one, else a fixed phrase. */
  return { kind: 'failed', message: typeof body?.error === 'string' ? body.error : 'gmail-sync answered with an unexpected shape' };
}

/**
 * Formats the last sync timestamp into a readable label.
 */
export function formatSyncTime(timestamp: number | null): string {
  if (timestamp === null) {
    return 'Not checked yet';
  }
  const date = new Date(timestamp);
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

/**
 * Pure helper: determines if an inbound email represents a legitimate interview invitation.
 * Rejects newsletters, security alerts, and social digests outright.
 */
export function isInterviewEmail(ev: EmailEventRow): boolean {
  /* 1. Explicit classifier positive match. `interview_invite` is the ONLY interview value
     in the enum; the former `|| === 'interview'` branch could never match, and with the
     shared closed union it no longer compiles (TS2367). */
  if (ev.classification === 'interview_invite') {
    return true;
  }

  /* 2. Disqualify known system and social senders */
  const fromLower = ev.from_address.toLowerCase();
  if (
    fromLower.includes('no-reply@accounts.google.com') ||
    fromLower.includes('redditmail.com') ||
    fromLower.includes('updates-noreply@linkedin.com') ||
    fromLower.includes('messages-noreply@linkedin.com') ||
    fromLower.includes('notifications@') ||
    fromLower.includes('security-noreply')
  ) {
    return false;
  }

  /* 3. Disqualify obvious automated newsletters by subject */
  const subjectLower = ev.subject.toLowerCase();
  if (
    subjectLower.includes('security alert') ||
    subjectLower.includes('digest') ||
    subjectLower.includes('new sign-in') ||
    subjectLower.includes('passkey added')
  ) {
    return false;
  }

  /* 4. Detect interview invitation intent in subject or body snippet */
  const content = (ev.subject + ' ' + ev.snippet).toLowerCase();
  return (
    content.includes('interview') ||
    content.includes('invitation to interview') ||
    content.includes('screening call') ||
    content.includes('schedule a call') ||
    content.includes('schedule a chat') ||
    content.includes('technical round') ||
    content.includes('hiring manager chat') ||
    content.includes('shortlisted')
  );
}

/* The quiet one-line status the page shows beside the list, one phrase per state.
   PURE so the wording is pinned by a test, not scattered through JSX. `idle` renders
   nothing. Failure wording says the EVENTS are fine, only possibly stale — a failed
   sync must never read like a failed page. */
export function syncStatusLine(state: 'idle' | 'syncing' | 'ok' | 'cooldown' | 'failed'): string | null {
  switch (state) {
    /* Nothing to say before the first attempt of this visit. */
    case 'idle':
      return null;
    case 'syncing':
      return 'syncing inbox…';
    case 'ok':
      return 'inbox synced';
    /* Both the client debounce and the server cooldown read as the same quiet skip. */
    case 'cooldown':
      return 'sync skipped (just ran)';
    case 'failed':
      return 'sync failed — events may be stale';
  }
}
