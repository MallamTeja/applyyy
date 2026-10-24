/* "Needs you" queues (2026-10-24): every row a human must finish or check shows its apply link, why it
 * is waiting, and the two human resolves; the rail badge counts exactly those rows.
 *
 * WHY. GitLab application ba1e5d1d was submitted by the worker at 12:49 IST with an UNKNOWN outcome and
 * swept to needs_verification. Its queue on System health listed only "Title at Company": no link to
 * check or finish the application, no reason, and nothing on the rail said a job was waiting. These
 * tests pin the row (link through safeHref, reason, both resolves) and the badge's arithmetic.
 *
 * Rendered, not grepped: RecoveryRowView is the exact component RecoveryQueue draws per row, rendered
 * by react-dom/server through the same transpile hook healthRuleWarnings.test.ts uses. */

import assert from 'node:assert/strict';
import { registerHooks, createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { describe, it, before } from 'node:test';
import { fileURLToPath } from 'node:url';

// Same hooks as healthRuleWarnings.test.ts: the health modules use extensionless relative imports.
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

// The queue module, loaded after the hooks are in place.
let queue: typeof import('../src/features/health/RecoveryQueue.tsx');
// The lane helpers, for the badge count.
let lanes: typeof import('../src/data/humanLanes.ts');
// The graph, so the rendered moves are the real human edges, not a test copy.
let contract: typeof import('../src/data/contract.ts');
// Static markup, no DOM.
let render: (element: unknown) => string;
// Element factory, so this .ts file needs no JSX.
let h: typeof import('react').createElement;

before(async () => {
  // Transpiled by the hook.
  queue = await import('../src/features/health/RecoveryQueue.tsx');
  // Plain .ts; Node strips the types.
  lanes = await import('../src/data/humanLanes.ts');
  // Plain .ts.
  contract = await import('../src/data/contract.ts');
  // From the installed react-dom.
  render = (await import('react-dom/server')).renderToStaticMarkup as (element: unknown) => string;
  // React's factory.
  h = (await import('react')).createElement;
});

// The live GitLab row's shape as the queue's select returns it; only apply_url varies between cases.
const gitlabRaw = (applyUrl: unknown) => ({
  // The real row id from the 2026-10-24 incident.
  id: 'ba1e5d1d-84a5-4cfb-b5a6-e5a2943bf154',
  // The move's stale-stamp guard.
  updated_at: '2026-10-24T07:35:00.000000+00:00',
  // Swept rows carry no lease.
  claim_expires_at: null,
  // needs_verification rows have no block reason.
  block_reason: null,
  // Nor a failure reason.
  failure_reason: null,
  // The embedded job, as PostgREST nests it.
  jobs: { title: 'Intermediate Backend Engineer, India', company_name: 'GitLab', apply_url: applyUrl },
});

// One rendered row in the needs_verification queue, with the page's real manual-action wording.
function renderRow(applyUrl: unknown): string {
  // Parsed by the same function the queue's read uses.
  const row = queue.parseQueueRow('needs_verification', gitlabRaw(applyUrl));
  // A valid id and stamp must parse; null here would make every later assertion vacuous.
  assert.ok(row !== null, 'the GitLab row must parse');
  // Wrapped in a table body, where the queue draws it.
  return render(
    h('table', null, h('tbody', null, h(queue.RecoveryRowView, {
      // The queue under test.
      status: 'needs_verification',
      // The parsed row.
      row,
      // The real human edges out of needs_verification, from the graph.
      moves: contract.nextStatuses('needs_verification', 'human'),
      // The wording HealthPage passes to the two manual-action queues.
      verb: queue.manualActionVerb,
      // And their meaning lines.
      meaning: queue.manualActionMeaning,
      // Not in flight.
      locked: false,
      // Not frozen after an unknown outcome.
      frozen: false,
      // No live lease on a swept row.
      lease: null,
      // Clicks are not exercised by a static render.
      onMove: () => {},
    }))),
  );
}

describe('needs_verification row (the GitLab case)', () => {
  it('renders the apply link through safeHref, in a new tab, with noopener noreferrer', () => {
    // The live posting URL.
    const html = renderRow('https://job-boards.greenhouse.io/gitlab/jobs/8775507002');
    // The exact anchor: safe href, new tab, no opener and no referrer handed to the employer's page.
    assert.match(html, /<a [^>]*href="https:\/\/job-boards\.greenhouse\.io\/gitlab\/jobs\/8775507002"[^>]*target="_blank"[^>]*rel="noopener noreferrer"/);
  });

  it('says why the row is waiting: the submit outcome is unknown', () => {
    // Same row.
    const html = renderRow('https://job-boards.greenhouse.io/gitlab/jobs/8775507002');
    // The reason sentence for this status.
    assert.match(html, /Submit outcome unknown/);
  });

  it('offers both human resolves: mark applied, and failed / skip', () => {
    // Same row.
    const html = renderRow('https://job-boards.greenhouse.io/gitlab/jobs/8775507002');
    // The "I applied" resolve, as a button.
    assert.match(html, /<button[^>]*>I applied \(mark applied\)<\/button>/);
    // The give-up resolve, as a button.
    assert.match(html, /<button[^>]*>Failed \/ skip<\/button>/);
  });

  it('renders NO href for a javascript: apply_url, and says the link is unavailable', () => {
    // A hostile value a board could have stored.
    const html = renderRow('javascript:alert(1)');
    // Positive shape: the row has no anchor with an href at all.
    assert.equal(/<a [^>]*href=/.test(html), false, 'a javascript: apply_url must not become a link');
    // And the operator is told why there is no link.
    assert.match(html, /Apply link unavailable/);
  });
});

describe('blocked_needs_human row', () => {
  it('names the block reason in words', () => {
    // A captcha block, the commonest manual case.
    const row = queue.parseQueueRow('blocked_needs_human', { ...gitlabRaw('https://example.com/job'), block_reason: 'captcha' });
    // Parsed.
    assert.ok(row !== null);
    // The enum value in plain words.
    assert.equal(row.reason, 'Blocked: captcha');
  });
});

describe('rail badge count', () => {
  it('equals needs_verification + blocked_needs_human, and ignores every other lane', () => {
    // Live-like counts, including lanes the badge must not count.
    const counts = { needs_verification: 1, blocked_needs_human: 2, applying: 5, awaiting_approval: 7, dropped_filter: 17733 };
    // Exactly the two manual-action lanes.
    assert.equal(lanes.manualActionCount(counts), 3);
  });

  it('is 0 when neither lane has rows (absent keys)', () => {
    // A GROUP BY omits empty statuses, so both keys are absent.
    assert.equal(lanes.manualActionCount({ applying: 1 }), 0);
  });
});
