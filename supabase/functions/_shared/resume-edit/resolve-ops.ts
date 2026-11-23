// SERVER-SIDE OP RESOLUTION (S9i P2, 2026-11-21).
//
// WHY IT EXISTS: Teja ruled (15:34) that every resume-chat edit he prompts is applied and done, even if he closes the
// chat, the tab or the job. So resume-assist applies the AI's answer itself, and must turn each wire op (short ids
// bN/eN/mN/nN, a section name, a skill name) into the engine action the browser's resolveOne + toEditAction would have
// made (apps/web aiEdit.ts). The browser minted those short ids, so it sends the id -> ref maps with the ask (ApplyMaps).
// A ref from the wire is NEVER trusted: every action is checked again by the engine against the row the server reads,
// and tracesToMaster refuses any node that is not the pinned master's at save time.
//
// PURE: no Deno or DOM API, so node --test runs it and the edge function bundles it.

// A section key, as section_order spells it.
import type { BulletSection, SectionKind } from './tailored-edits.ts';
// The edit target union the engine's text edits take.
import type { EditTarget } from './edit-target.ts';

// The id -> ref maps the browser sends with a server-applied ask (it minted the ids in buildAssistDraft).
export interface ApplyMaps {
  // bN -> the bullet's ref.
  readonly bullets: Readonly<Record<string, string>>;
  // eN -> the entry's section and ref.
  readonly entries: Readonly<Record<string, { readonly section: BulletSection; readonly ref: string }>>;
  // mN -> a master bullet's ref (not on the resume yet).
  readonly availableBullets: Readonly<Record<string, string>>;
  // nN -> a master entry's section and ref (not on the resume yet).
  readonly availableEntries: Readonly<Record<string, { readonly section: BulletSection; readonly ref: string }>>;
  // Every printed skill with its ref, so remove_skill finds the copy by name (and by group when named).
  readonly skills: readonly { readonly name: string; readonly category: string; readonly ref: string }[];
}

// One op as resume-assist's parser keeps it (the wire shape), plus the S9j place fields.
export type WireOp =
  // Text edit of a bullet or the summary.
  | { readonly op: 'edit'; readonly id: string; readonly text: string }
  // A bullet off.
  | { readonly op: 'remove'; readonly id: string }
  // A skill on (attest: master first when new).
  | { readonly op: 'add_skill'; readonly name: string; readonly category: string }
  // A skill off.
  | { readonly op: 'remove_skill'; readonly name: string; readonly category?: string }
  // A bullet one step, or (S9j) to a place within its entry.
  | { readonly op: 'move'; readonly id: string; readonly direction?: 'up' | 'down'; readonly place?: number }
  // A section one step, or (S9j) to a place.
  | { readonly op: 'move_section'; readonly section: string; readonly direction?: 'up' | 'down'; readonly place?: number }
  // S9j: an entry to a place within its section ("applyyy first, One-on-One second").
  | { readonly op: 'move_entry'; readonly entry: string; readonly place: number }
  // A master item back (mN bullet, nN entry).
  | { readonly op: 'add_back'; readonly id: string }
  // A bullet the owner dictated, under an entry.
  | { readonly op: 'new_bullet'; readonly entry: string; readonly text: string }
  // A whole entry off.
  | { readonly op: 'remove_entry'; readonly id: string }
  // A job's title.
  | { readonly op: 'set_role'; readonly entry: string; readonly text: string };

// The engine action a resolved op becomes: the browser's PageEditAction kinds plus the S9j place moves.
export type ServerAction =
  // applyTextEdit.
  | { readonly kind: 'edit'; readonly target: EditTarget; readonly text: string }
  // removeBullet.
  | { readonly kind: 'remove'; readonly target: EditTarget }
  // removeSkill.
  | { readonly kind: 'remove_skill'; readonly ref: string }
  // attestSkill (at the pin, or master insert + repin).
  | { readonly kind: 'attest_skill'; readonly keyword: string; readonly category: string }
  // moveBullet.
  | { readonly kind: 'move_bullet'; readonly ref: string; readonly direction: 'up' | 'down' }
  // moveSection.
  | { readonly kind: 'move_section'; readonly section: SectionKind; readonly direction: 'up' | 'down' }
  // moveBulletTo (S9j).
  | { readonly kind: 'move_bullet_to'; readonly ref: string; readonly place: number }
  // moveSectionTo (S9j).
  | { readonly kind: 'move_section_to'; readonly section: SectionKind; readonly place: number }
  // moveEntryTo (S9j).
  | { readonly kind: 'move_entry_to'; readonly section: BulletSection; readonly ref: string; readonly place: number }
  // addMasterBullet.
  | { readonly kind: 'add_master_bullet'; readonly ref: string }
  // addMasterEntry.
  | { readonly kind: 'add_master_entry'; readonly section: BulletSection; readonly ref: string }
  // removeEntry.
  | { readonly kind: 'remove_entry'; readonly section: BulletSection; readonly ref: string }
  // setEntryRole.
  | { readonly kind: 'set_role'; readonly ref: string; readonly role: string }
  // attestBullet (master first).
  | { readonly kind: 'attest_bullet'; readonly section: BulletSection; readonly parentRef: string; readonly text: string };

// One op's resolution: the action, or why it cannot be one (the card's "what" and the one failed check).
export type Resolved = { readonly ok: true; readonly action: ServerAction } | { readonly ok: false; readonly what: string; readonly why: string };

// The reason an op on an id the browser never sent is refused with (the same words the browser used).
const NOT_SHOWN = 'The AI named something it was not shown.';

// The browser's wording for a place, in a card label.
const placeWord = (place: number): string => `place ${place}`;

// True for a whole number from 1: a place. Anything else is not one (CLAUDE.md §6: never coerce).
const isPlace = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 1;

/* One wire op to its engine action. Order-dependent effects (an earlier remove_entry in the same answer) are left to
   the engine: the server applies the actions one by one on the resume as it stands, so a later op on a removed entry
   is refused there with the engine's own reason, never guessed here. */
export function resolveWireOp(op: WireOp, maps: ApplyMaps, sections: readonly SectionKind[]): Resolved {
  // A refusal with its card wording.
  const no = (what: string, why: string): Resolved => ({ ok: false, what, why });
  // A skill on: the attest path decides at-pin versus new-to-master.
  if (op.op === 'add_skill') return { ok: true, action: { kind: 'attest_skill', keyword: op.name.trim(), category: op.category.trim() } };
  // A skill off: by name, in the named group when it prints twice, else the first copy.
  if (op.op === 'remove_skill') {
    // Every printed copy of that name.
    const copies = maps.skills.filter((skill) => skill.name.trim().toLowerCase() === op.name.trim().toLowerCase());
    // The named group's copy, else the first.
    const skill = copies.find((copy) => op.category !== undefined && copy.category.trim().toLowerCase() === op.category.trim().toLowerCase()) ?? copies[0];
    // Not printed.
    return skill === undefined ? no(`Remove skill "${op.name}"`, `"${op.name}" is not on the resume.`) : { ok: true, action: { kind: 'remove_skill', ref: skill.ref } };
  }
  // A whole entry off.
  if (op.op === 'remove_entry') {
    // The entry by short id.
    const entry = maps.entries[op.id];
    // Unknown id.
    return entry === undefined ? no(`Remove entry ${op.id}`, NOT_SHOWN) : { ok: true, action: { kind: 'remove_entry', section: entry.section, ref: entry.ref } };
  }
  // A job's title: only an experience entry has one.
  if (op.op === 'set_role') {
    // The entry by short id.
    const entry = maps.entries[op.entry];
    // Unknown id.
    if (entry === undefined) return no(`Set job title to "${op.text}"`, NOT_SHOWN);
    // Not a job.
    return entry.section !== 'experience' ? no(`Set job title to "${op.text}"`, 'Only a job (experience entry) has a title that can be changed here.') : { ok: true, action: { kind: 'set_role', ref: entry.ref, role: op.text } };
  }
  // A section: one step, or (S9j) to a place.
  if (op.op === 'move_section') {
    // The sent name, matched to the printed order's typed name.
    const section = sections.find((name) => name === op.section);
    // Not printed.
    if (section === undefined) return no(`Move section ${op.section}`, `${op.section} is not printed on this resume.`);
    // A place wins: it states the end position, no direction needed (S9j: "place applyy at first place").
    if (isPlace(op.place)) return { ok: true, action: { kind: 'move_section_to', section, place: op.place } };
    // Otherwise a direction, or nothing usable.
    return op.direction === undefined ? no(`Move section ${op.section}`, 'The AI did not say where to move it.') : { ok: true, action: { kind: 'move_section', section, direction: op.direction } };
  }
  // S9j: an entry to a place within its section.
  if (op.op === 'move_entry') {
    // The entry by short id.
    const entry = maps.entries[op.entry];
    // Unknown id.
    if (entry === undefined) return no(`Move entry ${op.entry}`, NOT_SHOWN);
    // A real place only.
    return isPlace(op.place) ? { ok: true, action: { kind: 'move_entry_to', section: entry.section, ref: entry.ref, place: op.place } } : no(`Move entry ${op.entry}`, 'The AI did not say which place.');
  }
  // A master item back: an mN bullet or an nN entry.
  if (op.op === 'add_back') {
    // A bullet first.
    const bullet = maps.availableBullets[op.id];
    // Found: its ref is all the engine needs (FULL holds its words).
    if (bullet !== undefined) return { ok: true, action: { kind: 'add_master_bullet', ref: bullet } };
    // Otherwise a whole entry.
    const entry = maps.availableEntries[op.id];
    // Unknown id.
    return entry === undefined ? no(`Add back ${op.id}`, NOT_SHOWN) : { ok: true, action: { kind: 'add_master_entry', section: entry.section, ref: entry.ref } };
  }
  // A dictated bullet under an entry (the parser already refused undictated words).
  if (op.op === 'new_bullet') {
    // The entry by short id.
    const entry = maps.entries[op.entry];
    // Unknown id.
    return entry === undefined ? no(`New bullet under ${op.entry}`, NOT_SHOWN) : { ok: true, action: { kind: 'attest_bullet', section: entry.section, parentRef: entry.ref, text: op.text } };
  }
  // The summary has its own target and is only ever edited.
  if (op.id === 'summary') return op.op === 'edit' ? { ok: true, action: { kind: 'edit', target: { kind: 'summary' }, text: op.text } } : no(`${op.op} summary`, 'The summary can be edited, not removed or moved.');
  // A bullet by short id.
  const ref = maps.bullets[op.id];
  // Unknown id (live 18:54: "Move e2" was an ENTRY id sent as a bullet: now move_entry exists for that).
  if (ref === undefined) return no(`${op.op === 'edit' ? 'Edit' : op.op === 'remove' ? 'Remove' : 'Move'} ${op.id}`, NOT_SHOWN);
  // An edit.
  if (op.op === 'edit') return { ok: true, action: { kind: 'edit', target: { kind: 'bullet', ref }, text: op.text } };
  // A removal.
  if (op.op === 'remove') return { ok: true, action: { kind: 'remove', target: { kind: 'bullet', ref } } };
  // A move: a place (S9j) wins over a direction.
  if (isPlace(op.place)) return { ok: true, action: { kind: 'move_bullet_to', ref, place: op.place } };
  // One step, or nothing usable.
  return op.direction === undefined ? no(`Move ${op.id}`, 'The AI did not say where to move it.') : { ok: true, action: { kind: 'move_bullet', ref, direction: op.direction } };
}

// The card label an applied action is reported under, in the owner's terms (used by the outcome list).
export function actionLabel(action: ServerAction): string {
  // One line per kind.
  switch (action.kind) {
    // Text.
    case 'edit': return action.target.kind === 'summary' ? 'Edit summary' : 'Edit bullet';
    // Bullet off.
    case 'remove': return 'Remove bullet';
    // Skill off.
    case 'remove_skill': return 'Remove skill';
    // Skill on.
    case 'attest_skill': return `Add skill "${action.keyword}" under ${action.category}`;
    // Bullet step.
    case 'move_bullet': return `Move bullet ${action.direction}`;
    // Section step.
    case 'move_section': return `Move section ${action.section} ${action.direction}`;
    // Bullet place.
    case 'move_bullet_to': return `Move bullet to ${placeWord(action.place)}`;
    // Section place.
    case 'move_section_to': return `Move section ${action.section} to ${placeWord(action.place)}`;
    // Entry place.
    case 'move_entry_to': return `Move ${action.section} entry to ${placeWord(action.place)}`;
    // Master bullet back.
    case 'add_master_bullet': return 'Add back a master bullet';
    // Master entry back.
    case 'add_master_entry': return `Add back a ${action.section} entry`;
    // Entry off.
    case 'remove_entry': return `Remove a ${action.section} entry`;
    // Title.
    case 'set_role': return `Set job title to "${action.role}"`;
    // Dictated bullet.
    case 'attest_bullet': return 'Add your new bullet';
  }
}
