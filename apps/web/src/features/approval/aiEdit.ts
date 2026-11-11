/* THE AI EDIT CONTRACT on the browser side (2026-10-31): what the review page sends to the
 * `resume-assist` edge function, how its answer is read, and how each proposed op becomes one
 * of the page's own EditActions.
 *
 * WHY THE AI ANSWERS IN EditActions AND NEVER IN RESUMES. Every edit on this page already
 * crosses one guarded write (saveTailoredEdit: shape check, R0' tracesToMaster check, status and
 * stamp guards, an append-only event). Mapping the AI's ops onto the SAME actions a click makes
 * means the AI gets no new write path at all: it can only suggest what the operator could have
 * typed, and only the operator's Apply click sends it.
 *
 * WHY SHORT IDS. Bullets go out as "b0", "b1"... and the ref behind each id stays in the
 * browser. Refs are long and cost tokens on every call, and a model that never sees a ref cannot
 * invent one: an id it was not given is simply not in the map.
 *
 * STRUCTURE EDITS (2026-11-01, docs/ui/2026-11-01-review-structure-edits-contract.md). When the page
 * passes an AssistStructure, the AI also sees the section order, each entry labelled once ("e0"),
 * which entry every bullet sits under, and a capped list of master items NOT on the resume ("m0"
 * bullets, "n0" entries). It can then move a bullet or a section one place, add a master item back,
 * or write a new bullet. Each maps onto the page's own structural EditAction, so again no new write
 * path: tracesToMaster checks every one at the save boundary. Without a structure the body is
 * exactly what it was before, so the page can ship this before it computes one.
 *
 * AN HONEST CHAT WITH FULL READ/WRITE (2026-11-04). Teja: "the changes I requested, the AI said it
 * applied, but they were not applied". The live table agreed: 20 of 25 replies carried no ops, and
 * several still said "I have added C". The reply is model prose written BEFORE the server drops
 * invalid ops, so it can never be the record of what happened. Three changes:
 *   1. Nothing is dropped silently any more. An op that cannot land (refused by the server, or
 *      unresolvable here) becomes a `rejected` StoredOp with what was asked and why it could not be
 *      done, shown as its own card. resolveOps returns one StoredOp per op, never a null.
 *   2. What the chat remembers as done comes from the resume (outcomeNote, from isApplied), and is
 *      what the model reads about its own earlier turns, so it cannot believe a change it only claimed.
 *   3. The AI reads the posting (location, arrangement, the JD as plain text) and every printed
 *      skill with its group, and can remove a skill or a whole entry: both through the save path's
 *      existing remove_skill / remove_entry actions, so still no new write path.
 *
 * Pure apart from the injected client, so node --test drives it with a fake. */

// Types only: the diff the page renders, the printed-skill record its skills line carries, and the
// action vocabulary the save path understands.
import type { PrintedSkill, ResumeDiff } from './diffModel';
// Type-only import from the view: the action union is declared there, beside the controls.
import type { EditAction } from './DiffView';
// Type only (T10): the save result a batch run reads, the same union every page save answers.
import type { EditResult } from './DiffView';
/* Types only from the core edits: section names, directions, and the shape of a master item not on
   the resume. Type-only so this file never runs W1's code, only compiles against its names. */
import type { AddableBullet, AddableEntry, BulletSection, MoveDirection, SectionKind } from './tailoredEdits';
/* The auditor's own rule 5 and tokenizer, imported by relative path (as diffAdapter.ts imports
   jd-keywords) so the advice shown before Apply is the audit's definition, never a copy. */
import { bulletGroundingGaps, tokenizeText } from '../../../../../supabase/functions/_shared/audit/detector.ts';
/* The closed list of section names, shared with the tailor's schema and the edge function, so a
   stored op naming a section is checked against the same seven words everywhere. */
import { TAILOR_SECTION_KINDS } from '../../../../../supabase/functions/_shared/tailor/prompt.ts';
/* The tailor's own keyword matcher (page-trim.ts ranks bullets with it), so "most job-relevant" here
   means exactly what it means when the page fit decides which bullet to cut. Never a copy. */
import { keywordAppearsIn } from '../../../../../supabase/functions/_shared/tailor/jd-keywords.ts';
// T10: the content rules' entry counts, so a swap pairs only where a rule caps the count (one home for the number).
import { PAGE_FIT_FLOORS } from '../../../../../supabase/functions/_shared/tailor/page-trim.ts';
/* The one edge call that refreshes once and retries once on a revoked session (2026-11-07), so the chat
   never shows the raw `invalid_session` code. */
import { invokeEdge } from '../../data/edgeCall.ts';
// Its client shape; the ask's own client type is this one.
import type { EdgeClient } from '../../data/edgeCall.ts';

/* The body the edge function validates (resume-assist/assist.ts parseAssistRequest). */
export interface AssistBody {
  // The operator's words.
  readonly instruction: string;
  /* The job: what steers wording, plus (2026-11-04) what answers questions about the role. The
     three extras are sent only when the posting has them, so an old body stays byte-identical. */
  readonly job: {
    // The posting's title.
    readonly title: string;
    // The hiring company.
    readonly company: string;
    // JD keywords the resume does not yet match.
    readonly missing: readonly string[];
    // Where the role is, the locations joined: "is this remote?" had no answer without it.
    readonly location?: string;
    // onsite | hybrid | remote | unknown, as the scout stored it.
    readonly arrangement?: string;
    // The posting as plain text, cut to the function's cap; the AI said "I cannot see the JD" before.
    readonly description?: string;
  };
  // The current summary, or null.
  readonly summary: string | null;
  // Current bullet text under short ids, with the short id of its entry when a structure was given.
  readonly bullets: readonly { readonly id: string; readonly text: string; readonly entry?: string }[];
  // The printed skills line.
  readonly skills: string;
  // The master's skill groups.
  readonly categories: readonly string[];
  // Every printed skill with its group (2026-11-04); sent only when the skills line carries them.
  readonly printedSkills?: readonly { readonly name: string; readonly category: string }[];
  // The owner's master skills NOT printed, each with its master group (2026-11-05); sent only when any.
  readonly availableSkills?: readonly { readonly name: string; readonly category: string }[];
  // Earlier messages of the active chat, oldest first (chat memory, 2026-11-01).
  readonly history: readonly ChatTurn[];
  // STRUCTURE (2026-11-01); the three fields below are sent only when the page passed a structure.
  // The printed section order.
  readonly sections?: readonly SectionKind[];
  // The entries on the resume, each labelled once.
  readonly entries?: readonly { readonly id: string; readonly section: BulletSection; readonly label: string }[];
  // Master items not on the resume: a bullet under an entry above, or a whole entry.
  readonly available?: readonly ({ readonly id: string; readonly entry: string; readonly text: string } | { readonly id: string; readonly section: BulletSection; readonly label: string })[];
}

/* One entry on the current resume, as the page describes it (see AssistStructure). */
export interface AssistEntry {
  // Which section it is in.
  readonly section: BulletSection;
  // Its master node ref.
  readonly ref: string;
  // tailoredEdits.entryLabel(section, entry), e.g. "Aczen Technologies · Full Stack AI Engineer".
  readonly label: string;
  // Its bullets' refs in printed order: the siblings a move swaps among.
  readonly bulletRefs: readonly string[];
}

/* What the page passes so the AI can make structural edits. Built from the CURRENT resume on every
   render, so it is also the record isApplied reads a structural op against:
     sections: current.section_order
     entries:  every entry of every bullet section, in printed order, as an AssistEntry
     addable:  tailoredEdits.addableFromMaster(current, full), as returned */
export interface AssistStructure {
  // The printed section order.
  readonly sections: readonly SectionKind[];
  // Every entry on the resume.
  readonly entries: readonly AssistEntry[];
  // Master items not on the resume.
  readonly addable: { readonly bullets: readonly AddableBullet[]; readonly entries: readonly AddableEntry[] };
}

/* One earlier message, as the edge function takes it: who said it and what. */
export interface ChatTurn {
  // The operator or the AI.
  readonly role: 'user' | 'assistant';
  // The instruction, or the AI's note.
  readonly text: string;
}

/* One proposed change, as the edge function returns it (a closed union, checked on read). */
export type AssistOp =
  // New text for a bullet id or "summary"; `newNumbers` are digits the old text did not have.
  | { readonly op: 'edit'; readonly id: string; readonly text: string; readonly newNumbers: readonly string[] }
  // Drop a bullet.
  | { readonly op: 'remove'; readonly id: string }
  // Add a skill under one of the master's groups.
  | { readonly op: 'add_skill'; readonly name: string; readonly category: string }
  // A bullet one place up or down within its entry.
  | { readonly op: 'move'; readonly id: string; readonly direction: MoveDirection }
  // A section one place up or down; a name from the sent order, checked again on resolve.
  | { readonly op: 'move_section'; readonly section: string; readonly direction: MoveDirection }
  // A master item back onto the resume, by its "mN" or "nN" id.
  | { readonly op: 'add_back'; readonly id: string }
  // New bullet text under an entry, by its "eN" id.
  | { readonly op: 'new_bullet'; readonly entry: string; readonly text: string }
  // A printed skill off the resume, by its printed name (2026-11-04).
  | { readonly op: 'remove_skill'; readonly name: string; readonly category?: string }
  // A whole entry off the resume, by its "eN" id (2026-11-04).
  | { readonly op: 'remove_entry'; readonly id: string }
  // A job's title, by its "eN" id, set to the owner's dictated wording (2026-11-11).
  | { readonly op: 'set_role'; readonly entry: string; readonly text: string };

/* One change the AI proposed that cannot land, said in words (2026-11-04): what was asked, and the
   one check it failed. Shown as its own card, so a refusal is never hidden behind the AI's text. */
export interface Rejection {
  // The change as proposed, e.g. 'Add skill "C"'.
  readonly what: string;
  // Why it was not made, one sentence.
  readonly why: string;
}

/* Billed token counts for one ask; null where Google did not report a number. */
export interface AssistUsage {
  // Input tokens, cached ones included.
  readonly input: number | null;
  // Of those, served from the implicit cache at a discount.
  readonly cached: number | null;
  // Visible output.
  readonly output: number | null;
  // Thinking, billed as output.
  readonly thinking: number | null;
}

/* The answer, read into a closed union; an unreadable answer is an error, never "no changes". */
export type AssistResult =
  // The validated ops, every op the server refused with its reason, the model's note and the bill.
  | { readonly kind: 'ok'; readonly ops: readonly AssistOp[]; readonly rejected: readonly Rejection[]; readonly note: string; readonly usage: AssistUsage }
  // Anything else, in words the operator can act on.
  | { readonly kind: 'error'; readonly message: string };

/* The request plus the map that turns the answer's ids back into this resume's targets. */
export interface AssistDraft {
  // What is sent.
  readonly body: AssistBody;
  // Short id -> bullet ref. "summary" is not in it; it has its own target.
  readonly refs: ReadonlyMap<string, string>;
  // Short id (and "summary") -> the text the id stood for when the ask was sent.
  readonly before: ReadonlyMap<string, string | null>;
  // Short id -> the master bullet it rewords: what the auditor compares a bullet against.
  readonly masterText: ReadonlyMap<string, string | null>;
  // Every token of every master skill name, which the auditor also allows in any bullet.
  readonly skillTokens: ReadonlySet<string>;
  // Every master skill name, lower-cased, so a card can say whether Apply also adds it to the master.
  readonly masterSkills: ReadonlySet<string>;
  // Short entry id -> the entry on the resume; new_bullet's parent. Empty without a structure.
  readonly entries: ReadonlyMap<string, AssistEntry>;
  // "mN" -> the master bullet it stands for. Empty without a structure.
  readonly availableBullets: ReadonlyMap<string, AddableBullet>;
  // "nN" -> the master entry it stands for. Empty without a structure.
  readonly availableEntries: ReadonlyMap<string, AddableEntry>;
  // The structure the ask was built from: the orders a move is resolved against. Null without one.
  readonly structure: AssistStructure | null;
  // Printed skills by lower-cased name -> every copy, in print order (a name can print under two groups).
  readonly printedSkills: ReadonlyMap<string, readonly PrintedSkill[]>;
}

/* What the audit would say about one AI edit, shown BEFORE Apply. Advice only (2026-10-31):
   it never blocks Apply and never changes the row's status. A closed union so "not checked"
   can never be shown as "clean". */
export type AuditAdvice =
  // Rule 5 ran: the numbers and words the master does not supply (both empty = grounded).
  | { readonly kind: 'checked'; readonly metrics: readonly string[]; readonly terms: readonly string[] }
  // The audit has no rule for this edit, said as such.
  | { readonly kind: 'not_checked'; readonly why: string };

/* The slice of supabase-js this file calls; structural, so a test passes a fake. It is the shared
   edge-call client (2026-11-07): the ask needs `auth` too, to refresh a session revoked elsewhere. */
export type AssistClient = EdgeClient;

// The edge function's own caps, mirrored so a long list is trimmed here instead of refused there.
const MAX_LIST = 40;
// Same: the longest keyword or group name the function accepts.
const MAX_ITEM = 80;
// The edge function's bullet cap (resume-assist MAX_BULLETS); mirrored so a long resume is trimmed here.
const MAX_BULLETS = 80;
// Same: the most entries the function accepts (resume-assist MAX_ENTRIES).
const MAX_ENTRIES = 40;
// Same: the most master items not on the resume (MAX_AVAILABLE). Token cost: no full master dump.
const MAX_AVAILABLE = 30;
// Same: the longest entry label (MAX_LABEL).
const MAX_LABEL = 120;
// Same: the longest AVAILABLE bullet text (MAX_AVAILABLE_TEXT). Only the model's choice reads it.
const MAX_AVAILABLE_TEXT = 200;
/* 2026-11-04, the posting and the skill groups. Same mirror-and-cut rule: the function REFUSES an
   oversize field, so everything is cut here first. The JD cap bounds the bill: ~2k tokens, sitting
   in the JOB block ahead of the chat, so repeat asks on one row reuse it from the implicit cache. */
// The posting's plain text (resume-assist MAX_DESCRIPTION).
const MAX_DESCRIPTION = 8000;
// The joined locations (MAX_LOCATION).
const MAX_LOCATION = 300;
// The arrangement word (MAX_ARRANGEMENT).
const MAX_ARRANGEMENT = 20;
// The most printed skills sent (resume-assist MAX_PRINTED_SKILLS); the function refuses more.
const MAX_PRINTED_SKILLS = 80;
// A printed skill name past this is refused there, so such a skill is left out here instead.
const MAX_SKILL_NAME = 60;
// A label in a card or the outcome line quotes at most this much of a bullet.
const MAX_QUOTE = 40;

/* A display string cut to `max` characters, never blank. The function refuses a blank or oversized
   label outright, which would refuse the whole ask over one odd master node. */
function clip(text: string, max: number, fallback: string): string {
  // One line, as the prompt prints it.
  const flat = text.replace(/\s+/g, ' ').trim();
  // Blank becomes the stated fallback, never an empty label.
  if (flat === '') return fallback;
  // Cut with an ellipsis so the model knows the text goes on.
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/* A line's printed text: its runs joined, exactly as the diff renders them. */
function lineText(runs: readonly { readonly text: string }[]): string {
  // The runs are the tailored text split by verdict; joined, they are the line.
  return runs.map((run) => run.text).join('');
}

/* Short strings only, capped; JD keywords are untrusted and can be anything. */
function shortList(items: readonly string[]): string[] {
  // Trimmed, non-empty, within the function's per-item cap, at most MAX_LIST of them.
  return items.map((item) => item.trim()).filter((item) => item !== '' && item.length <= MAX_ITEM).slice(0, MAX_LIST);
}

/* Build the compact projection the AI sees, from what the page already rendered. `structure` is
   optional: without it the body is exactly the pre-structure one, and no structural op can resolve. */
/* The structure prop, read from the diff the page already rendered (2026-11-01 integration). The
   diff's sections are the CURRENT resume's, printed ones first in print order (diffAdapter), so the
   chat sees exactly what the operator sees, from one derivation, never a second one from the
   resume that could drift. Null when the diff carries no sections (a hand-built fixture). */
export function structureFromDiff(diff: ResumeDiff): AssistStructure | null {
  // No sections: the chat keeps its pre-structure behaviour.
  if (diff.sections === undefined) return null;
  // Lines by id, so an entry's line ids resolve to its bullets.
  const lineById = new Map(diff.lines.map((line) => [line.id, line]));
  // Every entry still on the resume, with its printed bullet refs in order.
  const entries: AssistEntry[] = [];
  // Bullets offered back, each under the entry that owns it.
  const bullets: AddableBullet[] = [];
  // Whole entries offered back.
  const offeredEntries: AddableEntry[] = [];
  // Section by section, in the diff's order.
  for (const section of diff.sections) {
    // Summary and skills hold no entries; only the five bullet sections do.
    if (section.kind === 'summary' || section.kind === 'skills') continue;
    // Narrowed for the typed records below.
    const kind: BulletSection = section.kind;
    // Each entry the diff shows.
    for (const entry of section.entries) {
      // A removed entry is not on the resume, so the AI cannot target it.
      if (entry.state === 'removed') continue;
      // Its printed bullets: lines still on the resume, in the order the diff walks them.
      const bulletRefs = entry.lineIds
        // Each line id resolved.
        .map((id) => lineById.get(id))
        // Only bullet lines that are still printed.
        .filter((line) => line !== undefined && line.editState !== 'removed' && line.editTarget?.kind === 'bullet')
        // Their refs.
        .map((line) => (line!.editTarget as { readonly ref: string }).ref);
      // The entry as the AI sees it.
      entries.push({ section: kind, ref: entry.ref, label: entry.label, bulletRefs });
      // Its offered master bullets, with the owner the contract's AddableBullet names.
      for (const offer of entry.addableBullets) bullets.push({ ref: offer.ref, text: offer.text, section: kind, parentRef: entry.ref, parentLabel: entry.label });
    }
    // Whole entries this section can take back.
    for (const offer of section.addableEntries) offeredEntries.push({ ref: offer.ref, section: kind, label: offer.label });
  }
  // The printed order, as section_order spells it.
  const sections = diff.sections.filter((section) => section.printed).map((section) => section.kind as SectionKind);
  // Assembled.
  return { sections, entries, addable: { bullets, entries: offeredEntries } };
}

export function buildAssistDraft(
  diff: ResumeDiff,
  categories: readonly string[],
  instruction: string,
  history: readonly ChatTurn[] = [],
  structure: AssistStructure | null = null,
): AssistDraft {
  // Short entry id -> entry, numbered in the page's order and capped like the function.
  const entries = new Map<string, AssistEntry>((structure?.entries ?? []).slice(0, MAX_ENTRIES).map((entry, index) => [`e${index}`, entry]));
  // Bullet ref -> its entry's short id, so each bullet can be tagged as it is numbered.
  const entryOfBullet = new Map<string, string>();
  // Entry ref (scoped by section, since refs are only unique per section) -> short id, for AVAILABLE bullets.
  const entryIdOf = new Map<string, string>();
  // Both filled from the same walk.
  for (const [id, entry] of entries) {
    // The entry itself.
    entryIdOf.set(`${entry.section}:${entry.ref}`, id);
    // Each of its bullets.
    for (const ref of entry.bulletRefs) entryOfBullet.set(ref, id);
  }
  // Short id -> ref, filled as bullets are numbered.
  const refs = new Map<string, string>();
  // Short id -> text at ask time.
  const before = new Map<string, string | null>();
  // Short id -> master bullet text, for the audit advice.
  const masterText = new Map<string, string | null>();
  // Master skill tokens; empty until the skills line is read.
  let skillTokens = new Set<string>();
  // Master skill names; empty until the skills line is read.
  let masterSkills = new Set<string>();
  // The bullets sent.
  const bullets: { id: string; text: string; entry?: string }[] = [];
  // The summary, null until a summary line is found.
  let summary: string | null = null;
  // The skills line, empty until found.
  let skills = '';
  // Every printed skill with its ref and group, when the skills line carries them (2026-11-04).
  let printed: readonly PrintedSkill[] = [];
  // Master skills not printed, with their groups (2026-11-05); empty until the skills line is read.
  let availableSkills: readonly { readonly name: string; readonly category: string }[] = [];
  // Every line once, in print order.
  for (const line of diff.lines) {
    // A bullet that is still printed and can be edited: the only ones an op could target.
    if (line.kind === 'bullet' && line.editTarget?.kind === 'bullet' && line.editState !== 'removed') {
      /* The edge function refuses more than MAX_BULLETS (assist.ts): past that the AI sees no more
         bullets, rather than the whole ask failing on a long resume (review finding, 2026-11-01). */
      if (bullets.length >= MAX_BULLETS) continue;
      // Numbered in print order.
      const id = `b${bullets.length}`;
      // Its current text.
      const text = lineText(line.tailoredRuns);
      // A blank bullet gives the model nothing to work with, and the function refuses it.
      if (text.trim() === '') continue;
      // Remembered so the answer maps back.
      refs.set(id, line.editTarget.ref);
      // Remembered so the panel can show before -> after.
      before.set(id, text);
      // The master bullet this one rewords (diffAdapter sets it from bullet.master_text).
      masterText.set(id, line.masterText);
      // Its entry's short id, when the page passed a structure that lists it.
      const entry = entryOfBullet.get(line.editTarget.ref);
      // Sent; the key is left out rather than set to undefined (exactOptionalPropertyTypes, and a smaller body).
      bullets.push(entry === undefined ? { id, text } : { id, text, entry });
    } else if (line.kind === 'summary') {
      // The one summary line.
      summary = lineText(line.tailoredRuns);
    } else if (line.kind === 'skills') {
      // The printed skills, comma-separated as rendered.
      skills = lineText(line.tailoredRuns);
      // This line's masterText is EVERY master skill name joined (diffAdapter.ts:424), so its
      // tokens are exactly the auditor's MasterIndex.skillTokens.
      skillTokens = new Set(tokenizeText(line.masterText ?? ''));
      // The same joined names, split back into whole names for the "already in your master" check.
      masterSkills = new Set((line.masterText ?? '').split(',').map((name) => name.trim().toLowerCase()).filter((name) => name !== ''));
      /* Within the function's caps: a name it would refuse is left out rather than failing the
         whole ask over one odd master skill (it then simply cannot be removed by name). */
      printed = (line.printedSkills ?? []).filter((skill) => skill.name.trim() !== '' && skill.name.length <= MAX_SKILL_NAME && skill.category.trim() !== '' && skill.category.length <= MAX_ITEM).slice(0, MAX_PRINTED_SKILLS);
      // Every printed name, uncapped and case-folded, so no printed skill is ever offered again.
      const printedNames = new Set((line.printedSkills ?? []).map((skill) => skill.name.trim().toLowerCase()));
      /* The master skills the resume does not print, in master order, within the same caps as printed
         ones (the function refuses the whole ask otherwise): what "add 2 tools from my master" picks from. */
      availableSkills = (line.masterSkills ?? []).filter((skill) => !printedNames.has(skill.name.trim().toLowerCase()) && skill.name.trim() !== '' && skill.name.length <= MAX_SKILL_NAME && skill.category.trim() !== '' && skill.category.length <= MAX_ITEM).slice(0, MAX_PRINTED_SKILLS);
    }
  }
  // The summary is editable under its reserved id.
  before.set('summary', summary);
  // Every keyword the resume already matches, by any route.
  const matched = new Set([...diff.coverage.honestlyMatched, ...diff.coverage.matchedByFabrication, ...diff.coverage.matchedByEdit]);
  // The keywords still missing: the useful hint, and far cheaper than the whole posting.
  const missing = shortList(diff.coverage.jdKeywords.filter((keyword) => !matched.has(keyword)));
  // Each master bullet with its entry's short id; one whose entry is not on the resume (or past the
  // entry cap) is left out, since addMasterBullet needs the parent there.
  const placeable = (structure?.addable.bullets ?? []).flatMap((bullet) => {
    // The parent's short id, if listed.
    const entry = entryIdOf.get(`${bullet.section}:${bullet.parentRef}`);
    // Kept as a pair, so the body never has to look the id up again.
    return entry === undefined ? [] : [{ bullet, entry }];
  });
  /* T10 (2026-11-10). "Add more points to <entry>" may only pull that entry's UNUSED master bullets
     (truthfulness ruling), so every printed entry must have its best ones in the list. Master order plus
     a hard slice cut a later entry's bullets off entirely and ranked nothing by the job. Now: per entry,
     most JD keywords first (the stable sort keeps master order on ties), then dealt round-robin, so each
     entry's best bullet is listed before any entry's second. */
  const byEntry = new Map<string, (typeof placeable)[number][]>();
  // Grouped in master order, so round-robin also visits entries in master order.
  for (const item of placeable) byEntry.set(item.entry, [...(byEntry.get(item.entry) ?? []), item]);
  // How many posting keywords a bullet contains: page-trim.ts's keywordScore, by the same matcher.
  const relevance = (text: string) => diff.coverage.jdKeywords.filter((keyword) => keywordAppearsIn(keyword, text)).length;
  // Each entry's queue, best first; Array.prototype.sort is stable, so ties stay in master order.
  const queues = [...byEntry.values()].map((items) => [...items].sort((a, b) => relevance(b.bullet.text) - relevance(a.bullet.text)));
  /* Whole entries keep their priority ("add my LeetCode achievement back" is the common ask), but may
     no longer starve bullets: room is held for one bullet per printed entry that has any, up to half the
     cap. A master with 30+ unprinted entries is the only case that changes, and it keeps 15 of them. */
  const reserved = Math.min(queues.length, MAX_AVAILABLE / 2);
  // "nN" -> master entry, whole entries first, within the room the reserve leaves.
  const availableEntries = new Map<string, AddableEntry>((structure?.addable.entries ?? []).slice(0, MAX_AVAILABLE - reserved).map((entry, index) => [`n${index}`, entry]));
  // The room the entries left under the function's cap (it refuses a longer list).
  const room = MAX_AVAILABLE - availableEntries.size;
  // Dealt round by round: round r takes the r-th best bullet of every entry that still has one.
  const shownBullets: (typeof placeable)[number][] = [];
  // Until the room is full or every queue is empty (a round that deals nothing ends it).
  for (let round = 0; shownBullets.length < room; round += 1) {
    // This round's bullets, one per entry, in master entry order.
    const dealt = queues.flatMap((queue) => (round < queue.length ? [queue[round]!] : []));
    // Every queue is spent.
    if (dealt.length === 0) break;
    // Only what still fits; the "mN" ids below follow this order, so they stay contiguous.
    shownBullets.push(...dealt.slice(0, room - shownBullets.length));
  }
  // "mN" -> master bullet.
  const availableBullets = new Map<string, AddableBullet>(shownBullets.map(({ bullet }, index) => [`m${index}`, bullet]));
  // Where the role is: every location the scout stored, joined, cut to the function's cap.
  const location = clip((diff.locations ?? []).join('; '), MAX_LOCATION, '');
  // How it is worked, only a short word; anything longer is not one of the scout's values.
  const arrangement = (diff.workArrangement ?? '').trim();
  /* The posting as plain text: real tags out, whitespace collapsed. Stricter than DiffView's display
     strip, whose optional ">" deletes everything after a literal "<" ("<3 years"): that loss only
     hides text on screen, but here the AI would answer from a JD cut short (review finding, 2026-11-04).
     It is untrusted ATS text: the function labels it data, every op it could induce still crosses the
     same save gate and stays visible on its card, and removals wait for a click. Cut, never refused. */
  const description = (diff.jobDescription ?? '').replace(/<\/?[a-zA-Z][^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_DESCRIPTION);
  // The body, every list capped.
  const body: AssistBody = {
    instruction: instruction.trim(),
    job: {
      title: diff.jobTitle,
      company: diff.companyName,
      missing,
      // Each extra only when present, so a posting without them sends the pre-2026-11-04 job block.
      ...(location === '' ? {} : { location }),
      // Only a real short word.
      ...(arrangement === '' || arrangement.length > MAX_ARRANGEMENT ? {} : { arrangement }),
      // Only when the posting has text.
      ...(description === '' ? {} : { description }),
    },
    summary,
    bullets,
    skills,
    categories: shortList(categories),
    // Name and group only; the ref stays in the browser, like every other ref.
    ...(printed.length === 0 ? {} : { printedSkills: printed.map((skill) => ({ name: skill.name, category: skill.category })) }),
    // Only when any, so a resume printing every master skill sends the pre-2026-11-05 body.
    ...(availableSkills.length === 0 ? {} : { availableSkills }),
    // The caller (resumeChat.historyFor) already windowed and trimmed it to the function's caps.
    history,
    // The structure, only when the page passed one, so an old body stays byte-identical.
    ...(structure === null
      ? {}
      : {
          // The printed order, as section_order spells it.
          sections: structure.sections,
          // Each entry once, its label cut to the function's cap.
          entries: [...entries].map(([id, entry]) => ({ id, section: entry.section, label: clip(entry.label, MAX_LABEL, entry.section) })),
          // Entries first, then bullets; each bullet names its entry by short id, never by ref.
          available: [
            // A whole entry: section and label.
            ...[...availableEntries].map(([id, entry]) => ({ id, section: entry.section, label: clip(entry.label, MAX_LABEL, entry.section) })),
            // A bullet: its entry's id and its text, cut; numbered exactly as availableBullets.
            ...shownBullets.map(({ bullet, entry }, index) => ({ id: `m${index}`, entry, text: clip(bullet.text, MAX_AVAILABLE_TEXT, '(no text)') })),
          ],
        }),
  };
  // Printed skills by lower-cased name, every copy kept in print order: remove_skill picks one by group.
  const printedSkills = new Map<string, PrintedSkill[]>();
  // Grouped by name.
  for (const skill of printed) printedSkills.set(skill.name.trim().toLowerCase(), [...(printedSkills.get(skill.name.trim().toLowerCase()) ?? []), skill]);
  // Sent with the maps the answer and the audit advice need.
  return { body, refs, before, masterText, skillTokens, masterSkills, entries, availableBullets, availableEntries, structure, printedSkills };
}

/* The audit's verdict on one AI op, or null for an op that changes no wording. */
export function auditAdvice(op: AssistOp, draft: AssistDraft): AuditAdvice | null {
  // A removal or a skill changes no bullet wording; skills are checked by the attest path instead.
  if (op.op !== 'edit') return null;
  /* The auditor checks only the summary's source refs, never its wording, so no verdict is given;
     the server's "numbers new versus the current text" list is the one signal left, so it is shown. */
  if (op.id === 'summary') {
    // Said only when there are any.
    const numbers = op.newNumbers.length > 0 ? ` New numbers: ${op.newNumbers.join(', ')}.` : '';
    // Not a pass: the audit has no rule here.
    return { kind: 'not_checked', why: `The audit does not check summary wording.${numbers}` };
  }
  // The master bullet this one rewords.
  const master = draft.masterText.get(op.id);
  // No master text means no comparison; never reported as clean.
  if (master === undefined || master === null) return { kind: 'not_checked', why: 'No master bullet to compare against.' };
  /* Rule 5, the auditor's own function. Since 2026-11-04 its verdict also decides whether the edit
     applies without a click (shouldAutoApply), so it FAILS CLOSED: a throw or an answer of the wrong
     shape is "not checked", which holds the edit, never a clean pass. */
  let gaps: unknown;
  // The call itself may throw on input it was never written for.
  try {
    // The auditor's own verdict on this wording against its master bullet.
    gaps = bulletGroundingGaps(op.text, master, draft.skillTokens);
  } catch {
    // Unknown is not grounded.
    return { kind: 'not_checked', why: 'The audit could not run on this edit.' };
  }
  // Two lists of strings, or the verdict is unreadable (CLAUDE.md section 6: validate the shape).
  if (!isRecord(gaps) || !isStringList(gaps.metrics) || !isStringList(gaps.terms)) return { kind: 'not_checked', why: 'The audit gave an unreadable answer for this edit.' };
  // Each word once: the auditor's list keeps repeats, which only add noise on a card.
  return { kind: 'checked', metrics: [...new Set(gaps.metrics)], terms: [...new Set(gaps.terms)] };
}

/* True for an array holding only strings. */
function isStringList(value: unknown): value is readonly string[] {
  // Every entry checked; one non-string makes the list unreadable.
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

/* Rule 5 found nothing the master lacks (2026-11-04): the ONLY advice that lets an edit apply
   without a click. Read defensively, because stored rows and old answers reach it too. */
function isGrounded(advice: AuditAdvice | null): boolean {
  // Checked, both lists real and empty; anything else (null, not_checked, a drifted shape) is not.
  return advice !== null && advice.kind === 'checked' && isStringList(advice.metrics) && isStringList(advice.terms) && advice.metrics.length === 0 && advice.terms.length === 0;
}

/* Why a card waits for the operator's click, when the reason is not already on the card; null when it
   applies by itself or its body already says why (a new bullet, a skill the master lacks). */
export function holdReason(op: StoredOp): string | null {
  // A text edit the audit did not pass.
  if (op.op === 'edit' && !isGrounded(op.advice)) {
    // Checked and flagged: the flags are listed above this line.
    return op.advice?.kind === 'checked'
      ? 'Waiting for your click: the audit found words or numbers your master profile does not have.'
      : 'Waiting for your click: the audit cannot check this edit, so it never applies by itself.';
  }
  // A whole entry off: always the operator's call.
  if (op.op === 'remove_entry') return 'Waiting for your click: removing a whole entry always needs your OK.';
  // A job title is a claim an employer can verify: always the owner's click (2026-11-11).
  if (op.op === 'set_role') return 'Waiting for your click: a job title change always needs your OK.';
  /* A skill new to the master (2026-11-05): said, because a skill the operator named used to apply by
     itself, and a card that now waits would otherwise read as "did nothing". */
  if (op.op === 'add_skill' && !op.inMaster) return 'Waiting for your click: check its group first. A skill new to your master profile never applies by itself.';
  // Nothing to add.
  return null;
}

/* A proposed edit as the chat STORES it (2026-11-01): short ids resolved to this resume's real
   targets at answer time, because "b2" means a different bullet on the next ask. Everything a card
   needs after a reload is in it; whether it was applied is derived from the resume (isApplied). */
export type StoredOp =
  // New text for the summary or one bullet, with the text it replaced and the audit's advice.
  | {
      readonly op: 'edit';
      readonly target: { readonly kind: 'summary' } | { readonly kind: 'bullet'; readonly ref: string };
      readonly before: string | null;
      readonly text: string;
      readonly advice: AuditAdvice | null;
    }
  // One bullet dropped, with the text it had.
  | { readonly op: 'remove'; readonly ref: string; readonly before: string | null }
  // A skill, and whether the master already had it when proposed.
  | { readonly op: 'add_skill'; readonly name: string; readonly category: string; readonly inMaster: boolean }
  /* A bullet one place up or down. `past` is the sibling it moves past: what makes the op's effect
     checkable later ("ref now sits above past"), since "up" alone means nothing once it is applied. */
  | { readonly op: 'move'; readonly ref: string; readonly direction: MoveDirection; readonly past: string; readonly before: string | null }
  // A section one place up or down, past the neighbouring section, for the same reason.
  | { readonly op: 'move_section'; readonly section: SectionKind; readonly direction: MoveDirection; readonly past: SectionKind }
  // A master bullet back under its entry, with its master text and the entry's label for the card.
  | { readonly op: 'add_bullet'; readonly ref: string; readonly text: string; readonly parentLabel: string }
  // A whole master entry back onto the resume.
  | { readonly op: 'add_entry'; readonly section: BulletSection; readonly ref: string; readonly label: string }
  // New bullet text under an entry; Apply writes it into the master first (attestBullet).
  | { readonly op: 'new_bullet'; readonly section: BulletSection; readonly parentRef: string; readonly parentLabel: string; readonly text: string }
  // A printed skill off the resume (2026-11-04): its master ref for the save, its name for the card.
  | { readonly op: 'remove_skill'; readonly ref: string; readonly name: string }
  // A whole entry off the resume (2026-11-04), with its label for the card.
  | { readonly op: 'remove_entry'; readonly section: BulletSection; readonly ref: string; readonly label: string }
  // A job's title (2026-11-11): the job's ref for the save, its label (old title) and the new title for the card.
  | { readonly op: 'set_role'; readonly ref: string; readonly label: string; readonly role: string }
  /* A change that cannot land (2026-11-04): refused by the server or unresolvable here. Stored like
     any card so a reloaded chat still says what was NOT done and why; it has no action at all. */
  | ({ readonly op: 'rejected' } & Rejection);

/* Every stored op that a click can apply: all but a rejected card. toEditAction takes only these, so
   an Apply button on a rejected card does not typecheck. */
export type ApplicableOp = Exclude<StoredOp, { readonly op: 'rejected' }>;

/* A display name for a section key ("projects" -> "Projects"); the keys are single lower-case words. Exported so the chat panel spells sections the same way. */
export function sectionTitle(section: string): string {
  // First letter up, rest as is.
  return section.charAt(0).toUpperCase() + section.slice(1);
}

/* A bullet quoted for a label: one line, cut, in quotes; the short id when there is no text. */
function quote(text: string | null, fallback: string): string {
  // No text to quote: the id the AI used.
  return text === null || text.trim() === '' ? fallback : `"${clip(text, MAX_QUOTE, fallback)}"`;
}

/* A rejected card. */
function reject(what: string, why: string): StoredOp {
  // The closed shape readStoredOp reads back.
  return { op: 'rejected', what, why };
}

/* Resolve an answer's ops against the ask they came from, in order: one StoredOp per op. One that
   cannot apply to this resume (an id never sent, a move already at the end) becomes a rejected card
   with its reason; until 2026-11-04 it was a null the panel filtered out, which is how a reply could
   say "added" over nothing. Replaced the one-op toStoredOp on 2026-11-01, because a move can only be
   resolved knowing the moves before it. The orders are copied and each move (and removal) is played
   on the copy, because the saves land in order: "move b3 up" twice must pass two different siblings,
   and a bullet already first cannot go up. */
export function resolveOps(ops: readonly AssistOp[], draft: AssistDraft): StoredOp[] {
  // Each entry's bullet refs, copied so the ask's structure is never changed.
  const lists = (draft.structure?.entries ?? []).map((entry) => [...entry.bulletRefs]);
  // The section order, copied the same way.
  const sections = [...(draft.structure?.sections ?? [])];
  /* What an earlier remove_entry in this answer took away (review finding, 2026-11-04): each removed
     entry as "entry:<section>:<ref>" and each of its bullets by ref. A later op on any of them would
     auto-apply against a resume that no longer holds it, fail, and stop the rest of the run. */
  const gone = new Set<string>();
  // One op at a time, against the orders as the earlier ops left them.
  return ops.map((op) => resolveOne(op, draft, lists, sections, gone));
}

// The reason every op on something an earlier remove_entry took away is refused with.
const GONE_WITH_ENTRY = 'An earlier change in this answer removes its entry.';

/* Swap list[at] with its neighbour one place `direction`; answers the neighbour, or undefined at
   either end (and for an item that is not in the list). Mutates: callers pass resolveOps' copies. */
function swapPast<T>(list: T[], item: T, direction: MoveDirection): T | undefined {
  // Where it sits now.
  const at = list.indexOf(item);
  // One place up is one index lower.
  const to = direction === 'up' ? at - 1 : at + 1;
  // The neighbour; undefined past either end.
  const past = at < 0 ? undefined : list[to];
  // Nothing to move past: the caller drops the op.
  if (past === undefined) return undefined;
  // The swap the save will make.
  list[to] = item;
  // The neighbour takes the old place.
  list[at] = past;
  // Recorded on the stored op.
  return past;
}

/* One op against the orders as played so far (see resolveOps); a rejected card, with the one check it
   failed, wherever it cannot land. */
function resolveOne(op: AssistOp, draft: AssistDraft, lists: string[][], sections: SectionKind[], gone: Set<string>): StoredOp {
  // A skill needs no target; the master check is made once, now.
  if (op.op === 'add_skill') return { op: 'add_skill', name: op.name, category: op.category, inMaster: draft.masterSkills.has(op.name.trim().toLowerCase()) };
  // A skill off: it must be printed now; the page's own record gives its ref and spelling.
  if (op.op === 'remove_skill') {
    // Every printed copy of that name, compared the way every skill check here compares names.
    const copies = draft.printedSkills.get(op.name.trim().toLowerCase()) ?? [];
    /* The copy in the named group when the name prints under two (review finding, 2026-11-04: "remove
       Testing from Frameworks" took the other copy); otherwise the first, as the server spells it. */
    const skill = copies.find((copy) => op.category !== undefined && copy.category.trim().toLowerCase() === op.category.trim().toLowerCase()) ?? copies[0];
    // Not printed (or the page sent no skill records): said by name.
    return skill === undefined ? reject(`Remove skill "${op.name}"`, `"${op.name}" is not on the resume.`) : { op: 'remove_skill', ref: skill.ref, name: skill.name };
  }
  // A whole entry off: one the ask listed.
  if (op.op === 'remove_entry') {
    // The entry, by short id.
    const entry = draft.entries.get(op.id);
    // An id never sent cannot be applied.
    if (entry === undefined) return reject(`Remove entry ${op.id}`, 'The AI named an entry it was not shown.');
    // Recorded, so later ops in this answer on the entry or its bullets are refused, not failed.
    gone.add(`entry:${entry.section}:${entry.ref}`);
    // Its bullets, as the copy holds them now: lists is index-aligned with structure.entries, whose objects draft.entries reuses.
    const list = lists[draft.structure?.entries.indexOf(entry) ?? -1];
    // Each one gone with it, and the copy emptied so no later move finds a sibling there.
    for (const ref of list?.splice(0) ?? entry.bulletRefs) gone.add(ref);
    // Its section and ref are what remove_entry saves against; its label is what the card shows.
    return { op: 'remove_entry', section: entry.section, ref: entry.ref, label: entry.label };
  }
  // A job's title (2026-11-11): a JOB the ask listed, still on the resume after this answer's earlier ops.
  if (op.op === 'set_role') {
    // The card's wording, used by every refusal below.
    const what = `Set job title to "${clip(op.text, MAX_QUOTE, 'title')}"`;
    // The entry, by short id.
    const entry = draft.entries.get(op.entry);
    // An id never sent cannot be applied.
    if (entry === undefined) return reject(what, 'The AI named an entry it was not shown.');
    // Only a job has a title (the server checks too; this page never trusts that alone).
    if (entry.section !== 'experience') return reject(what, 'Only a job (experience entry) has a title that can be changed here.');
    // Taken off by an earlier op in this answer.
    if (gone.has(`entry:${entry.section}:${entry.ref}`)) return reject(what, GONE_WITH_ENTRY);
    // Its ref is what the save targets; the label (old title) and the new title are what the card shows.
    return { op: 'set_role', ref: entry.ref, label: entry.label, role: op.text };
  }
  // A section: it must be in the order, with a neighbour on that side.
  if (op.op === 'move_section') {
    // The card's wording, used by every refusal below.
    const what = `Move section ${sectionTitle(op.section)} ${op.direction}`;
    // The sent name, matched to its typed form (the wire carries a plain string).
    const section = sections.find((name) => name === op.section);
    // Not in the printed order: nothing to move.
    if (section === undefined) return reject(what, `${sectionTitle(op.section)} is not printed on this resume.`);
    // The neighbour it passes, played on the copy.
    const past = swapPast(sections, section, op.direction);
    // Already at that end.
    return past === undefined ? reject(what, `${sectionTitle(section)} is already ${op.direction === 'up' ? 'first' : 'last'}.`) : { op: 'move_section', section, direction: op.direction, past };
  }
  // A master item back: an "mN" bullet or an "nN" entry.
  if (op.op === 'add_back') {
    // A bullet first.
    const bullet = draft.availableBullets.get(op.id);
    // Its entry was removed earlier in this answer: addMasterBullet would find no parent.
    if (bullet !== undefined && gone.has(`entry:${bullet.section}:${bullet.parentRef}`)) return reject(`Add back ${quote(bullet.text, op.id)}`, GONE_WITH_ENTRY);
    // Its master text and entry label travel with it, for the card.
    if (bullet !== undefined) return { op: 'add_bullet', ref: bullet.ref, text: bullet.text, parentLabel: bullet.parentLabel };
    // Otherwise a whole entry.
    const entry = draft.availableEntries.get(op.id);
    // An id never sent cannot be applied.
    return entry === undefined ? reject(`Add back ${op.id}`, 'The AI named a master item it was not shown.') : { op: 'add_entry', section: entry.section, ref: entry.ref, label: entry.label };
  }
  // A new bullet: under an entry that was sent.
  if (op.op === 'new_bullet') {
    // The entry, by short id.
    const entry = draft.entries.get(op.entry);
    // An id never sent cannot be applied.
    if (entry === undefined) return reject(`New bullet under ${op.entry}`, 'The AI named an entry it was not shown.');
    // Removed earlier in this answer: nothing left to write under.
    if (gone.has(`entry:${entry.section}:${entry.ref}`)) return reject(`New bullet under "${clip(entry.label, MAX_QUOTE, op.entry)}"`, GONE_WITH_ENTRY);
    // Its section and ref are what attestBullet files the new master bullet under.
    return { op: 'new_bullet', section: entry.section, parentRef: entry.ref, parentLabel: entry.label, text: op.text };
  }
  // The text the id stood for at ask time.
  const before = draft.before.get(op.id) ?? null;
  // The verb on this op's card.
  const verb = op.op === 'edit' ? 'Edit' : op.op === 'remove' ? 'Remove' : 'Move';
  // The summary has its own target; the server never proposes removing or moving it.
  if (op.id === 'summary') return op.op === 'edit' ? { op: 'edit', target: { kind: 'summary' }, before, text: op.text, advice: auditAdvice(op, draft) } : reject(`${verb} summary`, 'The summary can be edited, not removed or moved.');
  // The bullet's ref, from the ask that produced this op.
  const ref = draft.refs.get(op.id);
  // An id we never sent cannot be applied.
  if (ref === undefined) return reject(`${verb} bullet ${op.id}${op.op === 'move' ? ` ${op.direction}` : ''}`, 'The AI named a bullet it was not shown.');
  // Its entry was removed earlier in this answer: the bullet is no longer on the resume to change.
  if (gone.has(ref)) return reject(`${verb} bullet ${quote(before, op.id)}${op.op === 'move' ? ` ${op.direction}` : ''}`, GONE_WITH_ENTRY);
  // The sibling list holding this bullet, if a structure was sent.
  const list = lists.find((refs) => refs.includes(ref));
  // A move needs that list and a neighbour on that side.
  if (op.op === 'move') {
    // The card's wording.
    const what = `Move bullet ${quote(before, op.id)} ${op.direction}`;
    // No structure: the page did not send the layout a move is played against.
    if ((draft.structure?.entries ?? []).length === 0) return reject(what, 'Bullets can only be moved when the page shows the resume by section.');
    // In no list now: an earlier change in this answer removed it.
    if (list === undefined) return reject(what, 'An earlier change in this answer removes that bullet.');
    // Played on the copy.
    const past = swapPast(list, ref, op.direction);
    // Already at that end of its entry.
    return past === undefined ? reject(what, `That bullet is already ${op.direction === 'up' ? 'first' : 'last'} in its entry.`) : { op: 'move', ref, direction: op.direction, past, before };
  }
  // A removal shortens the copy too, so a later move in this answer sees the right neighbour.
  if (op.op === 'remove') list?.splice(list.indexOf(ref), 1);
  // Resolved, with the audit's advice for an edit.
  return op.op === 'edit'
    ? { op: 'edit', target: { kind: 'bullet', ref }, before, text: op.text, advice: auditAdvice(op, draft) }
    : { op: 'remove', ref, before };
}

/* Whether the chat applies this op by itself, right after the answer (Teja, 2026-11-01: "my ai
   need to perform the actions"). Edits: only when rule 5 finds them grounded (2026-11-04, see the
   edit line below). Removals: yes; they change only this resume, the row
   still needs Approve, and every edited line keeps its Reset in the diff. A skill ON: only when the
   master already has it (2026-11-05). Otherwise applying writes a new claim, under the AI's chosen
   group, into the master profile that every future resume inherits. Naming the skill vouches for the
   skill, not for that group (master v14 got "Testing" and "Code review" filed under "AI"), so the card
   waits for the operator to check the group and click. A skill OFF: only when the operator NAMED it,
   matched by whole tokens, so "os" in "remove os" counts but "os" inside "cost" does not.
   STRUCTURE (2026-11-01): moves and add-backs apply by themselves, since they only reorder or reuse
   true master text. A new bullet never does: applying it writes a new claim into the master, the
   same reason as an unnamed skill, so its card always waits for a click. */
export function shouldAutoApply(op: StoredOp, instruction: string): boolean {
  // A rejected card has nothing to apply.
  if (op.op === 'rejected') return false;
  // A new claim in the master is the operator's call, every time.
  if (op.op === 'new_bullet') return false;
  /* A whole entry off is the biggest change one op can make, and since 2026-11-04 the untrusted JD is
     in the prompt, so a posting could ask for it (review finding): always the operator's click. */
  if (op.op === 'remove_entry') return false;
  // A job title is a claim an employer verifies (2026-11-11): always the operator's click.
  if (op.op === 'set_role') return false;
  /* A text edit applies by itself only when rule 5 found it grounded (Teja, 2026-11-04, "Audit-gated").
     The untrusted JD is in the prompt, so a posting can steer the wording; an injected claim almost
     always carries words the master lacks, which rule 5 names. Summary edits have no rule 5 and wait. */
  if (op.op === 'edit') return isGrounded(op.advice);
  /* Bullet removals, moves and add-backs insert no text that is not the master's own, and are
     resume-only and reversible: Reset on the line brings the tailor's version back. */
  if (op.op !== 'add_skill' && op.op !== 'remove_skill') return true;
  /* A skill on: only a master claim, which attest reuses with the master's own group. A new one
     waits even when named (2026-11-05): the group it would land under is the AI's pick. */
  if (op.op === 'add_skill') return op.inMaster;
  /* A skill off (2026-11-04, the JD reason above): only when the operator named it; "remove the
     duplicate testing" names Testing, "trim my skills" names none. */
  // The operator's words, as the auditor tokenises text.
  const said = new Set(tokenizeText(instruction));
  // Every word of the skill's name must have been typed ("CN" needs "cn"; "Code review" needs both).
  const name = tokenizeText(op.name);
  // An empty name never auto-applies.
  return name.length > 0 && name.every((token) => said.has(token));
}

/* The page action a stored op becomes on Apply. A switch over the closed union: a new StoredOp arm
   without an action here fails typecheck (the function would not return on every path). Takes only
   ApplicableOp, so a rejected card can never be turned into a save. */
export function toEditAction(stored: ApplicableOp): EditAction {
  // One case per stored shape.
  switch (stored.op) {
    /* A skill always goes through the attest path: it reuses the master's own node when the latest
       master already has the skill, and otherwise records the operator's vouch as a new master
       version first. Either way the printed skill traces to the master, which the auditor demands. */
    case 'add_skill':
      return { kind: 'attest_skill', keyword: stored.name, category: stored.category };
    // New text on its resolved target.
    case 'edit':
      return { kind: 'edit', target: stored.target, text: stored.text };
    // The bullet dropped.
    case 'remove':
      return { kind: 'remove', target: { kind: 'bullet', ref: stored.ref } };
    // One place among its siblings; the save re-reads the order, so this is "one place from now".
    case 'move':
      return { kind: 'move_bullet', ref: stored.ref, direction: stored.direction };
    // One place in section_order.
    case 'move_section':
      return { kind: 'move_section', section: stored.section, direction: stored.direction };
    // A master bullet back, by ref; the save puts it under its own entry.
    case 'add_bullet':
      return { kind: 'add_master_bullet', ref: stored.ref };
    // A master entry back, with all its bullets.
    case 'add_entry':
      return { kind: 'add_master_entry', section: stored.section, ref: stored.ref };
    // New text: into the master first, then onto the resume by its new ref.
    case 'new_bullet':
      return { kind: 'attest_bullet', section: stored.section, parentRef: stored.parentRef, text: stored.text };
    // The skill off, by master ref: the same action the skills row's own Remove makes.
    case 'remove_skill':
      return { kind: 'remove_skill', ref: stored.ref };
    // The entry off, by section and ref: the same action the entry's own Remove makes.
    case 'remove_entry':
      return { kind: 'remove_entry', section: stored.section, ref: stored.ref };
    // The job's title, by ref (2026-11-11).
    case 'set_role':
      return { kind: 'set_role', ref: stored.ref, role: stored.role };
  }
}

/* T10 (2026-11-10): THE LINKED SWAP PAIR. A remove_entry of entry X and an add_entry (an add_back of a
   master ENTRY) in the SAME section, in one answer, are one swap: "instead of One-on-One use F1 Race Pace".
   Either half alone breaks the project count (1 < 2, or 3 > 2), so they are shown together and applied
   together in one end-state-checked save (pageFitEdit.planBatch). DERIVED from the stored ops on every
   read, never stored: StoredOp and readStoredOp stay exactly as they were, so a chat saved before this
   pairs too on reload, and no wire or table changes. Greedy in answer order: each remove takes the first
   unpaired add of its section, so "swap two for two" pairs one-to-one. Answers index -> partner index,
   both ways.
   Review fix (2026-11-10): ONLY in a section whose content rule CAPS the count (SWAP_CAPPED below), because
   only there does a lone add break a rule. Elsewhere (certifications: a floor, no cap) each card applies
   on its own, and linking would only make one click do two things nobody asked to join. */
export function swapPartners(ops: readonly StoredOp[]): ReadonlyMap<number, number> {
  // Both directions, filled as pairs are found.
  const partners = new Map<number, number>();
  // Each remove_entry in order.
  ops.forEach((remove, i) => {
    // Only a whole-entry removal starts a swap, and only in a capped section.
    if (remove.op !== 'remove_entry' || !(remove.section in SWAP_CAPPED)) return;
    // The first add_entry of the same section not yet taken by an earlier remove.
    const j = ops.findIndex((add, k) => add.op === 'add_entry' && add.section === remove.section && !partners.has(k));
    // No add in this section: the remove stands alone.
    if (j === -1) return;
    // Linked one way.
    partners.set(i, j);
    // And back, so either card finds the other.
    partners.set(j, i);
  });
  // The pairs.
  return partners;
}

/* The sections whose entry COUNT a content rule caps, with the cap read from the rule's own floors
   (page-trim.ts PAGE_FIT_FLOORS, which checkContentRules reads). A table, not derived: the rules are named
   checks per field ("projects: 3, at most 2"), with no list of capped sections to read. Today only projects
   has a cap; a new cap is one line here beside the floor it reads. */
const SWAP_CAPPED: Readonly<Partial<Record<BulletSection, number>>> = {
  // "never and ever 3 projects, only 2" (Teja, 2026-11-08): the cap the live swap bug hit.
  projects: PAGE_FIT_FLOORS.maxProjects,
};

/* T10 review fix (2026-11-10): THE BATCH RUN, pure so it is tested without a page. Resume-only items go to
   ONE atomic save (all or none); the attest items (they also write a master version) each run on their own
   path AFTER it, one at a time. True all-or-none across a master insert and a row update is impossible from
   the browser (no single DB transaction spans them), so a refused attest after a saved batch is NOT undone:
   it is reported, never silent. A refused batch runs no attest at all. */
export type BatchRun =
  // Every item landed.
  | { readonly kind: 'all_saved' }
  // Nothing landed: the batch (or the only attest) was refused.
  | { readonly kind: 'none_saved'; readonly reason: string }
  // Some landed (`saved`), then `notSaved` was refused for `reason`; `notTried` attests after it never ran.
  | { readonly kind: 'partial'; readonly saved: number; readonly notSaved: string; readonly reason: string; readonly notTried: number };

/* Run a batch: the injected saves are the page's (the panel passes onEditBatch and its single save). */
export async function runApplyBatch<T>(
  // The items, in answer order.
  items: readonly T[],
  // Whether an item also writes the master (and so cannot be folded into the batch).
  isAttest: (item: T) => boolean,
  // How the report names an item.
  label: (item: T) => string,
  // The atomic save of every resume-only item.
  saveBatch: (items: readonly T[]) => Promise<EditResult>,
  // One attest's own guarded save.
  saveOne: (item: T) => Promise<EditResult>,
): Promise<BatchRun> {
  // Resume-only items: folded into one save.
  const pure = items.filter((item) => !isAttest(item));
  // Master-writing items: after it.
  const attests = items.filter(isAttest);
  // How many landed so far.
  let saved = 0;
  // Only when there is something to fold.
  if (pure.length > 0) {
    // ONE save of the end state.
    const result = await saveBatch(pure);
    // Refused: nothing landed, and no attest runs on top of it.
    if (!result.ok) return { kind: 'none_saved', reason: result.reason };
    // All of them landed together.
    saved = pure.length;
  }
  // The attests in order; the first refusal stops the run (the row probably changed).
  for (const [i, item] of attests.entries()) {
    // Its own save.
    const result = await saveOne(item);
    // Landed: count it.
    if (result.ok) { saved += 1; continue; }
    // Refused with nothing before it: nothing landed at all.
    if (saved === 0) return { kind: 'none_saved', reason: result.reason };
    // Refused after something landed: say both, and how many were never tried.
    return { kind: 'partial', saved, notSaved: label(item), reason: result.reason, notTried: attests.length - i - 1 };
  }
  // Everything landed.
  return { kind: 'all_saved' };
}

/* The one line a batch run puts above the composer, or null when everything landed. */
export function batchRunLine(run: BatchRun): string | null {
  // Nothing to say.
  if (run.kind === 'all_saved') return null;
  // Nothing landed, in the save's own words.
  if (run.kind === 'none_saved') return `Not applied: ${run.reason}`;
  // What landed, what did not and why, and what never ran: a partial save is never silent.
  return `Saved ${run.saved} change${run.saved === 1 ? '' : 's'}; not saved: ${run.notSaved} — ${run.reason}.${run.notTried > 0 ? ` ${run.notTried} more not tried.` : ''}`;
}

/* A short name for a card in a batch report. Only the attest kinds reach the report today, but every arm
   answers, so a new caller never prints "undefined". */
export function opLabel(op: ApplicableOp): string {
  // A skill: by name.
  if (op.op === 'add_skill') return `add skill "${op.name}"`;
  // A new bullet: by its entry.
  if (op.op === 'new_bullet') return `new bullet under "${op.parentLabel}"`;
  // Anything else: its kind, readable.
  return op.op.replace(/_/g, ' ');
}

/* Which ops one card's Apply takes, as answer indices in answer order. A half whose partner is NOT on the
   resume yet takes the partner with it: applying it alone would be refused, or worse, would leave the
   resume a project short until the second click. A half whose partner already landed (applied earlier,
   or by hand) is an ordinary single op again. `applied` is injected (the panel passes isApplied over its
   diff), so this stays pure and testable. */
export function applyTogether(ops: readonly StoredOp[], index: number, applied: (op: StoredOp) => boolean): number[] {
  // This card's partner, if it has one.
  const partner = swapPartners(ops).get(index);
  // Unpaired, or the partner is already on the resume: this card alone.
  if (partner === undefined || applied(ops[partner]!)) return [index];
  // Both, in the order the AI answered them (the order the batch folds them in).
  return [index, partner].sort((a, b) => a - b);
}

/* Whether this op is one half of a swap: the chat never auto-applies such a half by itself (an add_back
   would otherwise land alone and be refused on the project cap), and its card says it goes with its partner. */
export function isPairedHalf(ops: readonly StoredOp[], index: number): boolean {
  // Any partner at all.
  return swapPartners(ops).has(index);
}

/* Whether the resume already shows this op's effect. Derived, never stored: the resume is the one
   record of what was applied, so a chat reopened tomorrow (or after a Reset) tells the truth.
   Structural ops are read from `structure` (the current resume's, from the page); without one they
   read as not applied, since nothing could confirm them. */
export function isApplied(stored: StoredOp, diff: ResumeDiff, structure: AssistStructure | null = null): boolean {
  // A rejected card never landed, whatever the resume holds now.
  if (stored.op === 'rejected') return false;
  // The six structural shapes have their own reader.
  if (stored.op === 'move' || stored.op === 'move_section' || stored.op === 'add_bullet' || stored.op === 'add_entry' || stored.op === 'new_bullet' || stored.op === 'remove_entry') {
    // Nothing to read them against.
    return structure !== null && structureApplied(stored, diff, structure);
  }
  /* A job title (2026-11-11): applied when that job's heading now ends in the new title. The label is
     "company · role" (entryLabel), so the last part is the title; without a structure nothing confirms it. */
  if (stored.op === 'set_role') return structure !== null && structure.entries.some((entry) => entry.section === 'experience' && entry.ref === stored.ref && entry.label.split(' · ').at(-1) === stored.role);
  // A skill add or removal is read off the printed skills line.
  if (stored.op === 'add_skill' || stored.op === 'remove_skill') {
    // The skills line, if the diff has one.
    const skillsLine = diff.lines.find((line) => line.kind === 'skills');
    /* A removal is read by REF when the line carries refs: the same name can print twice (two
       groups), and "remove one of the two" must read as done while the other copy still prints. */
    if (stored.op === 'remove_skill' && skillsLine?.printedSkills !== undefined) return !skillsLine.printedSkills.some((skill) => skill.ref === stored.ref);
    // Printed names, compared case-insensitively like every other skill check here.
    const printed = lineText(skillsLine?.tailoredRuns ?? []).split(',').map((name) => name.trim().toLowerCase());
    // Whether this skill prints now.
    const prints = printed.includes(stored.name.trim().toLowerCase());
    // An add is applied when it prints; a removal when it no longer does.
    return stored.op === 'add_skill' ? prints : !prints;
  }
  // The targeted bullet's ref, or null for the summary.
  const ref = stored.op === 'remove' ? stored.ref : stored.target.kind === 'bullet' ? stored.target.ref : null;
  // The line: the summary, or the bullet with this ref.
  const line = diff.lines.find((l) => (ref === null ? l.kind === 'summary' : l.editTarget?.kind === 'bullet' && l.editTarget.ref === ref));
  // A removal is applied when the bullet is gone or marked removed.
  if (stored.op === 'remove') return line === undefined || line.editState === 'removed';
  // An edit is applied when the printed text is exactly the proposed text.
  return line !== undefined && line.editState !== 'removed' && lineText(line.tailoredRuns) === stored.text;
}

/* "a sits above b" in one list; false when either is missing, so a stale op never reads as done. */
function above<T>(list: readonly T[], a: T, b: T): boolean {
  // Both positions.
  const [i, j] = [list.indexOf(a), list.indexOf(b)];
  // Both present and in that order.
  return i >= 0 && j >= 0 && i < j;
}

/* isApplied for the structural shapes, against the current resume's structure. */
function structureApplied(
  stored: Extract<StoredOp, { op: 'move' | 'move_section' | 'add_bullet' | 'add_entry' | 'new_bullet' | 'remove_entry' }>,
  diff: ResumeDiff,
  structure: AssistStructure,
): boolean {
  // One case per shape.
  switch (stored.op) {
    // Moved up: the bullet now sits above the sibling it passed; down: below it. Same entry only.
    case 'move': {
      // The entry holding both, if any.
      const list = structure.entries.find((entry) => entry.bulletRefs.includes(stored.ref))?.bulletRefs ?? [];
      // Order read in the direction of the move.
      return stored.direction === 'up' ? above(list, stored.ref, stored.past) : above(list, stored.past, stored.ref);
    }
    // The same reading on section_order.
    case 'move_section':
      return stored.direction === 'up' ? above(structure.sections, stored.section, stored.past) : above(structure.sections, stored.past, stored.section);
    // Back on the resume under some entry.
    case 'add_bullet':
      return structure.entries.some((entry) => entry.bulletRefs.includes(stored.ref));
    // The entry is on the resume in its section.
    case 'add_entry':
      return structure.entries.some((entry) => entry.section === stored.section && entry.ref === stored.ref);
    // The mirror: the entry is no longer on the resume in its section (structureFromDiff skips removed ones).
    case 'remove_entry':
      return !structure.entries.some((entry) => entry.section === stored.section && entry.ref === stored.ref);
    // A bullet under its entry now prints exactly this text (its ref is new, so the text is the key).
    case 'new_bullet': {
      // The parent entry's bullets.
      const refs = structure.entries.find((entry) => entry.section === stored.section && entry.ref === stored.parentRef)?.bulletRefs ?? [];
      // Any of them printing the proposed text.
      return diff.lines.some((line) => line.editTarget?.kind === 'bullet' && refs.includes(line.editTarget.ref) && line.editState !== 'removed' && lineText(line.tailoredRuns) === stored.text);
    }
  }
}

/* A string array, or null. */
function stringArray(value: unknown): string[] | null {
  // Every entry must be a string; one that is not makes the whole list unreadable.
  return Array.isArray(value) && value.every((item) => typeof item === 'string') ? (value as string[]) : null;
}

/* The audit advice as stored, or undefined when the shape is wrong (null is a valid "no advice"). */
function readAdvice(value: unknown): AuditAdvice | null | undefined {
  // No advice is a legitimate stored value.
  if (value === null) return null;
  // Anything else must be a record.
  if (!isRecord(value)) return undefined;
  // Checked: two string lists.
  if (value.kind === 'checked') {
    // Both lists read on their own.
    const metrics = stringArray(value.metrics);
    // Same.
    const terms = stringArray(value.terms);
    // Either malformed makes the advice unreadable.
    return metrics !== null && terms !== null ? { kind: 'checked', metrics, terms } : undefined;
  }
  // Not checked: a reason.
  if (value.kind === 'not_checked' && typeof value.why === 'string') return { kind: 'not_checked', why: value.why };
  // Any other shape.
  return undefined;
}

/* A direction, or null for anything outside the closed pair. */
function moveDirection(value: unknown): MoveDirection | null {
  // Exactly one of two words, never coerced.
  return value === 'up' || value === 'down' ? value : null;
}

/* A section name from the closed list, typed, or null. find() returns the list's own typed value,
   so no cast is needed. */
function sectionKind(value: unknown): SectionKind | null {
  // Membership in the shared seven.
  return TAILOR_SECTION_KINDS.find((kind) => kind === value) ?? null;
}

/* A section that holds entries with bullets (every kind but summary and skills), or null. */
function bulletSection(value: unknown): BulletSection | null {
  // A real section name first.
  const kind = sectionKind(value);
  // The two that hold no entries are excluded; the rest narrow to BulletSection.
  return kind === null || kind === 'summary' || kind === 'skills' ? null : kind;
}

/* True when every listed field of the record is a string. */
function allStrings(value: Record<string, unknown>, keys: readonly string[]): boolean {
  // One wrong-typed field makes the row unreadable.
  return keys.every((key) => typeof value[key] === 'string');
}

/* A stored op read back from the database, or null when it is not one of the stored shapes. Rows
   are untrusted: an op shown with a guessed target could save the wrong bullet. */
export function readStoredOp(value: unknown): StoredOp | null {
  // Must be an object.
  if (!isRecord(value)) return null;
  // The text it replaced: a string or null.
  const before = typeof value.before === 'string' ? value.before : value.before === null ? null : undefined;
  // A bullet move: refs, a closed direction, and the old text.
  if (value.op === 'move') {
    // Closed.
    const direction = moveDirection(value.direction);
    // Every field typed exactly.
    return allStrings(value, ['ref', 'past']) && direction !== null && before !== undefined
      ? { op: 'move', ref: value.ref as string, direction, past: value.past as string, before }
      : null;
  }
  // A section move: two section names from the closed list and a direction.
  if (value.op === 'move_section') {
    // Each read on its own.
    const [section, past, direction] = [sectionKind(value.section), sectionKind(value.past), moveDirection(value.direction)];
    // All three readable.
    return section !== null && past !== null && direction !== null ? { op: 'move_section', section, direction, past } : null;
  }
  // A master bullet back: ref, text and its entry's label.
  if (value.op === 'add_bullet') {
    // Strings only.
    return allStrings(value, ['ref', 'text', 'parentLabel']) ? { op: 'add_bullet', ref: value.ref as string, text: value.text as string, parentLabel: value.parentLabel as string } : null;
  }
  // A master entry back: a bullet section, a ref and a label.
  if (value.op === 'add_entry') {
    // Closed.
    const section = bulletSection(value.section);
    // Typed exactly.
    return section !== null && allStrings(value, ['ref', 'label']) ? { op: 'add_entry', section, ref: value.ref as string, label: value.label as string } : null;
  }
  // A new bullet: a bullet section, its parent, the parent's label and the text.
  if (value.op === 'new_bullet') {
    // Closed.
    const section = bulletSection(value.section);
    // Typed exactly.
    return section !== null && allStrings(value, ['parentRef', 'parentLabel', 'text'])
      ? { op: 'new_bullet', section, parentRef: value.parentRef as string, parentLabel: value.parentLabel as string, text: value.text as string }
      : null;
  }
  // A skill off: its master ref and printed name.
  if (value.op === 'remove_skill') return allStrings(value, ['ref', 'name']) ? { op: 'remove_skill', ref: value.ref as string, name: value.name as string } : null;
  // An entry off: a bullet section, a ref and a label.
  if (value.op === 'remove_entry') {
    // Closed.
    const section = bulletSection(value.section);
    // Typed exactly.
    return section !== null && allStrings(value, ['ref', 'label']) ? { op: 'remove_entry', section, ref: value.ref as string, label: value.label as string } : null;
  }
  // A job title (2026-11-11): ref, label and the new title, all strings.
  if (value.op === 'set_role') return allStrings(value, ['ref', 'label', 'role']) ? { op: 'set_role', ref: value.ref as string, label: value.label as string, role: value.role as string } : null;
  // A rejected card: what was asked and why; without a reason it would say "not done" over nothing.
  if (value.op === 'rejected') return allStrings(value, ['what', 'why']) ? { op: 'rejected', what: value.what as string, why: value.why as string } : null;
  // A skill: name, group, and the master flag.
  if (value.op === 'add_skill') {
    // All three typed exactly.
    return typeof value.name === 'string' && typeof value.category === 'string' && typeof value.inMaster === 'boolean'
      ? { op: 'add_skill', name: value.name, category: value.category, inMaster: value.inMaster }
      : null;
  }
  // A removal: a ref and the old text.
  if (value.op === 'remove') return typeof value.ref === 'string' && before !== undefined ? { op: 'remove', ref: value.ref, before } : null;
  // Only an edit is left.
  if (value.op !== 'edit' || typeof value.text !== 'string' || before === undefined || !isRecord(value.target)) return null;
  // Its target: the summary, or a bullet by ref.
  const target = value.target.kind === 'summary' ? { kind: 'summary' as const } : value.target.kind === 'bullet' && typeof value.target.ref === 'string' ? { kind: 'bullet' as const, ref: value.target.ref } : null;
  // The advice, validated like the rest.
  const advice = readAdvice(value.advice);
  // Both must be readable.
  return target !== null && advice !== undefined ? { op: 'edit', target, before, text: value.text, advice } : null;
}

/* What one ask cost, in one line; unknown counts are left out, never shown as 0. */
export function formatUsage(usage: AssistUsage): string {
  // The parts Google reported, in billing order.
  const parts: string[] = [];
  // Input, with the cached share when known (cached input is billed at a discount).
  if (usage.input !== null) parts.push(usage.cached !== null && usage.cached > 0 ? `${usage.input} in (${usage.cached} cached)` : `${usage.input} in`);
  // Visible output.
  if (usage.output !== null) parts.push(`${usage.output} out`);
  // Thinking, billed as output.
  if (usage.thinking !== null) parts.push(`${usage.thinking} thinking`);
  // Nothing reported is said as such.
  return parts.length === 0 ? 'Token use not reported.' : `Tokens: ${parts.join(', ')}.`;
}

/* True for a plain object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  // Arrays and null are not records.
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/* A token count or null; anything else is not a count. */
function count(value: unknown): number | null {
  // Shape-checked like every other field of the answer.
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}

/* Token counts from the wire or from a stored chat row: one reader for both, unknowns as null. */
export function readUsage(value: unknown): AssistUsage {
  // Anything but a record reads as four unknowns.
  const usage = isRecord(value) ? value : {};
  // Each count checked on its own.
  return { input: count(usage.input), cached: count(usage.cached), output: count(usage.output), thinking: count(usage.thinking) };
}

/* One op from the wire, or null when it is not one of the nine shapes. */
function readOp(value: unknown): AssistOp | null {
  // Must be an object.
  if (!isRecord(value)) return null;
  // A direction, for the two moves.
  const direction = moveDirection(value.direction);
  // A bullet move: an id and a direction.
  if (value.op === 'move' && typeof value.id === 'string' && direction !== null) return { op: 'move', id: value.id, direction };
  // A section move: a name (checked against the order on resolve) and a direction.
  if (value.op === 'move_section' && typeof value.section === 'string' && direction !== null) return { op: 'move_section', section: value.section, direction };
  // A master item back: an id.
  if (value.op === 'add_back' && typeof value.id === 'string') return { op: 'add_back', id: value.id };
  // A new bullet: an entry id and text.
  if (value.op === 'new_bullet' && typeof value.entry === 'string' && typeof value.text === 'string') return { op: 'new_bullet', entry: value.entry, text: value.text };
  // A skill off: its printed name (2026-11-04).
  if (value.op === 'remove_skill' && typeof value.name === 'string' && (value.category === undefined || typeof value.category === 'string')) {
    // The group only when sent: it picks one of two same-named copies.
    return value.category === undefined ? { op: 'remove_skill', name: value.name } : { op: 'remove_skill', name: value.name, category: value.category };
  }
  // An entry off: its short id (2026-11-04).
  if (value.op === 'remove_entry' && typeof value.id === 'string') return { op: 'remove_entry', id: value.id };
  // A job title: an entry id and the new title (2026-11-11).
  if (value.op === 'set_role' && typeof value.entry === 'string' && typeof value.text === 'string') return { op: 'set_role', entry: value.entry, text: value.text };
  // An edit carries an id, text and a list of new numbers.
  if (value.op === 'edit' && typeof value.id === 'string' && typeof value.text === 'string' && Array.isArray(value.newNumbers)) {
    // Every flagged number must be a string, or the warning shown would be wrong.
    const newNumbers = value.newNumbers.filter((n): n is string => typeof n === 'string');
    // A list that lost entries is malformed, not "fewer warnings".
    return newNumbers.length === value.newNumbers.length ? { op: 'edit', id: value.id, text: value.text, newNumbers } : null;
  }
  // A remove carries only an id.
  if (value.op === 'remove' && typeof value.id === 'string') return { op: 'remove', id: value.id };
  // A skill carries a name and a group.
  if (value.op === 'add_skill' && typeof value.name === 'string' && typeof value.category === 'string') {
    // Exactly those two fields kept.
    return { op: 'add_skill', name: value.name, category: value.category };
  }
  // Any other shape.
  return null;
}

/* One server refusal from the wire, or null when it is not two strings. */
function readRejection(value: unknown): Rejection | null {
  // Both fields must be strings; a reason shown as "undefined" would be worse than an error.
  return isRecord(value) && typeof value.what === 'string' && typeof value.why === 'string' ? { what: value.what, why: value.why } : null;
}

/* A short label for one stored op, lower-case first so it reads inside a sentence. The outcome line
   below uses it; a rejected card keeps the AI-facing wording it was stored with. */
export function describeOp(op: StoredOp): string {
  // One case per stored shape.
  switch (op.op) {
    // The summary, or a bullet quoted by its old text.
    case 'edit':
      return op.target.kind === 'summary' ? 'edit summary' : `edit bullet ${quote(op.before, 'bullet')}`;
    // The bullet quoted.
    case 'remove':
      return `remove bullet ${quote(op.before, 'bullet')}`;
    // By name.
    case 'add_skill':
      return `add skill "${op.name}"`;
    // By name.
    case 'remove_skill':
      return `remove skill "${op.name}"`;
    // The bullet and the way it goes.
    case 'move':
      return `move bullet ${quote(op.before, 'bullet')} ${op.direction}`;
    // The section and the way it goes.
    case 'move_section':
      return `move section ${sectionTitle(op.section)} ${op.direction}`;
    // The master text coming back.
    case 'add_bullet':
      return `add back bullet ${quote(op.text, 'bullet')}`;
    // The entry coming back.
    case 'add_entry':
      return `add back "${clip(op.label, MAX_QUOTE, op.section)}"`;
    // The entry going.
    case 'remove_entry':
      return `remove entry "${clip(op.label, MAX_QUOTE, op.section)}"`;
    // The job and its new title (2026-11-11).
    case 'set_role':
      return `set job title of "${clip(op.label, MAX_QUOTE, 'job')}" to "${clip(op.role, MAX_QUOTE, 'title')}"`;
    // The new wording.
    case 'new_bullet':
      return `new bullet ${quote(op.text, 'bullet')}`;
    // What was asked, as stored.
    case 'rejected':
      return op.what;
  }
}

/* A sentence that reports a change as done: a past-tense change verb, or the bare word "done". Deliberately
   broad: hiding a true sentence is the safe error, because the status line and the op cards carry the truth. */
const CLAIMS_A_CHANGE = /\b(?:added|removed|changed|moved|applied|updated|rewrote|rephrased|replaced|deleted|inserted|swapped|done)\b/i;

/* The reply text the panel shows (bug a, Teja 2026-11-06, live Revature row: "Added GCP, MySQL, Redis, MongoDB"
   with 0 ops applied). A reply whose ops could never land (none, or every one rejected) must not claim a
   change: its words are hidden when they claim one, so the panel never shows a change that did not happen.
   A reply with a landable op keeps its words; its cards and status line say what really changed. */
export function replyNote(note: string, ops: readonly StoredOp[]): string {
  // Whether anything in this reply could ever land (a rejected card never does; an empty list has none).
  const somethingCanLand = ops.some((op) => op.op !== 'rejected');
  // Landable: the cards beside the words prove or disprove them.
  if (somethingCanLand) return note;
  // Nothing can land: a claim is false by construction, a plain answer or question is fine.
  return CLAIMS_A_CHANGE.test(note) ? '' : note;
}

/* What one reply's changes amount to NOW, read from the resume (2026-11-04): "[Applied: … |
   Not applied yet: … | Could not do: … (why)]", or '' for a reply with no ops. The chat sends this
   ahead of each earlier AI reply, so the model reads the outcome of its own turns instead of its own
   claims; the old note "I added C" was resent as fact and the model went on believing it. */
export function outcomeNote(ops: readonly StoredOp[], diff: ResumeDiff, structure: AssistStructure | null): string {
  // Landed, by the same reading the cards use.
  const applied = ops.filter((op) => isApplied(op, diff, structure)).map(describeOp);
  // Could land, has not: waiting for a click, failed, or undone since.
  const open = ops.filter((op) => op.op !== 'rejected' && !isApplied(op, diff, structure)).map(describeOp);
  // Could never land, with the reason.
  const impossible = ops.flatMap((op) => (op.op === 'rejected' ? [`${op.what} (${op.why})`] : []));
  // Only the non-empty groups, in that order.
  const groups = [
    // Done.
    applied.length > 0 ? `Applied: ${applied.join('; ')}` : null,
    // Not yet.
    open.length > 0 ? `Not applied yet: ${open.join('; ')}` : null,
    // Never.
    impossible.length > 0 ? `Could not do: ${impossible.join('; ')}` : null,
  ].filter((group): group is string => group !== null);
  // Bracketed so the model reads it as the app's record, not as its own words.
  return groups.length === 0 ? '' : `[${groups.join(' | ')}]`;
}

// The chat's words for a 503 from resume-assist (Gemini overloaded). Exported for the test that pins it.
export const AI_BUSY_MESSAGE = 'The AI is busy right now; try again in a minute.';

/* supabase-js hides a non-2xx body behind error.context (a fetch Response); read it defensively.
   ponytail: same reader as WebScoutPanel's private one; export a shared one if a third caller appears. */
async function readErrorBody(error: unknown): Promise<unknown> {
  // The Response, if there is one.
  const context = isRecord(error) ? error.context : null;
  // Only an object with a json() method can be read; checked before it is called.
  if (!isRecord(context) || typeof context.json !== 'function') return null;
  // A non-JSON body must not throw out of the ask.
  try {
    // Called as a method so `this` is the Response.
    return await (context as { json(): Promise<unknown> }).json();
  } catch {
    // Unreadable: the caller's generic message applies.
    return null;
  }
}

/* Ask the edge function. Never throws: every outcome is an AssistResult. */
export async function requestAssist(client: AssistClient | null, body: AssistBody): Promise<AssistResult> {
  // No client means the app is not configured; nothing can be asked.
  if (client === null) return { kind: 'error', message: 'The app is not connected to the database.' };
  // The call.
  try {
    // The function validates the body again; nothing here is trusted by it. Routed through the shared
    // helper so a session revoked elsewhere is refreshed once, or ends in a plain sentence.
    const answer = await invokeEdge(client, 'resume-assist', { body: { ...body } });
    // The session could not be recovered and this browser is signed out: the plain sentence, never the code.
    if (answer.kind === 'signed_out') return { kind: 'error', message: answer.message };
    // Otherwise exactly what invoke returned, read as before.
    const { data, error } = answer;
    // A non-2xx answer: read the function's own message when it sent one.
    if (error) {
      // The JSON body behind the error, if readable.
      const errBody = (await readErrorBody(error)) ?? data;
      // 503 {status:'upstream_unavailable'}: Gemini overloaded. Its message is the operator line
      // "upstream_unavailable status=503 …" (describeGeminiFailure), which the chat showed raw as if the AI
      // had said it (A1, 2026-11-05). The user gets plain words; the raw line goes to the console for debugging.
      if (isRecord(errBody) && errBody.status === 'upstream_unavailable') {
        // Kept for whoever debugs it, never on screen.
        console.warn('resume-assist upstream_unavailable:', errBody.message);
        // What the user can act on.
        return { kind: 'error', message: AI_BUSY_MESSAGE };
      }
      // The function's message, verbatim, when it has the expected shape.
      if (isRecord(errBody) && typeof errBody.message === 'string') return { kind: 'error', message: errBody.message };
      // Otherwise a plain sentence; the gateway's 404 for an undeployed function lands here.
      return { kind: 'error', message: 'The AI request failed and returned no readable message.' };
    }
    // A 200 must be the ok shape.
    if (!isRecord(data) || data.status !== 'ok' || !Array.isArray(data.ops)) return { kind: 'error', message: 'The AI answer had an unexpected shape.' };
    // Each op read on its own.
    const ops = data.ops.map(readOp);
    // One unreadable op means the contract drifted; say so rather than show a partial list.
    if (ops.some((op) => op === null)) return { kind: 'error', message: 'The AI answer had an unexpected shape.' };
    // The server's refusals with reasons (2026-11-04); absent from a server deployed before then.
    const listed = data.rejected === undefined ? [] : Array.isArray(data.rejected) ? data.rejected.map(readRejection) : null;
    // A malformed list is a drifted contract, like an unreadable op: never shown in part.
    if (listed === null || listed.some((item) => item === null)) return { kind: 'error', message: 'The AI answer had an unexpected shape.' };
    // Every refusal the server reported.
    const rejected = listed.filter((item): item is Rejection => item !== null);
    // How many it dropped in all; the list is capped there, and an older server sends only this.
    const unlisted = (count(data.dropped) ?? 0) - rejected.length;
    // Any it counted but did not itemise are still said, never lost.
    if (unlisted > 0) rejected.push({ what: `${unlisted} ${rejected.length > 0 ? 'more ' : ''}proposed change${unlisted === 1 ? '' : 's'}`, why: 'The AI service did not say why.' });
    // The validated answer.
    return {
      kind: 'ok',
      ops: ops.filter((op): op is AssistOp => op !== null),
      rejected,
      note: typeof data.note === 'string' ? data.note : '',
      // The bill, every count checked.
      usage: readUsage(data.usage),
    };
  } catch (cause) {
    // A network drop or a thrown fetch.
    return { kind: 'error', message: `The AI request failed: ${cause instanceof Error ? cause.message : 'no answer'}.` };
  }
}
