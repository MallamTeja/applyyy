/* The one-page rule, live in the approval editor (Teja, 2026-11-07 23:18 IST: "they need to be
   handled live while adding new skills and all, but not by AI").

   Every edit's new resume passes through here BEFORE it is saved, and what is saved is what comes
   out: one page, by the same pure trimmer the tailor uses (supabase/functions/_shared/tailor/
   page-trim.ts), so a live edit and a fresh tailoring can never trim by different rules. The
   typography step is not chosen here: renderResumeHtml picks it on every render, so the preview
   already shows the smaller type when one is needed. This module only removes content when even
   the smallest type overflows, and refuses when the floors themselves overflow.

   Pure: no React, no network, no Supabase. The page wires it; the tests drive it directly. */
// The same trimmer as the tailor, by relative path (the rowPipeline.ts precedent): one rule, one file.
import { fitToOnePage, type TrimItem } from '../../../../../supabase/functions/_shared/tailor/page-trim.ts';
// The resume type, from the web's own contract module.
import type { ResolvedResume } from '../../data/contract';

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
   never saved (CLAUDE.md section 6: unmeasurable is not "fits"). */
export function fitEditToOnePage(next: ResolvedResume, jdKeywords: readonly string[]): PageFitEdit {
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
export function preflightBatch<A>(current: ResolvedResume, actions: readonly A[], step: EditStep<A>, jdKeywords: readonly string[]): string | null {
  // The resume as it would stand after each save.
  let resume = current;
  // Each op in order, as the real loop applies them.
  for (const action of actions) {
    // The edit itself.
    const edited = step(resume, action);
    // A refused edit saves nothing, so the resume is unchanged for the next op.
    if (!edited.ok) continue;
    // The fit its save would run.
    const fitted = fitEditToOnePage(edited.resume, jdKeywords);
    // This op would be refused on the floors: the whole batch is held back, with the reason.
    if (!fitted.ok) return fitted.reason;
    // What would be stored before the next op.
    resume = fitted.resume;
  }
  // Every op would save on one page.
  return null;
}
