/* Email Sync and Interview Helper Utilities.
 *
 * PURPOSE:
 * Provides pure logic and client fetch routines for triggering on-demand Gmail sync
 * when the operator opens the Email Monitoring screen or clicks "Refresh Interviews".
 *
 * ZERO CRON INVARIANT:
 * Replaces continuous 15-minute background polling triggers with on-demand sync.
 * Prevents quota exhaustion and ensures fresh email intake without delay.
 */

/* Storage key for user-configured Apps Script Web App or webhook URL */
export const EMAIL_SYNC_STORAGE_KEY = 'applyy_email_sync_url';

/* Default minimum cooldown between sync requests to avoid lock collisions (10 seconds) */
export const DEFAULT_SYNC_COOLDOWN_MS = 10_000;

/* Data model matching the public.email_events schema */
export interface EmailEventRow {
  readonly id: string;
  readonly user_id: string;
  readonly provider_message_id: string;
  readonly from_address: string;
  readonly subject: string;
  readonly snippet: string;
  readonly received_at: string;
  readonly classification: string;
  readonly classification_confidence: number | null;
  readonly matched_application_id: string | null;
  readonly processed_at: string | null;
  readonly created_at: string;
}

/* Result shape for on-demand sync invocation */
export interface SyncResult {
  readonly ok: boolean;
  readonly message: string;
  readonly data?: unknown;
}

/**
 * Resolves the active sync URL from environment variables or localStorage.
 * Trims leading/trailing whitespace and filters out blank values.
 */
export function resolveEmailSyncUrl(envUrl?: string | null, storageUrl?: string | null): string | null {
  if (typeof envUrl === 'string' && envUrl.trim() !== '') {
    return envUrl.trim();
  }
  if (typeof storageUrl === 'string' && storageUrl.trim() !== '') {
    return storageUrl.trim();
  }
  return null;
}

/**
 * Determines whether an on-demand sync request can be safely triggered.
 * Enforces:
 *  1. No concurrent sync already in flight.
 *  2. Minimum cooldown window since last completed sync.
 */
export function canTriggerSync(
  lastSyncedAt: number | null,
  isSyncing: boolean,
  cooldownMs: number = DEFAULT_SYNC_COOLDOWN_MS,
  currentTime: number = Date.now(),
): boolean {
  if (isSyncing) {
    return false;
  }
  if (lastSyncedAt === null) {
    return true;
  }
  return currentTime - lastSyncedAt >= cooldownMs;
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
  /* 1. Explicit classifier positive match */
  if (ev.classification === 'interview_invite' || ev.classification === 'interview') {
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

/**
 * Triggers on-demand Gmail sync via HTTP fetch.
 * Follows redirects (as Google Apps Script Web Apps redirect 302 to script.googleusercontent.com).
 * Includes timeout guard via AbortController.
 */
export async function triggerGmailSync(
  syncUrl: string,
  timeoutMs: number = 15_000,
  fetchFn: typeof fetch = globalThis.fetch,
): Promise<SyncResult> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchFn(syncUrl, {
      method: 'GET',
      redirect: 'follow',
      headers: {
        Accept: 'application/json',
      },
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      return {
        ok: false,
        message: `Sync service responded with HTTP status ${response.status} (${response.statusText}).`,
      };
    }

    try {
      const data = (await response.json()) as unknown;
      return {
        ok: true,
        message: 'Gmail on-demand sync completed successfully.',
        data,
      };
    } catch {
      // If response body is not JSON, treat successful HTTP status as OK
      return {
        ok: true,
        message: 'Gmail on-demand sync triggered.',
      };
    }
  } catch (err) {
    clearTimeout(timeoutId);
    if (err instanceof Error && err.name === 'AbortError') {
      return {
        ok: false,
        message: `Sync timed out after ${Math.round(timeoutMs / 1000)} seconds.`,
      };
    }
    return {
      ok: false,
      message: err instanceof Error ? err.message : 'Network error communicating with Gmail sync service.',
    };
  }
}
