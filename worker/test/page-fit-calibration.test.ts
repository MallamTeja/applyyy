// THE PROOF that the one-page MODEL never says "fits" when the real PDF is two pages.
//
// @applyy/resume-template page-fit.ts estimates the printed height of a resume from its
// markup, because the Deno tailor cannot lay out HTML. An estimate is only allowed to gate
// the one-page rule if it is held to the real renderer, and this file is that hold: it
// renders a ladder of resumes, from short to well over a page, at EVERY typography step,
// under BOTH fonts the stylesheet can resolve to (Georgia, and Times New Roman whose metrics
// Liberation Serif copies on the Linux runner), through Chromium's page.pdf(), and asserts:
//   model says fits at step k  ==>  the real PDF is exactly one page at step k.
// It lives in the worker because the worker owns page.pdf() and already runs real Chromium in CI.
//
// Calibrated 2026-11-07 against the 19 live awaiting_approval/approved rows too (not committed:
// they hold Teja's personal data): model/real height 0.996..1.057 over 152 renders, 0 unsafe.
import { afterAll, beforeAll, expect, test } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import type { ResolvedResume } from '@applyy/shared-types';
import {
  articleOf,
  fitsOnePage,
  flowFits,
  flowOf,
  renderResumeHtml,
  RESUME_STYLESHEET,
  stepStylesheet,
  TYPOGRAPHY_LADDER,
} from '@applyy/resume-template';
// The template package's own committed fixture: synthetic data, no real person.
import { zomatoBackendIntern } from '../../packages/resume-template/test/fixtures/zomato-backend-intern.ts';
import { countPdfPages, renderResumePdf, ResumeNotOnePageError } from '../src/render-resume-pdf.ts';

// One browser for the file: a launch is ~0.5 s and this renders ~90 PDFs.
let browser: Browser;
// One page, reused, as the worker's own renderer does.
let page: Page;

beforeAll(async () => {
  // Headless Chromium, the engine the worker submits with.
  browser = await chromium.launch();
  // The page every render below goes through.
  page = await browser.newPage();
});

afterAll(async () => {
  // Closed even when a test failed, so the run does not hang on a live browser.
  await browser?.close();
});

// Words for synthetic bullets: ordinary resume vocabulary, mixed lengths, a few long tokens.
const WORDS = 'built shipped designed reduced latency across distributed services using TypeScript PostgreSQL Redis Kubernetes pipelines improved throughput by percent for internal dashboards observability automated deployment workflows microservice architecture authentication caching layer migrated legacy monolith event-driven queues tested end-to-end'.split(' ');

/** A deterministic bullet of 18..37 words: the same text on every machine and every run. */
function syntheticBullet(seed: number): string {
  // A small LCG: deterministic, no dependency, good enough to vary word choice.
  let x = seed * 7919 + 17;
  // Word count from the seed, so bullets wrap to different line counts.
  const count = 18 + (seed % 20);
  // The words, in order.
  const words: string[] = [];
  // Drawn one at a time.
  for (let i = 0; i < count; i += 1) {
    // Next state.
    x = (x * 1103515245 + 12345) % 2147483648;
    // A word from the vocabulary.
    words.push(WORDS[x % WORDS.length]!);
  }
  // A sentence.
  return `${words.join(' ')}.`;
}

/** The fixture with `extra` synthetic bullets spread over its experience and project entries. */
function grown(extra: number): ResolvedResume {
  // A deep copy, so one size never leaks into the next.
  const resume = structuredClone(zomatoBackendIntern) as unknown as ResolvedResume;
  // The entries that take bullets.
  const targets = [...resume.experience, ...resume.projects];
  // Round-robin, so every entry grows.
  for (let i = 0; i < extra; i += 1) {
    // The entry this bullet joins.
    const entry = targets[i % targets.length]!;
    // Text from the seed; ref unique per bullet.
    const text = syntheticBullet(i + 1);
    // Appended like any tailored bullet.
    (entry.bullets as { ref: string; text: string; master_text: string }[]).push({ ref: `syn_${i}`, text, master_text: text });
  }
  // The grown resume.
  return resume;
}

/**
 * The fixture with `extra` synthetic achievements and certifications, alternating, so BOTH columns of the
 * .resume__split row grow (Teja, 2026-11-08: those two sections print side by side). Long labels, a detail
 * line, a link line and bullets, so each half-width column wraps hard: the axis the split model must hold on.
 */
function grownSplit(extra: number): ResolvedResume {
  // A deep copy, so one size never leaks into the next.
  const resume = structuredClone(zomatoBackendIntern) as unknown as ResolvedResume;
  // Writable views of the two lists the split holds.
  const lists = [resume.achievements, resume.certifications] as unknown as { ref: string; label: string; description: string | null; bullets: { ref: string; text: string; master_text: string }[]; links?: { id: string; label: string; url: string }[] }[][];
  // Alternate left and right, so neither column is always the tall one.
  for (let i = 0; i < extra; i += 1) {
    // Bullets 0..2 by seed, so entries differ in height.
    const bullets = Array.from({ length: i % 3 }, (_, b) => { const text = syntheticBullet(i * 3 + b + 101); return { ref: `spb_${i}_${b}`, text, master_text: text }; });
    // A long label: a half-width column wraps it to two or three lines.
    lists[i % 2]!.push({ ref: `spl_${i}`, label: `Recognised award or professional certificate number ${i} in distributed systems engineering`, description: `issued by an independent body, cohort ${i}`, bullets, links: [{ id: `lnk_${i}_a`, label: 'Credential', url: `https://example.com/c/${i}` }, { id: `lnk_${i}_b`, label: 'Verify', url: `https://example.com/v/${i}` }] });
  }
  // The grown resume.
  return resume;
}

// The Times override: what a machine without Georgia resolves (Liberation Serif has its metrics).
const TIMES = "body{font-family:'Times New Roman','Liberation Serif',serif !important}";

/** Real page count of a resume forced to one step and one font. */
async function realPages(resume: ResolvedResume, step: number, fontCss: string): Promise<number> {
  // The renderer's own document, with its style block replaced by the forced step (+ font).
  const html = renderResumeHtml(resume).replace(/<style>[\s\S]*<\/style>/, () => `<style>${RESUME_STYLESHEET}${stepStylesheet(step)}${fontCss}</style>`);
  // Same call the worker makes.
  await page.setContent(html, { waitUntil: 'domcontentloaded' });
  // Same options as renderResumePdf.
  const pdf = await page.pdf({ format: 'A4', margin: { top: '0', right: '0', bottom: '0', left: '0' }, printBackground: true, displayHeaderFooter: false });
  // Counted by pdf.js.
  return countPdfPages(new Uint8Array(pdf));
}

// The ladder of sizes: 0 extra bullets (well under a page) to 36 (well over, even at the minimum).
const SIZES = [0, 4, 8, 12, 16, 20, 24, 28, 32, 36];

/** Every size of one growth axis, at every rung and both fonts: the unsafe verdicts and the two non-vacuity counts. */
async function sweep(sizes: readonly number[], grow: (extra: number) => ResolvedResume): Promise<{ unsafe: string[]; fitsChecked: number; overflowsSeen: number }> {
  // Every unsafe case, collected so one failure names them all.
  const unsafe: string[] = [];
  // How many "fits" verdicts were actually checked, so the assertion cannot pass vacuously.
  let fitsChecked = 0;
  // How many cases the real PDF overflowed, same reason.
  let overflowsSeen = 0;
  // Each size.
  for (const extra of sizes) {
    // The resume and its flow (the model reads the markup once).
    const resume = grow(extra);
    // The modelled flow.
    const flow = flowOf(articleOf(renderResumeHtml(resume)));
    // Each rung.
    for (let step = 0; step < TYPOGRAPHY_LADDER.length; step += 1) {
      // Each font.
      for (const font of ['', TIMES]) {
        // The real count.
        const pages = await realPages(resume, step, font);
        // Overflow seen.
        if (pages > 1) overflowsSeen += 1;
        // Only "fits" verdicts carry the safety property.
        if (!flowFits(flow, TYPOGRAPHY_LADDER[step]!)) continue;
        // Counted.
        fitsChecked += 1;
        // The property.
        if (pages !== 1) unsafe.push(`extra=${extra} step=${step} font=${font === '' ? 'Georgia' : 'Times'} pages=${pages}`);
      }
    }
  }
  // Handed to the axis's test.
  return { unsafe, fitsChecked, overflowsSeen };
}

test('the model never says fits when the real PDF is two pages (every step, both fonts)', async () => {
  // The bullet axis: experience and projects grow.
  const { unsafe, fitsChecked, overflowsSeen } = await sweep(SIZES, grown);
  // No unsafe verdict.
  expect(unsafe).toEqual([]);
  // The ladder really crossed the boundary in both directions.
  expect(fitsChecked).toBeGreaterThan(10);
  // Same, the overflowing side.
  expect(overflowsSeen).toBeGreaterThan(10);
}, 240_000);

// The split axis: 0 extra achievements/certifications (under a page) to 30 (over, even at the minimum).
const SPLIT_SIZES = [0, 4, 8, 12, 16, 20, 24, 30];

test('SPLIT AXIS: the model never says fits when the real PDF is two pages as achievements + certifications grow side by side', async () => {
  // Precondition: the renderer really emits the split row, or this axis exercises nothing new.
  expect(renderResumeHtml(grownSplit(SPLIT_SIZES[1]!))).toContain('<div class="resume__split">');
  // The split axis.
  const { unsafe, fitsChecked, overflowsSeen } = await sweep(SPLIT_SIZES, grownSplit);
  // No unsafe verdict: a two-column model that is optimistic would show up here as a two-page PDF.
  expect(unsafe).toEqual([]);
  // The axis crossed the boundary from the fitting side.
  expect(fitsChecked).toBeGreaterThan(10);
  // And from the overflowing side.
  expect(overflowsSeen).toBeGreaterThan(10);
}, 240_000);

test('a resume two pages at full size prints on ONE page through renderResumePdf (the step is picked)', async () => {
  // Find a size that is two pages at step 0 but fits the minimum, by the real renderer.
  let chosen: ResolvedResume | null = null;
  // Smallest such size.
  for (const extra of SIZES) {
    // Candidate.
    const resume = grown(extra);
    // Two pages at today's typography, and the model says it fits at the minimum.
    if ((await realPages(resume, 0, '')) > 1 && fitsOnePage(resume)) { chosen = resume; break; }
  }
  // The ladder must contain such a resume, or this test proves nothing.
  expect(chosen).not.toBeNull();
  // The worker's real path: renderResumeHtml picks the step, page.pdf() prints it, the gate counts it.
  const rendered = await renderResumePdf({ resume: chosen!, page });
  // One page.
  expect(await countPdfPages(rendered.bytes)).toBe(1);
}, 120_000);

test('renderResumePdf refuses a resume that is over one page even at the minimum (ResumeNotOnePageError)', async () => {
  // The largest size: the model and the renderer both say it cannot fit.
  const resume = grown(SIZES[SIZES.length - 1]!);
  // Precondition: the model agrees it cannot fit.
  expect(fitsOnePage(resume)).toBe(false);
  // The gate throws the named error, so nothing is uploaded or attached.
  await expect(renderResumePdf({ resume, page })).rejects.toBeInstanceOf(ResumeNotOnePageError);
}, 60_000);

test('an unrenderable resume is not "fits" (fail closed)', () => {
  // A schema this renderer refuses.
  const stale = { ...grown(0), schema_version: 2 } as unknown as ResolvedResume;
  // Unmeasurable reads as does-not-fit.
  expect(fitsOnePage(stale)).toBe(false);
});
