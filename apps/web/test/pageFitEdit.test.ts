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
// Cast: checkContentRules reads only these six lists (skills since T13, the AI-group floor), and the page-fit tests are not about the rules.
const EMPTY_MASTER = { projects: [], experience: [], certifications: [], achievements: [], education: [], skills: [] } as unknown as MasterProfile;

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
  experience: [], certifications: [], achievements: [], education: [], skills: [],
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
    const notice = fit.trimNotice([{ step: 'weakest_bullet', ref: 'a', text: 'x'.repeat(100) }, { step: 'project_bullet_over_cap', ref: 'c', text: 'SQL' }]);
    // The second item was a 'certification' step until 2026-11-09, when Teja made certs untrimmable and TrimStep lost it.
    // Shape.
    assert.equal(notice, `Trimmed to fit one page: "${'x'.repeat(69)}…", "SQL".`);
  });
});

describe('T10 overflow preview (before Apply on an AI card that adds content)', () => {
  // The posting's one keyword in these tests: the grown bullets carry it, so a bullet without it is the least relevant.
  const JD = ['caching'];

  /** A new skill with its own long group: one more printed line, the cheapest overflow. */
  const SKILL = { kind: 'skill', name: 'Tool with a long enough name to wrap', category: 'A brand new group' } as const;

  /** Every bullet rewritten to carry the JD keyword, so a bullet added WITHOUT it is the unique weakest. */
  function allRelevant(resume: ResolvedResume): ResolvedResume {
    // One bullet, keyword appended; text and master_text alike so nothing reads as edited.
    const tag = <B extends { text: string; master_text: string }>(b: B): B => ({ ...b, text: `${b.text} caching`, master_text: `${b.master_text} caching` });
    // Each bullet-bearing section, entries copied with tagged bullets.
    const each = <E extends { bullets: readonly { ref: string; text: string; master_text: string }[] }>(entries: readonly E[]): E[] => entries.map((e) => ({ ...e, bullets: e.bullets.map(tag) }));
    // The same resume, every bullet relevant.
    return { ...resume, experience: each(resume.experience), projects: each(resume.projects), education: each(resume.education), achievements: each(resume.achievements), certifications: each(resume.certifications) };
  }

  it('T10 overflow: an add that overflows proposes the least job-relevant non-protected bullet to drop', () => {
    // Near-full: one more skill line overflows.
    const current = nearFull();
    // The preview of an attest_skill card.
    const out = fit.previewAdd(current, SKILL, JD);
    // An overflow with something to drop, not a fit and not a refusal.
    assert.equal(out.kind, 'drops', JSON.stringify(out));
    // Narrowed.
    if (out.kind !== 'drops') return;
    // Something is named.
    assert.ok(out.drop.length > 0);
    // Every existing bullet: what the drop is ranked against.
    const bullets = [...current.experience, ...current.projects, ...current.achievements, ...current.certifications].flatMap((e) => e.bullets);
    // A bullet without the keyword exists, so the first drop must be one of those (least relevant first).
    assert.ok(bullets.some((b) => !b.text.includes('caching')), 'fixture precondition: a zero-score bullet exists');
    // The proposed drop is a zero-score bullet: never one the posting asks for while a weaker one remains.
    assert.ok(!out.drop[0]!.text.includes('caching'), out.drop[0]!.text);
  });

  it('T10 overflow: certifications and achievements are never proposed for a drop', () => {
    // Near-full, and the add overflows.
    const current = nearFull();
    // The preview.
    const out = fit.previewAdd(current, SKILL, JD);
    // Narrowed: this test is about what a drop may name.
    assert.equal(out.kind, 'drops');
    // The resume Apply would save for the same add (the real save path).
    const applied = fit.fitEditToOnePage({ ...current, skills: [...current.skills, { ref: 'skill_real', name: SKILL.name, category: SKILL.category }] }, JD, noRules(current));
    // Saved.
    assert.ok(applied.ok);
    // Narrowed.
    if (!applied.ok) return;
    // Every certification entry stays: the drop is bullets, never a cert.
    assert.deepEqual(applied.resume.certifications.map((c) => c.ref), current.certifications.map((c) => c.ref));
    // Every achievement entry stays, each with at least one bullet (the achievements floor).
    assert.deepEqual(applied.resume.achievements.map((a) => a.ref), current.achievements.map((a) => a.ref));
    // No achievement lost its last line.
    for (const a of applied.resume.achievements) assert.ok(a.bullets.length >= Math.min(1, current.achievements.find((c) => c.ref === a.ref)!.bullets.length), a.ref);
    // No drop names an achievement's or a certification's entry ref (the drop is never a whole entry).
    const protectedRefs = new Set([...current.certifications, ...current.achievements].map((e) => e.ref));
    // Checked per item.
    if (out.kind === 'drops') for (const item of out.drop) assert.ok(!protectedRefs.has(item.ref), item.ref);
  });

  it('T10 overflow: the item being added is never the proposed drop', () => {
    // Grown on the experience entry only, so no project sits over its 4-bullet cap (that step would go first).
    const onExperience = (n: number) => {
      // A fresh copy of the committed fixture.
      const r = grown(0);
      // The first experience entry's bullets, the only list grown.
      const e = r.experience[0]!.bullets as { ref: string; text: string; master_text: string }[];
      // n long, unique, keyword-bearing bullets.
      for (let i = 0; i < n; i += 1) {
        // Same wording as grown(), so the length per bullet matches.
        const text = `Built and operated service number ${i} handling queues, caching, retries and dashboards for several internal teams.`;
        // Appended like any tailored bullet.
        e.push({ ref: `syn_${i}`, text, master_text: text });
      }
      // Every bullet then made relevant.
      return allRelevant(r);
    };
    // The fullest such resume that fits (bounded like nearFull).
    let n = 0;
    // Grow until one more would overflow.
    while (n < 80 && template.fitsOnePage(onExperience(n + 1))) n += 1;
    // Every existing bullet carries the keyword, so the added bullet (without it) is the trimmer's unique weakest.
    const current = onExperience(n);
    // Precondition: the tagged resume still fits (tagging can lengthen a line).
    assert.equal(template.fitsOnePage(current), true, 'precondition: tagged near-full resume fits');
    // A long owner-dictated bullet under the first experience entry (an attest_bullet card).
    const added = { kind: 'bullet', section: 'experience', entryRef: current.experience[0]!.ref, text: 'Organised a long series of internal knowledge-sharing sessions across several teams over a semester.' } as const;
    // The preview.
    const out = fit.previewAdd(current, added, JD);
    // Not a "drops" naming the add: the add is what the owner asked for. The trimmer would cut it straight back, so it says THAT.
    assert.equal(out.kind, 'cuts_the_add', JSON.stringify(out));
    // In every scenario: a "drops" result never lists the synthetic ref of the add.
    const skillOut = fit.previewAdd(nearFull(), SKILL, JD);
    // Checked on the plain overflow case too.
    if (skillOut.kind === 'drops') assert.ok(skillOut.drop.every((item) => item.ref !== fit.PREVIEW_ADDED_REF));
  });

  it("T10 overflow: the preview's drop equals what Apply trims", () => {
    // Near-full.
    const current = nearFull();
    // The preview of an attest_skill.
    const out = fit.previewAdd(current, SKILL, JD);
    // What Apply runs: the real save path, with the skill under its real (fresh) ref.
    const applied = fit.fitEditToOnePage({ ...current, skills: [...current.skills, { ref: 'skill_real', name: SKILL.name, category: SKILL.category }] }, JD, noRules(current));
    // Both: an overflow that saves.
    assert.ok(out.kind === 'drops' && applied.ok, JSON.stringify(out));
    // Narrowed.
    if (out.kind !== 'drops' || !applied.ok) return;
    // The same bullets, in the same order.
    assert.deepEqual(out.drop.map((i) => i.ref), applied.trimmed.map((i) => i.ref));
    // A pureEdit-built add (add_master_bullet's path) compares the same way: the preview of a built resume.
    const built = { ...current, skills: [...current.skills, { ref: 'skill_master', name: SKILL.name, category: SKILL.category }] };
    // The generic preview over an already-built resume.
    const generic = fit.overflowPreview(current, built, JD);
    // Same drop.
    assert.ok(generic.kind === 'drops' && generic.drop.map((i) => i.ref).join() === applied.trimmed.map((i) => i.ref).join(), JSON.stringify(generic));
  });

  it('T10 overflow: an add that fits proposes nothing', () => {
    // The committed fixture has room.
    const out = fit.previewAdd(grown(0), SKILL, JD);
    // Quiet.
    assert.deepEqual(out, { kind: 'fits' });
  });
});

describe('T10 overflow: the Apply all line', () => {
  it("T10 overflow: Apply all previews the batch's own trim", () => {
    // Two adds, each fine alone on a near-full page, together over one page.
    const step = (resume: ResolvedResume, count: number) => ({ ok: true as const, resume: withSkills(resume, count), before: null, after: null });
    // The same planBatch the save runs.
    const plan = fit.planBatch(nearFull(), [2, 2], step, ['caching'], EMPTY_MASTER);
    // Precondition: the batch trims something.
    assert.ok(plan.ok && plan.trimmed.length > 0, plan.ok ? 'nothing trimmed' : plan.reason);
    // Narrowed.
    if (!plan.ok) return;
    // The line by Apply all.
    const notice = fit.applyAllNotice(plan);
    // Says Apply all drops, not blocked.
    assert.ok(notice.line !== null && notice.line.startsWith('Apply all also drops "') && !notice.blocked, JSON.stringify(notice));
    // Names exactly the batch's own trim.
    for (const item of plan.trimmed) assert.ok(notice.line.includes(item.text.slice(0, 20)), item.ref);
    // A refused batch: the reason, and the button off.
    assert.deepEqual(fit.applyAllNotice({ ok: false, reason: 'projects: 1, needs 2' }), { line: 'Apply all would not save: projects: 1, needs 2', blocked: true });
    // A fit with nothing cut, or no preview: quiet.
    assert.deepEqual(fit.applyAllNotice(null), { line: null, blocked: false });
  });
});
