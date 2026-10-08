/* Click-to-edit on the approval page's Tailored column (2026-10-08).
 *
 * The tailored text of an editable line IS the edit trigger (a real <button>), replacing the
 * separate "Edit text" button. These tests pin who gets that button and who gets a reason instead:
 *   editable bullet -> button.line__text-button, runs and provenance unchanged (R1)
 *   skills (D3), D4, removed bullet -> no button, a title saying why
 *   unified view -> read-only, never a text button
 * Harness copied from coverageUnmeasured.test.ts (resolve + load hooks; .tsx transpiled, .css
 * emptied). Assertions match markup SHAPE (elements, classes, attributes), never bare words. */

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

// The component under test.
let view: typeof import('../src/features/approval/DiffView.tsx');
// Static server renderer, no DOM.
let render: (element: unknown) => string;
// Element factory, so no JSX in this .ts file.
let h: typeof import('react').createElement;

before(async () => {
  // Loaded after the hooks so both apply.
  view = await import('../src/features/approval/DiffView.tsx');
  render = (await import('react-dom/server')).renderToStaticMarkup as (element: unknown) => string;
  h = (await import('react')).createElement;
});

// The D4 sentence the page would pass; any non-empty string proves the threading.
const D4_REASON = 'Editing is off: the original tailored resume could not be rebuilt.';

// A DiffLine with sensible defaults; each test overrides only the field it is about.
const line = (over: Record<string, unknown>) => ({
  id: 'line-1',
  kind: 'bullet',
  masterText: 'Built a REST API serving 500 users',
  masterNodeId: 'b-api',
  tailoredRuns: [{ text: 'Built a REST API', verdict: 'traced', tracesTo: 'b-api' }],
  editTarget: { kind: 'bullet', ref: 'b-api' },
  editState: 'original',
  originalText: 'Built a REST API',
  supersededClaims: [],
  ...over,
});

// Renders DiffView around the given lines; onEdit present unless a test says otherwise.
const page = (lines: unknown[], extra: Record<string, unknown> = {}) =>
  render(
    h(view.DiffView, {
      diff: {
        applicationId: 'app-1',
        jobTitle: 'Engineer',
        companyName: 'Acme',
        masterVersion: 1,
        coverage: { jdKeywords: [], honestlyMatched: [], matchedByFabrication: [], matchedByEdit: [] },
        lines,
        unlocatedClaims: [],
        // Derived the same way the adapter does: any non-original line counts.
        editCount: (lines as { editState: string }[]).filter((l) => l.editState !== 'original').length,
      },
      onApprove: () => undefined,
      onReject: () => undefined,
      // A save path exists, so this is an editing screen.
      onEdit: async () => ({ ok: true }),
      ...extra,
    } as never),
  );

// The opening tag of the text button, if any; attributes are matched in it, not across the page.
const textButtonTag = (html: string) => html.match(/<button[^>]*class="line__text-button"[^>]*>/)?.[0];

describe('click-to-edit: the tailored text is the trigger', () => {
  it('an editable edited bullet renders a text button holding its runs, provenance unchanged', () => {
    // Edited by the operator: the strongest R1 case, since "edited by you" must survive the wrap.
    const html = page([
      line({
        tailoredRuns: [{ text: 'Shipped a REST API', verdict: 'edited', tracesTo: null }],
        editState: 'edited',
      }),
    ]);
    // The button exists, as a real button element.
    const tag = textButtonTag(html);
    assert.ok(tag, 'expected a button.line__text-button');
    // Named by its content: no aria-label (it would hide the runs' verdicts), a hidden "Edit: " first.
    assert.ok(!/aria-label=/.test(tag) && html.includes(tag + '<span class="visually-hidden">Edit: </span>'), 'expected no aria-label and a visually-hidden "Edit: " first child');
    // The hover hint.
    assert.match(tag, /title="Click to edit"/);
    // It is a non-submitting button.
    assert.match(tag, /type="button"/);
    // The edited run is INSIDE the button, right after the hidden "Edit: " name prefix, marking intact.
    assert.match(html, /class="line__text-button"[^>]*><span class="visually-hidden">Edit: <\/span><span class="run run--edited">Shipped a REST API/);
    // R1: the footer still says "edited by you"...
    assert.match(html, /<p class="line__provenance line__provenance--edited">edited by you<\/p>/);
    // ...and never "traced" for this line.
    assert.doesNotMatch(html, /line__provenance--traced/);
    // The old duplicate trigger is gone: one tab stop per action.
    assert.doesNotMatch(html, /aria-label="Edit text of /);
  });

  it('an untouched traced bullet keeps its traced run and traced provenance inside/under the button', () => {
    // The tailor's own line, still traceable.
    const html = page([line({})]);
    // The traced run sits inside the button.
    assert.match(html, /class="line__text-button"[^>]*><span class="visually-hidden">Edit: <\/span><span class="run run--traced">Built a REST API/);
    // Provenance still names the master node.
    assert.match(html, /<p class="line__provenance line__provenance--traced">traced to <span class="identifier">b-api<\/span>/);
  });
});

describe('click-to-edit: non-editable lines say why', () => {
  it('a skills line with no target and no page reason has no text button and no title', () => {
    // No target and no D4 reason: since T3 a skills line normally HAS a target, so there is nothing true to claim.
    const html = page([line({ kind: 'skills', editTarget: null, originalText: null, masterNodeId: 's-1' })]);
    // Not clickable.
    assert.equal(textButtonTag(html), undefined);
    // The plain paragraph, with no invented reason on it (positive shape: the exact bare tag).
    assert.match(html, /<p class="line__text line__text--skills">/);
  });

  it('a skills line WITH a skills edit target is still not click-to-type', () => {
    // The T3 skills arm takes selection edits only (R0), so carrying a target must not add a text button.
    const html = page([line({ kind: 'skills', editTarget: { kind: 'skills' }, masterNodeId: 's-1' })]);
    // Not clickable as text.
    assert.equal(textButtonTag(html), undefined);
    // Explains how skills ARE edited now: added from the missing-keyword chips; tabindex="-1" gives
    // focus a home when Remove/Reset unmounts the clicked button (script-focusable, no tab stop).
    assert.match(html, /<p class="line__text line__text--skills" title="Add skills from the missing keywords above" tabindex="-1">/);
  });

  it('a D4 line has the page reason as its title and no text button', () => {
    // D4: every line loses its target and the page passes the reason.
    const html = page([line({ editTarget: null })], { editDisabledReason: D4_REASON });
    // Not clickable.
    assert.equal(textButtonTag(html), undefined);
    // The same sentence the page shows once, now on the line too.
    assert.match(html, new RegExp(`<p class="line__text line__text--bullet" title="${D4_REASON.replace(/[.]/g, '\\.')}">`));
  });

  it('a removed bullet has no text button and the Removed title', () => {
    // Removed by the operator: struck text, Reset brings it back.
    const html = page([line({ tailoredRuns: [], editState: 'removed' })]);
    // Not clickable.
    assert.equal(textButtonTag(html), undefined);
    // The reason, on the struck paragraph, which is also where focus lands if Reset unmounts.
    assert.match(html, /<p class="line__text line__text--bullet line__text--removed" title="Removed\. Use Reset to bring it back\." tabindex="-1">/);
  });

  it('a read-only screen (no onEdit) has neither a text button nor any reason title', () => {
    // Render-only caller: editing is not a feature here, so nothing explains its absence.
    const html = page([line({}), line({ id: 'line-2', kind: 'skills', editTarget: null })], { onEdit: undefined });
    // Not clickable.
    assert.equal(textButtonTag(html), undefined);
    // No paragraph-level title at all.
    assert.doesNotMatch(html, /<p class="line__text[^"]*" title=/);
  });
});

describe('click-to-edit: source shape', () => {
  // The component source, read once for the checks a static render cannot reach.
  const source = readFileSync(new URL('../src/features/approval/DiffView.tsx', import.meta.url), 'utf8');

  it('the unified view stays read-only: its block renders runs but no text button', () => {
    // viewMode is local state starting at 'split', so a static render never reaches unified;
    // the block between its container class and the footer is checked instead.
    const start = source.indexOf('diff__panes--unified');
    // Its end: the actions footer that follows it.
    const end = source.indexOf('<footer className="diff__actions">', start);
    // Both anchors must exist, or this test would pass vacuously.
    assert.ok(start > 0 && end > start, 'unified block anchors not found');
    // The slice under test.
    const unified = source.slice(start, end);
    // Positive shape: it does render runs (so this is the right block).
    assert.match(unified, /<Run key=/);
    // And no clickable text.
    assert.doesNotMatch(unified, /line__text-button/);
  });

  it("the textarea's onKeyDown cancels on Escape", () => {
    // The textarea element, from its opening tag to its self-close.
    const textarea = source.match(/<textarea[\s\S]*?\/>/)?.[0];
    // Must exist, or the next assertion would test nothing.
    assert.ok(textarea, 'textarea not found');
    // Positive shape: an onKeyDown handler that checks Escape and closes the editor.
    assert.match(textarea, /onKeyDown=\{\(e\) => \{[\s\S]*e\.key === 'Escape'[\s\S]*closeEditor\(\)/);
  });
});
