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

// The render input type, so the hand-built variants below are checked against
// the real contract rather than merely cast into shape. A cast would let a
// variant drift out of the type and keep passing against a resume nothing in
// production could produce.
import type { MasterLink, ResolvedResume } from '@applyy/shared-types';

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
    for (const heading of ['SKILLS', 'EXPERIENCE', 'PROJECTS', 'EDUCATION', 'ACHIEVEMENTS', 'CERTIFICATIONS']) {
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

/**
 * A resume identical to the worked example except for one project's links.
 *
 * Built as a helper rather than as four fixtures because the link count is the
 * ONLY dimension these tests vary. Two inputs that differ in one property are
 * what makes a rejection test and its non-vacuity twin comparable — if the
 * fixtures differed in anything else, a failure would not say which difference
 * caused it (docs/verification-traps.md, step 4).
 */
function resumeWithProjectLinks(links: readonly MasterLink[]): ResolvedResume {
  return {
    // Spread the real fixture so every other field stays production-shaped; only
    // `projects` is replaced.
    ...zomatoBackendIntern,
    projects: [
      {
        ref: 'prj_link_probe',
        name: 'Link probe',
        // The one variable under test.
        links,
        start_display: '2025',
        end_display: '2025',
        // No bullets: they are irrelevant to the subtitle line and would only
        // add noise to a failure message.
        bullets: [],
      },
    ],
  };
}

describe('renderProject — a project has many addresses, not one', () => {
  it('renders every link as its label, not as a raw URL', () => {
    // THE CASE THAT MOTIVATED THE CONTRACT CHANGE. The old single `url` slot
    // discarded the second address on every ingest, silently. Two links must
    // both survive, and each must print its LABEL — three raw URLs side by side
    // is a line a recruiter skips and a parser gains nothing from.
    const html = renderResumeHtml(resumeWithProjectLinks([
      { id: 'lnk_live', label: 'Live', url: 'https://applyy.example.com' },
      { id: 'lnk_src', label: 'Source', url: 'https://github.com/MallamTeja/applyy' },
    ]));
    assert.match(html, /<a href="https:\/\/applyy\.example\.com">Live<\/a>/);
    assert.match(html, /<a href="https:\/\/github\.com\/MallamTeja\/applyy">Source<\/a>/);
    // The URL must not be the visible text. Asserted as an absence because the
    // regression here is additive: a renderer that printed both label AND URL
    // would satisfy the two assertions above while doubling the line.
    assert.equal(html.includes('>https://github.com/MallamTeja/applyy</a>'), false, 'the raw URL must not be the anchor text');
  });

  it('separates links with a REAL character, not CSS generated content', () => {
    // Not a style preference. Generated content (::before, ::after, a border) is
    // INVISIBLE to a text extractor, so two adjacent anchors with a styled gap
    // parse as the single token 'LiveSource' and neither label matches anything.
    // renderContact carries the same rule; this is the same failure mode at a
    // second call site, which is exactly where a rule stops being applied.
    const html = renderResumeHtml(resumeWithProjectLinks([
      { id: 'lnk_live', label: 'Live', url: 'https://applyy.example.com' },
      { id: 'lnk_src', label: 'Source', url: 'https://github.com/MallamTeja/applyy' },
    ]));
    // The separator character itself must be in the MARKUP, between the anchors.
    assert.match(html, /<\/a><span class="resume__link-sep">•<\/span><a /);
    // And the two labels must never be adjacent with nothing between them.
    assert.equal(html.includes('>Live</a><a '), false, 'labels are fused with no separator character');
  });

  it('NON-VACUITY TWIN: one link renders no separator at all', () => {
    // The twin for the assertion above. A renderer that appended a separator
    // after every link — the obvious wrong implementation — would satisfy the
    // 'separator is present' test and print a dangling bullet on the far more
    // common single-link project. Only this input distinguishes them.
    const html = renderResumeHtml(resumeWithProjectLinks([
      { id: 'lnk_src', label: 'Source', url: 'https://github.com/MallamTeja/applyy' },
    ]));
    // The subtitle exists...
    assert.match(html, /<div class="resume__entry-subtitle"><a href="https:\/\/github\.com\/MallamTeja\/applyy">Source<\/a><\/div>/);
    // ...and carries no separator span. SCOPED TO THE ENTRY, not to the whole
    // document: the stylesheet is inlined into the page and now DEFINES
    // .resume__link-sep, so a document-wide `includes` can never be false and
    // would have reported a pass that had nothing to do with the markup. The
    // first draft of this assertion did exactly that and failed loudly, which is
    // the only reason it is written correctly now.
    const entry = html.slice(html.indexOf('data-ref="prj_link_probe"'));
    const body = entry.slice(0, entry.indexOf('</section>'));
    assert.ok(body.includes('Source'), 'sliced the wrong region — this assertion would be vacuous');
    assert.equal(body.includes('resume__link-sep'), false, 'a single link must not print a separator');
  });

  it('renders no subtitle at all for a project with no public address', () => {
    // Empty links is NORMAL — a private or coursework project has no address —
    // and it is a different fact from 'the parser found none'. An empty subtitle
    // div would still occupy vertical space on the page.
    const html = renderResumeHtml(resumeWithProjectLinks([]));
    // The project itself must still render; only its subtitle disappears.
    assert.match(html, /<div class="resume__entry" data-ref="prj_link_probe">/);
    // The entry must end its head and go straight to the bullets, with no
    // subtitle div anywhere between the two.
    const entry = html.slice(html.indexOf('data-ref="prj_link_probe"'));
    const body = entry.slice(0, entry.indexOf('</section>'));
    assert.equal(body.includes('resume__entry-subtitle'), false, 'empty links produced a subtitle div');
    assert.equal(body.includes('resume__link-sep'), false, 'empty links produced a stray separator');
  });

  it('applies safeHref to a PROJECT link, not only to a contact link', () => {
    // THE VERIFICATION-TRAPS CASE. The existing 'refuses a javascript: URL' test
    // exercises renderContact only, so it would stay green with safeHref deleted
    // from renderProject — the guard and the test would have quietly stopped
    // being about the same code. A project link is a second, independent call
    // site and needs its own input.
    const html = renderResumeHtml(resumeWithProjectLinks([
      { id: 'lnk_evil', label: 'Demo', url: 'javascript:alert(document.cookie)' },
    ]));
    assert.equal(/javascript:/i.test(html), false, 'a javascript: project link must not survive into the href');
    // Collapsed to a dead link, with the label intact — a dead link is cosmetic,
    // an executable one is a vulnerability in the one document a human clicks.
    assert.match(html, /<a href="#">Demo<\/a>/);
  });

  it('NON-VACUITY TWIN: an ordinary https project link is NOT rewritten', () => {
    // safeHref must be an allow-list, not a blanket rejector. Without this twin,
    // a safeHref that returned '#' for everything would pass every rejection
    // assertion above and silently strip every real link from every resume.
    const html = renderResumeHtml(resumeWithProjectLinks([
      { id: 'lnk_ok', label: 'Demo', url: 'https://applyy.example.com/demo' },
    ]));
    assert.match(html, /<a href="https:\/\/applyy\.example\.com\/demo">Demo<\/a>/);
    assert.equal(html.includes('<a href="#">'), false, 'a valid https link was rewritten to a dead one');
  });
});

describe('renderResumeHtml — achievements and certifications (undated sections)', () => {
  const html = renderResumeHtml(zomatoBackendIntern);

  it('renders both new sections under conventional headings', () => {
    // These two kinds joined TailoredSectionKind and so became a compile error
    // in renderSection's exhaustive switch. The compile error is the feature;
    // this asserts it was answered with a real rendering rather than silenced.
    assert.match(html, /<section class="resume__section" data-section="achievements">/);
    assert.match(html, /<section class="resume__section" data-section="certifications">/);
    assert.ok(html.includes('>Achievements</h2>'), 'achievements needs a heading an ATS recognises');
    assert.ok(html.includes('>Certifications</h2>'), 'certifications needs a heading an ATS recognises');
  });

  it('anchors every achievement and certification to its master node', () => {
    // data-ref is what lets the approval diff view highlight one entry against
    // the master it came from. An entry without one is invisible to that view.
    for (const ref of ['ach_sih', 'ach_codechef', 'cert_meta_backend', 'cert_nptel_dbms']) {
      assert.ok(html.includes(`<div class="resume__entry" data-ref="${ref}">`), `entry ${ref} rendered without a master ref`);
    }
  });

  it('prints a present description as its own detail line', () => {
    // Follows renderEducation's grade_display pattern: a detail line rather than
    // a suffix on the title, so the qualifying fact is scannable.
    assert.match(html, /<div class="resume__entry-detail">national finals, 300\+ teams<\/div>/);
    // Certifications changed on 2026-11-10: the issuer now prints inline as "Name (Issuer)"
    // (see the CERT INLINE suite), so the present description is asserted on the title line.
    assert.match(html, /<h3 class="resume__entry-title">Meta Back-End Developer Professional Certificate \(Coursera\)<\/h3>/);
  });

  it('NON-VACUITY TWIN: a null description prints no detail line and no separator', () => {
    // The twin. A renderer that always emitted the detail div would pass the
    // assertion above and print an empty italic line — or the string 'null' —
    // under every entry whose label already says everything. The contract says
    // null is the common case, not the exception.
    const codechef = html.slice(html.indexOf('data-ref="ach_codechef"'));
    const entry = codechef.slice(0, codechef.indexOf('</section>'));
    assert.ok(entry.includes('CodeChef'), 'sliced the wrong entry — this assertion would be vacuous');
    assert.equal(entry.includes('resume__entry-detail'), false, 'a null description produced a detail line');
    assert.equal(entry.includes('null'), false, 'a null description leaked into the markup');
  });

  it('invents no date line for an undated entry', () => {
    // The contract deliberately carries NO date for these, because the real
    // document writes them undated. An empty resume__entry-dates span would be
    // the renderer asserting a field the type refused to have, and the DATE
    // CONTRACT forbids a date the renderer decided for itself.
    const achievements = html.slice(
      html.indexOf('data-section="achievements"'),
      html.indexOf('data-section="certifications"'),
    );
    assert.ok(achievements.includes('Smart India Hackathon'), 'the achievements section did not render — this assertion would be vacuous');
    assert.equal(achievements.includes('resume__entry-dates'), false, 'an undated entry printed a dates slot');
  });

  it('omits an asked-for section that has nothing to show', () => {
    // The hostile fixture LISTS certifications in section_order and supplies an
    // empty array. That is the only input that proves wrapSection suppresses the
    // heading: projects and education are absent from section_order entirely, so
    // the renderer is never even asked for them.
    const sparse = renderResumeHtml(injectionAttempt);
    assert.equal(sparse.includes('data-section="certifications"'), false, 'an empty asked-for section printed a heading');
    // The twin, one line away: the section that DOES have content still renders,
    // so this is a suppression rule and not a blanket refusal of new sections.
    assert.ok(sparse.includes('data-section="achievements"'), 'the populated new section failed to render');
  });

  it('escapes markup reaching the new sections from an uploaded resume', () => {
    // label and description come from the master by ref, so they are NOT
    // downstream of a job description — but the master is parsed out of a file
    // the user uploaded, so the text is still user-supplied. These two renderers
    // are new call sites, and a new call site is where a missing escapeHtml lands.
    const sparse = renderResumeHtml(injectionAttempt);
    assert.equal(/<img\b/i.test(sparse), false, 'an injected img tag survived as markup');
    assert.match(sparse, /&lt;img src=x onerror=alert\(1\)&gt;/, 'the payload should appear escaped, as inert text');
    assert.match(sparse, /judged by &quot;Acme&quot; &amp; &lt;b&gt;Corp&lt;\/b&gt;/, 'description must be escaped exactly once');
  });
});

// Every field the contract types `string | null`, by where it sits. One list, so the
// null builder and the absent builder below can never disagree about which keys exist.
type NullableKeys = { identity: string[]; summary: boolean; experience: string[]; education: string[]; achievements: string[]; certifications: string[] };
// The nine nullable display fields in ResolvedResume (shared-types profile-nodes.ts).
const NULLABLE: NullableKeys = {
  // Headline, phone and location are the optional identity lines.
  identity: ['headline', 'phone', 'location'],
  // The summary itself is the one top-level nullable field.
  summary: true,
  // A role's location: the "Acme, undefined" silent-print case.
  experience: ['location'],
  // Field of study prints after the degree, the grade gets its own line.
  education: ['field', 'grade_display'],
  // The qualifying detail line under an undated entry: the live crash.
  achievements: ['description'],
  // Same field, the second undated section.
  certifications: ['description'],
};

// The fixture with every nullable field either set to null or DELETED. Deleting
// models a stored jsonb snapshot whose writer dropped the key, which is exactly
// what master_profiles v2 and the 3c77d7dc tailored_profile hold live (2026-10-24).
// It violates the type on purpose, so it is built on an untyped JSON clone and
// cast back only at the end: that cast IS the lie the renderer has to survive.
function withNullables(mode: 'null' | 'absent'): ResolvedResume {
  // A deep clone, so neither variant mutates the shared fixture.
  const clone = JSON.parse(JSON.stringify(zomatoBackendIntern)) as Record<string, any>;
  // One edit for one key: set it to null, or remove it outright.
  const clear = (node: Record<string, unknown>, key: string): void => {
    // The two shapes a reader can receive for "this resume has none".
    if (mode === 'null') node[key] = null; else delete node[key];
  };
  // Identity is a single object.
  for (const key of NULLABLE.identity) clear(clone['identity'], key);
  // The summary sits on the root.
  if (NULLABLE.summary) clear(clone, 'summary');
  // The four list sections: every entry, every nullable key.
  for (const section of ['experience', 'education', 'achievements', 'certifications'] as const) {
    // Each entry of the section loses the same keys.
    for (const entry of clone[section] as Record<string, unknown>[]) {
      // The section's nullable keys from the one list above.
      for (const key of NULLABLE[section]) clear(entry, key);
    }
  }
  // Cast only here, after the type has been deliberately broken (see header).
  return clone as unknown as ResolvedResume;
}

// A deep copy of the fixture with links attached to one cert and one achievement.
// JSON round-trip rather than structuredClone so the copy is plain data, exactly
// what a frozen `tailored_profile` read back from jsonb looks like.
function withEntryLinks(links: {
  readonly cert?: readonly MasterLink[];
  readonly achievement?: readonly MasterLink[];
}): ResolvedResume {
  // Untyped clone: the test writes keys onto entries the fixture declares without them.
  const clone = JSON.parse(JSON.stringify(zomatoBackendIntern)) as Record<string, any>;
  // cert_meta_backend is certifications[0] in the fixture.
  if (links.cert !== undefined) clone['certifications'][0]['links'] = links.cert;
  // ach_sih is achievements[0] in the fixture.
  if (links.achievement !== undefined) clone['achievements'][0]['links'] = links.achievement;
  // Back to the contract type for the call under test.
  return clone as unknown as ResolvedResume;
}

// The markup of one entry, from its data-ref to the start of the next entry, so
// an assertion about cert A cannot be satisfied by an anchor printed under cert B.
function entryHtml(html: string, ref: string): string {
  // Start at this entry's anchor attribute.
  const start = html.indexOf(`data-ref="${ref}"`);
  // A missing ref would make every later assertion vacuous, so fail here instead.
  assert.ok(start >= 0, `entry ${ref} not rendered; the slice would be vacuous`);
  // Stop at the next entry, or at the section end for the last one.
  const rest = html.slice(start + 1);
  // Whichever boundary comes first.
  const ends = [rest.indexOf('data-ref="'), rest.indexOf('</section>')].filter((i) => i >= 0);
  // The entry body alone.
  return html.slice(start, start + 1 + Math.min(...ends));
}

// CERT INLINE (2026-11-10, row 38bb2f12): Teja's rule keeps >= 5 certifications on every
// tailored resume, and with the issuer on its own detail line the certifications column
// (157.6pt) out-grew the achievements column (134.2pt) and set the split's height. A
// v30 resume with Student Tribe at its floor then measured 791.0pt against a 778.1pt
// budget and was refused page_overflow. One line per cert ("Name (Issuer)") cut the column
// to 113.9pt and the same resume to 767.7pt (real Chromium 771.1pt, 1 page).
describe('renderCertification — issuer inline on the title line (2026-11-10)', () => {
  // The shared fixture: cert_meta_backend has issuer 'Coursera', cert_nptel_dbms has none.
  const html = renderResumeHtml(zomatoBackendIntern);

  it('prints a certification as "Name (Issuer)" on ONE line, with no separate issuer line', () => {
    // The cert's own markup, so a detail line under another entry cannot satisfy or fail this.
    const cert = entryHtml(html, 'cert_meta_backend');
    // The positive shape: the issuer sits inside the title, in parentheses.
    assert.ok(
      cert.includes('<h3 class="resume__entry-title">Meta Back-End Developer Professional Certificate (Coursera)</h3>'),
      'the issuer is not inline on the cert title line',
    );
    // And the second line is gone: that line is the height this change exists to save.
    assert.equal(cert.includes('resume__entry-detail'), false, 'the cert still prints its issuer on a second line');
  });

  it('prints a certification with no issuer as its bare name, never "Name ()"', () => {
    // The null-description cert from the fixture.
    const cert = entryHtml(html, 'cert_nptel_dbms');
    // The title exactly as the master typed it: no dangling separator or empty parentheses.
    assert.ok(
      cert.includes('<h3 class="resume__entry-title">NPTEL Database Management Systems — Elite</h3>'),
      'a cert without an issuer did not print its bare name',
    );
  });
});

describe('renderUndatedEntry — certification and achievement links (2026-11-01)', () => {
  // (a) THE FEATURE. A credential URL on a cert must reach the PDF as a real
  // anchor, labelled, under THAT cert. Before this change the renderer had no
  // links field to read, so this fails on the missing <a>, not on a typo.
  it('renders a cert credential link as a labelled <a href> under that cert', () => {
    const html = renderResumeHtml(withEntryLinks({
      cert: [{ id: 'lnk_meta', label: 'Credential', url: 'https://coursera.org/verify/ABC123' }],
    }));
    // The anchor sits inside cert_meta_backend's own entry.
    assert.ok(
      entryHtml(html, 'cert_meta_backend').includes('<a href="https://coursera.org/verify/ABC123">Credential</a>'),
      'the credential link did not render as an anchor under its cert',
    );
  });

  // Achievements share the renderer but are a separate section and a separate
  // field read; a renderer wired for certs alone passes the test above.
  it('renders an achievement link under that achievement', () => {
    const html = renderResumeHtml(withEntryLinks({
      achievement: [{ id: 'lnk_lc', label: 'LeetCode profile', url: 'https://leetcode.com/example' }],
    }));
    // Under ach_sih, not anywhere in the document.
    assert.ok(entryHtml(html, 'ach_sih').includes('<a href="https://leetcode.com/example">LeetCode profile</a>'));
  });

  // Two links on one entry use the same REAL-CHARACTER separator as project
  // links, so a text extractor reads two tokens rather than one glued word.
  it('separates two links on one cert with the shared link separator', () => {
    const html = renderResumeHtml(withEntryLinks({
      cert: [
        { id: 'lnk_a', label: 'Credential', url: 'https://example.com/a' },
        { id: 'lnk_b', label: 'Transcript', url: 'https://example.com/b' },
      ],
    }));
    // Exactly the project-link join, so both sections read the same to a parser.
    assert.ok(entryHtml(html, 'cert_meta_backend').includes(
      '<a href="https://example.com/a">Credential</a><span class="resume__link-sep">•</span><a href="https://example.com/b">Transcript</a>',
    ));
  });

  // safeHref is the control that stops a javascript: URL firing in the approval
  // preview. A cert link is master data a human typed, so it gets the same gate.
  it('neutralises a non-http credential URL to "#"', () => {
    const html = renderResumeHtml(withEntryLinks({
      cert: [{ id: 'lnk_bad', label: 'Credential', url: 'javascript:alert(1)' }],
    }));
    // Collapsed href, label still shown.
    assert.ok(entryHtml(html, 'cert_meta_backend').includes('<a href="#">Credential</a>'));
    // And the payload is nowhere in the document.
    assert.equal(html.includes('javascript:'), false);
  });

  // (b) THE v8 SHAPE. Every resume frozen before 2026-11-01 has NO links key on
  // its certs (the fixture is that shape). A renderer that called `.map` on the
  // raw field would throw here, which is the approval-queue crash of 2026-10-24
  // repeated in a new field.
  it('renders a cert with no links key without crashing and without an anchor', () => {
    // Non-vacuity: the fixture cert really has no key.
    assert.equal('links' in (zomatoBackendIntern.certifications[0] ?? {}), false, 'fixture carries links; test is vacuous');
    // Must not throw.
    const html = renderResumeHtml(zomatoBackendIntern);
    // And prints no link line for it.
    const cert = entryHtml(html, 'cert_meta_backend');
    assert.equal(cert.includes('<a '), false, 'an absent links key produced an anchor');
    assert.equal(cert.includes('resume__entry-subtitle'), false, 'an absent links key produced an empty link line');
  });

  // Absent and [] are one meaning (no links), so they must be one output.
  it('renders links: [] byte-identically to an absent links key', () => {
    assert.equal(renderResumeHtml(withEntryLinks({ cert: [], achievement: [] })), renderResumeHtml(zomatoBackendIntern));
  });
});

describe('renderResumeHtml — a nullable key that is ABSENT means the same as null', () => {
  it('an achievement with no description key renders like description: null', () => {
    // THE LIVE CRASH (approval queue, 2026-10-24): escapeHtml(undefined) threw
    // "TypeError: Cannot read properties of undefined (reading 'replace')" because
    // the guard tested only `=== null || === ''`.
    const absent = JSON.parse(JSON.stringify(zomatoBackendIntern)) as Record<string, any>;
    // The same entry in its null form, for the byte comparison.
    const nulled = JSON.parse(JSON.stringify(zomatoBackendIntern)) as Record<string, any>;
    // ach_sih carries a real description in the fixture, so deleting it is a change.
    delete absent['achievements'][0]['description'];
    // Its twin carries an explicit null.
    nulled['achievements'][0]['description'] = null;
    // Non-vacuity: the key really is gone from the input under test.
    assert.equal('description' in absent['achievements'][0], false, 'the key was not removed; this test would be vacuous');
    // Absent and null must render the same bytes: one meaning, one output.
    assert.equal(renderResumeHtml(absent as unknown as ResolvedResume), renderResumeHtml(nulled as unknown as ResolvedResume));
  });

  it('a role with no location key and a degree with no field key never print "undefined"', () => {
    // THE SILENT CASE, worse than the crash: these two sites build a subtitle by
    // concatenation, so undefined did not throw — it printed "Acme, undefined" onto
    // the PDF that gets submitted (repo CLAUDE.md §6: missing data became an answer).
    const html = renderResumeHtml(withNullables('absent'));
    // The literal word must appear nowhere in the document.
    assert.equal(html.includes('undefined'), false, 'an absent nullable key printed the word "undefined"');
    // Non-vacuity: the sections whose subtitles are under test did render.
    assert.ok(html.includes('data-section="experience"') && html.includes('data-section="education"'), 'the sections under test did not render');
  });

  it('every nullable key absent renders byte-identical to every nullable key null', () => {
    // The whole class at once. Byte equality, not "does not throw": a reader that
    // invents a value for undefined would pass a no-throw check and still differ.
    const absent = renderResumeHtml(withNullables('absent'));
    // The contract-conforming twin.
    const nulled = renderResumeHtml(withNullables('null'));
    // One meaning, one rendering.
    assert.equal(absent, nulled);
    // Non-vacuity: clearing the keys must have changed SOMETHING versus the full
    // fixture, or both variants would equal the original and prove nothing.
    assert.notEqual(nulled, renderResumeHtml(zomatoBackendIntern), 'clearing the nullable keys changed nothing; this test would be vacuous');
  });
});

// A deep copy of the fixture with section_order and the two undated lists overridden.
// JSON round-trip for the same reason as withEntryLinks: plain data, like a jsonb read.
function withLayout(patch: {
  readonly section_order?: readonly string[];
  readonly achievements?: readonly unknown[];
  readonly certifications?: readonly unknown[];
}): ResolvedResume {
  // Untyped clone so the test can set any of the three keys without a cast per key.
  const clone = JSON.parse(JSON.stringify(zomatoBackendIntern)) as Record<string, any>;
  // Each key replaced only when the caller names it, so the rest stays the fixture.
  for (const [key, value] of Object.entries(patch)) clone[key] = value;
  // Back to the contract type for the call under test.
  return clone as unknown as ResolvedResume;
}

// One whole <section> by its data-section, from its opening tag to its closing tag.
// Used to prove the split wraps the SAME bytes the section prints without it.
function sectionHtml(html: string, kind: string): string {
  // The opening tag the renderer's wrapSection emits.
  const start = html.indexOf(`<section class="resume__section" data-section="${kind}">`);
  // A missing section would make the comparison vacuous, so fail here instead.
  assert.ok(start >= 0, `section ${kind} not rendered; the slice would be vacuous`);
  // Sections never nest, so the first close after the open is this section's own.
  const end = html.indexOf('</section>', start);
  // Inclusive of the closing tag.
  return html.slice(start, end + '</section>'.length);
}

// The split wrapper's opening tag, written once so every test names the same markup.
const SPLIT_OPEN = '<div class="resume__split">';

describe('renderResumeHtml — achievements | certifications side by side (2026-11-08)', () => {
  it('certifications render in the right column', () => {
    // The fixture has both kinds, each with entries, adjacent in section_order.
    const html = renderResumeHtml(zomatoBackendIntern);
    // The wrapper exists exactly once.
    const open = html.indexOf(SPLIT_OPEN);
    assert.ok(open >= 0, 'no split wrapper was emitted for a resume with both sections');
    assert.equal(html.indexOf(SPLIT_OPEN, open + 1), -1, 'the split wrapper was emitted twice');
    // Both sections sit after the wrapper opens.
    const ach = html.indexOf('data-section="achievements"');
    const cert = html.indexOf('data-section="certifications"');
    // Achievements is LEFT, which in a row flex box means FIRST in DOM order.
    assert.ok(open < ach && ach < cert, 'achievements must precede certifications inside the split');
    // The wrapper closes right after the certifications section, so both are inside it.
    const certEnd = html.indexOf('</section>', cert);
    assert.equal(html.slice(certEnd, certEnd + '</section>\n</div>'.length), '</section>\n</div>', 'certifications is not the last child of the split');
  });

  it('wraps the sections byte-identically to how each prints alone', () => {
    // Split render: both kinds present.
    const split = renderResumeHtml(zomatoBackendIntern);
    // Each kind alone: the other dropped from section_order, so no split is possible.
    const achOnly = renderResumeHtml(withLayout({ section_order: ['skills', 'experience', 'projects', 'education', 'achievements'] }));
    // The mirror case.
    const certOnly = renderResumeHtml(withLayout({ section_order: ['skills', 'experience', 'projects', 'education', 'certifications'] }));
    // The wrapper adds layout only; it must not change a byte of either section.
    assert.equal(sectionHtml(split, 'achievements'), sectionHtml(achOnly, 'achievements'));
    assert.equal(sectionHtml(split, 'certifications'), sectionHtml(certOnly, 'certifications'));
  });

  it('renders a single kind with no split wrapper', () => {
    // Certifications not asked for: achievements prints as a normal full-width section.
    const achOnly = renderResumeHtml(withLayout({ section_order: ['skills', 'achievements'] }));
    // Non-vacuity: the remaining section did render.
    assert.ok(achOnly.includes('data-section="achievements"'), 'achievements did not render; test is vacuous');
    // And nothing wrapped it.
    assert.equal(achOnly.includes(SPLIT_OPEN), false, 'a lone achievements section was wrapped in a split');
    // Mirror: achievements not asked for.
    const certOnly = renderResumeHtml(withLayout({ section_order: ['certifications', 'skills'] }));
    // Non-vacuity again.
    assert.ok(certOnly.includes('data-section="certifications"'), 'certifications did not render; test is vacuous');
    // No wrapper.
    assert.equal(certOnly.includes(SPLIT_OPEN), false, 'a lone certifications section was wrapped in a split');
  });

  it('renders no split when one listed section has no entries', () => {
    // Both listed, certifications empty: the hostile fixture's shape on the real fixture.
    const noCerts = renderResumeHtml(withLayout({ certifications: [] }));
    // Achievements still renders, full width.
    assert.ok(noCerts.includes('data-section="achievements"'), 'achievements did not render; test is vacuous');
    // No half-empty two-column box.
    assert.equal(noCerts.includes(SPLIT_OPEN), false, 'an empty certifications list still produced a split');
    // Mirror: achievements empty.
    const noAch = renderResumeHtml(withLayout({ achievements: [] }));
    // Certifications still renders.
    assert.ok(noAch.includes('data-section="certifications"'), 'certifications did not render; test is vacuous');
    // No wrapper.
    assert.equal(noAch.includes(SPLIT_OPEN), false, 'an empty achievements list still produced a split');
  });

  it('places one split at the FIRST of the two kinds when they are not adjacent', () => {
    // Certifications early, achievements last: the split goes where certifications was.
    const html = renderResumeHtml(withLayout({
      section_order: ['skills', 'certifications', 'projects', 'experience', 'education', 'achievements'],
    }));
    // Exactly one wrapper.
    const open = html.indexOf(SPLIT_OPEN);
    assert.ok(open >= 0, 'no split for non-adjacent sections');
    assert.equal(html.indexOf(SPLIT_OPEN, open + 1), -1, 'the split was emitted twice');
    // It sits after skills and before projects: certifications' slot.
    assert.ok(html.indexOf('data-section="skills"') < open, 'split printed before skills');
    assert.ok(open < html.indexOf('data-section="projects"'), 'split printed after projects, not at the first slot');
    // Achievements still LEFT (first in DOM) inside it.
    assert.ok(html.indexOf('data-section="achievements"') < html.indexOf('data-section="certifications"'), 'achievements is not left');
    // And each section printed once: the second slot printed nothing.
    assert.equal(html.split('data-section="achievements"').length - 1, 1, 'achievements printed twice');
    assert.equal(html.split('data-section="certifications"').length - 1, 1, 'certifications printed twice');
  });
});

describe('print stylesheet — links are blue (Teja, 2026-11-08)', () => {
  // Every rule whose selector targets an anchor, as [selector, body] pairs.
  const anchorRules = [...RESUME_STYLESHEET.matchAll(/([^{}]*\sa)\s*\{([^}]*)\}/g)]
    // Selector trimmed so a failure message prints it readably; CSS comments stripped
    // from the body so the rule's own prose ("never a background") is not read as a declaration.
    .map((match) => [match[1]!.trim(), match[2]!.replace(/\/\*[\s\S]*?\*\//g, '')] as const);

  it('colours every resume link #1155cc with an underline', () => {
    // Non-vacuity: both link rules (contact line and entry link line) were found.
    const selectors = anchorRules.map(([selector]) => selector);
    assert.ok(selectors.some((s) => s.endsWith('.resume__contact a')), 'no contact link rule found; test is vacuous');
    assert.ok(selectors.some((s) => s.endsWith('.resume__entry-subtitle a')), 'no entry link rule found; test is vacuous');
    // Each one blue and underlined.
    for (const [selector, body] of anchorRules) {
      assert.match(body, /color:\s*#1155cc\s*;/i, `${selector} is not blue`);
      assert.match(body, /text-decoration:\s*underline\s*;/, `${selector} is not underlined`);
    }
  });

  it('gives no link a background (printBackground is off in page.pdf)', () => {
    // Non-vacuity: there are anchor rules to inspect.
    assert.ok(anchorRules.length >= 2, 'no anchor rules found; test is vacuous');
    // A background would vanish in the PDF and only show in the preview.
    for (const [selector, body] of anchorRules) {
      assert.equal(/background/i.test(body), false, `${selector} sets a background`);
    }
  });
});

describe('renderContact — the email is a working mailto link', () => {
  it('prints href="mailto:<email>" for a real address', () => {
    // The bug: safeHref saw the bare address, which is not http(s)/mailto, and gave '#'.
    const html = renderResumeHtml(zomatoBackendIntern);
    // The whole anchor, so a broken href and a broken label both fail.
    assert.ok(html.includes('<a href="mailto:tejamallam00@gmail.com">tejamallam00@gmail.com</a>'), 'the email link is not a working mailto');
    // The broken shape is gone.
    assert.equal(html.includes('href="mailto:#"'), false, 'the email still renders as mailto:#');
  });

  it('escapes a hostile email inside the mailto href', () => {
    // The hostile fixture's email carries a quote meant to break out of the attribute.
    const html = renderResumeHtml(injectionAttempt);
    // Escaped once, kept inside the attribute.
    assert.ok(html.includes('href="mailto:a&quot;onmouseover=&quot;alert(1)@example.com"'), 'hostile email not escaped in href');
    // No live attribute was injected.
    assert.equal(html.includes('"onmouseover="'), false, 'the quote broke out of the href');
  });

  it('still collapses a javascript: link to "#"', () => {
    // The mailto fix must not loosen safeHref for the other links.
    const html = renderResumeHtml(injectionAttempt);
    // The hostile fixture's Portfolio link is javascript:.
    assert.ok(html.includes('<a href="#">Portfolio</a>'), 'javascript: link was not collapsed');
    // Nowhere in the document.
    assert.equal(/javascript:/i.test(html), false, 'a javascript: URL survived');
  });
});
