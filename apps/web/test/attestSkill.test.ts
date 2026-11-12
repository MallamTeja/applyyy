/* Attesting a skill the master does not have, from the approval page's ✗ chip (2026-10-24).
 *
 * The page promises "every line traces to master version N". So clicking ✗ Java must put Java in
 * the MASTER first (a new immutable version), and only then on this resume, re-pinned to that
 * version. The rules pinned here:
 *   - one click = a new master version holding the skill + the skill on tailored_profile + all
 *     three pins (tailored_profile, the column, tailor_refs) moved together;
 *   - a refused master insert writes NOTHING to the application (no half-write);
 *   - a master that already holds the skill (another row attested it) is reused, not re-inserted;
 *   - a latest master that would change any claim the tailor made is refused, never re-pinned;
 *   - Undo (the existing remove_skill path) takes the skill back off this resume.
 * The client double behaves like supabase-js: it RETURNS { error }, it never throws. */

import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { describe, it, before } from 'node:test';

// Same resolver as the other approval tests: the modules use extensionless relative imports.
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

// The module under test.
let attest: typeof import('../src/features/approval/attestSkill.ts');
// The pure edits, for building fixtures and for the Undo step.
let edits: typeof import('../src/features/approval/tailoredEdits.ts');

before(async () => {
  // Loaded after the hooks so its own extensionless imports resolve.
  attest = await import('../src/features/approval/attestSkill.ts');
  // Same.
  edits = await import('../src/features/approval/tailoredEdits.ts');
});

// The pinned version every fixture starts from.
const V3 = 3;
// The master the resume was tailored against (same shape as addSkill.test.ts's fixture).
const MASTER_V3 = {
  schema_version: 1,
  identity: { full_name: 'Test Person', headline: 'Backend Engineer', email: 'test@example.com', phone: null, location: 'Hyderabad', links: [] },
  summary: { id: 'summary-master', text: 'Backend engineer building REST APIs in Node.js.' },
  experience: [{
    id: 'exp-acme', company: 'Acme', role: 'Backend Intern', location: 'Remote',
    start_display: 'Jun 2025', end_display: 'Aug 2025', start_date: null, end_date: null,
    bullets: [
      { id: 'b-api', text: 'Built a REST API with Express and Node.js handling 500 users', tags: [] },
      { id: 'b-tests', text: 'Wrote unit tests for the billing service', tags: [] },
    ],
  }],
  projects: [], education: [], achievements: [], certifications: [],
  skills: [
    { id: 'skill-node', name: 'Node.js', category: 'Frameworks' },
    { id: 'skill-docker', name: 'Docker', category: 'Tools' },
    { id: 'skill-pg', name: 'PostgreSQL', category: 'Databases' },
  ],
  links: [],
};
// What applications.tailor_refs stores for the row.
const TAILOR_REFS = {
  schema_version: 1,
  master_version: V3,
  section_order: ['summary', 'experience', 'skills'],
  summary: { text: 'Backend engineer shipping REST APIs in Node.js.', refs: ['summary-master'] },
  skills: [{ ref: 'skill-node' }, { ref: 'skill-pg' }],
  experience: [{ ref: 'exp-acme', bullets: [
    { ref: 'b-api', text: 'Built a REST API with Express and Node.js handling 500 users' },
    { ref: 'b-tests', text: 'Wrote unit tests for the billing service' },
  ] }],
  projects: [], education: [], achievements: [], certifications: [],
};
// The id the page generates for the new master skill; fixed here so assertions can name it.
const NEW_ID = 'skill-attested-java';
// The stamp the page loaded the row at.
const LOADED_STAMP = '2026-10-24T13:00:00.000Z';
// The stamp the database assigns on the re-pin write.
const NEW_STAMP = '2026-10-24T13:05:00.000Z';

// A deep copy, so no test can mutate another's fixture.
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value));

// One recorded call on the double.
type Call = { table: string; method: string; args: unknown[] };
// A canned answer for one chain.
type Answer = { data?: unknown; error?: unknown };

/* A supabase-js-shaped double. Chains are told apart by table and by whether insert()/update()
   was called: the latest-master read, the master insert, the application update, the re-read
   and the history note. Every builder step is thenable, like PostgREST's builders. */
function fakeClient(answers: { latest?: Answer; masterInsert?: Answer; update?: Answer; reselect?: Answer }) {
  // Every call in order, so "no update happened" is assertable.
  const calls: Call[] = [];
  // Defaults: latest is v3, an insert lands as v4, the re-pin writes one row.
  const latest = answers.latest ?? { data: { profile: clone(MASTER_V3), version: V3 }, error: null };
  const masterInsert = answers.masterInsert ?? { data: { version: 4 }, error: null };
  const update = answers.update ?? { data: [{ id: 'app-1', updated_at: NEW_STAMP }], error: null };
  const reselect = answers.reselect ?? { data: null, error: null };
  // The client surface the code uses: from(table) only.
  const client = {
    from(table: string) {
      // Recorded so a chain's start is visible in the log.
      calls.push({ table, method: 'from', args: [table] });
      // Which chain this is, decided by the methods called on it.
      let kind: 'read' | 'insert' | 'update' = 'read';
      // The chainable, thenable builder.
      const builder: Record<string, unknown> = {
        then(resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) {
          // The answer this chain earned.
          const answer =
            table === 'master_profiles' ? (kind === 'insert' ? masterInsert : latest)
              : table === 'applications' ? (kind === 'update' ? update : reselect)
                : { error: null };
          // Returned, never thrown: supabase-js reports failures as values.
          return Promise.resolve(answer).then(resolve, reject);
        },
      };
      // Every PostgREST method the code may chain.
      for (const method of ['select', 'order', 'limit', 'maybeSingle', 'single', 'insert', 'update', 'eq']) {
        builder[method] = (...args: unknown[]) => {
          // Recorded with its table.
          calls.push({ table, method, args });
          // insert/update decide the canned answer.
          if (method === 'insert') kind = 'insert';
          if (method === 'update') kind = 'update';
          // Chain continues.
          return builder;
        };
      }
      return builder;
    },
  };
  return { client, calls };
}

// The calls of one method on one table.
const callsOf = (calls: Call[], table: string, method: string) => calls.filter((c) => c.table === table && c.method === method);

// The tailor's resume at v3, as the page holds it.
const originalV3 = () => {
  const resume = edits.rebuildOriginal(clone(TAILOR_REFS), clone(MASTER_V3) as never, V3);
  // A null here is a fixture bug, named as such.
  assert.notEqual(resume, null, 'fixture must rebuild to a ResolvedResume');
  return resume!;
};

// One attest call with these answers and overrides.
function run(answers: Parameters<typeof fakeClient>[0], overrides: Record<string, unknown> = {}) {
  const fake = fakeClient(answers);
  const done = attest.attestSkill(fake.client as never, {
    applicationId: 'app-1',
    keyword: 'Java',
    category: 'Languages',
    current: originalV3(),
    original: originalV3(),
    tailorRefs: clone(TAILOR_REFS),
    expectedUpdatedAt: LOADED_STAMP,
    newSkillId: NEW_ID,
    // No JD keywords: the one-page fit still runs, ranking every bullet equally.
    jdKeywords: [],
    // A hand attest on the page unless a test says otherwise.
    source: 'operator',
    ...overrides,
  } as never);
  return { done, calls: fake.calls };
}

describe('attestSkill: one click puts the skill in the master, then on the resume', () => {
  it('inserts a NEW master version with the skill, adds it to tailored_profile, and re-pins all three pins', async () => {
    const { done, calls } = run({});
    const out = await done;
    assert.equal(out.ok, true, out.ok ? '' : out.message);
    // 1. A new master version, holding every v3 skill plus Java, appended last.
    const inserts = callsOf(calls, 'master_profiles', 'insert');
    assert.equal(inserts.length, 1, 'exactly one master insert');
    const inserted = (inserts[0]!.args[0] as { profile: { skills: unknown[] } }).profile;
    assert.deepEqual(inserted.skills, [...MASTER_V3.skills, { id: NEW_ID, name: 'Java', category: 'Languages' }]);
    // 2 + 3. One application write carrying the new skill and all three pins at the new version.
    const updates = callsOf(calls, 'applications', 'update');
    assert.equal(updates.length, 1, 'exactly one application write');
    const written = updates[0]!.args[0] as { tailored_profile: { master_version: number; skills: unknown[] }; master_version: number; tailor_refs: { master_version: number } };
    assert.deepEqual(written.tailored_profile.skills.at(-1), { ref: NEW_ID, name: 'Java', category: 'Languages' });
    assert.equal(written.tailored_profile.master_version, 4);
    assert.equal(written.master_version, 4);
    assert.equal(written.tailor_refs.master_version, 4);
    // Still optimistic-concurrency guarded, like every other edit.
    assert.ok(calls.some((c) => c.table === 'applications' && c.method === 'eq' && c.args[0] === 'updated_at' && c.args[1] === LOADED_STAMP));
    // The page is handed what it needs to redraw against the new pin.
    if (out.ok) assert.equal(out.skillRef, NEW_ID);
  });

  it('a failed master insert leaves tailored_profile untouched (no half-write)', async () => {
    // supabase-js returns the refusal as a value.
    const { done, calls } = run({ masterInsert: { data: null, error: { code: 'XX000', message: 'insert refused' } } });
    const out = await done;
    assert.equal(out.ok, false);
    // Refused for THIS reason (the insert), not by some earlier gate that would also write nothing.
    if (!out.ok) {
      assert.equal(out.masterInserted, false);
      assert.match(out.message, /insert refused/);
    }
    // The insert really was attempted, so "no update" below is the no-half-write rule at work.
    assert.equal(callsOf(calls, 'master_profiles', 'insert').length, 1);
    // Not one write to the application row.
    assert.equal(callsOf(calls, 'applications', 'update').length, 0);
  });

  it('reuses a skill the latest master already holds: no new version, the row re-pins to latest', async () => {
    // Another row attested Java already: latest is v4 = v3 + Java.
    const v4 = { ...clone(MASTER_V3), skills: [...MASTER_V3.skills, { id: 'skill-java-earlier', name: 'Java', category: 'Languages' }] };
    const { done, calls } = run({ latest: { data: { profile: v4, version: 4 }, error: null } });
    const out = await done;
    assert.equal(out.ok, true, out.ok ? '' : out.message);
    // No duplicate master version.
    assert.equal(callsOf(calls, 'master_profiles', 'insert').length, 0);
    const written = callsOf(calls, 'applications', 'update')[0]!.args[0] as { tailored_profile: { skills: unknown[] }; master_version: number };
    // The EXISTING master skill, by its existing id.
    assert.deepEqual(written.tailored_profile.skills.at(-1), { ref: 'skill-java-earlier', name: 'Java', category: 'Languages' });
    assert.equal(written.master_version, 4);
  });

  it('refuses a skill the master already holds under another case ("ai" held, "AI" attested): no master version, no row write', async () => {
    // Latest master v4 = v3 + "ai" (lower case), as a hand edit on the Master page would store it.
    const v4 = { ...clone(MASTER_V3), skills: [...MASTER_V3.skills, { id: 'skill-ai', name: 'ai', category: 'AI' }] };
    // The operator vouches for "AI".
    const { done, calls } = run({ latest: { data: { profile: v4, version: 4 }, error: null } }, { keyword: 'AI', category: 'AI' });
    const out = await done;
    // Refused, naming the master's own spelling and group.
    assert.deepEqual(out, { ok: false, message: '"AI" is already in your master profile as "ai" (AI); nothing was added.', masterInserted: false });
    // No duplicate master version: the live v11/v14 bug.
    assert.equal(callsOf(calls, 'master_profiles', 'insert').length, 0);
    // And the row is untouched.
    assert.equal(callsOf(calls, 'applications', 'update').length, 0);
  });

  it('refuses when the latest master would change a claim the tailor made, and writes nothing', async () => {
    // Latest master reworded a bullet the resume carries: a re-pin would silently change that line.
    const changed = clone(MASTER_V3);
    changed.experience[0]!.bullets[1]!.text = 'Wrote integration tests for the billing service';
    const { done, calls } = run({ latest: { data: { profile: changed, version: 4 }, error: null } });
    const out = await done;
    assert.equal(out.ok, false);
    // Refused by the rebuild proof, not by ingest validation (which would also write nothing).
    if (!out.ok) assert.match(out.message, /changed since this resume was tailored/);
    // Neither a master version nor an application write.
    assert.equal(callsOf(calls, 'master_profiles', 'insert').length, 0);
    assert.equal(callsOf(calls, 'applications', 'update').length, 0);
  });

  it('Undo before approve: removing the attested skill restores the tailored skills', async () => {
    const { done } = run({});
    const out = await done;
    assert.equal(out.ok, true);
    if (!out.ok) return;
    // Undo is the existing remove_skill path, against the original rebuilt at the new pin.
    const undone = edits.removeSkill(out.resume, out.skillRef);
    assert.equal(undone.ok, true);
    if (undone.ok) assert.deepEqual(undone.resume.skills, originalV3().skills);
  });

  it('saveTailoredEdit refuses a re-pin whose pins disagree, before any network call', async () => {
    // The module that owns the write boundary.
    const save = await import('../src/features/approval/saveTailoredEdit.ts');
    // The tailor's version at v3, and the same resume relabelled to v4 (the only change).
    const atV3 = originalV3();
    const atV4 = { ...atV3, master_version: 4 };
    // Each case breaks exactly one pin; both must be refused with no call made.
    for (const repin of [{ version: 4, tailorRefs: { ...clone(TAILOR_REFS), master_version: 3 } }, { version: 5, tailorRefs: { ...clone(TAILOR_REFS), master_version: 5 } }]) {
      const fake = fakeClient({});
      const out = await save.saveTailoredEdit(fake.client, {
        applicationId: 'app-1', resume: atV4, previous: atV3, original: atV4, master: clone(MASTER_V3) as never,
        expectedUpdatedAt: LOADED_STAMP,
        // source is REQUIRED (EditSource, 2026-11-04): an attest from the review page is the operator's own act.
        event: { kind: 'resume_attest_skill', ref: NEW_ID, before: null, after: 'Java', source: 'operator' }, repin,
      });
      assert.equal(out.ok, false);
      assert.equal(fake.calls.length, 0, 'a disagreeing re-pin never reaches the network');
    }
  });

  it('refuses a blank keyword or category before any network call', async () => {
    for (const overrides of [{ keyword: '  ' }, { category: '' }]) {
      const { done, calls } = run({}, overrides);
      assert.equal((await done).ok, false);
      assert.equal(calls.length, 0);
    }
  });
});

describe('attestSkill audit-trail honesty (2026-11-04)', () => {
  it('refuses a skill the resume already prints instead of inserting a duplicate master skill', async () => {
    // Live 2026-11-01: "Testing" attested twice 9 s apart became two master skills and two printed copies.
    const { done, calls } = run({}, { keyword: 'PostgreSQL', category: 'Databases' });
    // Refused, by name.
    const out = await done;
    // Not saved.
    assert.equal(out.ok, false);
    // Said plainly, and nothing was written to the master.
    if (!out.ok) {
      // The operator's words back.
      assert.match(out.message, /PostgreSQL" is already on this resume/);
      // No version made.
      assert.equal(out.masterInserted, false);
    }
    // Neither a master version nor a row write.
    assert.deepEqual([callsOf(calls, 'master_profiles', 'insert').length, callsOf(calls, 'applications', 'update').length], [0, 0]);
  });

  it('writes the source into the history note', async () => {
    // Applied from an AI chat card by the operator's click.
    const { done, calls } = run({}, { source: 'ai_chat_click' });
    // Saved.
    assert.equal((await done).ok, true);
    // The note.
    const note = callsOf(calls, 'application_events', 'insert')[0]!.args[0] as { detail: { source: string } };
    // Named.
    assert.equal(note.detail.source, 'ai_chat_click');
  });
});

describe('T10 attestSkill into a group the master does not have yet (2026-11-10)', () => {
  it('T10 skill group: attesting into a new group writes the master skill under that group', async () => {
    // The owner dictated a group none of MASTER_V3's skills use.
    assert.ok(!MASTER_V3.skills.some((skill) => skill.category === 'Infrastructure as Code'), 'fixture must lack the group');
    // One click: Pulumi under the new group.
    const { done, calls } = run({}, { keyword: 'Pulumi', category: 'Infrastructure as Code' });
    // Awaited.
    const out = await done;
    // Accepted: a new group is a valid non-blank category.
    assert.equal(out.ok, true, out.ok ? '' : out.message);
    // The new master version carries the skill under the owner's group, appended last.
    const inserted = (callsOf(calls, 'master_profiles', 'insert')[0]!.args[0] as { profile: { skills: unknown[] } }).profile;
    // Every v3 skill kept, then Pulumi in its new group.
    assert.deepEqual(inserted.skills, [...MASTER_V3.skills, { id: NEW_ID, name: 'Pulumi', category: 'Infrastructure as Code' }]);
    // The resume prints it under the same group, so the master and the page agree.
    const written = callsOf(calls, 'applications', 'update')[0]!.args[0] as { tailored_profile: { skills: unknown[] } };
    // Last printed skill.
    assert.deepEqual(written.tailored_profile.skills.at(-1), { ref: NEW_ID, name: 'Pulumi', category: 'Infrastructure as Code' });
  });
});

/* ONE LINE PER SKILL GROUP (2026-11-12, after commit 4b7e75a). The check runs BEFORE any write: refused
   after the master insert, a new master version would stay behind (versions are immutable). */
describe('attestSkill keeps every skill group on one line (2026-11-12)', () => {
  // Long enough that "Frameworks: Node.js, <this>" cannot print on one line at any typography rung.
  const LONG = 'Java Enterprise Edition and Spring Framework Microservices Architecture Patterns';

  it('refuses an add that would wrap its group, with no master version and no row write', async () => {
    // No `wrap` passed, like any caller that omits it: must fail CLOSED.
    const { done, calls } = run({}, { keyword: LONG, category: 'Frameworks' });
    // Awaited.
    const out = await done;
    // Refused, naming the full group, and nothing was inserted.
    assert.deepEqual(out, { ok: false, message: `"Frameworks" is full: adding ${LONG} would wrap it onto a second line. Remove a skill from that group first, or say "all" to add it anyway.`, masterInserted: false });
    // No master version.
    assert.equal(callsOf(calls, 'master_profiles', 'insert').length, 0);
    // No row write.
    assert.equal(callsOf(calls, 'applications', 'update').length, 0);
  });

  it('with wrap "allow" (the owner said "all") it saves and says the group now wraps', async () => {
    // The same add, allowed.
    const { done } = run({}, { keyword: LONG, category: 'Frameworks', wrap: 'allow' });
    // Awaited.
    const out = await done;
    // Saved.
    assert.equal(out.ok, true);
    // And the wrap is never silent.
    assert.match(out.ok ? out.notice ?? '' : '', /"Frameworks" now wraps onto a second line/);
  });
});
