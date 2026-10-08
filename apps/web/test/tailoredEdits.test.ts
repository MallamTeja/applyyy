/* Tailored-resume editing on the approval page: the pure edit functions (task 8 contract, 2026-10-06).
 *
 * The load-bearing ruling is R0: an edit writes a bullet's `text` (or the top-level `summary`) and
 * NOTHING else. `master_text` is the Auditor's and the diff's ground truth; an edit that touched it
 * would make the operator's own words read as traced to the master. So the starred test compares the
 * WHOLE resume after an edit against the whole resume before, with exactly one field changed.
 *
 * Fixture: a MasterProfile + TailoredProfile that validateTailoredProfile accepts (verified with a
 * throwaway node one-liner before these assertions were written: it returned ok:true). Kept small:
 * identity, one experience entry with two bullets, one skill, a summary node. */

import assert from 'node:assert/strict';
import { registerHooks, createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { describe, it, before } from 'node:test';
import { fileURLToPath } from 'node:url';

// Copied verbatim from coverageUnmeasured.test.ts: approval modules use extensionless imports.
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
  // Same load hook as the other web render tests.
  load(url, context, nextLoad) {
    // Stylesheets have no runtime meaning in Node.
    if (url.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true };
    // Only .tsx needs transpiling; .ts is type-stripped by Node itself.
    if (!url.endsWith('.tsx')) return nextLoad(url, context);
    // apps/web's own typescript, no new dependency.
    const ts = createRequire(import.meta.url)('typescript') as typeof import('typescript');
    // nextLoad refuses .tsx, so read it directly.
    const source = readFileSync(fileURLToPath(url), 'utf8');
    // react-jsx matches tsconfig.
    const out = ts.transpileModule(source, {
      compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    });
    // Plain ESM for Node.
    return { format: 'module', source: out.outputText, shortCircuit: true };
  },
});

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

describe('onlyTextChanged', () => {
  it('is true for the outputs of applyTextEdit, removeBullet and resetTarget', () => {
    // The tailor's version doubles as the stored previous.
    const orig = original();
    // A bullet text edit.
    const edited = okResume(edits.applyTextEdit(orig, { kind: 'bullet', ref: 'b-tests' }, 'Wrote integration tests'));
    // Text is free.
    assert.equal(edits.onlyTextChanged(orig, edited, orig), true);
    // A summary edit.
    const summary = okResume(edits.applyTextEdit(orig, { kind: 'summary' }, 'Engineer who ships Node.js APIs.'));
    // Summary is free.
    assert.equal(edits.onlyTextChanged(orig, summary, orig), true);
    // A removal.
    const removed = okResume(edits.removeBullet(orig, { kind: 'bullet', ref: 'b-api' }));
    // Removing a bullet this page owns is allowed.
    assert.equal(edits.onlyTextChanged(orig, removed, orig), true);
    // Re-inserting it, measured against the removed state as previous.
    const restored = okResume(edits.resetTarget(removed, orig, { kind: 'bullet', ref: 'b-api' }));
    // Re-insertion of an original bullet is allowed.
    assert.equal(edits.onlyTextChanged(removed, restored, orig), true);
  });

  it('is false when master_text, identity, master_version or a non-bullet entry field changes', () => {
    // The reference.
    const orig = original();
    // master_text rewritten to match an edit: the R0 violation that makes edits read as traced.
    const masterText = clone(orig);
    // Both fields moved together, as a careless edit would.
    masterText.experience[0]!.bullets[1] = { ...masterText.experience[0]!.bullets[1]!, text: 'X', master_text: 'X' };
    // Refused.
    assert.equal(edits.onlyTextChanged(orig, masterText, orig), false);
    // Identity is the master's, never editable here.
    assert.equal(edits.onlyTextChanged(orig, { ...orig, identity: { ...orig.identity, full_name: 'Someone Else' } }, orig), false);
    // The pin must survive.
    assert.equal(edits.onlyTextChanged(orig, { ...orig, master_version: VERSION + 1 }, orig), false);
    // An entry's display field: an employer cannot be renamed from this page.
    const company = clone(orig);
    // Only the company changes; bullets untouched.
    company.experience[0] = { ...company.experience[0]!, company: 'Bigger Corp' };
    // Refused.
    assert.equal(edits.onlyTextChanged(orig, company, orig), false);
    // A bullet whose ref the tailor never produced is an invented bullet.
    const invented = clone(orig);
    // Appended with a ref absent from the original.
    invented.experience[0]!.bullets.push({ ref: 'b-new', text: 'New', master_text: 'New' });
    // Refused.
    assert.equal(edits.onlyTextChanged(orig, invented, orig), false);
    // Positive control: an unchanged resume is text-only by definition.
    assert.equal(edits.onlyTextChanged(orig, clone(orig), orig), true);
  });
});

// --- D5: the save boundary must agree with what the diff shows (2026-10-08) ---------------------

// The original widened to every bullet section plus a second employer, so a relocation has
// somewhere to go and a hidden-section edit has something to edit. Only the pure functions see it.
const wideOriginal = () => {
  // Start from the validator's own resume so every real field is present.
  const resume = clone(original()) as unknown as Record<string, { ref: string; bullets: { ref: string; text: string; master_text: string }[] }[]>;
  // A one-bullet helper, so each fixture bullet's text and master_text start equal, as the validator's do.
  const b = (ref: string, text: string) => ({ ref, text, master_text: text });
  // A second employer: the destination a relocated claim would be laundered into.
  resume['experience']!.push({ ...resume['experience']![0]!, ref: 'exp-beta', bullets: [b('b-beta', 'Ran the Beta on-call rota')] });
  // A project and a degree, so the two other diff-rendered sections are covered by a real edit.
  resume['projects'] = [{ ref: 'proj-cli', bullets: [b('b-proj', 'Shipped a CLI for log search')] }];
  // Education is rendered by the diff too, so its text must stay editable.
  resume['education'] = [{ ref: 'edu-btech', bullets: [b('b-edu', 'Graduated with honours')] }];
  // Achievements: stored and sent, but never on the diff - the section D5(a) is about.
  resume['achievements'] = [{ ref: 'ach-hack', bullets: [b('b-ach', 'Won first place at a hackathon')] }];
  // Certifications: same blind spot as achievements.
  resume['certifications'] = [{ ref: 'cert-aws', bullets: [b('b-cert', 'Passed the AWS associate exam')] }];
  // Retyped for the functions under test.
  return resume as unknown as ReturnType<typeof original>;
};

// Mutable view of a cloned resume's bullet sections, so the hand-built violations stay readable.
type Sections = Record<string, { ref: string; bullets: { ref: string; text: string }[] }[]>;

describe('onlyTextChanged, D5 save-boundary cases', () => {
  it('refuses a text change in an achievements or certifications bullet (the diff never shows it)', () => {
    // The reference, with both hidden sections populated.
    const orig = wideOriginal();
    // An achievement reworded: editCount would stay 0 and the row would batch-approve unseen.
    const ach = clone(orig) as unknown as Sections;
    // Only `text` changes - exactly what R0 allows in a SHOWN section.
    ach['achievements']![0]!.bullets[0]!.text = 'Won the national hackathon';
    // Refused: text is free only where the operator's diff can see it.
    assert.equal(edits.onlyTextChanged(orig, ach as never, orig), false);
    // A certification reworded, same blind spot.
    const cert = clone(orig) as unknown as Sections;
    // Only `text` changes.
    cert['certifications']![0]!.bullets[0]!.text = 'Passed the AWS professional exam';
    // Refused.
    assert.equal(edits.onlyTextChanged(orig, cert as never, orig), false);
    // Positive control: the unchanged wide resume is clean, so the refusals above are about the edit.
    assert.equal(edits.onlyTextChanged(orig, clone(orig), orig), true);
  });

  it('refuses removing a bullet from a section the diff does not show', () => {
    // The reference.
    const orig = wideOriginal();
    // removeBullet locates in every section, so it CAN produce this; no diff line would record it.
    const gone = okResume(edits.removeBullet(orig, { kind: 'bullet', ref: 'b-ach' }));
    // Refused: an invisible removal is as unreviewed as an invisible edit.
    assert.equal(edits.onlyTextChanged(orig, gone, orig), false);
  });

  it('refuses a bullet moved under another entry', () => {
    // The reference: two employers.
    const orig = wideOriginal();
    // The candidate, hand-built because no page function relocates.
    const moved = clone(orig) as unknown as Sections;
    // Take Acme's second bullet out...
    const [claim] = moved['experience']![0]!.bullets.splice(1, 1);
    // ...and file it under Beta: same ref, same text, a different employer's history.
    moved['experience']![1]!.bullets.push(claim!);
    // Refused: the parent entry is part of the claim.
    assert.equal(edits.onlyTextChanged(orig, moved as never, orig), false);
  });

  it('refuses two bullets swapped within an entry', () => {
    // The reference: Acme holds [b-api, b-tests].
    const orig = wideOriginal();
    // The candidate.
    const swapped = clone(orig) as unknown as Sections;
    // Reversed in place: every bullet still under its own parent, order changed.
    swapped['experience']![0]!.bullets.reverse();
    // Precondition: the swap really happened, so the refusal is about order.
    assert.deepEqual(swapped['experience']![0]!.bullets.map((x) => x.ref), ['b-tests', 'b-api']);
    // Refused: order is the tailor's decision, not this page's.
    assert.equal(edits.onlyTextChanged(orig, swapped as never, orig), false);
  });

  it('still accepts every page operation in the sections the diff shows', () => {
    // The reference.
    const orig = wideOriginal();
    // A text edit in each diff-rendered section.
    for (const ref of ['b-tests', 'b-proj', 'b-edu']) {
      // Each must stay legal, named on failure.
      assert.equal(edits.onlyTextChanged(orig, okResume(edits.applyTextEdit(orig, { kind: 'bullet', ref }, 'Reworded by the operator')), orig), true, ref);
    }
    // The summary is editable and outside the bullet walk.
    assert.equal(edits.onlyTextChanged(orig, okResume(edits.applyTextEdit(orig, { kind: 'summary' }, 'Engineer who ships Node.js APIs.')), orig), true);
    // Removing a whole shown bullet is legal (removeBullet).
    const removed = okResume(edits.removeBullet(orig, { kind: 'bullet', ref: 'b-api' }));
    // Accepted: the survivors keep their parent and relative order.
    assert.equal(edits.onlyTextChanged(orig, removed, orig), true);
    // Re-inserting it at its original place is legal (resetTarget).
    assert.equal(edits.onlyTextChanged(removed, okResume(edits.resetTarget(removed, orig, { kind: 'bullet', ref: 'b-api' })), orig), true);
    // The 3-bullet middle removal and reset, the case the relative-order logic exists for.
    const three = threeBullets();
    // Remove the middle one.
    const middle = okResume(edits.removeBullet(three, { kind: 'bullet', ref: 'b-tests' }));
    // Survivors [b-api, b-docs] keep relative order: legal.
    assert.equal(edits.onlyTextChanged(three, middle, three), true);
    // Reset puts it back between them: legal.
    assert.equal(edits.onlyTextChanged(middle, okResume(edits.resetTarget(middle, three, { kind: 'bullet', ref: 'b-tests' })), three), true);
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
    // The save boundary frees text in exactly the sections the operator sees, in the same order.
    assert.deepEqual([...edits.DIFF_BULLET_SECTIONS], walked);
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
