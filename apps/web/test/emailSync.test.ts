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
// The shared edge-client double, typed against the real EdgeClient so its shape cannot drift (W36).
import { fakeEdgeClient } from './support/fakeEdgeClient.ts';

import {
  formatSyncTime,
  GMAIL_SYNC_DEBOUNCE_MS,
  GMAIL_SYNC_LAST_MS_KEY,
  isInterviewEmail,
  readLastGmailSyncMs,
  shouldAutoSync,
  syncGmailInbox,
  syncStatusLine,
  writeLastGmailSyncMs,
  type EmailEventRow,
  type GmailSyncClient,
} from '../src/features/emails/emailSync.ts';

/* A GmailSyncClient double returning one canned invoke result — the same seam shape
   pipelineRunner tests use; no network, no supabase. */
const fakeClient = (result: { data: unknown; error: unknown }): GmailSyncClient => fakeEdgeClient(async () => result);

describe('emailSync helpers', () => {
  describe('shouldAutoSync — the once-a-minute on-open debounce', () => {
    // A pinned clock so the 60s boundary is asserted exactly, never raced.
    const NOW = 10_000_000;

    it('REGRESSION: skips inside the window, syncs at and past the boundary', () => {
      // 1ms into the window: skip.
      assert.equal(shouldAutoSync(NOW - 1, NOW), false);
      // One ms short of the full minute: still skip.
      assert.equal(shouldAutoSync(NOW - (GMAIL_SYNC_DEBOUNCE_MS - 1), NOW), false);
      // Exactly 60s: sync (>= boundary, so the cap is one-per-minute, not one-per-61s).
      assert.equal(shouldAutoSync(NOW - GMAIL_SYNC_DEBOUNCE_MS, NOW), true);
      // Well past: sync.
      assert.equal(shouldAutoSync(NOW - GMAIL_SYNC_DEBOUNCE_MS * 5, NOW), true);
    });

    it('never synced (null) and garbage future timestamps both mean sync', () => {
      // No record: first visit, go.
      assert.equal(shouldAutoSync(null, NOW), true);
      // A future instant is a mangled clock or storage, not a reason to stop syncing.
      assert.equal(shouldAutoSync(NOW + 5_000, NOW), true);
    });
  });

  describe('readLastGmailSyncMs — shape-checked storage read', () => {
    // A Map-backed storage double, the repo's standard trick for node tests.
    const storageWith = (value: string | null): Pick<Storage, 'getItem'> => ({
      getItem: (key) => (key === GMAIL_SYNC_LAST_MS_KEY ? value : null),
    });

    it('REGRESSION: a non-digit or empty value reads as null, never as a number', () => {
      // CLAUDE.md §6: Number('') is 0, which would read as "synced in 1970" = always resync
      // — and worse, '-5' or garbage must not become an instant either.
      for (const bad of ['', '-5', '1.5', 'yesterday', '1e9', ' 123 ']) {
        assert.equal(readLastGmailSyncMs(storageWith(bad)), null, JSON.stringify(bad));
      }
    });

    it('a plain digits value round-trips through write and read', () => {
      // One Map-backed store shared by both helpers.
      const map = new Map<string, string>();
      const store = { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => void map.set(k, v) };
      writeLastGmailSyncMs(store, 1_730_000_000_000);
      assert.equal(readLastGmailSyncMs(store), 1_730_000_000_000);
    });

    it('a throwing or absent storage reads null and never throws', () => {
      // Safari private mode and locked-down profiles THROW on access; the page must work.
      const throwing: Pick<Storage, 'getItem'> = { getItem: () => { throw new Error('blocked'); } };
      assert.equal(readLastGmailSyncMs(throwing), null);
      // SSR / node: no storage object at all.
      assert.equal(readLastGmailSyncMs(undefined), null);
      // Writes are equally silent.
      writeLastGmailSyncMs(undefined, 123);
    });
  });

  describe('syncGmailInbox — the gmail-sync edge call, outcomes only', () => {
    it('ok: true becomes the ok outcome', async () => {
      const outcome = await syncGmailInbox(fakeClient({ data: { ok: true, details: { ingested: 2 } }, error: null }));
      assert.equal(outcome.kind, 'ok');
    });

    it('cooldown: true wins even alongside ok, and reads as the quiet skip', async () => {
      // The server saying "just ran" is not a success to re-render around.
      const outcome = await syncGmailInbox(fakeClient({ data: { ok: false, cooldown: true }, error: null }));
      assert.equal(outcome.kind, 'cooldown');
    });

    it('an invoke error (the 503 not-configured case) is the failed outcome', async () => {
      const outcome = await syncGmailInbox(fakeClient({ data: null, error: new Error('Edge Function returned a non-2xx status code') }));
      assert.equal(outcome.kind, 'failed');
      if (outcome.kind === 'failed') assert.match(outcome.message, /non-2xx/);
    });

    it('REGRESSION: a malformed body fails closed, never a guessed success', async () => {
      // Every shape that is not exactly ok === true must land in failed (or cooldown
      // only on exactly cooldown === true) — truthiness is how "ok": "no" becomes a sync.
      for (const data of [null, 'done', 42, {}, { ok: 'true' }, { ok: 1 }, { cooldown: 'yes' }]) {
        const outcome = await syncGmailInbox(fakeClient({ data, error: null }));
        assert.equal(outcome.kind, 'failed', JSON.stringify(data));
      }
    });

    it('a throwing client double is contained as failed, not propagated', async () => {
      const throwing: GmailSyncClient = fakeEdgeClient(async () => { throw new Error('boom'); });
      const outcome = await syncGmailInbox(throwing);
      assert.equal(outcome.kind, 'failed');
    });
  });

  describe('syncStatusLine — the one quiet line the page shows', () => {
    it('each state has its ruled phrase; idle renders nothing', () => {
      assert.equal(syncStatusLine('idle'), null);
      assert.equal(syncStatusLine('syncing'), 'syncing inbox…');
      assert.equal(syncStatusLine('ok'), 'inbox synced');
      assert.equal(syncStatusLine('cooldown'), 'sync skipped (just ran)');
      // The failure wording must say the EVENTS are fine — stale at worst.
      assert.equal(syncStatusLine('failed'), 'sync failed — events may be stale');
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
      // The four columns EmailEventRow gained after this fixture was written (thread/To/labels in
      // migration 20260918213000, read_at in 20261105124600). null is a real row's value when the
      // script sent none / the email is unread, and isInterviewEmail reads none of them.
      thread_id: null,
      // No To header captured.
      recipient_to: null,
      // No Gmail labels captured.
      label_ids: null,
      // Unread in the app.
      read_at: null,
    };

    it('accepts explicit classification matches', () => {
      assert.equal(isInterviewEmail({ ...baseRow, classification: 'interview_invite' }), true);
      // No `classification: 'interview'` case (W21, 2026-11-02): that value is not in
      // EMAIL_CLASSIFICATIONS, so the old assertion pinned a dead branch. It passed only
      // because the subject says "Interview". tsc now rejects the literal in src.
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

  describe('a failed sync never blocks the stored events (page wiring)', () => {
    // SSR cannot run useEffect (see discoveredJobsLoadError.test.ts for the precedent),
    // so this pins the wiring by the page's own source text — brittle on rewrites, but
    // the properties asserted are exactly the safety contract.
    it('REGRESSION: events are fetched before any sync decision, and a failure only sets the quiet state', async () => {
      const { readFileSync } = await import('node:fs');
      const source = readFileSync('src/features/emails/EmailMonitoringPage.tsx', 'utf8');
      // The fetch of stored events is the FIRST act of performSync, before every gate.
      assert.match(source, /await fetchEvents\(\);\s*\n\s*\/\/ No client, no call/);
      // The failed branch sets the quiet status pair and nothing else: no setError, no
      // setEvents, so the rendered list is untouched by a sync failure.
      const failedBranch = source.match(/\/\/ Failed \(503 not-configured included\)[\s\S]*?setSyncDetail\(outcome\.message\);/)?.[0] ?? '';
      assert.notEqual(failedBranch, '', 'the failed branch must exist');
      assert.doesNotMatch(failedBranch, /setError|setEvents/);
      // The sync failure renders through the muted one-liner, not the error banner.
      assert.match(source, /syncStatusLine\(syncState\)/);
    });
  });
});
