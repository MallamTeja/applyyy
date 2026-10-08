/* Tailored-resume editing on the approval page: how edits reach the diff and the bucket (task 8, 2026-10-06).
 *
 * The rulings tested here:
 *   R1 - an edited line is verdict 'edited', never 'traced', and never counted as traced coverage.
 *   R2 - a row with any edited or removed line is NEVER Bucket A, even with zero Auditor findings.
 *   D4 - when the original cannot be rebuilt, editing is disabled on every line.
 * "Edited" is DERIVED (current vs original rebuilt from tailor_refs), so these tests build the
 * "current" resume by mutating a clone of the original, never through the edit functions: the
 * adapter is tested on its own, and a bug in tailoredEdits.ts cannot mask one here.
 *
 * Fixture: the same validator-accepted MasterProfile + TailoredProfile as tailoredEdits.test.ts
 * (identity, one experience entry with two bullets, one skill, a summary node). */

import assert from 'node:assert/strict';
import { registerHooks, createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { describe, it, before } from 'node:test';
import { fileURLToPath } from 'node:url';

// Copied verbatim from coverageUnmeasured.test.ts: diffAdapter.ts has extensionless imports.
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

// The adapter: resumes in, view model out.
let adapter: typeof import('../src/features/approval/diffAdapter.ts');
// The derivations the bucket badge and the batch button both read.
let model: typeof import('../src/features/approval/diffModel.ts');
// The producer, used to build the original exactly as rebuildOriginal will.
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

// The master; every tailored word appears here, so the validator accepts the tailoring.
const MASTER = {
  // Shape marker.
  schema_version: 1,
  // Verbatim identity.
  identity: { full_name: 'Test Person', headline: 'Backend Engineer', email: 'test@example.com', phone: null, location: 'Hyderabad', links: [] },
  // A citable summary node.
  summary: { id: 'summary-master', text: 'Backend engineer building REST APIs in Node.js.' },
  // One employer, two bullets: one to change, one as the untouched control.
  experience: [{
    id: 'exp-acme', company: 'Acme', role: 'Backend Intern', location: 'Remote',
    start_display: 'Jun 2025', end_display: 'Aug 2025', start_date: null, end_date: null,
    bullets: [
      // Carries "Express", the honestly-matched keyword.
      { id: 'b-api', text: 'Built a REST API with Express and Node.js handling 500 users', tags: [] },
      // The bullet these tests edit or remove.
      { id: 'b-tests', text: 'Wrote unit tests for the billing service', tags: [] },
    ],
  }],
  // Required arrays.
  projects: [], education: [], achievements: [], certifications: [],
  // One skill.
  skills: [{ id: 'skill-node', name: 'Node.js', category: 'Frameworks' }],
  // Profile links.
  links: [],
} as never;

// The tailoring as stored in tailor_refs.
const TAILOR_REFS = {
  // Shape marker.
  schema_version: 1,
  // Matches VERSION.
  master_version: VERSION,
  // Document order.
  section_order: ['summary', 'experience', 'skills'],
  // Cites the master summary.
  summary: { text: 'Backend engineer shipping REST APIs in Node.js.', refs: ['summary-master'] },
  // Chosen by id.
  skills: [{ ref: 'skill-node' }],
  // Both bullets, verbatim.
  experience: [{ ref: 'exp-acme', bullets: [
    // Index 0.
    { ref: 'b-api', text: 'Built a REST API with Express and Node.js handling 500 users' },
    // Index 1.
    { ref: 'b-tests', text: 'Wrote unit tests for the billing service' },
  ] }],
  // Required arrays.
  projects: [], education: [], achievements: [], certifications: [],
} as never;

// The Auditor's path for the edited bullet, in the adapter's section.entry.bullet form.
const TESTS_PATH = 'experience.exp-acme.b-tests';
// "Express" is in an untouched bullet (honest); "Docker" appears only after the edit below.
const KEYWORDS = ['Express', 'Docker'];
// The operator's wording: introduces a JD keyword the master never contained.
const EDITED_TEXT = 'Wrote unit tests in Docker for the billing service';

// The original, rebuilt by the validator exactly as rebuildOriginal does.
const original = () => {
  // Producer verdict.
  const verdict = validator.validateTailoredProfile(TAILOR_REFS, MASTER, VERSION);
  // A refusal here is a fixture bug, named as such.
  assert.equal(verdict.ok, true, 'fixture must validate');
  // Narrowed; the cast is safe after the assert.
  return (verdict as { resume: import('../src/data/contract').ResolvedResume }).resume;
};

// A deep copy, mutated to simulate a saved edit; JSON is enough for plain data.
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value));

// The original with b-tests' text replaced, as a saved edit leaves tailored_profile.
// The text defaults to EDITED_TEXT; the superseded tests pass their own to keep or drop a claim.
const editedCurrent = (text: string = EDITED_TEXT) => {
  // Start from the tailor's version.
  const current = clone(original()) as { experience: { bullets: { text: string }[] }[] };
  // Only `text` changes; master_text stays, per R0.
  current.experience[0]!.bullets[1]!.text = text;
  // Retyped for the adapter.
  return current as never;
};

// The original with b-tests deleted, as a saved removal leaves tailored_profile.
const removedCurrent = () => {
  // Start from the tailor's version.
  const current = clone(original()) as { experience: { bullets: unknown[] }[] };
  // Remove index 1.
  current.experience[0]!.bullets.splice(1, 1);
  // Retyped for the adapter.
  return current as never;
};

// One Auditor finding on the tailor's version of b-tests.
const testsFinding = { path: TESTS_PATH, claim: 'billing service', reason: 'test finding', confidence: null };

// Build the diff the page would build; the row carries only the fields the adapter reads.
const diff = (resolved: unknown, opts: { original?: unknown; findings?: unknown[] } = {}) =>
  adapter.buildResumeDiff({
    // Minimal application row: id, pinned version, findings and JD keywords.
    application: { id: 'app-1', master_version: VERSION, audit_findings: opts.findings ?? [], selected_jd_keywords: KEYWORDS } as never,
    // Header fields only.
    job: { title: 'Backend Engineer', company_name: 'Acme' },
    // What tailored_profile holds now.
    resolved: resolved as never,
    // The pinned master, for the skills line.
    master: MASTER,
    // `original` absent from opts means "rebuilt successfully"; explicit null means D4.
    original: (opts.original === undefined ? original() : opts.original) as never,
  });

// The line for one bullet ref, found by its master node so the id format is not assumed.
const lineFor = (d: ReturnType<typeof diff>, ref: string) => {
  // Exactly one line per bullet ref.
  const line = d.lines.find((l) => l.masterNodeId === ref);
  // Missing line is a failure, not an undefined to read through.
  assert.ok(line, `no line for ${ref}`);
  // Narrowed.
  return line;
};

describe('bucket', () => {
  it('an edited row is never Bucket A', () => {
    // Zero findings, one edited bullet.
    const edited = diff(editedCurrent());
    // Exactly one changed line.
    assert.equal(edited.editCount, 1);
    // R2: the operator's own wording needs a deliberate look, so never batch-approvable.
    assert.equal(model.deriveBucket(edited), 'B');
    // Positive control: the same input, unedited, is Bucket A.
    const unedited = diff(original());
    // Nothing changed.
    assert.equal(unedited.editCount, 0);
    // So the row is batch-approvable.
    assert.equal(model.deriveBucket(unedited), 'A');
  });

  it('a removed bullet also makes the row Bucket B', () => {
    // Zero findings, one removed bullet.
    const removed = diff(removedCurrent());
    // A removal counts as a change.
    assert.equal(removed.editCount, 1);
    // R2 names removed lines too.
    assert.equal(model.deriveBucket(removed), 'B');
  });
});

describe('edited and removed lines', () => {
  it("the edited line is 'edited' with an 'edited' run and no 'traced' run", () => {
    // The edited bullet's line.
    const line = lineFor(diff(editedCurrent()), 'b-tests');
    // Its state.
    assert.equal(line.editState, 'edited');
    // R1: at least one run says 'edited'.
    assert.ok(line.tailoredRuns.some((r) => r.verdict === 'edited'));
    // R1: none says 'traced', or the operator's words would read as the master's.
    assert.equal(line.tailoredRuns.filter((r) => r.verdict === 'traced').length, 0);
    // The run carries the saved text.
    assert.deepEqual(line.tailoredRuns.map((r) => r.text).join(''), EDITED_TEXT);
    // The tailor's version is kept for the reset button and the comparison.
    assert.equal(line.originalText, 'Wrote unit tests for the billing service');
    // Positive control: the untouched bullet is still 'original' and traced.
    const control = lineFor(diff(editedCurrent()), 'b-api');
    // Unchanged state.
    assert.equal(control.editState, 'original');
    // Still traced.
    assert.ok(control.tailoredRuns.some((r) => r.verdict === 'traced'));
  });

  it("a removed bullet is a line with editState 'removed' and no tailored runs", () => {
    // The removed bullet still appears, built from the original.
    const line = lineFor(diff(removedCurrent()), 'b-tests');
    // Its state.
    assert.equal(line.editState, 'removed');
    // Nothing of it will print.
    assert.deepEqual(line.tailoredRuns, []);
    // Still targetable, so Reset can restore it.
    assert.deepEqual(line.editTarget, { kind: 'bullet', ref: 'b-tests' });
    // Positive control: the kept bullet still has runs.
    assert.ok(lineFor(diff(removedCurrent()), 'b-api').tailoredRuns.length > 0);
  });
});

describe('findings on changed lines are superseded', () => {
  it('a flagged claim removed by the edit is superseded', () => {
    // The operator's rewrite drops "billing service" entirely.
    const d = diff(editedCurrent('Wrote unit tests in Docker'), { findings: [testsFinding] });
    // The claim is recorded against the line it was made about.
    assert.deepEqual(lineFor(d, 'b-tests').supersededClaims, ['billing service']);
    // Not an open flag: the flagged wording is no longer on the resume.
    assert.deepEqual(model.collectFlaggedClaims(d).map((c) => c.text), []);
    // Not lost into the unlocated list either.
    assert.equal(d.unlocatedClaims.length, 0);
    // Positive control: the same finding on the UNedited resume is an open flag.
    assert.equal(model.collectFlaggedClaims(diff(original(), { findings: [testsFinding] })).length, 1);
  });

  it('a flagged claim kept verbatim in an edit still gates approval', () => {
    // Earned in review: an edit that changes a DIFFERENT word must not launder the flagged one.
    // "unit" becomes "integration"; "billing service" survives untouched.
    const d = diff(editedCurrent('Wrote integration tests for the billing service'), { findings: [testsFinding] });
    // The line under test.
    const line = lineFor(d, 'b-tests');
    // Still an open flag, so the approval gate stays shut.
    assert.ok(model.collectFlaggedClaims(d).some((c) => c.text.toLowerCase() === 'billing service'));
    // The kept words are marked fabricated inside the edited text.
    const fabricated = line.tailoredRuns.filter((r) => r.verdict === 'fabricated');
    // Exactly the claim, matched case-insensitively.
    assert.deepEqual(fabricated.map((r) => r.text.toLowerCase()), ['billing service']);
    // Every other run is the operator's wording.
    assert.deepEqual(line.tailoredRuns.filter((r) => r.verdict !== 'fabricated').map((r) => r.verdict), ['edited']);
    // Nothing on an edited line is ever traced (R1).
    assert.equal(line.tailoredRuns.filter((r) => r.verdict === 'traced').length, 0);
    // Not superseded: the claim is still on the resume.
    assert.equal(line.supersededClaims.includes('billing service'), false);
    // Still the edited state, so the row also counts as edited.
    assert.equal(line.editState, 'edited');
    // Positive control: the run texts reassemble the saved edit, so nothing was dropped.
    assert.equal(line.tailoredRuns.map((r) => r.text).join(''), 'Wrote integration tests for the billing service');
  });

  it('a finding on a removed bullet lands in supersededClaims, not flagged or unlocated', () => {
    // The flagged bullet was removed outright.
    const d = diff(removedCurrent(), { findings: [testsFinding] });
    // Recorded against the removed line.
    assert.deepEqual(lineFor(d, 'b-tests').supersededClaims, ['billing service']);
    // Not an open flag.
    assert.equal(model.collectFlaggedClaims(d).length, 0);
    // Not unlocated.
    assert.equal(d.unlocatedClaims.length, 0);
    // Positive control: the unchanged bullet carries no superseded claims.
    assert.deepEqual(lineFor(d, 'b-api').supersededClaims, []);
  });
});

describe('coverage', () => {
  it('a keyword only in edited text is matchedByEdit, not honest', () => {
    // "Docker" exists only in the operator's wording.
    const d = diff(editedCurrent());
    // Credited to the edit.
    assert.deepEqual(d.coverage.matchedByEdit, ['Docker']);
    // Never as master-backed.
    assert.deepEqual(d.coverage.honestlyMatched, ['Express']);
    // Nor as fabrication: the Auditor never saw it.
    assert.deepEqual(d.coverage.matchedByFabrication, []);
    // The honest figure excludes it: 1 of 2.
    assert.deepEqual(model.coveragePercent(d.coverage, 'honest'), { kind: 'measured', percent: 50 });
    // The with-edits figure includes it: 2 of 2.
    assert.deepEqual(model.coveragePercent(d.coverage, 'withEdits'), { kind: 'measured', percent: 100 });
    // Positive control: unedited, nothing is matched by edit.
    assert.deepEqual(diff(original()).coverage.matchedByEdit, []);
  });
});

describe('D4: original cannot be rebuilt', () => {
  it('original null disables editing on every line and counts no edits', () => {
    // The page could not rebuild the original, so "edited" cannot be derived.
    const d = diff(editedCurrent(), { original: null });
    // No baseline, no edit count.
    assert.equal(d.editCount, 0);
    // Every line, skills and summary included, has no edit target.
    assert.deepEqual(d.lines.map((l) => l.editTarget), d.lines.map(() => null));
    // And there was at least one line to check, so the line above is not vacuous.
    assert.ok(d.lines.length >= 3);
    // Positive control: with the original, bullet lines are targetable.
    assert.deepEqual(lineFor(diff(original()), 'b-api').editTarget, { kind: 'bullet', ref: 'b-api' });
    // Positive control: and the summary line is targetable.
    assert.deepEqual(diff(original()).lines.find((l) => l.kind === 'summary')?.editTarget, { kind: 'summary' });
  });
});

/* THE PAGE WIRING of fixes 2b/3 and 4 (added 2026-10-08 by peer 1, integrating task 8).
 * Red-on-revert found both controls UNGUARDED: deleting the page's freshness check or turning a
 * missing master back into a page-wide error left the suite at 364/364. The pure helpers are tested
 * in their own files; these hold the CALL SITES. ApprovalQueuePage.tsx cannot be mounted here
 * without a Supabase double and effects, so the assertions match CODE SHAPE on the page with its
 * comments stripped by the TypeScript printer: a comment describing the old bug cannot trip them,
 * and a comment cannot satisfy them either (CLAUDE.md section 3). */
describe('approval page wiring: per-row freshness (fixes 2b/3) and missing master (fix 4)', () => {
  // apps/web's own typescript, already used by the load hook above.
  const ts = createRequire(import.meta.url)('typescript') as typeof import('typescript');
  // The page as written.
  const raw = readFileSync(fileURLToPath(new URL('../src/features/approval/ApprovalQueuePage.tsx', import.meta.url)), 'utf8');
  // Comment-free code: the printer re-emits the AST without comments, keeping literals as written.
  const page = ts.createPrinter({ removeComments: true }).printFile(ts.createSourceFile('page.tsx', raw, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX));
  // The text between two anchors; a missing anchor fails loudly instead of matching nothing.
  const between = (from: string, to: string): string => {
    // Start anchor must exist.
    const start = page.indexOf(from);
    assert.ok(start >= 0, `anchor not found: ${from}`);
    // End anchor must exist after it.
    const end = page.indexOf(to, start + from.length);
    assert.ok(end > start, `anchor not found after ${from}: ${to}`);
    // The slice the assertion reads.
    return page.slice(start, end);
  };

  it('every approval re-reads its row with confirmFresh inside the per-row loop, before the RPC', () => {
    // The body of settle(), where every approve and reject is sent.
    const settle = between('async function settle(', 'function approveReviewed(');
    // The per-row loop.
    const loop = settle.slice(settle.indexOf('for (const id of mine)'));
    // The check is in the loop, so each row is checked at its own send time, not once per batch.
    const check = loop.search(/await confirmFresh\(supabase, id, stamp\)/);
    assert.ok(check >= 0, 'confirmFresh(supabase, id, stamp) is not awaited inside the per-row loop');
    // And it precedes the one RPC that approves.
    assert.ok(check < loop.indexOf("rpc('advance_application_status'"), 'the freshness check must run before the RPC');
    // Gated on approval only, never on requireBucketA, so individual approvals are checked too.
    assert.match(loop, /if \(to === 'approved'\) \{\s*const stamp = latestStamps\.current\.get\(id\);/);
  });

  it('a changed or unverifiable row is skipped, never approved', () => {
    // From the changed branch to the unverifiable branch.
    const changed = between("if (check.kind === 'changed') {", "if (check.kind === 'unverifiable') {");
    // The changed branch ends the row's turn.
    assert.match(changed, /continue;/);
    // From the unverifiable branch to the bucket re-check that follows.
    const unverifiable = between("if (check.kind === 'unverifiable') {", 'const latest = latestDiffs.current.get(id);');
    // So does the unverifiable one.
    assert.match(unverifiable, /continue;/);
  });

  it('a missing pinned master refuses ONLY its own row, through the shape check', () => {
    // The master is resolved through the shape check, not "is it an object".
    assert.match(page, /master = masterFromRow\(masterData\?\.profile\);/);
    // The branch taken when the pinned version is missing or not a profile.
    const missing = between('if (master === null) {', 'const original = rebuildOriginal(');
    // Named in the refused list with its own cause...
    assert.match(missing, /refused\.push\(\{[\s\S]*reason: 'no_pinned_master'/);
    // ...and the loop moves on to the next row.
    assert.match(missing, /continue;/);
    // Never the page-wide error, which is what hid every reviewable row behind one bad one.
    assert.doesNotMatch(missing, /setLoadError\(/);
    // And never an early exit from the loader.
    assert.doesNotMatch(missing, /return;/);
  });

  it('7b: an unpinned or malformed pin refuses its own row before any master is fetched', () => {
    // From the classifier's no_pin branch to the resume shape gate that follows it.
    const pin = between("if (classifyTailored(app.tailored_profile) === 'no_pin') {", 'if (!isResumeShape(app.tailored_profile))');
    // The pin verdict (from classifyTailored, unit-tested in tailoredEdits.test.ts) refuses by name...
    assert.match(pin, /reason: 'no_pin'[\s\S]*continue;/);
    // ...and never turned into a page-wide error.
    assert.doesNotMatch(pin, /setLoadError\(/);
    // The pin check precedes the master fetch, so no "latest" or other version is ever asked for.
    assert.ok(page.indexOf('classifyTailored(') < page.indexOf(".from('master_profiles')"), 'the pin must be checked before any master is fetched');
    // The diff shows the snapshot's own pin, with no fallback to the never-written column.
    const adapter = ts.createPrinter({ removeComments: true }).printFile(ts.createSourceFile('a.ts', readFileSync(fileURLToPath(new URL('../src/features/approval/diffAdapter.ts', import.meta.url)), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS));
    // Shape, not prose: the property assignment names only the snapshot.
    assert.match(adapter, /masterVersion: resolved\.master_version,/);
  });
});
