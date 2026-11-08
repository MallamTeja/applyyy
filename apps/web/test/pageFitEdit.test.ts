// The one-page rule, live in the approval editor (Teja, 2026-11-07 23:18 IST): an edit that would
// overflow is trimmed in the same save and the cut is announced; floors that overflow refuse the
// edit; an AI batch that would hit the floors is held back before its first save.
// The page measurement is the template's real fitsOnePage (calibrated against Chromium in
// worker/test/page-fit-calibration.test.ts); the fixture is the template's committed synthetic one.
// The .tsx loader; must be the first import so it runs before any component loads.
import './support/registerTsxHooks.ts';
import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import type { MasterProfile, ResolvedResume } from '../src/data/contract';

// Loaded after the hooks so the resolve hook applies to the module's own imports.
let fit: typeof import('../src/features/approval/pageFitEdit.ts');
// The renderer's own one-page question, to check the outcome independently.
let template: typeof import('../../../packages/resume-template/src/index.ts');
// The synthetic fixture (no real person).
let fixture: typeof import('../../../packages/resume-template/test/fixtures/zomato-backend-intern.ts');

before(async () => {
  // The module under test.
  fit = await import('../src/features/approval/pageFitEdit.ts');
  // The renderer.
  template = await import('../../../packages/resume-template/src/index.ts');
  // The fixture.
  fixture = await import('../../../packages/resume-template/test/fixtures/zomato-backend-intern.ts');
});

/** The fixture with `extra` long bullets spread over its experience and project entries. */
function grown(extra: number): ResolvedResume {
  // A deep copy per call.
  const resume = structuredClone(fixture.zomatoBackendIntern) as unknown as ResolvedResume;
  // The entries that take bullets.
  const targets = [...resume.experience, ...resume.projects];
  // Round-robin.
  for (let i = 0; i < extra; i += 1) {
    // Long and unique per i.
    const text = `Built and operated service number ${i} handling queues, caching, retries and dashboards for several internal teams.`;
    // Appended like any tailored bullet.
    (targets[i % targets.length]!.bullets as { ref: string; text: string; master_text: string }[]).push({ ref: `syn_${i}`, text, master_text: text });
  }
  // The grown resume.
  return resume;
}

/** The fullest grown resume that still fits one page: an edit on top of it overflows. */
function nearFull(): ResolvedResume {
  // Grow until the next size would not fit.
  let n = 0;
  // Bounded: the fixture overflows long before 80 extra bullets.
  while (n < 80 && template.fitsOnePage(grown(n + 1))) n += 1;
  // The last size that fits.
  return grown(n);
}

/** An add_skill stand-in: a new skill appended (what tailoredEdits.addSkill produces, minus the master lookup). */
function withSkills(resume: ResolvedResume, count: number): ResolvedResume {
  // New skill objects, each its own group so every one adds a printed line.
  const added = Array.from({ length: count }, (_, i) => ({ ref: `skill_new_${i}`, name: `Tool number ${i} with a long name`, category: `Group ${i}` }));
  // Appended after the existing skills.
  return { ...resume, skills: [...resume.skills, ...added] };
}

// A master with nothing in it: every content floor is min(rule, 0) = 0, so only the 2-project cap can bind.
// Cast: checkContentRules reads only these five lists, and the page-fit tests are not about the rules.
const EMPTY_MASTER = { projects: [], experience: [], certifications: [], achievements: [], education: [] } as unknown as MasterProfile;

/** The content-rule context for a page-fit test: the edit compared with itself, against the empty master. */
function noRules(resume: ResolvedResume) {
  // Nothing newly broken by construction, so these tests measure the page fit alone.
  return { previous: resume, master: EMPTY_MASTER };
}

/** One synthetic project, shaped like the fixture's own, with one short bullet (fits easily). */
function project(ref: string) {
  // A distinct ref and bullet ref, so the rules count it as its own entry.
  return { ref, name: `Project ${ref}`, links: [], start_display: null, end_display: null, bullets: [{ ref: `bul_${ref}`, text: `Shipped ${ref}.`, master_text: `Shipped ${ref}.` }] };
}

/** The fixture holding exactly these project refs (prj_applyy is the fixture's own). */
function withProjects(refs: readonly string[]): ResolvedResume {
  // The committed fixture, unchanged otherwise.
  const base = grown(0);
  // The fixture's own project kept as-is; the rest synthetic.
  const projects = refs.map((ref) => (ref === 'prj_applyy' ? base.projects[0]! : project(ref)));
  // Cast: the synthetic projects use the fixture's shape.
  return { ...base, projects } as unknown as ResolvedResume;
}

/** A master holding three projects (one bullet each) and nothing else, so the 2-project cap is what binds. */
const THREE_PROJECT_MASTER = {
  // Empty, so their floors bind nothing (min(rule, 0) = 0).
  experience: [], certifications: [], achievements: [], education: [],
  // Three projects, one bullet each: min(2, 3) = 2 is both the floor and the cap.
  projects: ['prj_applyy', 'prj_two', 'prj_three'].map((id) => ({ id, bullets: [{ id: `bul_${id}`, text: id }] })),
} as unknown as MasterProfile;

describe('content rules in the editor (Teja, 2026-11-08)', () => {
  it('editor save never keeps 3 projects', () => {
    // The stored row: two projects, compliant.
    const previous = withProjects(['prj_applyy', 'prj_two']);
    // The edit: an add_master_entry of a third project.
    const next = withProjects(['prj_applyy', 'prj_two', 'prj_three']);
    // The save's fit.
    const out = fit.fitEditToOnePage(next, [], { previous, master: THREE_PROJECT_MASTER });
    // Refused, naming the projects rule.
    assert.ok(!out.ok && out.reason.includes('content rules') && out.reason.includes('projects: 3, at most 2'), out.ok ? 'saved' : out.reason);
    // An old row already over the cap may not grow either (3 -> 4).
    const fourth = { ...next, projects: [...next.projects, project('prj_four')] } as unknown as ResolvedResume;
    // Refused on the count rising, though "projects" was already broken.
    const grownOut = fit.fitEditToOnePage(fourth, [], { previous: next, master: THREE_PROJECT_MASTER });
    // Named.
    assert.ok(!grownOut.ok && grownOut.reason.includes('projects: 4, at most 2'), grownOut.ok ? 'saved' : grownOut.reason);
  });

  it('editor allows removing a 3rd project from an old row', () => {
    // A row tailored before the rules: three projects.
    const previous = withProjects(['prj_applyy', 'prj_two', 'prj_three']);
    // The fix Teja wants: the third removed.
    const next = withProjects(['prj_applyy', 'prj_two']);
    // The save's fit.
    const out = fit.fitEditToOnePage(next, [], { previous, master: THREE_PROJECT_MASTER });
    // Saved.
    assert.equal(out.ok, true, out.ok ? '' : out.reason);
  });

  it('an AI batch that would add a 3rd project is held back before its first save', () => {
    // Each op adds the named project.
    const addProject = (resume: ResolvedResume, ref: string) => ({ ok: true as const, resume: { ...resume, projects: [...resume.projects, project(ref)] } as unknown as ResolvedResume });
    // From one project: op 1 is fine, op 2 makes three.
    const reason = fit.preflightBatch(withProjects(['prj_applyy']), ['prj_two', 'prj_three'], addProject, [], THREE_PROJECT_MASTER);
    // Held back with the rule.
    assert.match(reason ?? '', /projects: 3, at most 2/);
  });
});

describe('fitEditToOnePage (live, per save)', () => {
  it('an add_skill that overflows is SAVED on one page: bullets are cut, every skill stays, and the cut is announced', () => {
    // The edit's raw result: near-full plus new skills, over one page.
    const edited = withSkills(nearFull(), 4);
    // Precondition: the raw edit does not fit.
    assert.equal(template.fitsOnePage(edited), false);
    // The fit the save runs.
    const out = fit.fitEditToOnePage(edited, ['caching'], noRules(edited));
    // Saved, not refused.
    assert.equal(out.ok, true);
    // Narrowed.
    if (!out.ok) return;
    // One page by the renderer's own model.
    assert.equal(template.fitsOnePage(out.resume), true);
    // Every skill, including the four just added, is still there: skills are never trimmed.
    assert.deepEqual(out.resume.skills, edited.skills);
    // Something was cut, and it is listed for the history note.
    assert.ok(out.trimmed.length > 0);
    // The visible notice names the cut text.
    assert.match(out.notice ?? '', /^Trimmed to fit one page: "/);
    // Each cut item's text is quoted in it (first 20 chars are enough to identify it).
    for (const item of out.trimmed) assert.ok(out.notice!.includes(item.text.slice(0, 20)), item.ref);
  });

  it('an edit that still fits saves unchanged, with no notice', () => {
    // The fixture as committed fits.
    const resume = grown(0);
    // The fit.
    const out = fit.fitEditToOnePage(resume, [], noRules(resume));
    // Same object, nothing cut, nothing to say.
    assert.ok(out.ok && out.resume === resume && out.trimmed.length === 0 && out.notice === null);
  });

  it('floors that overflow REFUSE the edit, naming what held; nothing is returned to save', () => {
    // A never-trimmed summary long enough that no amount of bullet cutting fits it.
    const base = grown(0);
    // Printed first, so it counts.
    const edited = { ...base, section_order: ['summary', ...base.section_order], summary: 'Long summary sentence about systems. '.repeat(400) } as ResolvedResume;
    // The fit.
    const out = fit.fitEditToOnePage(edited, [], noRules(edited));
    // Refused.
    assert.equal(out.ok, false);
    // In plain words, naming the summary floor.
    assert.ok(!out.ok && out.reason.includes('longer than one page') && out.reason.includes('summary: never removed'), !out.ok ? out.reason : '');
  });

  it('an unmeasurable resume is refused (fail closed), never saved', () => {
    // A schema the renderer refuses: fitsOnePage answers false at every step, so the floors "overflow".
    const stale = { ...grown(0), schema_version: 2 } as unknown as ResolvedResume;
    // The fit.
    const out = fit.fitEditToOnePage(stale, [], noRules(stale));
    // Not saved.
    assert.equal(out.ok, false);
  });
});

describe('preflightBatch (AI batch, before the first save)', () => {
  // A step that applies "add N skills" actions, the way pureEdit applies add_skill.
  const step = (resume: ResolvedResume, n: number) => ({ ok: true as const, resume: withSkills(resume, n) });

  it('a batch whose every op saves on one page passes (trims are fine, they happen in each save)', () => {
    // Three single-skill adds on a near-full resume: each save trims, none hits the floors.
    assert.equal(fit.preflightBatch(nearFull(), [1, 1, 1], step, [], EMPTY_MASTER), null);
  });

  it('a batch whose op 3 would hit the floors is held back with the reason, before any op saves', () => {
    // A step whose third op makes the never-trimmed summary huge.
    const summaryStep = (resume: ResolvedResume, op: string) => ({ ok: true as const, resume: op === 'huge' ? ({ ...resume, section_order: ['summary', ...resume.section_order], summary: 'Long summary. '.repeat(900) } as ResolvedResume) : withSkills(resume, 1) });
    // Ops 1 and 2 fine, op 3 over the floors.
    const reason = fit.preflightBatch(grown(0), ['a', 'b', 'huge'], summaryStep, [], EMPTY_MASTER);
    // The batch is refused as a whole.
    assert.match(reason ?? '', /longer than one page/);
  });

  it('an op the edit itself refuses does not block the batch (its own save reports it)', () => {
    // A refusing step.
    const refusing = (_resume: ResolvedResume, _op: number) => ({ ok: false as const });
    // Nothing would change, so nothing overflows.
    assert.equal(fit.preflightBatch(grown(0), [1, 2], refusing, [], EMPTY_MASTER), null);
  });
});

describe('trimNotice', () => {
  it('quotes each cut item, shortening a long one, and is null when nothing was cut', () => {
    // Nothing cut.
    assert.equal(fit.trimNotice([]), null);
    // A long bullet is shortened with an ellipsis; a short one is quoted whole.
    const notice = fit.trimNotice([{ step: 'weakest_bullet', ref: 'a', text: 'x'.repeat(100) }, { step: 'certification', ref: 'c', text: 'SQL' }]);
    // Shape.
    assert.equal(notice, `Trimmed to fit one page: "${'x'.repeat(69)}…", "SQL".`);
  });
});
