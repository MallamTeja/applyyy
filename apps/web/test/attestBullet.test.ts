/* Attesting a NEW bullet the master does not have (R0', 2026-11-01). Mirrors attestSkill.test.ts.
 *
 * The page promises "every line traces to master version N". So a new line typed under an entry must
 * go into the MASTER first (a new immutable version, under that entry), and only then onto this
 * resume by ref, re-pinned to that version. The rules pinned here:
 *   - one click = a new master version holding the bullet under its parent + the bullet on
 *     tailored_profile (in the master's words, master_text included) + all three pins moved together
 *     + a 'resume_attest_bullet' note;
 *   - a refused master insert writes NOTHING to the application (no half-write);
 *   - a latest master that would change any printed line - a tailor claim, or an entry added back
 *     earlier - is refused before any write;
 *   - a parent entry that is not printed, blank text or over-long text is refused before any call;
 *   - Undo (the existing remove path) takes the bullet back off.
 * The client double behaves like supabase-js: it RETURNS { error }, it never throws. */

import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { describe, it, before } from 'node:test';

// Same resolver as attestSkill.test.ts: the modules use extensionless relative imports.
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
let attest: typeof import('../src/features/approval/attestBullet.ts');
// The pure edits, for building fixtures and for the Undo step.
let edits: typeof import('../src/features/approval/tailoredEdits.ts');
// The owner of the refusal wording, so a test can compare against it rather than copy it.
let store: typeof import('../src/features/settings/masterStore.ts');

before(async () => {
  // Loaded after the hooks so its own extensionless imports resolve.
  attest = await import('../src/features/approval/attestBullet.ts');
  // Same.
  edits = await import('../src/features/approval/tailoredEdits.ts');
  // Same; read for storeRefusalMessage and classifyStoreFailure.
  store = await import('../src/features/settings/masterStore.ts');
});

// The pinned version every fixture starts from.
const V3 = 3;
// The master the resume was tailored against; exp-beta is NOT selected by the tailor.
const MASTER_V3 = {
  // The profile's shape marker.
  schema_version: 1,
  // Copied verbatim into every resume; ingest requires it.
  identity: { full_name: 'Test Person', headline: 'Backend Engineer', email: 'test@example.com', phone: null, location: 'Hyderabad', links: [] },
  // A real summary node, so the tailored summary has something honest to cite.
  summary: { id: 'summary-master', text: 'Backend engineer building REST APIs in Node.js.' },
  // Two employers: the tailor picked Acme only.
  experience: [
    // The entry the new line goes under.
    {
      id: 'exp-acme', company: 'Acme', role: 'Backend Intern', location: 'Remote',
      start_display: 'Jun 2025', end_display: 'Aug 2025', start_date: null, end_date: null,
      bullets: [
        { id: 'b-api', text: 'Built a REST API with Express and Node.js handling 500 users', tags: [] },
        { id: 'b-tests', text: 'Wrote unit tests for the billing service', tags: [] },
      ],
    },
    // Left out by the tailor; a test adds it back to prove the proof covers added-back entries.
    {
      id: 'exp-beta', company: 'Beta Labs', role: 'Platform Intern', location: null,
      start_display: 'Jan 2025', end_display: 'May 2025', start_date: null, end_date: null,
      bullets: [{ id: 'b-beta', text: 'Ran the Beta on-call rota', tags: [] }],
    },
  ],
  // Empty sections are legal; the validator only requires one substantive section.
  projects: [], education: [], achievements: [], certifications: [],
  // Both printed skills, so the skills-hold proof has something to check.
  skills: [
    { id: 'skill-node', name: 'Node.js', category: 'Frameworks' },
    { id: 'skill-pg', name: 'PostgreSQL', category: 'Databases' },
  ],
  // Profile-level links, empty.
  links: [],
};
// What applications.tailor_refs stores for the row.
const TAILOR_REFS = {
  // The contract's shape marker.
  schema_version: 1,
  // Matches V3, else the rebuild refuses.
  master_version: V3,
  // Document order; experience is slotted, so the new line prints.
  section_order: ['summary', 'experience', 'skills'],
  // Prose citing the master summary.
  summary: { text: 'Backend engineer shipping REST APIs in Node.js.', refs: ['summary-master'] },
  // Both skills, by id only.
  skills: [{ ref: 'skill-node' }, { ref: 'skill-pg' }],
  // Acme's two bullets, verbatim; Beta is left out.
  experience: [{ ref: 'exp-acme', bullets: [
    { ref: 'b-api', text: 'Built a REST API with Express and Node.js handling 500 users' },
    { ref: 'b-tests', text: 'Wrote unit tests for the billing service' },
  ] }],
  // Empty sections, required arrays.
  projects: [], education: [], achievements: [], certifications: [],
};
// The id the page generates for the new master bullet; fixed here so assertions can name it.
const NEW_ID = 'b-attested-latency';
// The operator's new line.
const TEXT = 'Cut billing latency by 30 percent';
// The stamp the page loaded the row at.
const LOADED_STAMP = '2026-11-01T13:00:00.000Z';
// The stamp the database assigns on the re-pin write.
const NEW_STAMP = '2026-11-01T13:05:00.000Z';

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
  // A landed master insert reports the version the database assigned.
  const masterInsert = answers.masterInsert ?? { data: { version: 4 }, error: null };
  // A landed re-pin returns exactly one row with a new stamp.
  const update = answers.update ?? { data: [{ id: 'app-1', updated_at: NEW_STAMP }], error: null };
  // No re-read row unless a test supplies one.
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
          // The answer this chain earned; the history note (application_events) always lands.
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
          // The application write.
          if (method === 'update') kind = 'update';
          // Chain continues.
          return builder;
        };
      }
      // The chain start.
      return builder;
    },
  };
  // The client to the code, the log to the test.
  return { client, calls };
}

// The calls of one method on one table.
const callsOf = (calls: Call[], table: string, method: string) => calls.filter((c) => c.table === table && c.method === method);

// The tailor's resume at v3, as the page holds it.
const originalV3 = () => {
  // The validator's own rebuild, from copies so no test can mutate the fixture.
  const resume = edits.rebuildOriginal(clone(TAILOR_REFS), clone(MASTER_V3) as never, V3);
  // A null here is a fixture bug, named as such.
  assert.notEqual(resume, null, 'fixture must rebuild to a ResolvedResume');
  // Narrowed for the callers.
  return resume!;
};

// The v3 resume with exp-beta added back by the page's own function (an earlier R0' edit).
const withBetaV3 = () => {
  // FULL at v3, the source the add-back copies from.
  const full = edits.resolveFullMaster(clone(MASTER_V3) as never, V3);
  // Named precondition.
  assert.notEqual(full, null);
  // The add-back, asserted.
  const out = edits.addMasterEntry(originalV3(), full!, 'experience', 'exp-beta');
  // A refusal here is a fixture bug.
  assert.equal(out.ok, true);
  // Narrowed for the callers.
  return (out as { resume: ReturnType<typeof originalV3> }).resume;
};

// One attest call with these answers and overrides.
function run(answers: Parameters<typeof fakeClient>[0], overrides: Record<string, unknown> = {}) {
  // A fresh double per call, so call logs never leak between tests.
  const fake = fakeClient(answers);
  // The call under test; every argument the page would pass, overridable per test.
  const done = attest.attestBullet(fake.client as never, {
    // Which row.
    applicationId: 'app-1',
    // The section and entry the new line goes under.
    section: 'experience',
    parentRef: 'exp-acme',
    // The operator's words.
    text: TEXT,
    // The stored resume and the tailor's version, both at v3.
    current: originalV3(),
    original: originalV3(),
    // The row's tailor_refs, copied so the code cannot mutate the fixture.
    tailorRefs: clone(TAILOR_REFS),
    // The concurrency stamp.
    expectedUpdatedAt: LOADED_STAMP,
    // No JD keywords: the one-page fit still runs, ranking every bullet equally.
    jdKeywords: [],
    // A hand attest on the page.
    source: 'operator',
    // The id the new master bullet takes.
    newBulletId: NEW_ID,
    ...overrides,
  } as never);
  // The promise and the log, so the test can await one and inspect the other.
  return { done, calls: fake.calls };
}

describe('attestBullet: one click puts the line in the master, then on the resume', () => {
  it('inserts a NEW master version with the bullet under its entry, adds it by ref, and re-pins all three pins', async () => {
    // The happy path, all defaults.
    const { done, calls } = run({});
    // Awaited.
    const out = await done;
    // Landed, or the reason is named.
    assert.equal(out.ok, true, out.ok ? '' : out.message);
    // 1. A new master version: exp-acme's bullets plus the new one, appended last, nothing else moved.
    const inserts = callsOf(calls, 'master_profiles', 'insert');
    assert.equal(inserts.length, 1, 'exactly one master insert');
    // The profile that became the new version.
    const inserted = (inserts[0]!.args[0] as { profile: typeof MASTER_V3 }).profile;
    // Appended last under its parent, with no tailoring tags yet.
    assert.deepEqual(inserted.experience[0]!.bullets, [...MASTER_V3.experience[0]!.bullets, { id: NEW_ID, text: TEXT, tags: [] }]);
    // The other entry is untouched.
    assert.deepEqual(inserted.experience[1], MASTER_V3.experience[1]);
    // 2 + 3. One application write: the bullet under exp-acme in the master's words, every pin at v4.
    const updates = callsOf(calls, 'applications', 'update');
    assert.equal(updates.length, 1, 'exactly one application write');
    // The columns that write set.
    const written = updates[0]!.args[0] as { tailored_profile: { master_version: number; experience: { bullets: unknown[] }[] }; master_version: number; tailor_refs: { master_version: number } };
    // FULL's node: master_text is the vouched text, so the line reads as traced because it IS traced.
    assert.deepEqual(written.tailored_profile.experience[0]!.bullets.at(-1), { ref: NEW_ID, text: TEXT, master_text: TEXT });
    // The resume's own pin.
    assert.equal(written.tailored_profile.master_version, 4);
    // The column pin.
    assert.equal(written.master_version, 4);
    // tailor_refs' pin, so the page's rebuild still works after reload.
    assert.equal(written.tailor_refs.master_version, 4);
    // Still optimistic-concurrency guarded, like every other edit.
    assert.ok(calls.some((c) => c.table === 'applications' && c.method === 'eq' && c.args[0] === 'updated_at' && c.args[1] === LOADED_STAMP));
    // 4. The history note names the new kind and the vouched words.
    const note = callsOf(calls, 'application_events', 'insert')[0]!.args[0] as { detail: { kind: string; ref: string; after: string } };
    assert.deepEqual([note.detail.kind, note.detail.ref, note.detail.after], ['resume_attest_bullet', NEW_ID, TEXT]);
    // The page is handed what it needs to redraw against the new pin.
    if (out.ok) assert.equal(out.bulletRef, NEW_ID);
  });

  it('a failed master insert leaves tailored_profile untouched (no half-write)', async () => {
    // supabase-js returns the refusal as a value.
    const { done, calls } = run({ masterInsert: { data: null, error: { code: 'XX000', message: 'insert refused' } } });
    // Awaited.
    const out = await done;
    // Not ok.
    assert.equal(out.ok, false);
    // Refused for THIS reason (the insert), not by some earlier gate that would also write nothing.
    if (!out.ok) {
      // Nothing was created.
      assert.equal(out.masterInserted, false);
      // The database's own words survive.
      assert.match(out.message, /insert refused/);
    }
    // The insert really was attempted, so "no update" below is the no-half-write rule at work.
    assert.equal(callsOf(calls, 'master_profiles', 'insert').length, 1);
    // Not one write to the application row.
    assert.equal(callsOf(calls, 'applications', 'update').length, 0);
  });

  /* ONE WORDING FOR A REFUSED MASTER INSERT (review finding, 2026-11-01). attestBullet kept a
     line-for-line copy of masterStore.storeRefusalMessage, so the add forms and this path could
     drift apart on the next edit to either. Pinned through the REAL path: each error goes through
     the real classifier inside storeMasterProfile, and the message must be storeRefusalMessage's. */
  it('words every refused master insert exactly as storeRefusalMessage does', async () => {
    // One PostgREST-shaped error per refusal kind, with the kind it must classify as.
    const cases = [
      // Unique content hash: this master already exists.
      { kind: 'identical', error: { code: '23505', message: 'duplicate key value violates unique constraint "master_profiles_user_content_hash_key"' } },
      // Unique version: a concurrent save took the number.
      { kind: 'version_race', error: { code: '23505', message: 'duplicate key value violates unique constraint "master_profiles_user_version_key"' } },
      // RLS refused the row.
      { kind: 'not_authenticated', error: { code: '42501', message: 'new row violates row-level security policy' } },
      // Anything else keeps the database's words.
      { kind: 'failed', error: { code: 'XX000', message: 'insert refused' } },
    ] as const;
    for (const c of cases) {
      // Non-vacuity: the fixture error really is the kind it is named for.
      const outcome = store.classifyStoreFailure(c.error);
      // A mislabelled case would test some other branch twice.
      assert.equal(outcome.kind, c.kind, `fixture for ${c.kind} classifies as ${outcome.kind}`);
      // The attest path refused by exactly this insert error.
      const out = await run({ masterInsert: { data: null, error: c.error } }).done;
      // Refused, or the comparison below is meaningless.
      assert.equal(out.ok, false, `${c.kind} must refuse`);
      // The owner's sentence, inside attestBullet's own frame, and nothing else.
      if (!out.ok) assert.equal(out.message, `could not add it to your master profile: ${store.storeRefusalMessage(outcome as never)}.`, c.kind);
    }
  });

  /* The test above passes on a faithful COPY too, which is the drift risk itself. This is the red
     half: the owner's literal sentences may appear in exactly one source file. Derived from
     storeRefusalMessage at run time, so a rewording moves with it instead of breaking this. */
  it('keeps the refusal wording in one source file, masterStore.ts', async () => {
    // Node stdlib only: a recursive listing and a read.
    const { readdirSync, readFileSync } = await import('node:fs');
    // The web source root, beside this test directory.
    const srcRoot = new URL('../src/', import.meta.url);
    // Every TS/TSX source file, as forward-slash paths relative to src/.
    const files = readdirSync(srcRoot, { recursive: true, encoding: 'utf8' })
      // Normalised so the assertion reads the same on Windows and CI.
      .map((p) => p.replaceAll('\\', '/'))
      // Code only.
      .filter((p) => /\.tsx?$/.test(p));
    // Non-vacuity: the walk found the tree, not an empty directory.
    assert.ok(files.length > 20, `only ${files.length} source files found`);
    // The two sentences only the owner should write out ('failed' echoes the db; RLS's is generic).
    for (const kind of ['identical', 'version_race'] as const) {
      // The owner's words, read from the owner.
      const sentence = store.storeRefusalMessage({ kind });
      // Every file that spells the sentence out.
      const homes = files.filter((p) => readFileSync(new URL(p, srcRoot), 'utf8').includes(sentence));
      // Exactly one home.
      assert.deepEqual(homes, ['features/settings/masterStore.ts'], `"${sentence}" is written out in: ${homes.join(', ')}`);
    }
  });

  it('refuses when the latest master would change a claim the tailor made, and writes nothing', async () => {
    // Latest master reworded a bullet the resume carries: a re-pin would silently change that line.
    const changed = clone(MASTER_V3);
    // b-tests reworded in the master.
    changed.experience[0]!.bullets[1]!.text = 'Wrote integration tests for the billing service';
    // That master is the latest one.
    const { done, calls } = run({ latest: { data: { profile: changed, version: 4 }, error: null } });
    // Awaited.
    const out = await done;
    // Refused.
    assert.equal(out.ok, false);
    // Refused by the proof, not by ingest validation (which would also write nothing).
    if (!out.ok) assert.match(out.message, /changed since this resume was tailored/);
    // Neither a master version...
    assert.equal(callsOf(calls, 'master_profiles', 'insert').length, 0);
    // ...nor an application write.
    assert.equal(callsOf(calls, 'applications', 'update').length, 0);
  });

  it('refuses when the latest master changed an entry ADDED BACK earlier (not a tailor claim), and writes nothing', async () => {
    // Positive control first: with the master unchanged, a resume carrying the added-back entry attests fine.
    const control = await run({}, { current: withBetaV3() }).done;
    // So the refusal below is about the rename, not about Beta being there.
    assert.equal(control.ok, true, control.ok ? '' : control.message);
    // Latest master renamed Beta: the tailor never chose Beta, so only the tracesToMaster step can see this.
    const renamed = clone(MASTER_V3);
    // Only the company changes.
    renamed.experience[1]!.company = 'Beta Corp';
    // Attested on the resume that carries Beta.
    const { done, calls } = run({ latest: { data: { profile: renamed, version: 4 }, error: null } }, { current: withBetaV3() });
    // Awaited.
    const out = await done;
    // Refused.
    assert.equal(out.ok, false);
    // The re-pin would print a different employer name: refused as a changed master.
    if (!out.ok) assert.match(out.message, /changed since this resume was tailored/);
    // Proven before writing: no master version...
    assert.equal(callsOf(calls, 'master_profiles', 'insert').length, 0);
    // ...and no application write.
    assert.equal(callsOf(calls, 'applications', 'update').length, 0);
  });

  it('refuses a parent entry that is not on the resume, before any network call', async () => {
    // exp-beta exists in the master but is not printed: the new line would have no heading.
    const { done, calls } = run({}, { parentRef: 'exp-beta' });
    // Awaited.
    const out = await done;
    // Refused.
    assert.equal(out.ok, false);
    // With the instruction to add the entry first.
    if (!out.ok) assert.match(out.message, /not on this resume/);
    // Nothing read, nothing written.
    assert.equal(calls.length, 0);
  });

  it('refuses blank or over-long text before any network call', async () => {
    // Whitespace trims to nothing; 2001 characters is one past the edit cap.
    for (const text of ['   ', 'x'.repeat(2001)]) {
      const { done, calls } = run({}, { text });
      // Refused, named by length on failure.
      assert.equal((await done).ok, false, `text of length ${text.length}`);
      // Before any read or write.
      assert.equal(calls.length, 0);
    }
  });

  it('refuses a non-string text or a non-bullet section without throwing (args built from model output)', async () => {
    // A number where text belongs, then a section that holds no bullets: both reach here from AI output.
    for (const bad of [{ text: 42 as unknown as string }, { section: 'skills' as never }]) {
      // Must resolve, never reject: the function promises an outcome on every path.
      const { done, calls } = run({}, bad);
      // Refused.
      assert.equal((await done).ok, false, JSON.stringify(bad));
      // Before any read or write.
      assert.equal(calls.length, 0);
    }
  });

  it('Undo before approve: removing the attested bullet restores the tailored bullets', async () => {
    // A landed attest first.
    const { done } = run({});
    // Awaited.
    const out = await done;
    // Precondition.
    assert.equal(out.ok, true);
    // Narrowed.
    if (!out.ok) return;
    // Undo is the existing remove path; the bullet goes, the tailor's bullets stay as they were.
    const undone = edits.removeBullet(out.resume, { kind: 'bullet', ref: out.bulletRef });
    // Accepted.
    assert.equal(undone.ok, true);
    // Exactly the tailor's entries again.
    if (undone.ok) assert.deepEqual(undone.resume.experience, originalV3().experience);
  });
});
