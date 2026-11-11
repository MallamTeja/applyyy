/* The one-page rule, live in the approval editor (Teja, 2026-11-07 23:18 IST: "they need to be
   handled live while adding new skills and all, but not by AI").

   Every edit's new resume passes through here BEFORE it is saved, and what is saved is what comes
   out: one page, by the same pure trimmer the tailor uses (supabase/functions/_shared/tailor/
   page-trim.ts), so a live edit and a fresh tailoring can never trim by different rules. The
   typography step is not chosen here: renderResumeHtml picks it on every render, so the preview
   already shows the smaller type when one is needed. This module only removes content when even
   the smallest type overflows, and refuses when the floors themselves overflow.

   Then the content rules (2026-11-08, supabase/functions/_shared/tailor/content-rules.ts): an edit
   that newly breaks one (above all, a 3rd project) is refused before the save, like an overflow.

   Pure: no React, no network, no Supabase. The page wires it; the tests drive it directly. */
// The same trimmer as the tailor, by relative path (the rowPipeline.ts precedent): one rule, one file.
import { fitToOnePage, PAGE_FIT_FLOORS, type TrimItem } from '../../../../../supabase/functions/_shared/tailor/page-trim.ts';
// The content rules' gate (Teja, 2026-11-08), the same file the tailor and the auditor run: one rule, one file.
import { checkContentRules } from '../../../../../supabase/functions/_shared/tailor/content-rules.ts';
// The resume and master types, from the web's own contract module.
import type { MasterProfile, ResolvedResume } from '../../data/contract';

/* What the content-rule check needs beyond the edited resume. One named object, not two more
   positional params: `previous` and `next` share a type, so positional order could be swapped silently. */
export interface ContentRuleContext {
  // The resume as stored BEFORE this edit, so a row tailored before the rules can still be fixed.
  readonly previous: ResolvedResume;
  // The master the row is pinned to: every floor is min(rule, what this master holds).
  readonly master: MasterProfile;
}

/* One broken rule's identity: the section/ref before ":" plus its direction (cap or floor). The
   direction matters: an old row breaking "projects: 3, at most 2" must not license an edit down to
   "projects: 1, needs 2", which shares the prefix "projects" but is a different rule. */
function ruleKey(broken: string): string {
  // "projects: 3, at most 2" -> "projects|max"; "exp_aczen: 1 bullets, needs 4" -> "exp_aczen|min".
  return `${broken.split(':')[0]}|${broken.includes('at most') ? 'max' : 'min'}`;
}

/* THE "MAKES WORSE" RULE. Every rule `next` breaks that `previous` did not, plus the project cap when
   the count rises past it. Why not simply refuse whatever `next` breaks: a row tailored before the
   rules (live: 3 projects, 1 Aczen bullet) would then refuse EVERY edit, including the one that fixes
   it (removing the 3rd project). So a rule the stored row already broke stays tolerated, and only a
   newly broken rule refuses. The cap is checked by count too, because "projects|max" is already broken
   on such a row and adding a 4th project must still be refused (the ruling that started this).
   ponytail: a floor already broken may sink further (certifications 2 -> 1 on an old row); compare
   per-rule counts if that ever matters. */
function newlyBroken(previous: ResolvedResume, next: ResolvedResume, master: MasterProfile): string[] {
  // The rules the stored row already broke, by identity.
  const before = new Set(checkContentRules(previous, master).map(ruleKey));
  // Rules `next` breaks that were not broken before.
  const broken = checkContentRules(next, master).filter((rule) => !before.has(ruleKey(rule)));
  // Over the cap and growing: refused even when the cap was already broken (an old 3-project row adding a 4th).
  const capRise = next.projects.length > PAGE_FIT_FLOORS.maxProjects && next.projects.length > previous.projects.length;
  // Named once: when the cap is newly broken, the filter above already holds it.
  if (capRise && !broken.some((rule) => ruleKey(rule) === 'projects|max')) broken.push(`projects: ${next.projects.length}, at most ${PAGE_FIT_FLOORS.maxProjects}`);
  // Empty = the edit makes no rule worse.
  return broken;
}

/* What an edit becomes after the fit: a resume to save (with what was cut), or a refusal. */
export type PageFitEdit =
  // Save `resume` exactly; `trimmed` goes into the history note and `notice` onto the screen.
  | { readonly ok: true; readonly resume: ResolvedResume; readonly trimmed: readonly TrimItem[]; readonly notice: string | null }
  // Nothing may be saved; `reason` is shown where the edit was made.
  | { readonly ok: false; readonly reason: string };

// A trimmed line is quoted in the notice up to this many characters, so a long bullet stays readable.
const QUOTE_LIMIT = 70;

/* One trimmed item as the operator reads it: its printed text, shortened for the notice only. */
function quote(item: TrimItem): string {
  // Collapsed whitespace, so a wrapped bullet reads as one line.
  const text = item.text.replace(/\s+/g, ' ').trim();
  // Shortened with an ellipsis past the limit; the full text is in the history note.
  return `"${text.length > QUOTE_LIMIT ? `${text.slice(0, QUOTE_LIMIT - 1)}…` : text}"`;
}

/* The visible sentence for a trim, or null when nothing was cut. Never silent (the rule's own ask). */
export function trimNotice(trimmed: readonly TrimItem[]): string | null {
  // Nothing cut, nothing to say.
  if (trimmed.length === 0) return null;
  // Every cut item, quoted, in the order it went.
  return `Trimmed to fit one page: ${trimmed.map(quote).join(', ')}.`;
}

/* Fit one edited resume on one page. Fails CLOSED: a resume the check cannot measure is refused,
   never saved (CLAUDE.md section 6: unmeasurable is not "fits"). Then the content rules (Teja,
   2026-11-08: at most 2 projects, Aczen/project/cert/achievement/education floors) on the FITTED
   resume, the one that would be saved. `rules` is required, not optional: a default would let a
   caller skip the gate by omission (CLAUDE.md section 6). */
export function fitEditToOnePage(next: ResolvedResume, jdKeywords: readonly string[], rules: ContentRuleContext): PageFitEdit {
  // The trimmer's answer, or nothing when it threw.
  let fit: ReturnType<typeof fitToOnePage>;
  // A throw here is a measuring failure, and a measuring failure must not become a save.
  try {
    // The same call the tailor makes, on the resume the edit produced.
    fit = fitToOnePage(next, jdKeywords);
  } catch {
    // Said plainly; nothing was sent.
    return { ok: false, reason: 'the one-page check could not measure this resume, so nothing was saved.' };
  }
  // The floors themselves overflow: refuse, naming what held, so the operator knows what to remove.
  if (!fit.fits) {
    // The floors in plain words, joined.
    return { ok: false, reason: `this would make the resume longer than one page, and nothing more can be cut automatically (${fit.blockedBy.join('; ')}). Remove something first.` };
  }
  // The content rules this save would newly break, judged on what would actually be stored.
  const broken = newlyBroken(rules.previous, fit.resume, rules.master);
  // Any: refuse before the save, naming each rule in the gate's own words.
  if (broken.length > 0) return { ok: false, reason: `this breaks the resume content rules (${broken.join('; ')}).` };
  // One page: save this resume, and say what was cut.
  return { ok: true, resume: fit.resume, trimmed: fit.trimmed, notice: trimNotice(fit.trimmed) };
}

/* T10 (2026-11-10): THE ATOMIC BATCH. Live bug (Teja, 12:20 IST): an AI swap ("instead of One-on-One
   use F1 Race Pace") is remove_entry + add_master_entry, and checked after EACH op it can never pass:
   the remove alone is "projects: 1, needs 2", the add alone "projects: 3, at most 2". So a batch is
   judged on its END STATE: every action folded over the current resume by the same pure step the page
   saves with, then ONE fitEditToOnePage against the pre-batch resume, then (in the page) ONE save.
   All or none: a step its edit refuses, or an end state that breaks a rule, returns a reason and no
   resume, so nothing can be saved half-way. The intermediate states are never judged, on purpose:
   they are never stored, and only what is stored has to obey the rules. */

/* One folded step's record for the history note: what the pure edit said changed. */
export interface BatchStep {
  // The edit's own before text (an entry's label, a skill's name, a bullet's old text), or null.
  readonly before: string | null;
  // The edit's own after text, or null.
  readonly after: string | null;
}

/* What a whole batch becomes. A closed union, no boolean beside it: a refusal carries no resume to save. */
export type BatchPlan =
  // Save `resume` exactly, in one write; `steps` is aligned with the actions, for the history note.
  | { readonly ok: true; readonly resume: ResolvedResume; readonly trimmed: readonly TrimItem[]; readonly notice: string | null; readonly steps: readonly BatchStep[] }
  // Nothing may be saved; `reason` is shown where the batch was applied.
  | { readonly ok: false; readonly reason: string };

/* One pure edit as the page computes it (pureEdit, tailoredEdits' EditOutcome): a new resume with its
   before/after, or a refusal with the edit's own reason. Structural, so the tests pass the very
   tailoredEdits functions without a page. */
export type BatchEditStep<A> = (resume: ResolvedResume, action: A) => ({ readonly ok: true; readonly resume: ResolvedResume } & BatchStep) | { readonly ok: false; readonly reason: string };

/* Fold `actions` over `current`, then fit and rule-check the end state once. `master` is required for
   the reason fitEditToOnePage's `rules` is: no caller may skip the content rules by omission. */
export function planBatch<A>(current: ResolvedResume, actions: readonly A[], step: BatchEditStep<A>, jdKeywords: readonly string[], master: MasterProfile): BatchPlan {
  // An empty batch would save an unchanged resume under a history note naming nothing.
  if (actions.length === 0) return { ok: false, reason: 'there was nothing to apply.' };
  // The resume as the batch builds it, never stored until the end state passes.
  let resume = current;
  // Each step's record, in order.
  const steps: BatchStep[] = [];
  // Every action, in the order the AI answered them.
  for (const action of actions) {
    // The same pure edit the page's single save runs.
    const edited = step(resume, action);
    // One refused step refuses the whole batch: applying the rest would be the partial save this exists to prevent.
    if (!edited.ok) return { ok: false, reason: edited.reason };
    // Recorded for the note.
    steps.push({ before: edited.before, after: edited.after });
    // The next step builds on this one.
    resume = edited.resume;
  }
  // ONE fit and ONE rule check, judged against the resume as stored before the batch.
  const fitted = fitEditToOnePage(resume, jdKeywords, { previous: current, master });
  // The end state breaks a rule or overflows past the floors: nothing is saved.
  if (!fitted.ok) return fitted;
  // The end state, fitted, with every step's record.
  return { ...fitted, steps };
}

/* T10 review fix (2026-11-10): THE APPLY-ALL LINE. Each card previews its own add alone, but Apply all fits the
   END state, so a batch can trim bullets no card warned about. This line reads the very planBatch the save runs
   and says, before the click, what that end state costs. `blocked` turns Apply all off: the save would refuse. */
export function applyAllNotice(plan: BatchPlan | null): { readonly line: string | null; readonly blocked: boolean } {
  // No preview (render-only callers, an unsimulable row, a batch of attests only): quiet, and the save's own guards speak.
  if (plan === null) return { line: null, blocked: false };
  // The save would refuse: say why, and keep the button off.
  if (!plan.ok) return { line: `Apply all would not save: ${plan.reason}`, blocked: true };
  // One page with nothing cut: quiet.
  if (plan.trimmed.length === 0) return { line: null, blocked: false };
  // The batch's own trim, quoted like the save's notice.
  return { line: `Apply all also drops ${plan.trimmed.map(quote).join(', ')} (least job-relevant).`, blocked: false };
}

/* T10 (2026-11-10): THE OVERFLOW PREVIEW, shown on an AI-chat card that ADDS content BEFORE its Apply,
   so an add that would run past one page is never a surprise ("never silently overflow, never silently
   drop"). It runs the very fitToOnePage that fitEditToOnePage runs at the save, on the same resume the
   save would build, so the drop it names IS the trim Apply makes (a test pins that). It does not run
   the content rules: those refuse at Apply in their own words, and this line is about the page only. */

/* What a content-adding card puts on the resume, when the card itself must build it (the attest_* kinds,
   whose real ref is minted only at the save). Closed: a third kind is a compile error here, not a guess. */
export type AddedItem =
  // attest_skill: a skill the master lacks, printed under `category`.
  | { readonly kind: 'skill'; readonly name: string; readonly category: string }
  // attest_bullet: the owner's own words, appended under one entry (where attestBullet's master puts it: last).
  | { readonly kind: 'bullet'; readonly section: 'experience' | 'projects' | 'education' | 'achievements' | 'certifications'; readonly entryRef: string; readonly text: string };

/* The preview's answer. One closed union, no boolean beside it: each arm is one line on the card. */
export type OverflowPreview =
  // One page with the add: the card stays quiet.
  | { readonly kind: 'fits' }
  // Over one page: Apply also drops these existing bullets, least job-relevant first. Never lists the add itself.
  | { readonly kind: 'drops'; readonly drop: readonly TrimItem[] }
  // Over one page, and the add is itself the least job-relevant line: Apply would trim it straight back off.
  | { readonly kind: 'cuts_the_add' }
  // Over one page and the floors hold: Apply would be refused (fitEditToOnePage's own reason).
  | { readonly kind: 'blocked'; readonly reason: string };

/* The ref a previewed attest item carries. Its real ref is a fresh uuid minted at the save; the trimmer
   ranks by text score and document position, never by ref, so this stand-in trims exactly like it. */
export const PREVIEW_ADDED_REF = 'preview_added';

/* The resume an attest card's Apply would fit: `current` with the item appended where its save puts it. */
export function withAdded(current: ResolvedResume, added: AddedItem): ResolvedResume {
  // A skill goes last, as addSkill appends it.
  if (added.kind === 'skill') return { ...current, skills: [...current.skills, { ref: PREVIEW_ADDED_REF, name: added.name, category: added.category }] };
  // The new bullet, text and master_text alike (a vouched line is its own master text).
  const bullet = { ref: PREVIEW_ADDED_REF, text: added.text, master_text: added.text };
  // Appended last under the matching entry of the named section; every other section and entry stays the same object.
  const append = <E extends { readonly ref: string; readonly bullets: readonly (typeof bullet)[] }>(section: string, entries: readonly E[]): readonly E[] =>
    // Another section: untouched. The named one: only the parent changes.
    section !== added.section ? entries : entries.map((entry) => (entry.ref === added.entryRef ? { ...entry, bullets: [...entry.bullets, bullet] } : entry));
  // One call per section, so each keeps its own entry type (a computed key would widen them into one union).
  return {
    // Everything else as stored.
    ...current,
    // Each bullet section, appended to only when it is the named one.
    experience: append('experience', current.experience),
    // Same.
    projects: append('projects', current.projects),
    // Same.
    education: append('education', current.education),
    // Same.
    achievements: append('achievements', current.achievements),
    // Same.
    certifications: append('certifications', current.certifications),
  };
}

/* The preview over an already-built resume (a pureEdit result, or withAdded's). The added refs are the
   bullets and skills `next` holds that `current` does not, so the add is never offered as "the drop". */
export function overflowPreview(current: ResolvedResume, next: ResolvedResume, jdKeywords: readonly string[]): OverflowPreview {
  // Every bullet ref already on the resume: anything else in a trim is part of the add.
  const before = new Set([...current.experience, ...current.projects, ...current.education, ...current.achievements, ...current.certifications].flatMap((entry) => entry.bullets.map((b) => b.ref)));
  // The trimmer's answer, or nothing when it threw.
  let fit: ReturnType<typeof fitToOnePage>;
  // A throw is a measuring failure: shown as a refusal, exactly as the save would refuse it.
  try {
    // The same call fitEditToOnePage makes at the save.
    fit = fitToOnePage(next, jdKeywords);
  } catch {
    // fitEditToOnePage's own words for this case, so the card and the save say the same thing.
    return { kind: 'blocked', reason: 'the one-page check could not measure this resume, so nothing was saved.' };
  }
  // The floors hold: Apply is refused; the reason names them.
  if (!fit.fits) return { kind: 'blocked', reason: `this would make the resume longer than one page, and nothing more can be cut automatically (${fit.blockedBy.join('; ')}). Remove something first.` };
  // One page with nothing cut: quiet.
  if (fit.trimmed.length === 0) return { kind: 'fits' };
  // The trimmer took the add itself: say that, never name it as "the drop" the owner should accept.
  if (fit.trimmed.some((item) => !before.has(item.ref))) return { kind: 'cuts_the_add' };
  // Existing bullets only: these are what Apply also drops.
  return { kind: 'drops', drop: fit.trimmed };
}

/* The preview for an attest card: build the add, then preview it. */
export function previewAdd(current: ResolvedResume, added: AddedItem, jdKeywords: readonly string[]): OverflowPreview {
  // One path for every caller, so the card and the test read the same answer.
  return overflowPreview(current, withAdded(current, added), jdKeywords);
}

/* The one line a card shows for its preview, or null to stay quiet (it fits, or there is no preview).
   Here, not in the panel, so the wording sits beside the quoting the save's own notice uses. */
export function overflowNotice(preview: OverflowPreview | null): string | null {
  // No preview (not an add, or the row cannot be simulated) and a fit both say nothing.
  if (preview === null || preview.kind === 'fits') return null;
  // The drop, quoted like the save's own trim notice, named before the click.
  if (preview.kind === 'drops') return `Would run past one page: Apply also drops ${preview.drop.map(quote).join(', ')} (least job-relevant).`;
  // The add is the weakest line: Apply keeps it in the master but the page fit cuts it from this resume.
  if (preview.kind === 'cuts_the_add') return 'Would run past one page: this is the least job-relevant line, so Apply would trim it straight back off this resume. Remove something first.';
  // Floors hold: Apply would be refused; the reason already ends in "Remove something first."
  return `Would run past one page: ${preview.reason}`;
}
