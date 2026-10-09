/* Every per-pane control in the resume preview names its pane (task C item 5a, 2026-10-09).
 *
 * The tailored and master panes sit side by side with identical controls. Before this, both had
 * "Zoom in", "Zoom out", "Download PDF" ... so a screen-reader user hearing the control list
 * could not tell which resume a button acts on. Contract in ResumePreview.tsx's ResumePane: each
 * accessible name ends with the pane heading:
 *   group  `Preview zoom, ${heading}`
 *   button `Zoom out, ${heading}` / `Zoom in, ${heading}` / `Fit page width, now N%, ${heading}`
 *   button `Download PDF, ${heading}` / `Download HTML, ${heading}`
 *
 * Rendered, not read as source: renderToStaticMarkup through the real component. ResumePane is
 * module-private and the master pane only renders after a Supabase read (no DB in a unit test),
 * so the load hook below appends ONE test-only line to the transpiled ResumePreview.tsx,
 * `export { ResumePane };`. Nothing else in the module changes, and src/ is untouched on disk.
 * The public ResumePreview is also rendered, to prove the real entry passes its heading through. */

import assert from 'node:assert/strict';
import { registerHooks, createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { describe, it, before } from 'node:test';
import { fileURLToPath } from 'node:url';

// Same harness as resumePreviewZoom.test.ts, plus the one-line export seam for ResumePane.
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
    }).outputText;
    // The seam: only this one module gains an export of its private pane component.
    const seam = url.endsWith('/resume-preview/ResumePreview.tsx') ? '\nexport { ResumePane };\n' : '';
    // Plain ESM for Node.
    return { format: 'module', source: out + seam, shortCircuit: true };
  },
});

// The pure helpers: the zoom default and the preview builder.
let pure: typeof import('../src/features/resume-preview/renderPreview.ts');
// The component module, with ResumePane exposed by the seam (typed loosely: it is not in the .d.ts).
let view: Record<string, any>;
// Static server renderer, no DOM.
let render: (element: unknown) => string;
// Element factory, so this .ts file needs no JSX.
let h: typeof import('react').createElement;
// A real resume from the template's own fixtures.
let resume: typeof import('../../../packages/resume-template/test/fixtures/zomato-backend-intern.ts').zomatoBackendIntern;

before(async () => {
  // Loaded after the hooks so both apply.
  pure = await import('../src/features/resume-preview/renderPreview.ts');
  // Same.
  view = await import('../src/features/resume-preview/ResumePreview.tsx');
  // React's server renderer.
  render = (await import('react-dom/server')).renderToStaticMarkup as (element: unknown) => string;
  // createElement.
  h = (await import('react')).createElement;
  // Fixture resume.
  resume = (await import('../../../packages/resume-template/test/fixtures/zomato-backend-intern.ts')).zomatoBackendIntern;
});

// The two headings ResumePreview gives its panes for company "Zomato" and master version 2.
const TAILORED = 'Tailored for Zomato';
// Same, for the master pane.
const MASTER = 'Master v2';

// Every aria-label in a markup string, unescaped the way a screen reader would hear it.
const ariaLabels = (markup: string): string[] =>
  // Attribute values are double-quoted by React; & and " are the escapes that matter here.
  [...markup.matchAll(/aria-label="([^"]*)"/g)].map((m) => m[1]!.replaceAll('&quot;', '"').replaceAll('&amp;', '&'));

// The six names the contract requires for one pane, given its heading and the shown zoom.
const expectedFor = (heading: string, percent: number): string[] => [
  // The zoom group.
  `Preview zoom, ${heading}`,
  // Smaller.
  `Zoom out, ${heading}`,
  // Fit, carrying the current percentage.
  `Fit page width, now ${percent}%, ${heading}`,
  // Larger.
  `Zoom in, ${heading}`,
  // Print-to-PDF.
  `Download PDF, ${heading}`,
  // Raw HTML.
  `Download HTML, ${heading}`,
];

// One pane rendered by itself, so its labels cannot mix with the other pane's.
const paneMarkup = (heading: string): string => {
  // The component the seam exposed; absent means the seam or the component name changed.
  assert.equal(typeof view.ResumePane, 'function', 'ResumePane not found in ResumePreview.tsx');
  // A rendered preview, as the real parent builds it.
  const preview = pure.buildResumePreview(resume as never, `Resume ${heading}`);
  // Precondition: a refused render shows no controls, which would make every check vacuous.
  assert.equal(preview.kind, 'rendered', 'fixture must render, or the pane shows no controls');
  // The pane with its heading.
  return render(h(view.ResumePane, { heading, frameTitle: `Frame ${heading}`, fileStem: `stem-${heading}`, preview }));
};

// The fit button shows the pre-measurement default zoom in a static render.
const percent = () => Math.round(pure.DEFAULT_PREVIEW_ZOOM * 100);

describe('ResumePane: every control names its pane', () => {
  // Both panes, each checked the same way.
  for (const heading of [TAILORED, MASTER]) {
    it(`the "${heading}" pane carries each of the six names exactly once`, () => {
      // This pane's labels.
      const labels = ariaLabels(paneMarkup(heading));
      // Each required name appears once: zero means unnamed, two means a duplicate control.
      for (const name of expectedFor(heading, percent())) {
        // Counted, so the failure says how many were found.
        assert.equal(labels.filter((l) => l === name).length, 1, `"${name}" in ${JSON.stringify(labels)}`);
      }
    });

    it(`the "${heading}" pane has no aria-label without its heading`, () => {
      // Any name that would collide with the other pane's.
      const unnamed = ariaLabels(paneMarkup(heading)).filter((l) => !l.endsWith(`, ${heading}`));
      // Positive shape: every label ends with ", <heading>", so none is shared.
      assert.deepEqual(unnamed, []);
    });
  }

  it('the tailored and master panes share no accessible name', () => {
    // Tailored names.
    const tailored = new Set(ariaLabels(paneMarkup(TAILORED)));
    // Master names.
    const master = ariaLabels(paneMarkup(MASTER));
    // Non-vacuous: both panes really expose the six controls.
    assert.ok(tailored.size >= 6 && master.length >= 6, `tailored ${tailored.size}, master ${master.length}`);
    // Disjoint: no name a screen reader would read identically for both panes.
    assert.deepEqual(master.filter((l) => tailored.has(l)), []);
  });

  it('the public ResumePreview passes "Tailored for <company>" through to the tailored pane', () => {
    // The component exactly as the approval page mounts it (the master pane is still loading).
    const markup = render(h(view.ResumePreview, {
      applicationId: 'a1', tailoredProfile: resume as never, masterVersion: 2, jobTitle: 'Backend Intern', companyName: 'Zomato',
    }));
    // The tailored pane's names, through the real parent rather than the seam.
    const labels = ariaLabels(markup);
    // All six, once each.
    for (const name of expectedFor(TAILORED, percent())) {
      // Counted for a precise failure message.
      assert.equal(labels.filter((l) => l === name).length, 1, `"${name}" in ${JSON.stringify(labels)}`);
    }
  });
});
