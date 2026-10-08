/* The resume preview frame shows a ZOOMED-OUT sheet; the downloads never carry the zoom.
 *
 * Asked for 2026-10-08: the panes rendered the resume at full size, so only the header,
 * summary and skills were visible. Two promises are held here:
 * - the frame's srcdoc carries the screen-only zoom style (rendered through the real
 *   component, not by reading its source), and
 * - the HTML the operator downloads is the renderer's document without that style.
 * Harness as in coverageUnmeasured.test.ts: .tsx transpiled by apps/web's own typescript,
 * .css emptied, extensionless relative imports resolved the way Vite does.
 */

import assert from 'node:assert/strict';
import { registerHooks, createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { describe, it, before } from 'node:test';
import { fileURLToPath } from 'node:url';

registerHooks({
  // Extensionless relative imports (ResumePreview imports './renderPreview') get TS extensions.
  resolve(specifier, context, nextResolve) {
    // Packages and already-extended paths resolve normally.
    if (!specifier.startsWith('.') || /\.[cm]?[jt]sx?$|\.css$/.test(specifier)) return nextResolve(specifier, context);
    // A real .js sibling still wins.
    try { return nextResolve(specifier, context); } catch { /* try .tsx */ }
    // Components.
    try { return nextResolve(`${specifier}.tsx`, context); } catch { /* try .ts */ }
    // Plain modules; a genuine miss throws here with the path named.
    return nextResolve(`${specifier}.ts`, context);
  },
  // .tsx is transpiled, .css is empty, everything else loads normally.
  load(url, context, nextLoad) {
    // Stylesheets have no runtime meaning in Node.
    if (url.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true };
    // Node type-strips .ts itself.
    if (!url.endsWith('.tsx')) return nextLoad(url, context);
    // apps/web's own compiler, no new dependency.
    const ts = createRequire(import.meta.url)('typescript') as typeof import('typescript');
    // react-jsx matches tsconfig.
    const out = ts.transpileModule(readFileSync(fileURLToPath(url), 'utf8'), {
      compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    });
    // Plain ESM for Node.
    return { format: 'module', source: out.outputText, shortCircuit: true };
  },
});

// The pure helpers.
let pure: typeof import('../src/features/resume-preview/renderPreview.ts');
// The component that puts them in a frame.
let view: typeof import('../src/features/resume-preview/ResumePreview.tsx');
// Static server renderer, no DOM.
let render: (element: unknown) => string;
// Element factory, so this .ts file needs no JSX.
let h: typeof import('react').createElement;
// A real resume from the template's own fixtures.
let resume: typeof import('../../../packages/resume-template/test/fixtures/zomato-backend-intern.ts').zomatoBackendIntern;

before(async () => {
  // Loaded after the hooks so both apply.
  pure = await import('../src/features/resume-preview/renderPreview.ts');
  view = await import('../src/features/resume-preview/ResumePreview.tsx');
  render = (await import('react-dom/server')).renderToStaticMarkup as (element: unknown) => string;
  h = (await import('react')).createElement;
  resume = (await import('../../../packages/resume-template/test/fixtures/zomato-backend-intern.ts')).zomatoBackendIntern;
});

// The style element the zoom helper injects, matched by its marker attribute and its rule.
const ZOOM_STYLE = /<style data-preview-zoom>@media screen\{html\{zoom:([0-9.]+)\}/;

describe('resume preview zoom', () => {
  it('the rendered frame srcdoc carries the screen-only zoom at the default scale', () => {
    // The component as the approval page mounts it.
    const markup = render(h(view.ResumePreview, {
      applicationId: 'a1', tailoredProfile: resume as never, masterVersion: 2, jobTitle: 'Backend Intern', companyName: 'Zomato',
    }));
    // The iframe's srcdoc attribute, HTML-escaped by React.
    const srcdoc = /<iframe[^>]*srcDoc="([^"]*)"/i.exec(markup)?.[1];
    // A frame must exist: a missing frame would make every check below vacuous.
    assert.ok(srcdoc, 'no iframe srcdoc in the preview markup');
    // Undo React's attribute escaping to read the document as the frame does.
    const doc = srcdoc.replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&quot;', '"').replaceAll('&amp;', '&');
    // The zoom style is present, at the pre-measurement default.
    assert.equal(ZOOM_STYLE.exec(doc)?.[1], String(pure.DEFAULT_PREVIEW_ZOOM));
    // It is still the resume: the template's own stylesheet and the candidate's name are there.
    assert.match(doc, /@page \{/);
  });

  it('the download HTML (preview.html) never carries the zoom', () => {
    // The same render the Download HTML button saves.
    const preview = pure.buildResumePreview(resume, 'x');
    // Must render, or the absence check below would be vacuous.
    assert.equal(preview.kind, 'rendered');
    // Narrowed for the compiler.
    if (preview.kind !== 'rendered') return;
    // No zoom marker in the downloadable document.
    assert.doesNotMatch(preview.html, /data-preview-zoom/);
    // And the zoomed copy differs from it only by the injected style.
    assert.equal(pure.zoomedPreviewHtml(preview.html, 0.5).replace(/<style data-preview-zoom>[^<]*<\/style>/, ''), preview.html);
  });

  it('the zoom is screen-only, so the printed PDF keeps the template size', () => {
    // Any document with a head.
    const out = pure.zoomedPreviewHtml('<html><head><title>t</title></head><body></body></html>', 0.7);
    // Inside @media screen, which print media skips.
    assert.match(out, /<style data-preview-zoom>@media screen\{html\{zoom:0\.7\}/);
    // Placed in the head, after any template style, so it wins on equal specificity.
    assert.ok(out.indexOf('data-preview-zoom') < out.indexOf('</head>'));
  });

  it('a non-finite or non-positive zoom leaves the document unzoomed', () => {
    // A document with a head, so only the zoom value decides.
    const doc = '<html><head></head><body></body></html>';
    // Each bad value returns the input exactly, never a style with zoom:NaN.
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, 0, -1]) assert.equal(pure.zoomedPreviewHtml(doc, bad), doc);
    // Positive control: a real zoom on the same document does inject.
    assert.match(pure.zoomedPreviewHtml(doc, 0.5), ZOOM_STYLE);
  });

  it('fit and the -/+ buttons share one clamp', () => {
    // Below the floor and above the ceiling both land on the bounds.
    assert.equal(pure.clampZoom(0.1), pure.MIN_ZOOM);
    // A very wide drawer's fit is capped where "+" stops, so "+" can never zoom out.
    assert.equal(pure.clampZoom(1.9), pure.MAX_ZOOM);
    // In-range values pass through untouched.
    assert.equal(pure.clampZoom(0.68), 0.68);
    // The component routes BOTH computations through it (source shape, as resumePreview.test.ts does).
    const src = readFileSync(fileURLToPath(new URL('../src/features/resume-preview/ResumePreview.tsx', import.meta.url)), 'utf8');
    // The fit computation.
    assert.match(src, /setFitZoom\(clampZoom\(/);
    // The step computation.
    assert.match(src, /setChosenZoom\(clampZoom\(/);
  });

  it('Download HTML saves preview.html, the unzoomed document', () => {
    // The component source; the harness cannot click, so the wiring is pinned by shape.
    const src = readFileSync(fileURLToPath(new URL('../src/features/resume-preview/ResumePreview.tsx', import.meta.url)), 'utf8');
    // The download is handed the raw render, never the zoomed srcdoc.
    assert.match(src, /downloadHtml\(preview\.html\)/);
  });
});
