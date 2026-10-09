/* T3: add a missing JD keyword to the resume as a MASTER skill (written TDD, 2026-10-08).
 *
 * The integrity rule under test: a human may add only an UNSELECTED skill that already exists in
 * the pinned master, inserted as exactly { ref: id, name, category } copied from it. Never a
 * synthetic skill, never a renamed or re-categorised one. An added skill is the operator's choice,
 * so it reads as 'edited' (never 'traced'), counts in coverage.matchedByEdit, and takes the row out
 * of Bucket A. R0 still holds: nothing but resume.skills may change.
 *
 * Import shape: only modules that ALREADY exist are imported in before(), and every new export is
 * read inside its own test. A missing export then fails that one test with "is not a function"
 * instead of cancelling the whole suite from a before() hook (a cancelled suite hides everything).
 *
 * Fixture: the validator-accepted master + tailoring from tailoredEdits.test.ts, widened to FOUR
 * master skills with TWO selected, so there are unselected skills to add and two original skills
 * whose order can be checked. */

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

// The edit functions; the T3 exports are read per test so a missing one fails only its own test.
let edits: typeof import('../src/features/approval/tailoredEdits.ts');
// The adapter, for the skills DiffLine and coverage.
let adapter: typeof import('../src/features/approval/diffAdapter.ts');
// deriveBucket, the one function the badge and the batch button share.
let model: typeof import('../src/features/approval/diffModel.ts');
// The write boundary, for the "synthetic skill never reaches the network" test.
let save: typeof import('../src/features/approval/saveTailoredEdit.ts');

before(async () => {
  // All four modules exist before T3 lands, so this hook cannot cancel the suite.
  edits = await import('../src/features/approval/tailoredEdits.ts');
  // Loaded after the hooks so its extensionless imports resolve.
  adapter = await import('../src/features/approval/diffAdapter.ts');
  // Same.
  model = await import('../src/features/approval/diffModel.ts');
  // Same.
  save = await import('../src/features/approval/saveTailoredEdit.ts');
});

// The T3 surface, read loosely so this file runs before the builder's types exist.
type AnyFn = (...args: unknown[]) => any;
// Fetches one export by name; a missing one becomes a named assertion failure, not a TypeError.
const fn = (name: string): AnyFn => {
  // The module namespace as a plain record.
  const f = (edits as unknown as Record<string, unknown>)[name];
  // Named, so the report says WHICH contract export is absent.
  assert.equal(typeof f, 'function', `tailoredEdits.ts does not export ${name}()`);
  // Narrowed for the caller.
  return f as AnyFn;
};

// The pinned master version; the tailoring must name the same one or the validator refuses it.
const VERSION = 3;

// The master: same as tailoredEdits.test.ts, plus three more skills so some are unselected.
const MASTER = {
  // The profile's shape marker, not the row version.
  schema_version: 1,
  // Copied verbatim into the resume; R0 says an edit may never touch it.
  identity: { full_name: 'Test Person', headline: 'Backend Engineer', email: 'test@example.com', phone: null, location: 'Hyderabad', links: [] },
  // A real summary node, so the tailored summary has something honest to cite.
  summary: { id: 'summary-master', text: 'Backend engineer building REST APIs in Node.js.' },
  // One employer with two bullets; "Express" in b-api is the honestly-matched keyword control.
  experience: [{
    id: 'exp-acme', company: 'Acme', role: 'Backend Intern', location: 'Remote',
    start_display: 'Jun 2025', end_display: 'Aug 2025', start_date: null, end_date: null,
    bullets: [
      // Carries "Express".
      { id: 'b-api', text: 'Built a REST API with Express and Node.js handling 500 users', tags: [] },
      // The bullet the "non-skills change" test tampers with.
      { id: 'b-tests', text: 'Wrote unit tests for the billing service', tags: [] },
    ],
  }],
  // Empty sections are legal; the validator only requires one substantive section.
  projects: [], education: [], achievements: [], certifications: [],
  // ORDER MATTERS: Docker precedes Kubernetes, so "first in master order" is checkable.
  skills: [
    // Selected by the tailor.
    { id: 'skill-node', name: 'Node.js', category: 'Frameworks' },
    // NOT selected: the skill most tests add.
    { id: 'skill-docker', name: 'Docker', category: 'Tools' },
    // Selected by the tailor; the second original skill, so reordering is expressible.
    { id: 'skill-pg', name: 'PostgreSQL', category: 'Databases' },
    // NOT selected: the second addable skill.
    { id: 'skill-k8s', name: 'Kubernetes', category: 'Tools' },
  ],
  // Profile-level links, empty.
  links: [],
} as never;

// What the Tailor returned and what applications.tailor_refs stores.
const TAILOR_REFS = {
  // The contract's shape marker.
  schema_version: 1,
  // Matches VERSION, else rebuildOriginal returns null.
  master_version: VERSION,
  // Document order for the renderer; carried through untouched.
  section_order: ['summary', 'experience', 'skills'],
  // Prose citing the master summary, so the summary_without_refs rule passes.
  summary: { text: 'Backend engineer shipping REST APIs in Node.js.', refs: ['summary-master'] },
  // Two of four master skills chosen, by id only; Docker and Kubernetes are left addable.
  skills: [{ ref: 'skill-node' }, { ref: 'skill-pg' }],
  // Both bullets, in master order, worded from master tokens only.
  experience: [{ ref: 'exp-acme', bullets: [
    // Verbatim; numbers match the master so no invented_metric.
    { ref: 'b-api', text: 'Built a REST API with Express and Node.js handling 500 users' },
    // Verbatim.
    { ref: 'b-tests', text: 'Wrote unit tests for the billing service' },
  ] }],
  // Empty sections, required arrays.
  projects: [], education: [], achievements: [], certifications: [],
};

// The exact skill object an honest add of Docker must produce: copied from the master, three keys.
const DOCKER = { ref: 'skill-docker', name: 'Docker', category: 'Tools' };
// The same for Kubernetes.
const K8S = { ref: 'skill-k8s', name: 'Kubernetes', category: 'Tools' };

// Plain-data resume type for local mutation; the real type is the builder's.
type Resume = import('../src/data/contract').ResolvedResume;

// The rebuilt original; failing loudly here beats every later test failing on a null.
const original = (): Resume => {
  // The existing producer (not a T3 export), so this cannot fail just because T3 is missing.
  const resume = edits.rebuildOriginal(TAILOR_REFS, MASTER, VERSION);
  // A null here is a fixture bug, named as such.
  assert.notEqual(resume, null, 'fixture must rebuild to a ResolvedResume');
  // Narrowed for the callers.
  return resume!;
};

// A deep copy for hand-built candidates; JSON is enough for plain data.
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value));
// A JSON snapshot, so in-place mutation of nested objects is detected.
const snapshot = (value: unknown) => JSON.stringify(value);

// The original with extra skills appended by hand, so adapter tests do not depend on addSkill.
const withSkills = (...extra: unknown[]): Resume => {
  // Start from the tailor's version.
  const current = clone(original()) as unknown as { skills: unknown[] };
  // Appended, matching the contract's "skill appended".
  current.skills.push(...extra);
  // Retyped for the callers.
  return current as unknown as Resume;
};

// addSkill, asserted to succeed, returning the new resume; used as a step in later tests.
const added = (resume: Resume, ref: string): Resume => {
  // The contract call.
  const out = fn('addSkill')(resume, MASTER, ref);
  // A refusal here is a precondition failure, named.
  assert.equal(out.ok, true, `addSkill(${ref}) should succeed: ${out.reason ?? ''}`);
  // Narrowed for the caller.
  return out.resume as Resume;
};

describe('addableSkillFor', () => {
  it('returns the unselected master skill whose name matches the keyword, copied exactly', () => {
    // Case-insensitive: a lower-case JD keyword still finds "Docker".
    assert.deepEqual(fn('addableSkillFor')('docker', original(), MASTER), DOCKER);
    // Contract changed 2026-10-09 (QA s6): a keyword merely CONTAINING the name is a different
    // thing ("Docker Compose" is not Docker), so the old "name in keyword" branch is gone.
    assert.equal(fn('addableSkillFor')('Docker Compose', original(), MASTER), null);
    // The other unselected skill is found too.
    assert.deepEqual(fn('addableSkillFor')('Kubernetes', original(), MASTER), K8S);
  });

  it('a keyword naming several skills offers none of them (no fragment match)', () => {
    // Under token equality neither Docker nor Kubernetes IS "Docker on Kubernetes"; offering
    // one would leave the keyword missing, so null (CLAUDE.md §6: ambiguity is never a yes).
    assert.equal(fn('addableSkillFor')('Docker on Kubernetes', original(), MASTER), null);
  });

  it('returns null for a skill already on the resume, a non-word-bounded fragment, or no master skill', () => {
    // Node.js is selected already; adding it again would be a duplicate.
    assert.equal(fn('addableSkillFor')('Node.js', original(), MASTER), null);
    // PostgreSQL is selected already.
    assert.equal(fn('addableSkillFor')('postgresql', original(), MASTER), null);
    // "Dock" is a substring of "Docker" but not a word of it.
    assert.equal(fn('addableSkillFor')('Dock', original(), MASTER), null);
    // No master skill at all: never a synthetic one.
    assert.equal(fn('addableSkillFor')('Rust', original(), MASTER), null);
    // Once added, Docker is no longer addable.
    assert.equal(fn('addableSkillFor')('Docker', added(original(), 'skill-docker'), MASTER), null);
    // Positive control: the same keyword on the unedited resume is addable.
    assert.notEqual(fn('addableSkillFor')('Docker', original(), MASTER), null);
  });
});

describe('addSkill', () => {
  it('appends exactly the master skill and changes nothing else', () => {
    // Baseline.
    const before = original();
    // Captured before the call so in-place mutation shows up.
    const beforeJson = snapshot(before);
    // The operator adds Docker.
    const out = fn('addSkill')(before, MASTER, 'skill-docker');
    // Accepted.
    assert.equal(out.ok, true);
    // The expected result: the input with only `skills` extended by the exact master copy.
    const expected = JSON.parse(beforeJson);
    // Appended at the end, never interleaved with the tailor's order.
    expected.skills.push(DOCKER);
    // Whole-object equality: identity, versions, bullets, master_text, summary all unchanged (R0).
    assert.deepEqual(out.resume, expected);
    // A skill is chosen, not reworded: before is null.
    assert.equal(out.before, null);
    // The added skill's name, for the event log.
    assert.equal(out.after, 'Docker');
    // The input was not mutated: React state must never change under the renderer.
    assert.equal(snapshot(before), beforeJson);
    // A NEW object, so a reference-equality state update re-renders.
    assert.notEqual(out.resume, before);
  });

  it('refuses a ref that is not a master skill, or one already on the resume', () => {
    // Synthetic ref: the very thing the integrity rule forbids.
    const synthetic = fn('addSkill')(original(), MASTER, 'user:caching');
    // Refused.
    assert.equal(synthetic.ok, false);
    // With a reason the page can show.
    assert.equal(typeof synthetic.reason, 'string');
    // A plausible-looking but absent master id.
    assert.equal(fn('addSkill')(original(), MASTER, 'skill-nope').ok, false);
    // A non-skill master id (a bullet) is not a skill either.
    assert.equal(fn('addSkill')(original(), MASTER, 'b-api').ok, false);
    // Already selected by the tailor.
    assert.equal(fn('addSkill')(original(), MASTER, 'skill-node').ok, false);
    // Already added by the operator.
    assert.equal(fn('addSkill')(added(original(), 'skill-docker'), MASTER, 'skill-docker').ok, false);
    // Positive control: an unselected master skill is accepted.
    assert.equal(fn('addSkill')(original(), MASTER, 'skill-k8s').ok, true);
  });
});

describe('removeAddedSkill', () => {
  it('removes an added skill and returns exactly the resume before the add', () => {
    // Docker added.
    const withDocker = added(original(), 'skill-docker');
    // Captured to prove the input is not mutated.
    const json = snapshot(withDocker);
    // The operator takes it back off.
    const out = fn('removeAddedSkill')(withDocker, original(), 'skill-docker');
    // Accepted.
    assert.equal(out.ok, true);
    // Exactly the tailor's version again: nothing else drifted on the round trip.
    assert.deepEqual(out.resume, original());
    // The removed skill's name, for the event log.
    assert.equal(out.before, 'Docker');
    // Nothing replaces it.
    assert.equal(out.after, null);
    // Input untouched.
    assert.equal(snapshot(withDocker), json);
  });

  it("refuses to remove a tailor-selected skill, or a skill that isn't on the resume", () => {
    // Docker added, so the resume has one removable skill.
    const withDocker = added(original(), 'skill-docker');
    // Node.js is the tailor's selection: removing it is not "undo an add".
    assert.equal(fn('removeAddedSkill')(withDocker, original(), 'skill-node').ok, false);
    // Kubernetes was never added.
    assert.equal(fn('removeAddedSkill')(withDocker, original(), 'skill-k8s').ok, false);
    // Positive control: the added one is removable.
    assert.equal(fn('removeAddedSkill')(withDocker, original(), 'skill-docker').ok, true);
  });
});

describe("resetTarget({ kind: 'skills' })", () => {
  it("restores the tailor's skills exactly, dropping every added skill", () => {
    // Two skills added.
    const twoAdded = added(added(original(), 'skill-docker'), 'skill-k8s');
    // The existing reset entry point, with the new target kind.
    const out = edits.resetTarget(twoAdded, original(), { kind: 'skills' } as never);
    // Accepted.
    assert.equal(out.ok, true);
    // Narrow.
    if (!out.ok) return;
    // Skills equal the original's, in the original's order.
    assert.deepEqual(out.resume.skills, original().skills);
    // And the whole resume is the original: reset touched only skills.
    assert.deepEqual(out.resume, original());
  });
});

describe('onlyTextChanged with a master (R0 for skills)', () => {
  // The 4-arg contract call; previous defaults to the tailor's version.
  const check = (next: Resume, previous: Resume = original()): boolean => (edits.onlyTextChanged as unknown as AnyFn)(previous, next, original(), MASTER);

  it('accepts the outputs of addSkill, removeAddedSkill and reset', () => {
    // One add.
    const one = added(original(), 'skill-docker');
    // An honest add is text-only for R0's purposes.
    assert.equal(check(one), true);
    // Two adds in a row.
    const two = added(one, 'skill-k8s');
    // Also accepted, from the previous step.
    assert.equal(check(two, one), true);
    // Undo of one add.
    const removed = fn('removeAddedSkill')(two, original(), 'skill-k8s');
    // Precondition.
    assert.equal(removed.ok, true);
    // Accepted.
    assert.equal(check(removed.resume, two), true);
    // Reset of all adds.
    const reset = edits.resetTarget(two, original(), { kind: 'skills' } as never);
    // Precondition.
    assert.equal(reset.ok, true);
    // Accepted.
    if (reset.ok) assert.equal(check(reset.resume, two), true);
  });

  it('refuses a synthetic skill, a renamed or re-categorised master skill, and a duplicate', () => {
    // A skill that is not in the master at all.
    assert.equal(check(withSkills({ ref: 'user:caching', name: 'Caching', category: 'X' })), false);
    // Docker's ref with an invented name: real ref, fabricated words.
    assert.equal(check(withSkills({ ...DOCKER, name: 'Docker Swarm' })), false);
    // Docker's ref with another category.
    assert.equal(check(withSkills({ ...DOCKER, category: 'Languages' })), false);
    // Docker twice.
    assert.equal(check(withSkills(DOCKER, DOCKER)), false);
    // A tailor-selected skill duplicated.
    assert.equal(check(withSkills({ ref: 'skill-node', name: 'Node.js', category: 'Frameworks' })), false);
    // Positive control: the exact master copy is accepted.
    assert.equal(check(withSkills(DOCKER)), true);
  });

  it('refuses dropping or reordering the tailor-selected skills', () => {
    // The tailor's two skills.
    const [node, pg] = original().skills;
    // Node.js dropped: removing the tailor's choice is not an add-undo.
    const dropped = clone(original()) as unknown as { skills: unknown[] };
    // Only PostgreSQL kept.
    dropped.skills = [pg];
    // Refused.
    assert.equal(check(dropped as unknown as Resume), false);
    // Swapped order: order is part of the tailoring.
    const reordered = clone(original()) as unknown as { skills: unknown[] };
    // PostgreSQL first.
    reordered.skills = [pg, node];
    // Refused.
    assert.equal(check(reordered as unknown as Resume), false);
  });

  it('refuses a skill add combined with any non-skills change', () => {
    // An honest add...
    const tampered = clone(added(original(), 'skill-docker')) as unknown as { experience: { bullets: { master_text: string }[] }[] };
    // ...smuggling a master_text rewrite alongside it.
    tampered.experience[0]!.bullets[1]!.master_text = 'Wrote integration tests for the billing service';
    // Refused: R0 holds whatever else the edit did.
    assert.equal(check(tampered as unknown as Resume), false);
    // An add plus a changed identity.
    const renamed = clone(added(original(), 'skill-docker')) as unknown as { identity: { full_name: string } };
    // Not the master's identity.
    renamed.identity.full_name = 'Someone Else';
    // Refused.
    assert.equal(check(renamed as unknown as Resume), false);
  });
});

describe('saveTailoredEdit: a synthetic skill never reaches the database', () => {
  // A minimal recording fake in the saveTailoredEdit.test.ts shape: every builder step is thenable.
  const fakeClient = () => {
    // Every call in order, so "zero updates" is assertable.
    const calls: { table: string; method: string }[] = [];
    // The surface the code uses: from(table) only.
    const client = {
      from(table: string) {
        // Recorded so a chain that never reaches update() still shows up.
        calls.push({ table, method: 'from' });
        // Which canned answer this chain gets.
        let kind: 'read' | 'update' | 'insert' = 'read';
        // Chainable and thenable at every step.
        const builder: Record<string, unknown> = {
          then(resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) {
            // A landed update returns one row with a new stamp; inserts succeed; reads are unused here.
            const answer = kind === 'update'
              ? { data: [{ id: 'app-1', updated_at: '2026-10-08T10:05:00.000Z' }], error: null, status: 200 }
              : { data: null, error: null, status: 200 };
            // Resolved like postgrest-js: never throws, returns { data, error }.
            return Promise.resolve(answer).then(resolve, reject);
          },
        };
        // The PostgREST methods either chain might call.
        for (const method of ['update', 'eq', 'select', 'insert', 'single', 'maybeSingle', 'limit']) {
          // Each records itself and continues the chain.
          builder[method] = () => {
            // Recorded with its table.
            calls.push({ table, method });
            // update/insert decide the answer.
            if (method === 'update') kind = 'update';
            // The event write.
            if (method === 'insert') kind = 'insert';
            // Chain continues.
            return builder;
          };
        }
        // The chain start.
        return builder;
      },
    };
    // Both handed back.
    return { client, calls };
  };

  // One save of `resume` over the original, with the T3 `master` argument.
  const run = (resume: Resume, kind: string) => {
    // A fresh fake per run.
    const fake = fakeClient();
    // The call under test.
    const done = save.saveTailoredEdit(fake.client as never, {
      // Which row.
      applicationId: 'app-1',
      // The candidate.
      resume,
      // What the page believed was stored.
      previous: original(),
      // The tailor's version.
      original: original(),
      // T3: the pinned master, the ground truth for skills.
      master: MASTER,
      // The concurrency token.
      expectedUpdatedAt: '2026-10-08T10:00:00.000Z',
      // The new event kind.
      event: { kind, ref: 'skill-docker', before: null, after: 'Docker' },
    } as never);
    // Result and log.
    return { done, calls: fake.calls };
  };

  it("refuses with 'not_text_only' and sends no update", async () => {
    // A hand-built resume with a skill the master never had.
    const { done, calls } = run(withSkills({ ref: 'user:caching', name: 'Caching', category: 'X' }), 'resume_add_skill');
    // Awaited.
    const result = await done;
    // Refused.
    assert.equal(result.ok, false);
    // With the R0 reason.
    if (!result.ok) assert.equal(result.reason, 'not_text_only');
    // No UPDATE reached the client.
    assert.equal(calls.filter((c) => c.method === 'update').length, 0);
  });

  it('positive control: an honest addSkill result reaches the update and saves', async () => {
    // The same save path with an honest add.
    const { done, calls } = run(added(original(), 'skill-docker'), 'resume_add_skill');
    // Awaited.
    const result = await done;
    // Saved.
    assert.equal(result.ok, true, `expected ok, got ${JSON.stringify(result)}`);
    // Exactly one UPDATE went out.
    assert.equal(calls.filter((c) => c.method === 'update').length, 1);
  });
});

describe('buildResumeDiff: an added skill on the skills line', () => {
  // JD keywords: "Express" is in a traced bullet; "Docker" is only ever supplied by the add.
  const KEYWORDS = ['Express', 'Docker'];
  // The diff the page would build.
  const diff = (resolved: Resume, orig: Resume | null = original()) =>
    adapter.buildResumeDiff({
      // Minimal row: id, pin, no findings, the JD keywords.
      application: { id: 'app-1', master_version: VERSION, audit_findings: [], selected_jd_keywords: KEYWORDS } as never,
      // Header fields only.
      job: { title: 'Backend Engineer', company_name: 'Acme' } as never,
      // What tailored_profile holds now.
      resolved,
      // The pinned master.
      master: MASTER,
      // null means D4: the original could not be rebuilt.
      original: orig,
    } as never);
  // The one skills line; missing is a failure, not an undefined to read through.
  const skillsOf = (d: ReturnType<typeof diff>) => {
    // Found by kind so the id format is not assumed.
    const line = d.lines.find((l) => l.kind === 'skills');
    // Named.
    assert.ok(line, 'no skills line');
    // Narrowed.
    return line;
  };
  // Word-bounded "Docker" test on one run's text.
  const hasDocker = (text: string) => /(^|[^A-Za-z0-9])Docker([^A-Za-z0-9]|$)/.test(text);

  it("is 'edited', targetable, never traced for the added skill, and forces Bucket B", () => {
    // The original plus Docker, built by hand so a bug in addSkill cannot mask one here.
    const d = diff(withSkills(DOCKER));
    // The line.
    const line = skillsOf(d);
    // Derived state.
    assert.equal(line.editState, 'edited');
    // Targetable for remove/reset.
    assert.deepEqual(line.editTarget, { kind: 'skills' });
    // The added skill is shown in an 'edited' run.
    assert.ok(line.tailoredRuns.some((r) => r.verdict === 'edited' && hasDocker(r.text)), `no edited run with Docker: ${JSON.stringify(line.tailoredRuns)}`);
    // And never in a 'traced' run: the operator's choice must not read as the tailor's.
    assert.equal(line.tailoredRuns.filter((r) => r.verdict === 'traced' && hasDocker(r.text)).length, 0);
    // The tailor's skills are still shown, so nothing was dropped from the line.
    assert.ok(line.tailoredRuns.some((r) => r.text.includes('Node.js')));
    // Counted as a change.
    assert.ok(d.editCount >= 1);
    // R2: never batch-approvable.
    assert.equal(model.deriveBucket(d), 'B');
  });

  it('credits the added skill to matchedByEdit, never honestlyMatched', () => {
    // Docker only via the add.
    const d = diff(withSkills(DOCKER));
    // Credited to the operator's edit.
    assert.ok(d.coverage.matchedByEdit.includes('Docker'), `matchedByEdit = ${JSON.stringify(d.coverage.matchedByEdit)}`);
    // Never as master-backed by the tailoring.
    assert.equal(d.coverage.honestlyMatched.includes('Docker'), false);
    // Positive control: the traced bullet still matches honestly.
    assert.ok(d.coverage.honestlyMatched.includes('Express'));
    // Positive control: unedited, Docker is matched nowhere.
    assert.equal(diff(original()).coverage.matchedByEdit.includes('Docker'), false);
  });

  it("with no added skill the line is 'original' and the row stays Bucket A", () => {
    // The tailor's version as stored.
    const d = diff(original());
    // Nothing differs.
    assert.equal(skillsOf(d).editState, 'original');
    // No edits anywhere.
    assert.equal(d.editCount, 0);
    // Zero findings, zero edits: batch-approvable.
    assert.equal(model.deriveBucket(d), 'A');
  });

  it('D4: with no original, the skills line has no edit target', () => {
    // Even with an added skill, no baseline means nothing can be told apart as an edit.
    const d = diff(withSkills(DOCKER), null);
    // Not targetable.
    assert.equal(skillsOf(d).editTarget, null);
    // And counted as no edit.
    assert.equal(d.editCount, 0);
  });
});

/* Review fixes (2026-10-08): three gaps an independent review found in the T3 data layer. */
describe('review fix 1: addableSkillFor never offers a short skill found inside C++ or C#', () => {
  // The fixture master plus a one-letter "C" and a literal "C++", so both sides are expressible.
  const withC = {
    // Everything else from the shared fixture.
    ...(MASTER as unknown as Record<string, unknown>),
    // "C" first, so if the reverse branch fired on "C++" it would win by master order.
    skills: [
      // The over-offer candidate.
      { id: 'skill-c', name: 'C', category: 'Languages' },
      // The real C++ skill, for the positive control.
      { id: 'skill-cpp', name: 'C++', category: 'Languages' },
      // The shared fixture's skills, unchanged.
      ...(MASTER as unknown as { skills: unknown[] }).skills,
    ],
  } as never;
  // The same master without "C++", so "C++" has no honest supplier at all.
  const onlyC = { ...(withC as unknown as Record<string, unknown>), skills: (withC as unknown as { skills: { id: string }[] }).skills.filter((s) => s.id !== 'skill-cpp') } as never;

  it('JD keyword "C++" with only master skill "C" offers nothing', () => {
    // "C" ends at the '+', so a word-bounded match fires; adding "C" would leave "C++" missing.
    assert.equal(fn('addableSkillFor')('C++', original(), onlyC), null);
  });

  it('JD keyword "C#" with only master skill "C" offers nothing', () => {
    // Same trap with '#'.
    assert.equal(fn('addableSkillFor')('C#', original(), onlyC), null);
  });

  it('positive controls: equality still finds "C++" and "Docker"; "Docker Compose" finds nothing', () => {
    // Exact (case-insensitive) equality is untouched by the guard, so the real skill is offered.
    assert.deepEqual(fn('addableSkillFor')('c++', original(), withC), { ref: 'skill-cpp', name: 'C++', category: 'Languages' });
    // Equal tokens still offer the skill, so the null below is the rule, not a dead function.
    assert.deepEqual(fn('addableSkillFor')('Docker', original(), withC), DOCKER);
    // The old reverse branch is gone by design (2026-10-09): a containing keyword is a different thing.
    assert.equal(fn('addableSkillFor')('Docker Compose', original(), withC), null);
  });
});

describe('review fix 2: masterFromRow refuses a master skill without a string category', () => {
  it('a master row with one skill lacking category loads as null', () => {
    // A deep copy, so the shared fixture stays intact for every other test.
    const row = clone(MASTER) as unknown as { skills: Record<string, unknown>[] };
    // Docker loses its category; every add and every deepEqual would otherwise break.
    delete row.skills[1]!['category'];
    // Refused at load: the page names the row instead of filing it in Bucket B.
    assert.equal(edits.masterFromRow(row), null);
  });

  it('positive control: the intact fixture master loads as itself', () => {
    // Same object back, so the null above is the category check and not some other field.
    assert.equal(edits.masterFromRow(MASTER), MASTER);
  });
});

describe('review fix 3: editRow refuses an edit when the resume pin no longer matches the loaded master', () => {
  // apps/web's own typescript, already used by the load hook above.
  const ts = createRequire(import.meta.url)('typescript') as typeof import('typescript');
  // The page as written.
  const raw = readFileSync(fileURLToPath(new URL('../src/features/approval/ApprovalQueuePage.tsx', import.meta.url)), 'utf8');
  // Comments stripped by the printer, so a comment can neither satisfy nor trip the check.
  const page = ts.createPrinter({ removeComments: true }).printFile(ts.createSourceFile('page.tsx', raw, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX));

  it('the master_version guard sits in editRow before any edit is built', () => {
    // Start anchor: editRow itself.
    const start = page.indexOf('async function editRow(');
    // A missing anchor fails loudly instead of slicing nothing.
    assert.ok(start >= 0, 'anchor not found: async function editRow(');
    // End anchor: the pure operation that calls addSkill/removeAddedSkill/applyTextEdit.
    const end = page.indexOf('const outcome =', start);
    // Must exist after the start, or the slice is meaningless.
    assert.ok(end > start, 'anchor not found after editRow: const outcome =');
    // Everything editRow does before building the edit.
    const head = page.slice(start, end);
    // The pin of the latest resume compared with the pin the original (and master) were built from...
    assert.match(head, /if \(current\.master_version !== source\.original\.master_version\) \{\s*return notSaved\(/);
    // ...with the operator told to reload.
    assert.match(head, /master version changed since the page loaded; reload before editing\./);
  });
});
