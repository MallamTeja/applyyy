/* Approval page keyword coverage: "not measured" is a state, never "0% Match".
 *
 * Earned 2026-10-06: the GitLab row had selected_jd_keywords '{}' (nothing writes it yet) and
 * the page showed "ATS Match Score 0% Match / 0% verified from master / 100% verified claims".
 * coveragePercent returned 0 for "no keywords" under a comment saying 0 would be wrong.
 *
 * Harness as in webScoutPanel.test.ts (load hook: .tsx transpiled, .css emptied), plus a
 * RESOLVE hook: DiffView.tsx imports extensionless paths, which Vite resolves and Node does
 * not. Kept here rather than editing production imports to suit the test runner.
 * Assertions match markup SHAPE (elements and classes), never a bare "0%" substring. */

import assert from 'node:assert/strict';
import { registerHooks, createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { describe, it, before } from 'node:test';
import { fileURLToPath } from 'node:url';

registerHooks({
  // Extensionless RELATIVE imports only: try the original, then .tsx, then .ts.
  resolve(specifier, context, nextResolve) {
    // Packages and already-extended paths resolve normally.
    if (!specifier.startsWith('.') || /\.[cm]?[jt]sx?$|\.css$/.test(specifier)) return nextResolve(specifier, context);
    // First the way Vite would write it, so a real .js sibling still wins.
    try { return nextResolve(specifier, context); } catch { /* fall through to TS extensions */ }
    // A component is the usual case for an extensionless import here.
    try { return nextResolve(`${specifier}.tsx`, context); } catch { /* then a plain module */ }
    // Last resort; a genuine miss throws from here with the .ts path named.
    return nextResolve(`${specifier}.ts`, context);
  },
  // Same load hook as the other web render tests.
  load(url, context, nextLoad) {
    // Stylesheets have no runtime meaning in Node.
    if (url.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true };
    // Only .tsx needs transpiling; .ts is type-stripped by Node itself.
    if (!url.endsWith('.tsx')) return nextLoad(url, context);
    // apps/web's own typescript, no new dependency.
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

// The pure function under test.
let model: typeof import('../src/features/approval/diffModel.ts');
// The component that renders it.
let view: typeof import('../src/features/approval/DiffView.tsx');
// Static server renderer, no DOM.
let render: (element: unknown) => string;
// Element factory, so no JSX in this .ts file.
let h: typeof import('react').createElement;

before(async () => {
  // Loaded after the hooks so both apply.
  model = await import('../src/features/approval/diffModel.ts');
  view = await import('../src/features/approval/DiffView.tsx');
  render = (await import('react-dom/server')).renderToStaticMarkup as (element: unknown) => string;
  h = (await import('react')).createElement;
});

// KeywordCoverage with n JD keywords, `honest` of them traced and `fab` matched only by flagged claims.
const coverage = (n: number, honest: number, fab = 0) => {
  // Synthetic keywords; names are irrelevant, only the counts are measured.
  const jd = Array.from({ length: n }, (_, i) => `kw${i}`);
  return { jdKeywords: jd, honestlyMatched: jd.slice(0, honest), matchedByFabrication: jd.slice(honest, honest + fab) };
};
// CoverageBar reads only diff.coverage, so a minimal diff is enough.
const bar = (c: ReturnType<typeof coverage>) => render(h(view.CoverageBar, { diff: { coverage: c } as never }));

describe('coveragePercent', () => {
  it('no JD keywords is unmeasured in both modes, never a number', () => {
    // The GitLab row's exact shape: an empty keyword list.
    assert.deepEqual(model.coveragePercent(coverage(0, 0), 'honest'), { kind: 'unmeasured' });
    // The fabrication-inclusive figure shares the denominator, so it is unmeasured too.
    assert.deepEqual(model.coveragePercent(coverage(0, 0), 'withFabrication'), { kind: 'unmeasured' });
  });

  it('7 of 10 is measured at 70, and flagged matches add on top', () => {
    // Honest only.
    assert.deepEqual(model.coveragePercent(coverage(10, 7), 'honest'), { kind: 'measured', percent: 70 });
    // One more keyword matched only by a flagged claim.
    assert.deepEqual(model.coveragePercent(coverage(10, 7, 1), 'withFabrication'), { kind: 'measured', percent: 80 });
  });
});

describe('CoverageBar', () => {
  it("an application with no JD keywords shows 'not measured', never 0%", () => {
    // Rendered from the empty-keywords shape.
    const html = bar(coverage(0, 0));
    // The unmeasured sentence, as its own element.
    assert.match(html, /<p class="coverage__unmeasured">[^<]*not measured/);
    // No bar: a track of any width would state a measurement.
    assert.doesNotMatch(html, /class="coverage__track"/);
    // No score badge, which is where "0% Match" was printed.
    assert.doesNotMatch(html, /class="coverage__ats-badge"/);
    // No legend, which is where "100% verified claims" contradicted it.
    assert.doesNotMatch(html, /class="coverage__legend"/);
  });

  it('a measured 7 of 10 renders the bar at 70% and the badge', () => {
    // A real measurement still renders exactly as before.
    const html = bar(coverage(10, 7));
    // The bar exists.
    assert.match(html, /class="coverage__track"/);
    // The honest segment's width is the measured value.
    assert.match(html, /class="coverage__fill coverage__fill--honest" style="width:70%"/);
    // The badge exists, carrying the number.
    assert.match(html, /<span class="coverage__ats-badge">70% Match<\/span>/);
    // And the unmeasured sentence is absent, so the two states cannot co-render.
    assert.doesNotMatch(html, /class="coverage__unmeasured"/);
  });
});
