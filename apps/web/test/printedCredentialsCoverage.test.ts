/* A JD keyword printed in a CERTIFICATION title counts as honestly matched (task C item 3,
 * 2026-10-09; QA item 3 of 2026-10-08: "SQL and Relational Databases" printed under
 * Certifications, yet "SQL" read missing and the page offered "+ Add SQL").
 *
 * Contract under test, keywordAppearsInPrintedCredentials(keyword, resolved, master) in
 * diffAdapter.ts: true ONLY when a certification/achievement entry is
 *   - in a section that resolved.section_order names (printed, as the renderer decides),
 *   - backed by a master node with the same ref,
 *   - carrying a label (or non-null description) EQUAL to the master's, and
 *   - containing the keyword by the producer's word-bounded rule.
 * Every negative below flips exactly ONE of those conditions on a fixture whose positive passes,
 * so each false is caused by the condition it names and not by a broken fixture.
 *
 * Then the same fact through buildResumeDiff: the keyword lands in honestlyMatched (not in
 * matchedByEdit/matchedByFabrication) and gets no "+ Add" chip, while the same diff without
 * Certifications in section_order DOES offer the chip, proving the guard is what removed it.
 *
 * Fixture: generic placeholder identity only (the repo is public). */

import assert from 'node:assert/strict';
import { registerHooks, createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { describe, it, before } from 'node:test';
import { fileURLToPath } from 'node:url';

// Same hooks as addSkill.test.ts: approval modules use extensionless imports and import .tsx/.css.
registerHooks({
  // Extensionless RELATIVE imports only: try the original, then .tsx, then .ts.
  resolve(specifier, context, nextResolve) {
    // Packages and already-extended paths resolve normally.
    if (!specifier.startsWith('.') || /\.[cm]?[jt]sx?$|\.css$/.test(specifier)) return nextResolve(specifier, context);
    // First the way Vite would write it, so a real .js sibling still wins.
    try { return nextResolve(specifier, context); } catch { /* fall through to TS extensions */ }
    // A component is the usual case for an extensionless import here.
    try { return nextResolve(`${specifier}.tsx`, context); } catch { /* then a plain module */ }
    // Last resort; a genuine miss throws from here with the .ts path named.
    return nextResolve(`${specifier}.ts`, context);
  },
  // .css is empty, .tsx is transpiled, everything else loads normally.
  load(url, context, nextLoad) {
    // Stylesheets have no runtime meaning in Node.
    if (url.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true };
    // Node type-strips .ts itself.
    if (!url.endsWith('.tsx')) return nextLoad(url, context);
    // apps/web's own typescript, no new dependency.
    const ts = createRequire(import.meta.url)('typescript') as typeof import('typescript');
    // react-jsx matches tsconfig.
    const out = ts.transpileModule(readFileSync(fileURLToPath(url), 'utf8'), {
      compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    });
    // Plain ESM for Node.
    return { format: 'module', source: out.outputText, shortCircuit: true };
  },
});

// The adapter: the function under test and buildResumeDiff.
let adapter: typeof import('../src/features/approval/diffAdapter.ts');
// rebuildOriginal, so the resume is the validator's real output and not a hand-made guess.
let edits: typeof import('../src/features/approval/tailoredEdits.ts');

before(async () => {
  // Both modules exist at HEAD, so this hook cannot cancel the suite.
  adapter = await import('../src/features/approval/diffAdapter.ts');
  // Loaded after the hooks so its extensionless imports resolve.
  edits = await import('../src/features/approval/tailoredEdits.ts');
});

// The pinned master version; the tailoring must cite the same one or rebuildOriginal refuses it.
const VERSION = 4;
// The certification title QA saw printed.
const CERT_LABEL = 'SQL and Relational Databases';

// A master with one certification that names SQL and an UNSELECTED "SQL" skill, so "+ Add SQL"
// is a real possibility the guard has to suppress (without it, the no-chip assertion is vacuous).
const MASTER = {
  // The profile's shape marker.
  schema_version: 1,
  // Placeholder identity; nothing personal in a public repo.
  identity: { full_name: 'Test Person', headline: 'Backend Engineer', email: 'test@example.com', phone: null, location: 'Remote', links: [] },
  // A summary node the tailored summary can cite.
  summary: { id: 'summary-master', text: 'Backend engineer building REST APIs in Node.js.' },
  // One job whose bullet carries "Express", the traced positive control, and never "SQL".
  experience: [{
    id: 'exp-acme', company: 'Acme', role: 'Backend Intern', location: 'Remote',
    start_display: 'Jun 2025', end_display: 'Aug 2025', start_date: null, end_date: null,
    // The only bullet: no SQL, so SQL can only ever come from the certification.
    bullets: [{ id: 'b-api', text: 'Built a REST API with Express and Node.js handling 500 users', tags: [] }],
  }],
  // Unused sections, legal when empty.
  projects: [], education: [], achievements: [],
  // The certification under test; description null so only the label can match.
  certifications: [{ id: 'cert-sql', label: CERT_LABEL, description: null, bullets: [] }],
  // Node.js selected; SQL left unselected and therefore addable.
  skills: [
    // Selected by the tailor.
    { id: 'skill-node', name: 'Node.js', category: 'Frameworks' },
    // NOT selected: the chip the cert must suppress.
    { id: 'skill-sql', name: 'SQL', category: 'Languages' },
  ],
  // Profile-level links, empty.
  links: [],
} as never;

// What the tailor returned: the cert selected AND its section printed.
const TAILOR_REFS = {
  // Contract shape marker.
  schema_version: 1,
  // Matches VERSION.
  master_version: VERSION,
  // 'certifications' named, so the cert is printed.
  section_order: ['summary', 'experience', 'skills', 'certifications'],
  // Cites the master summary.
  summary: { text: 'Backend engineer shipping REST APIs in Node.js.', refs: ['summary-master'] },
  // Node.js only.
  skills: [{ ref: 'skill-node' }],
  // The one bullet, verbatim.
  experience: [{ ref: 'exp-acme', bullets: [{ ref: 'b-api', text: 'Built a REST API with Express and Node.js handling 500 users' }] }],
  // Required arrays.
  projects: [], education: [], achievements: [],
  // The cert, selected by ref only; label and description come from the master.
  certifications: [{ ref: 'cert-sql', bullets: [] }],
};

// The resume type, loose enough to mutate per case.
type Resume = import('../src/data/contract').ResolvedResume;
// Deep copy so each case mutates its own resume.
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value));

// The validator's resume for the fixture; a null is a fixture bug and is named as one.
const printed = (): Resume => {
  // The real producer, so the cert's resolved shape is whatever the app actually stores.
  const resume = edits.rebuildOriginal(TAILOR_REFS, MASTER, VERSION);
  // Fail loudly here rather than on every later assertion.
  assert.notEqual(resume, null, 'fixture must rebuild to a ResolvedResume');
  // A fresh copy per call.
  return clone(resume!);
};

// The same resume with one tweak applied; keeps each negative to a single changed condition.
const tweaked = (change: (r: Record<string, any>) => void): Resume => {
  // Fresh copy.
  const r = printed() as unknown as Record<string, any>;
  // The one condition this case flips.
  change(r);
  // Retyped for the caller.
  return r as unknown as Resume;
};

// Shorthand for the function under test against the fixture master.
const covers = (keyword: string, resolved: Resume): boolean =>
  // The contract export.
  adapter.keywordAppearsInPrintedCredentials(keyword, resolved, MASTER);

describe('keywordAppearsInPrintedCredentials', () => {
  it('the fixture really prints the certification with the master label (precondition)', () => {
    // The resolved cert entry: if this shape is wrong every case below means nothing.
    const certs = (printed() as unknown as { certifications: { ref: string; label: string }[] }).certifications;
    // Exactly the one cert, by ref, with the master's label copied in.
    assert.deepEqual(certs.map((c) => [c.ref, c.label]), [['cert-sql', CERT_LABEL]]);
  });

  it('printed cert "SQL and Relational Databases" covers "SQL"', () => {
    // Every condition holds: printed, ref in master, label equal, keyword word-bounded inside.
    assert.equal(covers('SQL', printed()), true);
  });

  it('the same cert with section_order lacking "certifications" → false', () => {
    // Selected but not printed: the renderer skips it, so it is not on the resume.
    const r = tweaked((x) => { x.section_order = x.section_order.filter((s: string) => s !== 'certifications'); });
    // Not printed earns nothing.
    assert.equal(covers('SQL', r), false);
  });

  it('a stored label that differs from the master → false', () => {
    // Still contains SQL, but the string is not the master's, so it cannot be trusted as traced.
    const r = tweaked((x) => { x.certifications[0].label = 'SQL Expert Certificate'; });
    // Only master-equal strings count.
    assert.equal(covers('SQL', r), false);
  });

  it('a ref the master lacks → false', () => {
    // Same label as the master's cert, but under a ref the master has never heard of.
    const r = tweaked((x) => { x.certifications[0].ref = 'cert-ghost'; });
    // Not master-traced.
    assert.equal(covers('SQL', r), false);
  });

  it('section_order that is not an array → false', () => {
    // A legacy row shape: nothing is provably printed.
    const r = tweaked((x) => { x.section_order = 'summary,experience,skills,certifications'; });
    // The array guard fails closed, even though the string names the section.
    assert.equal(covers('SQL', r), false);
  });

  it('keyword "PostgreSQL" in the same printed cert → false', () => {
    // The cert says SQL, not PostgreSQL; no alias may turn one into the other.
    assert.equal(covers('PostgreSQL', printed()), false);
  });
});

describe('buildResumeDiff: a keyword covered only by a printed certification', () => {
  // JD keywords: "Express" is the traced control; "SQL" appears only in the cert title.
  const KEYWORDS = ['Express', 'SQL'];
  // The diff the approval page builds for this resume.
  const diff = (resolved: Resume) =>
    adapter.buildResumeDiff({
      // Minimal row: no findings, the JD keywords, the pinned version.
      application: { id: 'app-1', master_version: VERSION, audit_findings: [], selected_jd_keywords: KEYWORDS } as never,
      // Header fields only.
      job: { title: 'Backend Engineer', company_name: 'Acme' } as never,
      // The stored resume.
      resolved,
      // The pinned master.
      master: MASTER,
      // The tailor's version, so add-offers are switched on (null would be D4: none at all).
      original: printed(),
    } as never);

  it('"SQL" is honestlyMatched, not matchedByEdit or matchedByFabrication', () => {
    // The printed resume.
    const d = diff(printed());
    // Credited as honest coverage.
    assert.ok(d.coverage.honestlyMatched.includes('SQL'), `honestlyMatched = ${JSON.stringify(d.coverage.honestlyMatched)}`);
    // Not as the operator's edit.
    assert.equal(d.coverage.matchedByEdit.includes('SQL'), false);
    // Not as Auditor-flagged text.
    assert.equal(d.coverage.matchedByFabrication.includes('SQL'), false);
    // Positive control: the traced bullet still counts the normal way.
    assert.ok(d.coverage.honestlyMatched.includes('Express'));
  });

  it('"SQL" gets no "+ Add" chip, although the master has an unselected SQL skill', () => {
    // The printed resume.
    const d = diff(printed());
    // No entry at all: present keywords are skipped, not mapped to null.
    assert.equal(d.coverage.addable.has('SQL'), false);
  });

  it('control: with Certifications unprinted, "SQL" is missing and DOES offer "+ Add SQL"', () => {
    // Same resume, cert section dropped from section_order.
    const d = diff(tweaked((x) => { x.section_order = x.section_order.filter((s: string) => s !== 'certifications'); }));
    // No longer honest coverage.
    assert.equal(d.coverage.honestlyMatched.includes('SQL'), false);
    // And the chip appears, so the previous test's "no chip" is caused by the printed cert.
    assert.deepEqual(d.coverage.addable.get('SQL'), { ref: 'skill-sql', name: 'SQL' });
  });
});

/* The achievements half and the description half (review 2026-10-09): each has a positive and a
 * one-condition negative, so dropping 'achievements' from the section tuple or the description
 * branch from the helper turns a named test red. Hand-built shapes: only the fields the helper reads. */
describe('keywordAppearsInPrintedCredentials: achievements and descriptions', () => {
  // The keyword lives ONLY in the description, so the label cannot be what earns the credit.
  const ACH = { id: 'ach-cache', label: 'Hackathon winner', description: 'Built a Redis cache layer', bullets: [] };
  // A master holding just that achievement; certifications empty so they cannot answer instead.
  const master = { achievements: [ACH], certifications: [] } as never;
  // A printed resume carrying the achievement copied verbatim from the master.
  const resolved = (description: string | null, order: string[] = ['achievements']) =>
    // Cast: the helper reads only these fields.
    ({ section_order: order, certifications: [], achievements: [{ ref: ACH.id, label: ACH.label, description, bullets: [] }] }) as never;

  it('a printed achievement whose master-equal description names "Redis" covers "Redis"', () => {
    // Positive: the achievements section and the description branch both have to work.
    assert.equal(adapter.keywordAppearsInPrintedCredentials('Redis', resolved(ACH.description), master), true);
  });

  it('the same achievement with a description that differs from the master → false', () => {
    // One condition flipped: the stored description is not the master's, so it is untrusted.
    assert.equal(adapter.keywordAppearsInPrintedCredentials('Redis', resolved('Built a Redis cluster'), master), false);
  });

  it('the same achievement when section_order does not print achievements → false', () => {
    // One condition flipped: not printed, so not on the resume.
    assert.equal(adapter.keywordAppearsInPrintedCredentials('Redis', resolved(ACH.description, ['summary']), master), false);
  });

  it('a master with no achievements array reads as no credit, never a throw', () => {
    // Legacy or minimal master shape: fail closed instead of crashing buildResumeDiff.
    assert.equal(adapter.keywordAppearsInPrintedCredentials('Redis', resolved(ACH.description), { certifications: [] } as never), false);
  });
});
