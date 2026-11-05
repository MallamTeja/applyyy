/* R4 (2026-11-05): the approval screen prints the tailored skills GROUPED, the way the PDF does.
 *
 * Before this, DiffView drew the skills line as one flat comma list in resume order, while
 * packages/resume-template/src/render-resume-html.ts renderSkills prints one "Category: a, b" row
 * per group, groups in first-appearance order. So the operator approved a layout the PDF never
 * printed. These tests pin the POSITIVE shape: the group labels in order, each group's skills
 * under it, and the per-skill traced/edited marking kept inside its group. The order is checked
 * against the REAL renderer's output, so the screen and the PDF cannot drift apart silently.
 *
 * Fixtures come from the REAL buildResumeDiff (as addSkillUi.test.ts does), so they carry the exact
 * printedSkills / addedSkills shapes the page gets. */

// The .tsx loader; must be the first import so it runs before any component loads.
import './support/registerTsxHooks.ts';
// Strict asserts, so a loose == can never pass a wrong shape.
import assert from 'node:assert/strict';
// The runner; before() loads modules so a missing one fails loudly once.
import { describe, it, before } from 'node:test';
// The PDF's own renderer, by relative path (no new dependency), as resumePreview.test.ts imports it.
import { renderResumeHtml } from '../../../packages/resume-template/src/index.ts';

// The component under test.
let view: typeof import('../src/features/approval/DiffView.tsx');
// The real adapter, so the skills line is the one the page builds.
let adapter: typeof import('../src/features/approval/diffAdapter.ts');
// rebuildOriginal, the existing producer of the tailor's version.
let edits: typeof import('../src/features/approval/tailoredEdits.ts');
// Static server renderer, no DOM.
let render: (element: unknown) => string;
// Element factory, so no JSX in this .ts file.
let h: typeof import('react').createElement;
// A router context: the coverage bar may render a react-router <Link>.
let MemoryRouter: typeof import('react-router-dom').MemoryRouter;

before(async () => {
  // Loaded after the hooks so its .tsx imports resolve.
  view = await import('../src/features/approval/DiffView.tsx');
  // Same.
  adapter = await import('../src/features/approval/diffAdapter.ts');
  // Same.
  edits = await import('../src/features/approval/tailoredEdits.ts');
  // The server renderer the other render tests use.
  render = (await import('react-dom/server')).renderToStaticMarkup as (element: unknown) => string;
  // Element factory.
  h = (await import('react')).createElement;
  // Already a dependency of apps/web.
  MemoryRouter = (await import('react-router-dom')).MemoryRouter;
});

// The pinned master version; the tailoring must name the same one or rebuildOriginal refuses it.
const VERSION = 3;

// A master whose groups INTERLEAVE in print order, so a flat list and a grouped one differ.
const MASTER = {
  // The profile's shape marker.
  schema_version: 1,
  // Copied verbatim into the resume.
  identity: { full_name: 'Test Person', headline: 'Backend Engineer', email: 'test@example.com', phone: null, location: 'Hyderabad', links: [] },
  // A summary node for the tailored summary to cite.
  summary: { id: 'summary-master', text: 'Backend engineer building REST APIs in Node.js.' },
  // One bullet, so the resume is a whole resume.
  experience: [{
    id: 'exp-acme', company: 'Acme', role: 'Backend Intern', location: 'Remote',
    start_display: 'Jun 2025', end_display: 'Aug 2025', start_date: null, end_date: null,
    bullets: [{ id: 'b-api', text: 'Built a REST API with Express and Node.js', tags: [] }],
  }],
  // Empty sections are legal.
  projects: [], education: [], achievements: [], certifications: [],
  // Frameworks, Databases, Frameworks again, then Tools (unselected, added by the operator).
  skills: [
    // Selected: opens the Frameworks group.
    { id: 'skill-node', name: 'Node.js', category: 'Frameworks' },
    // Selected: opens the Databases group.
    { id: 'skill-pg', name: 'PostgreSQL', category: 'Databases' },
    // Selected: printed AFTER PostgreSQL but belongs back under Frameworks.
    { id: 'skill-express', name: 'Express', category: 'Frameworks' },
    // NOT selected by the tailor: the operator's addition.
    { id: 'skill-docker', name: 'Docker', category: 'Tools' },
  ],
  // Profile-level links, empty.
  links: [],
} as never;

// What the Tailor returned: three skills in an interleaved order.
const TAILOR_REFS = {
  // The contract's shape marker.
  schema_version: 1,
  // Matches VERSION, else rebuildOriginal returns null.
  master_version: VERSION,
  // Print order.
  section_order: ['summary', 'experience', 'skills'],
  // Prose citing the master summary.
  summary: { text: 'Backend engineer shipping REST APIs in Node.js.', refs: ['summary-master'] },
  // Node.js, PostgreSQL, Express: Frameworks is split by Databases in resume order.
  skills: [{ ref: 'skill-node' }, { ref: 'skill-pg' }, { ref: 'skill-express' }],
  // The one bullet, verbatim.
  experience: [{ ref: 'exp-acme', bullets: [{ ref: 'b-api', text: 'Built a REST API with Express and Node.js' }] }],
  // Required arrays.
  projects: [], education: [], achievements: [], certifications: [],
};

// Plain-data resume type for local mutation.
type Resume = import('../src/data/contract').ResolvedResume;
// The diff the adapter returns.
type Diff = import('../src/features/approval/diffModel.ts').ResumeDiff;

// The tailor's resume; a null is a fixture bug, named as such.
const original = (): Resume => {
  // The existing producer of the tailor's version.
  const resume = edits.rebuildOriginal(TAILOR_REFS, MASTER, VERSION);
  // Loud, so later failures are not a confusing null read.
  assert.notEqual(resume, null, 'fixture must rebuild to a ResolvedResume');
  // Narrowed.
  return resume!;
};

// The tailor's resume with Docker appended, as addSkill would leave it.
const withDocker = (): Resume => {
  // Deep copy; JSON is enough for plain data.
  const current = JSON.parse(JSON.stringify(original())) as { skills: unknown[] };
  // The exact master copy an honest add produces.
  current.skills.push({ ref: 'skill-docker', name: 'Docker', category: 'Tools' });
  // Retyped.
  return current as unknown as Resume;
};

/* The diff the page would build. Editing is on when an original exists (the default); pass null for a
   D4 row, which has no tailor version to compare against. */
const diffOf = (resolved: Resume, tailorVersion: Resume | null = original()): Diff =>
  adapter.buildResumeDiff({
    // Minimal row: id, pin, no findings, no JD keywords.
    application: { id: 'app-1', master_version: VERSION, audit_findings: [], selected_jd_keywords: [] } as never,
    // Header fields only.
    job: { title: 'Backend Engineer', company_name: 'Acme' } as never,
    // What tailored_profile holds now.
    resolved,
    // The pinned master.
    master: MASTER,
    // The tailor's version (null = D4); the skills line carries printedSkills either way.
    original: tailorVersion,
  } as never);

// The full DiffView (split view, the default), with a save path so the skills line is editable.
const page = (diff: Diff) =>
  render(
    h(MemoryRouter, null, h(view.DiffView, {
      diff,
      // Required callbacks, never called in a static render.
      onApprove: () => undefined,
      // Same.
      onReject: () => undefined,
      // A save path exists, so this is an editing screen.
      onEdit: async () => ({ ok: true }),
    } as never) as never),
  );

// Visible text of a fragment: tags dropped, then the spoken-only verdict suffixes dropped.
const visible = (html: string) =>
  html
    // Drop every visually-hidden span with its text: it is spoken, not printed.
    .replace(/<span class="visually-hidden">[^<]*<\/span>/g, '')
    // Then every remaining tag.
    .replace(/<[^>]*>/g, '');

// The tailored skills paragraph of the split view (the one with tabindex, unique to the Line).
const skillsParagraph = (html: string): string => {
  // The skills <p> on the tailored side; the master side carries no tabindex.
  const match = html.match(/<p class="line__text line__text--skills"[^>]*tabindex="-1"[^>]*>([\s\S]*?)<\/p>/);
  // Missing is a failure in itself, named.
  assert.ok(match, 'expected the tailored skills paragraph');
  // Its inner markup.
  return match[1]!;
};

// Each group of a skills fragment as "Label: a, b", in order, from its line__skill-group spans.
const groupsOf = (fragment: string): string[] =>
  // Split at each group's opening tag: groups do not nest, so each piece is one group's markup.
  fragment
    .split('<span class="line__skill-group">')
    // The piece before the first group is not a group (and is empty when grouping is on).
    .slice(1)
    // The visible text is exactly what a reader sees on that row.
    .map((piece) => visible(piece).trim());

// The PDF's groups, "Label: a, b", from the real renderer's resume__skill-group rows.
const pdfGroupsOf = (resume: Resume): string[] =>
  // One div per group in the PDF's HTML.
  [...renderResumeHtml(resume as never).matchAll(/<div class="resume__skill-group">([\s\S]*?)<\/div>/g)]
    // Same visible-text reading as the screen's, so the two compare like for like.
    .map((m) => visible(m[1]!).replace(/&#x27;/g, "'").trim());

describe('skills line: grouped like the PDF', () => {
  it('shows the group labels in first-appearance order, each with its skills under it', () => {
    // The tailor's untouched resume.
    const html = page(diffOf(original()));
    // The split view's tailored skills paragraph.
    const groups = groupsOf(skillsParagraph(html));
    // Frameworks first (Node.js opened it), Express pulled back under it, then Databases.
    assert.deepEqual(groups, ['Frameworks: Node.js, Express', 'Databases: PostgreSQL']);
  });

  it('matches the groups the PDF renderer prints for the same resume, added skill included', () => {
    // The resume with the operator's Docker on it.
    const resolved = withDocker();
    // What the screen draws.
    const screen = groupsOf(skillsParagraph(page(diffOf(resolved))));
    // What the PDF prints.
    const pdf = pdfGroupsOf(resolved);
    // Positive control: the PDF really is grouped (three rows), so equality is not vacuous.
    assert.deepEqual(pdf, ['Frameworks: Node.js, Express', 'Databases: PostgreSQL', 'Tools: Docker']);
    // Same rows, same order.
    assert.deepEqual(screen, pdf);
  });

  it('keeps the per-skill marking inside its group: tailor skills traced, the added one edited', () => {
    // Docker added by the operator.
    const fragment = skillsParagraph(page(diffOf(withDocker())));
    // Express sits in a traced run inside the Frameworks group.
    assert.match(fragment, /<span class="line__skill-group"><strong>Frameworks:<\/strong> (?:(?!line__skill-group)[\s\S])*<span class="run run--traced">Express</);
    // Docker sits in an edited run inside the Tools group.
    assert.match(fragment, /<span class="line__skill-group"><strong>Tools:<\/strong> (?:(?!line__skill-group)[\s\S])*<span class="run run--edited">Docker</);
    // Paired absence: Docker is never traced.
    assert.doesNotMatch(fragment, /<span class="run run--traced">Docker</);
  });

  it('leaves the per-skill Remove control and the Reset in place', () => {
    // Docker added, so both controls should show.
    const html = page(diffOf(withDocker()));
    // The added skill's own Remove, unchanged by grouping.
    assert.match(html, /<button\b[^>]*aria-label="Remove Docker, added by you"/);
    // Reset still names the skills line.
    assert.match(html, /Reset to tailor(?:&#x27;|’)s version<span class="visually-hidden"> \(skills\)<\/span>/);
  });

  it('a D4 row (no original) groups its skills too, every skill traced as the D4 line always was', () => {
    // A D4 row: the stored resume with no tailor version to compare it to.
    const html = page(diffOf(original(), null));
    /* A D4 line is read-only, so its <p> has no tabindex for skillsParagraph to key on. The tailored
       side is the skills <p> holding run spans; the master side is plain text. */
    const fragment = [...html.matchAll(/<p class="line__text line__text--skills"[^>]*>([\s\S]*?)<\/p>/g)].map((m) => m[1]!).find((inner) => inner.includes('class="run run--'));
    // Missing is a failure in itself, named.
    assert.ok(fragment !== undefined, 'expected the tailored skills paragraph of the D4 row');
    // What the PDF prints for the same resume.
    const pdf = pdfGroupsOf(original());
    // Positive control: the PDF really prints two rows, so the equality below is not vacuous.
    assert.deepEqual(pdf, ['Frameworks: Node.js, Express', 'Databases: PostgreSQL']);
    // Same rows, same order: a D4 row no longer shows a layout the PDF never prints.
    assert.deepEqual(groupsOf(fragment), pdf);
    // D4 marking kept: every skill is a traced run, as the D4 line's one run always was.
    for (const name of ['Node.js', 'PostgreSQL', 'Express']) assert.ok(fragment.includes(`<span class="run run--traced">${name}<`), `${name} must be traced`);
    // Paired absence: nothing on a D4 line reads as edited, since no edit can be told apart there.
    assert.doesNotMatch(fragment, /run--edited/);
  });
});
