/* The auditor's INDEX path form on the approval page (2026-11-07).
 *
 * The auditor names a bullet by its position in the resume it read (detector.ts:409,
 * "experience[1].bullets[1]"); the adapter's lines are keyed by ref ("experience.exp-beta.b-b2").
 * Before this change every index-form finding missed its line and landed in the alarm quoting the
 * whole bullet. These tests pin: the index form lands on the SAME line its ref-form twin does, never
 * a neighbour; anything the index cannot name exactly stays unlocated (CLAUDE.md §6, fail closed).
 * Fixture style: approvalJdKeywordDropped.test.ts, grown to two entries of two bullets. */

// The .tsx loader; first import so it runs before any component loads.
import './support/registerTsxHooks.ts';
// Strict asserts, so a loose == never passes a wrong shape.
import assert from 'node:assert/strict';
// The node test runner the web suite uses.
import { describe, it, before } from 'node:test';

// The adapter: stored findings in, view model out.
let adapter: typeof import('../src/features/approval/diffAdapter.ts');
// The flagged-claim list the batch button and the alarm both read.
let model: typeof import('../src/features/approval/diffModel.ts');
// The producer, used to build the resume exactly as the page rebuilds it.
let validator: typeof import('../../../supabase/functions/_shared/tailor/validator.ts');

before(async () => {
  // Loaded after the hooks so the resolve hook applies to their extensionless imports.
  adapter = await import('../src/features/approval/diffAdapter.ts');
  // Same.
  model = await import('../src/features/approval/diffModel.ts');
  // Type-stripped Deno module; it has no runtime imports.
  validator = await import('../../../supabase/functions/_shared/tailor/validator.ts');
});

// The pinned master version.
const VERSION = 3;
// Every bullet starts with this word, so a claim on the WRONG bullet would still be located there:
// the tests can then tell "landed on the right line" from "landed on some line".
const WORD = 'Built';
// The four bullets, each text unique after the shared first word.
const A1 = `${WORD} a REST API in Node.js`;
// Second bullet of the first entry.
const A2 = `${WORD} a queue worker in Node.js`;
// First bullet of the second entry.
const B1 = `${WORD} a dashboard in React`;
// Second bullet of the second entry: the off-by-one target.
const B2 = `${WORD} a cache layer in Node.js`;

// An experience entry with the fields the validator demands.
const entry = (id: string, company: string, bullets: { id: string; text: string }[]) => ({
  // Identity and dates, all verbatim fields.
  id, company, role: 'Engineer', location: 'Remote', start_display: 'Jun 2025', end_display: 'Aug 2025', start_date: null, end_date: null,
  // The bullets, untagged.
  bullets: bullets.map((b) => ({ ...b, tags: [] })),
});

// Two employers, two bullets each: the least that can show an off-by-one in either index.
const MASTER = {
  // Shape marker.
  schema_version: 1,
  // Verbatim identity.
  identity: { full_name: 'Test Person', headline: 'Backend Engineer', email: 'test@example.com', phone: null, location: 'Hyderabad', links: [] },
  // A citable summary node.
  summary: { id: 'summary-master', text: 'Backend engineer building REST APIs in Node.js.' },
  // The two employers.
  experience: [
    // Index 0.
    entry('exp-acme', 'Acme', [{ id: 'b-a1', text: A1 }, { id: 'b-a2', text: A2 }]),
    // Index 1.
    entry('exp-beta', 'Beta', [{ id: 'b-b1', text: B1 }, { id: 'b-b2', text: B2 }]),
  ],
  // Required arrays.
  projects: [], education: [], achievements: [], certifications: [],
  // One skill.
  skills: [{ id: 'skill-node', name: 'Node.js', category: 'Frameworks' }],
  // Profile links.
  links: [],
} as never;

// The tailoring as stored in tailor_refs: every bullet verbatim, in master order.
const TAILOR_REFS = {
  // Shape marker.
  schema_version: 1,
  // Matches VERSION.
  master_version: VERSION,
  // Document order.
  section_order: ['summary', 'experience', 'skills'],
  // Cites the master summary.
  summary: { text: 'Backend engineer building REST APIs in Node.js.', refs: ['summary-master'] },
  // Chosen by id.
  skills: [{ ref: 'skill-node' }],
  // Both entries, both bullets each.
  experience: [
    // Index 0.
    { ref: 'exp-acme', bullets: [{ ref: 'b-a1', text: A1 }, { ref: 'b-a2', text: A2 }] },
    // Index 1.
    { ref: 'exp-beta', bullets: [{ ref: 'b-b1', text: B1 }, { ref: 'b-b2', text: B2 }] },
  ],
  // Required arrays.
  projects: [], education: [], achievements: [], certifications: [],
} as never;

// The resume as the validator resolves it; a fresh copy each call so a test may mutate its own.
const resolved = (): { experience: { bullets: unknown[] }[] } => {
  // Producer verdict.
  const verdict = validator.validateTailoredProfile(TAILOR_REFS, MASTER, VERSION);
  // A refusal here is a fixture bug, named as such.
  assert.equal(verdict.ok, true, 'fixture must validate');
  // Deep copy, so no test can leak an edit into another.
  return structuredClone((verdict as { resume: unknown }).resume) as never;
};

// One fabricated-claim finding, shaped as the detector stores it (detector.ts:465-476).
const claimAt = (path: string) => ({ kind: 'unfaithful_rewording', path, claim: WORD, reason: 'ungrounded metric', confidence: 0.95 });

// The diff the page would build; `current` defaults to the unedited resume.
const diff = (findings: unknown[], current: unknown = resolved()) =>
  adapter.buildResumeDiff({
    // Minimal application row: id, findings and JD keywords.
    application: { id: 'app-1', audit_findings: findings, selected_jd_keywords: [] } as never,
    // Header fields only.
    job: { title: 'Backend Engineer', company_name: 'Acme' },
    // What tailored_profile holds now.
    resolved: current as never,
    // The pinned master.
    master: MASTER,
    // The tailor's version: what the auditor read.
    original: resolved() as never,
  });

// Every flagged claim as `lineId|text`, the exact positive shape each test asserts.
const flagged = (d: ReturnType<typeof diff>) => model.collectFlaggedClaims(d).map((c) => `${c.lineId}|${c.text}`);

describe('audit finding path forms on the approval page', () => {
  it('index-form finding marks the run on the same bullet as its ref-form twin', () => {
    // The detector's form for the first bullet of the first entry.
    const byIndex = flagged(diff([claimAt('experience[0].bullets[0]')]));
    // The adapter's own form for the same bullet.
    const byRef = flagged(diff([claimAt('experience.exp-acme.b-a1')]));
    // One located run, on b-a1, and both forms agree exactly.
    assert.deepEqual(byIndex, ['experience.exp-acme.b-a1|Built']);
    // Same result as the twin.
    assert.deepEqual(byIndex, byRef);
  });

  it('index-form second bullet of the second entry resolves with no off-by-one', () => {
    // Both indices past zero, so an off-by-one in either lands on a different bullet.
    assert.deepEqual(flagged(diff([claimAt('experience[1].bullets[1]')])), ['experience.exp-beta.b-b2|Built']);
  });

  it('index-form out-of-range index stays unlocated in collectFlaggedClaims', () => {
    // An entry index past the end and a bullet index past the end.
    for (const path of ['experience[2].bullets[0]', 'experience[1].bullets[2]']) {
      // Unlocated, under its own path, never moved onto the last real bullet.
      assert.deepEqual(flagged(diff([claimAt(path)])), [`${path}|Built`], path);
    }
  });

  it('index-form malformed path stays unlocated', () => {
    // Not a number, a negative, a leading zero, an unknown section, trailing junk, a ref mixed in.
    for (const path of ['experience[x]', 'experience[x].bullets[0]', 'experience[-1].bullets[0]', 'experience[01].bullets[0]', 'jobs[0].bullets[0]', 'experience[0].bullets[0].x', 'experience[0].b-a1']) {
      // Exactly the one claim, unlocated, under the path as written.
      assert.deepEqual(flagged(diff([claimAt(path)])), [`${path}|Built`], path);
    }
  });

  it('ref-form path is unchanged', () => {
    // The adapter's own form lands where it always did.
    assert.deepEqual(flagged(diff([claimAt('experience.exp-beta.b-b1')])), ['experience.exp-beta.b-b1|Built']);
    // A ref-form path naming nothing still stays unlocated under its own text, as before.
    assert.deepEqual(flagged(diff([claimAt('experience.exp-nope.b-nope')])), ['experience.exp-nope.b-nope|Built']);
  });

  it('index-form resolves against the resume the auditor read, not the edited one', () => {
    // The operator removed the first bullet after the audit, so stored index 0 is now b-a2.
    const edited = resolved();
    // Drop b-a1 from the stored copy only; the original (what the auditor read) keeps it.
    edited.experience[0]!.bullets.shift();
    // The auditor's experience[0].bullets[0] meant b-a1, the removed one.
    const d = diff([claimAt('experience[0].bullets[0]')], edited);
    // Nothing flagged: the claim's bullet is gone, so it is superseded on b-a1's line, not moved onto b-a2.
    assert.deepEqual(flagged(d), []);
    // And it is listed as superseded on exactly b-a1's line.
    assert.deepEqual(d.lines.filter((l) => (l.supersededClaims ?? []).length > 0).map((l) => `${l.id}|${l.supersededClaims.join(',')}`), ['experience.exp-acme.b-a1|Built']);
  });

  it('index-form jd_keyword_dropped note works with both forms', () => {
    // The note for each form; the path a note carries is the ref form either way.
    for (const path of ['experience[1].bullets[1]', 'experience.exp-beta.b-b2']) {
      // The detector's dropped-keyword shape with structured keywords.
      const d = diff([{ kind: 'jd_keyword_dropped', path, claim: B2, reason: 'dropped: Kafka', confidence: 1, keywords: ['Kafka'] }]);
      // One note, named, on b-b2.
      assert.deepEqual(d.keywordDrops?.map((n) => `${n.path}|${n.reason}`), ['experience.exp-beta.b-b2|Kafka'], path);
      // Never a flagged claim.
      assert.deepEqual(flagged(d), [], path);
    }
  });
});
