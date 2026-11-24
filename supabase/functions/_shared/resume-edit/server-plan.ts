// THE SERVER'S PLAN FOR ONE CHAT ANSWER (S9i P2, 2026-11-21).
//
// WHY IT EXISTS: Teja 15:34, "every edit he prompts in the resume chat is applied and done … NO Apply button". The
// browser applied each card by click (or auto) and its batch save was ALL OR NONE (planBatch). Server-side, one bad op
// must not sink the rest the owner asked for, so this folds the actions ONE BY ONE, keeps each that the engine accepts,
// names each it refuses, and then checks the END STATE once (one page, floors, content rules: fitEditToOnePage). The
// end-state checks still refuse (the ruling keeps them); the reply then says what did not land and why.
//
// Policy kept from the browser (master-or-dictated): an edit whose words the master bullet cannot ground (the auditor's
// own bulletGroundingGaps) is NOT applied; it comes back as a suggestion, text the owner can ask for by name.
//
// PURE: the DB read and write live in resume-assist; this file only decides.

// Resume and master shapes.
import type { MasterProfile, ResolvedResume } from '../contracts/shared-types.ts';
// The engine's edits, each a pure function of the resume.
import {
  applyTextEdit, removeBullet, removeSkill, moveBullet, moveSection, moveBulletTo, moveSectionTo, moveEntryTo, moveSkillTo,
  addMasterBullet, addMasterEntry, removeEntry, setEntryRole, type EditOutcome,
} from './tailored-edits.ts';
// The one-page fit and content rules, the same call the browser's save runs.
import { fitEditToOnePage } from './page-fit-edit.ts';
// The auditor's grounding check (rule 5) and its tokeniser, the same ones the browser's auditAdvice calls.
import { bulletGroundingGaps, tokenizeText } from '../audit/detector.ts';
// The resolved action shapes.
import type { ServerAction } from './resolve-ops.ts';
// The closed event-kind union and the fit's trim record, so a step can only name a kind the save knows.
import type { EditEventKind } from './save-tailored-edit.ts';
// Same.
import type { TrimItem } from '../tailor/page-trim.ts';

// The actions this planner folds: everything except the two that also write the master (they run on their own).
export type PureServerAction = Exclude<ServerAction, { readonly kind: 'attest_skill' } | { readonly kind: 'attest_bullet' }>;

/* S45 (Teja 2026-11-24 13:42, "very shit reply"): WHAT a skill outcome was about, so the reply can say "Removed: LightGBM,
   XGBoost (you typed 'cgboost')" and "Added to Tools: YAML Flows" instead of "[Applied: Remove skill; Remove skill]".
   `name` is the printed (or master) name; `typed` only when the ask spelled it differently beyond case and spaces;
   `group` is where an added skill landed. Optional on every outcome, so an older reader ignores it. */
export type OutcomeSubject = { readonly verb: 'removed' | 'added'; readonly name: string; readonly group?: string; readonly typed?: string };

// What happened to one action.
export type ServerOutcome =
  // Landed on the resume.
  | { readonly status: 'applied'; readonly label: string; readonly subject?: OutcomeSubject }
  // A check refused it; the reason is the engine's or the end-state check's own sentence.
  | { readonly status: 'refused'; readonly label: string; readonly why: string; readonly subject?: OutcomeSubject }
  // Not applied by policy (ungrounded wording); offered as text instead.
  | { readonly status: 'suggested'; readonly label: string; readonly why: string; readonly subject?: OutcomeSubject };

// The subject a skill action carries, or undefined for every other kind (S45). Shared by the planner and server-apply.
export function subjectOf(action: ServerAction): OutcomeSubject | undefined {
  // A removal names the printed skill, plus the typed spelling when it differed.
  if (action.kind === 'remove_skill') return { verb: 'removed', name: action.name, ...(action.typed !== undefined ? { typed: action.typed } : {}) };
  // An add names the skill and the group it is filed under (the parser already chose the master's group for a master skill).
  if (action.kind === 'attest_skill') return { verb: 'added', name: action.keyword, group: action.category };
  // Nothing to name beyond the label.
  return undefined;
}

// The subject spread into an outcome only when there is one, so an outcome never carries `subject: undefined`.
const withSubject = (subject: OutcomeSubject | undefined): { readonly subject?: OutcomeSubject } => (subject === undefined ? {} : { subject });

// One applied step, for the history event (the browser's batch detail shape).
export interface ServerStep {
  // The event kind (resume_edit, resume_move_entry, ...).
  readonly kind: EditEventKind;
  // The node it touched.
  readonly ref: string;
  // The engine's before/after strings.
  readonly before: string | null;
  // After.
  readonly after: string | null;
}

// The plan: the resume to save (null when nothing landed or the end state was refused), each action's outcome, the steps.
export interface ServerPlan {
  // Save exactly this, or nothing.
  readonly resume: ResolvedResume | null;
  // In the answer's order.
  readonly outcomes: readonly ServerOutcome[];
  // Applied steps, for the event.
  readonly steps: readonly ServerStep[];
  // What the one-page fit trimmed, for the event.
  readonly trimmed: readonly TrimItem[];
  // The fit's on-screen notice, if any.
  readonly notice: string | null;
}

// The event kind per action kind: the browser's EVENT_KIND names (ApprovalQueuePage), plus the S9j place moves.
const EVENT_KIND: Readonly<Record<PureServerAction['kind'], EditEventKind>> = {
  // Text.
  edit: 'resume_edit',
  // Bullet off.
  remove: 'resume_remove',
  // Skill off.
  remove_skill: 'resume_remove_skill',
  // Bullet step.
  move_bullet: 'resume_move_bullet',
  // Section step.
  move_section: 'resume_move_section',
  // S9j bullet place: still a bullet move.
  move_bullet_to: 'resume_move_bullet',
  // S9j section place: still a section move.
  move_section_to: 'resume_move_section',
  // S9j entry place: a new kind of move.
  move_entry_to: 'resume_move_entry',
  // 2026-11-23 skill place within its group: a new kind of move, as move_entry was.
  move_skill_to: 'resume_move_skill',
  // Master bullet back.
  add_master_bullet: 'resume_add_bullet',
  // Master entry back.
  add_master_entry: 'resume_add_entry',
  // Entry off.
  remove_entry: 'resume_remove_entry',
  // Title.
  set_role: 'resume_set_role',
};

// The node an action names, for the event (the browser's eventRef).
function refOf(action: PureServerAction): string {
  // Text edits and removals name their target.
  if (action.kind === 'edit' || action.kind === 'remove') return action.target.kind === 'bullet' ? action.target.ref : 'summary';
  // Section moves name the section.
  if (action.kind === 'move_section' || action.kind === 'move_section_to') return action.section;
  // Everything else carries a ref.
  return action.ref;
}

// One action on the resume, by the engine (the browser's pureEdit dispatcher, plus the S9j place moves).
function applyOne(action: PureServerAction, current: ResolvedResume, full: ResolvedResume): EditOutcome {
  // One engine call per kind.
  switch (action.kind) {
    // Text.
    case 'edit': return applyTextEdit(current, action.target, action.text);
    // Only a bullet can be removed this way.
    case 'remove': return action.target.kind === 'bullet' ? removeBullet(current, action.target) : { ok: false, reason: 'The summary can be edited, not removed.' };
    // Skill off.
    case 'remove_skill': return removeSkill(current, action.ref);
    // Bullet step.
    case 'move_bullet': return moveBullet(current, action.ref, action.direction);
    // Section step.
    case 'move_section': return moveSection(current, action.section, action.direction);
    // S9j places.
    case 'move_bullet_to': return moveBulletTo(current, action.ref, action.place);
    // S9j.
    case 'move_section_to': return moveSectionTo(current, action.section, action.place);
    // S9j.
    case 'move_entry_to': return moveEntryTo(current, action.section, action.ref, action.place);
    // 2026-11-23.
    case 'move_skill_to': return moveSkillTo(current, action.ref, action.place);
    // Master bullet back, from FULL.
    case 'add_master_bullet': return addMasterBullet(current, full, action.ref);
    // Master entry back, from FULL.
    case 'add_master_entry': return addMasterEntry(current, full, action.section, action.ref);
    // Entry off.
    case 'remove_entry': return removeEntry(current, action.section, action.ref);
    // Title.
    case 'set_role': return setEntryRole(current, action.ref, action.role);
  }
}

// The master text a bullet rewords, found by ref anywhere on the resume (refs are unique), or null.
function masterTextOf(resume: ResolvedResume, ref: string): string | null {
  // The five bullet-bearing sections.
  for (const section of ['experience', 'projects', 'education', 'achievements', 'certifications'] as const) {
    // Each entry's bullets.
    for (const entry of (resume[section] as readonly { readonly bullets: readonly { readonly ref: string; readonly master_text: string }[] }[] | undefined) ?? []) {
      // The bullet by ref.
      const bullet = entry.bullets.find((candidate) => candidate.ref === ref);
      // Found.
      if (bullet !== undefined) return bullet.master_text;
    }
  }
  // Not on the resume.
  return null;
}

/* Why an edit may not land by itself, or null when its words are grounded. The summary is grounded against the
   master's own summary text; a bullet against its master bullet. Fails closed: no master text, or a throw, is a
   reason, never a pass (CLAUDE.md §6). */
function ungrounded(action: PureServerAction, current: ResolvedResume, master: MasterProfile, skillTokens: ReadonlySet<string>): string | null {
  // Only text edits carry new words.
  if (action.kind !== 'edit') return null;
  // The text it must be faithful to.
  const source = action.target.kind === 'summary' ? (master.summary?.text ?? null) : action.target.kind === 'bullet' ? masterTextOf(current, action.target.ref) : null;
  // Nothing to compare with.
  if (source === null) return 'There is no master text to check this wording against.';
  // The auditor's verdict.
  try {
    // Numbers and terms the master text lacks.
    const gaps = bulletGroundingGaps(action.text, source, skillTokens);
    // Every word grounded.
    if (gaps.metrics.length === 0 && gaps.terms.length === 0) return null;
    // Named, so the owner can dictate it if it is true.
    return `It uses ${[...new Set([...gaps.metrics, ...gaps.terms])].slice(0, 5).join(', ')}, which your master does not state. Say it in your own words to add it.`;
  } catch {
    // Unknown is not grounded.
    return 'The audit could not check this wording.';
  }
}

/* The plan for one answer's resume-only actions, folded on `current` in order. */
export function planServerEdits(input: {
  // The resume as stored now.
  readonly current: ResolvedResume;
  // The pinned master.
  readonly master: MasterProfile;
  // FULL, the master resolved at the pin (what add_back copies from).
  readonly full: ResolvedResume;
  // The JD keywords the fit protects.
  readonly jdKeywords: readonly string[];
  // The actions with their card labels, in answer order.
  readonly actions: readonly { readonly action: PureServerAction; readonly label: string }[];
}): ServerPlan {
  // The auditor's skill tokens: every master skill name, tokenised the auditor's way.
  const skillTokens = new Set(tokenizeText(input.master.skills.map((skill) => skill.name).join(', ')));
  // The resume as the fold leaves it.
  let resume = input.current;
  // Each action's outcome, in order.
  const outcomes: ServerOutcome[] = [];
  // Each applied step.
  const steps: ServerStep[] = [];
  // One action at a time.
  for (const { action, label } of input.actions) {
    // S45: what the reply names this action by, if it is a skill change.
    const subject = withSubject(subjectOf(action));
    // Policy first: ungrounded words are a suggestion, never applied.
    const why = ungrounded(action, resume, input.master, skillTokens);
    // Offered as text.
    if (why !== null) { outcomes.push({ status: 'suggested', label, why, ...subject }); continue; }
    // The engine on the resume as it stands now.
    const result = applyOne(action, resume, input.full);
    // Refused by its own check: named, and the fold goes on without it.
    if (!result.ok) { outcomes.push({ status: 'refused', label, why: result.reason, ...subject }); continue; }
    // Kept.
    resume = result.resume;
    // Recorded.
    outcomes.push({ status: 'applied', label, ...subject });
    // For the event.
    steps.push({ kind: EVENT_KIND[action.kind], ref: refOf(action), before: result.before, after: result.after });
  }
  // Nothing landed: nothing to save.
  if (steps.length === 0) return { resume: null, outcomes, steps, trimmed: [], notice: null };
  // The END STATE checked once, as the browser's batch save does (one page, floors, content rules).
  const fitted = fitEditToOnePage(resume, input.jdKeywords, { previous: input.current, master: input.master });
  // Refused: every applied action is refused with the end-state reason, so the reply names it.
  // The subject rides along (S45), so "Could not do: Remove skill "X"" still knows which skill it was.
  if (!fitted.ok) return { resume: null, outcomes: outcomes.map((o) => (o.status === 'applied' ? { status: 'refused', label: o.label, why: fitted.reason, ...withSubject(o.subject) } : o)), steps: [], trimmed: [], notice: null };
  // The plan to save.
  return { resume: fitted.resume, outcomes, steps, trimmed: fitted.trimmed, notice: fitted.notice };
}

/* S9i P2: what the server did, as one line the owner reads and the model reads back as history (the browser's
   outcomeNote wording, so a reply reads the same whichever side applied it). Bracketed: the app's record, not the AI's. */
export function outcomeText(outcomes: readonly ServerOutcome[]): string {
  // Landed.
  const applied = outcomes.filter((o) => o.status === "applied").map((o) => o.label);
  // Refused, with why.
  const refused = outcomes.flatMap((o) => (o.status === "refused" ? [`${o.label} (${o.why})`] : []));
  // Offered as text, with why.
  const suggested = outcomes.flatMap((o) => (o.status === "suggested" ? [`${o.label} (${o.why})`] : []));
  // Only the non-empty groups, in that order.
  const groups = [applied.length > 0 ? `Applied: ${applied.join("; ")}` : null, refused.length > 0 ? `Could not do: ${refused.join("; ")}` : null, suggested.length > 0 ? `Suggested, not applied: ${suggested.join("; ")}` : null].filter((g): g is string => g !== null);
  // Nothing to say.
  return groups.length === 0 ? "" : `[${groups.join(" | ")}]`;
}

/* S45 + S9k item 2 (Teja 2026-11-24 13:42, "very shit reply"): the chat reply the owner reads, in plain sentences.
   "[Applied: Remove skill; Remove skill; …] Proposed 4 changes. See the list below." becomes "Done. Removed: LightGBM,
   XGBoost (you typed 'cgboost'). Added to Tools: YAML Flows. <note> Resume still fits one page."
   ALWAYS starts with exactly "Done." or "Nothing changed.": the web's isServerRecord recognises a stored reply by that
   first word, so no branch below may put anything in front of it. */
export function replyText(outcomes: readonly ServerOutcome[], note: string): string {
  // The outcomes that landed.
  const applied = outcomes.filter((o) => o.status === 'applied');
  // The sentences, in the contract's order.
  const sentences: string[] = [applied.length > 0 ? 'Done.' : 'Nothing changed.'];
  // Applied removals, each by its printed name, the typed spelling echoed when it differed (op order kept).
  const removed = applied.flatMap((o) => (o.subject?.verb === 'removed' ? [o.subject.typed === undefined ? o.subject.name : `${o.subject.name} (you typed '${o.subject.typed}')`] : []));
  // One sentence for all of them.
  if (removed.length > 0) sentences.push(`Removed: ${removed.join(', ')}.`);
  // Applied adds by the group they landed in, groups in first-seen order ('' = no group known).
  const added = new Map<string, string[]>();
  // Each add into its group's list.
  for (const o of applied) if (o.subject?.verb === 'added') added.set(o.subject.group ?? '', [...(added.get(o.subject.group ?? '') ?? []), o.subject.name]);
  // One sentence per group, naming the group so a skill filed somewhere unexpected is visible.
  for (const [group, names] of added) sentences.push(`${group === '' ? 'Added' : `Added to ${group}`}: ${names.join(', ')}.`);
  // Applied outcomes with no subject (moves, edits, titles): their labels.
  const other = applied.filter((o) => o.subject === undefined).map((o) => o.label);
  // One sentence.
  if (other.length > 0) sentences.push(`Also: ${other.join('; ')}.`);
  // Refused, each with its reason.
  const refused = outcomes.flatMap((o) => (o.status === 'refused' ? [`${o.label} (${o.why})`] : []));
  // One sentence.
  if (refused.length > 0) sentences.push(`Could not do: ${refused.join('; ')}.`);
  // Held back as text, each with its reason.
  const suggested = outcomes.flatMap((o) => (o.status === 'suggested' ? [`${o.label} (${o.why})`] : []));
  // One sentence.
  if (suggested.length > 0) sentences.push(`Suggested, not applied: ${suggested.join('; ')}.`);
  // The AI's honest note plus the shortfall sentences, when there is one.
  if (note.trim() !== '') sentences.push(note.trim());
  /* True by construction: an outcome is 'applied' only after the end-state one-page fit accepted it (planServerEdits
     turns every applied into refused when fitEditToOnePage fails; attestSkill and attestBullet fit before they write). */
  if (applied.length > 0) sentences.push('Resume still fits one page.');
  // One line; the caller caps it at the table's 2000 characters.
  return sentences.join(' ');
}
