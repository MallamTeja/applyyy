/* The resume preview shows the SUBMITTED document, and the approval queue lets every
 * Bucket A row be opened before it is approved.
 *
 * Two halves, for two reasons:
 * - renderPreview.ts is pure, so it is tested by CALLING it: the preview must be the
 *   worker's renderer output with only the <title> changed, refusals must be named, and
 *   the master must render verbatim.
 * - The page and the frame are .tsx, which `node --test` cannot execute and apps/web has
 *   no render harness for (adding one is a dependency and a lockfile write). Those are
 *   held by SOURCE-SHAPE assertions that match code forms - a JSX tag, a call with its
 *   arguments, an attribute - never prose, so a comment explaining a removed bug cannot
 *   trip them (CLAUDE.md section 3).
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

// The module under test, by path with its extension, as node's ESM resolver requires.
import { buildResumePreview, masterAsResume, previewDocumentTitle } from '../src/features/resume-preview/renderPreview.ts';
// The renderer itself, to prove the preview's body IS its output.
import { renderResumeHtml } from '../../../packages/resume-template/src/index.ts';
// The template's own fixtures: a real resume, and one with hostile strings.
import { injectionAttempt, zomatoBackendIntern } from '../../../packages/resume-template/test/fixtures/zomato-backend-intern.ts';

// The <title> element, which is the only part the preview may change.
const TITLE = /<title>[^<]*<\/title>/;

// Source of a file under src/, read relative to this test so cwd does not matter.
const source = (rel: string) => readFileSync(fileURLToPath(new URL(`../src/${rel}`, import.meta.url)), 'utf8');

describe('buildResumePreview renders the worker document', () => {
  it('is the renderer output byte for byte, except the <title>', () => {
    // The preview, with a download title.
    const preview = buildResumePreview(zomatoBackendIntern, 'Name - Zomato - tailored');
    // Must render: this is a valid fixture.
    assert.equal(preview.kind, 'rendered');
    // Narrowed for the compiler and the reader.
    if (preview.kind !== 'rendered') return;
    // Everything outside the title is identical to what the worker would print.
    assert.equal(preview.html.replace(TITLE, ''), renderResumeHtml(zomatoBackendIntern).replace(TITLE, ''));
    // And the title is the one we asked for, which Chrome uses as the PDF filename.
    assert.match(preview.html, /<title>Name - Zomato - tailored<\/title>/);
  });

  it('names a refusal instead of rendering an empty document', () => {
    // An unsupported schema version is the renderer's documented refusal.
    const preview = buildResumePreview({ ...zomatoBackendIntern, schema_version: 99 as 1 }, 'x');
    // Refused, with the renderer's reason, never a blank 'rendered'.
    assert.equal(preview.kind, 'refused');
    // The message names the version, so the operator knows why.
    if (preview.kind === 'refused') assert.match(preview.message, /schema_version 99/);
  });

  it('cannot carry markup into <head> through the filename title', () => {
    // The hostile fixture's name holds a script tag; it flows into the title.
    const title = previewDocumentTitle(injectionAttempt.identity.full_name, 'Acme <b>', 'tailored');
    // Render with that title.
    const preview = buildResumePreview(injectionAttempt, title);
    // Still renders.
    assert.equal(preview.kind, 'rendered');
    // The head (everything before <body) holds no live tag from the name.
    if (preview.kind === 'rendered') assert.doesNotMatch(preview.html.split('<body')[0] ?? '', /<script|<b>/i);
  });
});

describe('previewDocumentTitle', () => {
  it('drops characters file systems refuse, and marks the variant', () => {
    // Slash and colon would otherwise reach the Save-as-PDF filename.
    assert.equal(previewDocumentTitle('Ada Lovelace', 'Acme/Labs: AI', 'tailored'), 'Ada Lovelace - Acme Labs AI - tailored');
    // The master is about no company.
    assert.equal(previewDocumentTitle('Ada Lovelace', 'Acme', 'master'), 'Ada Lovelace - master');
  });
});

describe('masterAsResume renders the master verbatim', () => {
  // A minimal master in the stored shape, including an achievement WITHOUT description,
  // which is how the live master stores it.
  const master = {
    schema_version: 1 as const,
    identity: { full_name: 'Ada Lovelace', headline: null, email: 'ada@example.com', phone: null, location: null, links: [] },
    summary: { id: 'summary_main', text: 'Analyst of engines.' },
    skills: [{ id: 'skill_math', name: 'Mathematics', category: 'Core' }],
    experience: [{
      id: 'exp_engine', company: 'Engine Co', role: 'Analyst', location: null,
      start_display: '1842', end_display: '1843', start_date: null, end_date: null,
      bullets: [{ id: 'b_notes', text: 'Wrote the notes on the engine.', tags: [] }],
    }],
    projects: [],
    education: [],
    achievements: [{ id: 'ach_first', label: 'First program', bullets: [{ id: 'b_first', text: 'Published the first algorithm.', tags: [] }] }],
    certifications: [],
    links: [],
  };

  it('copies every bullet into text AND master_text, and renders it', () => {
    // The mapping, at version 2.
    const resume = masterAsResume(master as never, 2);
    // Nothing reworded: the two text fields agree.
    assert.deepEqual(resume.experience[0]?.bullets[0], { ref: 'b_notes', text: 'Wrote the notes on the engine.', master_text: 'Wrote the notes on the engine.' });
    // A missing description becomes an explicit null, as the resolved type requires.
    assert.equal(resume.achievements[0]?.description, null);
    // The version it was rendered from travels with it.
    assert.equal(resume.master_version, 2);
    // And the shared renderer accepts it and prints every bullet.
    const preview = buildResumePreview(resume, 'Ada Lovelace - master');
    // Rendered.
    assert.equal(preview.kind, 'rendered');
    // Both bullets are on the page.
    if (preview.kind === 'rendered') {
      // The experience bullet.
      assert.match(preview.html, /Wrote the notes on the engine\./);
      // The achievement bullet.
      assert.match(preview.html, /Published the first algorithm\./);
    }
  });
});

describe('approval queue: Bucket A rows open', () => {
  // The page source, read once.
  const page = source('features/approval/ApprovalQueuePage.tsx');
  // Only the Bucket A section: from its heading id to the end of the file.
  const bucketA = page.slice(page.indexOf('id="bucket-a-heading"'));

  it('a Bucket A row can be expanded to its DiffView', () => {
    // The section exists; a missing anchor must fail, not pass vacuously.
    assert.ok(page.includes('id="bucket-a-heading"'), 'Bucket A heading not found');
    // A disclosure button bound to the per-row review state.
    assert.match(bucketA, /aria-expanded=\{isReviewing\}/);
    // The same DiffView component Bucket B uses, mounted inside Bucket A.
    assert.match(bucketA, /<DiffView\s/);
  });

  it('approving an opened Bucket A row goes through the shared RPC path', () => {
    // The row's DiffView approves via the shared helper, tagged as an individual review.
    // Pins `acknowledged` too (2026-11-05, B1): without it a "held for findings" second click from this row would re-hold forever.
    assert.match(bucketA, /approveReviewed\(diff\.applicationId, decisions, 'bucket_a_review', acknowledged\)/);
    // And that helper ends in settle(..., 'approved'), i.e. advance_application_status as 'human'.
    // `\s*` because settle's arguments now sit one per line (B1 added the stamp arg); the call is unchanged.
    assert.match(page, /function approveReviewed[\s\S]*?void settle\(\s*\[applicationId\],\s*'approved'/);
    /* The RPC still names the human agent. Since item 4 (2026-10-08) the arguments are built by
       buildSettleArgs in saveTailoredEdit.ts (unit-tested there, p_agent included), so this holds
       both halves: the page sends the builder's output, and the builder names 'human'. */
    assert.match(page, /rpc\(\s*'advance_application_status',[\s\S]*?buildSettleArgs\(/);
    // The builder's own source names the human agent.
    assert.match(source('features/approval/saveTailoredEdit.ts'), /p_agent: 'human'/);
  });

  it('a Bucket A row can preview its resume with the pinned master version', () => {
    // The shared preview component, mounted in Bucket A.
    assert.match(bucketA, /<ResumePreview\s/);
    // Fed the snapshot's own master_version, never the loader's latest.
    assert.match(bucketA, /masterVersion=\{resume\.master_version\}/);
  });
});

describe('the preview frame cannot run scripts', () => {
  // The component source.
  const frame = source('features/resume-preview/ResumePreview.tsx');

  it('sandboxes every iframe without allow-scripts', () => {
    // Every sandbox attribute in the file.
    const sandboxes = [...frame.matchAll(/sandbox="([^"]*)"/g)].map((m) => m[1] ?? '');
    // At least one, so this cannot pass on a file with no iframe.
    assert.ok(sandboxes.length > 0, 'no sandbox attribute found');
    // None grants scripts.
    for (const value of sandboxes) assert.doesNotMatch(value, /allow-scripts/);
    // And the frame content is srcdoc, not a URL that could load something else. The preview
    // html now passes through the screen-only zoom wrapper first; it is still inline markup.
    assert.match(frame, /srcDoc=\{zoomedPreviewHtml\(preview\.html, zoom\)\}/);
  });
});
