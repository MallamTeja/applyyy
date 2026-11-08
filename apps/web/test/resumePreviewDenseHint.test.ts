/* P1 #5 (2026-11-08): the resume preview says "Fitted to one page (smaller type)" when the renderer
 * shrank the FONT to fit one page (a typography rung with fontScale < 1, dc8ac5c), and only then.
 *
 * Two halves, as in resumePreview.test.ts: renderPreview.ts is pure, so its smallerType flag is tested by
 * calling it on resumes that land on known rungs; ResumePreview.tsx cannot run under node --test, so the
 * hint's render is held by a source-shape assertion on the JSX expression, never on prose.
 */

// Strict asserts, so a truthy non-boolean cannot pass for true.
import assert from 'node:assert/strict';
// Reads the .tsx source for the shape check.
import { readFileSync } from 'node:fs';
// The runner apps/web uses everywhere.
import { describe, it } from 'node:test';
// Resolves the source path relative to this file, so cwd does not matter.
import { fileURLToPath } from 'node:url';

// The module under test, by path with its extension, as node's ESM resolver requires.
import { buildResumePreview } from '../src/features/resume-preview/renderPreview.ts';
// The renderer's own picker, to prove each case really sits on the rung it claims to.
import { articleOf, flowOf, pickStepIndex, renderResumeHtml, TYPOGRAPHY_LADDER } from '../../../packages/resume-template/src/index.ts';
// A real resume that fits at full size.
import { zomatoBackendIntern } from '../../../packages/resume-template/test/fixtures/zomato-backend-intern.ts';
// Type only: the snapshot shape the renderer takes.
import type { ResolvedResume } from '../src/data/contract';

/** The fixture with `extra` long bullets appended round-robin (the same growth page-fit.test.ts uses). */
function grown(extra: number): ResolvedResume {
  // A deep copy per call, so the shared fixture is never mutated.
  const resume = structuredClone(zomatoBackendIntern) as unknown as ResolvedResume;
  // The entries that take bullets.
  const targets = [...resume.experience, ...resume.projects];
  // Round-robin, so no single entry balloons.
  for (let i = 0; i < extra; i += 1) {
    // Long and unique per i, so each bullet costs real lines.
    const text = `Built and operated service number ${i} handling queues, caching, retries and dashboards for several internal teams.`;
    // Appended like any tailored bullet.
    (targets[i % targets.length]!.bullets as { ref: string; text: string; master_text: string }[]).push({ ref: `syn_${i}`, text, master_text: text });
  }
  // The grown resume.
  return resume;
}

// The rung the renderer picks for a resume, by its own code path.
const rungOf = (resume: ResolvedResume) => pickStepIndex(flowOf(articleOf(renderResumeHtml(resume))));

/** The smallest growth that lands a resume on a rung matching `want`; searched, so ladder retuning cannot strand the test. */
function firstGrowth(want: (rung: number) => boolean): ResolvedResume {
  // Up to 80 extra bullets is far past the last rung (page-fit.test.ts overflows well before that).
  for (let extra = 0; extra <= 80; extra += 1) {
    // Candidate resume.
    const resume = grown(extra);
    // Found the rung we want.
    if (want(rungOf(resume))) return resume;
  }
  // A ladder that never reaches the wanted rung is a broken premise, said by name, not a silent pass.
  throw new Error('no growth reached the wanted rung');
}

// The source of the pane, for the shape check.
const paneSource = readFileSync(fileURLToPath(new URL('../src/features/resume-preview/ResumePreview.tsx', import.meta.url)), 'utf8');

describe('resume preview: "Fitted to one page (smaller type)" hint', () => {
  it('a resume that fits at full size has smallerType false', () => {
    // The fixture as shipped sits on rung 0 (the golden fixture test pins its bytes).
    assert.equal(rungOf(zomatoBackendIntern as unknown as ResolvedResume), 0);
    // Rendered with no hint.
    const preview = buildResumePreview(zomatoBackendIntern as unknown as ResolvedResume, 'x');
    // Narrowed: must render.
    assert.equal(preview.kind, 'rendered');
    // No smaller type.
    if (preview.kind === 'rendered') assert.equal(preview.smallerType, false);
  });

  it('a spacing-only rung (fontScale 1) is NOT smaller type', () => {
    // The first resume on a rung > 0 whose font is full size (rung 1 today).
    const resume = firstGrowth((r) => r > 0 && TYPOGRAPHY_LADDER[r]!.fontScale === 1);
    // Rendered.
    const preview = buildResumePreview(resume, 'x');
    // Must render.
    assert.equal(preview.kind, 'rendered');
    // Spacing tightened, type unchanged: no hint.
    if (preview.kind === 'rendered') assert.equal(preview.smallerType, false);
  });

  it('a resume fitted on a smaller-type rung has smallerType true', () => {
    // The first resume on a rung whose font is scaled down (rung 2 today).
    const resume = firstGrowth((r) => TYPOGRAPHY_LADDER[r]!.fontScale < 1);
    // Rendered.
    const preview = buildResumePreview(resume, 'x');
    // Must render.
    assert.equal(preview.kind, 'rendered');
    // The hint is due.
    if (preview.kind === 'rendered') assert.equal(preview.smallerType, true);
  });

  it('the pane renders the hint from preview.smallerType', () => {
    // The exact JSX expression: gated on the flag, the agreed words, the semantic-token status class.
    assert.match(paneSource, /\{preview\.smallerType && <p className="resume-preview__status">Fitted to one page \(smaller type\)<\/p>\}/);
  });
});
