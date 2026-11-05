/* Pipeline drawer: which rows offer "View resume", and the snapshot shape check behind it.
 *
 * The rule under test (Teja, 2026-10-06): any application with a real tailored snapshot, in
 * ANY status, can reopen it later; a row without one offers nothing at all, never a disabled
 * button and never a fallback to the master.
 *
 * Same harness as webScoutPanel.test.ts: a load hook transpiles .tsx with the installed
 * `typescript` and empties .css, and react-dom/server renders with no DOM. Assertions match
 * markup SHAPE (the button element and its class), never bare words from comments. */

import assert from 'node:assert/strict';
import { registerHooks, createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { describe, it, before } from 'node:test';
import { fileURLToPath } from 'node:url';

// Installed before the dynamic imports below, so they see it.
registerHooks({
  // Only .tsx and .css need special handling; everything else loads normally.
  load(url, context, nextLoad) {
    // A stylesheet has no runtime meaning in Node.
    if (url.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true };
    // Plain modules go through the default loader.
    if (!url.endsWith('.tsx')) return nextLoad(url, context);
    // apps/web's own typescript, so no new dependency.
    const ts = createRequire(import.meta.url)('typescript') as typeof import('typescript');
    // nextLoad refuses .tsx, so the source is read directly.
    const source = readFileSync(fileURLToPath(url), 'utf8');
    // react-jsx matches tsconfig, so output imports react/jsx-runtime.
    const out = ts.transpileModule(source, {
      compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    });
    // Plain ESM JavaScript for Node.
    return { format: 'module', source: out.outputText, shortCircuit: true };
  },
});

// Loaded lazily so the hook is active first.
let card: typeof import('../src/features/pipeline/DrawerAppCard.tsx');
// Pure module: no hook needed, but loaded the same way for symmetry.
let snapshot: typeof import('../src/features/pipeline/resumeSnapshot.ts');
// Server renderer, no DOM.
let render: (element: unknown) => string;
// Element factory, so this .ts file needs no JSX.
let h: typeof import('react').createElement;

before(async () => {
  // The card component, transpiled by the hook.
  card = await import('../src/features/pipeline/DrawerAppCard.tsx');
  // The shape check.
  snapshot = await import('../src/features/pipeline/resumeSnapshot.ts');
  // react-dom/server's static renderer.
  render = (await import('react-dom/server')).renderToStaticMarkup as (element: unknown) => string;
  // React's element factory.
  h = (await import('react')).createElement;
});

// The smallest object that passes the shape check; contents are synthetic.
const realSnapshot = () => ({
  schema_version: 1,
  master_version: 3,
  identity: { full_name: 'Ada Placeholder' },
  section_order: ['skills', 'experience'],
  summary: null,
  skills: [],
  experience: [],
  projects: [],
  education: [],
  achievements: [],
  certifications: [],
});

// A drawer row; only `resume` varies between the cases that matter.
const row = (resume: unknown) => ({
  id: '00000000-0000-4000-8000-000000000001',
  role: 'Backend Engineer',
  company: 'Example Co',
  createdAt: '2026-10-06T00:00:00Z',
  discoveredVia: null,
  score: null,
  resume,
});

// The rendered action, matched as a button carrying its class: the code shape, not its label.
const VIEW_BUTTON = /<button[^>]*class="[^"]*\bdrawer__view-resume\b/;

describe('DrawerAppCard', () => {
  it('a row with a tailored snapshot shows View resume; a row without one does not', () => {
    // Passed through the real shape check, as the drawer does.
    const withResume = render(h(card.DrawerAppCard, { app: row(snapshot.readResumeSnapshot(realSnapshot())) as never, onViewResume: () => {} }));
    // Null snapshot: the never-tailored row.
    const withoutResume = render(h(card.DrawerAppCard, { app: row(null) as never, onViewResume: () => {} }));
    // Present exactly where a snapshot exists.
    assert.match(withResume, VIEW_BUTTON);
    // ABSENT, not disabled: no button of that class at all.
    assert.doesNotMatch(withoutResume, VIEW_BUTTON);
    // Non-vacuity: the second card really rendered (its heading is there), so absence is meaningful.
    assert.match(withoutResume, /<h3[^>]*class="drawer__app-role"/);
  });

  // One name per number (2026-11-04): match_score is the master-vs-JD FIT, which the approval queue's
  // chip calls "Fit N · master vs JD". "Match" is the tailored resume's ATS coverage (DiffView's
  // "ATS Match Score"), so the drawer used to give the fit number the other figure's name.
  it('labels the matcher score as fit, worded like the approval chip, never as "Match"', () => {
    // A numeric(5,2) value as PostgREST returns it; the label rounds it as the chip does.
    const html = render(h(card.DrawerAppCard, { app: { ...row(null), score: 72.5 } as never, onViewResume: () => {} }));
    // The chip's exact wording.
    assert.match(html, /Fit 73 · master vs JD/);
    // And not the old, borrowed name.
    assert.doesNotMatch(html, /Match:/);
  });

  /* 2026-11-05: the drawer used to copy the chip's template, so it printed any number it got. It now
     calls the queue's own fitChip, which reads an off-scale value as unknown. */
  it('formats the fit with the queue chip itself, so an off-scale score reads as a dash', () => {
    // Above the matcher's 0..100 scale: not a fit.
    const html = render(h(card.DrawerAppCard, { app: { ...row(null), score: 150 } as never, onViewResume: () => {} }));
    // The chip's unknown wording.
    assert.match(html, /Fit —/);
    // Non-vacuity: the card really rendered.
    assert.match(html, /<h3[^>]*class="drawer__app-role"/);
  });
});

describe('readResumeSnapshot', () => {
  it('accepts a real snapshot and returns it unchanged', () => {
    // The same object back, not a copy or a default.
    const value = realSnapshot();
    assert.equal(snapshot.readResumeSnapshot(value), value);
  });

  it('refuses everything that is not a pinned ResolvedResume', () => {
    // Each case names itself in the failure message.
    const cases: Array<[string, unknown]> = [
      ['null (never tailored)', null],
      ['empty object (malformed write)', {}],
      ['array', []],
      ['string', 'resume'],
      ['wrong schema_version', { ...realSnapshot(), schema_version: 2 }],
      ['missing master_version (cannot pin the master)', { ...realSnapshot(), master_version: undefined }],
      ['fractional master_version', { ...realSnapshot(), master_version: 1.5 }],
      ['null identity', { ...realSnapshot(), identity: null }],
      ['experience not an array', { ...realSnapshot(), experience: {} }],
    ];
    // Every one must come back null, never a partially-trusted object.
    for (const [name, value] of cases) assert.equal(snapshot.readResumeSnapshot(value), null, name);
  });
});
