/* Receipt marker (2026-10-24): a row the Gmail tracker matched to an "application received" email
 * shows "Receipt received <date> — <subject>" beside its resolve buttons, on System health and on the
 * Manual apply page (both draw RecoveryRowView).
 *
 * WHY. The tracker writes email_events.classification='application_received' with
 * matched_application_id set (email-tracker-intake/decide.ts), but no screen read it: the email page
 * filters to interview mail on purpose. So the "tracked" step of the pipeline had no UI, and the only
 * proof a receipt landed was a SQL query. Zero receipts had ever matched when this was written, so the
 * fixtures copy the live column shapes (subject text NOT NULL, received_at timestamptz NOT NULL,
 * classification enum) instead of a captured row.
 *
 * Rendered, not grepped: the same transpile hook and static render as needsYouQueues.test.ts. */

// The .tsx loader; must be the first import so it runs before the component import.
import './support/registerTsxHooks.ts';
// Strict asserts: a loose equal would let '' pass for null.
import assert from 'node:assert/strict';
// The runner; before() loads the transpiled module once.
import { describe, it, before } from 'node:test';

// The queue module, loaded after the hooks are in place.
let queue: typeof import('../src/features/health/RecoveryQueue.tsx');
// Static markup, no DOM.
let render: (element: unknown) => string;
// Element factory, so this .ts file needs no JSX.
let h: typeof import('react').createElement;

before(async () => {
  // Transpiled by the hook.
  queue = await import('../src/features/health/RecoveryQueue.tsx');
  // From the installed react-dom.
  render = (await import('react-dom/server')).renderToStaticMarkup as (element: unknown) => string;
  // React's factory.
  h = (await import('react')).createElement;
});

// One embedded email_events row as PostgREST nests it under the application; fields vary per case.
const receipt = (over: Record<string, unknown> = {}) => ({
  // The phrase parser.ts classifies as application_received.
  subject: 'Thank you for applying to GitLab',
  // timestamptz as PostgREST serialises it.
  received_at: '2026-10-24T11:02:33+00:00',
  // The classification the marker is for.
  classification: 'application_received',
  // Per-case overrides.
  ...over,
});

// The live GitLab row's shape as the queue's select returns it, with its embedded emails.
const gitlabRaw = (emailEvents: unknown) => ({
  // The real row id Teja is applying to by hand.
  id: 'ba1e5d1d-84a5-4cfb-b5a6-e5a2943bf154',
  // The move's stale-stamp guard.
  updated_at: '2026-10-24T08:16:21.583434+00:00',
  // Swept rows carry no lease.
  claim_expires_at: null,
  // needs_verification rows have no block reason.
  block_reason: null,
  // Nor a failure reason.
  failure_reason: null,
  // The embedded job.
  jobs: { title: 'Intermediate Backend Engineer, India', company_name: 'GitLab', apply_url: 'https://job-boards.greenhouse.io/gitlab/jobs/8775507002' },
  // The embedded emails matched to this row (to-many, so an array).
  email_events: emailEvents,
});

// One rendered needs_verification row, through the same parse and component the queue uses.
function renderRow(emailEvents: unknown): string {
  // Parsed by the queue's own parser.
  const row = queue.parseQueueRow('needs_verification', gitlabRaw(emailEvents));
  // A valid row must survive whatever the emails look like: a bad email never hides the row.
  assert.ok(row !== null, 'the row itself must parse');
  // Drawn exactly as the queue draws it.
  return render(
    h('table', null, h('tbody', null, h(queue.RecoveryRowView, {
      // The lane.
      status: 'needs_verification',
      // The parsed row.
      row,
      // One move is enough to draw the cell.
      moves: ['applied'],
      // The page's wording.
      verb: queue.manualActionVerb,
      // Free.
      locked: false,
      // Not frozen.
      frozen: false,
      // No lease.
      lease: null,
      // Never clicked in a static render.
      onMove: () => undefined,
    }))),
  );
}

describe('receipt marker', () => {
  it('shows the matched receipt with its UTC date and subject', () => {
    // One genuine receipt.
    const html = renderRow([receipt()]);
    // The whole sentence, so date format and subject are both pinned.
    assert.match(html, /Receipt received 2026-10-24 11:02 UTC — Thank you for applying to GitLab/);
  });

  it('shows nothing when no email matched the row', () => {
    // An empty embed (the normal case today) and an absent key (an older select) both mean no receipt.
    for (const none of [[], undefined, null]) {
      // Rendered.
      const html = renderRow(none);
      // No marker, and no placeholder either.
      assert.doesNotMatch(html, /Receipt/);
    }
  });

  it('ignores mail of another classification', () => {
    // An interview invite matched to the row is not a receipt.
    assert.doesNotMatch(renderRow([receipt({ classification: 'interview' })]), /Receipt/);
  });

  it('picks the newest receipt when several matched', () => {
    // Older first in the array, so position cannot be what wins.
    const html = renderRow([receipt({ subject: 'Older receipt', received_at: '2026-10-20T09:00:00+00:00' }), receipt({ subject: 'Newer receipt', received_at: '2026-10-24T12:30:00+00:00' }), receipt({ subject: 'Middle receipt', received_at: '2026-10-22T09:00:00+00:00' })]);
    // The newest one is shown.
    assert.match(html, /Receipt received 2026-10-24 12:30 UTC — Newer receipt/);
    // And only one marker.
    assert.equal(html.match(/Receipt received/g)?.length, 1);
  });

  it('drops malformed receipts without crashing or printing undefined', () => {
    // Each is a shape the column types forbid, so it must never become a sentence.
    const bad = [
      // No subject.
      receipt({ subject: undefined }),
      // Blank subject.
      receipt({ subject: '   ' }),
      // No date.
      receipt({ received_at: undefined }),
      // Date.parse('-5') is year -5: a lenient parse would print it.
      receipt({ received_at: '-5' }),
      // Not a date at all.
      receipt({ received_at: 'yesterday' }),
      // A number where text belongs.
      receipt({ subject: 42 }),
      // Not an object.
      null,
      // Not an object either.
      'Thank you for applying',
    ];
    // Each alone: none may render.
    for (const b of bad) {
      // Rendered.
      const html = renderRow([b]);
      // No marker.
      assert.doesNotMatch(html, /Receipt/, JSON.stringify(b));
      // And no leaked placeholder.
      assert.doesNotMatch(html, /undefined|NaN|Invalid Date/, JSON.stringify(b));
    }
    // A non-array embed is no receipt, not a crash.
    assert.doesNotMatch(renderRow({ subject: 'x' }), /Receipt/);
  });

  it('keeps a valid receipt when a malformed one sits beside it', () => {
    // A bad row must not poison the good one.
    assert.match(renderRow([receipt({ received_at: '-5', subject: 'Bad' }), receipt()]), /Receipt received 2026-10-24 11:02 UTC — Thank you for applying to GitLab/);
  });

  it('reads the embedded emails in the queue select', () => {
    // The read must ask for the three fields the parser checks, or the marker can never appear.
    assert.match(queue.RECOVERY_SELECT, /email_events\(subject, received_at, classification\)/);
  });
});
