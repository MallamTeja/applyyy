/* "Send through pipeline" on Pipeline-drawer cards (2026-10-08).
 *
 * The button runs the REAL deployed matcher -> tailor -> auditor for one passed_filters row. The
 * browser never writes a status (75a75a0 deleted a button that forged six transitions); it only
 * invokes functions through injected deps. What this file holds:
 *   - every outcome kind has its own non-empty sentence;
 *   - the button exists only in the passed_filters lane, and is disabled while its row is in flight;
 *   - the real-deps factory builds the exact function name, and never throws;
 *   - the per-row lock refuses a second start for the same id, across card instances.
 *
 * Rendered with react-dom/server through the same transpile hook the other .tsx tests use; no
 * network, no client, fakes only. */

// The .tsx loader; must be the first import so it runs before any component loads.
import './support/registerTsxHooks.ts';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it, before, afterEach } from 'node:test';
import { fileURLToPath } from 'node:url';

// The card module, loaded after the hooks are in place.
let card: typeof import('../src/features/pipeline/DrawerAppCard.tsx');
// The real-deps factory (imports supabase.ts, which is null with no env: fine here).
let depsModule: typeof import('../src/features/pipeline/rowPipelineDeps.ts');
// Static markup, no DOM.
let render: (element: unknown) => string;
// Element factory, so this .ts file needs no JSX.
let h: typeof import('react').createElement;
// Router context for the /approvals Link.
let MemoryRouter: typeof import('react-router-dom').MemoryRouter;

before(async () => {
  // Transpiled by the hook.
  card = await import('../src/features/pipeline/DrawerAppCard.tsx');
  // Plain .ts, type-stripped by Node.
  depsModule = await import('../src/features/pipeline/rowPipelineDeps.ts');
  // From the installed react-dom.
  render = (await import('react-dom/server')).renderToStaticMarkup as (element: unknown) => string;
  // React's factory.
  h = (await import('react')).createElement;
  // The app's router, so the Link renders as it does in the drawer.
  MemoryRouter = (await import('react-router-dom')).MemoryRouter;
});

// A real-shaped uuid: the engine refuses anything else, and the function name must carry it verbatim.
const ID = '3f2b6c1e-9a4d-4e2b-8c7f-0123456789ab';

// The lock is module-level, so a test that takes it must not leak it into the next.
afterEach(() => card.finishRow(ID));

// A minimal card row; no resume, so the View-resume button stays out of the markup.
const row = { id: ID, role: 'Engineer', company: 'Acme', createdAt: '2026-10-08T00:00:00Z', resume: null };

// Deps that must never be called by a static render; a call would mean a run started on render.
const inertDeps = {
  // Throws so a render-time invoke cannot pass silently.
  invoke: () => { throw new Error('invoke must not run during render'); },
  // Same.
  readStatus: () => { throw new Error('readStatus must not run during render'); },
};

// Renders one card in a given lane, with or without deps.
const cardIn = (status: string, deps: unknown = inertDeps) =>
  render(h(card.DrawerAppCard as never, { app: row, onViewResume: () => {}, sendThroughPipeline: { status, deps } }));

// The send button as markup: a real <button type="button"> carrying the feature's class.
const SEND_BUTTON = /<button type="button" class="[^"]*drawer__send-button[^"]*"[^>]*>/;

describe('outcome -> message table', () => {
  // One sample per kind and per branch, so every sentence the table can produce is exercised.
  const samples = [
    { kind: 'invalid_id' },
    { kind: 'status_unreadable' },
    { kind: 'not_startable', finalStatus: 'scored' },
    { kind: 'ready_for_approval', finalStatus: 'awaiting_approval' },
    { kind: 'dropped', finalStatus: 'dropped_filter', atStep: 'matcher' },
    { kind: 'failed', finalStatus: 'failed', atStep: 'tailor' },
    { kind: 'failed', finalStatus: 'failed', atStep: 'auditor' },
    { kind: 'stopped', atStep: 'matcher', reason: 'invoke_error', finalStatus: 'passed_filters' },
    { kind: 'stopped', atStep: 'matcher', reason: 'halted', finalStatus: 'passed_filters' },
    { kind: 'stopped', atStep: 'tailor', reason: 'body_failure', finalStatus: 'scored' },
    { kind: 'stopped', atStep: 'auditor', reason: 'no_progress', finalStatus: 'tailored' },
    { kind: 'stopped', atStep: 'tailor', reason: 'status_unreadable', finalStatus: null },
  ] as const;

  it('every outcome kind in the table has a sample here', () => {
    // A new kind added to the table without a sample here would go untested.
    assert.deepEqual(new Set(samples.map((s) => s.kind)), new Set(Object.keys(card.OUTCOME_MESSAGE)));
  });

  it('every sample yields a non-empty sentence, and no two are the same', () => {
    // 503 so the invoke_error sentence has a status to carry.
    const sentences = samples.map((s) => card.describeOutcome(s as never, 503));
    // Non-empty after trimming: a blank result is a silent outcome.
    for (const s of sentences) assert.ok(s.trim().length > 0);
    // Distinct: two outcomes sharing a sentence means one of them is lying.
    assert.equal(new Set(sentences).size, sentences.length);
  });

  it('invoke_error carries the HTTP status, and says "no HTTP response" when there was none', () => {
    // The stopped/invoke_error sample.
    const o = { kind: 'stopped', atStep: 'matcher', reason: 'invoke_error', finalStatus: 'passed_filters' } as never;
    // The value itself must appear, framed as an HTTP status.
    assert.match(card.describeOutcome(o, 403), /\(HTTP 403\)/);
    // Offline is distinct from any status code.
    assert.match(card.describeOutcome(o, null), /\(no HTTP response\)/);
  });
});

describe('OutcomeNote: the /approvals link', () => {
  // Renders the note inside a router, as the drawer does.
  const note = (outcome: unknown) =>
    render(h(MemoryRouter as never, null, h(card.OutcomeNote as never, { outcome, httpStatus: null })));

  it('ready_for_approval renders a link to /approvals', () => {
    // An anchor whose href is the queue; the router Link renders exactly this.
    assert.match(note({ kind: 'ready_for_approval', finalStatus: 'awaiting_approval' }), /<a [^>]*href="\/approvals"[^>]*>[^<]+<\/a>/);
  });

  it('a dropped row renders no link', () => {
    // No anchor at all: a link would invite approving a row the queue will not show.
    assert.doesNotMatch(note({ kind: 'dropped', finalStatus: 'dropped_filter', atStep: 'matcher' }), /<a /);
  });
});

describe('the button: lane and disabled state', () => {
  it('renders an enabled send button in the passed_filters lane', () => {
    // The card in its lane, idle, with deps.
    const html = cardIn('passed_filters');
    // The button is there.
    const button = html.match(SEND_BUTTON)?.[0];
    // Present at all.
    assert.ok(button, 'send button missing in passed_filters');
    // Idle and configured: clickable.
    assert.doesNotMatch(button, /disabled/);
  });

  it('renders no send button in any other lane', () => {
    // A spread of other lanes, including both neighbours of passed_filters.
    for (const status of ['discovered', 'deduped', 'scored', 'tailored', 'awaiting_approval', 'submitted']) {
      // Absent, not disabled: these lanes are not on this three-agent path.
      assert.doesNotMatch(cardIn(status), /drawer__send-button/, `button rendered in ${status}`);
    }
  });

  it('renders no send button when the prop is omitted (existing callers unchanged)', () => {
    // The pre-feature call shape.
    const html = render(h(card.DrawerAppCard as never, { app: row, onViewResume: () => {} }));
    // Nothing added.
    assert.doesNotMatch(html, /drawer__send/);
  });

  it('is disabled while its row is in flight', () => {
    // Another instance holds the row, as during a running send.
    assert.equal(card.tryStartRow(ID), true);
    // This card, rendered now, must not offer a second run.
    const button = cardIn('passed_filters').match(SEND_BUTTON)?.[0];
    // Present but disabled.
    assert.match(button ?? '', /disabled=""/);
  });

  it('is disabled with a visible reason when Supabase is not configured', () => {
    // deps null is the unconfigured machine.
    const html = cardIn('passed_filters', null);
    // Disabled button.
    assert.match(html.match(SEND_BUTTON)?.[0] ?? '', /disabled=""/);
    // The reason element is rendered beside it.
    assert.match(html, /<span class="drawer__send-reason">[^<]+<\/span>/);
  });

  it('has a polite live region for progress', () => {
    // Progress announcements must not interrupt.
    assert.match(cardIn('passed_filters'), /<div class="drawer__send-progress" aria-live="polite">/);
  });
});

describe('per-row lock', () => {
  it('refuses a second start for the same id until released', () => {
    // First claim wins.
    assert.equal(card.tryStartRow(ID), true);
    // Second claim, as a second click or a second card instance would make, is refused.
    assert.equal(card.tryStartRow(ID), false);
    // Visible to any instance at render.
    assert.equal(card.isRowInFlight(ID), true);
    // Released when the run ends.
    card.finishRow(ID);
    // Claimable again.
    assert.equal(card.tryStartRow(ID), true);
  });

  it('holds across two card instances', () => {
    // Instance A claims (as its click would).
    assert.equal(card.tryStartRow(ID), true);
    // Instance B, rendered while A runs, shows the button disabled.
    assert.match(cardIn('passed_filters').match(SEND_BUTTON)?.[0] ?? '', /disabled=""/);
    // A second instance for the same row still renders the same disabled state.
    assert.match(cardIn('passed_filters').match(SEND_BUTTON)?.[0] ?? '', /disabled=""/);
  });

  it('does not block a different row', () => {
    // Row A held.
    assert.equal(card.tryStartRow(ID), true);
    // A different id; the lock is per row, not global.
    const other = '00000000-0000-4000-8000-000000000000';
    // Row B is free.
    assert.equal(card.tryStartRow(other), true);
    // Clean up B (afterEach only clears ID).
    card.finishRow(other);
  });
});

describe('real deps factory, with a fake client', () => {
  // A fake client recording invoke names, with a scriptable invoke and status read.
  const fakeClient = (
    invoke: (name: string) => Promise<{ data: unknown; error: unknown }>,
    readStatusRow: () => PromiseLike<{ data: unknown; error: unknown }> = () => Promise.resolve({ data: { status: 'scored' }, error: null }),
  ) => {
    // Every function name the deps asked for.
    const names: string[] = [];
    // The client shape rowPipelineDeps expects.
    const client = {
      // Records, then delegates to the script.
      functions: { invoke: (name: string) => { names.push(name); return invoke(name); } },
      // The status read.
      readStatusRow,
    };
    // Both, so a test can assert on the recorded names.
    return { names, client };
  };

  it('invoke builds `matcher?application_id=<id>` exactly and returns the body', async () => {
    // A clean 2xx.
    const { names, client } = fakeClient(async () => ({ data: { success: true }, error: null }));
    // Through the factory, as the drawer does.
    const res = await depsModule.makeRowPipelineDeps(client).invoke('matcher', ID);
    // Exactly one call, with the id in the query string.
    assert.deepEqual(names, [`matcher?application_id=${ID}`]);
    // ok and the body passed through untouched.
    assert.deepEqual({ ok: res.ok, body: res.body }, { ok: true, body: { success: true } });
  });

  it('a thrown invoke becomes ok:false with httpStatus null, without throwing', async () => {
    // The transport throws.
    const { client } = fakeClient(async () => { throw new Error('network down'); });
    // Must resolve, never reject.
    const res = await depsModule.makeRowPipelineDeps(client).invoke('tailor', ID);
    // A failed call with no response.
    assert.deepEqual({ ok: res.ok, httpStatus: res.httpStatus }, { ok: false, httpStatus: null });
  });

  it('an HTTP error response becomes ok:false carrying its status', async () => {
    // The shape supabase-js gives: error.context is the Response.
    const response = new Response(JSON.stringify({ error: 'forbidden' }), { status: 403 });
    // invoke reports it in `error`, not as a throw.
    const { client } = fakeClient(async () => ({ data: null, error: Object.assign(new Error('non-2xx'), { context: response }) }));
    // Through the factory.
    const res = await depsModule.makeRowPipelineDeps(client).invoke('auditor', ID);
    // The status survives so the UI can print it.
    assert.deepEqual({ ok: res.ok, httpStatus: res.httpStatus }, { ok: false, httpStatus: 403 });
  });

  it('readStatus returns the string status', async () => {
    // The default fake read answers 'scored'.
    const { client } = fakeClient(async () => ({ data: null, error: null }));
    // Read through the factory.
    assert.equal(await depsModule.makeRowPipelineDeps(client).readStatus(ID), 'scored');
  });

  it('readStatus error -> null', async () => {
    // A PostgREST-style error result.
    const { client } = fakeClient(async () => ({ data: null, error: null }), () => Promise.resolve({ data: null, error: { message: 'rls' } }));
    // Unreadable, never a guess.
    assert.equal(await depsModule.makeRowPipelineDeps(client).readStatus(ID), null);
  });

  it('readStatus non-string status or throw -> null', async () => {
    // A number where the status should be.
    const numeric = fakeClient(async () => ({ data: null, error: null }), () => Promise.resolve({ data: { status: 7 }, error: null }));
    // Not a status.
    assert.equal(await depsModule.makeRowPipelineDeps(numeric.client).readStatus(ID), null);
    // A read that throws.
    const throwing = fakeClient(async () => ({ data: null, error: null }), () => { throw new Error('boom'); });
    // Same channel as an error.
    assert.equal(await depsModule.makeRowPipelineDeps(throwing.client).readStatus(ID), null);
  });
});

/* Review fixes (2026-10-08, peer 1). D8: the lock's release-on-every-path lived only inside the
 * component, unguarded; it is now withRowLock, tested here. D1-D4: sentences that could be false. */
describe('withRowLock: claim, run, always release', () => {
  it('releases after the run resolves', async () => {
    // A run that completes normally.
    const out = await card.withRowLock(ID, async () => 'done');
    // It ran and handed back its value.
    assert.deepEqual(out, { started: true, value: 'done' });
    // And the row is free again.
    assert.equal(card.isRowInFlight(ID), false);
  });

  it('releases after the run throws, and rethrows', async () => {
    // A run that blows up: the lock must not be stranded.
    await assert.rejects(card.withRowLock(ID, async () => { throw new Error('boom'); }), /boom/);
    // Released despite the throw.
    assert.equal(card.isRowInFlight(ID), false);
  });

  it('runs nothing while the row is held', async () => {
    // Held, as by another click or card.
    assert.equal(card.tryStartRow(ID), true);
    // Counts calls, so "nothing ran" is measured, not assumed.
    let calls = 0;
    // A second start for the same row.
    const out = await card.withRowLock(ID, async () => { calls += 1; });
    // Refused, and the run never executed (no Gemini spent).
    assert.deepEqual(out, { started: false });
    assert.equal(calls, 0);
    // The original holder still owns it; release for the next test.
    card.finishRow(ID);
  });
});

describe('outcome sentences stay true (review D1-D4)', () => {
  it('invoke_error names the function\'s own error words beside the status', () => {
    // A 409 from a missing master profile, as describeInvokeError words it.
    const text = card.describeOutcome({ kind: 'stopped', atStep: 'matcher', reason: 'invoke_error', finalStatus: 'passed_filters' }, 409, 'no_master_profile');
    // Both the code and the reason, once each, so the operator knows what to fix.
    assert.match(text, /\(HTTP 409: no_master_profile\)\.$/);
  });

  it('words that already carry the code are not prefixed again', () => {
    // describeInvokeError's wording, which a render check showed doubled as "(HTTP 409): HTTP 409: ...".
    const text = card.describeOutcome({ kind: 'stopped', atStep: 'matcher', reason: 'invoke_error', finalStatus: 'passed_filters' }, 409, 'HTTP 409: no_master_profile');
    // The code appears exactly once.
    assert.equal(text.split('HTTP 409').length - 1, 1);
  });

  it('a tailor failure names both of its causes', () => {
    // failed at the tailor can be a validator refusal OR an unusable posting.
    const text = card.describeOutcome({ kind: 'failed', atStep: 'tailor', finalStatus: 'failed' }, null);
    // Both causes, so neither one is asserted as fact.
    assert.match(text, /validation, or the posting was unusable/);
  });

  it('a failure after partial movement says where the row is NOW, never "still"', () => {
    // The auditor moved the row to audit_flagged, then reported a failure.
    const text = card.describeOutcome({ kind: 'stopped', atStep: 'auditor', reason: 'body_failure', finalStatus: 'audit_flagged' }, null);
    // True whether or not the step moved the row.
    assert.match(text, /now at audit_flagged/);
    // The false form is gone.
    assert.doesNotMatch(text, /still audit_flagged/);
  });

  it('a matcher drop claims no user setting that does not exist', () => {
    // The floor is a code constant, not a user threshold. 29, so the fixture stays a score the
    // floor of 30 can really produce (it was 31 under the old 45).
    const text = card.describeOutcome({ kind: 'dropped', atStep: 'matcher', finalStatus: 'dropped_filter', matcherDrop: { kind: 'low_score', score: 29 } }, null);
    // Names the matcher's own floor.
    assert.match(text, /matcher's advance floor/);
    // Never "your threshold".
    assert.doesNotMatch(text, /your threshold/);
  });
});

/* Matcher drop sentences (2026-10-09). The pre-gate and a low score both end at dropped_filter;
 * only the cause the engine read may be claimed. An unread cause gets the neutral sentence. */
describe('matcher drop sentences: pre-gate vs low score vs unknown', () => {
  // The base matcher drop, before a cause is attached.
  const base = { kind: 'dropped', finalStatus: 'dropped_filter', atStep: 'matcher' } as const;

  it('pre-gate drop says pre-gate and that no Gemini call was made', () => {
    // A drop the pre-gate made, with match_score NULL.
    const text = card.describeOutcome({ ...base, matcherDrop: { kind: 'pre_gate' } }, null);
    // Names the stage that dropped it.
    assert.match(text, /^Dropped by the matcher's pre-gate: /);
    // True for both gate branches: an excluded term, or no configured title/keyword matched.
    assert.match(text, /excluded keywords, or none of your target titles and keywords/);
    // The cost fact the operator cares about.
    assert.match(text, /No Gemini call was made\.$/);
    // Never the score sentence, which is false here.
    assert.doesNotMatch(text, /scored/);
  });

  it('low-score drop names the score and the floor', () => {
    // A real low score, read back from the row.
    // 29: the top of `poor`, one below the floor of 30 (Teja's ruling, 2026-11-07; it was 31 under the old 45).
    const text = card.describeOutcome({ ...base, matcherDrop: { kind: 'low_score', score: 29 } }, null);
    // The value in hand and the code-constant floor.
    assert.equal(text, "Dropped by the matcher: it scored 29, below the matcher's advance floor of 30.");
  });

  it('unknown-score drop is the neutral sentence', () => {
    // The score could not be read.
    const text = card.describeOutcome({ ...base, matcherDrop: { kind: 'unknown' } }, null);
    // No cause claimed.
    assert.equal(text, 'Dropped by the matcher.');
  });

  it('a matcher drop with no cause read is the neutral sentence too', () => {
    // An outcome from deps without readMatchScore.
    const text = card.describeOutcome(base, null);
    // Same as unknown: neither cause is claimed.
    assert.equal(text, 'Dropped by the matcher.');
  });
});

describe('real deps factory: readMatchScore', () => {
  // A deps object over a client whose one read answers as scripted.
  const depsOver = (read: () => PromiseLike<{ data: unknown; error: unknown }>) =>
    // Invoke is never called by these tests.
    depsModule.makeRowPipelineDeps({ functions: { invoke: async () => ({ data: null, error: null }) }, readStatusRow: read });

  it('a NULL match_score is read as a real null', async () => {
    // The pre-gate's row.
    const deps = depsOver(() => Promise.resolve({ data: { status: 'dropped_filter', match_score: null }, error: null }));
    // A found value of null.
    assert.deepEqual(await deps.readMatchScore?.(ID), { value: null });
  });

  it('a numeric match_score is passed through raw for the engine to validate', async () => {
    // A low-score row.
    const deps = depsOver(() => Promise.resolve({ data: { status: 'dropped_filter', match_score: 31 }, error: null }));
    // The raw value.
    assert.deepEqual(await deps.readMatchScore?.(ID), { value: 31 });
  });

  it('a row without the column, an error, no row, or a throw is unreadable (null)', async () => {
    // The column is absent: not a NULL, so never read as the pre-gate.
    assert.equal(await depsOver(() => Promise.resolve({ data: { status: 'dropped_filter' }, error: null })).readMatchScore?.(ID), null);
    // An RLS or network error.
    assert.equal(await depsOver(() => Promise.resolve({ data: null, error: { message: 'rls' } })).readMatchScore?.(ID), null);
    // No row at all.
    assert.equal(await depsOver(() => Promise.resolve({ data: null, error: null })).readMatchScore?.(ID), null);
    // A throwing read.
    assert.equal(await depsOver(() => { throw new Error('boom'); }).readMatchScore?.(ID), null);
  });

  it('the live read selects match_score beside status', () => {
    // The deps source, as written.
    const src = readFileSync(fileURLToPath(new URL('../src/features/pipeline/rowPipelineDeps.ts', import.meta.url)), 'utf8');
    // The one select, both columns.
    assert.match(src, /\.select\('status, match_score'\)/);
  });
});

/* The drawer loads at most 25 rows of a lane that can hold thousands; its header must not imply
 * every row is listed. Pure, so the wording is tested without a client. */
describe('drawerHeading: "showing N of M" whenever N < M', () => {
  it('a truncated list says showing N of M', () => {
    // 25 loaded of 6661 in the lane.
    assert.equal(card.drawerHeading({ count: 6661, shown: 25, conclusive: true }), 'Showing 25 of 6661 applications');
  });

  it('a complete list prints the count', () => {
    // Everything listed.
    assert.equal(card.drawerHeading({ count: 3, shown: 3, conclusive: true }), '3 Applications');
    // Singular.
    assert.equal(card.drawerHeading({ count: 1, shown: 1, conclusive: true }), '1 Application');
  });

  it('more rows than the board count never prints a smaller number than is listed', () => {
    // The board count comes from a different, older query.
    assert.equal(card.drawerHeading({ count: 2, shown: 4, conclusive: true }), '4 Applications');
  });

  it('an inconclusive read prints no number', () => {
    // No standing to repeat a count.
    assert.equal(card.drawerHeading({ count: 6661, shown: 0, conclusive: false }), 'Applications');
  });
});

/* A run that ends short of approval at a step the engine reported "done" (the auditor's second hop
 * failed, leaving audit_flagged) must not show "Auditor: done" beside "Stopped at the auditor". */
describe('settleProgress: the step list agrees with the outcome note', () => {
  it('a stopped outcome marks its step stopped, even after a done event', () => {
    // The auditor moved tailored -> audit_flagged (done), then the run ended there.
    const progress = { matcher: 'skipped', tailor: 'skipped', auditor: 'done' } as const;
    // The engine's after-loop verdict.
    const settled = card.settleProgress(progress, { kind: 'stopped', atStep: 'auditor', reason: 'no_progress', finalStatus: 'audit_flagged' });
    // Both now say "stopped" at the auditor.
    assert.equal(settled.auditor, 'stopped');
    // Other steps unchanged.
    assert.equal(settled.matcher, 'skipped');
  });

  it('a non-stopped outcome leaves the list as the engine reported it', () => {
    // A clean run.
    const progress = { matcher: 'done', tailor: 'done', auditor: 'done' } as const;
    // Ready for approval.
    const settled = card.settleProgress(progress, { kind: 'ready_for_approval', finalStatus: 'awaiting_approval' });
    // Same content.
    assert.deepEqual(settled, progress);
  });
});
