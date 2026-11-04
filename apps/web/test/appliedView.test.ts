/* The Applied jobs page's pure rules (features/applied/appliedView.ts), asked for by Teja 2026-11-04.
 * One named test per rule, so a red test names the rule that broke. Live 2026-11-04: 2 rows at
 * applied, 1 with a resume path, 0 later stages, 0 matched emails, so the sparse cases (no date,
 * no timeline, no path) are tested as the NORMAL case, not as edge cases. */

// appliedView imports isNoAnswer from approval/saveTailoredEdit.ts, whose own imports are
// extensionless; this hook resolves them, so it must be the first import.
import './support/registerTsxHooks.ts';
// Strict asserts: deepEqual compares order, which the stage-order tests rely on.
import assert from 'node:assert/strict';
// node:test, like every web test (package.json "test").
import { describe, it } from 'node:test';
// Type only (erased at run time): the row shape the fixtures build.
import type { AppliedRow } from '../src/features/applied/appliedView.ts';

// Imported DYNAMICALLY: a static import is linked before the hook above runs, so its extensionless
// imports would fail to resolve. Top-level await runs after the hook module has evaluated.
const {
  APPLIED_STAGES,
  STAGE_LABELS,
  isAppliedStage,
  readTimestamp,
  daysSince,
  daysSinceText,
  dayText,
  readStoragePath,
  fileNameOf,
  readEdges,
  legalNextStages,
  mergeTimeline,
  readAppliedRow,
  applyAppliedView,
  countByStage,
  buildMoveArgs,
  moveErrorText,
  DEFAULT_APPLIED_VIEW,
} = await import('../src/features/applied/appliedView.ts');

/* Today's live graph out of the six page stages (read 2026-11-04 20:30 IST), as the table returns it.
 * Fixture ONLY: the page reads the live table and never carries a copy. */
const LIVE_EDGES = [
  { from_status: 'applied', to_status: 'employer_screening', allowed_agents: ['tracker', 'human'] },
  { from_status: 'applied', to_status: 'oa_pending', allowed_agents: ['tracker', 'human'] },
  { from_status: 'applied', to_status: 'interview', allowed_agents: ['tracker', 'human'] },
  { from_status: 'applied', to_status: 'rejected', allowed_agents: ['tracker', 'human'] },
  { from_status: 'employer_screening', to_status: 'oa_pending', allowed_agents: ['tracker', 'human'] },
  { from_status: 'employer_screening', to_status: 'interview', allowed_agents: ['tracker', 'human'] },
  { from_status: 'employer_screening', to_status: 'rejected', allowed_agents: ['tracker', 'human'] },
  { from_status: 'oa_pending', to_status: 'interview', allowed_agents: ['tracker', 'human'] },
  { from_status: 'oa_pending', to_status: 'rejected', allowed_agents: ['tracker', 'human'] },
  { from_status: 'interview', to_status: 'oa_pending', allowed_agents: ['tracker', 'human'] },
  { from_status: 'interview', to_status: 'offer', allowed_agents: ['tracker', 'human'] },
  { from_status: 'interview', to_status: 'rejected', allowed_agents: ['tracker', 'human'] },
];

// One stored row as the page's embedded select returns it; `over` replaces top-level keys.
const rawRow = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'a1b2c3d4-0000-4000-8000-000000000001',
  status: 'applied',
  updated_at: '2026-11-03T09:15:00.123456+00:00',
  applied_at: '2026-11-03T09:15:00.123456+00:00',
  resume_storage_path: 'user-1/a1b2c3d4/1762161300000.pdf',
  screenshot_storage_path: null,
  tailored_profile: null,
  jobs: { title: 'Backend Engineer', company_name: 'Stripe', locations: ['Bengaluru, India'], apply_url: 'https://boards.greenhouse.io/stripe/jobs/1' },
  application_events: [],
  email_events: [],
  ...over,
});

// A validated row for the view tests, built through the real reader so the fixtures cannot drift from it.
function row(over: Record<string, unknown>): AppliedRow {
  // The reader under test elsewhere; here it only builds fixtures.
  const read = readAppliedRow(rawRow(over));
  // A fixture that does not read is a broken test, said loudly.
  assert.ok(read !== null, 'fixture row must read');
  // Proven non-null above.
  return read;
}

describe('stage labels', () => {
  it('labels employer_screening "Shortlisted" and keeps the status value itself', () => {
    // Teja's ruling 2026-11-04: the word on screen.
    assert.equal(STAGE_LABELS.employer_screening, 'Shortlisted');
    // The value the database and the RPC use is unchanged.
    assert.ok(APPLIED_STAGES.includes('employer_screening'));
  });

  it('lists exactly the six post-apply stages in pipeline order', () => {
    // The order the stage buttons and the filter options follow.
    assert.deepEqual([...APPLIED_STAGES], ['applied', 'employer_screening', 'oa_pending', 'interview', 'offer', 'rejected']);
  });

  it('accepts only the six statuses as a stage', () => {
    // Every listed stage passes.
    for (const stage of APPLIED_STAGES) assert.equal(isAppliedStage(stage), true);
    // An earlier status, a label, a blank and non-strings are not stages.
    for (const junk of ['approved', 'Shortlisted', '', null, undefined, 3, {}]) assert.equal(isAppliedStage(junk), false);
  });
});

describe('legal next stages come from the edges read, never from a built-in graph', () => {
  // Read once through the real reader, as the page does.
  const edges = readEdges(LIVE_EDGES);

  it('applied offers Shortlisted, OA, Interview and Rejected, and never Offer', () => {
    // Offer has no edge from applied.
    assert.deepEqual(legalNextStages(edges, 'applied'), ['employer_screening', 'oa_pending', 'interview', 'rejected']);
  });

  it('employer_screening offers OA, Interview and Rejected', () => {
    // No edge back to applied or to itself.
    assert.deepEqual(legalNextStages(edges, 'employer_screening'), ['oa_pending', 'interview', 'rejected']);
  });

  it('oa_pending offers Interview and Rejected', () => {
    // Two edges out.
    assert.deepEqual(legalNextStages(edges, 'oa_pending'), ['interview', 'rejected']);
  });

  it('interview offers OA, Offer and Rejected', () => {
    // The multi-round loop back to OA is a real edge.
    assert.deepEqual(legalNextStages(edges, 'interview'), ['oa_pending', 'offer', 'rejected']);
  });

  it('offer and rejected offer nothing: no edge leaves them', () => {
    // Terminal in the live graph.
    assert.deepEqual(legalNextStages(edges, 'offer'), []);
    // Rejected too: neither terminal stage gets a button.
    assert.deepEqual(legalNextStages(edges, 'rejected'), []);
  });

  it('no edges read means no moves at all', () => {
    // A failed or empty read never falls back to a remembered graph.
    assert.deepEqual(legalNextStages([], 'applied'), []);
    // A non-array answer reads as no edges.
    assert.deepEqual(readEdges(null), []);
    // A single object is not a list either: no edges, never one guessed edge.
    assert.deepEqual(readEdges({ from_status: 'applied' }), []);
  });

  it('drops an edge a human may not walk', () => {
    // Tracker-only: the browser acts as human, so this button would only be refused.
    const only = readEdges([{ from_status: 'applied', to_status: 'offer', allowed_agents: ['tracker'] }]);
    // So applied offers nothing a human could actually do.
    assert.deepEqual(legalNextStages(only, 'applied'), []);
  });

  it('drops a malformed edge row instead of guessing it', () => {
    // Missing actor list, an unknown target, a target outside the page, a non-object, a null.
    const junk = readEdges([
      { from_status: 'applied', to_status: 'interview' },
      { from_status: 'applied', to_status: 'hired', allowed_agents: ['human'] },
      { from_status: 'applied', to_status: 'needs_verification', allowed_agents: ['human'] },
      'applied->offer',
      null,
    ]);
    // Every malformed row dropped; none is guessed into an edge.
    assert.deepEqual(junk, []);
  });

  it('orders the moves by stage order, whatever order the table returned', () => {
    // Reversed input, same buttons in the same order.
    assert.deepEqual(legalNextStages(readEdges([...LIVE_EDGES].reverse()), 'interview'), ['oa_pending', 'offer', 'rejected']);
  });
});

describe('timestamps are shape-checked, never trusted to Date.parse', () => {
  it('reads a PostgREST timestamptz with microseconds', () => {
    // The exact format the applications table returns.
    assert.equal(readTimestamp('2026-11-01T08:00:00.000000+00:00'), Date.UTC(2026, 10, 1, 8, 0, 0));
  });

  it('reads Z, +05:30 and +0530 as the same instant', () => {
    // 13:30 IST is 08:00 UTC.
    const utc = Date.UTC(2026, 10, 4, 8, 0, 0);
    // UTC, written with Z.
    assert.equal(readTimestamp('2026-11-04T08:00:00Z'), utc);
    // IST, written with a colon offset.
    assert.equal(readTimestamp('2026-11-04T13:30:00+05:30'), utc);
    // IST, the colon-less offset form ISO 8601 also allows.
    assert.equal(readTimestamp('2026-11-04T13:30:00+0530'), utc);
  });

  it('never turns junk into a date', () => {
    // Date.parse would answer several of these: "-5" is year -5, Feb 31 rolls into March, a bare
    // date is midnight UTC, a zone-less time is local. Each must read as no date.
    for (const junk of [
      '', '-5', '2026', '2026-11-04', 'Tue Nov 04 2026', '2026-02-31T00:00:00Z', '2026-11-04T25:00:00Z',
      '2026-11-04T08:61:00Z', '2026-11-04T08:00:00', '2026-11-04T08:00:00+05', null, undefined, 0, 1793520000000, {},
    ]) {
      assert.equal(readTimestamp(junk), null, `"${String(junk)}" must not read as a date`);
    }
  });

  it('counts whole days since, floored', () => {
    // 2 days and 23 hours is 2 days.
    const at = Date.UTC(2026, 10, 1, 8);
    // Floored: never rounded up to 3.
    assert.equal(daysSince(at, at + (2 * 24 + 23) * 3_600_000), 2);
    // The same instant is day 0.
    assert.equal(daysSince(at, at), 0);
  });

  it('treats a date more than a day ahead as no answer, and small clock skew as day 0', () => {
    // A future applied date is malformed data, not "-3 days".
    assert.equal(daysSince(Date.UTC(2026, 10, 9), Date.UTC(2026, 10, 4)), null);
    // A few minutes of skew between the database clock and this one.
    assert.equal(daysSince(Date.UTC(2026, 10, 4, 8, 5), Date.UTC(2026, 10, 4, 8, 0)), 0);
  });

  it('says "—" for a missing date and the day count in words otherwise', () => {
    // Missing is said, never 0.
    assert.equal(daysSinceText(null), '—');
    // The date itself too, not only the count.
    assert.equal(dayText(null), '—');
    // Singular and plural.
    assert.equal(daysSinceText(1), '1 day since applied');
    // Zero is plural: "0 days".
    assert.equal(daysSinceText(0), '0 days since applied');
    // An ordinary plural.
    assert.equal(daysSinceText(12), '12 days since applied');
  });
});

describe('reading one applied row', () => {
  it('takes the applied date from applied_at', () => {
    // The trigger stamps applied_at when the row enters applied.
    assert.equal(row({}).appliedAt, Date.UTC(2026, 10, 3, 9, 15, 0, 123));
  });

  it('falls back to the status_change event into applied when applied_at is null', () => {
    // A row moved before the column existed, or by a path that skipped it.
    const read = row({
      applied_at: null,
      application_events: [
        { event_type: 'status_change', from_status: 'approved', to_status: 'applying', created_at: '2026-11-02T10:00:00+00:00' },
        { event_type: 'status_change', from_status: 'applying', to_status: 'applied', created_at: '2026-11-02T10:05:00+00:00' },
      ],
    });
    // The status_change event's time stands in for the missing applied_at.
    assert.equal(read.appliedAt, Date.UTC(2026, 10, 2, 10, 5));
  });

  it('says no date when applied_at is junk and no event says when', () => {
    // Not 1970, not now: missing.
    assert.equal(row({ applied_at: 'yesterday' }).appliedAt, null);
    // A null applied_at with no event: missing too.
    assert.equal(row({ applied_at: null }).appliedAt, null);
  });

  it('refuses a row whose status is not one of the page stages', () => {
    // A row the select should never return; shown nowhere rather than mislabelled.
    assert.equal(readAppliedRow(rawRow({ status: 'approved' })), null);
  });

  it('refuses a row without an id or an updated_at stamp: it could not be moved safely', () => {
    // The id names the RPC target; the stamp is the stale-click guard.
    assert.equal(readAppliedRow(rawRow({ id: '' })), null);
    // No stamp: no safe move, so no row.
    assert.equal(readAppliedRow(rawRow({ updated_at: null })), null);
    // Not an object at all.
    assert.equal(readAppliedRow(null), null);
    // An array holding a row is still not a row.
    assert.equal(readAppliedRow([rawRow()]), null);
  });

  it('keeps a row with no job embed, with no title, company or link', () => {
    // An application without its job is still an application that was sent.
    const read = row({ jobs: null });
    // No title: the card shows "—".
    assert.equal(read.title, null);
    // No company.
    assert.equal(read.company, null);
    // No link to vet.
    assert.equal(read.applyUrl, null);
    // No places: an empty list, never [null].
    assert.deepEqual(read.locations, []);
  });

  it('reads a blank, non-string or ".." storage path as no file', () => {
    // Each would sign a URL for a path the worker never wrote.
    for (const junk of ['', '   ', 7, {}, 'user-1/../other/x.pdf', '../x.pdf']) assert.equal(readStoragePath(junk), null);
    // A real path reads as itself.
    assert.equal(readStoragePath('user-1/a/b.pdf'), 'user-1/a/b.pdf');
  });

  it('treats an empty {} tailored_profile as no resume to rebuild', () => {
    // A truthy test would render an empty resume that LOOKS tailored.
    assert.equal(row({ tailored_profile: {} }).resume, null);
  });

  it('names the download after the stored file', () => {
    // The worker's own file name, the last path segment.
    assert.equal(fileNameOf('user-1/a1b2/1762161300000.pdf'), '1762161300000.pdf');
  });
});

describe('search, sort and stage filter', () => {
  // Three rows: two dated, one undated, across two stages.
  const stripe = row({ id: 's', jobs: { title: 'Backend Engineer', company_name: 'Stripe', locations: ['Bengaluru, India'], apply_url: 'https://x.test/1' } });
  // The newest dated row, at a later stage.
  const gitlab = row({ id: 'g', status: 'employer_screening', applied_at: '2026-11-04T09:00:00Z', jobs: { title: 'Platform Engineer', company_name: 'GitLab', locations: ['Remote'], apply_url: 'https://x.test/2' } });
  // No date and null locations: the sparse row.
  const undated = row({ id: 'u', applied_at: null, jobs: { title: 'Data Engineer', company_name: 'Acme', locations: null, apply_url: 'https://x.test/3' } });
  // Out of date order on purpose, so a sort that does nothing fails.
  const rows = [stripe, undated, gitlab];

  it('requires every whitespace token to match across title, company and location', () => {
    // "engineer bengaluru" is Stripe only: both tokens, across two fields.
    assert.deepEqual(applyAppliedView(rows, { ...DEFAULT_APPLIED_VIEW, search: '  engineer   BENGALURU ' }).map((r) => r.id), ['s']);
    // A token no row has empties the list.
    assert.deepEqual(applyAppliedView(rows, { ...DEFAULT_APPLIED_VIEW, search: 'stripe remote' }), []);
  });

  it('shows every row for a blank search', () => {
    // Whitespace only is no search.
    assert.equal(applyAppliedView(rows, { ...DEFAULT_APPLIED_VIEW, search: '   ' }).length, 3);
  });

  it('filters to one stage; All shows every stage', () => {
    // Only the shortlisted row.
    assert.deepEqual(applyAppliedView(rows, { ...DEFAULT_APPLIED_VIEW, stage: 'employer_screening' }).map((r) => r.id), ['g']);
    // All.
    assert.equal(applyAppliedView(rows, { ...DEFAULT_APPLIED_VIEW, stage: 'all' }).length, 3);
  });

  it('sorts newest applied first, with undated rows last', () => {
    // GitLab (Nov 4) before Stripe (Nov 3); the undated row never ranks as newest.
    assert.deepEqual(applyAppliedView(rows, { ...DEFAULT_APPLIED_VIEW, sort: 'newest' }).map((r) => r.id), ['g', 's', 'u']);
  });

  it('sorts oldest applied first, with undated rows still last', () => {
    // An undated row is not "oldest" either: missing is never ranked.
    assert.deepEqual(applyAppliedView(rows, { ...DEFAULT_APPLIED_VIEW, sort: 'oldest' }).map((r) => r.id), ['s', 'g', 'u']);
  });

  it('counts each stage, with All as every row and zeros present', () => {
    // An empty stage reads 0, never undefined.
    assert.deepEqual(countByStage(rows), { all: 3, applied: 2, employer_screening: 1, oa_pending: 0, interview: 0, offer: 0, rejected: 0 });
    // The empty page.
    assert.equal(countByStage([]).all, 0);
  });

  it('returns a new array and leaves the input order alone', () => {
    // Sorting must not reorder the page's fetched list.
    const input = [...rows];
    // A sort that would reorder this list if it worked in place.
    applyAppliedView(input, { ...DEFAULT_APPLIED_VIEW, sort: 'oldest' });
    // The caller's array is untouched.
    assert.deepEqual(input.map((r) => r.id), ['s', 'u', 'g']);
  });
});

describe('timeline merge', () => {
  it('merges status changes and matched emails in time order, oldest first', () => {
    // An email between two status changes lands between them.
    const items = mergeTimeline(
      [
        { event_type: 'status_change', from_status: 'applying', to_status: 'applied', created_at: '2026-11-03T09:15:00+00:00' },
        { event_type: 'status_change', from_status: 'applied', to_status: 'employer_screening', created_at: '2026-11-05T10:00:00+00:00' },
      ],
      [{ from_address: 'jobs@stripe.com', subject: 'Thanks for applying', received_at: '2026-11-03T09:20:00Z', classification: 'acknowledgement' }],
    );
    // One time order across both lists: status, email, status.
    assert.deepEqual(items.map((i) => i.kind), ['status', 'email', 'status']);
    // The email keeps its fields.
    const email = items[1];
    // It is the email, narrowed for the field checks.
    assert.ok(email !== undefined && email.kind === 'email');
    // Sender kept verbatim.
    assert.equal(email.sender, 'jobs@stripe.com');
    // Subject kept verbatim.
    assert.equal(email.subject, 'Thanks for applying');
    // The tracker's reading kept verbatim.
    assert.equal(email.classification, 'acknowledgement');
  });

  it('drops events that are not status changes', () => {
    // A note or an llm_call is not part of the application's stage history.
    const items = mergeTimeline([{ event_type: 'note', from_status: null, to_status: null, created_at: '2026-11-03T09:15:00Z' }], []);
    // Dropped, not drawn as a blank line.
    assert.deepEqual(items, []);
  });

  it('keeps an item whose time is junk, placed last with no time', () => {
    // Hiding it would lose history; ranking it would invent a time.
    const items = mergeTimeline(
      [{ event_type: 'status_change', from_status: 'applying', to_status: 'applied', created_at: 'garbage' }],
      [{ from_address: 'a@b.test', subject: 'Hi', received_at: '2026-11-03T09:20:00Z', classification: 'other' }],
    );
    // The dated email first; the junk-time status kept, last, with no time.
    assert.deepEqual(items.map((i) => [i.kind, i.at]), [['email', Date.UTC(2026, 10, 3, 9, 20)], ['status', null]]);
  });

  it('drops malformed items it cannot describe', () => {
    // Non-objects, a status change with no target, an email with a non-string subject.
    const items = mergeTimeline(
      ['x', null, { event_type: 'status_change', from_status: 'applied', created_at: '2026-11-03T09:15:00Z' }],
      [{ from_address: 'a@b.test', subject: 5, received_at: '2026-11-03T09:20:00Z', classification: 'other' }, 7],
    );
    // Nothing describable, so nothing drawn.
    assert.deepEqual(items, []);
  });

  it('is empty for a row with no events and no emails: the normal case today', () => {
    // Missing embeds are no history, not an error.
    assert.deepEqual(mergeTimeline(null, undefined), []);
    // Empty lists: the same empty history.
    assert.deepEqual(mergeTimeline([], []), []);
  });
});

describe('stage moves', () => {
  it('acts as human and always sends the stamp exactly as read', () => {
    // The stamp is never parsed: a Date would drop the microseconds and make every move stale.
    const args = buildMoveArgs({ id: 'app-1', status: 'applied', stamp: '2026-11-03T09:15:00.123456+00:00' }, 'employer_screening');
    // Every argument pinned: actor human, the stamp verbatim, the source page in the detail.
    assert.deepEqual(args, {
      p_application_id: 'app-1',
      p_to_status: 'employer_screening',
      p_agent: 'human',
      p_detail: { source: 'applied_page', from: 'applied' },
      p_expected_updated_at: '2026-11-03T09:15:00.123456+00:00',
    });
  });

  it('says a lost answer may still land, never that it failed', () => {
    // Status 0 is the transport giving up; the database may still commit.
    assert.match(moveErrorText(0, null), /may still land/);
    // An error with no SQLSTATE is the network, not the database.
    assert.match(moveErrorText(500, { message: 'Failed to fetch' }), /may still land/);
  });

  it('says a stale stamp means the row changed since the page loaded', () => {
    // PT409 from the expected-updated_at guard.
    assert.match(moveErrorText(409, { code: 'PT409', message: 'stale' }), /changed since this page loaded/);
  });

  it("keeps the database's own words for any other refusal", () => {
    // An illegal edge, a missing row, a privilege refusal.
    assert.equal(moveErrorText(400, { code: '23514', message: 'illegal status transition' }), 'Not moved (23514): illegal status transition');
  });
});
