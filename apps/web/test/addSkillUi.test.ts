/* T3 UI: an added skill on the approval card (TDD, 2026-10-08; slimmed 2026-11-07).
 *
 * The data layer (diffAdapter addable / addedSkills, tailoredEdits addSkill) is pinned by
 * addSkill.test.ts. This file pins what DiffView.tsx RENDERS from it on the skills line, which
 * since the 2026-11-07 slim card shows under "Changes by AI" once a skill is added:
 *   - each added skill keeps its "<name> added by you" label (no Remove: the AI chat is the only
 *     edit path now); a master skill traces to the master; Reset names skills; never click-to-type.
 * The keyword "+ Add" chips, the master-profile link and the click-to-edit text button this file
 * also pinned were removed with the slim card; diffViewSlim.test.ts pins their absence.
 *
 * Fixtures come from the REAL buildResumeDiff (same master and tailoring as addSkill.test.ts) so
 * they cannot drift from what the page actually renders. Assertions match markup SHAPE (elements,
 * classes, attributes); every absence check is paired with a positive control in the same render. */

// The .tsx loader; must be the first import so it runs before any component loads.
import './support/registerTsxHooks.ts';
// Strict asserts, so a loose == never passes a wrong shape.
import assert from 'node:assert/strict';
// The runner; before() loads modules so a missing one fails loudly once.
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

// Every <button ...>...</button> in the markup (buttons do not nest, so lazy matching is safe).
const buttons = (html: string) => [...html.matchAll(/<button\b[^>]*>[\s\S]*?<\/button>/g)].map((m) => m[0]);

describe('skills line: added skills keep their "added by you" label', () => {
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

  it('labels each added skill "added by you" with no Remove; Docker, a master skill, as a traced run that says so', () => {
    // The full DiffView: the skills line is listed under Changes by AI.
    const html = page(skillsOnly());
    // The provenance label for Docker, kept by the slim card (2026-11-07).
    assert.match(html, /<li class="line__added-skill">Docker <span class="line__added-skill-tag">added by you<\/span><\/li>/);
    // Paired absence: removal is the AI chat's job now, so no per-skill button.
    assert.equal(buttons(html).filter((b) => b.includes('Remove')).length, 0);
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
    // The skills paragraph itself, listed as a changed line.
    assert.match(html, /<p class="line__text line__text--skills">/);
    // The added skills keep list semantics despite list-style: none.
    assert.match(html, /<ul class="line__added-skills" role="list">/);
    // The old D3 note is gone as visible TEXT (a title attribute is not text, so not matched here).
    assert.doesNotMatch(html, />[^<]*skills can(?:&#x27;|')t be edited yet/i);
    // Skills are chosen, never typed: no text button on the only line rendered.
    assert.doesNotMatch(html, /class="line__text-button"/);
  });
});
