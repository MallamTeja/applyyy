/* Tests for the Master Profile page's "+ Add" builder (masterAdd.ts).
 *
 * WHAT THESE PROTECT. addToMaster decides what master version N+1 is. Its failure modes are
 * silent: a node appended to the wrong section, an existing node dropped, a javascript: link
 * stored, a blank required field reaching the database, or the ingest gate skipped so a
 * duplicate id is stored. Each test below pins one of those. saveMasterAddition (the
 * read-then-insert) is not tested here: its two calls are masterStore's, tested there.
 *
 * RUN: `node --test test/masterAdd.test.ts` from apps/web. */

// Strict asserts: deepEqual without strict would pass on 1 == '1'.
import assert from 'node:assert/strict';
// The resolver hook, for the source's extensionless imports.
import { registerHooks } from 'node:module';
// The runner; before() loads the module after the hook is in place.
import { before, describe, it } from 'node:test';

// Same resolver as the approval tests: the modules use extensionless relative imports.
registerHooks({
  // Extensionless RELATIVE imports only: try the original, then .ts.
  resolve(specifier, context, nextResolve) {
    // Packages and already-extended paths resolve normally.
    if (!specifier.startsWith('.') || /\.[cm]?[jt]sx?$|\.css$/.test(specifier)) return nextResolve(specifier, context);
    // First the way Vite would write it.
    try { return nextResolve(specifier, context); } catch { /* fall through to .ts */ }
    // A plain module is the only kind these imports name.
    return nextResolve(`${specifier}.ts`, context);
  },
});

// The module under test, loaded after the hook.
let add: typeof import('../src/features/settings/masterAdd.ts');

before(async () => {
  // Loaded here so its own extensionless imports resolve.
  add = await import('../src/features/settings/masterAdd.ts');
});

/* A deterministic minter: `<prefix>-<n>`, so a test can name the ids it expects. */
function counterMint(): (prefix: string) => string {
  // Shared across calls so every id differs.
  let n = 0;
  // Prefix keeps the kind readable in failure output.
  return (prefix) => `${prefix}-${String(++n)}`;
}

/* A small valid master, one node per section. `.invalid` TLD so no URL can be real. */
function base(): any {
  return {
    // The only accepted shape version.
    schema_version: 1,
    // Name and email are the required identity fields.
    identity: { full_name: 'Test Person', headline: null, email: 'test@example.invalid', phone: null, location: null, links: [{ id: 'link-0', label: 'GitHub', url: 'https://example.invalid/g' }] },
    // A real summary node; individual tests null it.
    summary: { id: 'summary-0', text: 'A paragraph.' },
    // One of each bulleted section, each with a tagged bullet so the base draws no advisories.
    education: [{ id: 'edu-0', institution: 'ExampleU', degree: 'BTech', field: null, start_display: '2022', end_display: '2026', start_date: null, end_date: null, grade_display: null, bullets: [{ id: 'edu-0-b', text: 'Studied', tags: ['study'] }] }],
    // Same.
    experience: [{ id: 'exp-0', company: 'ExampleCo', role: 'Intern', location: null, start_display: 'Jan 2025', end_display: 'Present', start_date: null, end_date: null, bullets: [{ id: 'exp-0-b', text: 'Did a thing', tags: ['node'] }] }],
    // Same.
    projects: [{ id: 'proj-0', name: 'Thing', links: [], start_display: '2025', end_display: '2025', start_date: null, end_date: null, bullets: [{ id: 'proj-0-b', text: 'Built it', tags: ['react'] }] }],
    // One skill.
    skills: [{ id: 'skill-0', name: 'TypeScript', category: 'Languages' }],
    // One of each undated section.
    achievements: [{ id: 'ach-0', label: 'Won', description: null, bullets: [] }],
    // Same.
    certifications: [{ id: 'cert-0', label: 'Certified', description: 'Issuer', bullets: [] }],
    // Top-level links.
    links: [],
  };
}

describe('addToMaster appends one node to the right section and keeps the rest', () => {
  it('adds a skill last, with the typed name and group', () => {
    // The base, kept for the no-mutation check.
    const before = base();
    // A frozen copy to compare against afterwards.
    const snapshot = structuredClone(before);
    // The add under test.
    const result = add.addToMaster(before, 'skill', { name: ' Kubernetes ', category: 'DevOps & Cloud' }, counterMint());
    // Must pass the ingest gate.
    assert.equal(result.ok, true);
    // Narrowing for the compiler.
    if (!result.ok) return;
    // Existing skill first, new one last, trimmed.
    assert.deepEqual(result.profile.skills, [snapshot.skills[0], { id: 'skill-1', name: 'Kubernetes', category: 'DevOps & Cloud' }]);
    // The input object is untouched: the page's state must not change before the insert lands.
    assert.deepEqual(before, snapshot);
    // No other section moved.
    assert.deepEqual(result.profile.experience, snapshot.experience);
  });

  it('adds an experience with bullets and trailing #tags, blank location as null', () => {
    // A role with two bullet lines; the second has a mid-text '#1' that must stay text.
    const result = add.addToMaster(base(), 'experience', { role: 'Engineer', company: 'Acme', location: '  ', start_display: 'May 2026', end_display: 'Present', bullets: 'Built APIs #fastapi #postgres\n\nRanked #1 of 300 teams' }, counterMint());
    // Must pass the gate.
    assert.equal(result.ok, true);
    // Narrowing.
    if (!result.ok) return;
    // The appended role.
    const added = result.profile.experience[1];
    // Bullets minted before the parent (parseBullets runs first), so bullet-1, bullet-2, exp-3.
    assert.deepEqual(added, { id: 'exp-3', role: 'Engineer', company: 'Acme', location: null, start_display: 'May 2026', end_display: 'Present', start_date: null, end_date: null, bullets: [{ id: 'bullet-1', text: 'Built APIs', tags: ['fastapi', 'postgres'] }, { id: 'bullet-2', text: 'Ranked #1 of 300 teams', tags: [] }] });
  });

  it('adds a project with only the links that were filled', () => {
    // GitHub filled, live demo blank.
    const result = add.addToMaster(base(), 'project', { name: 'New', start_display: '2026', end_display: 'Present', live_url: '', github_url: 'https://example.invalid/repo' }, counterMint());
    // Must pass the gate.
    assert.equal(result.ok, true);
    // Narrowing.
    if (!result.ok) return;
    // One link, labelled GitHub.
    assert.deepEqual(result.profile.projects[1]?.links, [{ id: 'link-1', label: 'GitHub', url: 'https://example.invalid/repo' }]);
  });

  it('adds education, a certification, an achievement and an identity link to their own sections', () => {
    // Each kind once, with a shared minter so ids never collide.
    const mint = counterMint();
    // Education with a grade.
    const edu = add.addToMaster(base(), 'education', { degree: 'MTech', institution: 'U2', start_display: '2027', end_display: '2029', grade_display: '9.0 CGPA' }, mint);
    // Certification with no description.
    const cert = add.addToMaster(base(), 'certification', { label: 'AWS CCP' }, mint);
    // Achievement with detail.
    const ach = add.addToMaster(base(), 'achievement', { label: 'Top 20%', description: 'of 25,000 teams' }, mint);
    // Identity link.
    const link = add.addToMaster(base(), 'link', { label: 'LinkedIn', url: 'https://example.invalid/in' }, mint);
    // All pass the gate.
    assert.ok(edu.ok && cert.ok && ach.ok && link.ok);
    // Field null when blank, grade kept.
    assert.equal(edu.profile.education[1]?.field, null);
    // Grade printed verbatim.
    assert.equal(edu.profile.education[1]?.grade_display, '9.0 CGPA');
    // Description null when blank.
    assert.equal(cert.profile.certifications[1]?.description, null);
    // Achievement lands in achievements, not certifications.
    assert.equal(ach.profile.achievements[1]?.label, 'Top 20%');
    // Certifications unchanged by the achievement add.
    assert.equal(ach.profile.certifications.length, 1);
    // The link lands under identity.
    assert.equal(link.profile.identity.links[1]?.label, 'LinkedIn');
  });

  it('adds a summary only when there is none', () => {
    // A master without a summary.
    const empty = { ...base(), summary: null };
    // Accepted.
    const first = add.addToMaster(empty, 'summary', { text: 'Hello.' }, counterMint());
    // The new node.
    assert.deepEqual(first.ok && first.profile.summary, { id: 'summary-1', text: 'Hello.' });
    // A master that already has one: refused, never silently replaced.
    const second = add.addToMaster(base(), 'summary', { text: 'Other.' }, counterMint());
    // The refusal says why.
    assert.deepEqual(second, { ok: false, message: 'A summary already exists.' });
  });
});

describe('addToMaster refuses before anything is written', () => {
  it('names the blank required field', () => {
    // Category is blank.
    const result = add.addToMaster(base(), 'skill', { name: 'Go', category: '   ' }, counterMint());
    // Refused with the field's label.
    assert.deepEqual(result, { ok: false, message: 'Group is required.' });
  });

  it('refuses a javascript: link in identity and in a project', () => {
    // An identity link that would execute on click.
    const link = add.addToMaster(base(), 'link', { label: 'x', url: 'javascript:alert(1)' }, counterMint());
    // Refused.
    assert.equal(link.ok, false);
    // A project link with a data: URL.
    const proj = add.addToMaster(base(), 'project', { name: 'p', start_display: '1', end_display: '2', live_url: 'data:text/html,hi' }, counterMint());
    // Refused.
    assert.equal(proj.ok, false);
  });

  it('runs the ingest gate: a duplicate id is refused, not stored', () => {
    // A broken minter that repeats an id already in the base.
    const result = add.addToMaster(base(), 'skill', { name: 'Go', category: 'Languages' }, () => 'skill-0');
    // The gate's duplicate-id check fired; only the gate can produce this refusal.
    assert.equal(result.ok, false);
    // The message carries the gate's path.
    assert.match(result.ok ? '' : result.message, /skills/);
  });
});

describe('parseBullets', () => {
  it('keeps a line that is only a tag as text, and drops blank lines', () => {
    // A tag-only line and blank lines.
    const bullets = add.parseBullets('\n#solo\n   \n', counterMint());
    // One bullet, the tag kept as its text rather than an empty bullet.
    assert.deepEqual(bullets, [{ id: 'bullet-1', text: '#solo', tags: [] }]);
  });
});
