/* The Applied jobs page (/applied) in a real browser, 2026-11-05.
 *
 * WHY A BROWSER TEST ON TOP OF THE STATIC ONES. test/appliedPage.test.ts renders the pure views with
 * react-dom/server, which proves the markup but not the page: the route, the rail entry, the two
 * reads the page really sends, the inline confirm's focus and clicks, and that no browser dialog ever
 * opens. This file serves the e2e bundle (dist/, built by `vite build --mode e2e`) and answers every
 * Supabase call locally, so a click here can never reach the live database.
 *
 * FIXTURES MIRROR LIVE (2026-11-04): 2 rows at applied, 1 with a stored resume, 0 at a later stage,
 * no matched emails. So the sparse row (no file, no date, no link) is the normal row, not an edge case.
 * The edges are the 12 human edges application_status_transitions held on 2026-11-05 (read live).
 *
 * RED-ON-REVERT (measured when this file landed): offering every stage instead of legalNextStages(...)
 * fails test 1 by an extra "Offer" button; dropping the RebuiltResume branch fails test 1 by the
 * missing rebuild label. */

// Strict asserts: deepEqual compares order too, which is what the stage-button check needs.
import assert from 'node:assert/strict';
// Type only: the shared harness's server, kept so after() can close it.
import type { Server } from 'node:http';
// node:test, like every other web test (package.json "test").
import { describe, it, before, beforeEach, after } from 'node:test';
// Real Chromium; the same Playwright the e2e suite uses (apps/web/node_modules).
import { chromium, type Browser, type BrowserContext, type Dialog, type Page } from 'playwright';
// The shared harness (test/support/e2eDist.ts): dist guard, static SPA server, fake session. This file
// carried its own copies until 2026-11-05; one copy means a guard fix lands in every browser test at once.
import { assertDistIsTestable, seedSession, startDistServer } from './support/e2eDist.ts';

// The operator the fake session and the auth answers name.
const USER_ID = '0f4b24da-e85b-40bb-8606-c81824493b45';

// The smallest frozen resume readResumeSnapshot accepts (same as appliedPage.test.ts).
const FROZEN_RESUME = { schema_version: 1, master_version: 3, identity: { full_name: 'Teja Mallam' }, experience: [], skills: [], projects: [], education: [] };

// The row WITH a stored resume, as the page's select returns it.
const ROW_FILED = {
  // The RPC target and the confirm key.
  id: 'a1b2c3d4-0000-4000-8000-000000000001',
  // Submitted, nothing heard.
  status: 'applied',
  // The stale-stamp guard's value, sent back verbatim as p_expected_updated_at.
  updated_at: '2026-11-03T09:15:00.123456+00:00',
  // A real applied date.
  applied_at: '2026-11-03T09:15:00.123456+00:00',
  // The file the worker uploaded.
  resume_storage_path: `${USER_ID}/a1b2c3d4/1762161300000.pdf`,
  // No form screenshot.
  screenshot_storage_path: null,
  // Present, but the stored file wins.
  tailored_profile: FROZEN_RESUME,
  // The job, as PostgREST nests it.
  jobs: { title: 'E2E Backend Engineer', company_name: 'Acme', locations: ['Bengaluru, India'], apply_url: 'https://example.com/jobs/1' },
  // The move into applied: the timeline's one line.
  application_events: [{ event_type: 'status_change', from_status: 'applying', to_status: 'applied', created_at: '2026-11-03T09:15:00.123456+00:00' }],
  // No matched emails (live: none).
  email_events: [],
};

// The SPARSE row: no stored file, no date, no link, no history. Live, this is half the rows.
const ROW_SPARSE = {
  // A second row, so the per-row names must disambiguate.
  id: 'a1b2c3d4-0000-4000-8000-000000000002',
  // Same stage, so both rows get the same four moves.
  status: 'applied',
  // The stamp.
  updated_at: '2026-11-02T10:00:00+00:00',
  // Unknown: the page must say "—", never 1970 or today.
  applied_at: null,
  // No stored file: the rebuild must be offered, labelled.
  resume_storage_path: null,
  // No screenshot.
  screenshot_storage_path: null,
  // The frozen approved resume the rebuild renders.
  tailored_profile: FROZEN_RESUME,
  // No locations, no link.
  jobs: { title: 'E2E Data Engineer', company_name: 'Globex', locations: [], apply_url: null },
  // No history.
  application_events: [],
  // No emails.
  email_events: [],
};

// The live human edges out of the page stages, 2026-11-05 (12 rows; applied -> offer is NOT one).
const LIVE_EDGES = [
  ['applied', 'employer_screening'], ['applied', 'interview'], ['applied', 'oa_pending'], ['applied', 'rejected'],
  ['employer_screening', 'interview'], ['employer_screening', 'oa_pending'], ['employer_screening', 'rejected'],
  ['interview', 'oa_pending'], ['interview', 'offer'], ['interview', 'rejected'],
  ['oa_pending', 'interview'], ['oa_pending', 'rejected'],
].map(([from_status, to_status]) => ({ from_status, to_status, allowed_agents: ['tracker', 'human'] }));

/* What the mocked database answers: both rows, none, or a failed read of one table. */
type Mode = 'rows' | 'empty' | 'graph-500' | 'rows-500';

describe('Applied jobs page in a browser (fake session, every Supabase call answered locally)', () => {
  // The static server.
  let server: Server;
  // Its address.
  let base: string;
  // Chromium.
  let browser: Browser;
  // The signed-in context.
  let context: BrowserContext;
  // The one tab.
  let page: Page;
  // Set when dist/ cannot prove anything; rethrown per test so each FAILS (a throwing before() cancels).
  let guardError: Error | undefined;
  // The current fixture mode; each test sets it before navigating.
  let mode: Mode = 'rows';
  // Requests to the one write path; must stay 0 until a Confirm.
  let rpcCalls = 0;
  // The last write's JSON body, to pin actor, target and stamp.
  let rpcBody: unknown = null;
  // The applications GET URLs the page sent, to pin its filters.
  const appsReads: URL[] = [];
  // The transitions GET URLs the page sent.
  const graphReads: URL[] = [];
  // Browser dialogs (confirm/alert/prompt) opened; must stay 0 everywhere.
  let dialogs = 0;

  // A guard failure marks each test FAILED with the named reason.
  beforeEach(() => {
    // Rethrown, not thrown in before(): cancelled tests read as "fail 0".
    if (guardError) throw guardError;
  });

  before(async () => {
    // The guard's outcome, recorded.
    guardError = await assertDistIsTestable().then(() => undefined, (e: unknown) => (e instanceof Error ? e : new Error(String(e))));
    // Nothing to start for a refused dist.
    if (guardError) return;
    // dist/ as an SPA on a free port (unknown paths get index.html, so the client router serves /applied).
    ({ server, base } = await startDistServer());
    // Headless Chromium.
    browser = await chromium.launch({ headless: true });
    // A fresh context per file.
    context = await browser.newContext();
    // EVERY Supabase call answered here: nothing can reach the live project.
    await context.route('https://*.supabase.co/**', async (route) => {
      // The request's URL, parsed for its filters.
      const url = new URL(route.request().url());
      // A JSON answer.
      const json = (status: number, body: unknown) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
      // Auth: the seeded session's user.
      if (url.pathname.startsWith('/auth/v1/')) return json(200, { id: USER_ID, aud: 'authenticated', role: 'authenticated', email: 'operator@example.test' });
      // The one write path: counted, its body kept, answered as accepted (200 + null, like the real RPC).
      if (url.pathname === '/rest/v1/rpc/advance_application_status') {
        // Counted first.
        rpcCalls += 1;
        // The arguments the page sent.
        rpcBody = route.request().postDataJSON();
        // Accepted.
        return route.fulfill({ status: 200, contentType: 'application/json', body: 'null' });
      }
      // The page's rows read.
      if (url.pathname === '/rest/v1/applications') {
        // Kept, to pin the filters below.
        appsReads.push(url);
        // A failed read, in PostgREST's error shape.
        if (mode === 'rows-500') return json(500, { code: 'XX000', message: 'e2e: applications read failed', details: null, hint: null });
        // None, or both rows.
        return json(200, mode === 'empty' ? [] : [ROW_FILED, ROW_SPARSE]);
      }
      // The page's graph read.
      if (url.pathname === '/rest/v1/application_status_transitions') {
        // Kept, to pin the filters below.
        graphReads.push(url);
        // A failed read: the page must show NO buttons, never a remembered graph.
        if (mode === 'graph-500') return json(500, { code: 'XX000', message: 'e2e: graph read failed', details: null, hint: null });
        // The live edges.
        return json(200, LIVE_EDGES);
      }
      // Every other read the shell makes: an empty list.
      return json(200, []);
    });
    // The fake session supabase-js reads on boot; far-future expiry, so no refresh POST.
    await seedSession(context, USER_ID);
    // The tab.
    page = await context.newPage();
    // Counts AND dismisses, so a restored window.confirm fails by name instead of hanging the test.
    page.on('dialog', (d: Dialog) => {
      // Counted first.
      dialogs += 1;
      // Dismissed, as a Cancel would.
      void d.dismiss().catch(() => {});
    });
  });

  after(async () => {
    // Each closed if it started; a refused dist started none of them.
    if (page) await page.close().catch(() => {});
    // The context.
    if (context) await context.close().catch(() => {});
    // The browser.
    if (browser) await browser.close().catch(() => {});
    // The server.
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  // One row's card, found by its heading.
  const card = (title: string) => page.locator('li.applied-row', { has: page.locator('h2', { hasText: title }) });
  // The accessible names of a card's stage buttons, in DOM order.
  const moveNames = (title: string) => card(title).locator('.applied-row__move').evaluateAll((els) => els.map((el) => el.getAttribute('aria-label')));

  it('1. reached from the rail; shows the stored resume, the labelled rebuild, and only the legal moves; a move asks inline and writes once', async () => {
    // Both rows.
    mode = 'rows';
    // Start somewhere else, so the rail entry is the way in.
    await page.goto(`${base}/pipeline`, { waitUntil: 'domcontentloaded' });
    // The rail link routes.ts adds.
    await page.getByRole('link', { name: 'Applied jobs', exact: true }).click();
    // The router took it there.
    await page.waitForURL(`${base}/applied`);
    /* The URL changes BEFORE React renders the new route, so the heading is awaited, not read at once:
       a bare textContent() here read the old page's "Pipeline" on CI's slower CPU (2026-11-05, c36b771;
       reproduced 3/3 under a 6x CDP CPU throttle). A missing route entry reads "Unknown screen", so the
       wait times out and the assert below names the wrong heading. */
    await page.locator('h1.page__title', { hasText: /^Applied jobs$/ }).waitFor({ timeout: 10_000 }).catch(() => {});
    // The heading comes from the route table: without the entry it reads "Unknown screen".
    assert.equal(await page.locator('h1.page__title').textContent(), 'Applied jobs');
    // Both cards rendered from the read.
    await card('E2E Data Engineer').waitFor();
    // The rows read carried the page's filters: the six stages, and status_change events only.
    /* The PAGE's read, picked by its own embed filter, never "the last applications read": since 2026-11-05
       the AppShell rail badge also reads applications (status=in.(approved), via loadManualApply), and that
       read sometimes landed last, so this test failed ~2 runs in 3 on a read that was not the page's. */
    const apps = appsReads.filter((url) => url.searchParams.has('application_events.event_type')).at(-1);
    // A read happened.
    assert.ok(apps, 'the page must read applications');
    // The six post-apply stages, in pipeline order.
    assert.equal(apps.searchParams.get('status'), 'in.(applied,employer_screening,oa_pending,interview,offer,rejected)');
    // The embed filter the PostgREST probe proves live.
    assert.equal(apps.searchParams.get('application_events.event_type'), 'eq.status_change');
    // The graph read asks for human edges out of the page stages only.
    const graph = graphReads.at(-1);
    // A read happened.
    assert.ok(graph, 'the page must read the transition graph');
    // Human edges only: the browser sends no agent key.
    assert.equal(graph.searchParams.get('allowed_agents'), 'cs.{human}');
    // The stored file: a download button named for its row.
    await card('E2E Backend Engineer').getByRole('button', { name: 'Download submitted resume: E2E Backend Engineer at Acme', exact: true }).waitFor();
    // No stored file: the rebuild, under Teja's exact label (red when the RebuiltResume branch is dropped).
    assert.equal(await card('E2E Data Engineer').locator('details.applied-row__rebuild > summary').textContent(), 'Rebuilt from the approved resume — not the uploaded file');
    // The filed row offers no rebuild: the file wins.
    assert.equal(await card('E2E Backend Engineer').locator('details.applied-row__rebuild').count(), 0);
    // Both cards say no cover letter was sent.
    assert.equal(await page.getByText('No cover letter was sent', { exact: true }).count(), 2);
    // The sparse row's unknown date is "—", never 1970 or today.
    assert.match((await card('E2E Data Engineer').locator('.applied-row__meta').textContent()) ?? '', /^Applied — · —$/);
    // Exactly the live edges out of applied, in page order; no Offer (red when every stage is offered).
    assert.deepEqual(await moveNames('E2E Backend Engineer'), ['Shortlisted', 'OA', 'Interview', 'Rejected'].map((s) => `${s}: E2E Backend Engineer at Acme`));
    // The move under test.
    const moveName = 'Shortlisted: E2E Backend Engineer at Acme';
    // Arm: the first click only asks.
    await page.getByRole('button', { name: moveName, exact: true }).click();
    // The confirm's Cancel, named for the move.
    const cancel = page.getByRole('button', { name: `Cancel: ${moveName}`, exact: true });
    // Rendered on arming.
    await cancel.waitFor();
    // The sentence names the row and both stage labels ("Shortlisted", never "employer_screening").
    assert.match((await page.locator('p.inline-confirm__sentence', { hasText: 'Move "E2E Backend Engineer at Acme"' }).textContent()) ?? '', /from Applied to Shortlisted\?/);
    // Arming wrote nothing.
    assert.equal(rpcCalls, 0, 'the first click must not write');
    // Cancel.
    await cancel.click();
    // Closed.
    await cancel.waitFor({ state: 'detached' });
    // Cancel wrote nothing.
    assert.equal(rpcCalls, 0, 'Cancel must not write');
    // Arm again, then Esc.
    await page.getByRole('button', { name: moveName, exact: true }).click();
    // Open again.
    await cancel.waitFor();
    // The keyboard cancel.
    await page.keyboard.press('Escape');
    // Closed by Esc.
    await cancel.waitFor({ state: 'detached' });
    // Esc wrote nothing.
    assert.equal(rpcCalls, 0, 'Esc must not write');
    // Arm a third time, to Confirm.
    await page.getByRole('button', { name: moveName, exact: true }).click();
    // The write that leaves on Confirm; a restored popup would block it (timeout -> null).
    const write = page.waitForRequest('**/rest/v1/rpc/advance_application_status', { timeout: 5_000 }).catch(() => null);
    // Confirm, by its row-specific name.
    await page.getByRole('button', { name: `Confirm: ${moveName}`, exact: true }).click();
    // Settled once the mocked answer exists.
    await (await write)?.response();
    // No browser dialog at any step (checked first, so a restored window.confirm fails HERE by name).
    assert.equal(dialogs, 0, 'a browser dialog opened: every move must ask inline');
    // Exactly one write for one Confirm.
    assert.equal(rpcCalls, 1, 'Confirm must send exactly one advance_application_status');
    // As human, to the chosen stage, with the row's stamp verbatim.
    assert.deepEqual(rpcBody, { p_application_id: ROW_FILED.id, p_to_status: 'employer_screening', p_agent: 'human', p_detail: { source: 'applied_page', from: 'applied' }, p_expected_updated_at: ROW_FILED.updated_at });
  });

  it('2. phone width: no sideways page scroll with both cards', async () => {
    // Both rows.
    mode = 'rows';
    // The narrow width Teja's phone uses.
    await page.setViewportSize({ width: 390, height: 900 });
    try {
      // A fresh load at this width.
      await page.goto(`${base}/applied`, { waitUntil: 'domcontentloaded' });
      // Both cards laid out.
      await card('E2E Data Engineer').waitFor();
      // The page is no wider than the viewport (Applied.css untested until now).
      const [scroll, inner] = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
      // Equal or narrower.
      assert.ok(scroll <= inner, `the page scrolls sideways at 390px: scrollWidth ${scroll} > ${inner}`);
    } finally {
      // Back to the default the other tests assume.
      await page.setViewportSize({ width: 1280, height: 720 });
    }
  });

  it('3. an empty read says so: no list, no buttons', async () => {
    // A successful read with no rows (live, before the first submit).
    mode = 'empty';
    // Fresh load.
    await page.goto(`${base}/applied`, { waitUntil: 'domcontentloaded' });
    // The measured empty state.
    await page.getByText('No applied jobs yet. An application appears here once its submission is confirmed.', { exact: true }).waitFor();
    // No cards.
    assert.equal(await page.locator('li.applied-row').count(), 0);
  });

  it('4. a failed graph read shows the rows with NO stage buttons and says why', async () => {
    // Rows fine, transitions 500.
    mode = 'graph-500';
    // Fresh load.
    await page.goto(`${base}/applied`, { waitUntil: 'domcontentloaded' });
    // The rows still render.
    await card('E2E Backend Engineer').waitFor();
    // The reason, per row.
    await card('E2E Backend Engineer').getByText(/^Stage moves are unavailable: the transition graph could not be read/).waitFor();
    // Never a remembered graph: zero stage buttons on the page.
    assert.equal(await page.locator('.applied-row__move').count(), 0);
  });

  it('5. a failed rows read is an error, never an empty list', async () => {
    // Applications 500.
    mode = 'rows-500';
    // Fresh load.
    await page.goto(`${base}/applied`, { waitUntil: 'domcontentloaded' });
    // Announced as an error.
    await page.locator('p.applied__note[role="alert"]', { hasText: 'Could not read applied jobs' }).waitFor();
    // Not the empty state.
    assert.equal(await page.getByText('No applied jobs yet.', { exact: false }).count(), 0);
    // No browser dialog across the whole file.
    assert.equal(dialogs, 0);
  });
});
