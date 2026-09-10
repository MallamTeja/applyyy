// PROJECT_PLAN §17.2 — does a machine actually READ this resume correctly?
//
// ── WHY THIS SUITE EXISTS SEPARATELY FROM render-resume-html.test.ts ─────────────
// The existing suite asserts single-column compliance STRUCTURALLY: no <table>, no
// column CSS, real <ul>/<li>. Those are proxies. They say the markup has the shape
// that usually parses well; they cannot say that anything parsing it gets the right
// text out. The proxy and the property are not the same claim, and only one of them is
// what a recruiter's ATS does.
//
// The failure being guarded against is the commonest silent fresher killer: a resume
// that looks immaculate to a human and parses into interleaved gibberish, so the
// keyword matcher never sees the skills and therefore no human ever sees the resume.
// Nothing in a visual review catches it — the document looks perfect, which is exactly
// why it survives review. PARSER FIRST, EYE SECOND.
//
// ── THE SEAM, AND WHY IT IS A SEAM RATHER THAN AN IMPLEMENTATION ─────────────────
// These assertions take EXTRACTED TEXT (an array of lines) as their input. Today that
// text comes from `naiveTextExtract`, a deliberately dumb reader — see the long note in
// naive-text-extract.ts for why naive is the correct choice and not a compromise.
// The real ATS parse simulator belongs to the worker stream (applyyy-ef); when its
// output is available, feed it in here instead. Writing a second parse simulator in
// this package would be the two-implementations-of-one-concept drift this repo has
// already been bitten by, so this file deliberately does not contain one.
//
// The assertions are the durable asset. They are written against the extracted-text
// INTERFACE, so swapping the extractor changes one line and nothing else.
import test from 'node:test';
import assert from 'node:assert/strict';

import { renderResumeHtml } from '../src/render-resume-html.ts';
import { naiveTextExtract } from './naive-text-extract.ts';
import { zomatoBackendIntern } from './fixtures/zomato-backend-intern.ts';

// The one line to change when ef's simulator lands: swap the extractor, keep every
// assertion below. If its output disagrees with these, the FIXTURE is right and the
// renderer is wrong — take the failures back as regression tests rather than relaxing
// the assertion, because the extractor is the truth and the structure was the proxy.
const extractLines = naiveTextExtract;

const resume = zomatoBackendIntern;
const lines = extractLines(renderResumeHtml(resume));
const text = lines.join('\n');

/** The visible heading each section kind renders, matching the renderer's own labels. */
const SECTION_HEADINGS: Record<string, string> = {
  summary: 'Summary',
  skills: 'Skills',
  experience: 'Experience',
  projects: 'Projects',
  education: 'Education',
};

test('ATS parse — the extractor gets real text out at all', () => {
  // A guard on the guard. If extraction returned nothing, or returned the stylesheet,
  // every assertion below would pass vacuously against an empty document — reporting
  // "parses correctly" having parsed nothing. This is the same vacuous-pass trap the
  // enum parity suite checks for with its "parsed zero declarations" assertions.
  assert.ok(lines.length > 10, `extracted only ${lines.length} lines — extraction is broken, not the resume`);
  // A CSS selector leaking through means <style> was not stripped, which would make
  // the skills assertions below pass for entirely the wrong reason.
  assert.ok(!text.includes('{'), 'extracted text contains CSS — the stylesheet leaked into the parse');
});

test('ATS parse — the candidate name is the first thing read', () => {
  // A parser that finds a section heading before a name usually mis-assigns the name,
  // and some ATSs give up on the contact block entirely. The name must lead.
  const firstHeadingIndex = lines.findIndex((line) => Object.values(SECTION_HEADINGS).includes(line));
  const nameIndex = lines.findIndex((line) => line.includes(resume.identity.full_name));

  assert.notEqual(nameIndex, -1, 'the candidate name does not survive text extraction at all');
  assert.ok(
    firstHeadingIndex === -1 || nameIndex < firstHeadingIndex,
    `name appears at line ${nameIndex}, after the first section heading at ${firstHeadingIndex}`,
  );
});

test('ATS parse — sections are read in the tailored order', () => {
  // section_order is a TAILORING DECISION (see DocumentOrdered in profile-nodes.ts):
  // skills go where the parser reads them first for this particular job. If extraction
  // returns them in a different order from the one the Tailor chose, that decision was
  // silently discarded and every tailoring renders equivalently to a machine.
  const expected = resume.section_order
    .filter((kind) => SECTION_HEADINGS[kind] !== undefined)
    // A section the tailoring omitted entirely prints no heading, so it cannot be
    // expected in the extracted text.
    .filter((kind) => text.includes(SECTION_HEADINGS[kind]!))
    .map((kind) => SECTION_HEADINGS[kind]!);

  const actual = lines.filter((line) => Object.values(SECTION_HEADINGS).includes(line));

  assert.deepEqual(actual, expected, 'extracted section order does not match resume.section_order');
});

test('ATS parse — every rendered skill is readable as text', () => {
  // THE KEYWORD-MATCH ASSERTION, and the reason this file exists. A skill that renders
  // beautifully but does not survive extraction is invisible to the matcher, so the
  // application is scored as if the skill were absent — the single most costly silent
  // failure available here, because it is indistinguishable from being unqualified.
  const missing = resume.skills.filter((skill) => !text.includes(skill.name));
  assert.deepEqual(missing.map((s) => s.name), [], 'these skills do not survive text extraction');
});

test('ATS parse — no line interleaves two sections', () => {
  // THE MULTI-COLUMN SIGNATURE. In a two-column layout a dumb reader walking document
  // order emits one line carrying content from both columns — "Skills Python
  // Experience CampusHub" — and every downstream field assignment is then wrong.
  //
  // Checking that no single extracted line contains two section headings detects
  // exactly that, and it is a property the structural tests cannot express: markup can
  // pass "no <table>, no column CSS" and still lay out side by side via flex or grid.
  const headings = Object.values(SECTION_HEADINGS);
  for (const line of lines) {
    const found = headings.filter((h) => line.includes(h));
    assert.ok(
      found.length <= 1,
      `one extracted line carries two section headings (${found.join(' + ')}), the multi-column signature: "${line}"`,
    );
  }
});

test('ATS parse — every bullet survives intact on a single line', () => {
  // A bullet split across lines, or fused with its neighbour, is how a parser turns an
  // achievement into two unreadable fragments. Asserting the whole string lands on ONE
  // extracted line is stricter than asserting it appears somewhere in the text, and it
  // is the strictness that matters: substring-anywhere would pass on a document whose
  // every line was mangled.
  const bullets = [
    ...resume.experience.flatMap((entry) => entry.bullets),
    ...resume.projects.flatMap((entry) => entry.bullets),
    ...resume.education.flatMap((entry) => entry.bullets),
  ];
  assert.ok(bullets.length > 0, 'the fixture has no bullets — this assertion would pass vacuously');

  const broken = bullets.filter((bullet) => !lines.some((line) => line === bullet.text));
  assert.deepEqual(
    broken.map((b) => b.ref),
    [],
    'these bullets do not survive extraction as a single intact line',
  );
});

test('ATS parse — the contact block survives', () => {
  // An unreachable candidate is a rejected candidate regardless of fit. The email is
  // rendered inside a mailto: anchor, which is an INLINE element, so it must not have
  // been broken across lines by extraction either.
  assert.ok(text.includes(resume.identity.email), 'the email address does not survive text extraction');
});

test('ATS parse — every experience employer and role is readable', () => {
  // Company and role come from the master by ref and can never be reworded, so if they
  // do not survive extraction the failure is purely in the rendering. A parser that
  // cannot read the employer cannot build an employment history, which is the field
  // most ATSs rank on first.
  for (const entry of resume.experience) {
    assert.ok(text.includes(entry.company), `employer "${entry.company}" does not survive extraction`);
    assert.ok(text.includes(entry.role), `role "${entry.role}" does not survive extraction`);
  }
});
