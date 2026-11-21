/*
 * The preview frame's paper inset follows the margin the PDF will print at (tailor pending #4,
 * 2026-11-21). The frame padded the sheet with a fixed 14mm, the rung-0 @page margin, but a dense
 * resume prints at a later fit rung whose @page margin is 7-12mm. The frame then wrapped every line
 * 7mm narrower on each side than the PDF, so the preview showed line breaks (and a page length)
 * the submitted PDF does not have.
 */

// Strict asserts: no coercion between the padding string and a number.
import assert from 'node:assert/strict';
// node:test, the runner every apps/web test uses.
import { describe, it } from 'node:test';

// The pure helper under test. It has no React import, so plain Node type stripping loads it.
import { buildResumePreview, zoomedPreviewHtml } from '../src/features/resume-preview/renderPreview.ts';
// The renderer's own ladder and step CSS, so the test builds the exact @page text a dense render carries.
import { stepStylesheet, TYPOGRAPHY_LADDER } from '../../../packages/resume-template/src/index.ts';
// A real resume, for the end-to-end check against the renderer's own output.
import { zomatoBackendIntern } from '../../../packages/resume-template/test/fixtures/zomato-backend-intern.ts';

// The body padding the injected preview style sets, in mm, or undefined when it sets none.
function paddingMm(html: string): number | undefined {
  // The zoom style's body rule, matched by its marker attribute.
  const raw = /<style data-preview-zoom>[^<]*body\{[^}]*padding:([0-9.]+)mm/.exec(html)?.[1];
  // A number only when the shape matched.
  return raw === undefined ? undefined : Number(raw);
}

// A document with the template's base @page rule, then (optionally) a rung's override, as renderResumeHtml emits them.
function docAtRung(index: number): string {
  // The base sheet always declares the rung-0 margin first; the rung CSS follows it and wins.
  return `<html><head><style>@page {\n  size: A4;\n  margin: 14mm;\n}\n${stepStylesheet(index)}</style></head><body></body></html>`;
}

describe('preview paper inset = the printed @page margin', () => {
  // Every rung, so a fix that handles only the default (14mm) cannot pass.
  for (const [index, step] of TYPOGRAPHY_LADDER.entries()) {
    it(`pads the sheet by ${step.pageMarginMm}mm at rung ${index}`, () => {
      // The frame copy of that rung's document.
      const out = zoomedPreviewHtml(docAtRung(index), 0.5);
      // The padding is the rung's own margin, the one the PDF prints with.
      assert.equal(paddingMm(out), step.pageMarginMm);
    });
  }

  it('the densest rung really differs from 14mm (else the loop above proves nothing)', () => {
    // The readable-minimum rung.
    const last = TYPOGRAPHY_LADDER[TYPOGRAPHY_LADDER.length - 1]!;
    // 7mm today; anything but 14 keeps the red-on-revert meaningful.
    assert.notEqual(last.pageMarginMm, 14);
  });

  it('a real render pads by the margin its own @page declares last', () => {
    // The renderer's output for the shared fixture.
    const preview = buildResumePreview(zomatoBackendIntern, 'x');
    // Must render, or the check below is vacuous.
    assert.equal(preview.kind, 'rendered');
    // Narrowed for the compiler.
    if (preview.kind !== 'rendered') return;
    // Every @page margin the document declares, in order; the last one is the one that prints.
    const margins = [...preview.html.matchAll(/@page\s*\{[^}]*?margin:\s*([0-9.]+)mm/g)].map((m) => Number(m[1]));
    // At least the base rule.
    assert.ok(margins.length > 0, 'the render declares no @page margin');
    // The frame pads by exactly that.
    assert.equal(paddingMm(zoomedPreviewHtml(preview.html, 0.5)), margins[margins.length - 1]);
  });
});
