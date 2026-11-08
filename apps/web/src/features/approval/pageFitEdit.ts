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

/* One edit step, as the page computes it (pureEdit): a new resume, or a refusal. */
export type EditStep<A> = (resume: ResolvedResume, action: A) => { readonly ok: true; readonly resume: ResolvedResume } | { readonly ok: false };

/* THE AI-BATCH PREFLIGHT: simulate every op of a batch on the current resume, each followed by the
   same fit its real save will run, BEFORE the first save. Answers the reason the batch would stop
   on the floors, or null when every op would save on one page. So a batch never lands half-applied
   because op 3 hit the floors. An op the edit itself refuses is not this check's business (its own
   save reports it), so the simulation skips it exactly as a refused save changes nothing. */
// `master` is required for the same reason fitEditToOnePage's `rules` is: the batch must hit the content rules its saves will.
export function preflightBatch<A>(current: ResolvedResume, actions: readonly A[], step: EditStep<A>, jdKeywords: readonly string[], master: MasterProfile): string | null {
  // The resume as it would stand after each save.
  let resume = current;
  // Each op in order, as the real loop applies them.
  for (const action of actions) {
    // The edit itself.
    const edited = step(resume, action);
    // A refused edit saves nothing, so the resume is unchanged for the next op.
    if (!edited.ok) continue;
    // The fit its save would run.
    // Judged against the resume this op starts from, exactly as its real save compares with the stored row.
    const fitted = fitEditToOnePage(edited.resume, jdKeywords, { previous: resume, master });
    // This op would be refused (floors or content rules): the whole batch is held back, with the reason.
    if (!fitted.ok) return fitted.reason;
    // What would be stored before the next op.
    resume = fitted.resume;
  }
  // Every op would save on one page.
  return null;
}
