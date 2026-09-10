/**
 * applyy — tests for the shared resume renderer.
 *
 * Run with `pnpm --filter @applyy/resume-template test`, which is `node --test`.
 * No test framework is installed on purpose: node:test ships with Node 24 and
 * runs .ts directly via native type stripping, so the package that must stay
 * importable by three runtimes does not drag a build-time dependency behind it.
 *
 * The suite is organised around the three properties renderResumeHtml cannot
 * lose — determinism, escaping, and single-column structure — because those are
 * the ones whose failure is SILENT. A crashed render is obvious; a render that
 * quietly differs between the preview and the PDF, or that parses into
 * interleaved gibberish, is not.
 */

// Built-in runner and strict assertions; strict so `==` coercion can never make
// a failing assertion pass.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
// Used for the determinism fingerprint and for the golden-file comparison.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
// URL-relative paths so the suite runs from any working directory.
import { fileURLToPath } from 'node:url';

// The subject under test, imported through the package's public surface so the
// tests exercise the same entry point the worker and React use.
import { renderResumeHtml, ResumeRenderError, RESUME_STYLESHEET } from '../src/index.ts';
// The section 11 worked example plus a hostile variant.
import { zomatoBackendIntern, injectionAttempt } from './fixtures/zomato-backend-intern.ts';

/** Absolute path to the committed golden render, resolved relative to this file. */
const GOLDEN_PATH = fileURLToPath(new URL('./fixtures/zomato-backend-intern.golden.html', import.meta.url));

/** Short, readable fingerprint of a string, for determinism assertions. */
function sha256(value: string): string {
  // Hex digest because a failing assertion prints it and hex is greppable.
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

describe('renderResumeHtml — determinism', () => {
  it('produces byte-identical output across repeated calls', () => {
    // Determinism is the load-bearing property: the approval guarantee and the
    // tailored_hash cache key (constraint 8) both assume it. Rendering many
    // times catches accidental dependence on iteration order or shared mutable
    // state that a single comparison would miss.
    const first = renderResumeHtml(zomatoBackendIntern);
    // 50 iterations is cheap (the render is pure string building) and would
    // surface a Map/Set ordering bug that only shows up intermittently.
    for (let i = 0; i < 50; i += 1) {
      assert.equal(renderResumeHtml(zomatoBackendIntern), first, `render ${i} differed from render 0`);
    }
  });

  it('matches the committed golden render byte for byte', () => {
    // A golden FILE rather than a bare hash constant: when this fails, the
    // diff shows what changed in the resume, whereas a hash mismatch only says
    // that something did. Regenerate deliberately with UPDATE_GOLDEN=1.
    const actual = renderResumeHtml(zomatoBackendIntern);
    // Opt-in regeneration, so a golden can never be silently rewritten by a
    // normal test run to make a real regression disappear.
    if (process.env['UPDATE_GOLDEN'] === '1') {
      writeFileSync(GOLDEN_PATH, actual, 'utf8');
    }
    // utf8 with no normalisation: the point is a byte comparison.
    const expected = readFileSync(GOLDEN_PATH, 'utf8');
    assert.equal(
      sha256(actual),
      sha256(expected),
      'Rendered resume changed. If intended, re-run with UPDATE_GOLDEN=1 and review the diff — this file is what gets submitted to employers.',
    );
    // Compared again as strings so a failure prints an actual diff, not hashes.
    assert.equal(actual, expected);
  });

  it('emits LF line endings regardless of how the source was checked out', () => {
    // Every part of the output is built from multi-line template literals, so
    // without normalisation the rendered HTML inherits the source file's line
    // endings. git core.autocrlf=true (this machine, and the Windows default)
    // would give a fresh clone CRLF while the Ubuntu Actions runner gets LF —
    // so the approved preview and the submitted PDF would differ, and
    // tailored_hash would vary by platform, with every test passing locally.
    const html = renderResumeHtml(zomatoBackendIntern);
    assert.equal(html.includes('\r'), false, 'rendered output must contain no carriage returns');
  });

  it('contains no clock, locale or randomness dependence in the renderer source', () => {
    // A STRUCTURAL test, not a behavioural one. Behaviourally, a timezone bug
    // only appears on a machine in another timezone — which is exactly the
    // Windows-preview vs Ubuntu-runner split this system has. Banning the
    // constructs at source level catches it on Teja's machine instead of in
    // a mismatch between an approved preview and a submitted PDF.
    const rendererSource = readFileSync(fileURLToPath(new URL('../src/render-resume-html.ts', import.meta.url)), 'utf8');
    // Strip comments first: this very file's explanatory prose names the banned
    // constructs, and a naive scan would flag the comment that forbids them.
    const code = rendererSource.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    // Each pattern is a real source of host-dependent output.
    for (const banned of [/new Date\b/, /Date\.now\b/, /Intl\./, /toLocale\w*/, /Math\.random\b/]) {
      assert.equal(banned.test(code), false, `renderer must not use ${String(banned)} — it makes output host-dependent`);
    }
    // Sorting would let two different tailorings render identically and collide
    // on tailored_hash, serving a cached PDF that belongs to another job.
    assert.equal(/\.sort\(/.test(code), false, 'renderer must not sort — order is data, decided by the Tailor');
  });
});

describe('renderResumeHtml — ATS structure (section 17.2)', () => {
  // Rendered once and shared: these assertions are all read-only.
  const html = renderResumeHtml(zomatoBackendIntern);

  it('is single-column and uses no layout primitive that scrambles extraction', () => {
    // The failure this guards against is silent and total: a two-column resume
    // parses into interleaved gibberish, so the machine never sees the skills
    // and a human never sees the resume.
    assert.match(RESUME_STYLESHEET, /column-count:\s*1/, 'stylesheet must pin a single column');
    // A layout table is the other classic way extraction order breaks.
    assert.equal(/<table/i.test(html), false, 'resume must not use tables for layout');
    // Absolutely positioned text extracts in DOM order rather than visual order.
    assert.equal(/position:\s*absolute/i.test(RESUME_STYLESHEET), false, 'no absolute positioning');
    // Multi-column shorthand would reintroduce the exact problem column-count:1 prevents.
    assert.equal(/columns:\s*[2-9]/i.test(RESUME_STYLESHEET), false, 'no multi-column shorthand');
  });

  it('exposes exactly one h1 carrying the candidate name', () => {
    // Parsers weight the first heading as the candidate name; competing h1s
    // actively confuse them.
    const h1s = html.match(/<h1\b/g) ?? [];
    assert.equal(h1s.length, 1, 'exactly one h1');
    assert.match(html, /<h1 class="resume__name">Teja Mallam<\/h1>/);
  });

  it('uses conventional section headings a keyword matcher recognises', () => {
    // A clever heading is a heading the parser does not recognise, so the
    // content beneath it is filed as unclassified prose.
    for (const heading of ['SKILLS', 'EXPERIENCE', 'PROJECTS', 'EDUCATION']) {
      // The stylesheet uppercases visually; the markup carries title case.
      const titleCase = heading.charAt(0) + heading.slice(1).toLowerCase();
      assert.ok(html.includes(`>${titleCase}</h2>`), `missing standard heading: ${titleCase}`);
    }
  });

  it('renders achievement lines as real list items', () => {
    // Extractors emit <li> as separate lines; a div-with-a-dash collapses into
    // one run-on paragraph that reads as a wall of text.
    assert.match(html, /<ul class="resume__bullets">/);
    assert.match(html, /<li class="resume__bullet" data-ref="bul_rest_api">/);
  });

  it('honours the tailored section order rather than a fixed layout', () => {
    // The fixture puts skills first because the JD is technology-led. If the
    // renderer imposed its own order this would silently regress.
    assert.ok(html.indexOf('data-section="skills"') < html.indexOf('data-section="experience"'));
    assert.ok(html.indexOf('data-section="experience"') < html.indexOf('data-section="education"'));
  });

  it('omits a section entirely rather than printing an empty heading', () => {
    // The hostile fixture has no projects and no education. A bare heading would
    // add a keyword the content does not support — which is a small fabrication.
    const sparse = renderResumeHtml(injectionAttempt);
    assert.equal(sparse.includes('data-section="projects"'), false);
    assert.equal(sparse.includes('data-section="education"'), false);
  });
});

describe('renderResumeHtml — honesty gate (sections 10 and 11)', () => {
  const html = renderResumeHtml(zomatoBackendIntern);

  it('renders only skills that resolved from the master', () => {
    // Section 11's whole lesson: the JD asked for PostgreSQL and Docker, Teja has
    // used neither, and his master says MongoDB. They cannot appear, because a
    // ResolvedSkill only exists if the validator resolved it out of the master.
    assert.equal(/PostgreSQL/i.test(html), false, 'PostgreSQL was never in the master');
    assert.equal(/\bDocker\b/i.test(html), false, 'Docker was never in the master');
    // The real datastore is shown instead of the one the JD wanted.
    assert.match(html, /MongoDB/);
  });

  it('prints the reworded bullet and never the pre-tailoring master text', () => {
    // master_text exists for the approval diff view. Printing it on the PDF would
    // put the untailored wording in front of the employer.
    assert.match(html, /Designed and shipped a production REST API/);
    assert.equal(html.includes('Built a REST API with Express and Node.js for a college event portal'), false);
  });

  it('anchors every rendered bullet to a master node id', () => {
    // Every printed line is traceable to a master node — the property the
    // Auditor's verdict depends on.
    const bulletTags = html.match(/<li class="resume__bullet"[^>]*>/g) ?? [];
    assert.ok(bulletTags.length > 0, 'fixture should render bullets');
    for (const tag of bulletTags) {
      assert.match(tag, /data-ref="[^"]+"/, `bullet rendered without a master ref: ${tag}`);
    }
  });

  it('rejects a snapshot whose schema version it does not understand', () => {
    // Resume pinning means old snapshots genuinely arrive. Rendering one with
    // fields silently missing is worse than refusing it.
    const stale = { ...zomatoBackendIntern, schema_version: 99 } as unknown as Parameters<typeof renderResumeHtml>[0];
    assert.throws(() => renderResumeHtml(stale), ResumeRenderError);
  });
});

describe('renderResumeHtml — escaping untrusted input (section 17)', () => {
  // Bullet text is reworded from job-description language, so JD strings really
  // do reach these fields. Escaping is asserted on output, never assumed.
  const html = renderResumeHtml(injectionAttempt);

  it('neutralises HTML injected through any rendered field', () => {
    // The payload must survive as inert text, not as markup.
    assert.equal(/<script/i.test(html.replace(/<style>[\s\S]*?<\/style>/i, '')), false, 'no live script tag');
    assert.match(html, /&lt;script&gt;/, 'payload should appear escaped');
    // A closing </li></ul> smuggled through a bullet would break out of the list.
    assert.equal(html.includes('</li></ul><script>'), false);
  });

  it('escapes ampersands exactly once', () => {
    // Ampersand must be replaced first, or the function re-escapes its own
    // output and the resume literally prints '&amp;lt;'.
    assert.match(html, /C &amp; C\+\+/);
    assert.equal(html.includes('&amp;amp;'), false, 'double-escaped ampersand');
  });

  it('refuses a javascript: URL rather than escaping it', () => {
    // Quote-escaping alone would not stop this: the payload needs no quotes, and
    // the React approval preview is exactly where a human clicks the link.
    assert.equal(/javascript:/i.test(html), false, 'javascript: URL must not survive');
    assert.match(html, /<a href="#">Portfolio<\/a>/);
  });
});

describe('renderResumeHtml — self-contained document', () => {
  const html = renderResumeHtml(zomatoBackendIntern);

  it('is a complete document with the stylesheet inlined', () => {
    // page.pdf() gets no second chance to fetch anything: an external stylesheet
    // that fails to load produces an unstyled PDF that still "succeeds".
    assert.match(html, /^<!doctype html>/);
    assert.match(html, /<style>/);
    assert.ok(html.includes(RESUME_STYLESHEET), 'stylesheet must be inlined verbatim');
  });

  it('requests no network resources at all', () => {
    // Any of these would be a fetch on a GitHub Actions runner that may be
    // slow, blocked, or offline — and a silently degraded PDF.
    assert.equal(/<link\b/i.test(html), false, 'no external stylesheet or preload');
    assert.equal(/@import/i.test(html), false, 'no CSS @import');
    assert.equal(/@font-face/i.test(html), false, 'no web fonts — a font that fails to load changes the page count');
    assert.equal(/<img\b/i.test(html), false, 'no images: they carry no extractable text and can fail to load');
  });

  it('declares A4 with print margins so page.pdf does not crop', () => {
    // Playwright honours @page only with preferCSSPageSize: true, which the
    // README instructs the worker to pass; without the rule there is nothing to
    // honour and Chromium silently falls back to Letter.
    assert.match(RESUME_STYLESHEET, /@page\s*\{[^}]*size:\s*A4/);
    assert.match(RESUME_STYLESHEET, /@page\s*\{[^}]*margin:/);
  });
});
