/* The one-page rule, live in the approval editor, end to end in a real browser (Teja, 2026-11-07
 * 23:18 IST: "they need to be handled live while adding new skills and all, but not by AI").
 *
 * WHAT IT PROVES, against the built bundle in Chromium with Supabase and resume-assist answered by
 * routes (the aiEditE2e.test.ts harness): on a resume that is ALREADY nearly a full page, an AI
 * "add four skills" turn
 *   1. saves a resume that is ONE page (the template's own fitsOnePage), with both skills on it;
 *   2. cut a bullet to get there (skills are never trimmed), and the cut is SHOWN on the page
 *      ("Trimmed to fit one page: ...") and RECORDED in the history note (page_fit_trimmed);
 *   3. never sent a stale write, and never opened a native dialog.
 * NEAR-FULL is computed, not guessed: the operator-edited summary is lengthened until the resume
 * fits, adding the four skills overflows it, and cutting the one trimmable bullet fits it again
 * (the fixture's only bullet above its floor: the first job has 2, the floor is 1).
 * Screenshots (before/after) are written only when PAGEFIT_SHOTS_DIR is set; CI does not set it.
 *
 * Needs the e2e bundle: cd apps/web && ./node_modules/.bin/vite build --mode e2e (CI builds it first). */
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { join } from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import { chromium, type Browser, type BrowserContext, type Dialog, type Page } from 'playwright';
import { MASTER_V2, STORED_TAILORED_PROFILE, TAILOR_REFS } from './fixtures/gitlab-row-anonymised.ts';
// The shared browser-test harness (guarded dist, SPA server, seeded session).
import { assertDistIsTestable, seedSession, startDistServer } from './support/e2eDist.ts';
// The renderer's own one-page question: the same function the page's fit uses.
import { fitsOnePage } from '../../../packages/resume-template/src/index.ts';
import type { ResolvedResume } from '../src/data/contract';

// The signed-in operator.
const USER = { id: '0f4b24da-e85b-40bb-8606-c81824493b45', aud: 'authenticated', role: 'authenticated', email: 'operator@example.test' };
// The row's first stamp.
const STAMP_0 = '2026-11-07T00:00:00.000000+00:00';
// The row.
const APP_ID = '44444444-4444-4444-8444-444444444444';
// The job, as the preview frame's title names it.
const JOB_TITLE = 'Page Fit Engineer';
/* Four master AI skills not on the stored resume, as the AI answer adds them. Four, because they join the
   existing AI line and only the fourth wraps it onto a new line (measured: 1-3 add no height). */
const ADDED_SKILLS = ['RAG Pipelines', 'Prompt Engineering', 'Context Engineering', 'Tool Calling & Guardrails'].map((name) => ({ name, category: 'AI' }));
/* The prompt. It says "all" since 2026-11-12: an add that wraps a skill group onto a second line is refused
   unless the owner says "all" (tailoredEdits.skillGroupWrapReason), and this test needs exactly that wrap. */
const PROMPT = 'Add all of RAG Pipelines, Prompt Engineering, Context Engineering and Tool Calling to my skills.';

/* The resume with the four skills appended as addSkill builds them (the master's ref, name, category). */
function withAddedSkills(resume: ResolvedResume): ResolvedResume {
  // The master's own skill nodes, found by name.
  const master = (MASTER_V2 as unknown as { skills: { id: string; name: string; category: string }[] }).skills;
  // Each added skill as a resolved node.
  const added = ADDED_SKILLS.map((s) => {
    // Must exist in the master, or the fixture changed under this test.
    const node = master.find((m) => m.name === s.name);
    // Said by name.
    assert.ok(node !== undefined, `MASTER_V2 must hold the skill ${s.name}`);
    // Resolved shape.
    return { ref: node.id, name: node.name, category: node.category };
  });
  // Appended.
  return { ...resume, skills: [...resume.skills, ...added] };
}

/* The stored resume with a lengthened summary such that: fits; +4 skills overflows; minus the first job's last bullet fits. */
function nearFull(): ResolvedResume {
  // The stored fixture.
  const base = structuredClone(STORED_TAILORED_PROFILE) as unknown as ResolvedResume;
  // Words to lengthen the summary with, one at a time.
  const words = 'Built reliable backend services and data pipelines for product teams'.split(' ');
  // Grow word by word until the conditions hold (bounded).
  for (let n = 0; n < 2000; n += 1) {
    // The candidate summary.
    const summary = `${base.summary ?? ''} ${Array.from({ length: n }, (_, i) => words[i % words.length]).join(' ')}`.trim();
    // The candidate resume.
    const candidate = { ...base, summary } as ResolvedResume;
    // Must fit as stored.
    if (!fitsOnePage(candidate)) break;
    // The edit's raw result.
    const edited = withAddedSkills(candidate);
    // Not yet near-full: adding the skills still fits.
    if (fitsOnePage(edited)) continue;
    // The one trim the fit can make: the first job's last bullet.
    const trimmed = { ...edited, experience: edited.experience.map((e, i) => (i === 0 ? { ...e, bullets: e.bullets.slice(0, -1) } : e)) } as ResolvedResume;
    // Near-full exactly when that one cut fits it again.
    if (fitsOnePage(trimmed)) return candidate;
  }
  // No such length: the fixture changed; said by name rather than a vacuous pass.
  throw new Error('pageFitE2e: no summary length makes the fixture near-full; re-check the fixture');
}

/* A PostgREST answer: a single object when the client asked for one, else an array. */
function pgrst(accept: string | undefined, row: unknown): string {
  // The single-object media type means "one row, not a list".
  return JSON.stringify(accept?.includes('vnd.pgrst.object') === true ? row : [row]);
}

describe('one-page rule, live in the editor (2026-11-07)', () => {
  // The static server.
  let server: Server;
  // Where it listens.
  let baseUrl: string;
  // Chromium.
  let browser: Browser;
  // The signed-in context with the routes.
  let context: BrowserContext;
  // The page.
  let page: Page;
  // A dist that cannot prove anything, recorded so the test fails by name instead of being cancelled.
  let guardError: Error | undefined;
  // The stored row, mutable: the PATCH route writes into it.
  let row: Record<string, unknown>;
  // Every accepted PATCH body.
  const patches: Record<string, unknown>[] = [];
  // PATCHes refused for a stale stamp; must stay 0.
  let stalePatches = 0;
  // Every application_events row inserted.
  const events: { detail?: Record<string, unknown> }[] = [];
  // Stored chat messages.
  const chats: Record<string, unknown>[] = [];
  // Native dialogs opened; must stay 0.
  let dialogs = 0;

  // Rethrown per test: a failed before() would CANCEL it (CLAUDE.md section 5), which proves nothing.
  beforeEach(() => {
    // The guard's own message, as the test's failure.
    if (guardError) throw guardError;
  });

  before(async () => {
    // Missing, stale or unconfigured dist: recorded, not thrown.
    guardError = await assertDistIsTestable().then(() => undefined, (e: unknown) => (e instanceof Error ? e : new Error(String(e))));
    // Nothing worth serving.
    if (guardError) return;
    // The near-full row, computed with the real template; a throw is recorded like the dist guard, never a cancel.
    let profile: ResolvedResume;
    // nearFull throws by name when the fixture cannot be made near-full.
    try { profile = nearFull(); } catch (e) { guardError = e instanceof Error ? e : new Error(String(e)); return; }
    // The row.
    row = {
      id: APP_ID, user_id: USER.id, job_id: `job-${APP_ID}`, status: 'awaiting_approval',
      tailored_profile: profile, tailor_refs: TAILOR_REFS, audit_findings: [], selected_jd_keywords: [],
      match_score: 41, cover_letter: null, updated_at: STAMP_0, status_changed_at: STAMP_0, created_at: STAMP_0,
      jobs: { title: JOB_TITLE, company_name: 'Acme', employment_type: null, work_arrangement: 'remote', locations: [], salary_min: null, salary_max: null, salary_currency: null, discovered_via: null, source_refs: [], apply_url: 'https://example.com/jobs/fit', description_raw: 'A backend role using RAG and SQL.', application_deadline: null },
    };
    // The SPA server.
    ({ server, base: baseUrl } = await startDistServer());
    // Headless, as CI runs it.
    browser = await chromium.launch({ headless: true });
    // A fresh context; a tall viewport so a screenshot shows the card and the toast.
    context = await browser.newContext({ viewport: { width: 1440, height: 1600 } });
    // Every Supabase call answered here; nothing reaches the network.
    await context.route('https://*.supabase.co/**', async (route) => {
      // The request's parts.
      const request = route.request();
      // Parsed once.
      const url = new URL(request.url());
      // Which representation a read asked for.
      const accept = request.headers()['accept'];
      // One JSON answer.
      const json = (status: number, body: unknown) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
      // The session's user.
      if (url.pathname.endsWith('/auth/v1/user')) return json(200, USER);
      // A refreshed session.
      if (url.pathname.endsWith('/auth/v1/token')) return json(200, { access_token: 'e2e-test-token', token_type: 'bearer', expires_in: 7200, refresh_token: 'e2e-test-refresh', user: USER });
      // THE AI: add the four skills (the server's ok shape).
      if (url.pathname.endsWith('/functions/v1/resume-assist')) return json(200, { status: 'ok', ops: ADDED_SKILLS.map((s) => ({ op: 'add_skill', ...s })), dropped: 0, rejected: [], note: `Done: ${PROMPT}`, usage: {} });
      // THE RESUME WRITE, with the database's optimistic lock.
      if (url.pathname.endsWith('/rest/v1/applications') && request.method() === 'PATCH') {
        // id, status and the stamp the page last read.
        const matches = url.searchParams.get('id') === `eq.${APP_ID}` && url.searchParams.get('status') === 'eq.awaiting_approval' && url.searchParams.get('updated_at') === `eq.${String(row.updated_at)}`;
        // Stale: zero rows, as PostgREST answers.
        if (!matches) { stalePatches += 1; return json(200, []); }
        // The columns written.
        const body = request.postDataJSON() as Record<string, unknown>;
        // Recorded.
        patches.push(body);
        // Stored with a new stamp.
        Object.assign(row, body, { updated_at: `2026-11-07T00:00:${String(patches.length).padStart(2, '0')}.000000+00:00` });
        // The one row.
        return json(200, [{ id: APP_ID, updated_at: row.updated_at }]);
      }
      // The history notes.
      if (url.pathname.endsWith('/rest/v1/application_events') && request.method() === 'POST') {
        // One row or a list.
        const body = request.postDataJSON() as unknown;
        // Recorded flat.
        events.push(...(Array.isArray(body) ? body : [body]));
        // Created.
        return json(201, []);
      }
      // The chat history.
      if (url.pathname.endsWith('/rest/v1/resume_chat_messages')) {
        // Appended with ids and times, as the table would.
        if (request.method() === 'POST') {
          // bigint ids, as resumeChat.ts requires.
          const inserted = (request.postDataJSON() as Record<string, unknown>[]).map((m, i) => ({ ...m, id: chats.length + i + 1, created_at: `2026-11-07T01:00:${String(chats.length + i).padStart(2, '0')}.000Z` }));
          // Stored.
          chats.push(...inserted);
          // Returned.
          return json(201, inserted);
        }
        // Loaded.
        return json(200, chats.filter((m) => m.application_id === APP_ID));
      }
      // The reads of applications.
      if (url.pathname.endsWith('/rest/v1/applications') && request.method() === 'GET') {
        // The queue.
        if (url.searchParams.get('status') === 'eq.awaiting_approval') return json(200, [row]);
        // The per-row read.
        if (url.searchParams.get('id') === `eq.${APP_ID}`) return route.fulfill({ status: 200, contentType: 'application/json', body: pgrst(accept, { tailored_profile: row.tailored_profile, updated_at: row.updated_at, status: row.status }) });
      }
      // The master: the row's pin is version 2 (version 1 a placeholder, as in aiEditE2e).
      if (url.pathname.endsWith('/rest/v1/master_profiles')) {
        // Both versions are MASTER_V2's content.
        const masters = [{ profile: MASTER_V2, version: 1 }, { profile: MASTER_V2, version: 2 }];
        // A pinned read names its version; otherwise the newest.
        const pinned = url.searchParams.get('version');
        // That version, or the newest.
        const found = pinned !== null ? masters.find((m) => `eq.${m.version}` === pinned) : masters[masters.length - 1];
        // Unknown version: no row.
        return route.fulfill({ status: 200, contentType: 'application/json', body: found === undefined ? (accept?.includes('vnd.pgrst.object') === true ? 'null' : '[]') : pgrst(accept, found) });
      }
      // Every other read: empty.
      return json(200, []);
    });
    // The stored session.
    await seedSession(context, USER.id);
    // The page.
    page = await context.newPage();
    // Counted and dismissed, so a native dialog fails by name instead of hanging.
    page.on('dialog', (dialog: Dialog) => { dialogs += 1; void dialog.dismiss().catch(() => {}); });
  });

  after(async () => {
    // Each closed only if opened.
    if (page) await page.close().catch(() => {});
    // The context.
    if (context) await context.close().catch(() => {});
    // The browser.
    if (browser) await browser.close().catch(() => {});
    // The server.
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  /* A screenshot, only when asked for (PAGEFIT_SHOTS_DIR); never in CI. */
  async function shot(name: string): Promise<void> {
    // The directory, when set.
    const dir = process.env.PAGEFIT_SHOTS_DIR;
    // Not asked for.
    if (dir === undefined || dir === '') return;
    // The whole page.
    await page.screenshot({ path: join(dir, `${name}.png`), fullPage: true });
  }

  it('an AI "add four skills" on a near-full resume saves ONE page, keeps every skill, and shows + records the cut', async () => {
    // The queue page.
    await page.goto(`${baseUrl}/approvals`, { waitUntil: 'domcontentloaded' });
    // The card.
    const card = page.locator(`#app-card-${APP_ID}`);
    // Rendered from the routes.
    await card.waitFor({ timeout: 10_000 });
    // Unfolded, when folded.
    const review = card.getByRole('button', { name: 'Review', exact: true });
    // Only when folded.
    if (await review.isVisible()) await review.click();
    // The live preview, opened.
    const show = card.getByRole('button', { name: 'Preview resume', exact: true });
    // Only when closed.
    if (await show.isVisible()) await show.click();
    // The chat, docked.
    const dock = card.getByRole('button', { name: 'Chat with AI', exact: true });
    // Only when closed.
    if (await dock.isVisible()) await dock.click();
    // The preview has rendered the near-full resume.
    await page.frameLocator(`iframe[title="Tailored resume for ${JOB_TITLE} at Acme"]`).locator('body').waitFor({ timeout: 10_000 });
    // Before.
    await shot('pagefit-before');
    // The chat.
    const chat = page.getByRole('region', { name: 'AI resume chat' });
    // The prompt box, once history has loaded.
    const input = chat.getByLabel('Message to the AI');
    // Ready.
    await input.waitFor({ timeout: 10_000 });
    // Typed.
    await input.fill(PROMPT);
    // Sent.
    await chat.getByRole('button', { name: 'Send', exact: true }).click();
    // The answer.
    const answer = chat.locator('li.ai-chat__msg--ai').filter({ hasText: `Done: ${PROMPT}` });
    // Rendered.
    await answer.waitFor({ timeout: 10_000 });
    // Both op cards applied.
    for (let i = 0; i < ADDED_SKILLS.length; i += 1) await answer.locator('li.ai-chat__op').nth(i).locator('.ai-chat__done').waitFor({ timeout: 10_000 });
    // THE VISIBLE NOTICE: the cut, in words, on the page.
    const notice = page.getByText(/Trimmed to fit one page: "/);
    // Shown.
    await notice.first().waitFor({ timeout: 10_000 });
    // After.
    await shot('pagefit-after');
    // The stored resume after the last save.
    const saved = row.tailored_profile as ResolvedResume;
    // ONE page, by the renderer's own model.
    assert.equal(fitsOnePage(saved), true, 'the saved resume must fit one page');
    // Both skills on it: skills are never trimmed.
    for (const s of ADDED_SKILLS) assert.ok(saved.skills.some((k) => k.name === s.name), `saved skills must include ${s.name}`);
    // The cut: the first job is down to its floor of one bullet.
    assert.equal(saved.experience[0]!.bullets.length, 1, 'the one trimmable bullet must have been cut');
    // Recorded in the history, beside the edit that caused it.
    const recorded = events.flatMap((e) => (Array.isArray(e.detail?.page_fit_trimmed) ? (e.detail!.page_fit_trimmed as unknown[]) : []));
    // Exactly the one cut.
    assert.equal(recorded.length, 1, `page_fit_trimmed must record the cut, got ${JSON.stringify(events.map((e) => e.detail))}`);
    // No stale write, no native dialog.
    assert.deepEqual([stalePatches, dialogs], [0, 0]);
  });
});
