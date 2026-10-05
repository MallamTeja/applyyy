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
    // The happy path is the baseline every other case is a deviation from.
    const state = await panel.runWebScout(fake({ data: okBody(), error: null }), '');
    // The kind proves the body passed the shape check.
    assert.equal(state.kind, 'ok');
    // A count read back proves the result was carried through, not just labelled ok.
    assert.equal(state.kind === 'ok' && state.result.verified, 2);
  });

  it('treats a body with no jobs as an error, never as zero jobs', async () => {
    // Destructure `jobs` away so every other field stays valid and only the missing array can fail it.
    const { jobs: _dropped, ...noJobs } = okBody();
    const state = await panel.runWebScout(fake({ data: noJobs, error: null }), '');
    // Error, not ok with an empty list: absent data must never read as "0 jobs found".
    assert.equal(state.kind, 'error');
  });

  it('reads a disabled envelope from error.context', async () => {
    // Mimics supabase-js: a non-2xx puts the Response under error.context, with data null.
    const context = { json: async () => ({ status: 'disabled', message: 'Web scout is switched off.' }) };
    const state = await panel.runWebScout(fake({ data: null, error: { context } }), '');
    // deepEqual also pins the message, which must reach the user verbatim.
    assert.deepEqual(state, { kind: 'disabled', message: 'Web scout is switched off.' });
  });

  it('maps unauthorized and survives an unreadable error body', async () => {
    // Unauthorized needs its own kind because the remedy is signing in, not retrying.
    const context = { json: async () => ({ status: 'unauthorized', message: 'Sign in again.' }) };
    assert.equal((await panel.runWebScout(fake({ data: null, error: { context } }), '')).kind, 'unauthorized');
    // A body that is not JSON must degrade to a generic error, never throw out of the handler.
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
    // The body is otherwise fully valid (counts and arrays), so ONLY the `status !== 'ok'` guard can reject it;
    // a body missing those fields would be refused by the count checks and leave that guard untested.
    const state = await panel.runWebScout(fake({ data: { ...okBody(), status: 'quota' }, error: null }), '');
    // Error kind proves the guard fired rather than the quota branch being reachable from a 2xx.
    assert.equal(state.kind, 'error');
  });

  it('maps a 503 upstream_unavailable envelope to its own upstream state', async () => {
    // Exactly what scout-web returns when Gemini stayed overloaded through every retry.
    const context = { json: async () => ({ status: 'upstream_unavailable', message: 'gemini is temporarily overloaded; try again in a few minutes' }) };
    const state = await panel.runWebScout(fake({ data: null, error: { context } }), '');
    // Fixed user-facing text, not the server's.
    assert.deepEqual(state, { kind: 'upstream', message: panel.UPSTREAM_MESSAGE });
  });

  it('refuses status upstream_unavailable on a 2xx body', async () => {
    // Same drift guard as quota: otherwise-valid body, so only the status check can reject it.
    const state = await panel.runWebScout(fake({ data: { ...okBody(), status: 'upstream_unavailable' }, error: null }), '');
    // Error kind proves the upstream branch is unreachable from a 2xx.
    assert.equal(state.kind, 'error');
  });

  it('sends the trimmed query, and no query key when blank', async () => {
    // Collects what each call sent, since the body is the only thing this test observes.
    const bodies: unknown[] = [];
    // Fake that records the body and returns a valid result so the call itself succeeds.
    const client = { functions: { invoke: async (_n: string, o: { body: unknown }) => { bodies.push(o.body); return { data: okBody(), error: null }; } } };
    // Padded query: the backend should get the trimmed text, not the user's stray spaces.
    await panel.runWebScout(client, '  rust  ');
    // Whitespace-only counts as blank, so the backend falls back to saved preferences.
    await panel.runWebScout(client, '   ');
    // An absent key, not query:'', is how the contract says "use my preferences".
    assert.deepEqual(bodies, [{ query: 'rust' }, {}]);
  });
});

describe('WebScoutView markup', () => {
  it('renders the summary counts, the job link and the rejected details', async () => {
    // Go through runWebScout so the markup is rendered from a really-validated state.
    const state = await panel.runWebScout(fake({ data: okBody(), error: null }), '');
    const html = view(state);
    // All three counts, so the proposed-versus-verified gap is visible.
    assert.match(html, /Proposed 5 · verified 2 · added 1 to Discovered/);
    // noopener+noreferrer on the external link so the target cannot reach window.opener.
    assert.match(html, /<a [^>]*href="https:\/\/boards\.greenhouse\.io\/acme\/jobs\/1"[^>]*rel="noopener noreferrer"/);
    // Evidence of what was invented sits in the collapsible block, reason included.
    assert.match(html, /<details [^>]*>[\s\S]*https:\/\/example\.com\/made-up[\s\S]*not a known ATS host/);
    // Rejected URLs must never be anchors.
    assert.equal(/<a [^>]*made-up/.test(html), false);
  });

  it('shows the disabled message and a disabled button while running', () => {
    // Notice styling, not alert styling: the kill switch is information.
    assert.match(view({ kind: 'disabled', message: 'Switched off.' }), /<p class="web-scout__notice">Switched off\.<\/p>/);
    // The disabled attribute is what stops a double click starting two paid searches.
    assert.match(view({ kind: 'running' }), /<button [^>]*disabled=""/);
  });

  it('renders the quota state as a non-alert notice', () => {
    // A fixed message stands in for the state's own text; only the markup is under test.
    const html = view({ kind: 'quota', message: 'Budget spent.' });
    // Notice styling, and no role=alert: it is information, not a failure.
    assert.match(html, /<p class="web-scout__notice">Budget spent\.<\/p>/);
    assert.equal(/role="alert"/.test(html), false);
  });

  // The announcement contract: a live region injected together with its text is often not announced,
  // so the status container must exist from the first render and the notices must sit inside it.
  // Non-greedy up to the first `</div>`: the region holds no nested div, so that is its own closing tag.
  const statusRegion = (html: string) => /<div [^>]*role="status"[^>]*>[\s\S]*?<\/div>/.exec(html)?.[0] ?? '';

  it('keeps the live region mounted while idle, as a div so it can hold a paragraph', () => {
    // Present before any state change, otherwise the first announcement can be dropped.
    assert.match(view({ kind: 'idle' }), /<div class="web-scout__status" role="status" aria-live="polite"><\/div>/);
  });

  it('renders the quota and disabled notices INSIDE the live region, once each', () => {
    // Quota notice: inside the role=status element, not a sibling after it.
    assert.match(statusRegion(view({ kind: 'quota', message: 'Budget spent.' })), /<p class="web-scout__notice">Budget spent\.<\/p>/);
    // Disabled notice: same placement, same reason.
    assert.match(statusRegion(view({ kind: 'disabled', message: 'Switched off.' })), /<p class="web-scout__notice">Switched off\.<\/p>/);
    // Visible text must not be duplicated (e.g. a hidden twin for screen readers).
    assert.equal(view({ kind: 'quota', message: 'Budget spent.' }).split('Budget spent.').length - 1, 1);
  });

  it('renders the upstream notice inside the live region, once, and never as an alert', () => {
    const html = view({ kind: 'upstream', message: 'Overloaded.' });
    // Inside the role=status element, so a screen-reader user hears it.
    assert.match(statusRegion(html), /<p class="web-scout__notice">Overloaded\.<\/p>/);
    // Information, not a failure.
    assert.equal(/role="alert"/.test(html), false);
    // Not duplicated elsewhere on the page.
    assert.equal(html.split('Overloaded.').length - 1, 1);
  });

  it('keeps the running message in the live region and errors outside it as alerts', () => {
    // The running text is the region's own content, so it is announced on change.
    assert.match(statusRegion(view({ kind: 'running' })), /^<div [^>]*>Searching the web and verifying links\./);
    // An error is assertive: it must follow the empty polite region, not be nested in it.
    assert.match(view({ kind: 'error', message: 'Boom.' }), /<div [^>]*role="status"[^>]*><\/div>[\s\S]*<p class="web-scout__error" role="alert">Boom\.<\/p>/);
  });

  it('never renders comment syntax as visible text in any state', async () => {
    // In JSX children a bare `//` line is literal text, not a comment; tsc cannot see it, so test the rendered output.
    const ok = await panel.runWebScout(fake({ data: okBody(), error: null }), '');
    // Every state, with the ok state carrying jobs AND rejected rows so the whole result block renders.
    const states = [{ kind: 'idle' }, { kind: 'running' }, ok, { kind: 'disabled', message: 'Off.' }, { kind: 'quota', message: 'Spent.' }, { kind: 'upstream', message: 'Busy.' }, { kind: 'unauthorized', message: 'Sign in.' }, { kind: 'error', message: 'Boom.' }];
    // The ok state must really be ok, or the result block would be silently untested.
    assert.equal(ok.kind, 'ok');
    for (const state of states) {
      // Tags stripped so only the text a user (or screen reader) receives is inspected.
      const text = view(state).replace(/<[^>]*>/g, ' ');
      // `//` not preceded by `:` so the legitimate https:// in a rejected URL is not a false positive.
      // Neither line-comment nor block-comment openers may appear in rendered text.
      assert.equal(/(^|[^:])\/\/|\/\*/.test(text), false, `comment syntax rendered in state ${state.kind}`);
    }
  });

  it('labels the input', () => {
    // A real label tied by for/id, because a placeholder is not an accessible name.
    assert.match(view({ kind: 'idle' }), /<label [^>]*for="web-scout-query"[^>]*>[\s\S]*<input id="web-scout-query"/);
  });
});
