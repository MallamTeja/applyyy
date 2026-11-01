# Review page: structural resume edits: contract (2026-11-01)

Teja asked that the review page (and its AI chat) can change **achievements and
certifications**, **section order**, **bullet order**, and add **new bullets**. Today the
save gate `onlyTextChanged` (`apps/web/src/features/approval/tailoredEdits.ts`) refuses all
four. This file is the contract three parallel writers code against. Read it whole.

## The honesty rule that replaces `onlyTextChanged` (R0')

Old R0: "the resume is the tailor's version with only text changed". New R0': **every node on
the resume traces to the pinned master under its true parent**. Concretely, a candidate resume
passes `tracesToMaster` iff:

1. Every top-level key except `summary`, `skills`, `section_order` and the five bullet sections
   deep-equals `previous` (identity, schema_version, master_version are untouched by these edits;
   a re-pin goes through the existing `repin` path in `saveTailoredEdit`).
2. `summary` is a string or null. `skills`: unchanged from previous, or `skillsAreOriginalPlusMaster`
   (existing rule, unchanged).
3. `section_order`: an array of unique `TailoredSectionKind` values; every non-empty section of the
   resume appears in it (a section with entries but no slot would be invisible in the PDF).
4. For each of the 5 sections (experience, projects, education, achievements, certifications):
   every entry's `ref` exists in **FULL** (the whole master resolved, see below) in the same section;
   the entry deep-equals FULL's entry **except `bullets`**; no entry ref twice. Entries may be added,
   removed and reordered.
5. Every bullet under an entry: its `ref` exists in FULL under the **same section and same parent
   entry**; it deep-equals FULL's bullet except `text`; `text` is a string; no bullet ref twice on
   the resume. Bullets may be added (from FULL), removed and reordered.

**FULL** = `resolveFullMaster(master, version)`: the validator (`validateTailoredProfile`) run on a
TailoredProfile that selects EVERY master node, so FULL holds every entry and bullet exactly as a
tailoring would render it (`master_text`, display dates, labels). One resolver, never a hand-built
copy. Returns null when the master cannot be resolved (then editing is off, as D4 does today).

**D5a still holds**: anything the gate allows must be visible in the diff and count as an edit, so
a structurally changed row can never sit in Bucket A. The diff (W2) counts structural changes.

**New bullet text** never enters the resume directly: `attestBullet` writes it into the master as a
new immutable version first (under its parent node), re-pins the row, then adds it by ref, exactly
as `attestSkill` does for skills. So FULL always contains it and the auditor can trace it.

## Types and signatures (stubs already in the code; W1 fills the bodies)

`tailoredEdits.ts` (W1):

```ts
export type BulletSection = 'experience' | 'projects' | 'education' | 'achievements' | 'certifications';
export type SectionKind = ResolvedResume['section_order'][number];
export type MoveDirection = 'up' | 'down';
export const DIFF_BULLET_SECTIONS  // becomes all five, same order as BULLET_SECTIONS
export function resolveFullMaster(master: MasterProfile, version: number): ResolvedResume | null;
export function tracesToMaster(previous: ResolvedResume, next: ResolvedResume, original: ResolvedResume, master: MasterProfile): boolean; // replaces onlyTextChanged
export function moveBullet(current: ResolvedResume, ref: string, direction: MoveDirection): EditOutcome;
export function moveSection(current: ResolvedResume, section: SectionKind, direction: MoveDirection): EditOutcome;
export function addMasterBullet(current: ResolvedResume, full: ResolvedResume, ref: string): EditOutcome;   // parent entry must be on the resume; inserted after the last sibling that precedes it in FULL
export function addMasterEntry(current: ResolvedResume, full: ResolvedResume, section: BulletSection, ref: string): EditOutcome; // with all its FULL bullets; inserted at FULL's relative position; section appended to section_order if absent
export function removeEntry(current: ResolvedResume, section: BulletSection, ref: string): EditOutcome;
export function entryLabel(section: BulletSection, entry: unknown): string; // "Aczen Technologies · Full Stack AI Engineer", "F1 Race Pace Predictor", "LeetCode"
export interface AddableBullet { readonly ref: string; readonly text: string; readonly section: BulletSection; readonly parentRef: string; readonly parentLabel: string }
export interface AddableEntry { readonly ref: string; readonly section: BulletSection; readonly label: string }
export function addableFromMaster(current: ResolvedResume, full: ResolvedResume): { readonly bullets: readonly AddableBullet[]; readonly entries: readonly AddableEntry[] };
```

`attestBullet.ts` (W1, new; mirror `attestSkill.ts`):

```ts
export interface AttestBulletArgs { applicationId; section: BulletSection; parentRef: string; text: string; current; original; tailorRefs; expectedUpdatedAt; newBulletId: string }
export type AttestBulletOutcome = { ok: true; resume; master; original; tailorRefs; bulletRef: string; updatedAt; eventRecorded } | { ok: false; message; masterInserted: boolean; stored?: StoredRow };
export async function attestBullet(client, args: AttestBulletArgs): Promise<AttestBulletOutcome>;
```

`saveTailoredEdit.ts` (W1): `EditEventKind` gains `'resume_move_bullet' | 'resume_move_section' |
'resume_add_bullet' | 'resume_add_entry' | 'resume_remove_entry' | 'resume_attest_bullet'`; the gate
call becomes `tracesToMaster`.

`DiffView.tsx` `EditAction` (stubs already added; W2 owns the file):

```ts
| { kind: 'move_bullet'; ref: string; direction: MoveDirection }
| { kind: 'move_section'; section: SectionKind; direction: MoveDirection }
| { kind: 'add_master_bullet'; ref: string }
| { kind: 'add_master_entry'; section: BulletSection; ref: string }
| { kind: 'remove_entry'; section: BulletSection; ref: string }
| { kind: 'attest_bullet'; section: BulletSection; parentRef: string; text: string }
```

## Ownership (no two writers touch one file)

| Writer | Owns |
|---|---|
| W1 core | `tailoredEdits.ts`, new `attestBullet.ts`, `saveTailoredEdit.ts`, tests `tailoredEdits.test.ts`, `saveTailoredEdit.test.ts`, `addSkill.test.ts`, new `attestBullet.test.ts`, `approvalEdits.test.ts` |
| W2 UI | `diffAdapter.ts`, `diffModel.ts`, `DiffView.tsx`, `DiffView.css`, `ApprovalQueuePage.tsx`, diff/UI tests (`addSkillUi.test.ts`, `coverage*.test.ts`, any `diff*.test.ts`, new `structureEditsUi.test.ts`) |
| W3 AI | `aiEdit.ts`, `AiEditPanel.tsx`, `AiEditPanel.css`, `resumeChat.ts`, `supabase/functions/resume-assist/*`, tests `aiEdit.test.ts`, `resumeChat.test.ts` |

Cross-file parity: `tailoredEdits.test.ts` regex-checks that `DIFF_BULLET_SECTIONS` equals
`diffAdapter.ts` `bulletGroups`. W1 sets the constant to all five; W2 adds achievements and
certifications to `bulletGroups` in the same order.

## AI chat ops (W3)

The AI's view gains: each bullet labelled with its entry (`b3 [Aczen Technologies · Full Stack AI
Engineer]: …`), achievements/certification bullets, the section order, and an AVAILABLE list of
master items not on the resume (`m0`… bullets with their entry, `n0`… whole entries). New ops:
`move {id, direction}`, `move_section {section, direction}`, `add_back {id: mN|nN}`,
`new_bullet {entry: eN, text}` (entries listed as `eN`). Auto-apply: move, move_section and
add_back apply by themselves (they only reuse true master text); `new_bullet` waits for a click,
like a skill the operator did not name, because applying it writes a new claim into the master.
