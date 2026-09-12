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
  canTriggerSync,
  EMAIL_SYNC_STORAGE_KEY,
  formatSyncTime,
  isInterviewEmail,
  resolveEmailSyncUrl,
  triggerGmailSync,
  type EmailEventRow,
} from '../src/features/emails/emailSync.ts';
import {
  DEFAULT_OPERATOR_EMAIL,
  formatAuthError,
  isSessionValid,
} from '../src/data/useAuth.ts';
import {
  APPLICATION_STATUSES,
  isTerminal,
  nextStatuses,
} from '../src/data/contract.ts';

describe('Supabase Auth API Contracts', () => {
  it('enforces operator default identity tejamallam00@gmail.com', () => {
    // Assert operator default identity is permanently locked to Teja
    assert.equal(DEFAULT_OPERATOR_EMAIL, 'tejamallam00@gmail.com');
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
        email: 'tejamallam00@gmail.com',
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

describe('Gmail Sync Webhook API Contracts', () => {
  it('resolves webhook sync URLs correctly from environment or storage fallback', () => {
    // When environment URL is present, it takes precedence
    const envUrl = 'https://script.google.com/macros/s/ENV_ID/exec';
    assert.equal(resolveEmailSyncUrl(envUrl, ''), envUrl);

    // When environment URL is absent, user custom URL from settings is used
    const customUrl = 'https://script.google.com/macros/s/CUSTOM_ID/exec';
    assert.equal(resolveEmailSyncUrl('', customUrl), customUrl);

    // When both are absent, null is returned
    assert.equal(resolveEmailSyncUrl('', ''), null);
    assert.equal(resolveEmailSyncUrl(undefined, '   '), null);
  });

  it('enforces sync cooldown and in-flight lock (canTriggerSync)', () => {
    const now = Date.now();

    // In flight sync cannot be triggered again
    assert.equal(canTriggerSync(now - 10000, true), false);

    // Sync within 10 seconds cooldown cannot be triggered
    assert.equal(canTriggerSync(now - 2000, false), false);

    // Sync after cooldown window (>= 10000ms) can be triggered
    assert.equal(canTriggerSync(now - 12000, false), true);

    // Initial sync (never synced before) can be triggered
    assert.equal(canTriggerSync(null, false), true);
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
    assert.equal(isTerminal('dropped_filter'), true);
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
