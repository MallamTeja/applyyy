/* WebScoutPanel: response validation, error mapping, and rendered state shape.
 *
 * WHY A LOADER HOOK. Node strips types but cannot run .tsx, and apps/web has no render
 * harness (see discoveryNoFastPath.test.ts). Rather than add a dependency, this test
 * registers a synchronous load hook that transpiles .tsx with the already-installed
 * `typescript` package and turns the .css import into an empty module.
 * Rendering uses react-dom/server, which ships with react-dom, so no DOM is needed.
 * Assertions match markup SHAPE (tags, attributes), never bare words from comments. */

import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, it, before } from 'node:test';
import { fileURLToPath } from 'node:url';

// Hook installed before the dynamic import below, so the import sees it.
registerHooks({
  // Runs for every module load; only .tsx and .css are special-cased.
  load(url, context, nextLoad) {
    // Stylesheet import has no runtime meaning in Node, so it becomes an empty module.
    if (url.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true };
    // Any other non-.tsx module loads normally.
    if (!url.endsWith('.tsx')) return nextLoad(url, context);
    // typescript is resolved from apps/web, where it is a devDependency.
    const ts = createRequire(import.meta.url)('typescript') as typeof import('typescript');
    // Read the source ourselves because nextLoad refuses .tsx.
    const source = readFileSync(fileURLToPath(url), 'utf8');
    // react-jsx matches tsconfig, so the output imports react/jsx-runtime.
    const out = ts.transpileModule(source, {
      compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    });
    // Hand Node plain ESM JavaScript.
    return { format: 'module', source: out.outputText, shortCircuit: true };
  },
});

// Loaded lazily so the hook above is active first.
let panel: typeof import('../src/features/discovery/WebScoutPanel.tsx');
// react-dom/server renders a state to a string with no DOM.
let render: (element: unknown) => string;
// createElement avoids needing JSX in a .ts test file.
let h: typeof import('react').createElement;

before(async () => {
  // The component module, transpiled by the hook.
  panel = await import('../src/features/discovery/WebScoutPanel.tsx');
  // Server renderer from the installed react-dom.
  render = (await import('react-dom/server')).renderToStaticMarkup as (element: unknown) => string;
  // React's element factory.
  h = (await import('react')).createElement;
});

// A body exactly as the contract describes, reused and mutated per test.
const okBody = () => ({
  status: 'ok',
  proposed: 5,
  verified: 2,
  inserted: 1,
  jobs: [{ title: 'Backend Engineer', company_name: 'Acme', apply_url: 'https://boards.greenhouse.io/acme/jobs/1', ats_provider: 'greenhouse', location_raw: null }],
  rejected: [{ url: 'https://example.com/made-up', reason: 'not a known ATS host' }],
});

// Fake client returning a canned result; no network.
const fake = (result: { data: unknown; error: unknown }) => ({ functions: { invoke: async () => result } });

// Renders a state through the pure view.
const view = (state: unknown) => render(h(panel.WebScoutView, { state: state as never, query: '', onQueryChange: () => {}, onSearch: () => {} }));

describe('runWebScout', () => {
  it('maps a valid 200 body to an ok state with its counts', async () => {
    const state = await panel.runWebScout(fake({ data: okBody(), error: null }), '');
    assert.equal(state.kind, 'ok');
    assert.equal(state.kind === 'ok' && state.result.verified, 2);
  });

  it('treats a body with no jobs as an error, never as zero jobs', async () => {
    const { jobs: _dropped, ...noJobs } = okBody();
    const state = await panel.runWebScout(fake({ data: noJobs, error: null }), '');
    assert.equal(state.kind, 'error');
  });

  it('reads a disabled envelope from error.context', async () => {
    const context = { json: async () => ({ status: 'disabled', message: 'Web scout is switched off.' }) };
    const state = await panel.runWebScout(fake({ data: null, error: { context } }), '');
    assert.deepEqual(state, { kind: 'disabled', message: 'Web scout is switched off.' });
  });

  it('maps unauthorized and survives an unreadable error body', async () => {
    const context = { json: async () => ({ status: 'unauthorized', message: 'Sign in again.' }) };
    assert.equal((await panel.runWebScout(fake({ data: null, error: { context } }), '')).kind, 'unauthorized');
    const broken = { json: async () => { throw new Error('not json'); } };
    assert.equal((await panel.runWebScout(fake({ data: null, error: { context: broken } }), '')).kind, 'error');
  });

  it('maps a 429 quota envelope to its own quota state, not an error and not zero jobs', async () => {
    // Exactly what scout-web returns when every key is cooling or the daily budget is spent.
    const context = { json: async () => ({ status: 'quota', message: 'gemini quota or daily budget exhausted; try again later' }) };
    const state = await panel.runWebScout(fake({ data: null, error: { context } }), '');
    // Its own kind, carrying the fixed user-facing remedy.
    assert.deepEqual(state, { kind: 'quota', message: panel.QUOTA_MESSAGE });
  });

  it('refuses status quota on a 2xx body', async () => {
    // A 200 claiming quota is contract drift, so it must be an error, never the quota notice.
    const state = await panel.runWebScout(fake({ data: { status: 'quota', message: 'x' }, error: null }), '');
    assert.equal(state.kind, 'error');
  });

  it('sends the trimmed query, and no query key when blank', async () => {
    const bodies: unknown[] = [];
    const client = { functions: { invoke: async (_n: string, o: { body: unknown }) => { bodies.push(o.body); return { data: okBody(), error: null }; } } };
    await panel.runWebScout(client, '  rust  ');
    await panel.runWebScout(client, '   ');
    assert.deepEqual(bodies, [{ query: 'rust' }, {}]);
  });
});

describe('WebScoutView markup', () => {
  it('renders the summary counts, the job link and the rejected details', async () => {
    const state = await panel.runWebScout(fake({ data: okBody(), error: null }), '');
    const html = view(state);
    assert.match(html, /Proposed 5 · verified 2 · added 1 to Discovered/);
    assert.match(html, /<a [^>]*href="https:\/\/boards\.greenhouse\.io\/acme\/jobs\/1"[^>]*rel="noopener noreferrer"/);
    assert.match(html, /<details [^>]*>[\s\S]*https:\/\/example\.com\/made-up[\s\S]*not a known ATS host/);
    // Rejected URLs must never be anchors.
    assert.equal(/<a [^>]*made-up/.test(html), false);
  });

  it('shows the disabled message and a disabled button while running', () => {
    assert.match(view({ kind: 'disabled', message: 'Switched off.' }), /<p class="web-scout__notice">Switched off\.<\/p>/);
    assert.match(view({ kind: 'running' }), /<button [^>]*disabled=""/);
  });

  it('renders the quota state as a non-alert notice', () => {
    const html = view({ kind: 'quota', message: 'Budget spent.' });
    // Notice styling, and no role=alert: it is information, not a failure.
    assert.match(html, /<p class="web-scout__notice">Budget spent\.<\/p>/);
    assert.equal(/role="alert"/.test(html), false);
  });

  it('labels the input', () => {
    assert.match(view({ kind: 'idle' }), /<label [^>]*for="web-scout-query"[^>]*>[\s\S]*<input id="web-scout-query"/);
  });
});
