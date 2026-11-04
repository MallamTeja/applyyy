/* The Applied jobs page as drawn (features/applied/AppliedJobsPage.tsx), 2026-11-04.
 * apps/web has no DOM lib, so the row and list views are rendered statically with react-dom/server:
 * they are pure (everything arrives as props), so the markup is exactly what the operator sees.
 * The rules behind them are tested in appliedView.test.ts; this file proves the page USES them.
 * Two tests here are the red-on-revert guards the brief asked for: "shows exactly the stage
 * buttons its edges allow" and "a null resume path ... offers the rebuild". */

// The .tsx loader; must run before any component is imported.
import './support/registerTsxHooks.ts';
// Strict asserts: deepEqual compares order, which the stage-button checks rely on.
import assert from 'node:assert/strict';
// Reads the page source for the query shapes a static render cannot reach.
import { readFileSync } from 'node:fs';
// node:test, like every web test (package.json "test").
import { describe, it } from 'node:test';

// Dynamic, after the hook: the page and its imports are .tsx and extensionless.
const pageMod = await import('../src/features/applied/AppliedJobsPage.tsx');
// The pure rules, to build fixtures through the same readers the page uses.
const view = await import('../src/features/applied/appliedView.ts');
// Static render, no DOM needed.
const render = (await import('react-dom/server')).renderToStaticMarkup as (element: unknown) => string;
// Element factory, so the test needs no JSX.
const h = (await import('react')).createElement as (type: unknown, props: unknown) => unknown;

// Today's live human edges out of the page stages (fixture only; the page reads the live table).
const LIVE_EDGES = view.readEdges([
  ['applied', 'employer_screening'], ['applied', 'oa_pending'], ['applied', 'interview'], ['applied', 'rejected'],
  ['employer_screening', 'oa_pending'], ['employer_screening', 'interview'], ['employer_screening', 'rejected'],
  ['oa_pending', 'interview'], ['oa_pending', 'rejected'],
  ['interview', 'oa_pending'], ['interview', 'offer'], ['interview', 'rejected'],
].map(([from_status, to_status]) => ({ from_status, to_status, allowed_agents: ['tracker', 'human'] })));

// The smallest frozen resume readResumeSnapshot accepts.
const FROZEN_RESUME = { schema_version: 1, master_version: 3, identity: { full_name: 'Teja Mallam' }, experience: [], skills: [], projects: [], education: [] };

// One validated row; `over` replaces stored fields before the reader runs.
function row(over: Record<string, unknown> = {}) {
  // The stored shape the page's select returns.
  const read = view.readAppliedRow({
    id: 'a1b2c3d4-0000-4000-8000-000000000001',
    status: 'applied',
    updated_at: '2026-11-03T09:15:00.123456+00:00',
    applied_at: '2026-11-03T09:15:00.123456+00:00',
    resume_storage_path: 'user-1/a1b2c3d4/1762161300000.pdf',
    screenshot_storage_path: null,
    tailored_profile: FROZEN_RESUME,
    jobs: { title: 'Backend Engineer', company_name: 'Stripe', locations: ['Bengaluru, India'], apply_url: 'https://boards.greenhouse.io/stripe/jobs/1' },
    application_events: [],
    email_events: [],
    ...over,
  });
  // A fixture that does not read is a broken test.
  assert.ok(read !== null, 'fixture must read');
  // Proven non-null above.
  return read;
}

// One row as drawn, with the given edges state and row error.
function drawRow(r: ReturnType<typeof row>, edges: unknown = { kind: 'ok', edges: LIVE_EDGES }, error: string | null = null): string {
  // Fixed "now" two days after the fixture's applied date, so the day count is stable.
  return render(h(pageMod.AppliedRowView, { row: r, edges, busy: false, error, now: Date.UTC(2026, 10, 5, 10), onMove: () => {} }));
}

// The visible text of every stage button, in order: the exact list, a positive shape.
function stageButtons(html: string): string[] {
  // Stage buttons carry their own class; the text between the tags is the stage label.
  return [...html.matchAll(/<button[^>]*class="[^"]*applied-row__move[^"]*"[^>]*>([^<]*)<\/button>/g)].map((m) => m[1] ?? '');
}

describe('stage buttons', () => {
  it('an applied row shows exactly the stage buttons its edges allow', () => {
    // Offer has no edge from applied, so it is not a button.
    assert.deepEqual(stageButtons(drawRow(row())), ['Shortlisted', 'OA', 'Interview', 'Rejected']);
  });

  it('a shortlisted row shows OA, Interview and Rejected', () => {
    // Its own stage and the edges it lacks are not buttons.
    assert.deepEqual(stageButtons(drawRow(row({ status: 'employer_screening' }))), ['OA', 'Interview', 'Rejected']);
  });

  it('names each stage button with its row, for screen readers', () => {
    // Label first (label-in-name), then which job.
    assert.match(drawRow(row()), /aria-label="Shortlisted: Backend Engineer at Stripe"/);
  });

  it('shows no stage buttons and says why when the edges could not be read', () => {
    // A failed read never falls back to a remembered graph.
    const html = drawRow(row(), { kind: 'error', message: 'permission denied' });
    // No stage buttons at all.
    assert.deepEqual(stageButtons(html), []);
    // And the reason is said, in the database's words.
    assert.match(html, /Stage moves are unavailable: the transition graph could not be read \(permission denied\)/);
  });

  it('says there is no further move from a stage no edge leaves', () => {
    // Rejected is terminal in the live graph.
    assert.match(drawRow(row({ status: 'rejected' })), /No further stage moves from Rejected\./);
  });

  it("shows a refused move's error on its row", () => {
    // role=alert so it is announced.
    assert.match(drawRow(row(), undefined, 'Not moved (23514): illegal status transition'), /role="alert"[^>]*>Not moved \(23514\): illegal status transition/);
  });
});

describe('row text', () => {
  it('labels an employer_screening row "Shortlisted" on its chip', () => {
    // The StatusBadge label, not the raw status.
    assert.match(drawRow(row({ status: 'employer_screening' })), /status-badge--employer_screening[^>]*>(?:<span[^>]*><\/span>)?<span class="status-badge__label">Shortlisted<\/span>/);
  });

  it('shows the applied date and the days since', () => {
    // Applied Nov 3, "now" Nov 5 10:00 UTC: two whole days.
    const html = drawRow(row());
    // The date, in the operator's locale.
    assert.match(html, /3 Nov 2026/);
    // The day count, from the fixed "now".
    assert.match(html, /2 days since applied/);
  });

  it('shows — for both when no date is known', () => {
    // No applied_at and no event: missing, said as missing.
    const html = drawRow(row({ applied_at: null }));
    // Date and count both "—": never 1970, never today.
    assert.match(html, /Applied <time>—<\/time> · —/);
  });

  it('links the posting only through safeHref', () => {
    // A javascript: URL from a board is not a link.
    assert.match(drawRow(row({ jobs: { title: 'X', company_name: 'Y', locations: [], apply_url: 'javascript:alert(1)' } })), /Apply link unavailable/);
    // A real one opens in a new tab with no handle back.
    assert.match(drawRow(row()), /<a[^>]*href="https:\/\/boards\.greenhouse\.io\/stripe\/jobs\/1"[^>]*rel="noopener noreferrer"/);
  });
});

describe('documents', () => {
  it('a null resume path with a frozen resume offers the rebuild, labelled as not the uploaded file', () => {
    // The exact wording Teja asked for, so nobody takes the rebuild for the sent file.
    assert.match(drawRow(row({ resume_storage_path: null })), /Rebuilt from the approved resume — not the uploaded file/);
  });

  it('a stored resume path offers the submitted file for download', () => {
    // The signed-URL button.
    assert.match(drawRow(row()), />Download submitted resume<\/button>/);
  });

  it('says so when there is neither a stored file nor a frozen resume', () => {
    // Nothing to download and nothing to rebuild.
    assert.match(drawRow(row({ resume_storage_path: null, tailored_profile: {} })), /No resume is on record for this application\./);
  });

  it('says no cover letter was sent', () => {
    // The worker never attaches one.
    assert.match(drawRow(row()), /No cover letter was sent/);
  });

  it('offers the form screenshot when one was stored', () => {
    // The screenshot button appears with a path.
    assert.match(drawRow(row({ screenshot_storage_path: 'user-1/a1b2/form.png' })), />Download form screenshot<\/button>/);
  });
});

describe('timeline and interview prep', () => {
  it('says when the row has no history yet', () => {
    // The normal case today: no matched emails.
    assert.match(drawRow(row()), /No status changes or emails yet\./);
  });

  it('lists status changes and matched emails, oldest first', () => {
    // One of each.
    const html = drawRow(row({
      application_events: [{ event_type: 'status_change', from_status: 'applying', to_status: 'applied', created_at: '2026-11-03T09:15:00Z' }],
      email_events: [{ from_address: 'jobs@stripe.com', subject: 'Thanks for applying', received_at: '2026-11-03T09:20:00Z', classification: 'acknowledgement' }],
    }));
    // Both, in time order.
    const moved = html.indexOf('applying to Applied');
    // Where the email line sits in the markup.
    const mail = html.indexOf('Thanks for applying');
    // Both drawn, the status change before the email.
    assert.ok(moved > -1 && mail > moved, 'status change first, then the email');
    // The summary counts both items.
    assert.match(html, /Timeline \(2\)/);
  });

  it('an interview row carries the interview prep panel', () => {
    // The panel's own first render (it fetches after mount).
    assert.match(drawRow(row({ status: 'interview' })), /Loading interview prep materials/);
  });
});

describe('list states', () => {
  // The list view with a given read and view.
  const drawList = (read: unknown, v = view.DEFAULT_APPLIED_VIEW) =>
    render(h(pageMod.AppliedListView, { read, edges: { kind: 'ok', edges: LIVE_EDGES }, view: v, onView: () => {}, busy: new Set(), errors: new Map(), now: Date.UTC(2026, 10, 5), onMove: () => {} }));

  it('says no applied jobs yet for an empty, successful read', () => {
    // The empty state is a measured fact, only after a read.
    assert.match(drawList({ kind: 'rows', rows: [], more: false }), /No applied jobs yet\./);
  });

  it('says nothing matches when a search hides every row, not that the list is empty', () => {
    // A filtered-out list is not an empty one.
    assert.match(drawList({ kind: 'rows', rows: [row()], more: false }, { ...view.DEFAULT_APPLIED_VIEW, search: 'nomatch' }), /No applied jobs match this search and stage\./);
  });

  it('lists All and every stage with its count in the stage filter', () => {
    // One applied row and one shortlisted row.
    const html = drawList({ kind: 'rows', rows: [row(), row({ id: 'b', status: 'employer_screening' })], more: false });
    // All counts every row.
    assert.match(html, /<option value="all"[^>]*>All \(2\)<\/option>/);
    // The filter uses Teja's label and counts its one row.
    assert.match(html, /<option value="employer_screening"[^>]*>Shortlisted \(1\)<\/option>/);
    // An empty stage is still offered, with 0.
    assert.match(html, /<option value="offer"[^>]*>Offer \(0\)<\/option>/);
  });

  it('says a failed read failed', () => {
    // role=alert: a list that cannot be read is not an empty one.
    assert.match(drawList({ kind: 'error', message: 'timeout' }), /role="alert"[^>]*>Could not read applied jobs: timeout/);
  });
});

describe('page wiring', () => {
  // The page source; read for the query shapes a static render cannot reach.
  const source = readFileSync(new URL('../src/features/applied/AppliedJobsPage.tsx', import.meta.url), 'utf8');

  it('reads the legal moves from the live transitions table, human edges only', () => {
    // The table, and the human filter on its actor array.
    assert.match(source, /\.from\('application_status_transitions'\)/);
    // Human edges only: the browser sends no agent key.
    assert.match(source, /\.contains\('allowed_agents', \['human'\]\)/);
  });

  it('moves a row only through advance_application_status with the built arguments', () => {
    // The one write, through the pure argument builder.
    assert.match(source, /\.rpc\('advance_application_status', buildMoveArgs\(row, to\)\)/);
  });

  it('confirms every stage move inline', () => {
    // The app's inline confirm, armed by the button.
    assert.match(source, /import \{ InlineConfirm, armConfirm \} from '\.\.\/\.\.\/app\/InlineConfirm';/);
    // Each stage button arms the confirm; none writes on click.
    assert.match(source, /onClick=\{\(e\) => armConfirm\(confirmId, \{/);
  });

  it('signs downloads from the private resumes and screenshots buckets', () => {
    // Both buckets, through createSignedUrl with a download name.
    assert.match(source, /bucket="resumes"/);
    // The form screenshot, from its own bucket.
    assert.match(source, /bucket="screenshots"/);
    // Signed per click, named after the stored file.
    assert.match(source, /createSignedUrl\(props\.path, SIGNED_URL_SECONDS, \{ download: fileNameOf\(props\.path\) \}\)/);
  });
});
