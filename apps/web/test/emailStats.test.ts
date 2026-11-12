/* The Emails page's analytics (Teja, 2026-11-12 12:41 IST: "i need more anyticks , numbers abt my mails to uderstand
 * more abt them"). Pure numbers over the stored rows, so every figure on screen is pinned here.
 *
 * THE TRAP THIS FILE GUARDS: mail Teja sent himself (replies, forwards) used to be counted as rejections (5 stored
 * "rejections" were really 1 on 2026-11-12). ffa32af keeps such mail unclassified, but the signal is not stored, so the
 * page must recognise owner-sent mail itself, by sender, and keep it out of every employer figure. */
// Strict asserts.
import assert from 'node:assert/strict';
// node:test, like every web test.
import { describe, it } from 'node:test';
// The module under test.
import { companyOf, computeEmailStats, isOwnerSent, istWeekStart } from '../src/features/emails/emailStats.ts';
// The card's time wording (2026-11-12).
import { formatReceivedAt } from '../src/features/emails/emailView.ts';
// Type only: the row shape.
import type { EmailEventRow } from '../src/features/emails/emailSync.ts';

// One stored email; `over` replaces fields.
const row = (over: Partial<EmailEventRow>): EmailEventRow => ({
  // A fixed id; tests that need several pass their own.
  id: 'e0000000-0000-4000-8000-000000000000',
  // The owner.
  user_id: 'u',
  // Gmail's id.
  provider_message_id: 'm',
  // An employer by default.
  from_address: 'Acme Recruiting <jobs@acme.com>',
  // A receipt subject.
  subject: 'Thank you for applying to Acme',
  // A short body.
  snippet: 'Thanks',
  // Wednesday 2026-11-11 15:30 IST.
  received_at: '2026-11-11T10:00:00+00:00',
  // Unused columns.
  thread_id: null,
  recipient_to: null,
  label_ids: null,
  // A receipt.
  classification: 'application_received',
  classification_confidence: 0.9,
  matched_application_id: null,
  processed_at: null,
  created_at: '2026-11-11T10:00:00+00:00',
  read_at: null,
  // The caller's overrides.
  ...over,
}) as EmailEventRow;

// The owner's address, as the session holds it.
const OWNER = 'tejamallam00@gmail.com';
// "Now": Thursday 2026-11-12 13:00 IST.
const NOW = new Date('2026-11-12T07:30:00+00:00');

describe('isOwnerSent', () => {
  // The live shapes: a display name with the address in brackets, and a bare address.
  it('matches the owner by address, in any case, bracketed or bare', () => {
    // Bracketed, as Gmail stores it.
    assert.equal(isOwnerSent('Teja Mallam <tejamallam00@gmail.com>', OWNER), true);
    // Bare, mixed case.
    assert.equal(isOwnerSent('TejaMallam00@Gmail.com', OWNER), true);
  });
  // A lookalike must not pass: the whole address is compared, never a substring.
  it('never matches a lookalike or an employer', () => {
    // A longer address containing the owner's.
    assert.equal(isOwnerSent('x.tejamallam00@gmail.com', OWNER), false);
    // An employer quoting the owner in the display name.
    assert.equal(isOwnerSent('"tejamallam00@gmail.com via Hash" <support@usepylon.com>', OWNER), false);
    // No owner known (signed out): nothing is owner-sent.
    assert.equal(isOwnerSent('Teja Mallam <tejamallam00@gmail.com>', ''), false);
  });
});

describe('companyOf', () => {
  // A tracked email names its application's company: the most reliable source.
  it('uses the tracked application company first', () => {
    // Linked to an application whose company is known.
    assert.equal(companyOf(row({ matched_application_id: 'a1', from_address: 'no-reply@us.greenhouse-mail.io' }), new Map([['a1', 'Stripe']])), 'Stripe');
  });
  // ATS senders (greenhouse-mail.io, ashbyhq.com) are not the employer: the subject names it ("applying to X").
  it('reads "applying to <Company>" from the subject before an ATS domain', () => {
    // Greenhouse's receipt, live wording.
    assert.equal(companyOf(row({ from_address: 'no-reply@us.greenhouse-mail.io', subject: 'Thank you for applying to TrueFoundry' }), new Map()), 'TrueFoundry');
  });
  // A display name is the employer when it is not an ATS.
  it('falls back to the display name without its recruiting suffix', () => {
    // "Supabase Hiring Team" -> Supabase.
    assert.equal(companyOf(row({ from_address: 'Supabase Hiring Team <no-reply@ashbyhq.com>', subject: 'Hello' }), new Map()), 'Supabase');
  });
});

describe('istWeekStart', () => {
  // Weeks start Monday in IST: a Sunday 23:00 IST row belongs to the week before, a Monday 00:30 IST row to the new one.
  it('buckets by the IST calendar, Monday first', () => {
    // Sunday 2026-11-08 23:00 IST = 17:30 UTC.
    assert.equal(istWeekStart(new Date('2026-11-08T17:30:00Z')), '2026-11-02');
    // Monday 2026-11-09 00:30 IST = Sunday 19:00 UTC: already the new week in IST.
    assert.equal(istWeekStart(new Date('2026-11-08T19:00:00Z')), '2026-11-09');
  });
});

describe('computeEmailStats', () => {
  // The live mix of 2026-11-12, small: two receipts (one tracked), one rejection, one owner reply, one unclassified.
  const events = [
    row({ id: '1', classification: 'application_received', matched_application_id: 'a1', read_at: '2026-11-11T11:00:00Z' }),
    row({ id: '2', classification: 'application_received', from_address: 'no-reply@us.greenhouse-mail.io', subject: 'Thank you for applying to TrueFoundry' }),
    row({ id: '3', classification: 'rejection', from_address: 'no-reply@hackerrank.com', subject: 'Thank you for your interest in HackerRank', received_at: '2026-11-07T12:30:00Z' }),
    row({ id: '4', classification: 'unclassified', from_address: 'Teja Mallam <tejamallam00@gmail.com>', subject: 'Re: Thank you for your interest in HackerRank' }),
    row({ id: '5', classification: 'unclassified', from_address: 'news@example.com', subject: 'Newsletter' }),
  ];
  // The figures.
  const stats = computeEmailStats(events, { ownerEmail: OWNER, now: NOW, companyByApplication: new Map([['a1', 'Acme']]), weeks: 4 });

  // Owner mail is counted on its own and never as employer mail. RED-ON-REVERT: without isOwnerSent, fromYou is 0.
  it('splits the owner\'s own mail out of every employer figure', () => {
    // One owner reply.
    assert.equal(stats.fromYou, 1);
    // Everything stored.
    assert.equal(stats.total, 5);
    // Job mail = classified employer mail: the two receipts and the rejection.
    assert.equal(stats.jobMail, 3);
  });
  // The class breakdown is over job mail only, biggest first, zero classes left out.
  it('breaks job mail down by class, biggest first, with labels', () => {
    // Two receipts, one rejection.
    assert.deepEqual(stats.byType.map((t) => [t.label, t.count]), [['Application received', 2], ['Rejection', 1]]);
  });
  // Tracked vs not, over job mail.
  it('counts tracked and untracked job mail', () => {
    // Row 1 is linked.
    assert.equal(stats.tracked, 1);
    // Rows 2 and 3 are not.
    assert.equal(stats.untracked, 2);
  });
  // Outcomes: interviews and offers vs rejections, the "how am I doing" line.
  it('counts outcomes', () => {
    // No interview or offer yet.
    assert.equal(stats.positive, 0);
    // One real rejection, not the owner's reply.
    assert.equal(stats.rejections, 1);
  });
  // Companies heard from: job mail only, owner mail never makes "Tejamallam00" a company.
  it('ranks companies by job mail, never the owner', () => {
    // HackerRank ("interest in", 11-07), Acme (tracked), TrueFoundry ("applying to"): one each, so the employer heard
    // from FIRST ranks first (the oldest mail breaks the tie).
    assert.deepEqual(stats.companies.map((c) => c.name), ['HackerRank', 'Acme', 'TrueFoundry']);
    // And the distinct count.
    assert.equal(stats.companyCount, 3);
  });
  // Weekly job mail, oldest first, zero weeks kept so the bars line up in time.
  it('counts job mail per IST week, oldest first, empty weeks included', () => {
    // Four weeks ending in the week of NOW (Mon 2026-11-09).
    assert.deepEqual(stats.weekly.map((w) => w.weekStart), ['2026-10-19', '2026-10-26', '2026-11-02', '2026-11-09']);
    // The rejection on Sat 11-07; the two receipts on 11-11.
    assert.deepEqual(stats.weekly.map((w) => w.count), [0, 0, 1, 2]);
  });
  // Unread is job mail only, the same set the page lists by default.
  it('counts unread job mail', () => {
    // Rows 2 and 3.
    assert.equal(stats.unread, 2);
  });
  // An empty inbox is all zeros, never NaN or a crash.
  it('handles no mail', () => {
    // Nothing stored.
    const empty = computeEmailStats([], { ownerEmail: OWNER, now: NOW, companyByApplication: new Map(), weeks: 2 });
    // Zeros and empty lists.
    assert.deepEqual([empty.total, empty.jobMail, empty.companies.length, empty.weekly.map((w) => w.count)], [0, 0, 0, [0, 0]]);
  });
});

// The card's time (2026-11-12): the bare toLocaleString() printed the US "11/12/2026, 1:19:14 AM" in the browser's zone.
describe('formatReceivedAt', () => {
  // The live TrueFoundry receipt: 19:49 UTC is 01:19 IST the next day.
  it('prints IST in en-IN wording, whatever the machine zone', () => {
    // The exact wording the other pages use.
    assert.equal(formatReceivedAt('2026-11-11T19:49:14+00:00'), '12 Nov 2026, 1:19 am');
  });
  // A malformed time is said, never shown as 1970.
  it('says an unparseable time', () => {
    // Not a date.
    assert.equal(formatReceivedAt('not a date'), 'Time unknown');
  });
});
