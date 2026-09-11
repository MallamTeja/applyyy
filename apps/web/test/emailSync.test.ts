/* Unit tests for on-demand email sync and interview detection helpers.
 *
 * PURPOSE:
 * Verifies that sync URL resolution, cooldown gates, formatting, interview classification,
 * and fetch triggering behave deterministically without regressions.
 *
 * HOUSE STYLE:
 * Explicit comments on each assertion explaining the invariant under test.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  canTriggerSync,
  DEFAULT_SYNC_COOLDOWN_MS,
  formatSyncTime,
  isInterviewEmail,
  resolveEmailSyncUrl,
  triggerGmailSync,
  type EmailEventRow,
} from '../src/features/emails/emailSync.ts';

describe('emailSync helpers', () => {
  describe('resolveEmailSyncUrl', () => {
    it('prioritizes envUrl when both env and storage URLs are present', () => {
      const result = resolveEmailSyncUrl('https://env.example.com/sync', 'https://storage.example.com/sync');
      assert.equal(result, 'https://env.example.com/sync');
    });

    it('falls back to storageUrl when envUrl is absent or blank', () => {
      const resultFromUndefined = resolveEmailSyncUrl(undefined, 'https://storage.example.com/sync');
      assert.equal(resultFromUndefined, 'https://storage.example.com/sync');

      const resultFromBlank = resolveEmailSyncUrl('   ', 'https://storage.example.com/sync');
      assert.equal(resultFromBlank, 'https://storage.example.com/sync');
    });

    it('returns null when neither URL is provided', () => {
      assert.equal(resolveEmailSyncUrl(undefined, undefined), null);
      assert.equal(resolveEmailSyncUrl('', ''), null);
      assert.equal(resolveEmailSyncUrl('  ', '   '), null);
    });

    it('trims whitespace cleanly', () => {
      assert.equal(resolveEmailSyncUrl('  https://env.example.com/sync  '), 'https://env.example.com/sync');
      assert.equal(resolveEmailSyncUrl(undefined, '  https://storage.example.com/sync  '), 'https://storage.example.com/sync');
    });
  });

  describe('canTriggerSync cooldown and lock check', () => {
    it('refuses to trigger if a sync is already in flight', () => {
      // Regardless of cooldown, a running sync must block another trigger
      assert.equal(canTriggerSync(null, true), false);
      assert.equal(canTriggerSync(Date.now() - 100_000, true), false);
    });

    it('permits initial sync when lastSyncedAt is null', () => {
      // First run on page mount should always proceed
      assert.equal(canTriggerSync(null, false), true);
    });

    it('enforces the minimum cooldown window', () => {
      const now = 1_000_000;
      const cooldown = DEFAULT_SYNC_COOLDOWN_MS; // 10,000ms

      // 5 seconds ago: still in cooldown
      assert.equal(canTriggerSync(now - 5_000, false, cooldown, now), false);

      // 9.999 seconds ago: still in cooldown
      assert.equal(canTriggerSync(now - 9_999, false, cooldown, now), false);

      // Exactly at cooldown boundary: allowed
      assert.equal(canTriggerSync(now - 10_000, false, cooldown, now), true);

      // 20 seconds ago: allowed
      assert.equal(canTriggerSync(now - 20_000, false, cooldown, now), true);
    });
  });

  describe('formatSyncTime', () => {
    it('returns placeholder when timestamp is null', () => {
      assert.equal(formatSyncTime(null), 'Not checked yet');
    });

    it('formats valid timestamp into localized time string', () => {
      const timeStr = formatSyncTime(1726074000000);
      assert.ok(typeof timeStr === 'string' && timeStr.length > 0);
    });
  });

  describe('isInterviewEmail classification filter', () => {
    const baseRow: EmailEventRow = {
      id: 'row-1',
      user_id: 'user-1',
      provider_message_id: 'msg-1',
      from_address: 'recruiter@techcorp.com',
      subject: 'Interview Invitation: Senior Software Engineer',
      snippet: 'We would love to schedule a screening call with our engineering lead.',
      received_at: '2026-09-11T12:00:00Z',
      classification: 'unclassified',
      classification_confidence: null,
      matched_application_id: null,
      processed_at: null,
      created_at: '2026-09-11T12:00:00Z',
    };

    it('accepts explicit classification matches', () => {
      assert.equal(isInterviewEmail({ ...baseRow, classification: 'interview_invite' }), true);
      assert.equal(isInterviewEmail({ ...baseRow, classification: 'interview' }), true);
    });

    it('rejects automated system and social notification senders', () => {
      assert.equal(isInterviewEmail({ ...baseRow, from_address: 'no-reply@accounts.google.com' }), false);
      assert.equal(isInterviewEmail({ ...baseRow, from_address: 'digest@redditmail.com' }), false);
      assert.equal(isInterviewEmail({ ...baseRow, from_address: 'updates-noreply@linkedin.com' }), false);
      assert.equal(isInterviewEmail({ ...baseRow, from_address: 'messages-noreply@linkedin.com' }), false);
      assert.equal(isInterviewEmail({ ...baseRow, from_address: 'notifications@github.com' }), false);
      assert.equal(isInterviewEmail({ ...baseRow, from_address: 'security-noreply@service.com' }), false);
    });

    it('rejects security alerts and newsletters by subject', () => {
      assert.equal(isInterviewEmail({ ...baseRow, subject: 'Security alert: new sign-in detected' }), false);
      assert.equal(isInterviewEmail({ ...baseRow, subject: 'Your weekly digest of top stories' }), false);
      assert.equal(isInterviewEmail({ ...baseRow, subject: 'New passkey added to your account' }), false);
    });

    it('detects interview intent keywords in subject and snippet', () => {
      assert.equal(isInterviewEmail({ ...baseRow, subject: 'Invitation to interview at Stripe' }), true);
      assert.equal(isInterviewEmail({ ...baseRow, subject: 'Technical round schedule', snippet: 'Please pick a slot' }), true);
      assert.equal(isInterviewEmail({ ...baseRow, subject: 'Next steps for your application', snippet: 'We would like to schedule a screening call' }), true);
      assert.equal(isInterviewEmail({ ...baseRow, subject: 'Hiring manager chat', snippet: 'Available next Tuesday?' }), true);
      assert.equal(isInterviewEmail({ ...baseRow, subject: 'Update on role', snippet: 'You have been shortlisted for the position' }), true);
    });

    it('rejects generic emails lacking interview keywords', () => {
      assert.equal(isInterviewEmail({ ...baseRow, subject: 'Receipt for your subscription', snippet: 'Thank you for your payment of $10.' }), false);
    });
  });

  describe('triggerGmailSync network fetch', () => {
    it('returns ok: true when fetch succeeds with 200 JSON', async () => {
      const mockFetch: typeof fetch = async () => {
        return new Response(JSON.stringify({ ok: true, message: 'Sync done', data: { ingested: 2 } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      };

      const result = await triggerGmailSync('https://script.google.com/sync', 5000, mockFetch);
      assert.equal(result.ok, true);
      assert.equal(result.message, 'Gmail on-demand sync completed successfully.');
    });

    it('returns ok: false when endpoint returns HTTP error code', async () => {
      const mockFetch: typeof fetch = async () => {
        return new Response('Unauthorized', { status: 401, statusText: 'Unauthorized' });
      };

      const result = await triggerGmailSync('https://script.google.com/sync', 5000, mockFetch);
      assert.equal(result.ok, false);
      assert.ok(result.message.includes('401'));
    });

    it('handles network failure gracefully', async () => {
      const mockFetch: typeof fetch = async () => {
        throw new Error('Failed to fetch');
      };

      const result = await triggerGmailSync('https://script.google.com/sync', 5000, mockFetch);
      assert.equal(result.ok, false);
      assert.equal(result.message, 'Failed to fetch');
    });
  });
});
