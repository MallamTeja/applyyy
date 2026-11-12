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
// The one-skill-group-one-line helpers (2026-11-12).
import { fillSkillLine, skillGroupFitsOneLine, skillGroupLineCount } from '../src/index.ts';
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
  // And the old rungs emit no summary MARGIN rule (since 2026-11-11 every rung > 0 sets the summary's font-size, so match the margin rule only).
  for (let i = 0; i <= OLD_MINIMUM; i += 1) assert.equal(stepStylesheet(i).includes('.resume__summary { margin'), false, `rung ${i}`);
});

/*
 * THE TWO-COLUMN SPLIT (Teja, 2026-11-08): achievements and certifications may print side by side
 * in one `<div class="resume__split">` (flex, 5mm gap, two equal columns). The model must read that
 * block as max(column heights at half width), never as the two sections stacked at full width:
 * a half-width column wraps MORE, so the stacked reading can be the optimistic one. The markup below
 * is hand-built from the renderer's contract, so these tests do not depend on renderResumeHtml.
 */

// One millimetre in points, the same conversion the stylesheet's mm values go through.
const MM_PT = 72 / 25.4;
// A4 width in points: the paper @page declares.
const A4_W_PT = 595.276;

/** One column's width at a rung: (content width - the fixed 5mm flex gap) / 2. An independent oracle, not the model's own helper. */
function halfWidth(rung: number): number {
  // The rung's page margin decides the content width.
  const step = TYPOGRAPHY_LADDER[rung]!;
  // Content width between the @page margins, minus the gap, halved.
  return (A4_W_PT - 2 * step.pageMarginMm * MM_PT - 5 * MM_PT) / 2;
}

/** An undated entry exactly as renderUndatedEntry emits it: head, detail line, link line, bullets. */
function undatedEntry(i: number, bullets: number): string {
  // Long bullets so a half-width column visibly wraps more than a full-width one.
  const items = Array.from({ length: bullets }, (_, b) => `<li class="resume__bullet" data-ref="b_${i}_${b}">Led a team of engineers building distributed ingestion, caching and observability for item ${i} bullet ${b} across regions.</li>`).join('\n');
  // The entry, with the nested entry-head div that a first-`</div>` leaf scan would cut short.
  return `<div class="resume__entry" data-ref="e_${i}">
<div class="resume__entry-head">
<h3 class="resume__entry-title">Award or certificate number ${i} with a fairly long label</h3>
</div>
<div class="resume__entry-detail">issuer ${i}</div>
<div class="resume__entry-subtitle"><a href="https://example.com/${i}">Credential</a><span class="resume__link-sep">•</span><a href="https://example.com/p/${i}">Profile</a></div>
${bullets === 0 ? '' : `<ul class="resume__bullets">\n${items}\n</ul>`}
</div>`;
}

/** A section of `entries` undated entries, each with `bullets` bullets. */
function undatedSection(kind: string, entries: number, bullets: number): string {
  // The section wrapper and title, as wrapSection emits them.
  return `<section class="resume__section" data-section="${kind}">
<h2 class="resume__section-title">${kind}</h2>
${Array.from({ length: entries }, (_, i) => undatedEntry(i, bullets)).join('\n')}
</section>`;
}

/** The split block per the contract: left = achievements, right = certifications. */
function split(left: string, right: string): string {
  // The flex wrapper around exactly two sections.
  return `<div class="resume__split">\n${left}\n${right}\n</div>`;
}

/** Wrapped in the article the scan expects (the article is a container, so its close adds nothing). */
function article(body: string): string {
  // Same open tag as the renderer.
  return `<article class="resume">\n${body}\n</article>`;
}

test('SPLIT: a long left column is measured at HALF width: the block is at least the left column alone at half width, which exceeds it at full width', () => {
  // A long left column and a short right one.
  const left = undatedSection('achievements', 4, 3);
  // One short certification.
  const right = undatedSection('certifications', 1, 0);
  // Every rung, because the column width changes with the page margin.
  for (let rung = 0; rung < TYPOGRAPHY_LADDER.length; rung += 1) {
    // The rung.
    const step = TYPOGRAPHY_LADDER[rung]!;
    // The modelled height of the whole split block.
    const block = flowHeight(flowOf(article(split(left, right))), step);
    // The left section alone, at half width, in the split's own smaller type (inSplit = true, 2026-11-11).
    const leftHalf = flowHeight(flowOf(article(left), true), step, halfWidth(rung));
    // The left section alone, at full width (the default width), same type.
    const leftFull = flowHeight(flowOf(article(left), true), step);
    // Precondition (non-vacuity): half width really wraps more, else the test proves nothing.
    assert.ok(leftHalf > leftFull, `rung ${rung}: half ${leftHalf} vs full ${leftFull}`);
    // The property: the block is never shorter than its longer column.
    assert.ok(block >= leftHalf, `rung ${rung}: split ${block.toFixed(1)}pt < left column at half width ${leftHalf.toFixed(1)}pt`);
  }
});

test('SPLIT: never lower than the max of each column modelled alone at half width (generated sizes, every rung)', () => {
  // Small grid of left/right sizes: entries x bullets per side.
  const sizes = [[1, 0], [2, 1], [3, 2], [1, 4], [5, 3]] as const;
  // Every pairing, so both "left taller" and "right taller" occur.
  for (const [le, lb] of sizes) {
    // Right side sizes.
    for (const [re, rb] of sizes) {
      // The two sections.
      const left = undatedSection('achievements', le, lb);
      // Right one.
      const right = undatedSection('certifications', re, rb);
      // Each rung.
      for (let rung = 0; rung < TYPOGRAPHY_LADDER.length; rung += 1) {
        // The rung.
        const step = TYPOGRAPHY_LADDER[rung]!;
        // The block as the model reads it.
        const block = flowHeight(flowOf(article(split(left, right))), step);
        // Each column alone at half width, in the split's smaller type (inSplit = true, 2026-11-11).
        const hL = flowHeight(flowOf(article(left), true), step, halfWidth(rung));
        // Same, right.
        const hR = flowHeight(flowOf(article(right), true), step, halfWidth(rung));
        // Never optimistic.
        assert.ok(block >= Math.max(hL, hR), `L${le}x${lb} R${re}x${rb} rung ${rung}: ${block} < max(${hL}, ${hR})`);
      }
    }
  }
});

test('SPLIT: the nested <div>s inside the split are not mis-parsed: one columns item, every entry head counted in its column', () => {
  // Three achievements, two certifications.
  const flow = flowOf(article(split(undatedSection('achievements', 3, 2), undatedSection('certifications', 2, 1))));
  // The whole block is ONE flow item, not a flattened leaf or a stacked run.
  const blocks = flow.filter((item) => item.kind === 'columns');
  // Exactly one.
  assert.equal(blocks.length, 1, `flow kinds: ${flow.map((i) => i.kind).join(',')}`);
  // Nothing outside it: the article holds only the split.
  assert.equal(flow.length, 1, `flow kinds: ${flow.map((i) => i.kind).join(',')}`);
  // Narrowed for the type checker.
  const block = blocks[0] as { kind: 'columns'; columns: readonly (readonly { kind: string }[])[] };
  // Two columns, in DOM order.
  assert.equal(block.columns.length, 2);
  // Every entry head is in its column: 3 left, 2 right.
  assert.deepEqual(block.columns.map((col) => col.filter((i) => i.kind === 'head').length), [3, 2]);
});


// ---- ONE SKILL GROUP = ONE LINE (Teja, 2026-11-12 13:57) ----------------------------------------------------
// The shared width model the tailor and resume-assist fill groups with. Chromium-checked the same day on all 11
// live v41 groups at rungs 0 and 5: every filled group printed on one line, and one more name wrapped (or the cap hit).

// Live v41 Testing & Quality, master order.
const TESTING = ['Code review', 'JUnit', 'pytest', 'Testing', 'Debugging & Troubleshooting', 'Integration Testing', 'API Testing', 'Unit Testing', 'Playwright Testing'];

test('skill line: a short group is one line, the whole 9-name Testing group is two', () => {
  // Three names: one line at every rung.
  assert.equal(skillGroupFitsOneLine('Languages', ['Python', 'SQL', 'Java']), true);
  // All nine Testing names: more than one line at the default rung.
  assert.ok(skillGroupLineCount('Testing & Quality', TESTING, 0) >= 2, 'nine Testing names modelled as one line');
  // And so not one line.
  assert.equal(skillGroupFitsOneLine('Testing & Quality', TESTING), false);
});

test('skill line: fillSkillLine keeps rank order, skips a name that would wrap, takes a later one that fits, stops at the cap', () => {
  // The filled Testing line.
  const line = fillSkillLine('Testing & Quality', TESTING, 7);
  // One line, under the cap.
  assert.ok(skillGroupFitsOneLine('Testing & Quality', line) && line.length <= 7, `bad line: ${line.join(', ')}`);
  // A subsequence of the ranked input: the order is the caller's relevance order, untouched.
  assert.deepEqual(line, TESTING.filter((n) => line.includes(n)));
  // FULL: nothing left out would still fit.
  assert.ok(TESTING.filter((n) => !line.includes(n)).every((n) => !skillGroupFitsOneLine('Testing & Quality', [...line, n])), 'room left on the line');
  // The cap: nine one-letter names fit a line but stop at 7.
  assert.equal(fillSkillLine('Languages', ['C', 'R', 'D', 'F', 'J', 'K', 'Q', 'V', 'Z'], 7).length, 7);
});

test('skill line: the label is measured bold, so a long label leaves less room than a short one', () => {
  // The same names under a short and a long label.
  const names = TESTING.slice(0, 5);
  // The long label never seats more than the short one.
  assert.ok(fillSkillLine('Testing, Quality Assurance & Reliability Engineering', names, 7).length <= fillSkillLine('QA', names, 7).length);
});
