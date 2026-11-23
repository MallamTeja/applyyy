/* S9i P2 + S9j, end to end in a real browser (orch round 2, 2026-11-23): Teja ruled every chat edit is applied
 * SERVER-side with no Apply button (15:34). The unit suites prove the reader and the server; this proves the panel:
 *   1. an answer carrying `applied` renders as ONE reply that leads with the outcome list ("Applied: …", and a
 *      refused op WITH its reason), shows NO Apply / Apply all / Retry button, writes the bubble itself when the
 *      server did not (chat_saved false), and re-reads the row the server wrote, so the preview shows the change;
 *   2. a S9j place-move ("projects first") applied by the server shows as applied: the preview's headings change
 *      order after the re-read, and with chat_saved true the page does NOT write the bubble a second time.
 * resume-assist and Supabase are answered by routes. The resume-assist route plays the SERVER: it writes the row
 * (as server-apply.ts would) before it answers, so only the page's own re-read can bring the change on screen.
 * No request leaves the machine (fake sb-*-auth-token session; memory: UI sweep without credentials).
 *
 * Needs the e2e bundle: cd apps/web && ./node_modules/.bin/vite build --mode e2e (CI builds it first). */

// Strict asserts.
import assert from 'node:assert/strict';
// The Server type only: the shared harness starts it, after() closes it.
import type { Server } from 'node:http';
// The runner; beforeEach turns a guard failure into a FAILED test rather than a cancelled one.
import { after, before, beforeEach, describe, it } from 'node:test';
// The browser, already a dependency of this package.
import { chromium, type Browser, type BrowserContext, type FrameLocator, type Locator, type Page } from 'playwright';
// The live row's three jsonb values, anonymised (the same fixture aiEditE2e drives).
import { MASTER_V2, STORED_TAILORED_PROFILE, TAILOR_REFS } from './fixtures/gitlab-row-anonymised.ts';
// The shared browser-test harness: dist guard, static SPA server, fake session.
import { assertDistIsTestable, seedSession, startDistServer } from './support/e2eDist.ts';

// The operator the fake session signs in as.
const USER = { id: '0f4b24da-e85b-40bb-8606-c81824493b45', aud: 'authenticated', role: 'authenticated', email: 'operator@example.test' };
// The row's stamp at load; each server write moves it on.
const STAMP_0 = '2026-11-23T00:00:00.000000+00:00';
// The one application this test edits.
const APP_ID = '44444444-4444-4444-8444-444444444444';
// The embedded job's title, which names the card and the preview frame.
const JOB_TITLE = 'Server Apply Engineer';
// A printed skill the first answer removes server-side (the fixture prints it; aiEditE2e removes it too).
const REMOVED_SKILL = 'Redis';
// The refused op's label and reason, as the server would word them; the page must show both.
const REFUSED = { label: 'Remove skill "Kubernetes"', why: 'It is not on this resume.' };

/* The stored application, mutable: the resume-assist route writes into it as the server would. */
const ROW: Record<string, unknown> = {
  id: APP_ID,
  user_id: USER.id,
  job_id: `job-${APP_ID}`,
  status: 'awaiting_approval',
  // A deep copy, so the fixture itself is never mutated.
  tailored_profile: structuredClone(STORED_TAILORED_PROFILE),
  tailor_refs: TAILOR_REFS,
  audit_findings: [],
  selected_jd_keywords: [],
  match_score: 41,
  cover_letter: null,
  updated_at: STAMP_0,
  status_changed_at: STAMP_0,
  created_at: STAMP_0,
  // The embedded job, in the select's own column list.
  jobs: { title: JOB_TITLE, company_name: 'Acme', employment_type: null, work_arrangement: 'remote', locations: [], salary_min: null, salary_max: null, salary_currency: null, discovered_via: null, source_refs: [], apply_url: 'https://example.com/jobs/sa', description_raw: 'A backend role.', application_deadline: null },
};

// The resume as the assertions read it.
type Resume = { skills: { name: string }[]; section_order: string[] };

/* The two server answers, in order. Each first WRITES the row (the server's apply), then answers with its report. */
const ANSWERS: { prompt: string; write: (resume: Resume) => void; body: Record<string, unknown> }[] = [
  {
    // An ask with one op that lands and one the server refused.
    prompt: `Remove ${REMOVED_SKILL} and Kubernetes from my skills.`,
    // The server's save: the skill gone.
    write: (resume) => { resume.skills = resume.skills.filter((s) => s.name !== REMOVED_SKILL); },
    // chat_saved false: the page must write the bubble itself.
    body: { status: 'ok', ops: [{ op: 'remove_skill', name: REMOVED_SKILL }], dropped: 0, rejected: [], note: 'Removed it.', usage: {}, applied: [{ status: 'applied', label: `Remove skill "${REMOVED_SKILL}"` }, { status: 'refused', ...REFUSED }], chat_saved: false },
  },
  {
    // S9j: an absolute place.
    prompt: 'Put the projects section first.',
    // The server's save: projects at place 1 of section_order.
    write: (resume) => { resume.section_order = ['projects', ...resume.section_order.filter((s) => s !== 'projects')]; },
    // chat_saved true: the server wrote the bubble, so the page must not.
    body: { status: 'ok', ops: [{ op: 'move_section', section: 'projects', place: 1 }], dropped: 0, rejected: [], note: '', usage: {}, applied: [{ status: 'applied', label: 'Move section projects to 1st' }], chat_saved: true },
  },
];

/* A PostgREST answer: a single object when the client asked for one, else an array. */
function pgrst(accept: string | undefined, row: unknown): string {
  // The single-object media type means "one row, not a list".
  return JSON.stringify(accept?.includes('vnd.pgrst.object') === true ? row : [row]);
}

describe('S9i P2: a server-applied chat answer in the browser (2026-11-23)', () => {
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
  // Every resume-assist request body, in order.
  const assistBodies: Record<string, unknown>[] = [];
  // Chat rows the PAGE inserted (the server's own write is not a browser request).
  const pageChatInserts: Record<string, unknown>[] = [];
  // Every chat row the table holds, served on load.
  const chats: Record<string, unknown>[] = [];
  // Per-row re-reads that ask for tailor_refs: only the page's reloadRow asks for that column on one row.
  let reloads = 0;
  // Resume PATCHes from the page: a server-applied answer must cause none.
  let pagePatches = 0;

  // Rethrown per test: a failed before() would CANCEL them (CLAUDE.md §5), which proves nothing.
  beforeEach(() => {
    // The guard's own message, as each test's failure.
    if (guardError) throw guardError;
  });

  before(async () => {
    // Missing, stale or unconfigured dist: recorded, not thrown, so beforeEach fails each test by name.
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
      // THE SERVER: apply (write the row), then answer with the report.
      if (url.pathname.endsWith('/functions/v1/resume-assist')) {
        // This answer, by the order of the asks.
        const answer = ANSWERS[assistBodies.length];
        // Recorded after the lookup, so the index above is this request's.
        assistBodies.push(request.postDataJSON() as Record<string, unknown>);
        // A third ask is a test bug, said by name.
        if (answer === undefined) return json(500, { status: 'error', message: 'e2e: unexpected extra resume-assist call' });
        // The server's save, onto the stored row.
        answer.write(ROW.tailored_profile as Resume);
        // A new stamp, as the guarded update sets.
        ROW.updated_at = `2026-11-23T00:00:0${assistBodies.length}.000000+00:00`;
        // The bubble the server wrote when it says so (index.ts saveChat), visible to a later history load.
        if (answer.body.chat_saved === true) {
          // The two rows chatRows() writes: the ask, then the record-led answer with no cards.
          const record = `[${(answer.body.applied as { label: string }[]).map((o) => `Applied: ${o.label}`).join(' | ')}]`;
          // Stored with ids and times, as the table would (after the page's own rows from turn 1).
          chats.push(...[{ role: 'user', content: answer.prompt, ops: null }, { role: 'assistant', content: record, ops: [] }].map((m, i) => ({ ...m, id: 900 + chats.length + i, application_id: APP_ID, chat_id: assistBodies.at(-1)?.chat_id, usage: null, created_at: `2026-11-23T02:00:0${i}.000Z` })));
        }
        // The report.
        return json(200, answer.body);
      }
      // A page-side resume write: must not happen in this mode; counted and accepted so the count is the signal.
      if (url.pathname.endsWith('/rest/v1/applications') && request.method() === 'PATCH') {
        // Counted.
        pagePatches += 1;
        // Zero rows: nothing written.
        return json(200, []);
      }
      // THE CHAT HISTORY: the page's inserts recorded, served on load.
      if (url.pathname.endsWith('/rest/v1/resume_chat_messages')) {
        // The page writing an exchange.
        if (request.method() === 'POST') {
          // Given ids and times as the table would (id a number: resumeChat.ts refuses another type).
          const inserted = (request.postDataJSON() as Record<string, unknown>[]).map((m, i) => ({ ...m, id: chats.length + i + 1, created_at: `2026-11-23T01:00:${String(chats.length + i).padStart(2, '0')}.000Z` }));
          // Recorded as the page's own.
          pageChatInserts.push(...inserted);
          // Stored.
          chats.push(...inserted);
          // Returned, as .select() asks.
          return json(201, inserted);
        }
        // Loaded: this application's messages.
        return json(200, chats.filter((m) => m.application_id === APP_ID));
      }
      // The applications reads: the queue, and the per-row reads.
      if (url.pathname.endsWith('/rest/v1/applications') && request.method() === 'GET') {
        // The queue's read: the row as stored now.
        if (url.searchParams.get('status') === 'eq.awaiting_approval') return json(200, [ROW]);
        // A per-row read.
        if (url.searchParams.get('id') === `eq.${APP_ID}`) {
          // reloadRow is the one per-row read that asks for tailor_refs (ApprovalQueuePage.reloadRow).
          if ((url.searchParams.get('select') ?? '').includes('tailor_refs')) reloads += 1;
          // What is stored now.
          return route.fulfill({ status: 200, contentType: 'application/json', body: pgrst(accept, { tailored_profile: ROW.tailored_profile, updated_at: ROW.updated_at, status: ROW.status, tailor_refs: ROW.tailor_refs }) });
        }
      }
      // The master: the row's pin (version 2) for every read, as no answer here re-pins.
      if (url.pathname.endsWith('/rest/v1/master_profiles')) return route.fulfill({ status: 200, contentType: 'application/json', body: pgrst(accept, { profile: MASTER_V2, version: 2 }) });
      // Every other read (counts, health): empty.
      return json(200, []);
    });
    // The stored session supabase-js reads on boot.
    await seedSession(context, USER.id);
    // The one page.
    page = await context.newPage();
    // A native dialog would fail the run by hanging; dismissed (the AST rule forbids them anyway).
    page.on('dialog', (dialog) => { void dialog.dismiss().catch(() => {}); });
    // The queue page.
    await page.goto(`${baseUrl}/approvals`, { waitUntil: 'domcontentloaded' });
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

  /* The row's card, unfolded, with its chat docked (the same steps as aiEditE2e.openCard). */
  async function openCard(): Promise<Locator> {
    // The card, by the id the page gives it.
    const card = page.locator(`#app-card-${APP_ID}`);
    // Rendered: the routes fed the queue.
    await card.waitFor({ timeout: 15_000 });
    // "Review" while folded.
    const review = card.getByRole('button', { name: 'Review', exact: true });
    // Only when folded.
    if (await review.isVisible()) await review.click();
    // The dock button reads "Chat with AI" while closed.
    const dock = card.getByRole('button', { name: 'Chat with AI', exact: true });
    // Only when closed.
    if (await dock.isVisible()) await dock.click();
    // Ready.
    return card;
  }

  /* The live preview's document, opened if it is not already. */
  async function openPreview(card: Locator): Promise<FrameLocator> {
    // "Preview resume" while closed.
    const show = card.getByRole('button', { name: 'Preview resume', exact: true });
    // Only when closed.
    if (await show.isVisible()) await show.click();
    // The rendered resume, in its titled frame.
    return page.frameLocator(`iframe[title="Tailored resume for ${JOB_TITLE} at Acme"]`);
  }

  /* Sends one prompt and returns its settled reply bubble, found by the text it must show (never by index: the
     streaming "Thinking…" bubble is an AI message too). A bubble that never shows `expected` times out by name. */
  async function ask(prompt: string, expected: string): Promise<{ chat: Locator; reply: Locator }> {
    // The AI chat region.
    const chat = page.getByRole('region', { name: 'AI resume chat' });
    // The prompt box, ready once the history has loaded.
    const input = chat.getByLabel('Message to the AI');
    // Ready.
    await input.waitFor({ timeout: 15_000 });
    // Typed.
    await input.fill(prompt);
    // Sent.
    await chat.getByRole('button', { name: 'Send', exact: true }).click();
    // The reply that carries the expected record.
    const reply = chat.locator('li.ai-chat__msg--ai').filter({ hasText: expected });
    // Rendered.
    await reply.first().waitFor({ timeout: 15_000 });
    // Both, for the assertions.
    return { chat, reply: reply.first() };
  }

  /* How many times the preview's text names the removed skill. */
  async function mentions(frame: FrameLocator): Promise<number> {
    // The rendered text, split on the name: n parts means n-1 mentions.
    return (await frame.locator('body').innerText()).split(REMOVED_SKILL).length - 1;
  }

  /* The section headings the preview prints, lower-cased, in order. */
  async function headings(frame: FrameLocator): Promise<string[]> {
    // Read from headings, not body text (the words also occur in prose).
    return (await frame.locator('h1, h2, h3, h4').allInnerTexts()).map((h) => h.trim().toLowerCase());
  }

  it('1. the outcome list renders (applied + refused WITH its reason), no Apply button, the row is re-read', async () => {
    // The row, open.
    const card = await openCard();
    // The preview, open, before the ask: it must CHANGE after it.
    const frame = await openPreview(card);
    // The skill is printed now.
    await frame.locator('body').getByText(REMOVED_SKILL, { exact: false }).first().waitFor({ timeout: 15_000 });
    // How many times the preview names it before the ask (skills line + bullets).
    const mentionsBefore = await mentions(frame);
    // Asked.
    // The bubble must show what landed, by the server's label (a hidden record times out here, by name).
    const { chat, reply: bubble } = await ask(ANSWERS[0]!.prompt, `Applied: Remove skill "${REMOVED_SKILL}"`);
    // The ask turned server apply on, for this row.
    assert.deepEqual([assistBodies[0]?.server_apply, assistBodies[0]?.application_id], [true, APP_ID], 'the page must ask the server to apply, naming this row');
    // The reply bubble's text.
    const reply = (await bubble.innerText()).replace(/\s+/g, ' ');
    // Never contradicted by a card-less summary (the bug this test found: "No changes made" under landed edits).
    assert.ok(!reply.includes('No changes made'), `the reply must not say "No changes made" over edits that landed, got: ${reply}`);
    // The refused op WITH its reason: a refusal without a why is a dead end.
    assert.ok(reply.includes(`Could not do: ${REFUSED.label} (${REFUSED.why})`), `the reply must name the refusal and its reason, got: ${reply}`);
    // No Apply, Apply all or Retry anywhere in the chat (Teja 15:34: no Apply button).
    assert.equal(await chat.getByRole('button', { name: /^(Apply|Apply all|Retry)\b/ }).count(), 0, 'a server-applied answer must show no Apply button');
    /* The page re-read the row the server wrote: the preview prints the skill ONE time fewer (the skills line; the
       fixture's bullets also name Redis, so presence alone proves nothing). Only the re-read can bring that change. */
    let count = mentionsBefore;
    // Polled on the text itself, up to 15 s in 250 ms steps (never a fixed sleep).
    for (let i = 0; i < 60 && count >= mentionsBefore; i += 1) { await page.waitForTimeout(250); count = await mentions(frame); }
    // One fewer.
    assert.equal(count, mentionsBefore - 1, `the preview must drop the skills-line "${REMOVED_SKILL}" after the re-read (before ${mentionsBefore}, now ${count})`);
    // Counted: at least one reloadRow read.
    assert.ok(reloads >= 1, 'the page must re-read the row after a server-applied answer');
    // chat_saved false: the page wrote the exchange itself, ops [] (no cards).
    assert.deepEqual(pageChatInserts.map((m) => [m.role, m.ops]), [['user', null], ['assistant', []]], 'the page must write the bubble when the server did not, with no cards');
    // And it never wrote the resume itself.
    assert.equal(pagePatches, 0, 'a server-applied answer must cause no page-side resume write');
  });

  it('2. a S9j place-move applied by the server shows as applied; chat_saved true means no second bubble write', async () => {
    // The row, open.
    const card = await openCard();
    // The preview.
    const frame = await openPreview(card);
    // Before: projects below experience (the fixture's order).
    const before = await headings(frame);
    // The fixture really has projects after experience, or the test proves nothing.
    assert.ok(before.indexOf('projects') > before.indexOf('experience') && before.indexOf('experience') >= 0, `fixture must print Experience above Projects, got ${JSON.stringify(before)}`);
    // Page inserts so far.
    const insertsBefore = pageChatInserts.length;
    // Asked.
    // The reply names the place-move as applied, by the server's label (re-read from the stored history).
    const { chat, reply: bubble } = await ask(ANSWERS[1]!.prompt, 'Applied: Move section projects to 1st');
    // Its text.
    const reply = (await bubble.innerText()).replace(/\s+/g, ' ');
    // The server saved it, so the page must not claim otherwise (local copies with no id used to say this).
    assert.ok(!reply.includes('Not saved to history'), `a bubble the server saved must not read "Not saved to history", got: ${reply}`);
    // Still no Apply button.
    assert.equal(await chat.getByRole('button', { name: /^(Apply|Apply all|Retry)\b/ }).count(), 0, 'a server-applied place-move must show no Apply button');
    // Polled on the headings themselves (never on time): projects above experience.
    let after: string[] = [];
    // Up to 15 s, in 250 ms steps.
    for (let i = 0; i < 60; i += 1) { after = await headings(frame); if (after.indexOf('projects') >= 0 && after.indexOf('projects') < after.indexOf('experience')) break; await page.waitForTimeout(250); }
    // Moved.
    assert.ok(after.indexOf('projects') >= 0 && after.indexOf('projects') < after.indexOf('experience'), `the preview must show Projects above Experience after the re-read, got ${JSON.stringify(after)}`);
    // chat_saved true: the page wrote no exchange of its own.
    assert.equal(pageChatInserts.length, insertsBefore, 'with chat_saved true the page must not write the bubble a second time');
    // No page-side resume write in this mode either.
    assert.equal(pagePatches, 0, 'a server-applied answer must cause no page-side resume write');
  });
});
