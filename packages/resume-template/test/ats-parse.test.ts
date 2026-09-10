// PROJECT_PLAN §17.2 — does a machine actually READ this resume correctly?
//
// ── WHY THIS SUITE EXISTS SEPARATELY FROM render-resume-html.test.ts ─────────────
// The existing suite asserts single-column compliance STRUCTURALLY: no <table>, no
// column CSS, real <ul>/<li>. Those are proxies. They say the markup has the shape
// that usually parses well; they cannot say that anything parsing it gets the right
// text out. The proxy and the property are not the same claim, and only one of them is
// what a recruiter's ATS does.
//
// The failure class being guarded against: a resume that looks immaculate to a human
// while the machine reads something else, so the keyword matcher never sees the skills
// and therefore no human ever sees the resume. Nothing in a visual review catches it —
// the document looks perfect, which is exactly why it survives review.
// PARSER FIRST, EYE SECOND.
//
// ── WHICH HAZARD IS REAL HERE, MEASURED 2026-09-10 BY applyyy-ef ─────────────────
// The received wisdom — "multi-column layouts parse into interleaved gibberish" — is
// FALSE for this pipeline, and ef measured it rather than arguing it. Rendering the real
// golden resume in two columns and extracting through `page.pdf()` -> pdf.js
// `getTextContent()` produced correct DOM order. Chromium emits its PDF text stream in
// PAINT order, and paint order equals DOM order for every ordinary side-by-side layout.
// column-count, flex, grid, float, absolute positioning and even a two-cell <table> all
// came out in DOM order. The folklore is true of Word, LaTeX and design tools — which is
// where the advice comes from — and not of a browser print.
//
// So the two rules that actually bind are narrower and one of them is nearly invisible:
//   1. NEVER place sections with `order:` or `flex-direction: row-reverse`. Those are
//      the ONLY primitives that move the text layer, and the rendered PDF still looks
//      correct — so no reviewer, screenshot or approval preview can catch it. That gets
//      its own assertion here.
//   2. KEEP EVERY CLAIMED SKILL IN THE TEXT LAYER. Missing text, not misordered text,
//      is the load-bearing risk.
//
// Consequence for the sibling suite: render-resume-html.test.ts's "no columns, no
// tables, real <ul>" assertions are kept — they are cheap and they encode intent — but
// they are LAYOUT-INTENT assertions, not §17.2 compliance. A proxy labelled as the real
// thing is worse than no proxy, because it stops anyone looking for the actual hazard.
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
// The stylesheet itself, for the reordering assertion — the one layout hazard ef's
// measurement showed actually moves the PDF text layer.
import { RESUME_STYLESHEET } from '../src/print-styles.ts';
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
  // Detects one extracted line carrying content from two sections — "Skills Python
  // Experience CampusHub" — after which every downstream field assignment is wrong.
  //
  // ── SCOPE, CORRECTED 2026-09-10 AFTER applyyy-ef MEASURED THE REAL PIPELINE ─────
  // This assertion is about EXTRACTION FROM HTML in document order. It is NOT evidence
  // about the submitted PDF, and the difference matters because the folklore is wrong
  // for our pipeline. ef rendered the real golden resume in two columns expecting
  // extraction to break; it PASSED. It then measured every layout through
  // `page.pdf()` -> pdf.js `getTextContent()`:
  //   NOT scrambled: column-count:2, display:flex, display:grid, float, position:
  //                  absolute, a two-cell <table>
  //   SCRAMBLED:     flex-direction: row-reverse, and flex `order:`
  // Chromium emits its PDF text stream in PAINT order, and paint order equals DOM
  // order for every ordinary side-by-side layout. The interleaving advice comes from
  // Word, LaTeX and design tools, where it is true — and is not true of a browser
  // print. So printing through Chromium is structurally safer than §17.2 assumes.
  //
  // This test is therefore kept as a cheap lower bound on a dumb reader, not as
  // §17.2 compliance. The hazard that actually binds has its own test below.
  const headings = Object.values(SECTION_HEADINGS);
  for (const line of lines) {
    const found = headings.filter((h) => line.includes(h));
    assert.ok(
      found.length <= 1,
      `one extracted line carries two section headings (${found.join(' + ')}): "${line}"`,
    );
  }
});

test('ATS parse — NON-VACUITY CONTROL: the interleaving check accepts a correct document', () => {
  // THE POSITIVE CONTROL, adopted from applyyy-ef. Every mutation test run today proves
  // a guard CAN fail; none proves it can PASS for the right reason — and a guard that
  // rejects ALL inputs is indistinguishable from a correct one when you only ever test
  // the failing side. This closes that hole for the assertion above.
  //
  // Same fragments, same expectation, differing ONLY in emission order: sequential must
  // pass, interleaved must fail. If either half stops holding, the check has become
  // either vacuous or a blanket rejector.
  const sequential = ['Skills', 'Python', 'Experience', 'CampusHub'];
  const interleaved = ['Skills Python Experience CampusHub'];

  const interleaves = (ls: string[]): boolean =>
    ls.some((line) => Object.values(SECTION_HEADINGS).filter((h) => line.includes(h)).length > 1);

  assert.equal(interleaves(sequential), false, 'the check rejects a correctly ordered document — it is a blanket rejector');
  assert.equal(interleaves(interleaved), true, 'the check accepts an interleaved document — it is vacuous');
});

test('ATS parse — the stylesheet never reorders content away from DOM order', () => {
  // THE ONE HAZARD THAT ACTUALLY BINDS IN THIS PIPELINE, per ef's measurement above:
  // `order:` and `flex-direction: row-reverse` are the only primitives that move the
  // PDF text layer away from DOM order.
  //
  // AND IT IS INVISIBLE. The rendered PDF looks perfect — the sections appear exactly
  // where the designer put them — while the text layer a parser reads is in a different
  // order entirely. No human reviewer can catch it, no screenshot shows it, and the
  // approval preview looks right too. That combination is what makes it worth a test of
  // its own rather than a note: it is the only layout defect in this package that a
  // person cannot see.
  //
  // `display: flex` itself is FINE and is deliberately not banned — it is used on
  // .resume__entry-head for two single-line siblings already in reading order. Banning
  // flex would be cargo-culting the refuted hazard; banning reordering is the real rule.
  assert.doesNotMatch(
    RESUME_STYLESHEET,
    /(^|[^-\w])order\s*:/m,
    'stylesheet sets `order:` — this silently reorders the PDF text layer while looking correct',
  );
  assert.doesNotMatch(
    RESUME_STYLESHEET,
    /flex-direction\s*:\s*\w*-?reverse/,
    'stylesheet reverses flex direction — this silently reorders the PDF text layer',
  );
  assert.doesNotMatch(
    RESUME_STYLESHEET,
    /flex-flow\s*:[^;]*reverse/,
    'stylesheet reverses flex flow via the shorthand',
  );
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
