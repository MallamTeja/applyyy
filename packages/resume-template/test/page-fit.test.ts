/**
 * applyy — the typography ladder's DENSE rungs (2026-11-08).
 *
 * Two live rows (Tether 04d5c6e4, L&T 7890ff1b) failed the tailor closed: at every content floor
 * Teja set (skills, summary and education never removed; per-entry bullet floors) they were still
 * 12-19% over one page at the old minimum rung. His rule is that layout shrinks before content goes,
 * so the ladder gained denser rungs (tighter leading, gaps, margins and the summary's paragraph
 * margin), never a smaller body font. These tests pin: rung 0 is unchanged, the readable floor holds,
 * and a resume as far over as those two rows now fits. Safety against the real renderer is proven
 * separately, in worker/test/page-fit-calibration.test.ts (real Chromium, both fonts, every rung).
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ResolvedResume } from '@applyy/shared-types';
import { articleOf, fitsOnePage, flowOf, renderResumeHtml, stepStylesheet, TYPOGRAPHY_LADDER } from '../src/index.ts';
import { flowHeight } from '../src/page-fit.ts';
import { zomatoBackendIntern } from './fixtures/zomato-backend-intern.ts';

// The old minimum rung (index 3 before 2026-11-08): the rung the two rows failed at.
const OLD_MINIMUM = 3;

/** The fixture with `extra` long bullets spread over its experience and project entries. */
function grown(extra: number): ResolvedResume {
  // A deep copy per call.
  const resume = structuredClone(zomatoBackendIntern) as unknown as ResolvedResume;
  // Entries that take bullets.
  const targets = [...resume.experience, ...resume.projects];
  // Round-robin.
  for (let i = 0; i < extra; i += 1) {
    // Long and unique per i.
    const text = `Built and operated service number ${i} handling queues, caching, retries and dashboards for several internal teams.`;
    // Appended like any tailored bullet.
    (targets[i % targets.length]!.bullets as { ref: string; text: string; master_text: string }[]).push({ ref: `syn_${i}`, text, master_text: text });
  }
  // The grown resume.
  return resume;
}

/** How far over one page (as a fraction of the usable height) a resume is at a rung. */
function overAt(resume: ResolvedResume, rung: number): number {
  // The rung.
  const step = TYPOGRAPHY_LADDER[rung]!;
  // Usable page height in pt at that rung's margins.
  const page = ((297 - 2 * step.pageMarginMm) * 72) / 25.4;
  // Modelled height over page height, minus one.
  return flowHeight(flowOf(articleOf(renderResumeHtml(resume))), step) / page - 1;
}

test('rung 0 is today\'s stylesheet: no extra CSS, so a resume that fits renders byte-identical', () => {
  // The base parameters, pinned.
  assert.deepEqual(TYPOGRAPHY_LADDER[0], { fontScale: 1, lineHeight: 1.38, gapScale: 1, pageMarginMm: 14, paragraphEm: 1 });
  // And it adds nothing.
  assert.equal(stepStylesheet(0), '');
});

test('the readable floor holds on every rung: body >= 9.5pt, line-height >= 1.15, margin >= 7mm', () => {
  // Each rung.
  for (const step of TYPOGRAPHY_LADDER) {
    // Body text never below 9.5pt (10.5pt x fontScale), the line Teja set.
    assert.ok(10.5 * step.fontScale >= 9.49, `body ${10.5 * step.fontScale}pt`);
    // Leading never below 1.15.
    assert.ok(step.lineHeight >= 1.15, `line-height ${step.lineHeight}`);
    // Page margin never below 7mm (inside the printable area of ordinary printers).
    assert.ok(step.pageMarginMm >= 7, `margin ${step.pageMarginMm}mm`);
  }
});

test('the ladder only gets denser: each rung is no larger than the one before on every axis', () => {
  // Pairs of neighbours.
  for (let i = 1; i < TYPOGRAPHY_LADDER.length; i += 1) {
    // The two.
    const [a, b] = [TYPOGRAPHY_LADDER[i - 1]!, TYPOGRAPHY_LADDER[i]!];
    // Never looser than the rung above it, so "the first rung that fits" is the widest one.
    assert.ok(b.fontScale <= a.fontScale && b.lineHeight <= a.lineHeight && b.gapScale <= a.gapScale && b.pageMarginMm <= a.pageMarginMm && b.paragraphEm <= a.paragraphEm, `rung ${i}`);
  }
});

test('DENSE RUNGS: a resume 12-16% over at the old minimum (the Tether/L&T overflow) now fits one page', () => {
  // The smallest grown fixture that is at least 12% over at the old minimum.
  let n = 0;
  // Bounded search.
  while (n < 200 && overAt(grown(n), OLD_MINIMUM) < 0.12) n += 1;
  // The candidate.
  const resume = grown(n);
  // Precondition, so the test cannot pass vacuously: really 12-16% over at the old minimum.
  const over = overAt(resume, OLD_MINIMUM);
  // In the band the two live rows sat in.
  assert.ok(over >= 0.12 && over < 0.16, `fixture is ${(over * 100).toFixed(1)}% over at the old minimum`);
  // It fits now: content untouched, layout denser.
  assert.equal(fitsOnePage(resume), true);
});

test('a dense rung shrinks the summary paragraph margin too (the browser default 1em is the biggest single gap)', () => {
  // The last rung's CSS.
  const css = stepStylesheet(TYPOGRAPHY_LADDER.length - 1);
  // The summary paragraph rule, at the rung's em.
  assert.match(css, new RegExp(`\\.resume__summary \\{ margin: ${TYPOGRAPHY_LADDER[TYPOGRAPHY_LADDER.length - 1]!.paragraphEm}em 0; \\}`));
  // And the old rungs do not emit it, so their output is unchanged.
  for (let i = 0; i <= OLD_MINIMUM; i += 1) assert.equal(stepStylesheet(i).includes('.resume__summary'), false, `rung ${i}`);
});
