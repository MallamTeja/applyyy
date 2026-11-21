/* The Emails page's pure view rules (2026-11-05): the class badge, the filters, the sort, the URL state,
 * the unread count and which emails can be added to Applied. The page renders what these return, so a
 * rule pinned here is a rule on screen; the browser test (emailsE2e) proves the wiring.
 *
 * THE BUG THIS FILE EXISTS FOR: the page hard-coded "Interview Invite" on every row, so a HackerRank
 * "we have received your application" and a Simplilearn promo both read as interview invites. */

// Strict asserts.
import assert from 'node:assert/strict';
// node:test, like every web test.
import { describe, it } from 'node:test';
// The module under test (plain .ts, no loader needed).
import { applyEmailFilters, classLabel, DEFAULT_EMAIL_FILTERS, filtersToParams, isTrackable, parseEmailFilters, prefillOf, unreadCount } from '../src/features/emails/emailView.ts';
// Type only: the row shape.
import type { EmailEventRow } from '../src/features/emails/emailSync.ts';

// One stored email; `over` replaces fields.
const row = (over: Partial<EmailEventRow>): EmailEventRow => ({
  id: 'e0000000-0000-4000-8000-000000000000',
  user_id: 'u',
  provider_message_id: 'm',
  from_address: 'Acme Recruiting <jobs@acme.com>',
  subject: 'Your application to Acme',
  snippet: 'Thanks',
  received_at: '2026-11-04T10:00:00+00:00',
  thread_id: null,
  recipient_to: null,
  label_ids: null,
  classification: 'application_received',
  classification_confidence: 0.9,
  matched_application_id: null,
  processed_at: null,
  created_at: '2026-11-04T10:00:00+00:00',
  read_at: null,
  ...over,
});

describe('classLabel: the stored class, never a guess', () => {
  it('a received-application email reads "Application received", not "Interview invite"', () => {
    // The live HackerRank case.
    assert.equal(classLabel('application_received'), 'Application received');
    // The class that used to be stamped on every row keeps its own label.
    assert.equal(classLabel('interview_invite'), 'Interview invite');
  });

  it('an unknown or malformed class reads "Unclassified"', () => {
    // A value the closed map does not know (e.g. a newer DB enum value) is never guessed into a label.
    assert.equal(classLabel('something_new'), 'Unclassified');
    // Not even a string.
    assert.equal(classLabel(null), 'Unclassified');
    // A prototype key is not a class.
    assert.equal(classLabel('toString'), 'Unclassified');
  });
});

describe('filters, sort and URL state', () => {
  // Four emails: two tracked states, three classes, three days, two senders.
  const rows = [
    row({ id: 'a', classification: 'application_received', received_at: '2026-11-01T10:00:00+00:00', from_address: 'Zeta <z@zeta.com>', subject: 'Zeta: application received' }),
    row({ id: 'b', classification: 'interview_invite', received_at: '2026-11-03T10:00:00+00:00', matched_application_id: 'app-1', from_address: 'Acme <a@acme.com>', subject: 'Interview with Acme' }),
    row({ id: 'c', classification: 'job_alert', received_at: '2026-11-02T10:00:00+00:00', from_address: 'LinkedIn <jobalerts-noreply@linkedin.com>', subject: 'Engineer: 10 more jobs' }),
    row({ id: 'd', classification: 'unclassified', received_at: '2026-11-04T10:00:00+00:00', subject: '' }),
  ];
  // Ids of a filtered list, in order.
  const ids = (f: Partial<typeof DEFAULT_EMAIL_FILTERS>) => applyEmailFilters(rows, { ...DEFAULT_EMAIL_FILTERS, ...f }).map((r) => r.id);

  it('the default view is all JOB mail, newest first (unclassified and other are hidden)', () => {
    // b (11-03), c (11-02), a (11-01); d is unclassified.
    assert.deepEqual(ids({}), ['b', 'c', 'a']);
  });

  it('"Not tracked" is the unmatched filter: only rows with no application', () => {
    // b is matched, so it leaves.
    assert.deepEqual(ids({ track: 'untracked' }), ['c', 'a']);
    // And tracked keeps only b.
    assert.deepEqual(ids({ track: 'tracked' }), ['b']);
  });

  it('by class, by sender text, by date range, and every sort', () => {
    // One class.
    assert.deepEqual(ids({ cls: 'job_alert' }), ['c']);
    // Everything, unclassified included.
    assert.deepEqual(ids({ cls: 'all' }), ['d', 'b', 'c', 'a']);
    // Sender text, case-insensitive.
    assert.deepEqual(ids({ q: 'ACME' }), ['b']);
    // An inclusive day range (local days).
    assert.deepEqual(ids({ from: '2026-11-02', to: '2026-11-03' }), ['b', 'c']);
    // Oldest first.
    assert.deepEqual(ids({ sort: 'oldest' }), ['a', 'c', 'b']);
    // Sender A to Z: Acme, LinkedIn, Zeta.
    assert.deepEqual(ids({ sort: 'sender' }), ['b', 'c', 'a']);
  });

  it('the URL round-trips, and a junk value falls back to its default', () => {
    // A non-default state.
    const f = { ...DEFAULT_EMAIL_FILTERS, cls: 'offer' as const, track: 'untracked' as const, q: 'acme', from: '2026-11-01', sort: 'oldest' as const };
    // Written and read back.
    assert.deepEqual(parseEmailFilters(filtersToParams(f)), f);
    // Defaults are omitted, so a clean URL stays clean.
    assert.equal(filtersToParams(DEFAULT_EMAIL_FILTERS).toString(), '');
    // Junk never becomes a state: an unknown class, sort or a malformed date.
    assert.deepEqual(parseEmailFilters(new URLSearchParams('cls=bogus&sort=up&from=-5&track=x')), DEFAULT_EMAIL_FILTERS);
  });
});

describe('unread count and Add to Applied eligibility', () => {
  it('counts rows with no read_at', () => {
    // One read, two unread.
    assert.equal(unreadCount([row({ read_at: '2026-11-05T01:00:00Z' }), row({}), row({})]), 2);
  });

  it('only unmatched mail ABOUT an application can be added (the RPC refuses the rest)', () => {
    // A receipt with no match: yes.
    assert.equal(isTrackable(row({})), true);
    // Already tracked: no.
    assert.equal(isTrackable(row({ matched_application_id: 'app-1' })), false);
    // An alert, a notice, an unread-by-the-classifier email: no.
    for (const c of ['job_alert', 'other', 'unclassified'] as const) assert.equal(isTrackable(row({ classification: c })), false, c);
  });

  it('prefills the company from the sender and the title from the subject, both editable later', () => {
    // A display name with a recruiting suffix.
    // The title is the subject's role with the ATS wrapper stripped (2026-11-21: Add to Applied writes on one click).
    assert.deepEqual(prefillOf(row({ from_address: 'Acme Recruiting <no-reply@greenhouse.io>', subject: 'Backend Engineer - Application received' })), { company: 'Acme', title: 'Backend Engineer' });
    // No display name: the sender's domain label.
    assert.equal(prefillOf(row({ from_address: 'careers@globex.com' })).company, 'Globex');
  });
});

/* 2026-11-21 (orch ruling on S6): Add to Applied creates a new job in ONE click, so the title is written unseen.
   It must be the role, not the ATS wrapper. RED-ON-REVERT: returning the raw subject fails every row below. */
describe('titleFromSubject: the role out of a typical ATS subject', () => {
  it('strips receipt wrappers, "at <company>" and role words; falls back to "<Company> role"', async () => {
    // Imported here so the earlier tests do not depend on the new export.
    const { titleFromSubject } = await import('../src/features/emails/emailView.ts');
    // Subject -> expected title, for company Acme.
    const cases: [string, string][] = [
      ['Application received for Backend Engineer', 'Backend Engineer'],
      ['Thank you for applying to the Senior Data Engineer position at Acme', 'Senior Data Engineer'],
      ['Thanks for applying for Full-Stack Developer at Acme!', 'Full-Stack Developer'],
      ['We have received your Application || AI Researcher Intern', 'AI Researcher Intern'],
      ['Backend Engineer - Application received', 'Backend Engineer'],
      ['Re: Your application: Platform Engineer, Infra', 'Platform Engineer, Infra'],
      ['Your application to Acme for ML Engineer', 'ML Engineer'],
      // "Application" inside a real title is kept: only the receipt PHRASES are cut.
      ['Application received: Application Security Engineer', 'Application Security Engineer'],
      // Nothing but the wrapper and the company: the fallback, never the wrapper.
      ['Thank you for applying to Acme', 'Acme role'],
      ['Application received', 'Acme role'],
    ];
    // Each one exactly.
    for (const [subject, title] of cases) assert.equal(titleFromSubject(subject, 'Acme'), title, subject);
  });
});

describe('link candidates: the duplicate guard before Add to Applied (2026-11-05)', () => {
  /* 2026-11-21 (S6): the lookup reads JOBS by slug and embeds their applications. The old applications-side read
     timed out live (7.2 s EXPLAIN ANALYZE: a seq scan over every application, the jobs filter trapped inside a
     LIMITed lateral); the jobs-side read uses jobs_user_company_slug_idx (32 ms). So the parser takes job rows. */
  it('flattens job rows with their embedded applications, keeping only well-formed ones', async () => {
    // Imported here so the earlier tests do not depend on the new export.
    const { parseLinkCandidates } = await import('../src/features/emails/emailView.ts');
    // Job rows as PostgREST embeds a to-many join, plus malformed rows and applications.
    const parsed = parseLinkCandidates([
      { title: 'AI Researcher Intern', applications: [{ id: 'a1', status: 'approved' }] },
      { title: 'Backend Engineer', applications: [{ id: 'a2', status: 'applied' }, { id: 'a3', status: 'not_a_status' }, { id: 4, status: 'applied' }] },
      { title: 7, applications: [{ id: 'a5', status: 'applied' }] },
      { title: 'No apps', applications: 'x' },
      null,
    ]);
    // The two real ones, with their job titles.
    assert.deepEqual(parsed, [{ id: 'a1', status: 'approved', title: 'AI Researcher Intern' }, { id: 'a2', status: 'applied', title: 'Backend Engineer' }]);
    // Not a list: none, never a crash.
    assert.deepEqual(parseLinkCandidates({}), []);
  });
});
