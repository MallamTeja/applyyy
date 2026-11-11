/* Tailored-resume editing on the approval page: the pure edit functions (task 8 contract, 2026-10-06).
 *
 * The load-bearing ruling is R0: an edit writes a bullet's `text` (or the top-level `summary`) and
 * NOTHING else. `master_text` is the Auditor's and the diff's ground truth; an edit that touched it
 * would make the operator's own words read as traced to the master. So the starred test compares the
 * WHOLE resume after an edit against the whole resume before, with exactly one field changed.
 * R0' (2026-11-01) widened the save gate (tracesToMaster): entries and bullets may now be added
 * back from the master, removed and reordered, as long as every node traces to the pinned master
 * under its true parent. The gate tests below pin both halves: what it now allows, and the honesty
 * refusals that still hold.
 *
 * Fixture: a MasterProfile + TailoredProfile that validateTailoredProfile accepts (verified with a
 * throwaway node one-liner before these assertions were written: it returned ok:true). Kept small:
 * identity, one experience entry with two bullets, one skill, a summary node. */

// The .tsx loader; must be the first import so it runs before any component loads.
import './support/registerTsxHooks.ts';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it, before } from 'node:test';
import { fileURLToPath } from 'node:url';

// The module under test, typed from its source so a renamed export fails typecheck too.
let edits: typeof import('../src/features/approval/tailoredEdits.ts');
// The producer, so rebuildOriginal is compared against the validator's own output, not a copy.
let validator: typeof import('../../../supabase/functions/_shared/tailor/validator.ts');

before(async () => {
  // Loaded after the hooks so the resolve hook applies to the module's own imports.
  edits = await import('../src/features/approval/tailoredEdits.ts');
  // Same path tailoredEdits.ts itself imports, so both sides run one validator.
  validator = await import('../../../supabase/functions/_shared/tailor/validator.ts');
});

// The pinned master version; the tailoring must name the same one or the validator refuses it.
const VERSION = 3;

// The master: every tailored word below appears here, so the validator's token check passes.
const MASTER = {
  // The profile's shape marker, not the row version.
  schema_version: 1,
  // Copied verbatim into the resume; R0 says an edit may never touch it.
  identity: { full_name: 'Test Person', headline: 'Backend Engineer', email: 'test@example.com', phone: null, location: 'Hyderabad', links: [] },
  // A real summary node, so the tailored summary has something honest to cite.
  summary: { id: 'summary-master', text: 'Backend engineer building REST APIs in Node.js.' },
  // One employer with two bullets: enough to prove an edit or removal touches only one of them.
  experience: [{
    id: 'exp-acme', company: 'Acme', role: 'Backend Intern', location: 'Remote',
    start_display: 'Jun 2025', end_display: 'Aug 2025', start_date: null, end_date: null,
    bullets: [
      // Index 0, so "re-insert at the ORIGINAL index" is distinguishable from "append".
      { id: 'b-api', text: 'Built a REST API with Express and Node.js handling 500 users', tags: [] },
      // Index 1, the bullet most tests edit.
      { id: 'b-tests', text: 'Wrote unit tests for the billing service', tags: [] },
    ],
  }],
  // Empty sections are legal; the validator only requires one substantive section.
  projects: [], education: [], achievements: [], certifications: [],
  // One skill, so the skills section is non-empty.
  skills: [{ id: 'skill-node', name: 'Node.js', category: 'Frameworks' }],
  // Profile-level links, empty.
  links: [],
} as never;

// What the Tailor returned and what applications.tailor_refs stores.
const TAILOR_REFS = {
  // The contract's shape marker.
  schema_version: 1,
  // Matches VERSION, else rebuildOriginal must return null.
  master_version: VERSION,
  // Document order for the renderer; carried through untouched.
  section_order: ['summary', 'experience', 'skills'],
  // Prose citing the master summary, so the summary_without_refs rule passes.
  summary: { text: 'Backend engineer shipping REST APIs in Node.js.', refs: ['summary-master'] },
  // Chosen by id only.
  skills: [{ ref: 'skill-node' }],
  // Both bullets, in master order, worded from master tokens only.
  experience: [{ ref: 'exp-acme', bullets: [
    // Verbatim rewording; numbers match the master so no invented_metric.
    { ref: 'b-api', text: 'Built a REST API with Express and Node.js handling 500 users' },
    // Verbatim rewording.
    { ref: 'b-tests', text: 'Wrote unit tests for the billing service' },
  ] }],
  // Empty sections, required arrays.
  projects: [], education: [], achievements: [], certifications: [],
};

// The rebuilt original; failing loudly here beats every later test failing on a null.
const original = () => {
  // The function under test produces the baseline every edit test starts from.
  const resume = edits.rebuildOriginal(TAILOR_REFS, MASTER, VERSION);
  // A null here is a fixture or rebuild bug, named as such.
  assert.notEqual(resume, null, 'fixture must rebuild to a ResolvedResume');
  // Narrowed for the callers.
  return resume!;
};

// A frozen JSON snapshot, so mutation of nested objects is detected, not just the top level.
const snapshot = (value: unknown) => JSON.stringify(value);

describe('applyTextEdit', () => {
  it('an edit never changes master_text', () => {
    // The resume as the tailor produced it.
    const before = original();
    // Captured before the call so in-place mutation shows up as a difference.
    const beforeJson = snapshot(before);
    // The operator rewrites the second bullet.
    const out = edits.applyTextEdit(before, { kind: 'bullet', ref: 'b-tests' }, 'Wrote integration tests for billing');
    // An honest edit is accepted.
    assert.equal(out.ok, true);
    // Narrow for the field checks below.
    if (!out.ok) return;
    // The expected result: the input with exactly ONE field changed, and it is `text`.
    const expected = JSON.parse(beforeJson);
    // The only legal write under R0.
    expected.experience[0].bullets[1].text = 'Wrote integration tests for billing';
    // Whole-object equality: master_text, ref, identity, versions and the other bullet all unchanged.
    assert.deepEqual(out.resume, expected);
    // Named explicitly as well, because this is the field R0 exists for.
    assert.equal(out.resume.experience[0]!.bullets[1]!.master_text, 'Wrote unit tests for the billing service');
    // The ref still identifies the same master bullet.
    assert.equal(out.resume.experience[0]!.bullets[1]!.ref, 'b-tests');
    // Identity is the master's, verbatim.
    assert.deepEqual(out.resume.identity, before.identity);
    // Both version markers survive.
    assert.equal(out.resume.master_version, VERSION);
    // The shape marker survives.
    assert.equal(out.resume.schema_version, 1);
    // before/after describe the change for the event log.
    assert.equal(out.before, 'Wrote unit tests for the billing service');
    // The new text, as saved.
    assert.equal(out.after, 'Wrote integration tests for billing');
    // The input was not mutated: React state must never change under the renderer.
    assert.equal(snapshot(before), beforeJson);
    // A NEW object, so a reference-equality state update re-renders.
    assert.notEqual(out.resume, before);
  });

  it('trims the text it saves', () => {
    // Surrounding whitespace is formatting, not content.
    const out = edits.applyTextEdit(original(), { kind: 'bullet', ref: 'b-tests' }, '  Wrote tests  ');
    // Accepted.
    assert.equal(out.ok, true);
    // And stored trimmed.
    if (out.ok) assert.equal(out.resume.experience[0]!.bullets[1]!.text, 'Wrote tests');
  });

  it('refuses empty, whitespace-only, over-long and unknown-ref edits', () => {
    // A bullet target that exists.
    const target = { kind: 'bullet', ref: 'b-tests' } as const;
    // Empty text would print a blank bullet.
    assert.equal(edits.applyTextEdit(original(), target, '').ok, false);
    // Whitespace trims to empty.
    assert.equal(edits.applyTextEdit(original(), target, '   \n\t ').ok, false);
    // One past the 2000-character cap.
    assert.equal(edits.applyTextEdit(original(), target, 'x'.repeat(2001)).ok, false);
    // A ref that is not on the resume names nothing to edit.
    assert.equal(edits.applyTextEdit(original(), { kind: 'bullet', ref: 'b-nope' }, 'Some text').ok, false);
    // Positive control: exactly 2000 characters is the limit, not over it.
    assert.equal(edits.applyTextEdit(original(), target, 'x'.repeat(2000)).ok, true);
    // Positive control: the same known ref with ordinary text is accepted.
    assert.equal(edits.applyTextEdit(original(), target, 'Some text').ok, true);
  });

  it('a summary edit changes only `summary`', () => {
    // Baseline.
    const before = original();
    // The operator rewrites the summary paragraph.
    const out = edits.applyTextEdit(before, { kind: 'summary' }, 'Engineer who ships Node.js APIs.');
    // Accepted.
    assert.equal(out.ok, true);
    // Narrow.
    if (!out.ok) return;
    // Expected: the input with only `summary` replaced.
    const expected = JSON.parse(snapshot(before));
    // The one legal write for a summary target.
    expected.summary = 'Engineer who ships Node.js APIs.';
    // Every bullet, skill and marker is untouched.
    assert.deepEqual(out.resume, expected);
    // The old prose is reported as `before`.
    assert.equal(out.before, 'Backend engineer shipping REST APIs in Node.js.');
  });
});

describe('removeBullet', () => {
  it('removes exactly that bullet; the entry and the other bullet stay', () => {
    // Baseline.
    const before = original();
    // Remove the first bullet.
    const out = edits.removeBullet(before, { kind: 'bullet', ref: 'b-api' });
    // Accepted.
    assert.equal(out.ok, true);
    // Narrow.
    if (!out.ok) return;
    // The employer entry survives a bullet removal.
    assert.equal(out.resume.experience.length, 1);
    // Only the other bullet remains, unchanged.
    assert.deepEqual(out.resume.experience[0]!.bullets, [before.experience[0]!.bullets[1]]);
    // A removal has no new text.
    assert.equal(out.after, null);
    // The input still holds both bullets.
    assert.equal(before.experience[0]!.bullets.length, 2);
  });
});

describe('resetTarget', () => {
  it('restores edited text to the original', () => {
    // The reference the reset restores to.
    const orig = original();
    // Edit the second bullet first.
    const edited = edits.applyTextEdit(orig, { kind: 'bullet', ref: 'b-tests' }, 'Something else entirely');
    // Precondition: the edit happened.
    assert.equal(edited.ok, true);
    // Narrow.
    if (!edited.ok) return;
    // Positive control: the edited resume differs from the original.
    assert.notDeepEqual(edited.resume, orig);
    // Reset that bullet.
    const out = edits.resetTarget(edited.resume, orig, { kind: 'bullet', ref: 'b-tests' });
    // Accepted.
    assert.equal(out.ok, true);
    // Back to exactly the original.
    if (out.ok) assert.deepEqual(out.resume, orig);
  });

  it('re-inserts a removed bullet at its ORIGINAL index', () => {
    // The reference.
    const orig = original();
    // Remove index 0, so an append would put it at index 1 and fail this test.
    const removed = edits.removeBullet(orig, { kind: 'bullet', ref: 'b-api' });
    // Precondition.
    assert.equal(removed.ok, true);
    // Narrow.
    if (!removed.ok) return;
    // Reset the removed bullet.
    const out = edits.resetTarget(removed.resume, orig, { kind: 'bullet', ref: 'b-api' });
    // Accepted.
    assert.equal(out.ok, true);
    // Narrow.
    if (!out.ok) return;
    // The bullet order is the original's, not "the rest, then the restored one".
    assert.deepEqual(out.resume.experience[0]!.bullets.map((b) => b.ref), ['b-api', 'b-tests']);
    // And the whole resume equals the original.
    assert.deepEqual(out.resume, orig);
  });
});

describe('rebuildOriginal', () => {
  it('a valid fixture rebuilds to exactly what the validator returns', () => {
    // The producer's own verdict on the same inputs.
    const verdict = validator.validateTailoredProfile(TAILOR_REFS as never, MASTER, VERSION);
    // Precondition: the fixture is valid, else this test proves nothing.
    assert.equal(verdict.ok, true);
    // The rebuild must agree with it field for field.
    if (verdict.ok) assert.deepEqual(edits.rebuildOriginal(TAILOR_REFS, MASTER, VERSION), verdict.resume);
  });

  it('null, {}, garbage and a refused tailoring rebuild to null and never throw', () => {
    // No tailor_refs recorded on the row.
    assert.equal(edits.rebuildOriginal(null, MASTER, VERSION), null);
    // An empty object; the validator itself would throw reading `.length` of undefined.
    assert.equal(edits.rebuildOriginal({}, MASTER, VERSION), null);
    // A string is not an object.
    assert.equal(edits.rebuildOriginal('garbage', MASTER, VERSION), null);
    // A number is not an object.
    assert.equal(edits.rebuildOriginal(42, MASTER, VERSION), null);
    // Half-shaped: right marker, wrong section type.
    assert.equal(edits.rebuildOriginal({ schema_version: 1, experience: 'nope' }, MASTER, VERSION), null);
    // Well-shaped but pinned to another version: the validator refuses, so no original.
    assert.equal(edits.rebuildOriginal(TAILOR_REFS, MASTER, VERSION + 1), null);
    // Positive control: the same function on the valid fixture is not null.
    assert.notEqual(edits.rebuildOriginal(TAILOR_REFS, MASTER, VERSION), null);
  });
});

describe('isResumeShape', () => {
  it('accepts the rebuilt resume and refuses {}, null and schema_version 2', () => {
    // Positive: the real thing.
    assert.equal(edits.isResumeShape(original()), true);
    // An empty object has none of the required fields.
    assert.equal(edits.isResumeShape({}), false);
    // Null is not a resume.
    assert.equal(edits.isResumeShape(null), false);
    // A future schema must not be saved under this one's rules.
    assert.equal(edits.isResumeShape({ ...original(), schema_version: 2 }), false);
  });
});

// --- Contract v2 (applyyy-d6 review fixes) ------------------------------------------------------

// A deep copy for building hand-mutated variants; JSON is enough for plain data.
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value));

// Unwrap an outcome that must succeed, so a refusal fails here and not three lines later.
const okResume = (out: ReturnType<typeof edits.applyTextEdit>) => {
  // A refusal here is a precondition failure, named with its reason.
  assert.equal(out.ok, true, out.ok ? '' : out.reason);
  // Narrowed for the caller.
  return (out as { resume: ReturnType<typeof original> }).resume;
};

// The original with a third bullet, so relative-order resets have siblings on both sides.
const threeBullets = () => {
  // Start from the validator's own resume.
  const resume = clone(original()) as ReturnType<typeof original> & { experience: { bullets: unknown[] }[] };
  // Appended as index 2; only the pure functions see it, so the validator need not.
  resume.experience[0]!.bullets.push({ ref: 'b-docs', text: 'Wrote docs for the billing service', master_text: 'Wrote docs for the billing service' });
  // Retyped for the functions under test.
  return resume as ReturnType<typeof original>;
};

describe('tracesToMaster', () => {
  it('is true for the outputs of applyTextEdit, removeBullet and resetTarget', () => {
    // The tailor's version doubles as the stored previous.
    const orig = original();
    // A bullet text edit.
    const edited = okResume(edits.applyTextEdit(orig, { kind: 'bullet', ref: 'b-tests' }, 'Wrote integration tests'));
    // Text is free.
    assert.equal(edits.tracesToMaster(orig, edited, orig, MASTER), true);
    // A summary edit.
    const summary = okResume(edits.applyTextEdit(orig, { kind: 'summary' }, 'Engineer who ships Node.js APIs.'));
    // Summary is free.
    assert.equal(edits.tracesToMaster(orig, summary, orig, MASTER), true);
    // A removal.
    const removed = okResume(edits.removeBullet(orig, { kind: 'bullet', ref: 'b-api' }));
    // Removing a bullet is allowed.
    assert.equal(edits.tracesToMaster(orig, removed, orig, MASTER), true);
    // Re-inserting it, measured against the removed state as previous.
    const restored = okResume(edits.resetTarget(removed, orig, { kind: 'bullet', ref: 'b-api' }));
    // Re-insertion of a master bullet is allowed.
    assert.equal(edits.tracesToMaster(removed, restored, orig, MASTER), true);
  });

  it('is false when master_text, identity, master_version or an entry field changes', () => {
    // The reference.
    const orig = original();
    // master_text rewritten to match an edit: the violation that makes edits read as traced.
    const masterText = clone(orig);
    // Both fields moved together, as a careless edit would.
    const first = masterText.experience[0];
    // A missing entry is a fixture bug: fail on it by name, not via a TypeError.
    assert.ok(first, 'fixture must have a first experience entry');
    // The bullets swapped for a NEW list (DocumentOrdered is readonly): index 1 rewritten, the rest the same objects.
    first.bullets = first.bullets.map((b, i) => (i === 1 ? { ...b, text: 'X', master_text: 'X' } : b));
    // Refused.
    assert.equal(edits.tracesToMaster(orig, masterText, orig, MASTER), false);
    // Identity is the master's, never editable here.
    assert.equal(edits.tracesToMaster(orig, { ...orig, identity: { ...orig.identity, full_name: 'Someone Else' } }, orig, MASTER), false);
    // The pin must survive (a re-pin relabels previous in saveTailoredEdit first).
    assert.equal(edits.tracesToMaster(orig, { ...orig, master_version: VERSION + 1 }, orig, MASTER), false);
    // An entry's display field: an employer cannot be renamed from this page.
    const company = clone(orig);
    // Only the company changes; bullets untouched.
    // A NEW experience list (DocumentOrdered is readonly): entry 0 renamed, the others the same objects.
    company.experience = company.experience.map((e, i) => (i === 0 ? { ...e, company: 'Bigger Corp' } : e));
    // Refused.
    assert.equal(edits.tracesToMaster(orig, company, orig, MASTER), false);
    // A bullet whose ref the master never had is an invented bullet.
    const invented = clone(orig);
    // Appended with a ref absent from the master.
    const target = invented.experience[0];
    // A missing entry is a fixture bug: fail on it by name, not via a TypeError.
    assert.ok(target, 'fixture must have a first experience entry');
    // Appended as a NEW list (DocumentOrdered is readonly).
    target.bullets = [...target.bullets, { ref: 'b-new', text: 'New', master_text: 'New' }];
    // Refused.
    assert.equal(edits.tracesToMaster(orig, invented, orig, MASTER), false);
    // Positive control: an unchanged resume traces by definition.
    assert.equal(edits.tracesToMaster(orig, clone(orig), orig, MASTER), true);
  });

  it('accepts the owner\'s dictated experience title (2026-11-11), and only a clean title, only the role', () => {
    // The reference.
    const orig = original();
    // A resume whose first job title is the owner's wording, as the FamPay row needed ("Data Analyst Intern").
    const titled = clone(orig);
    // Only the role changes; company, dates and bullets are the master's.
    titled.experience = titled.experience.map((e, i) => (i === 0 ? { ...e, role: 'Data Analyst Intern' } : e));
    // Non-vacuity: the master really holds a different title, so this proves the role is freed, not unchanged.
    assert.notEqual(orig.experience[0]!.role, 'Data Analyst Intern');
    // Accepted: the title is the owner's to state.
    assert.equal(edits.tracesToMaster(orig, titled, orig, MASTER), true);
    // A title outside ROLE_TITLE_SHAPE (markup, a blob) is refused: freed means shape-checked, not unchecked.
    const junk = clone(orig);
    // Angle brackets and a newline are nothing a printed title holds.
    junk.experience = junk.experience.map((e, i) => (i === 0 ? { ...e, role: '<b>CTO</b>\nand founder' } : e));
    // Refused.
    assert.equal(edits.tracesToMaster(orig, junk, orig, MASTER), false);
    // A blank title is refused too (the shape needs 2+ characters starting with a letter).
    const blank = clone(orig);
    // Emptied.
    blank.experience = blank.experience.map((e, i) => (i === 0 ? { ...e, role: '' } : e));
    // Refused.
    assert.equal(edits.tracesToMaster(orig, blank, orig, MASTER), false);
    // Freeing the role frees NOTHING else: a clean title plus a renamed employer is still refused.
    const both = clone(titled);
    // The employer renamed alongside the title.
    both.experience = both.experience.map((e, i) => (i === 0 ? { ...e, company: 'Bigger Corp' } : e));
    // Refused.
    assert.equal(edits.tracesToMaster(orig, both, orig, MASTER), false);
  });

  it('fails closed when the master cannot be resolved', () => {
    // The reference.
    const orig = original();
    // No master at all (an old 3-argument caller at runtime): nothing can vouch, so nothing passes.
    assert.equal((edits.tracesToMaster as (...a: unknown[]) => boolean)(orig, clone(orig), orig), false);
    // A master whose ids collide: the validator refuses it, so there is no FULL to trace against.
    const ambiguous = clone(MASTER as object) as { experience: { bullets: { id: string }[] }[] };
    // The second bullet now shares the first one's id.
    ambiguous.experience[0]!.bullets[1]!.id = 'b-api';
    // Refused even for an unchanged resume.
    assert.equal(edits.tracesToMaster(orig, clone(orig), orig, ambiguous as never), false);
    // Positive control: the intact master passes the same unchanged resume.
    assert.equal(edits.tracesToMaster(orig, clone(orig), orig, MASTER), true);
  });
});

// --- R0' (2026-11-01): every node traces to the pinned master under its true parent -------------

// One master bullet, so each fixture line below is written once.
const mb = (id: string, text: string) => ({ id, text, tags: [] });

// A master with every bullet section populated, plus nodes the tailor did NOT select (b-beta-2,
// proj-f1, ach-leet) so add-back has something real to add. Validator-accepted: the tailoring below
// rewords nothing, so every token is the master's own.
const WIDE_MASTER = {
  // The profile's shape marker.
  schema_version: 1,
  // Copied verbatim into the resume.
  identity: { full_name: 'Test Person', headline: 'Backend Engineer', email: 'test@example.com', phone: null, location: 'Hyderabad', links: [] },
  // A real summary node.
  summary: { id: 'summary-master', text: 'Backend engineer building REST APIs in Node.js.' },
  // Two employers, so a relocated claim has somewhere to be laundered into.
  experience: [
    // Three bullets, so relative-order inserts have siblings on both sides.
    { id: 'exp-acme', company: 'Acme', role: 'Backend Intern', location: 'Remote', start_display: 'Jun 2025', end_display: 'Aug 2025', start_date: null, end_date: null,
      bullets: [mb('b-api', 'Built a REST API with Express and Node.js handling 500 users'), mb('b-tests', 'Wrote unit tests for the billing service'), mb('b-docs', 'Wrote docs for the billing service')] },
    // b-beta-2 is never selected by the tailor: the add-back bullet.
    { id: 'exp-beta', company: 'Beta Labs', role: 'Platform Intern', location: null, start_display: 'Jan 2025', end_display: 'May 2025', start_date: null, end_date: null,
      bullets: [mb('b-beta', 'Ran the Beta on-call rota'), mb('b-beta-2', 'Cut Beta deploy time in half')] },
  ],
  // proj-f1 is never selected: the add-back entry, placed AFTER proj-cli in master order.
  projects: [
    { id: 'proj-cli', name: 'Log Search CLI', links: [], start_display: '2024', end_display: '2024', start_date: null, end_date: null, bullets: [mb('b-proj', 'Shipped a CLI for log search')] },
    { id: 'proj-f1', name: 'F1 Race Pace Predictor', links: [], start_display: '2025', end_display: '2025', start_date: null, end_date: null, bullets: [mb('b-f1', 'Predicted race pace from lap data')] },
  ],
  // One degree.
  education: [{ id: 'edu-btech', institution: 'JNTU', degree: 'B.Tech', field: 'Computer Science', start_display: '2021', end_display: '2025', start_date: null, end_date: null, grade_display: '8.4 CGPA', bullets: [mb('b-edu', 'Graduated with honours')] }],
  // ach-leet is never selected.
  achievements: [
    { id: 'ach-hack', label: 'Hackathon Winner', description: null, bullets: [mb('b-ach', 'Won first place at a hackathon')] },
    { id: 'ach-leet', label: 'LeetCode', description: null, bullets: [mb('b-leet', 'Solved 500 problems')] },
  ],
  // One credential.
  certifications: [{ id: 'cert-aws', label: 'AWS Solutions Architect', description: null, bullets: [mb('b-cert', 'Passed the AWS associate exam')] }],
  // One skill.
  skills: [{ id: 'skill-node', name: 'Node.js', category: 'Frameworks' }],
  // Profile-level links.
  links: [],
} as never;

// One tailored entry, verbatim from the master: what the tailor would select.
const pick = (ref: string, ...bullets: [string, string][]) => ({ ref, bullets: bullets.map(([b, text]) => ({ ref: b, text })) });

// The tailoring over WIDE_MASTER: every section non-empty and slotted, three master nodes left out.
const WIDE_REFS = {
  // The contract's shape marker.
  schema_version: 1,
  // Same pin as the narrow fixture.
  master_version: VERSION,
  // Every kind, so no section is slotless unless a test makes it so.
  section_order: ['summary', 'experience', 'projects', 'education', 'achievements', 'certifications', 'skills'],
  // Cites the master summary.
  summary: { text: 'Backend engineer shipping REST APIs in Node.js.', refs: ['summary-master'] },
  // The one skill.
  skills: [{ ref: 'skill-node' }],
  // Acme whole; Beta without b-beta-2.
  experience: [
    pick('exp-acme', ['b-api', 'Built a REST API with Express and Node.js handling 500 users'], ['b-tests', 'Wrote unit tests for the billing service'], ['b-docs', 'Wrote docs for the billing service']),
    pick('exp-beta', ['b-beta', 'Ran the Beta on-call rota']),
  ],
  // The CLI only; proj-f1 left out.
  projects: [pick('proj-cli', ['b-proj', 'Shipped a CLI for log search'])],
  // The degree.
  education: [pick('edu-btech', ['b-edu', 'Graduated with honours'])],
  // The hackathon only; ach-leet left out.
  achievements: [pick('ach-hack', ['b-ach', 'Won first place at a hackathon'])],
  // The credential.
  certifications: [pick('cert-aws', ['b-cert', 'Passed the AWS associate exam'])],
};

// The wide original, rebuilt by the real validator, so every field is what a live row would hold.
const wideOriginal = () => {
  // The function under test produces it; a null is a fixture bug.
  const resume = edits.rebuildOriginal(WIDE_REFS, WIDE_MASTER, VERSION);
  // Named, so a broken fixture does not read as a gate failure.
  assert.notEqual(resume, null, 'wide fixture must rebuild to a ResolvedResume');
  // Narrowed for the callers.
  return resume!;
};
// FULL for the wide master, as the page and the gate compute it.
const wideFull = () => {
  // The function under test.
  const full = edits.resolveFullMaster(WIDE_MASTER, VERSION);
  // Named precondition.
  assert.notEqual(full, null, 'the wide master must resolve to FULL');
  // Narrowed.
  return full!;
};
// The gate over the wide fixture; previous defaults to the tailor's version.
const traces = (next: unknown, previous: unknown = wideOriginal()) =>
  // original is always the tailor's, master always the pinned wide master.
  edits.tracesToMaster(previous as never, next as never, wideOriginal(), WIDE_MASTER);

// Mutable view of a cloned resume's bullet sections, so the hand-built violations stay readable.
type Sections = Record<string, { ref: string; bullets: { ref: string; text: string; master_text: string }[]; [field: string]: unknown }[]> & { section_order: string[] };

describe("tracesToMaster (R0'): what the gate now allows", () => {
  it('accepts a text edit and a removal in achievements and certifications (the diff shows them now)', () => {
    // The reference.
    const orig = wideOriginal();
    // An achievement reworded: free text, like any other section since R0'.
    assert.equal(traces(okResume(edits.applyTextEdit(orig, { kind: 'bullet', ref: 'b-ach' }, 'Won a hackathon'))), true);
    // A certification reworded.
    assert.equal(traces(okResume(edits.applyTextEdit(orig, { kind: 'bullet', ref: 'b-cert' }, 'Passed AWS'))), true);
    // An achievement bullet removed.
    assert.equal(traces(okResume(edits.removeBullet(orig, { kind: 'bullet', ref: 'b-ach' }))), true);
  });

  it('accepts a swapped bullet order (hand-built and moveBullet)', () => {
    // The reference: Acme holds [b-api, b-tests, b-docs].
    const orig = wideOriginal();
    // Reversed in place: every bullet still under its own parent, order changed.
    const swapped = clone(orig) as unknown as Sections;
    // The whole entry reversed.
    swapped['experience']![0]!.bullets.reverse();
    // Order is the operator's to change now.
    assert.equal(traces(swapped), true);
    // The page's own move.
    assert.equal(traces(okResume(edits.moveBullet(orig, 'b-tests', 'up'))), true);
  });

  it('accepts a moved section', () => {
    // achievements moved above education.
    assert.equal(traces(okResume(edits.moveSection(wideOriginal(), 'achievements', 'up'))), true);
  });

  it('accepts an added-back master bullet and an added master entry', () => {
    // The reference and FULL.
    const orig = wideOriginal();
    // Beta's left-out bullet put back under Beta.
    assert.equal(traces(okResume(edits.addMasterBullet(orig, wideFull(), 'b-beta-2'))), true);
    // The left-out project put on, with its bullet.
    assert.equal(traces(okResume(edits.addMasterEntry(orig, wideFull(), 'projects', 'proj-f1'))), true);
    // The left-out achievement too.
    assert.equal(traces(okResume(edits.addMasterEntry(orig, wideFull(), 'achievements', 'ach-leet'))), true);
  });

  it('accepts a removed achievement entry', () => {
    // The only achievement taken off, bullets and all.
    assert.equal(traces(okResume(edits.removeEntry(wideOriginal(), 'achievements', 'ach-hack'))), true);
  });
});

describe("tracesToMaster (R0'): the honesty refusals that still hold", () => {
  it('refuses a bullet moved under another entry', () => {
    // The candidate: two employers.
    const moved = clone(wideOriginal()) as unknown as Sections;
    // Take Acme's second bullet out...
    const [claim] = moved['experience']![0]!.bullets.splice(1, 1);
    // ...and file it under Beta: same ref, same text, a different employer's history.
    moved['experience']![1]!.bullets.push(claim!);
    // Refused: the parent entry is part of the claim.
    assert.equal(traces(moved), false);
  });

  it('refuses a bullet ref or an entry ref that is not in the master, or an entry in the wrong section', () => {
    // An invented bullet under Acme.
    const bullet = clone(wideOriginal()) as unknown as Sections;
    // A ref the master never had.
    bullet['experience']![0]!.bullets.push({ ref: 'b-invented', text: 'Led a team of five', master_text: 'Led a team of five' });
    // Refused.
    assert.equal(traces(bullet), false);
    // An invented project entry, wearing a real entry's fields.
    const entry = clone(wideOriginal()) as unknown as Sections;
    // A copy of the CLI under a new ref.
    entry['projects']!.push({ ...entry['projects']![0]!, ref: 'proj-invented', bullets: [] });
    // Refused.
    assert.equal(traces(entry), false);
    // A real achievement filed as a certification: real ref, wrong section.
    const relocated = clone(wideOriginal()) as unknown as Sections;
    // Moved across sections whole.
    relocated['certifications']!.push(relocated['achievements']!.pop()!);
    // Refused: an award is not a credential.
    assert.equal(traces(relocated), false);
  });

  it('refuses an edited entry field (company, dates)', () => {
    // An employer renamed.
    const company = clone(wideOriginal()) as unknown as Sections;
    // Only the company changes.
    company['experience']![0]!['company'] = 'Bigger Corp';
    // Refused.
    assert.equal(traces(company), false);
    // Dates stretched.
    const dates = clone(wideOriginal()) as unknown as Sections;
    // A longer tenure than the master records.
    dates['experience']![1]!['start_display'] = 'Jan 2023';
    // Refused.
    assert.equal(traces(dates), false);
  });

  it('lets a stored entry lack a key the master leaves empty, and nothing more (2026-11-01)', () => {
    // The live case: a resume stored before the validator began filling an empty field (links: [])
    // has no such key, and a strict compare refused EVERY edit on all 26 live rows. description is
    // null on the wide master's achievement, so the same branch is exercised without that change.
    const lacking = clone(wideOriginal()) as unknown as Sections;
    // The key removed entirely from the stored achievement.
    delete lacking['achievements']![0]!['description'];
    // Absent claims nothing: allowed, both as the edit and as the stored previous.
    assert.equal(traces(lacking, lacking), true);
    // But a PRESENT value the master does not have is a claim, and is refused.
    const claimed = clone(wideOriginal()) as unknown as Sections;
    // Text where the master has null.
    claimed['achievements']![0]!['description'] = 'Won first prize';
    // Refused.
    assert.equal(traces(claimed), false);
    // And a missing key whose master value HAS content is still refused (the employer, here).
    const noCompany = clone(wideOriginal()) as unknown as Sections;
    // The company dropped.
    delete noCompany['experience']![0]!['company'];
    // Refused.
    assert.equal(traces(noCompany), false);
  });

  it('refuses an own __proto__ key and a blank or runaway bullet text (review findings, 2026-11-01)', () => {
    // An own "__proto__" key, as JSON.parse creates it: prev['__proto__'] reads the prototype, so a
    // value-only compare called it unchanged.
    const smuggled = JSON.parse(JSON.stringify(wideOriginal()).replace(/^{/, '{"__proto__":{},'));
    // Refused: a key the stored resume does not own.
    assert.equal(traces(smuggled), false);
    // A bullet emptied by a hand-built object, bypassing applyTextEdit.
    const blank = clone(wideOriginal()) as unknown as Sections;
    // Whitespace only.
    blank['experience']![0]!.bullets[0]!.text = '   ';
    // Refused at the boundary.
    assert.equal(traces(blank), false);
    // A runaway paste, one past the cap.
    const runaway = clone(wideOriginal()) as unknown as Sections;
    // MAX_EDIT_LENGTH + 1 characters.
    runaway['experience']![0]!.bullets[0]!.text = 'x'.repeat(edits.MAX_EDIT_LENGTH + 1);
    // Refused.
    assert.equal(traces(runaway), false);
  });

  it('refuses a duplicate bullet ref or a duplicate entry ref', () => {
    // A bullet printed twice in its own entry.
    const bullet = clone(wideOriginal()) as unknown as Sections;
    // Same node appended again.
    bullet['experience']![0]!.bullets.push(bullet['experience']![0]!.bullets[0]!);
    // Refused.
    assert.equal(traces(bullet), false);
    // An entry printed twice.
    const entry = clone(wideOriginal()) as unknown as Sections;
    // Same project appended again.
    entry['projects']!.push(entry['projects']![0]!);
    // Refused.
    assert.equal(traces(entry), false);
  });

  it('refuses master_text altered, in any section', () => {
    // Each section's first bullet, master_text rewritten to match a new text.
    for (const section of ['experience', 'achievements', 'certifications']) {
      // A fresh candidate per section.
      const tampered = clone(wideOriginal()) as unknown as Sections;
      // Both fields moved together, as a careless edit would.
      Object.assign(tampered[section]![0]!.bullets[0]!, { text: 'Rewritten', master_text: 'Rewritten' });
      // Refused, named by section on failure.
      assert.equal(traces(tampered), false, section);
    }
  });

  it('refuses a section_order with an unknown kind or a duplicate kind', () => {
    // An unknown kind the renderer has no instruction for.
    const unknown = clone(wideOriginal()) as unknown as Sections;
    // Appended.
    unknown.section_order.push('hobbies');
    // Refused.
    assert.equal(traces(unknown), false);
    // A kind twice would print that section twice.
    const duplicate = clone(wideOriginal()) as unknown as Sections;
    // experience listed again.
    duplicate.section_order.push('experience');
    // Refused.
    assert.equal(traces(duplicate), false);
    // Not an array at all.
    assert.equal(traces({ ...wideOriginal(), section_order: 'experience' }), false);
  });

  it('refuses a changed section with no slot; an untouched slotless section blocks nothing', () => {
    // A stored row whose tailor left achievements out of section_order (the tailor only checks Array.isArray).
    const stored = clone(wideOriginal()) as unknown as Sections;
    // The slot removed, entries kept.
    stored.section_order = stored.section_order.filter((kind) => kind !== 'achievements');
    // An edit elsewhere is not blocked by the tailor's quirk.
    assert.equal(traces(okResume(edits.applyTextEdit(stored as never, { kind: 'bullet', ref: 'b-api' }, 'Built an API')), stored), true);
    // A text edit INSIDE the slotless section would be saved but never printed: refused.
    assert.equal(traces(okResume(edits.applyTextEdit(stored as never, { kind: 'bullet', ref: 'b-ach' }, 'Won a hackathon')), stored), false);
    // addMasterEntry appends the slot, so its own output passes.
    assert.equal(traces(okResume(edits.addMasterEntry(stored as never, wideFull(), 'achievements', 'ach-leet')), stored), true);
  });

  it('DIFF_BULLET_SECTIONS is exactly the section list diffAdapter bulletGroups walks', () => {
    // The adapter's source, read rather than imported: bulletGroups is not exported.
    const source = readFileSync(fileURLToPath(new URL('../src/features/approval/diffAdapter.ts', import.meta.url)), 'utf8');
    // The function body, from its declaration to the closing `] as const;`.
    const body = /function bulletGroups\([^)]*\)\s*\{([\s\S]*?)\]\s*as const;/.exec(source)?.[1];
    // Fails loudly if the function is renamed or reshaped, instead of passing on zero matches.
    assert.ok(body, 'bulletGroups not found in diffAdapter.ts');
    // Every `section: '<name>'` CODE entry, not a prose mention in a comment.
    const walked = [...body.matchAll(/\{\s*section:\s*'(\w+)'\s*,\s*entries:\s*resume\.\1\s*\}/g)].map((m) => m[1]);
    // Non-empty, so the equality below cannot pass vacuously.
    assert.ok(walked.length > 0, 'no section entries parsed from bulletGroups');
    // D5a: the gate frees every bullet section, so the diff must show (and count) every one, in order.
    assert.deepEqual([...edits.DIFF_BULLET_SECTIONS], walked);
  });
});

describe('resolveFullMaster', () => {
  it('resolves every master node exactly as the validator would', () => {
    // FULL for the wide master.
    const full = wideFull();
    // Every entry of every section, in master order.
    assert.deepEqual(full.projects.map((p) => p.ref), ['proj-cli', 'proj-f1']);
    // Including the bullets the tailor left out.
    assert.deepEqual(full.experience[1]!.bullets.map((b) => b.ref), ['b-beta', 'b-beta-2']);
    // The award sections too.
    assert.deepEqual(full.achievements.map((a) => a.ref), ['ach-hack', 'ach-leet']);
    // Each bullet in the master's words, text and master_text alike.
    assert.deepEqual(full.experience[1]!.bullets[1], { ref: 'b-beta-2', text: 'Cut Beta deploy time in half', master_text: 'Cut Beta deploy time in half' });
    // The tailor's entries are field-for-field FULL's (the property rule 4 relies on).
    assert.deepEqual(wideOriginal().experience[0], full.experience[0]);
  });

  it('returns null, never throws, for a master the validator refuses or garbage', () => {
    // Ids that collide make every lookup ambiguous.
    const ambiguous = clone(WIDE_MASTER as object) as { projects: { id: string }[] };
    // proj-f1 now shares proj-cli's id.
    ambiguous.projects[1]!.id = 'proj-cli';
    // No FULL.
    assert.equal(edits.resolveFullMaster(ambiguous as never, VERSION), null);
    // Not a master at all.
    assert.equal(edits.resolveFullMaster(null as never, VERSION), null);
    // Positive control.
    assert.notEqual(edits.resolveFullMaster(WIDE_MASTER, VERSION), null);
  });
});

describe('moveBullet and moveSection', () => {
  it('moveBullet swaps one bullet with its neighbour and records the order before and after', () => {
    // The reference, captured to prove no mutation.
    const orig = wideOriginal();
    // A JSON snapshot of the input.
    const beforeJson = snapshot(orig);
    // b-docs up one place.
    const out = edits.moveBullet(orig, 'b-docs', 'up');
    // Unwrapped.
    const resume = okResume(out);
    // The new order.
    assert.deepEqual(resume.experience[0]!.bullets.map((b) => b.ref), ['b-api', 'b-docs', 'b-tests']);
    // The event replays the move.
    assert.deepEqual(out.ok && [out.before, out.after], ['b-api, b-tests, b-docs', 'b-api, b-docs, b-tests']);
    // Input untouched.
    assert.equal(snapshot(orig), beforeJson);
    // Down is the mirror.
    assert.deepEqual(okResume(edits.moveBullet(orig, 'b-api', 'down')).experience[0]!.bullets.map((b) => b.ref), ['b-tests', 'b-api', 'b-docs']);
  });

  it('moveBullet refuses the edges and an unknown ref', () => {
    // First cannot go up.
    assert.equal(edits.moveBullet(wideOriginal(), 'b-api', 'up').ok, false);
    // Last cannot go down.
    assert.equal(edits.moveBullet(wideOriginal(), 'b-docs', 'down').ok, false);
    // A lone bullet can go nowhere.
    assert.equal(edits.moveBullet(wideOriginal(), 'b-beta', 'down').ok, false);
    // Not on the resume.
    assert.equal(edits.moveBullet(wideOriginal(), 'b-beta-2', 'up').ok, false);
  });

  it('moveSection swaps one section with its neighbour; refuses the edges and an absent section', () => {
    // The tailor's order starts with summary.
    const orig = wideOriginal();
    // experience above summary.
    const out = edits.moveSection(orig, 'experience', 'up');
    // The new order's head.
    assert.deepEqual(okResume(out).section_order.slice(0, 2), ['experience', 'summary']);
    // Only the order changed.
    assert.deepEqual({ ...okResume(out), section_order: orig.section_order }, orig);
    // First cannot go up.
    assert.equal(edits.moveSection(orig, 'summary', 'up').ok, false);
    // Last cannot go down.
    assert.equal(edits.moveSection(orig, 'skills', 'down').ok, false);
    // The narrow fixture has no projects slot.
    assert.equal(edits.moveSection(original(), 'projects', 'up').ok, false);
  });
});

describe('addMasterBullet, addMasterEntry and removeEntry', () => {
  it("addMasterBullet inserts FULL's bullet after its last printed predecessor", () => {
    // Beta's missing bullet goes after b-beta.
    const out = edits.addMasterBullet(wideOriginal(), wideFull(), 'b-beta-2');
    // Unwrapped.
    const resume = okResume(out);
    // In master order, verbatim from FULL.
    assert.deepEqual(resume.experience[1]!.bullets, wideFull().experience[1]!.bullets);
    // The event names the master's words.
    assert.equal(out.ok && out.after, 'Cut Beta deploy time in half');
    // With the operator's reordering: Acme as [b-docs, b-api], then b-tests added back.
    const reordered = okResume(edits.moveBullet(okResume(edits.removeBullet(wideOriginal(), { kind: 'bullet', ref: 'b-tests' })), 'b-docs', 'up'));
    // Precondition.
    assert.deepEqual(reordered.experience[0]!.bullets.map((b) => b.ref), ['b-docs', 'b-api']);
    // b-tests follows b-api, its master predecessor, wherever b-api now sits.
    assert.deepEqual(okResume(edits.addMasterBullet(reordered, wideFull(), 'b-tests')).experience[0]!.bullets.map((b) => b.ref), ['b-docs', 'b-api', 'b-tests']);
  });

  it('addMasterBullet refuses a printed bullet, a non-master ref, and a bullet whose entry is not printed', () => {
    // Already on the resume.
    assert.equal(edits.addMasterBullet(wideOriginal(), wideFull(), 'b-api').ok, false);
    // Not in the master.
    assert.equal(edits.addMasterBullet(wideOriginal(), wideFull(), 'b-invented').ok, false);
    // proj-f1 is not printed, so its bullet would be an orphan.
    assert.equal(edits.addMasterBullet(wideOriginal(), wideFull(), 'b-f1').ok, false);
  });

  it("addMasterEntry inserts FULL's entry at its master position, bullets and all", () => {
    // proj-f1 follows proj-cli in the master.
    const out = edits.addMasterEntry(wideOriginal(), wideFull(), 'projects', 'proj-f1');
    // Unwrapped.
    const resume = okResume(out);
    // Order and content are FULL's.
    assert.deepEqual(resume.projects, wideFull().projects);
    // The event names it the way the operator reads it.
    assert.equal(out.ok && out.after, 'F1 Race Pace Predictor');
    // ach-leet goes AFTER ach-hack; with ach-hack removed it is first.
    const removed = okResume(edits.removeEntry(wideOriginal(), 'achievements', 'ach-hack'));
    // Alone in its section.
    assert.deepEqual(okResume(edits.addMasterEntry(removed, wideFull(), 'achievements', 'ach-leet')).achievements.map((a) => a.ref), ['ach-leet']);
  });

  it('addMasterEntry appends a missing slot to section_order, and refuses a printed or non-master entry', () => {
    // The narrow fixture has no achievements slot; FULL of the wide master supplies the entry.
    const narrow = original();
    // Precondition: no slot.
    assert.equal(narrow.section_order.includes('achievements'), false);
    // The slot is appended, after everything already ordered.
    assert.deepEqual(okResume(edits.addMasterEntry(narrow, wideFull(), 'achievements', 'ach-leet')).section_order, [...narrow.section_order, 'achievements']);
    // Already printed.
    assert.equal(edits.addMasterEntry(wideOriginal(), wideFull(), 'projects', 'proj-cli').ok, false);
    // Not in the master.
    assert.equal(edits.addMasterEntry(wideOriginal(), wideFull(), 'projects', 'proj-invented').ok, false);
    // A real ref in the wrong section.
    assert.equal(edits.addMasterEntry(wideOriginal(), wideFull(), 'certifications', 'ach-leet').ok, false);
  });

  it('removeEntry takes one entry off and keeps the slot; refuses an absent entry', () => {
    // The only achievement.
    const out = edits.removeEntry(wideOriginal(), 'achievements', 'ach-hack');
    // Unwrapped.
    const resume = okResume(out);
    // Gone, bullets and all.
    assert.deepEqual(resume.achievements, []);
    // The slot stays; the renderer drops an empty section.
    assert.ok(resume.section_order.includes('achievements'));
    // The event names what went.
    assert.equal(out.ok && out.before, 'Hackathon Winner');
    // Not on the resume.
    assert.equal(edits.removeEntry(wideOriginal(), 'achievements', 'ach-leet').ok, false);
  });
});

describe('entryLabel and addableFromMaster', () => {
  it('labels each section the way its heading reads, and never returns undefined', () => {
    // Company · role.
    assert.equal(edits.entryLabel('experience', { company: 'Aczen Technologies', role: 'Full Stack AI Engineer' }), 'Aczen Technologies · Full Stack AI Engineer');
    // A project by name.
    assert.equal(edits.entryLabel('projects', { name: 'F1 Race Pace Predictor' }), 'F1 Race Pace Predictor');
    // An award by label.
    assert.equal(edits.entryLabel('achievements', { label: 'LeetCode' }), 'LeetCode');
    // Institution · degree.
    assert.equal(edits.entryLabel('education', wideOriginal().education[0]), 'JNTU · B.Tech');
    // No naming field: the ref, then the master id, then ''.
    assert.equal(edits.entryLabel('projects', { ref: 'proj-x' }), 'proj-x');
    // A master node carries `id`.
    assert.equal(edits.entryLabel('projects', { id: 'proj-y' }), 'proj-y');
    // Garbage.
    assert.equal(edits.entryLabel('projects', null), '');
  });

  it('lists the missing bullets of printed entries and the missing entries, in master order', () => {
    // What the wide original leaves out.
    const addable = edits.addableFromMaster(wideOriginal(), wideFull());
    // One bullet, under the entry that prints.
    assert.deepEqual(addable.bullets, [{ ref: 'b-beta-2', text: 'Cut Beta deploy time in half', section: 'experience', parentRef: 'exp-beta', parentLabel: 'Beta Labs · Platform Intern' }]);
    // Two whole entries; b-f1 and b-leet come with them, not separately.
    assert.deepEqual(addable.entries, [{ ref: 'proj-f1', section: 'projects', label: 'F1 Race Pace Predictor' }, { ref: 'ach-leet', section: 'achievements', label: 'LeetCode' }]);
    // FULL against itself offers nothing.
    assert.deepEqual(edits.addableFromMaster(wideFull(), wideFull()), { bullets: [], entries: [] });
  });
});

describe('masterFromRow', () => {
  it('returns null for null, undefined, {}, an array and a string', () => {
    // No row value at all.
    assert.equal(edits.masterFromRow(null), null);
    // An absent column.
    assert.equal(edits.masterFromRow(undefined), null);
    // The fail-open case: `typeof {} === 'object'` let this through as a master.
    assert.equal(edits.masterFromRow({}), null);
    // jsonb can hold an array; it is not a profile.
    assert.equal(edits.masterFromRow([]), null);
    // Nor is a string.
    assert.equal(edits.masterFromRow('master'), null);
  });

  it('returns null when a field the diff or the validator dereferences is the wrong shape', () => {
    // A copy to break one field at a time.
    const broken = (patch: Record<string, unknown>) => edits.masterFromRow({ ...clone(MASTER as object), ...patch });
    // Future schema: not this reader's shape.
    assert.equal(broken({ schema_version: 2 }), null);
    // skills.map in skillsLine would throw.
    assert.equal(broken({ skills: 'Node.js' }), null);
    // The validator iterates achievements' bullets.
    assert.equal(broken({ achievements: undefined }), null);
    // An entry without a bullets array breaks every `for (const bullet of parent.bullets)`.
    assert.equal(broken({ experience: [{ id: 'exp-x' }] }), null);
    // The validator reads master.summary.id.
    assert.equal(broken({ summary: 'a paragraph' }), null);
    // Identity is copied verbatim and read field by field.
    assert.equal(broken({ identity: null }), null);
  });

  it('returns a real master as-is', () => {
    // The same reference back: a check, not a copy or a normalisation.
    assert.equal(edits.masterFromRow(MASTER), MASTER);
    // A null summary is legal (required field, nullable value).
    assert.notEqual(edits.masterFromRow({ ...clone(MASTER as object), summary: null }), null);
  });
});

describe('removeBullet and resetTarget, v2 cases', () => {
  it('removeBullet refuses an unknown ref', () => {
    // A ref not on the resume.
    assert.equal(edits.removeBullet(original(), { kind: 'bullet', ref: 'b-nope' }).ok, false);
    // Positive control: a known ref is removed.
    assert.equal(edits.removeBullet(original(), { kind: 'bullet', ref: 'b-tests' }).ok, true);
  });

  it('resetTarget restores an edited summary', () => {
    // The reference.
    const orig = original();
    // Edit the summary.
    const edited = okResume(edits.applyTextEdit(orig, { kind: 'summary' }, 'Something else.'));
    // Precondition: it changed.
    assert.notEqual(edited.summary, orig.summary);
    // Reset it.
    const reset = okResume(edits.resetTarget(edited, orig, { kind: 'summary' }));
    // Back to exactly the original.
    assert.deepEqual(reset, orig);
  });

  it('re-inserting with 3+ bullets keeps the relative order', () => {
    // [b-api, b-tests, b-docs].
    const orig = threeBullets();
    // The order as refs, for compact assertions.
    const refs = (r: ReturnType<typeof original>) => r.experience[0]!.bullets.map((b) => b.ref);
    // Remove the middle one and reset it: it returns between its siblings, not at the end.
    const middle = okResume(edits.removeBullet(orig, { kind: 'bullet', ref: 'b-tests' }));
    // Back in the middle.
    assert.deepEqual(refs(okResume(edits.resetTarget(middle, orig, { kind: 'bullet', ref: 'b-tests' }))), ['b-api', 'b-tests', 'b-docs']);
    // Remove the first two: [b-docs].
    const both = okResume(edits.removeBullet(okResume(edits.removeBullet(orig, { kind: 'bullet', ref: 'b-api' })), { kind: 'bullet', ref: 'b-tests' }));
    // Precondition.
    assert.deepEqual(refs(both), ['b-docs']);
    // Reset the second first: it goes before b-docs, not after it.
    const one = okResume(edits.resetTarget(both, orig, { kind: 'bullet', ref: 'b-tests' }));
    // Relative order held with a sibling still missing.
    assert.deepEqual(refs(one), ['b-tests', 'b-docs']);
    // Then the first: the full original order.
    assert.deepEqual(refs(okResume(edits.resetTarget(one, orig, { kind: 'bullet', ref: 'b-api' }))), ['b-api', 'b-tests', 'b-docs']);
  });
});

/* 7b (2026-10-08): the approval page reads a row's pin from tailored_profile.master_version and
 * must judge it EXACTLY as the auditor does (supabase/functions/_shared/audit/pinned-master.ts),
 * or the screen and the auditor could disagree about which master a resume is checked against.
 * A PARITY test, not a copy of the rules: both resolvers run over one table of pins, so a change
 * to either side that the other does not mirror goes red here. */
describe('readPin: parity with the auditor', () => {
  // The auditor's resolver, imported by relative path; it has no runtime imports.
  let auditor: typeof import('../../../supabase/functions/_shared/audit/pinned-master.ts');
  // Loaded once for the block.
  before(async () => {
    auditor = await import('../../../supabase/functions/_shared/audit/pinned-master.ts');
  });

  it('classifies every pin the way resolvePinnedMaster does', () => {
    // Absent, malformed, coerced-looking and valid pins; strings must NOT be coerced.
    const pins: unknown[] = [undefined, null, 0, -1, 1.5, '2', NaN, Infinity, 2 ** 53, true, {}, 1, 3];
    // A map holding every valid pin above, so the auditor never answers "version missing" here.
    const all = new Map([[1, {} as never], [3, {} as never]]);
    // Each pin, side by side.
    for (const pin of pins) {
      // The auditor's verdict for this pin.
      const theirs = auditor.resolvePinnedMaster(pin, all);
      // Ours, which stops before the lookup (the page fetches the version itself).
      const ours = edits.readPin(pin);
      // Same kind, named by the pin so a failure says which one diverged.
      assert.equal(ours.kind, theirs.kind, `pin ${String(pin)}`);
      // And the same version when pinned.
      if (ours.kind === 'pinned' && theirs.kind === 'pinned') assert.equal(ours.version, theirs.version);
    }
  });

  it('a string pin is invalid, never coerced to its number', () => {
    // Number('2') === 2 is the lenient-parser trap the auditor refuses too.
    assert.equal(edits.readPin('2').kind, 'invalid_pin');
  });
});

/* 7b review fix: the page's refusal cause comes from classifyTailored. The first 7b cut checked the
 * pin before the shape, so '{}' read "master version missing" and sent the operator to the wrong fix. */
describe('classifyTailored: the pin is blamed only when it is the ONLY problem', () => {
  it("'{}', null, an array and a string are no resume, never a pin problem", () => {
    // The case the reviewer found: an empty object has no pin AND no resume.
    assert.equal(edits.classifyTailored({}), 'not_a_resume');
    // Non-objects never reach the pin question.
    for (const value of [null, undefined, [], 'resume']) assert.equal(edits.classifyTailored(value), 'not_a_resume');
  });

  it('a full resume with a missing or malformed pin is no_pin', () => {
    // Pin removed: everything else is intact.
    const { master_version: _dropped, ...unpinned } = original() as unknown as Record<string, unknown>;
    assert.equal(edits.classifyTailored(unpinned), 'no_pin');
    // A string pin is malformed, not coerced.
    assert.equal(edits.classifyTailored({ ...original(), master_version: '2' }), 'no_pin');
  });

  it('a valid pin with a broken body is no resume; a complete one is a resume', () => {
    // The pin is fine, so the problem is the body.
    assert.equal(edits.classifyTailored({ ...original(), schema_version: 2 }), 'not_a_resume');
    // Positive control.
    assert.equal(edits.classifyTailored(original()), 'resume');
  });
});
