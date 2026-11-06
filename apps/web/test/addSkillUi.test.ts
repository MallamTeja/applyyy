/* T3 UI: add a missing JD keyword from the master profile, remove an added skill (TDD, 2026-10-08).
 *
 * The data layer (diffAdapter addable / addedSkills, tailoredEdits addSkill) is pinned by
 * addSkill.test.ts. This file pins what DiffView.tsx RENDERS from it:
 *   1. CoverageBar: an addable missing keyword is an "Add <name>" button; a keyword the master
 *      lacks says so and links once to /master-profile; without onEdit, today's chips (back-compat).
 *   2. Skills line: each added skill is an edited run with its own Remove; Reset names skills;
 *      no "can't be edited yet" text and never click-to-type.
 *   3. Click-to-edit a11y: the text button's name comes from its content ("Edit: " + the runs),
 *      not an aria-label that would hide the runs' spoken verdicts.
 *   4. (Removed 2026-11-01.) Add used to ask a window.confirm first. Teja ruled it redundant: an
 *      addable skill is already in the operator's own master, and addSkill() refusing any other ref
 *      (addSkill.test.ts "refuses a ref that is not a master skill") is the control that answers
 *      "do you have this skill?". A master-less skill still goes through the in-page vouch question.
 *
 * Import shape: only modules that exist today are imported in before(); every new behaviour is
 * looked up inside its own test, so a missing implementation FAILS that test instead of
 * cancelling the suite. Fixtures come from the REAL buildResumeDiff (same master and tailoring
 * as addSkill.test.ts) so they cannot drift from what the page actually renders.
 * Assertions match markup SHAPE (elements, classes, attributes); every absence check is paired
 * with a positive control in the same render. */

// The .tsx loader; must be the first import so it runs before any component loads.
import './support/registerTsxHooks.ts';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it, before } from 'node:test';

// The component under test.
let view: typeof import('../src/features/approval/DiffView.tsx');
// The real adapter, so fixtures carry exactly the addable / addedSkills shapes the page gets.
let adapter: typeof import('../src/features/approval/diffAdapter.ts');
// rebuildOriginal, the existing producer of the tailor's version.
let edits: typeof import('../src/features/approval/tailoredEdits.ts');
// Static server renderer, no DOM.
let render: (element: unknown) => string;
// Element factory, so no JSX in this .ts file.
let h: typeof import('react').createElement;
// A router context: if the master-profile link is a react-router <Link>, it throws without one.
let MemoryRouter: typeof import('react-router-dom').MemoryRouter;

before(async () => {
  // Every module here exists before T3's UI lands, so this hook cannot cancel the suite.
  view = await import('../src/features/approval/DiffView.tsx');
  // Loaded after the hooks so its extensionless imports resolve.
  adapter = await import('../src/features/approval/diffAdapter.ts');
  // Same.
  edits = await import('../src/features/approval/tailoredEdits.ts');
  // The server renderer the other render tests use.
  render = (await import('react-dom/server')).renderToStaticMarkup as (element: unknown) => string;
  // Element factory.
  h = (await import('react')).createElement;
  // Already a dependency of apps/web; harmless around a plain <a>.
  MemoryRouter = (await import('react-router-dom')).MemoryRouter;
});

// The pinned master version; the tailoring must name the same one or rebuildOriginal refuses it.
const VERSION = 3;

// The master from addSkill.test.ts: four skills, two selected, so Docker and Kubernetes are addable.
const MASTER = {
  // The profile's shape marker, not the row version.
  schema_version: 1,
  // Copied verbatim into the resume.
  identity: { full_name: 'Test Person', headline: 'Backend Engineer', email: 'test@example.com', phone: null, location: 'Hyderabad', links: [] },
  // A real summary node, so the tailored summary has something to cite.
  summary: { id: 'summary-master', text: 'Backend engineer building REST APIs in Node.js.' },
  // One employer, two bullets; "Express" in b-api is the honestly-matched keyword.
  experience: [{
    id: 'exp-acme', company: 'Acme', role: 'Backend Intern', location: 'Remote',
    start_display: 'Jun 2025', end_display: 'Aug 2025', start_date: null, end_date: null,
    bullets: [
      // Carries "Express".
      { id: 'b-api', text: 'Built a REST API with Express and Node.js handling 500 users', tags: [] },
      // A second bullet, so the page has more than one text button.
      { id: 'b-tests', text: 'Wrote unit tests for the billing service', tags: [] },
    ],
  }],
  // Empty sections are legal.
  projects: [], education: [], achievements: [], certifications: [],
  // Docker and Kubernetes are unselected, so the UI can offer them.
  skills: [
    // Selected.
    { id: 'skill-node', name: 'Node.js', category: 'Frameworks' },
    // NOT selected: the skill these tests add.
    { id: 'skill-docker', name: 'Docker', category: 'Tools' },
    // Selected.
    { id: 'skill-pg', name: 'PostgreSQL', category: 'Databases' },
    // NOT selected.
    { id: 'skill-k8s', name: 'Kubernetes', category: 'Tools' },
  ],
  // Profile-level links, empty.
  links: [],
} as never;

// What the Tailor returned (tailor_refs), as in addSkill.test.ts.
const TAILOR_REFS = {
  // The contract's shape marker.
  schema_version: 1,
  // Matches VERSION, else rebuildOriginal returns null.
  master_version: VERSION,
  // Print order.
  section_order: ['summary', 'experience', 'skills'],
  // Prose citing the master summary.
  summary: { text: 'Backend engineer shipping REST APIs in Node.js.', refs: ['summary-master'] },
  // Two of four master skills chosen.
  skills: [{ ref: 'skill-node' }, { ref: 'skill-pg' }],
  // Both bullets, verbatim.
  experience: [{ ref: 'exp-acme', bullets: [
    // Verbatim.
    { ref: 'b-api', text: 'Built a REST API with Express and Node.js handling 500 users' },
    // Verbatim.
    { ref: 'b-tests', text: 'Wrote unit tests for the billing service' },
  ] }],
  // Required arrays.
  projects: [], education: [], achievements: [], certifications: [],
};

// The exact master copy an honest add of Docker produces.
const DOCKER = { ref: 'skill-docker', name: 'Docker', category: 'Tools' };

// Plain-data resume type for local mutation.
type Resume = import('../src/data/contract').ResolvedResume;
// The diff the adapter returns.
type Diff = import('../src/features/approval/diffModel.ts').ResumeDiff;

// The tailor's resume; a null is a fixture bug, named as such.
const original = (): Resume => {
  // The existing producer, so this cannot fail just because T3's UI is missing.
  const resume = edits.rebuildOriginal(TAILOR_REFS, MASTER, VERSION);
  // Loud, so every later failure is not a confusing null read.
  assert.notEqual(resume, null, 'fixture must rebuild to a ResolvedResume');
  // Narrowed.
  return resume!;
};

// The original with Docker appended by hand, so these tests do not depend on addSkill().
const withDocker = (): Resume => {
  // Deep copy; JSON is enough for plain data.
  const current = JSON.parse(JSON.stringify(original())) as { skills: unknown[] };
  // Appended, as addSkill would.
  current.skills.push(DOCKER);
  // Retyped.
  return current as unknown as Resume;
};

// The diff the page would build for this resume and these JD keywords.
const diffOf = (resolved: Resume, keywords: string[]): Diff =>
  adapter.buildResumeDiff({
    // Minimal row: id, pin, no findings, the JD keywords.
    application: { id: 'app-1', master_version: VERSION, audit_findings: [], selected_jd_keywords: keywords } as never,
    // Header fields only.
    job: { title: 'Backend Engineer', company_name: 'Acme' } as never,
    // What tailored_profile holds now.
    resolved,
    // The pinned master.
    master: MASTER,
    // The tailor's version, so editing is on (not D4).
    original: original(),
  } as never);

// A save path that always succeeds; static render never calls it.
const onEdit = async () => ({ ok: true });

// Renders any element inside a router, so a <Link> renders instead of throwing.
const inRouter = (element: unknown) => render(h(MemoryRouter, null, element as never));

// CoverageBar with the given extra props (onEdit, busy) or none.
const bar = (diff: Diff, extra: Record<string, unknown> = {}) => inRouter(h(view.CoverageBar, { diff, ...extra } as never));

// The full DiffView screen, editing on.
const page = (diff: Diff) =>
  inRouter(
    h(view.DiffView, {
      diff,
      // Required callbacks, never called in a static render.
      onApprove: () => undefined,
      // Same.
      onReject: () => undefined,
      // A save path exists, so this is an editing screen.
      onEdit,
    } as never),
  );

// Visible text of a markup fragment: tags dropped, the one entity these strings use decoded.
const textOf = (html: string) => html.replace(/<[^>]*>/g, '').replace(/&#x27;/g, "'");

// Every <button ...>...</button> in the markup (buttons do not nest, so lazy matching is safe).
const buttons = (html: string) => [...html.matchAll(/<button\b[^>]*>[\s\S]*?<\/button>/g)].map((m) => m[0]);

describe('CoverageBar: missing keywords become actions when editing is on', () => {
  it('an addable missing keyword is an "Add <name>" button naming the master profile', () => {
    // Docker is missing and the master has it unselected; Express is honestly matched.
    const diff = diffOf(original(), ['Express', 'Docker']);
    // Precondition from the data layer: the adapter offers Docker.
    assert.deepEqual(diff.coverage.addable?.get('Docker'), { ref: 'skill-docker', name: 'Docker' });
    // Rendered with a save path.
    const html = bar(diff, { onEdit, busy: false });
    // The addable chip, as a real button.
    const chip = buttons(html).find((b) => /^<button\b[^>]*class="[^"]*\bkw-chip--addable\b/.test(b));
    // Named, so the report says what is missing.
    assert.ok(chip, 'expected a <button class="... kw-chip--addable">');
    // Non-submitting.
    assert.match(chip, /^<button\b[^>]*type="button"/);
    // Named by its content (WCAG 2.5.3): an aria-label would replace the visible words.
    assert.doesNotMatch(chip.match(/^<button\b[^>]*>/)![0], /aria-label=/);
    // The action part is its own accent pill, so the chip reads as a control at rest.
    assert.match(chip, /<span class="kw-chip__add">＋ Add Docker<\/span>/);
    // Then the spoken-only provenance suffix.
    assert.match(chip, /<span class="visually-hidden"> from your master profile<\/span><\/button>$/);
    // So the accessible name (the text content) holds the visible words and says where the skill comes from.
    assert.match(textOf(chip), /^✕ Docker ＋ Add Docker from your master profile$/);
  });

  it('renders a polite role="status" region for the "Added <name>" announcement', () => {
    // The add's chip unmounts on success, so this region is the only thing that says it landed.
    const html = bar(diffOf(original(), ['Express', 'Docker']), { onEdit, busy: false });
    // Mounted empty from the first render, so a screen reader is already watching it when text arrives.
    assert.match(html, /<p class="visually-hidden" role="status"><\/p>/);
    // And the announcement text is written on success (source shape: a static render cannot click).
    assert.match(view.CoverageBar.toString(), /Added \$\{skill\.name\} to this resume/);
  });

  it('draws one chip per distinct keyword and no chip for a blank keyword', () => {
    // A real measured diff, then a coverage with repeats and blanks the adapter might pass through.
    const base = diffOf(original(), ['Express', 'Rust']);
    // Duplicate matched and missing keywords, an empty and a whitespace-only keyword.
    const diff = { ...base, coverage: { ...base.coverage, honestlyMatched: ['Express', 'Express'], jdKeywords: ['Express', 'Rust', 'Rust', '', '  '] } } as Diff;
    // Read-only bar: missing chips are plain spans, the simplest shape to count.
    const html = bar(diff);
    // Every missing chip's visible text.
    const missing = [...html.matchAll(/<span class="kw-chip kw-chip--missing"[^>]*>([\s\S]*?)<\/span>/g)].map((m) => textOf(m[1]!).trim());
    // Exactly one, for Rust: no duplicate and no empty "✕".
    assert.deepEqual(missing, ['✕ Rust']);
    // Every matched chip's visible text.
    const matched = [...html.matchAll(/<span class="kw-chip kw-chip--matched"[^>]*>([\s\S]*?)<\/span>/g)].map((m) => textOf(m[1]!).trim());
    // Exactly one Express chip, so no colliding React key either.
    assert.deepEqual(matched, ['✓ Express']);
  });

  it('a keyword the master lacks is a plain span, and the bar links ONCE to the master profile', () => {
    // Rust and Haskell are in no master skill; two of them prove the link is not per keyword.
    const diff = diffOf(original(), ['Express', 'Rust', 'Haskell']);
    // Precondition: the adapter says "not in master" for both.
    assert.equal(diff.coverage.addable?.get('Rust'), null);
    // Same for the second.
    assert.equal(diff.coverage.addable?.get('Haskell'), null);
    // Rendered with a save path.
    const html = bar(diff, { onEdit, busy: false });
    // The chip says why it cannot be added, on a span.
    assert.match(html, /<span\b[^>]*title="Not in your master profile"[^>]*>(?:(?!<\/span>)[\s\S])*Rust/);
    // And it is not a button: nothing to click that could add a synthetic skill.
    assert.equal(buttons(html).filter((b) => textOf(b).includes('Rust')).length, 0);
    // Every link to the master profile in the bar.
    const links = [...html.matchAll(/<a\b[^>]*href="\/master-profile"[^>]*>([\s\S]*?)<\/a>/g)];
    // Exactly one, however many keywords are missing from the master.
    assert.equal(links.length, 1, `expected one /master-profile link, got ${links.length}`);
    // Saying what to do there.
    assert.equal(textOf(links[0]![1]!).trim(), 'Add missing skills to your master profile');
  });

  it('without onEdit the bar is unchanged: missing chips are "Missing from resume" spans, no Add button', () => {
    // The same addable diff as the first test.
    const diff = diffOf(original(), ['Express', 'Docker']);
    // Rendered as coverageUnmeasured.test.ts renders it: diff only.
    const html = bar(diff);
    // Positive control: today's missing chip, carrying Docker.
    assert.match(html, /<span\b[^>]*title="Missing from resume"[^>]*>(?:(?!<\/span>)[\s\S])*Docker/);
    // No add affordance on a read-only screen.
    assert.doesNotMatch(html, /kw-chip--addable/);
  });
});

describe('skills line: added skills are the operator\'s, removable one by one', () => {
  // A diff holding ONLY the skills line, so "no text button" is about this line and nothing else.
  const skillsOnly = (): Diff => {
    // The real diff with Docker added.
    const diff = diffOf(withDocker(), ['Express', 'Docker']);
    // The skills line the adapter built.
    const skills = diff.lines.find((l) => l.kind === 'skills');
    // Missing is a fixture failure, named.
    assert.ok(skills, 'no skills line');
    // Preconditions: the adapter marks it edited, targetable, with Docker as added.
    assert.equal(skills.editState, 'edited');
    // Selection-editable.
    assert.deepEqual(skills.editTarget, { kind: 'skills' });
    // The added list the UI renders from.
    assert.deepEqual(skills.addedSkills, [{ ref: 'skill-docker', name: 'Docker' }]);
    // Same diff, one line; editCount kept consistent with it.
    return { ...diff, lines: [skills], editCount: 1 };
  };

  it('renders a Remove button per added skill; Docker, a master skill, as a traced run that says so', () => {
    // The full DiffView, split view by default.
    const html = page(skillsOnly());
    // The Remove control for Docker.
    const remove = buttons(html).find((b) => /^<button\b[^>]*aria-label="Remove Docker, added by you"/.test(b));
    // Named.
    assert.ok(remove, 'expected a button aria-label="Remove Docker, added by you"');
    // Non-submitting.
    assert.match(remove, /^<button\b[^>]*type="button"/);
    /* Bug d (Teja 2026-11-06): an added skill that is in the master is the owner's own skill, so it traces to
       the master and says so; it used to read "edited by you, not checked against the master". The
       not-in-master case, which stays edited, is pinned in skillsGroupedDiff.test.ts. */
    assert.match(html, /<span class="run run--traced[^"]*"[^>]*>Docker<span class="visually-hidden"> — traced to your master skills<\/span>/);
    // Paired absence: not an edited run.
    assert.doesNotMatch(html, /<span class="run run--edited[^"]*"[^>]*>[^<]*\bDocker\b/);
    // Positive control for the traced check: the tailor's own skills ARE traced.
    assert.match(html, /<span class="run run--traced[^"]*"[^>]*>[^<]*Node\.js/);
  });

  it('offers Reset for skills, drops the "can\'t be edited yet" note, and is never click-to-type', () => {
    // Same skills-only screen.
    const html = page(skillsOnly());
    // Reset's visible words, then a spoken-only "(skills)" (straight or typographic apostrophe accepted).
    const reset = buttons(html).find((b) => /^<button\b[^>]*>Reset to tailor(?:&#x27;|’)s version<span class="visually-hidden"> \(skills\)<\/span><\/button>$/.test(b));
    // Positive: the line IS editable here, and the name is its content.
    assert.ok(reset, 'expected a Reset button "Reset to tailor\'s version" + hidden " (skills)"');
    // No aria-label, so the accessible name contains the visible label (WCAG 2.5.3).
    assert.doesNotMatch(reset.match(/^<button\b[^>]*>/)![0], /aria-label=/);
    // Focus has a home when Remove/Reset unmounts: the skills paragraph is script-focusable.
    assert.match(html, /<p class="line__text line__text--skills"[^>]*\btabindex="-1"/);
    // The added skills keep list semantics despite list-style: none.
    assert.match(html, /<ul class="line__added-skills" role="list">/);
    // The old D3 note is gone as visible TEXT (a title attribute is not text, so not matched here).
    assert.doesNotMatch(html, />[^<]*skills can(?:&#x27;|')t be edited yet/i);
    // Skills are chosen, never typed: no text button on the only line rendered.
    assert.doesNotMatch(html, /class="line__text-button"/);
  });
});

describe('click-to-edit: the text button is named by its content', () => {
  it('a bullet text button has no aria-label, starts with a hidden "Edit: ", and keeps the verdict inside', () => {
    // The tailor's untouched resume; its bullets are click-to-edit.
    const html = page(diffOf(original(), ['Express']));
    // The b-api bullet's text button, whole.
    const button = buttons(html).find((b) => /^<button\b[^>]*class="line__text-button"/.test(b) && b.includes('Built a REST API'));
    // Positive: the button exists.
    assert.ok(button, 'expected a button.line__text-button for the b-api bullet');
    // Its opening tag.
    const tag = button.match(/^<button\b[^>]*>/)![0];
    // No aria-label: it would override the content and silence the runs' verdicts.
    assert.doesNotMatch(tag, /aria-label=/);
    // The first child is the hidden verb, so the accessible name reads "Edit: <the text>".
    assert.match(button, /^<button\b[^>]*><span class="visually-hidden">Edit: <\/span>/);
    // The traced run's spoken verdict is still inside the button.
    assert.match(button, /<span class="visually-hidden"> — traced to b-api<\/span>/);
  });
});

