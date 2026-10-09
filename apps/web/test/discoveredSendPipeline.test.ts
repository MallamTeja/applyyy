/* "Send through pipeline" on Discovered job cards (Teja's ruling, 2026-10-08 16:08).
 *
 * The page reuses the drawer's SendThroughPipeline with a longer step list (DISCOVERED_STEPS).
 * What this file holds:
 *   - the component renders exactly the steps it is given (five here, three in the drawer);
 *   - the not_startable sentence names the lane's real start status, not a hard-coded one;
 *   - a drop names the deployed agent that made the call, so a Filtered Out card's drop cannot
 *     read as this page's local filter preview (orchestrator ruling, 17:31).
 *
 * Renders the exported component, never the page: the page imports supabase.ts. */

import assert from 'node:assert/strict';
import { registerHooks, createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { describe, it, before } from 'node:test';
import { fileURLToPath } from 'node:url';

// Same hooks as drawerSendPipeline.test.ts: the card has extensionless relative imports.
registerHooks({
  // Extensionless RELATIVE imports only: try the original, then .tsx, then .ts.
  resolve(specifier, context, nextResolve) {
    // Packages and already-extended paths resolve normally.
    if (!specifier.startsWith('.') || /\.[cm]?[jt]sx?$|\.css$/.test(specifier)) return nextResolve(specifier, context);
    // First the way Vite would write it.
    try { return nextResolve(specifier, context); } catch { /* fall through to TS extensions */ }
    // A component is the usual case.
    try { return nextResolve(`${specifier}.tsx`, context); } catch { /* then a plain module */ }
    // Last resort; a genuine miss throws with the .ts path named.
    return nextResolve(`${specifier}.ts`, context);
  },
  // .css becomes empty, .tsx is transpiled with apps/web's own typescript.
  load(url, context, nextLoad) {
    // Stylesheets have no runtime meaning in Node.
    if (url.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true };
    // Everything else but .tsx loads normally.
    if (!url.endsWith('.tsx')) return nextLoad(url, context);
    // No new dependency.
    const ts = createRequire(import.meta.url)('typescript') as typeof import('typescript');
    // nextLoad refuses .tsx, so read it directly.
    const source = readFileSync(fileURLToPath(url), 'utf8');
    // react-jsx matches tsconfig.
    const out = ts.transpileModule(source, {
      compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    });
    // Plain ESM for Node.
    return { format: 'module', source: out.outputText, shortCircuit: true };
  },
});

// The card module, loaded after the hooks.
let card: typeof import('../src/features/pipeline/DrawerAppCard.tsx');
// The engine's step lists, the only thing that differs between the two lanes.
let rp: typeof import('../src/features/pipeline/rowPipeline.ts');
// Static markup, no DOM.
let render: (element: unknown) => string;
// Element factory, so this .ts file needs no JSX.
let h: typeof import('react').createElement;

before(async () => {
  // Transpiled by the hook.
  card = await import('../src/features/pipeline/DrawerAppCard.tsx');
  // Plain .ts, type-stripped by Node.
  rp = await import('../src/features/pipeline/rowPipeline.ts');
  // From the installed react-dom.
  render = (await import('react-dom/server')).renderToStaticMarkup as (element: unknown) => string;
  // React's factory.
  h = (await import('react')).createElement;
});

// Real-shaped, distinct from the drawer test's id so the module lock cannot couple the files.
const ID = '7c1d2e3f-4a5b-4c6d-8e9f-a0b1c2d3e4f5';

// Deps that throw if a static render ever starts a run.
const inertDeps = {
  // A render-time invoke must fail loudly.
  invoke: () => { throw new Error('invoke must not run during render'); },
  // Same for the read.
  readStatus: () => { throw new Error('readStatus must not run during render'); },
};

// The send button as markup: a real <button type="button"> carrying the feature's class.
const SEND_BUTTON = /<button type="button" class="[^"]*drawer__send-button[^"]*"[^>]*>/;

// Renders the component, idle, with a given step list.
const renderWith = (steps: unknown) => render(h(card.SendThroughPipeline as never, { applicationId: ID, deps: inertDeps, steps }));

// The idle button's title: the agents one click will run, which is what the operator spends quota on.
const buttonTitle = (html: string) => html.match(SEND_BUTTON)?.[0].match(/title="([^"]*)"/)?.[1] ?? '';

describe('SendThroughPipeline renders the steps it is given', () => {
  it('DISCOVERED_STEPS names all five agents, in order, and the button is enabled', () => {
    // The discovered lane's list.
    const html = renderWith(rp.DISCOVERED_STEPS);
    // Every agent of the chain, in run order (the arrow is HTML-escaped by React only if needed; it is not).
    assert.match(buttonTitle(html), /Normalizer → Screener → Matcher → Tailor → Auditor/);
    // Idle with deps: clickable.
    assert.doesNotMatch(html.match(SEND_BUTTON)?.[0] ?? 'missing disabled', /disabled/);
  });

  it('PASSED_FILTERS_STEPS names only the three later agents', () => {
    // The drawer's list.
    const title = buttonTitle(renderWith(rp.PASSED_FILTERS_STEPS));
    // The three, in order.
    assert.match(title, /Matcher → Tailor → Auditor/);
    // And the first two agents are absent.
    assert.doesNotMatch(title, /Normalizer|Screener/);
  });
});

describe('per-card accessibility (review fix, 2026-10-08)', () => {
  it('a label gives the button a unique accessible name', () => {
    // Twenty cards with the same name are indistinguishable to a screen reader.
    const html = render(h(card.SendThroughPipeline as never, { applicationId: ID, deps: inertDeps, steps: rp.DISCOVERED_STEPS, label: 'Acme — Engineer' }));
    // The visible text first (WCAG 2.5.3 label-in-name), then the job that makes it unique.
    assert.match(html.match(SEND_BUTTON)?.[0] ?? '', /aria-label="Send through pipeline: Acme — Engineer"/);
  });

  it('without a label the button keeps its visible text as its name (drawer unchanged)', () => {
    // The drawer passes no label.
    assert.doesNotMatch(renderWith(rp.PASSED_FILTERS_STEPS).match(SEND_BUTTON)?.[0] ?? '', /aria-label=/);
  });

  it('the progress block stays live when onSettled is given, so refusal and throw notes are announced', () => {
    // The Discovered page's call shape. The outcome sentence moves to the page strip, but the card's
    // own notes (lock refusal, unexpected throw) reach no other live region, so this one must stay.
    const html = render(h(card.SendThroughPipeline as never, { applicationId: ID, deps: inertDeps, steps: rp.DISCOVERED_STEPS, onSettled: () => {} }));
    // Positive shape: the polite region is present on the page's cards too.
    assert.match(html, /<div class="drawer__send-progress" aria-live="polite">/);
  });
});

describe('withRowLockThenSettle: settle runs once, after the lock is released', () => {
  // A row that walks the whole discovered chain, one hop per invoke.
  const NEXT: Record<string, string> = { discovered: 'deduped', deduped: 'passed_filters', passed_filters: 'scored', scored: 'tailored', tailored: 'awaiting_approval' };

  it('drives a real engine run to completion, then settles exactly once with the row free', async () => {
    // The fake row's status; only the fake invoke moves it.
    let status = 'discovered';
    // Whether the lock was held while the engine was working (it must be).
    let heldDuringRun = false;
    // The fake deps: one hop per invoke, and a read that records the lock state.
    const deps = {
      // Advances one hop, as a deployed agent would.
      invoke: async () => { status = NEXT[status] ?? status; return { ok: true, httpStatus: 200, body: { success: true } }; },
      // Reads the status and samples the lock mid-run.
      readStatus: async () => { heldDuringRun ||= card.isRowInFlight(ID); return status; },
    };
    // Every settle call, with the lock state seen inside it.
    const settles: boolean[] = [];
    // The helper the component uses, with a real engine run inside.
    const out = await card.withRowLockThenSettle(ID, () => rp.runRowPipeline(deps, ID, rp.DISCOVERED_STEPS), () => { settles.push(card.isRowInFlight(ID)); });
    // The run happened and reached the queue.
    assert.deepEqual(out, { started: true, value: { kind: 'ready_for_approval', finalStatus: 'awaiting_approval' } });
    // The lock was really held during the run, so "free at settle" is a release, not a no-op.
    assert.equal(heldDuringRun, true);
    // Exactly one settle, and the row was already free inside it (a reload sees it claimable).
    assert.deepEqual(settles, [false]);
  });

  it('a refused start still settles exactly once, and runs nothing', async () => {
    // Held by another click or card.
    assert.equal(card.tryStartRow(ID), true);
    // Counts runs, so "nothing ran" is measured.
    let runs = 0;
    // Counts settles.
    let settles = 0;
    // The second start.
    const out = await card.withRowLockThenSettle(ID, async () => { runs += 1; }, () => { settles += 1; });
    // Refused, nothing ran, settled once.
    assert.deepEqual({ out, runs, settles }, { out: { started: false }, runs: 0, settles: 1 });
    // Release for the next test.
    card.finishRow(ID);
  });

  it('a run that throws still releases the row and settles exactly once, then rethrows', async () => {
    // Counts settles, and records the lock state inside each one.
    const settles: boolean[] = [];
    // The third path of "every path": the run rejects.
    await assert.rejects(card.withRowLockThenSettle(ID, async () => { throw new Error('boom'); }, () => { settles.push(card.isRowInFlight(ID)); }), /boom/);
    // One settle, with the row already free inside it.
    assert.deepEqual(settles, [false]);
    // And free afterwards, so the next click can claim it.
    assert.equal(card.isRowInFlight(ID), false);
  });
});

describe('outcome sentences for the discovered lane', () => {
  it('not_startable names the discovered lane\'s start status', () => {
    // A row that left discovered (e.g. a scheduled normalizer got there first).
    const text = card.describeOutcome({ kind: 'not_startable', finalStatus: 'deduped' }, null, null, rp.DISCOVERED_STEPS);
    // The expected start, from STEP_INPUT_STATUS of the first step.
    assert.match(text, /not discovered/);
    // Never the drawer's lane.
    assert.doesNotMatch(text, /passed_filters/);
  });

  it('not_startable still names passed_filters for the drawer lane', () => {
    // The drawer's list keeps its old sentence.
    assert.match(card.describeOutcome({ kind: 'not_startable', finalStatus: 'scored' }, null, null, rp.PASSED_FILTERS_STEPS), /not passed_filters/);
  });

  it('a screener drop says the screener agent made the call', () => {
    // The outcome the engine returns when the deployed screener drops the row.
    const text = card.describeOutcome({ kind: 'dropped', finalStatus: 'dropped_filter', atStep: 'screener' }, null);
    // Attributed to the deployed agent, not left ambiguous with the page's local filter preview.
    assert.match(text, /^Dropped by the screener/);
  });

  it('a matcher drop names the matcher and its advance floor', () => {
    // The outcome for a row scored below the code-constant floor.
    const text = card.describeOutcome({ kind: 'dropped', finalStatus: 'dropped_filter', atStep: 'matcher' }, null);
    // Agent named first, then the reason.
    assert.match(text, /^Dropped by the matcher: .*advance floor/);
  });

  it('a normalizer duplicate says the normalizer found a duplicate', () => {
    // The outcome for a fingerprint match against another of the user's jobs.
    const text = card.describeOutcome({ kind: 'dropped', finalStatus: 'dropped_duplicate', atStep: 'normalizer' }, null);
    // Agent named, and the reason the status itself states.
    assert.match(text, /^Dropped by the normalizer: .*duplicate/);
  });
});
