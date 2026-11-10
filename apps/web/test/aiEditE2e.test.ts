/* The AI resume chat, end to end in a real browser (Teja, 2026-11-05: "prompt it to add some skills,
 * change sections, rename things, rewrite and rephrase bullet points; it needs to write it, read it;
 * the change must show in the frontend, the resume preview live or on page refresh is ok").
 *
 * WHAT IT PROVES. Every layer below the panel is unit-tested with stubs, but nothing drove
 * browser -> resume-assist -> ops applied -> saved -> DiffView/preview -> reload -> approve. This does,
 * against the built bundle in Chromium, with resume-assist and Supabase answered by routes:
 *   1. four typed prompts each get an answer whose ops land: add 2 master skills + remove 1 printed
 *      skill, move a section, rephrase 2 bullets (auto-applied), write a new bullet (one click);
 *   2. each applied op is a PATCH of tailored_profile (optimistic lock honoured: a stale stamp is
 *      refused like the database would) plus an application_events row naming its source
 *      (ai_chat_auto / ai_chat_click);
 *   3. DiffView and the live resume preview show every change, and after a RELOAD the preview still
 *      shows them, read back from the stored row (the route serves what the PATCHes wrote);
 *   4. Approve runs the re-check over the AI's words: the new bullet's invented term holds it for a
 *      second click, which then writes exactly once. No native dialog opens.
 * "Rename things": there is no rename op (the 9 kinds are in aiEditContract.test.ts); a rename is an
 * `edit` of the text, which turn 3 covers.
 *
 * THE ROUTE BUILDS ITS OPS FROM THE REQUEST THE BROWSER SENT (bullet, entry and section ids), so the
 * test never hard-codes the panel's short-id projection.
 *
 * Needs the e2e bundle: cd apps/web && ./node_modules/.bin/vite build --mode e2e (CI builds it first). */

// Strict asserts.
import assert from 'node:assert/strict';
// The Server type only: the shared harness starts it, after() closes it.
import type { Server } from 'node:http';
// The runner; beforeEach turns a guard failure into a FAILED test rather than a cancelled one.
import { after, before, beforeEach, describe, it } from 'node:test';
// The browser, already a dependency of this package.
import { chromium, type Browser, type BrowserContext, type Dialog, type FrameLocator, type Locator, type Page } from 'playwright';
// The live row's three jsonb values, anonymised.
import { MASTER_V2, STORED_TAILORED_PROFILE, TAILOR_REFS } from './fixtures/gitlab-row-anonymised.ts';
/* The shared browser-test harness. Its guard walks all of src/ plus the root build inputs, a superset of the
   per-file source list this test kept until 2026-11-05, and also refuses a bundle built without the project URL. */
import { assertDistIsTestable, seedSession, startDistServer } from './support/e2eDist.ts';

// The operator the fake session signs in as.
const USER = { id: '0f4b24da-e85b-40bb-8606-c81824493b45', aud: 'authenticated', role: 'authenticated', email: 'operator@example.test' };
// The row's stamp at load; every accepted PATCH moves it on.
const STAMP_0 = '2026-11-05T00:00:00.000000+00:00';
// The one application this test edits.
const APP_ID = '33333333-3333-4333-8333-333333333333';
// The embedded job's title, which names the card and the preview frame.
const JOB_TITLE = 'AI Edit Engineer';

// The fixture's own words, read once: the edits below are built from them.
type Bullet = { ref: string; text: string };
// The first job's bullets, the ones turn 3 rephrases.
const FIRST_JOB = (STORED_TAILORED_PROFILE as unknown as { experience: { bullets: Bullet[] }[] }).experience[0]!.bullets;
// Two bullets, or the rephrase turn proves less than it claims.
assert.ok(FIRST_JOB.length >= 2, 'fixture must have two bullets on its first job');
/* "Rephrase" twice. The first drops the closing word, so every word left is the master's own and the
   edit applies by itself. The second also adds a term no master node has ("Zanzibarql"): an
   ungrounded edit waits for a click, saves as the operator's edit, and is what Approve's re-check
   must hold the row for. (A NEW bullet cannot play that part: applying one attests it into the
   master as a new version, so it traces and the auditor rightly has nothing to say.) */
const REPHRASED = [
  // Grounded: auto-applied.
  FIRST_JOB[0]!.text.split(' ').slice(0, -1).join(' '),
  // Ungrounded: one click, then held at Approve.
  `${FIRST_JOB[1]!.text.split(' ').slice(0, -1).join(' ')} using Zanzibarql`,
];
// Two master skills the stored resume does not print (fixture: MASTER_V2 has both, the resume neither).
const ADDED_SKILLS = [{ name: 'RAG Pipelines', category: 'AI' }, { name: 'SQL', category: 'Languages' }];
// A printed skill the first prompt asks to drop; named in the prompt, so its removal auto-applies.
const REMOVED_SKILL = 'Redis';
// The new bullet the fourth turn writes (attested into the master when its card is clicked).
const NEW_BULLET = 'Led the migration of the backend services to event-driven workflows.';

/* The four prompts, and the ops each answer carries, built from the request the browser sent. */
type AssistBody = { instruction: string; bullets: { id: string; text: string; entry?: string }[]; entries?: { id: string; section: string; label: string }[]; sections?: string[] };
const TURNS: { prompt: string; ops: (body: AssistBody) => Record<string, unknown>[] }[] = [
  {
    // Skills: two added from the master (removal is its own turn below; see REMOVE_TURN).
    prompt: 'Add RAG Pipelines and SQL to my skills.',
    // add_skill for a master skill applies by itself.
    ops: () => ADDED_SKILLS.map((s) => ({ op: 'add_skill', ...s })),
  },
  {
    // Sections: projects above experience.
    prompt: 'Move the projects section up, above experience.',
    // A section move applies by itself.
    ops: () => [{ op: 'move_section', section: 'projects', direction: 'up' }],
  },
  {
    // Bullets: the first job's two bullets, tightened.
    prompt: 'Rephrase my first two experience bullets to be tighter.',
    // The ids the browser gave those two bullets, found by their text.
    ops: (body) => FIRST_JOB.slice(0, 2).map((bullet, i) => {
      // The short id the panel sent for this bullet.
      const sent = body.bullets.find((b) => b.text === bullet.text);
      // Said by name rather than an op the panel cannot place.
      assert.ok(sent !== undefined, `the request must carry bullet "${bullet.text.slice(0, 40)}…"`);
      // A grounded edit, no new numbers.
      return { op: 'edit', id: sent.id, text: REPHRASED[i], newNumbers: [] };
    }),
  },
  {
    // A new bullet on the first job.
    prompt: 'Add a bullet to my first job about the Zanzibarql migration.',
    // The entry id the browser gave the first job (the first experience entry it sent).
    ops: (body) => {
      // The first experience entry in the projection.
      const entry = body.entries?.find((e) => e.section === 'experience');
      // Said by name.
      assert.ok(entry !== undefined, 'the request must carry an experience entry');
      // A new bullet never applies by itself: the test clicks Apply.
      return [{ op: 'new_bullet', entry: entry.id, text: NEW_BULLET }];
    },
  },
];

/* Removing a printed skill by name, sent after the four turns. Found by this test (2026-11-05): the
   save gate's skills rule (tailoredEdits.ts skillsAreOriginalPlusMaster) required every tailor-chosen
   skill to stay printed, so remove_skill was always refused as "does not trace". Test 4 pins the fix. */
const REMOVE_TURN = {
  // The skill named, so shouldAutoApply lets it apply by itself.
  prompt: `Remove ${REMOVED_SKILL} from my skills.`,
  // One removal.
  ops: () => [{ op: 'remove_skill', name: REMOVED_SKILL }],
};

/* The stored application, mutable: the PATCH route writes into it, so a reload reads what was saved. */
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
  jobs: { title: JOB_TITLE, company_name: 'Acme', employment_type: null, work_arrangement: 'remote', locations: [], salary_min: null, salary_max: null, salary_currency: null, discovered_via: null, source_refs: [], apply_url: 'https://example.com/jobs/ai', description_raw: 'A backend role using RAG and SQL.', application_deadline: null },
};

/* A PostgREST answer: a single object when the client asked for one, else an array. */
function pgrst(accept: string | undefined, row: unknown): string {
  // The single-object media type means "one row, not a list".
  return JSON.stringify(accept?.includes('vnd.pgrst.object') === true ? row : [row]);
}

/* The saved resume, typed just enough for the assertions. */
type Saved = { skills: { name: string }[]; section_order: string[]; experience: { bullets: { text: string }[] }[] };

// What the owner types while turn 1 is in flight; it must still be in the box afterwards (2026-11-09).
const NEXT_DRAFT = 'and now make the summary shorter';

describe('AI resume chat, end to end (2026-11-05)', () => {
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
  const assistBodies: AssistBody[] = [];
  /* Requests held mid-flight, by name (2026-11-09: Teja could not type the next prompt while an edit was being applied).
     Test 1 arms both for its first turn: the AI's answer, then the first save it auto-applies. Each is held ONCE. */
  type Hold = { taken: boolean; held: () => void; heldP: Promise<void>; release: () => void; releaseP: Promise<void> };
  // The armed holds; a name not here passes straight through.
  const holds = new Map<'assist' | 'save', Hold>();
  // Arms one hold: the route signals heldP when the request arrives, then waits for release().
  function arm(name: 'assist' | 'save'): void {
    // Filled synchronously by the two Promise executors below.
    const hold = { taken: false } as Hold;
    // Resolved by the route when it starts holding.
    hold.heldP = new Promise<void>((resolve) => { hold.held = resolve; });
    // Resolved by the test to let the request finish.
    hold.releaseP = new Promise<void>((resolve) => { hold.release = resolve; });
    // Armed.
    holds.set(name, hold);
  }
  // Called by the route: holds the request once if armed, else returns at once.
  async function waitIfHeld(name: 'assist' | 'save'): Promise<void> {
    // The armed hold, if any.
    const hold = holds.get(name);
    // Not armed, or already used: the request goes through.
    if (hold === undefined || hold.taken) return;
    // Used once only, so the later saves of the same turn are not held.
    hold.taken = true;
    // Tells the test the request is in flight now.
    hold.held();
    // Until the test has checked the composer.
    await hold.releaseP;
  }
  // Every accepted PATCH body on applications, in order.
  const patches: Record<string, unknown>[] = [];
  // PATCHes refused for a stale stamp; the page must never send one.
  let stalePatches = 0;
  // Every application_events row inserted.
  const events: { application_id?: string; detail?: { source?: string; kind?: string } }[] = [];
  // The stored chat messages, as the table would hold them.
  const chats: Record<string, unknown>[] = [];
  // advance_application_status calls, by application id.
  const writes: string[] = [];
  // The master versions, oldest first. Version 1 is a placeholder so MASTER_V2 really is version 2,
  // the row's pin (the fixture's master_version).
  const masters: { profile: unknown; version: number }[] = [{ profile: MASTER_V2, version: 1 }, { profile: MASTER_V2, version: 2 }];
  // Native dialogs opened; must stay 0.
  let dialogs = 0;

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
    // The shared SPA server on a free loopback port: a file when it exists, else index.html, as Vercel serves it.
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
      // THE AI: the turn's ops, built from what the browser sent.
      if (url.pathname.endsWith('/functions/v1/resume-assist')) {
        // The request, recorded.
        const body = request.postDataJSON() as AssistBody;
        // Which turn this is: the four scripted turns, then the removal turn, then nothing.
        const turn = assistBodies.length < TURNS.length ? TURNS[assistBodies.length] : assistBodies.length === TURNS.length ? REMOVE_TURN : undefined;
        // Recorded after the lookup, so the index above is this request's.
        assistBodies.push(body);
        // Held while test 1 types into the composer during the ask.
        await waitIfHeld('assist');
        // A sixth request is a test bug, said by name.
        if (turn === undefined) return json(500, { status: 'error', message: 'e2e: unexpected extra resume-assist call' });
        // The server's ok shape (assist.ts handleResumeAssist).
        return json(200, { status: 'ok', ops: turn.ops(body), dropped: 0, rejected: [], note: `Done: ${turn.prompt}`, usage: {} });
      }
      // THE RESUME WRITE: saveTailoredEdit's guarded update.
      if (url.pathname.endsWith('/rest/v1/applications') && request.method() === 'PATCH') {
        // Held while test 1 types into the composer during the auto-applied save.
        await waitIfHeld('save');
        // The optimistic lock the database applies: id, status and the stamp the page last read.
        const matches = url.searchParams.get('id') === `eq.${APP_ID}` && url.searchParams.get('status') === 'eq.awaiting_approval' && url.searchParams.get('updated_at') === `eq.${String(ROW.updated_at)}`;
        // A stale write matches no row, exactly as PostgREST answers it.
        if (!matches) {
          // Counted: the page must never send one.
          stalePatches += 1;
          // Zero rows.
          return json(200, []);
        }
        // The columns written.
        const body = request.postDataJSON() as Record<string, unknown>;
        // Recorded.
        patches.push(body);
        // Stored, so the next read (and a reload) sees it.
        Object.assign(ROW, body, { updated_at: `2026-11-05T00:00:${String(patches.length).padStart(2, '0')}.000000+00:00` });
        // The one row, with its new stamp.
        return json(200, [{ id: APP_ID, updated_at: ROW.updated_at }]);
      }
      // THE AUDIT TRAIL of each edit.
      if (url.pathname.endsWith('/rest/v1/application_events') && request.method() === 'POST') {
        // One row or a list.
        const body = request.postDataJSON() as unknown;
        // Recorded flat.
        events.push(...(Array.isArray(body) ? body : [body]));
        // Created.
        return json(201, []);
      }
      // THE CHAT HISTORY: stored on insert, served on load, so a reload shows the conversation.
      if (url.pathname.endsWith('/rest/v1/resume_chat_messages')) {
        // An exchange appended.
        if (request.method() === 'POST') {
          // The inserted rows, given ids and a time as the table would.
          // `id` is a number: the column is a bigint identity, and resumeChat.ts refuses any other type.
          const inserted = (request.postDataJSON() as Record<string, unknown>[]).map((m, i) => ({ ...m, id: chats.length + i + 1, created_at: `2026-11-05T01:00:${String(chats.length + i).padStart(2, '0')}.000Z` }));
          // Stored.
          chats.push(...inserted);
          // Returned, as .select() asks.
          return json(201, inserted);
        }
        // Loaded: this application's messages, oldest first (inserted in order).
        return json(200, chats.filter((m) => m.application_id === APP_ID));
      }
      // THE APPROVE: counted and accepted.
      if (url.pathname.endsWith('/rest/v1/rpc/advance_application_status')) {
        // The row it moves.
        writes.push(String((request.postDataJSON() as { p_application_id?: unknown }).p_application_id));
        // The RPC's own success shape.
        return route.fulfill({ status: 200, contentType: 'application/json', body: 'null' });
      }
      // The applications reads: the queue, and the per-row stamp check.
      if (url.pathname.endsWith('/rest/v1/applications') && request.method() === 'GET') {
        // The queue's read: the row as stored now.
        if (url.searchParams.get('status') === 'eq.awaiting_approval') return json(200, [ROW]);
        // The per-row read: what is stored now.
        if (url.searchParams.get('id') === `eq.${APP_ID}`) return route.fulfill({ status: 200, contentType: 'application/json', body: pgrst(accept, { tailored_profile: ROW.tailored_profile, updated_at: ROW.updated_at, status: ROW.status }) });
      }
      /* THE MASTER, versioned like the table: insert-only, the database assigns the next version.
         A new bullet is a new claim, so the chat writes it into the master as a new version and
         re-pins the row; every later save then traces against THAT version. Serving v2 forever made
         every later edit read as untraced. Reads: by version (the pin), or the newest one. */
      if (url.pathname.endsWith('/rest/v1/master_profiles')) {
        // A new version: stored, its number read back as `.select('version').single()` asks.
        if (request.method() === 'POST') {
          // The next version number.
          const version = masters.length + 1;
          // Stored.
          masters.push({ profile: (request.postDataJSON() as { profile: unknown }).profile, version });
          // The assigned version.
          return route.fulfill({ status: 201, contentType: 'application/json', body: pgrst(accept, { version }) });
        }
        // A pinned read names its version; the "current master" read asks for the newest.
        const pinned = url.searchParams.get('version');
        // That version, or the newest.
        const row = pinned !== null ? masters.find((m) => `eq.${m.version}` === pinned) : masters[masters.length - 1];
        // Unknown version: no row, as PostgREST answers.
        return route.fulfill({ status: 200, contentType: 'application/json', body: row === undefined ? (accept?.includes('vnd.pgrst.object') === true ? 'null' : '[]') : pgrst(accept, row) });
      }
      // Every other read (counts, health): empty.
      return json(200, []);
    });
    // The stored session supabase-js reads on boot, signed in as USER (the shared helper's user shape matches it).
    await seedSession(context, USER.id);
    // The one page.
    page = await context.newPage();
    // Counted AND dismissed, so a native confirm fails by name instead of hanging the run.
    page.on('dialog', (dialog: Dialog) => {
      // Counted first.
      dialogs += 1;
      // Dismissed.
      void dialog.dismiss().catch(() => {});
    });
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

  /* The row's card, unfolded so its diff and chat are reachable. */
  async function openCard(): Promise<Locator> {
    // The card, by the id the page gives it.
    const card = page.locator(`#app-card-${APP_ID}`);
    // Rendered: the routes fed the queue.
    await card.waitFor({ timeout: 10_000 });
    // The fold control reads "Review" while folded; open it then.
    const review = card.getByRole('button', { name: 'Review', exact: true });
    // Only when folded.
    if (await review.isVisible()) await review.click();
    // The chat docks on the right (2026-11-06), outside the card: open this row's, if it is not already.
    const dock = card.getByRole('button', { name: 'Chat with AI', exact: true });
    // Only when closed: the button reads 'Close chat' while docked.
    if (await dock.isVisible()) await dock.click();
    // The card, ready.
    return card;
  }

  /* The live preview's document, opened if it is not already. */
  async function openPreview(card: Locator): Promise<FrameLocator> {
    // The toggle reads "Preview resume" while closed.
    const show = card.getByRole('button', { name: 'Preview resume', exact: true });
    // Only when closed.
    if (await show.isVisible()) await show.click();
    // The rendered resume, in its titled frame.
    return page.frameLocator(`iframe[title="Tailored resume for ${JOB_TITLE} at Acme"]`);
  }

  /* Every change, asserted in the preview's text, waiting on what it asserts (never on timing). */
  async function assertPreviewShowsAll(frame: FrameLocator, when: string): Promise<void> {
    // The document body.
    const body = frame.locator('body');
    // Waits until the last change (the new bullet) has rendered.
    await body.getByText(NEW_BULLET, { exact: false }).waitFor({ timeout: 10_000 });
    // The text as rendered.
    const text = (await body.innerText()).replace(/\s+/g, ' ');
    // Both added skills.
    for (const s of ADDED_SKILLS) assert.ok(text.includes(s.name), `${when}: preview must print the added skill ${s.name}`);
    // Both rephrased bullets, exactly.
    for (const r of REPHRASED) assert.ok(text.includes(r.replace(/\s+/g, ' ')), `${when}: preview must print the rephrased bullet "${r.slice(0, 40)}…"`);
    // Projects now come before experience, read from the section HEADINGS (the words also occur in
    // body text, e.g. a summary mentioning experience, so a plain text search would mislead).
    const headings = (await body.locator('h1, h2, h3, h4').allInnerTexts()).map((h) => h.trim().toLowerCase());
    // Both headings exist, then their order.
    assert.ok(headings.includes('projects') && headings.includes('experience') && headings.indexOf('projects') < headings.indexOf('experience'), `${when}: preview must show Projects above Experience, got ${JSON.stringify(headings)}`);
  }

  it('1. four prompts: every answer\'s ops are applied and saved, with the source on each event', async () => {
    // The queue page.
    await page.goto(`${baseUrl}/approvals`, { waitUntil: 'domcontentloaded' });
    // The row, open. Called for its effect only: the chat below is found on the page, so the locator is not kept.
    await openCard();
    // One prompt per turn, in order.
    for (const [index, turn] of TURNS.entries()) {
      // The panel inside the card (re-found each turn: the card can move buckets after an edit).
      await openCard();
      // The AI chat region.
      const chat = page.getByRole('region', { name: 'AI resume chat' });
      // The prompt box.
      const input = chat.getByLabel('Message to the AI');
      // Ready once the history has loaded.
      await input.waitFor({ timeout: 10_000 });
      // The prompt, typed.
      await input.fill(turn.prompt);
      // Sent (disabled while history loads, so wait for it to be enabled).
      const send = chat.getByRole('button', { name: 'Send', exact: true });
      // Enabled.
      await send.waitFor({ timeout: 10_000 });
      // Clicked.
      // Turn 1 holds its answer and its first save, so the composer can be checked mid-flight.
      if (index === 0) {
        // The AI's answer.
        arm('assist');
        // The first save the answer auto-applies.
        arm('save');
      }
      await send.click();
      // While the AI is asked, then while its edit is saved, the next prompt can be typed and is kept.
      if (index === 0) {
        // The ask is in flight.
        await holds.get('assist')!.heldP;
        // Typing is open mid-ask (it used to be disabled for the whole ask).
        assert.equal(await input.isEnabled(), true, 'the prompt box must stay enabled while the AI is asked');
        // The owner starts the next message.
        await input.fill(NEXT_DRAFT);
        // The answer arrives.
        holds.get('assist')!.release();
        // Its first auto-applied save is in flight.
        await holds.get('save')!.heldP;
        // Still typable while the edit is being applied.
        assert.equal(await input.isEnabled(), true, 'the prompt box must stay enabled while an edit is applied');
        // The reply did not wipe the draft typed during the ask.
        assert.equal(await input.inputValue(), NEXT_DRAFT, 'the reply must not clear a message typed while it was pending');
        // The save finishes.
        holds.get('save')!.release();
      }
      // This turn's answer: the (index+1)-th AI message carrying the stub's note.
      const answer = chat.locator('li.ai-chat__msg--ai').filter({ hasText: `Done: ${turn.prompt}` });
      // Rendered.
      await answer.waitFor({ timeout: 10_000 });
      // Every op card in this answer.
      const ops = answer.locator('li.ai-chat__op');
      /* The cards that wait for a click: the ungrounded rephrase (turn 3, second card) and the new
         bullet (turn 4). Clicked one at a time, after the auto-applied ones finished. */
      const clicks = index === 2 ? [1] : index === 3 ? [0] : [];
      // Each waiting card, clicked once its Apply button is there.
      for (const card of clicks) {
        // Before clicking, the auto-applied card ahead of it must be done (it saves first).
        if (card > 0) await ops.nth(card - 1).locator('.ai-chat__done').waitFor({ timeout: 10_000 });
        // The card's own Apply.
        await ops.nth(card).getByRole('button', { name: 'Apply', exact: true }).click();
      }
      // As many cards as ops the stub sent.
      const expected = turn.ops(assistBodies[index]!).length;
      // Each one applied.
      for (let i = 0; i < expected; i += 1) await ops.nth(i).locator('.ai-chat__done').waitFor({ timeout: 10_000 });
      // Every save landed and the draft typed mid-flight is still there for the owner to send.
      if (index === 0) assert.equal(await input.inputValue(), NEXT_DRAFT, 'the draft typed while the edit was applied must survive it');
    }
    // Four requests, one per prompt, each carrying its instruction.
    assert.deepEqual(assistBodies.map((b) => b.instruction), TURNS.map((t) => t.prompt), 'each prompt must reach resume-assist once');
    // The page never wrote over a newer version.
    assert.equal(stalePatches, 0, 'every save must carry the stamp of the version it read');
    // The stored resume after the last save.
    const saved = ROW.tailored_profile as Saved;
    // Skills: both added.
    const names = saved.skills.map((s) => s.name);
    // Added.
    for (const s of ADDED_SKILLS) assert.ok(names.includes(s.name), `saved skills must include ${s.name}`);
    // Sections: projects above experience.
    assert.ok(saved.section_order.indexOf('projects') < saved.section_order.indexOf('experience'), `saved section_order must have projects above experience: ${saved.section_order.join(',')}`);
    // Bullets: the first job's texts, rephrased and with the new one.
    const texts = saved.experience[0]!.bullets.map((b) => b.text);
    // Both rephrased.
    for (const r of REPHRASED) assert.ok(texts.includes(r), `saved first job must carry "${r.slice(0, 40)}…"`);
    // The new bullet.
    assert.ok(texts.includes(NEW_BULLET), 'saved first job must carry the new bullet');
    // Events: one per applied op (2 skills + 1 move + 1 grounded edit auto; the ungrounded edit and the new bullet clicked), all for this row.
    const sources = events.filter((e) => e.application_id === APP_ID).map((e) => e.detail?.source);
    // Four applied by the chat itself.
    assert.equal(sources.filter((s) => s === 'ai_chat_auto').length, 4, `four ai_chat_auto events expected, got ${JSON.stringify(sources)}`);
    // Two by the operator's clicks.
    assert.equal(sources.filter((s) => s === 'ai_chat_click').length, 2, `two ai_chat_click events expected, got ${JSON.stringify(sources)}`);
  });

  it('2. DiffView and the live preview show every change', async () => {
    // The row, open.
    const card = await openCard();
    // Both added skills carry the "added by you" tag in Changes by AI. 'attached', not visible: the list is a
    // collapsed <details> (slim card, 2026-11-07), and the per-skill Remove button this used to wait for is gone.
    for (const s of ADDED_SKILLS) await card.locator('li.line__added-skill', { hasText: s.name }).locator('.line__added-skill-tag', { hasText: 'added by you' }).waitFor({ state: 'attached', timeout: 10_000 });
    // At least the two rephrased bullets are marked edited (counted in the DOM, open or collapsed).
    assert.ok((await card.locator('.line__provenance--edited').count()) >= 2, 'both rephrased bullets must be marked edited in the diff');
    // The live preview.
    await assertPreviewShowsAll(await openPreview(card), 'live');
  });

  it('3. after a reload the preview still shows every change (read back from the stored row) and the chat is still there', async () => {
    // A full reload: the page reads the row again from the routes, which serve what the PATCHes wrote.
    await page.reload({ waitUntil: 'domcontentloaded' });
    // The row, open.
    const card = await openCard();
    // The preview, from the reloaded row.
    await assertPreviewShowsAll(await openPreview(card), 'after reload');
    // The conversation reloaded from its table: the four answers are listed again.
    const chat = page.getByRole('region', { name: 'AI resume chat' });
    // The last answer, back.
    await chat.locator('li.ai-chat__msg--ai').filter({ hasText: `Done: ${TURNS[3]!.prompt}` }).waitFor({ timeout: 10_000 });
  });

  // Red before the 2026-11-05 skills-rule fix (every remove_skill was refused as "does not trace").
  it('4. a named skill removal is applied, saved and gone from the preview', async () => {
    // The row, open.
    const card = await openCard();
    // The AI chat region.
    const chat = page.getByRole('region', { name: 'AI resume chat' });
    // "Redis" also occurs in bullet text, so the preview check counts it: one fewer after the removal.
    const frame = await openPreview(card);
    // How many times the preview prints the skill's name now.
    const occurrences = async () => (await frame.locator('body').innerText()).split(REMOVED_SKILL).length - 1;
    // Before: at least the skills line.
    const before = await occurrences();
    // Printed somewhere, or the check below proves nothing.
    assert.ok(before >= 1, `the preview must print ${REMOVED_SKILL} before its removal`);
    // The prompt box, ready.
    const input = chat.getByLabel('Message to the AI');
    // Typed.
    await input.fill(REMOVE_TURN.prompt);
    // Sent.
    await chat.getByRole('button', { name: 'Send', exact: true }).click();
    // The answer.
    const answer = chat.locator('li.ai-chat__msg--ai').filter({ hasText: `Done: ${REMOVE_TURN.prompt}` });
    // Its one card, applied by itself (the skill was named).
    await answer.locator('li.ai-chat__op').first().locator('.ai-chat__done').waitFor({ timeout: 10_000 });
    // Saved without it.
    assert.ok(!(ROW.tailored_profile as Saved).skills.some((s) => s.name === REMOVED_SKILL), `saved skills must not include ${REMOVED_SKILL}`);
    // And gone from the live preview's skills line: polled, because the frame re-renders after the save.
    let after = await occurrences();
    // Up to 10 s, a fifth of a second apart.
    for (let tries = 0; after !== before - 1 && tries < 50; tries += 1) {
      // A short wait before re-reading.
      await page.waitForTimeout(200);
      // Re-read.
      after = await occurrences();
    }
    // Exactly one fewer: the skills line, and no bullet text, lost it.
    assert.equal(after, before - 1, `the preview must print ${REMOVED_SKILL} once fewer after its removal`);
  });

  it('5. Approve re-checks the AI\'s words: held for the invented term, then one write on "Approve with these"', async () => {
    // The row, open.
    const card = await openCard();
    // The ordinary Approve.
    await card.getByRole('button', { name: 'Approve and queue for submission', exact: true }).click();
    // The hold's second-click button.
    const again = card.getByRole('button', { name: 'Approve with these', exact: true });
    // Rendered: the check ran over the AI-written bullet and held.
    await again.waitFor({ timeout: 10_000 });
    // Nothing written yet.
    assert.deepEqual(writes, [], 'the first click must not approve a row whose AI edit is unsupported');
    // The finding names the invented word.
    assert.match((await card.locator('.diff__approve-hold').textContent()) ?? '', /zanzibarql/i, 'the hold must list the AI bullet\'s unsupported term');
    // The write the second click sends.
    const write = page.waitForRequest('**/rest/v1/rpc/advance_application_status', { timeout: 10_000 }).catch(() => null);
    // The acknowledgement.
    await again.click();
    // Answered.
    await (await write)?.response();
    // Exactly one write, for this row.
    assert.deepEqual(writes, [APP_ID], '"Approve with these" must send exactly one write');
    // No native dialog at any step.
    assert.equal(dialogs, 0, 'the chat and the approve must never open a browser dialog');
  });
});
