/* Review page: structural resume edits in the DIFF (2026-11-01,
 * docs/ui/2026-11-01-review-structure-edits-contract.md, W2).
 *
 * Contract under test:
 *   - D5a: every structural change the save gate allows (a moved bullet, a moved section, an entry
 *     added or removed, a bullet added back) shows in the diff AND counts in editCount, so a changed
 *     row can never sit in Bucket A. The structural half lives in diff.structureChanges.
 *   - Bullets are grouped under their section and entry, achievements and certifications included,
 *     and a bullet in a section the PDF does not print earns no coverage.
 *   - The page routes every structural EditAction (which only the AI chat emits since the 2026-11-07
 *     slim card removed the hand controls) to its pure edit; a moved or added bullet is listed under
 *     "Changes by AI" and says so.
 *
 * Adapter cases hand-edit the resume (JSON clone + splice) instead of calling the pure edits, so a
 * failure here is the diff's and not tailoredEdits'. Only the existing producers are used for the
 * fixture: rebuildOriginal (the tailor's version) and resolveFullMaster (FULL, the add-back source).
 * Render cases use react-dom/server and assert markup SHAPE. Routing cannot run without a DOM
 * (apps/web has none), so the page's action-to-edit pairing is checked on the comment-free source.
 *
 * Fixture: generic placeholder identity only (the repo is public). */

// The .tsx loader; must be the first import so it runs before any component loads.
import './support/registerTsxHooks.ts';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, it, before } from 'node:test';
import { fileURLToPath } from 'node:url';

// The adapter under test.
let adapter: typeof import('../src/features/approval/diffAdapter.ts');
// rebuildOriginal, resolveFullMaster and entryLabel: the fixture's producers and the one labeller.
let edits: typeof import('../src/features/approval/tailoredEdits.ts');
// deriveBucket, the one bucket rule.
let model: typeof import('../src/features/approval/diffModel.ts');
// The component that renders the controls.
let view: typeof import('../src/features/approval/DiffView.tsx');
// Static server renderer, no DOM.
let render: (element: unknown) => string;
// Element factory, so no JSX in this .ts file.
let h: typeof import('react').createElement;

before(async () => {
  // Loaded after the hooks so .tsx and extensionless imports resolve.
  adapter = await import('../src/features/approval/diffAdapter.ts');
  // Same.
  edits = await import('../src/features/approval/tailoredEdits.ts');
  // Same.
  model = await import('../src/features/approval/diffModel.ts');
  // Same.
  view = await import('../src/features/approval/DiffView.tsx');
  // The server renderer.
  render = (await import('react-dom/server')).renderToStaticMarkup as (element: unknown) => string;
  // The element factory.
  h = (await import('react')).createElement;
});

// The pinned master version; the tailoring cites the same one or rebuildOriginal refuses it.
const VERSION = 3;
// The bullet text the move cases swap, spelled once so the accessible-name checks can derive from it.
const API = 'Built a REST API with Express and Node.js handling 500 users';
// The second Acme bullet.
const TESTS = 'Wrote unit tests for the billing service';
// The Acme bullet the tailor LEFT OUT, so the master can offer it back.
const CI = 'Set up continuous integration for three services';

// A master with two employers, two certifications (one dropped by the tailor), and two achievements
// (one dropped, one selected but not printed), so every structural offer and state has a case.
const MASTER = {
  // The profile's shape marker.
  schema_version: 1,
  // Placeholder identity.
  identity: { full_name: 'Test Person', headline: 'Backend Engineer', email: 'test@example.com', phone: null, location: 'Remote', links: [] },
  // A summary node the tailored summary can cite.
  summary: { id: 'summary-master', text: 'Backend engineer building REST APIs in Node.js.' },
  experience: [
    {
      id: 'exp-acme', company: 'Acme', role: 'Backend Intern', location: 'Remote',
      start_display: 'Jun 2025', end_display: 'Aug 2025', start_date: null, end_date: null,
      // Three bullets; the tailor keeps the first two.
      bullets: [
        { id: 'b-api', text: API, tags: [] },
        { id: 'b-tests', text: TESTS, tags: [] },
        { id: 'b-ci', text: CI, tags: [] },
      ],
    },
    {
      id: 'exp-beta', company: 'Beta Corp', role: 'Engineer', location: null,
      start_display: 'Jan 2024', end_display: 'May 2025', start_date: null, end_date: null,
      // One bullet, so removing the entry also removes a line.
      bullets: [{ id: 'b-beta', text: 'Shipped the payments dashboard', tags: [] }],
    },
  ],
  // Unused, legal when empty.
  projects: [], education: [],
  achievements: [
    // Dropped by the tailor entirely: the section-level "Add back" case.
    { id: 'ach-hack', label: 'Hackathon winner', description: null, bullets: [] },
    // Selected by the tailor but its section left out of section_order: reviewed, never printed.
    { id: 'ach-talk', label: 'Conference speaker', description: null, bullets: [{ id: 'b-talk', text: 'Spoke about Kafka streams at a meetup', tags: [] }] },
  ],
  certifications: [
    // Selected, with one bullet, so a certification bullet edit has a line to land on.
    { id: 'cert-sql', label: 'SQL Basics', description: 'IBM', bullets: [{ id: 'b-sql', text: 'Scored 95 percent', tags: [] }] },
    // Dropped by the tailor, no bullets: the bullet-less entry an add must still count.
    { id: 'cert-aws', label: 'AWS Cloud Practitioner', description: null, bullets: [] },
  ],
  // One skill, selected.
  skills: [{ id: 'skill-node', name: 'Node.js', category: 'Frameworks' }],
  // Profile-level links, empty.
  links: [],
} as never;

// What the tailor returned.
const TAILOR_REFS = {
  // Contract shape marker.
  schema_version: 1,
  // Matches VERSION.
  master_version: VERSION,
  // Achievements NOT named: selected-but-unprinted, like the live row.
  section_order: ['summary', 'experience', 'skills', 'certifications'],
  // Cites the master summary.
  summary: { text: 'Backend engineer shipping REST APIs in Node.js.', refs: ['summary-master'] },
  // The one skill.
  skills: [{ ref: 'skill-node' }],
  // Acme without b-ci; Beta whole.
  experience: [
    { ref: 'exp-acme', bullets: [{ ref: 'b-api', text: API }, { ref: 'b-tests', text: TESTS }] },
    { ref: 'exp-beta', bullets: [{ ref: 'b-beta', text: 'Shipped the payments dashboard' }] },
  ],
  // Required arrays.
  projects: [], education: [],
  // Only the talk; the hackathon is dropped.
  achievements: [{ ref: 'ach-talk', bullets: [{ ref: 'b-talk', text: 'Spoke about Kafka streams at a meetup' }] }],
  // Only the SQL cert; AWS is dropped.
  certifications: [{ ref: 'cert-sql', bullets: [{ ref: 'b-sql', text: 'Scored 95 percent' }] }],
};

// The resume type, mutated per case.
type Resume = import('../src/data/contract').ResolvedResume;
// The diff type.
type Diff = import('../src/features/approval/diffModel.ts').ResumeDiff;
// Deep copy so each case mutates its own resume.
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value));

// The tailor's resume; a null is a fixture bug, named as one.
const original = (): Resume => {
  // The real producer.
  const resume = edits.rebuildOriginal(TAILOR_REFS, MASTER, VERSION);
  // Loud, so every later failure is not a confusing null read.
  assert.notEqual(resume, null, 'fixture must rebuild to a ResolvedResume');
  // Narrowed.
  return resume!;
};

// FULL for the fixture; same loudness.
const full = (): Resume => {
  // The real resolver.
  const resolved = edits.resolveFullMaster(MASTER, VERSION);
  // A null FULL would switch every offer off and make the offer cases vacuous.
  assert.notEqual(resolved, null, 'fixture master must resolve to FULL');
  // Narrowed.
  return resolved!;
};

// The diff for a stored resume, against the tailor's version and FULL unless overridden.
const diffOf = (resolved: Resume, opts: { original?: Resume | null; keywords?: string[] } = {}): Diff =>
  adapter.buildResumeDiff({
    // Only the fields the adapter reads.
    application: { id: 'app-1', audit_findings: [], selected_jd_keywords: opts.keywords ?? [] } as never,
    // Header names only.
    job: { title: 'Backend Engineer', company_name: 'Example Co' } as never,
    resolved,
    master: MASTER,
    // `in` so a case can pass an explicit null (D4).
    original: 'original' in opts ? (opts.original ?? null) : original(),
    // FULL, the add-back source.
    full: full(),
  });

// One line by id; loud when absent.
const lineOf = (d: Diff, id: string) => {
  // Looked up by the Auditor path the adapter builds.
  const line = d.lines.find((candidate) => candidate.id === id);
  // A missing line is a failure in its own right.
  assert.ok(line, `line ${id} not found`);
  // Narrowed.
  return line!;
};

// One section; loud when absent.
const sectionOf = (d: Diff, kind: string) => {
  // From the grouped layout.
  const section = d.sections?.find((candidate) => candidate.kind === kind);
  // A missing section is a failure in its own right.
  assert.ok(section, `section ${kind} not found`);
  // Narrowed.
  return section!;
};

describe('D5a: every structural change shows in the diff and counts', () => {
  it('an untouched resume has no changes and stays in Bucket A', () => {
    // Exactly the tailor's version.
    const d = diffOf(original());
    // Nothing edited, nothing moved.
    assert.equal(d.editCount, 0);
    // An empty list, present (not undefined), so the view has nothing to say.
    assert.deepEqual(d.structureChanges, []);
    // The batch bucket.
    assert.equal(model.deriveBucket(d), 'A');
  });

  it('a moved bullet (no word changed) counts once, is named, marks both swapped lines, and leaves Bucket A', () => {
    // Acme's two bullets swapped, text untouched.
    const moved = clone(original());
    // In place: the reverse of a two-item list is the swap.
    moved.experience[0]!.bullets.reverse();
    // The diff of the reordered resume.
    const d = diffOf(moved);
    // One structural change, zero text edits: the count is exactly the move.
    assert.equal(d.editCount, 1);
    // Named after the entry it happened in.
    assert.deepEqual(d.structureChanges, [`Reordered bullets under ${edits.entryLabel('experience', moved.experience[0])}`]);
    // Both swapped bullets say so.
    assert.equal(lineOf(d, 'experience.exp-acme.b-api').moved, true);
    // ...both.
    assert.equal(lineOf(d, 'experience.exp-acme.b-tests').moved, true);
    // An unmoved bullet elsewhere does not.
    assert.equal(lineOf(d, 'experience.exp-beta.b-beta').moved, false);
    // The display follows what prints: b-tests now first.
    assert.ok(d.lines.findIndex((l) => l.id.endsWith('b-tests')) < d.lines.findIndex((l) => l.id.endsWith('b-api')), 'display must follow the stored order');
    // And the row is out of the batch.
    assert.equal(model.deriveBucket(d), 'B');
  });

  it('a moved section counts once and the layout follows the new order', () => {
    // Experience promoted above the summary.
    const moved = clone(original());
    // The new order.
    moved.section_order = ['experience', 'summary', 'skills', 'certifications'];
    // The diff.
    const d = diffOf(moved);
    // One change.
    assert.equal(d.editCount, 1);
    // Named.
    assert.deepEqual(d.structureChanges, ['Changed the section order']);
    // The printed sections, in the order the PDF now prints them.
    assert.deepEqual(d.sections?.filter((s) => s.printed).map((s) => s.kind), ['experience', 'summary', 'skills', 'certifications']);
    // Out of the batch.
    assert.equal(model.deriveBucket(d), 'B');
  });

  it('an added certification with NO bullets still counts (no line could) and reads as added', () => {
    // The dropped AWS cert put back from FULL, as addMasterEntry would.
    const added = clone(original());
    // FULL's own entry, so the shape is exactly what an add produces.
    added.certifications.push(full().certifications.find((c) => c.ref === 'cert-aws')!);
    // The diff.
    const d = diffOf(added);
    // One change, and it cannot have come from a line: the cert has none.
    assert.equal(d.editCount, 1);
    // Named with its label and section.
    assert.deepEqual(d.structureChanges, ['Added AWS Cloud Practitioner (Certifications)']);
    // The entry says who added it.
    assert.equal(sectionOf(d, 'certifications').entries.find((e) => e.ref === 'cert-aws')?.state, 'added');
    // Out of the batch.
    assert.equal(model.deriveBucket(d), 'B');
  });

  it('a removed entry counts, reads as removed, and its bullets read removed in place', () => {
    // Beta Corp taken off.
    const removed = clone(original());
    // Only Acme left.
    removed.experience = removed.experience.filter((e) => e.ref !== 'exp-beta');
    // The diff.
    const d = diffOf(removed);
    // One entry change plus one removed bullet line.
    assert.equal(d.editCount, 2);
    // The entry change, named.
    assert.deepEqual(d.structureChanges, ['Removed Beta Corp · Engineer (Experience)']);
    // Shown, struck, where it was.
    assert.equal(sectionOf(d, 'experience').entries.map((e) => `${e.ref}:${e.state}`).join(','), 'exp-acme:kept,exp-beta:removed');
    // Its bullet reads removed, so Reset or Add back can bring it back.
    assert.equal(lineOf(d, 'experience.exp-beta.b-beta').editState, 'removed');
  });

  it('a bullet added back from the master is an unaudited line with no tailor version, and its offer is gone', () => {
    // b-ci put back under Acme, as addMasterBullet would.
    const added = clone(original());
    // FULL's own bullet.
    added.experience[0]!.bullets.push(full().experience[0]!.bullets.find((b) => b.ref === 'b-ci')!);
    // The diff.
    const d = diffOf(added);
    // The new line.
    const line = lineOf(d, 'experience.exp-acme.b-ci');
    // Counted as the operator's.
    assert.equal(line.editState, 'edited');
    // No tailor text to reset to.
    assert.equal(line.originalText, null);
    // Never traced: the Auditor never read a resume carrying it (R1).
    assert.deepEqual(line.tailoredRuns.map((r) => r.verdict), ['edited']);
    // The only change.
    assert.equal(d.editCount, 1);
    // No longer offered.
    assert.deepEqual(sectionOf(d, 'experience').entries[0]?.addableBullets, []);
  });

  it('a certification bullet text edit is a line and counts (the parity gap the walk closes)', () => {
    // The cert bullet reworded.
    const edited = clone(original());
    // New words.
    edited.certifications[0]!.bullets[0]!.text = 'Scored 95 percent on the final exam';
    // The diff.
    const d = diffOf(edited);
    // The certification line exists and is edited.
    assert.equal(lineOf(d, 'certifications.cert-sql.b-sql').editState, 'edited');
    // Counted once.
    assert.equal(d.editCount, 1);
  });
});

describe('grouping, offers and printed coverage', () => {
  it('every bullet line names its section and entry, and entries carry their master offers', () => {
    // The untouched diff.
    const d = diffOf(original());
    // Acme's first bullet knows its parent.
    assert.deepEqual([lineOf(d, 'experience.exp-acme.b-api').section, lineOf(d, 'experience.exp-acme.b-api').entryRef], ['experience', 'exp-acme']);
    // Acme offers the bullet the tailor left out, in the master's words.
    assert.deepEqual(sectionOf(d, 'experience').entries[0]?.addableBullets, [{ ref: 'b-ci', text: CI }]);
    // The dropped AWS cert is offered under its section.
    assert.deepEqual(sectionOf(d, 'certifications').addableEntries, [{ ref: 'cert-aws', label: 'AWS Cloud Practitioner' }]);
    // The unprinted achievements section still shows, says it is not printed, and offers the dropped one.
    assert.deepEqual([sectionOf(d, 'achievements').printed, sectionOf(d, 'achievements').addableEntries.map((e) => e.ref)], [false, ['ach-hack']]);
  });

  it('without an original (D4) nothing is offered and nothing reads as changed', () => {
    // The stored resume with no tailor version to compare against.
    const d = diffOf(original(), { original: null });
    // No offers anywhere.
    assert.equal(d.sections?.every((s) => s.addableEntries.length === 0 && s.entries.every((e) => e.addableBullets.length === 0)), true);
    // No changes.
    assert.deepEqual(d.structureChanges, []);
    // Still grouped: the layout does not depend on editing.
    assert.equal(sectionOf(d, 'experience').entries.length, 2);
  });

  it('a keyword only in an UNPRINTED section earns no coverage; printing the section earns it', () => {
    // Kafka appears only in the selected-but-unprinted achievement bullet.
    const unprinted = diffOf(original(), { keywords: ['Kafka'] });
    // Not on the PDF, so not matched.
    assert.deepEqual(unprinted.coverage.honestlyMatched, []);
    // The same resume with achievements printed (positive control: the filter is what removed it).
    const shown = clone(original());
    // Achievements named.
    shown.section_order = [...shown.section_order, 'achievements'];
    // Now honestly matched (and the order change counts, which is not under test here).
    assert.deepEqual(diffOf(shown, { keywords: ['Kafka'] }).coverage.honestlyMatched, ['Kafka']);
  });
});

// The spoken name ChangeRow builds for a bullet: kind plus the first 40 characters.
const bulletName = (text: string) => 'bullet: ' + (text.length > 40 ? text.slice(0, 40) + '…' : text);
// The whole review screen for a diff, editable unless a reason is given.
const page = (d: Diff, editDisabledReason: string | null = null) =>
  render(h(view.DiffView, { diff: d, onApprove: () => {}, onReject: () => {}, onEdit: async () => ({ ok: true }), editDisabledReason }));

describe('the controls on screen', () => {
  it('a moved bullet and an added one are listed in Changes by AI and say so; neither has a Reset', () => {
    // b-ci added, then the Acme list reordered so the tailor's two swap.
    const changed = clone(original());
    // Added from FULL.
    changed.experience[0]!.bullets.push(full().experience[0]!.bullets.find((b) => b.ref === 'b-ci')!);
    // b-tests, b-api, b-ci: the tailor's two swapped.
    changed.experience[0]!.bullets = [changed.experience[0]!.bullets[1]!, changed.experience[0]!.bullets[0]!, changed.experience[0]!.bullets[2]!];
    // The screen.
    const html = page(diffOf(changed));
    // Two moved lines.
    assert.equal(html.split('<p class="line__provenance line__provenance--edited">moved by you</p>').length - 1, 2);
    // One added line.
    assert.equal(html.split('<p class="line__provenance line__provenance--edited">added by you</p>').length - 1, 1);
    // All three changed lines are listed (two moved, one added), each placed under its entry.
    assert.match(html, /Changes by AI \(3\)/);
    // The entry label the adapter's layout supplies, so a change reads in context.
    assert.match(html, /<p class="diff__change-where">Experience · Acme · Backend Intern<\/p>/);
    // The structural change is listed above the changes, and the note counts changes, not lines.
    assert.match(html, /<div class="diff__structure-changes"><p class="diff__structure-changes-head">Structure changed by you<\/p><ul><li>Reordered bullets under Acme · Backend Intern<\/li><\/ul><\/div>/);
    // 1 move + 1 added line.
    assert.match(html, /You made 2 changes, so this/);
    // No Reset at all: resetTarget cannot restore a move (no words changed) or an added bullet (no
    // tailor version); the AI chat undoes those. A Reset here would only ever answer "Nothing to reset".
    assert.doesNotMatch(html, /Reset to tailor/);
    // Paired absence: no hand Remove either (2026-11-07), the AI chat is the only edit path.
    assert.ok(!html.includes(`aria-label="Remove ${bulletName(CI)}"`), 'no Remove on the added bullet');
  });
});

describe('the page routes each structural EditAction (source shape: no DOM to click in)', () => {
  // apps/web's own typescript, for a comment-free view of the source.
  const ts = createRequire(import.meta.url)('typescript') as typeof import('typescript');
  // A file's code with every comment removed, so a comment can neither satisfy nor trip a check.
  const code = (rel: string) => {
    // The file as written.
    const raw = readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
    // Re-emitted without comments.
    return ts.createPrinter({ removeComments: true }).printFile(ts.createSourceFile('f.tsx', raw, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX));
  };
  // The page. (DiffView's own control pairing went with its controls on 2026-11-07; the AI chat's
  // mapping onto these actions is pinned in aiEdit.test.ts "maps each onto the page's own structural EditAction".)
  const pageSrc = code('../src/features/approval/ApprovalQueuePage.tsx');

  it('the page routes every structural action to its pure edit, and a new bullet through attestBulletRow', () => {
    // Each case of pureEdit, with the call it must make.
    const cases: [string, RegExp][] = [
      ['move_bullet', /case 'move_bullet':\s*return moveBullet\(current, action\.ref, action\.direction\);/],
      ['move_section', /case 'move_section':\s*return moveSection\(current, action\.section, action\.direction\);/],
      ['add_master_bullet', /case 'add_master_bullet':\s*return addMasterBullet\(current, full, action\.ref\);/],
      ['add_master_entry', /case 'add_master_entry':\s*return addMasterEntry\(current, full, action\.section, action\.ref\);/],
      ['remove_entry', /case 'remove_entry':\s*return removeEntry\(current, action\.section, action\.ref\);/],
    ];
    // Each, by name in the failure.
    for (const [kind, shape] of cases) assert.match(pageSrc, shape, `pureEdit does not route ${kind}`);
    // editRow sends attest_bullet to its own path BEFORE any pure edit is built.
    const editRow = pageSrc.slice(pageSrc.indexOf('async function editRow('), pageSrc.indexOf('const outcome =', pageSrc.indexOf('async function editRow(')));
    // The route, carrying who decided it (editSource, 2026-11-04) into the history note.
    assert.match(editRow, /if \(action\.kind === 'attest_bullet'\)\s*return attestBulletRow\(applicationId, action, source, source\.original, current, stamp, supabase, editSource\);/);
    // And a row without FULL is refused before anything is built.
    assert.match(editRow, /if \(source\.full === null\)\s*return notSaved\(FULL_UNRESOLVED_REASON\);/);
  });
});
