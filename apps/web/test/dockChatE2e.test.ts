/* The docked AI chat, end to end in a real browser (Teja, 2026-11-06: "an AI chat on the right of the
 * approval queue; every job gets its own chat; it edits only that job's resume; I see the change live").
 *
 * WHAT IT PROVES, against the built bundle in Chromium with Supabase and resume-assist answered by routes:
 *   1. No chat is on screen until a row's chat is opened (the dock is absent, not empty).
 *   2. Opening row 1's chat docks it in the right-hand aside, titled with row 1's job; an edit sent there
 *      is saved to row 1 and row 1's live preview shows it.
 *   3. Opening row 2's chat REPLACES the dock: row 1's thread is gone from view, row 2's thread is empty,
 *      and an edit sent there is saved to row 2 only. Every PATCH of the run names the row it was typed on.
 * Needs the e2e bundle: cd apps/web && ./node_modules/.bin/vite build --mode e2e (CI builds it first). */

// Strict asserts.
import assert from 'node:assert/strict';
// The Server type only: the shared harness starts it, after() closes it.
import type { Server } from 'node:http';
// The runner; beforeEach turns a guard failure into a FAILED test rather than a cancelled one.
import { after, before, beforeEach, describe, it } from 'node:test';
// The browser, already a dependency of this package.
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
// The live row's three jsonb values, anonymised.
import { STORED_TAILORED_PROFILE, TAILOR_REFS, MASTER_V2 } from './fixtures/gitlab-row-anonymised.ts';
// The shared browser-test harness.
import { assertDistIsTestable, seedSession, startDistServer } from './support/e2eDist.ts';

// The operator the fake session signs in as.
const USER = { id: '0f4b24da-e85b-40bb-8606-c81824493b45', aud: 'authenticated', role: 'authenticated', email: 'operator@example.test' };
// The stamp both rows load with.
const STAMP_0 = '2026-11-05T00:00:00.000000+00:00';

/* Two applications, distinct in id and job title so every assertion can tell them apart. */
const APPS = [
  { id: '33333333-3333-4333-8333-333333333331', title: 'Dock Engineer One', skill: { name: 'SQL', category: 'Languages' } },
  { id: '33333333-3333-4333-8333-333333333332', title: 'Dock Engineer Two', skill: { name: 'RAG Pipelines', category: 'AI' } },
] as const;

/* One stored row per application, mutable: the PATCH route writes into it. */
function makeRow(app: (typeof APPS)[number]): Record<string, unknown> {
  return {
    id: app.id,
    user_id: USER.id,
    job_id: `job-${app.id}`,
    status: 'awaiting_approval',
    // A deep copy per row, so one row's save can never show up in the other.
    tailored_profile: structuredClone(STORED_TAILORED_PROFILE),
    tailor_refs: TAILOR_REFS,
    audit_findings: [],
    selected_jd_keywords: [],
    match_score: 41,
    cover_letter: null,
    updated_at: STAMP_0,
    status_changed_at: STAMP_0,
    created_at: STAMP_0,
    jobs: { title: app.title, company_name: 'Acme', employment_type: null, work_arrangement: 'remote', locations: [], salary_min: null, salary_max: null, salary_currency: null, discovered_via: null, source_refs: [], apply_url: 'https://example.com/jobs/dock', description_raw: 'A backend role.', application_deadline: null },
  };
}

// The rows, by id.
const ROWS = new Map(APPS.map((a) => [a.id, makeRow(a)]));

/* A PostgREST answer: a single object when the client asked for one, else an array. */
function pgrst(accept: string | undefined, row: unknown): string {
  // The single-object media type means "one row, not a list".
  return JSON.stringify(accept?.includes('vnd.pgrst.object') === true ? row : [row]);
}

// The saved resume, typed just enough for the assertions.
type Saved = { skills: { name: string }[] };

describe('docked AI chat, end to end (2026-11-06)', () => {
  // The static server.
  let server: Server;
  // Where it listens.
  let baseUrl: string;
  // Chromium.
  let browser: Browser;
  // The signed-in context with the routes.
  let context: BrowserContext;
  // The page every step drives.
  let page: Page;
  // A dist that cannot prove anything, recorded so each test fails by name instead of being cancelled.
  let guardError: Error | undefined;
  // The id each accepted PATCH named, in order.
  const patchedIds: string[] = [];
  // The stored chat messages, as the table would hold them.
  const chats: Record<string, unknown>[] = [];

  // Rethrown per test: a failed before() would CANCEL them (CLAUDE.md section 5), which proves nothing.
  beforeEach(() => {
    // The guard's own message, as each test's failure.
    if (guardError) throw guardError;
  });

  before(async () => {
    // Missing, stale or unconfigured dist: recorded, not thrown.
    guardError = await assertDistIsTestable().then(() => undefined, (e: unknown) => (e instanceof Error ? e : new Error(String(e))));
    // Nothing worth serving.
    if (guardError) return;
    // The shared SPA server on a free loopback port.
    ({ server, base: baseUrl } = await startDistServer());
    // Headless, as CI runs it.
    browser = await chromium.launch({ headless: true });
    // A fresh context per run.
    context = await browser.newContext();
    // Every Supabase call answered here; nothing reaches the network.
    await context.route('https://*.supabase.co/**', async (route) => {
      // The request's parts the answers depend on.
      const request = route.request();
      // Parsed once.
      const url = new URL(request.url());
      // Which representation a read asked for.
      const accept = request.headers()['accept'];
      // One JSON answer.
      const json = (status: number, body: unknown) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
      // The session's user.
      if (url.pathname.endsWith('/auth/v1/user')) return json(200, USER);
      // A refreshed session, should the client ask.
      if (url.pathname.endsWith('/auth/v1/token')) return json(200, { access_token: 'e2e-test-token', token_type: 'bearer', expires_in: 7200, refresh_token: 'e2e-test-refresh', user: USER });
      // THE AI: one master skill, picked by the job title the browser sent (so each row's answer is its own).
      if (url.pathname.endsWith('/functions/v1/resume-assist')) {
        // The request the browser sent.
        const body = request.postDataJSON() as { job: { title: string } };
        // The app this job title belongs to.
        const app = APPS.find((a) => a.title === body.job.title);
        // A request for an unknown job is a test bug, said by name.
        if (app === undefined) return json(500, { status: 'error', message: `e2e: unknown job ${body.job.title}` });
        // The server's ok shape (assist.ts handleResumeAssist).
        return json(200, { status: 'ok', ops: [{ op: 'add_skill', ...app.skill }], dropped: 0, rejected: [], note: `Done for ${app.title}`, usage: {} });
      }
      // THE RESUME WRITE: saveTailoredEdit's guarded update, matched on id, status and stamp.
      if (url.pathname.endsWith('/rest/v1/applications') && request.method() === 'PATCH') {
        // The id the write names.
        const id = (url.searchParams.get('id') ?? '').replace('eq.', '');
        // That row.
        const row = ROWS.get(id);
        // The optimistic lock the database applies.
        if (row === undefined || url.searchParams.get('updated_at') !== `eq.${String(row.updated_at)}` || url.searchParams.get('status') !== 'eq.awaiting_approval') return json(200, []);
        // Recorded: the scoping assertion reads this.
        patchedIds.push(id);
        // Stored, so a read-back sees it.
        Object.assign(row, request.postDataJSON() as Record<string, unknown>, { updated_at: `2026-11-05T00:00:${String(patchedIds.length).padStart(2, '0')}.000000+00:00` });
        // The one row, with its new stamp.
        return json(200, [{ id, updated_at: row.updated_at }]);
      }
      // THE AUDIT TRAIL of each edit.
      if (url.pathname.endsWith('/rest/v1/application_events') && request.method() === 'POST') return json(201, []);
      // THE CHAT HISTORY: stored on insert, served per application on load.
      if (url.pathname.endsWith('/rest/v1/resume_chat_messages')) {
        // An exchange appended.
        if (request.method() === 'POST') {
          // The inserted rows, given ids and a time as the table would.
          const inserted = (request.postDataJSON() as Record<string, unknown>[]).map((m, i) => ({ ...m, id: chats.length + i + 1, created_at: `2026-11-05T01:00:${String(chats.length + i).padStart(2, '0')}.000Z` }));
          // Stored.
          chats.push(...inserted);
          // Returned, as .select() asks.
          return json(201, inserted);
        }
        // Loaded: only the asked application's messages, as the table's filter does.
        const wanted = (url.searchParams.get('application_id') ?? '').replace('eq.', '');
        // Filtered.
        return json(200, chats.filter((m) => m.application_id === wanted));
      }
      // The applications reads: the queue, and the per-row stamp check.
      if (url.pathname.endsWith('/rest/v1/applications') && request.method() === 'GET') {
        // The queue's read: both rows as stored now.
        if (url.searchParams.get('status') === 'eq.awaiting_approval') return json(200, [...ROWS.values()]);
        // The per-row read: what is stored now.
        const row = ROWS.get((url.searchParams.get('id') ?? '').replace('eq.', ''));
        // Known row.
        if (row !== undefined) return route.fulfill({ status: 200, contentType: 'application/json', body: pgrst(accept, { tailored_profile: row.tailored_profile, updated_at: row.updated_at, status: row.status }) });
      }
      // THE MASTER: versioned like the table; the rows pin v2.
      if (url.pathname.endsWith('/rest/v1/master_profiles')) {
        // The pinned version, or the newest.
        return route.fulfill({ status: 200, contentType: 'application/json', body: pgrst(accept, { profile: MASTER_V2, version: 2 }) });
      }
      // Every other read (counts, health): empty.
      return json(200, []);
    });
    // The stored session supabase-js reads on boot.
    await seedSession(context, USER.id);
    // The one page.
    page = await context.newPage();
  });

  after(async () => {
    // Each closed only if it was opened.
    if (page) await page.close().catch(() => {});
    // The context.
    if (context) await context.close().catch(() => {});
    // The browser.
    if (browser) await browser.close().catch(() => {});
    // The server.
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  /* Sends one prompt in whatever chat the dock shows, and waits for its op card to be applied. */
  async function sendInDock(prompt: string, reply: string): Promise<void> {
    // The dock's chat region.
    const chat = page.locator('.queue__dock').getByRole('region', { name: 'AI resume chat' });
    // The prompt box, ready once the history has loaded.
    const input = chat.getByLabel('Message to the AI');
    // Rendered.
    await input.waitFor({ timeout: 10_000 });
    // Typed.
    await input.fill(prompt);
    // Sent.
    await chat.getByRole('button', { name: 'Send', exact: true }).click();
    // The answer carrying this row's own words.
    const answer = chat.locator('li.ai-chat__msg--ai').filter({ hasText: reply });
    // Rendered.
    await answer.waitFor({ timeout: 10_000 });
    // Its one op card, applied by itself (a master skill).
    await answer.locator('li.ai-chat__op').first().locator('.ai-chat__done').waitFor({ timeout: 10_000 });
  }

  it('1. no chat is on screen until a row opens one', async () => {
    // The queue page.
    await page.goto(`${baseUrl}/approvals`, { waitUntil: 'domcontentloaded' });
    // Both cards rendered.
    for (const app of APPS) await page.locator(`#app-card-${app.id}`).waitFor({ timeout: 10_000 });
    // No dock, and so no chat anywhere.
    assert.equal(await page.locator('.queue__dock').count(), 0, 'the dock must not exist before a chat is opened');
    assert.equal(await page.getByRole('region', { name: 'AI resume chat' }).count(), 0, 'no chat may render inline in a card');
  });

  it('2. row 1: its chat docks on the right, titled with its job, and its edit shows in its live preview', async () => {
    // Row 1's card.
    const card = page.locator(`#app-card-${APPS[0].id}`);
    // Opens the chat in the dock.
    await card.getByRole('button', { name: 'Chat with AI', exact: true }).click();
    // The dock, naming the job.
    await page.locator('.queue__dock').getByRole('heading', { name: new RegExp(APPS[0].title) }).waitFor({ timeout: 10_000 });
    // The dock sits to the RIGHT of the card: its left edge is past the card's left edge, and it is beside, not below.
    const dockBox = await page.locator('.queue__dock').boundingBox();
    // Row 1's card box.
    const cardBox = await card.boundingBox();
    // Both measured.
    assert.ok(dockBox !== null && cardBox !== null, 'dock and card must both be on screen');
    // Beside the queue, to its right.
    assert.ok(dockBox.x >= cardBox.x + cardBox.width - 1, `the dock must sit right of the queue: dock x=${dockBox.x}, card right=${cardBox.x + cardBox.width}`);
    // Send row 1's edit.
    await sendInDock(`Add ${APPS[0].skill.name} to my skills.`, `Done for ${APPS[0].title}`);
    // Saved to row 1.
    assert.deepEqual(patchedIds, [APPS[0].id], 'row 1 edit must PATCH row 1 only');
    // Its live preview, opened by the chat button, now prints the skill.
    const frame = page.frameLocator(`iframe[title="Tailored resume for ${APPS[0].title} at Acme"]`);
    // Waits for the render after the save.
    await frame.locator('body').getByText(APPS[0].skill.name, { exact: false }).first().waitFor({ timeout: 10_000 });
  });

  it('3. row 2: the dock switches to its own empty thread, and its edit saves to row 2 only', async () => {
    // Row 2's card.
    const card = page.locator(`#app-card-${APPS[1].id}`);
    // Opens row 2's chat: replaces the dock.
    await card.getByRole('button', { name: 'Chat with AI', exact: true }).click();
    // The dock now names row 2.
    await page.locator('.queue__dock').getByRole('heading', { name: new RegExp(APPS[1].title) }).waitFor({ timeout: 10_000 });
    // Row 1's answer is not in view: threads are per row.
    assert.equal(await page.getByText(`Done for ${APPS[0].title}`).first().isVisible(), false, "row 1's thread must not show in row 2's dock");
    // Row 2's edit.
    await sendInDock(`Add ${APPS[1].skill.name} to my skills.`, `Done for ${APPS[1].title}`);
    // Every write of the run named the row it was typed on, in order.
    assert.deepEqual(patchedIds, [APPS[0].id, APPS[1].id], 'each edit must PATCH only its own row');
    // Row 1's stored resume never got row 2's skill.
    assert.ok(!(ROWS.get(APPS[0].id)!.tailored_profile as Saved).skills.some((s) => s.name === APPS[1].skill.name), "row 2's skill must not land on row 1");
    // Row 2's did.
    assert.ok((ROWS.get(APPS[1].id)!.tailored_profile as Saved).skills.some((s) => s.name === APPS[1].skill.name), "row 2's skill must land on row 2");
  });

  it('4. back to row 1: its own thread is there again, and row 2\'s is not shown', async () => {
    // Docks row 1 again.
    await page.locator(`#app-card-${APPS[0].id}`).getByRole('button', { name: 'Chat with AI', exact: true }).click();
    // Row 1's answer is visible again (the panel was hidden, not dropped).
    await page.getByText(`Done for ${APPS[0].title}`).first().waitFor({ state: 'visible', timeout: 10_000 });
    // Row 2's answer is not visible in the dock now: one thread shows at a time.
    assert.equal(await page.getByText(`Done for ${APPS[1].title}`).first().isVisible(), false, "row 2's thread must be hidden while row 1's is docked");
    // Switching around never wrote anything: still exactly the two edits.
    assert.deepEqual(patchedIds, [APPS[0].id, APPS[1].id], 'switching threads must not write');
  });
});
