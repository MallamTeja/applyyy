/* API contract and endpoint validation tests for applyy web console.
 *
 * PURPOSE:
 * Verifies Supabase Auth, Supabase REST schemas, Gmail Sync Webhook API,
 * and ATS ingest endpoints against runtime contracts.
 *
 * HOUSE STYLE:
 * Explicit explanatory comments for every test case and assertion.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  formatSyncTime,
  GMAIL_SYNC_DEBOUNCE_MS,
  isInterviewEmail,
  shouldAutoSync,
  syncGmailInbox,
  type EmailEventRow,
  type GmailSyncClient,
} from '../src/features/emails/emailSync.ts';
import * as authModule from '../src/data/useAuth.ts';
import {
  formatAuthError,
  isSessionValid,
} from '../src/data/useAuth.ts';
import {
  APPLICATION_STATUSES,
  isTerminal,
  nextStatuses,
} from '../src/data/contract.ts';

describe('Supabase Auth API Contracts', () => {
  it('ships no default operator identity in the public bundle', () => {
    // The auth contract no longer carries an account address: identity is known
    // only after sign-in, so nothing pre-login can reveal which account exists.
    assert.equal('DEFAULT_OPERATOR_EMAIL' in authModule, false);
  });

  it('validates active JWT bearer sessions', () => {
    // Valid session structure with future expiration
    const futureTimestamp = Math.floor(Date.now() / 1000) + 3600;
    const validSession = {
      access_token: 'valid-jwt-token',
      token_type: 'bearer',
      expires_in: 3600,
      expires_at: futureTimestamp,
      refresh_token: 'valid-refresh-token',
      user: {
        id: '0f4b24da-e85b-40bb-8606-c81824493b45',
        aud: 'authenticated',
        role: 'authenticated',
        email: 'operator@example.test',
      },
    } as any;

    assert.equal(isSessionValid(validSession), true);
  });

  it('rejects expired or missing auth sessions', () => {
    // Expired timestamp
    const expiredSession = {
      access_token: 'expired-token',
      expires_at: 500,
      user: { id: 'usr-1' },
    } as any;
    assert.equal(isSessionValid(expiredSession, 1000), false);
    assert.equal(isSessionValid(null), false);
  });

  it('safely normalizes and formats authentication error payloads', () => {
    assert.equal(formatAuthError(null), 'An unknown authentication error occurred.');
    assert.equal(
      formatAuthError({ message: 'Invalid login credentials' }),
      'Invalid login credentials',
    );
    assert.equal(formatAuthError('Network timeout'), 'Network timeout');
  });
});

describe('Gmail Sync Edge-Function Contracts', () => {
  it('maps the gmail-sync response contract onto the closed outcome union', async () => {
    // One canned invoke per contract arm — the same seam double the unit tests use.
    const call = (result: { data: unknown; error: unknown }) => {
      const client: GmailSyncClient = { functions: { invoke: async () => result } };
      return syncGmailInbox(client);
    };
    // ok: true is the only success spelling.
    assert.equal((await call({ data: { ok: true }, error: null })).kind, 'ok');
    // cooldown: true is the server's "just ran" — not a failure.
    assert.equal((await call({ data: { ok: false, cooldown: true }, error: null })).kind, 'cooldown');
    // An invoke error (503 not-configured included) is the failed arm.
    assert.equal((await call({ data: null, error: new Error('non-2xx') })).kind, 'failed');
    // A malformed body fails closed rather than being guessed into a success.
    assert.equal((await call({ data: { ok: 'yes' }, error: null })).kind, 'failed');
  });

  it('enforces the once-a-minute on-open debounce (shouldAutoSync)', () => {
    const now = Date.now();

    // Sync 2 seconds ago: inside the minute, skip.
    assert.equal(shouldAutoSync(now - 2_000, now), false);

    // Sync exactly one window ago: allowed again.
    assert.equal(shouldAutoSync(now - GMAIL_SYNC_DEBOUNCE_MS, now), true);

    // Never synced: always allowed.
    assert.equal(shouldAutoSync(null, now), true);
  });

  it('formats sync timestamps into human-readable relative/absolute descriptions', () => {
    assert.equal(formatSyncTime(null), 'Not checked yet');
    const recent = Date.now() - 2000;
    assert.ok(formatSyncTime(recent).length > 0);
  });

  it('filters strictly interview email events from raw ingestion payloads', () => {
    // Valid interview event
    const interviewRow: EmailEventRow = {
      id: 'ev-1',
      user_id: 'usr-1',
      provider: 'gmail',
      provider_message_id: 'msg-1',
      received_at: '2026-09-12T10:00:00Z',
      from_address: 'recruiter@stripe.com',
      subject: 'Invitation to Technical Interview - Full Stack Engineer',
      snippet: 'We would love to schedule a 45-minute technical conversation.',
      matched_application_id: 'app-1',
      created_at: '2026-09-12T10:01:00Z',
    };
    assert.equal(isInterviewEmail(interviewRow), true);

    // Newsletter / spam event (must be filtered out)
    const spamRow: EmailEventRow = {
      id: 'ev-2',
      user_id: 'usr-1',
      provider: 'gmail',
      provider_message_id: 'msg-2',
      received_at: '2026-09-12T10:00:00Z',
      from_address: 'updates@linkedin.com',
      subject: 'Top jobs for you this week',
      snippet: 'Here are new job listings matching your preferences.',
      matched_application_id: null,
      created_at: '2026-09-12T10:01:00Z',
    };
    assert.equal(isInterviewEmail(spamRow), false);
  });
});

describe('Pipeline Status Graph & Human Lane Transitions', () => {
  it('covers all discrete application lifecycle statuses', () => {
    assert.equal(APPLICATION_STATUSES.length, 21);
    assert.ok(APPLICATION_STATUSES.includes('discovered'));
    assert.ok(APPLICATION_STATUSES.includes('awaiting_approval'));
    assert.ok(APPLICATION_STATUSES.includes('applying'));
    assert.ok(APPLICATION_STATUSES.includes('applied'));
    assert.ok(APPLICATION_STATUSES.includes('interview'));
  });

  it('correctly partitions terminal vs non-terminal pipeline stages', () => {
    assert.equal(isTerminal('offer'), true);
    assert.equal(isTerminal('rejected'), true);
    // Not terminal since 2026-10-31: a pasted link re-adds a dropped job (dropped_filter -> passed_filters).
    assert.equal(isTerminal('dropped_filter'), false);
    // dropped_duplicate still has no way out.
    assert.equal(isTerminal('dropped_duplicate'), true);
    assert.equal(isTerminal('awaiting_approval'), false);
    assert.equal(isTerminal('interview'), false);
  });

  it('permits human intervention moves for blocked and interview stages', () => {
    const blockedMoves = nextStatuses('blocked_needs_human', 'human');
    assert.ok(blockedMoves.includes('applied') || blockedMoves.includes('dropped_filter'));

    const interviewMoves = nextStatuses('interview', 'human');
    assert.ok(interviewMoves.includes('offer') || interviewMoves.includes('rejected') || interviewMoves.includes('oa_pending'));
  });
});
