// The one-page rule, live in the approval editor (Teja, 2026-11-07 23:18 IST): an edit that would
// overflow is trimmed in the same save and the cut is announced; floors that overflow refuse the
// edit; an AI batch that would hit the floors is held back before its first save.
// The page measurement is the template's real fitsOnePage (calibrated against Chromium in
// worker/test/page-fit-calibration.test.ts); the fixture is the template's committed synthetic one.
// The .tsx loader; must be the first import so it runs before any component loads.
import './support/registerTsxHooks.ts';
import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import type { ResolvedResume } from '../src/data/contract';

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

describe('fitEditToOnePage (live, per save)', () => {
  it('an add_skill that overflows is SAVED on one page: bullets are cut, every skill stays, and the cut is announced', () => {
    // The edit's raw result: near-full plus new skills, over one page.
    const edited = withSkills(nearFull(), 4);
    // Precondition: the raw edit does not fit.
    assert.equal(template.fitsOnePage(edited), false);
    // The fit the save runs.
    const out = fit.fitEditToOnePage(edited, ['caching']);
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
    const out = fit.fitEditToOnePage(resume, []);
    // Same object, nothing cut, nothing to say.
    assert.ok(out.ok && out.resume === resume && out.trimmed.length === 0 && out.notice === null);
  });

  it('floors that overflow REFUSE the edit, naming what held; nothing is returned to save', () => {
    // A never-trimmed summary long enough that no amount of bullet cutting fits it.
    const base = grown(0);
    // Printed first, so it counts.
    const edited = { ...base, section_order: ['summary', ...base.section_order], summary: 'Long summary sentence about systems. '.repeat(400) } as ResolvedResume;
    // The fit.
    const out = fit.fitEditToOnePage(edited, []);
    // Refused.
    assert.equal(out.ok, false);
    // In plain words, naming the summary floor.
    assert.ok(!out.ok && out.reason.includes('longer than one page') && out.reason.includes('summary: never removed'), !out.ok ? out.reason : '');
  });

  it('an unmeasurable resume is refused (fail closed), never saved', () => {
    // A schema the renderer refuses: fitsOnePage answers false at every step, so the floors "overflow".
    const stale = { ...grown(0), schema_version: 2 } as unknown as ResolvedResume;
    // The fit.
    const out = fit.fitEditToOnePage(stale, []);
    // Not saved.
    assert.equal(out.ok, false);
  });
});

describe('preflightBatch (AI batch, before the first save)', () => {
  // A step that applies "add N skills" actions, the way pureEdit applies add_skill.
  const step = (resume: ResolvedResume, n: number) => ({ ok: true as const, resume: withSkills(resume, n) });

  it('a batch whose every op saves on one page passes (trims are fine, they happen in each save)', () => {
    // Three single-skill adds on a near-full resume: each save trims, none hits the floors.
    assert.equal(fit.preflightBatch(nearFull(), [1, 1, 1], step, []), null);
  });

  it('a batch whose op 3 would hit the floors is held back with the reason, before any op saves', () => {
    // A step whose third op makes the never-trimmed summary huge.
    const summaryStep = (resume: ResolvedResume, op: string) => ({ ok: true as const, resume: op === 'huge' ? ({ ...resume, section_order: ['summary', ...resume.section_order], summary: 'Long summary. '.repeat(900) } as ResolvedResume) : withSkills(resume, 1) });
    // Ops 1 and 2 fine, op 3 over the floors.
    const reason = fit.preflightBatch(grown(0), ['a', 'b', 'huge'], summaryStep, []);
    // The batch is refused as a whole.
    assert.match(reason ?? '', /longer than one page/);
  });

  it('an op the edit itself refuses does not block the batch (its own save reports it)', () => {
    // A refusing step.
    const refusing = (_resume: ResolvedResume, _op: number) => ({ ok: false as const });
    // Nothing would change, so nothing overflows.
    assert.equal(fit.preflightBatch(grown(0), [1, 2], refusing, []), null);
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
