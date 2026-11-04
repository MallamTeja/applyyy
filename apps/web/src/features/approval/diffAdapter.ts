/* The adapter: schema shapes in, renderer view model out.
 *
 * One file stands between `@applyy/shared-types` and the diff view. Everything
 * upstream of it is the schema stream's contract; everything downstream is
 * presentation. The renderer imports nothing from the contract at all, which is
 * what lets it draw a fixture and a live row through the same code path - and
 * what makes the section 11 fixture a real regression test rather than a
 * mock-up that drifts from production.
 *
 * WHAT FABRICATION CAN ACTUALLY LOOK LIKE - worth knowing before reading the
 * matching logic below.
 *
 * Section 11's worked example is a skills line that gained "PostgreSQL" and
 * "Docker". Under the schema stream's contract that case is now UNREACHABLE:
 * `TailoredSkill` is `{ ref: NodeId }` with no text field, so there is nowhere
 * to type "Docker" that is not an id, and an id absent from the pinned master
 * fails the whole tailoring. Section 10 defense 1 is fully realised for skills -
 * the wrong answer cannot be expressed.
 *
 * That leaves exactly two vectors, and both are text fields:
 *   1. `ResolvedBullet.text`  - a real `ref` carrying a lying rewording.
 *   2. `ResolvedResume.summary` - prose, which the contract's own author names
 *      as the weakest point in the design, because prose cannot be constrained
 *      by refs the way a bullet can.
 *
 * So the fixture stays as the design brief and the renderer's test, but live
 * findings will land on bullets and summaries. The matching below is written
 * for that reality.
 */

import type {
  ApplicationRow,
  AuditFinding,
  JobRow,
  JobSourceRef,
  MasterProfile,
  ResolvedResume,
} from '../../data/contract';

import type {
  AddedSkill,
  DiffBulletSection,
  DiffEntry,
  DiffLine,
  DiffSection,
  DiffSectionKind,
  FlaggedClaim,
  ResumeDiff,
  TailoredRun,
} from './diffModel';
/* The one heading table, shared with the view so a change sentence and a heading name a section alike. */
import { SECTION_TITLE } from './diffModel';

/* THE PRODUCER'S matching rule, reached by relative path into the Deno tree (precedent:
   master-robots reaching the shared Retry-After parser). The same function chose these
   keywords in the tailor, so scoring them here cannot use a looser rule than selected them.
   Safe to bundle: the module is pure with zero imports. */
import { keywordAppearsIn } from '../../../../../supabase/functions/_shared/tailor/jd-keywords.ts';
/* T3: the ONE definition of "which master skill would supply this keyword" (shared with the page's
   add path and its tests), and the ONE structural equality the save boundary also uses, so the
   adapter's "skills changed" and the boundary's cannot disagree. tailoredEdits imports only types
   from diffModel, so this adds no import cycle. */
import { addableSkillFor, deepEqual } from './tailoredEdits.ts';
/* 2026-11-01: the ONE entry labeller and the ONE "what is in the master but not on the resume" rule,
   shared with the AI box, so the headings, the add-back offers and the AI's view cannot disagree. */
import { addableFromMaster, entryLabel } from './tailoredEdits.ts';

/* Everything the adapter needs. Passed as one object rather than five
 * positional parameters, because five positional strings and objects at a call
 * site is how the master and the tailored resume end up swapped. */
export interface DiffAdapterInput {
  /* The queue row: carries the findings, the coverage figure and the version. */
  readonly application: ApplicationRow;
  /* The job, for the title and company shown in the header. Both are UNTRUSTED
   * (they came from an ATS board), so both are rendered as React text children
   * and nothing else. */
  readonly job: Pick<JobRow, 'title' | 'company_name'> & {
    readonly discovered_via?: readonly string[] | null;
    readonly source_refs?: readonly JobSourceRef[] | null;
    readonly employment_type?: string | null;
    readonly work_arrangement?: string | null;
    readonly locations?: readonly string[] | null;
    readonly salary_min?: number | null;
    readonly salary_max?: number | null;
    readonly salary_currency?: string | null;
    /* Both UNTRUSTED, both from an ATS board, and both handled at the render
       site rather than sanitised here: the adapter's job is shape, not safety,
       and a "cleaned" string passed downstream invites the next caller to
       assume it is safe. */
    readonly apply_url?: string | null;
    readonly description_raw?: string | null;
  };
  /* The immutable snapshot the worker will render to PDF. What was approved is
   * byte-for-byte what gets sent, so this is the correct thing to review. */
  readonly resolved: ResolvedResume;
  /* The pinned master version, needed for the skills comparison: the resolved
   * resume carries only the SELECTED skills, and the operator needs to see what
   * was dropped as well as what was kept. */
  readonly master: MasterProfile;
  /* The tailor's resume rebuilt from tailor_refs + the pinned master (tailoredEdits.ts
   * rebuildOriginal). The ONLY thing an edit is measured against: "edited" is derived by
   * comparing `resolved` with this, never stored. Null when it cannot be rebuilt, which
   * disables editing on every line (D4) and otherwise leaves the diff exactly as before. */
  readonly original: ResolvedResume | null;
  /* FULL (2026-11-01): the whole pinned master resolved by the validator (tailoredEdits'
   * resolveFullMaster), the only source of "Add back" offers. Optional and nullable so callers that
   * predate it, and a master that cannot be resolved, simply get no offers, never a guess. */
  readonly full?: ResolvedResume | null;
}

/* --- Locating a finding inside a line -------------------------------- */

/* Split one line of tailored text into runs, given the claims flagged on it.
 *
 * The Auditor reports a finding as a quoted substring (`AuditFinding.claim`)
 * rather than as a token index, so the adapter has to find it. Splitting on the
 * claim rather than diffing the whole line keeps the marked region exactly as
 * wide as what the Auditor actually objected to - marking the whole line would
 * make a single invented word look like a wholly invented bullet, which is a
 * different and much worse accusation. */
function splitIntoRuns(
  text: string,
  claims: readonly string[],
  tracesTo: string,
  /* The verdict of the text AROUND the claims. 'traced' for the tailor's own text;
     'edited' for an operator edit that kept a flagged claim, so the kept claim still
     carves out as fabricated while the rest stays unaudited, never traced (R1).
     Defaulted so every pre-existing caller is unchanged. */
  baseVerdict: 'traced' | 'edited' = 'traced',
): { runs: TailoredRun[]; matched: string[] } {
  /* An edited run traces to nothing (the Auditor never read it); only traced text keeps the ref. */
  const baseTracesTo = baseVerdict === 'traced' ? tracesTo : null;
  /* Longest claims first. If the Auditor flagged both "Docker" and "Docker
   * Compose" on one line, matching the short one first would consume half of
   * the long one and leave "  Compose" unmatched and unmarked. */
  const ordered = [...claims].sort((a, b) => b.length - a.length);

  /* Which claims were actually located, reported back so the caller can list
   * the rest loudly instead of losing them. */
  const matched: string[] = [];

  /* Start with the whole line as a single traced run, then carve the flagged
   * claims out of it. Carving rather than assembling means any text the
   * Auditor did not object to keeps its traced verdict by default - the safe
   * reading, since the bullet's `ref` is guaranteed to resolve. */
  let runs: TailoredRun[] = [{ text, verdict: baseVerdict, tracesTo: baseTracesTo }];

  for (const claim of ordered) {
    /* Empty claims would match everywhere and split every run infinitely. */
    if (claim === '') continue;

    /* Track whether this claim landed anywhere in this line. */
    let located = false;

    runs = runs.flatMap((run): TailoredRun[] => {
      /* Never re-split an already-flagged run: a claim nested inside another
       * claim is one finding, not two, and re-splitting would double-count it
       * in the approval gate. */
      if (run.verdict === 'fabricated') return [run];

      /* Case-insensitive, because the Auditor quotes the JD's casing and the
       * Tailor may have written the resume's. */
      const index = run.text.toLowerCase().indexOf(claim.toLowerCase());
      if (index === -1) return [run];

      located = true;

      /* Slice from the run's own text, not the claim, so the marked run shows
       * the resume's actual casing rather than the Auditor's quotation. */
      const before = run.text.slice(0, index);
      const hit = run.text.slice(index, index + claim.length);
      const after = run.text.slice(index + claim.length);

      /* Empty edges are dropped rather than rendered as zero-width runs, which
       * would otherwise leave stray padding from the marker styles. */
      const pieces: TailoredRun[] = [];
      if (before !== '') {
        /* The left edge keeps the line's base verdict, traced or edited. */
        pieces.push({ text: before, verdict: baseVerdict, tracesTo: baseTracesTo });
      }
      /* The finding. `tracesTo: null` is not missing data - it IS the verdict. */
      pieces.push({ text: hit, verdict: 'fabricated', tracesTo: null });
      if (after !== '') {
        /* So does the right edge. */
        pieces.push({ text: after, verdict: baseVerdict, tracesTo: baseTracesTo });
      }
      return pieces;
    });

    if (located) matched.push(claim);
  }

  return { runs, matched };
}

/* Split an EDITED line: claims the operator's text still contains stay flagged; only
 * claims whose words are gone become superseded.
 *
 * Superseding every finding on any edit was an honesty hole: change one unrelated word,
 * keep "Docker", and the claim left the gate while the fabricated word shipped. An edit
 * supersedes a claim only by removing it. "Still contains" uses the same case-insensitive
 * indexOf that splitIntoRuns locates with, so a claim counted present here is one
 * splitIntoRuns can carve out. */
function splitEdited(
  text: string,
  claims: readonly string[],
  tracesTo: string,
): { runs: TailoredRun[]; matched: string[]; superseded: string[] } {
  /* Lowercased once; the per-claim test below compares against it. */
  const lower = text.toLowerCase();
  /* Claims whose words survived the edit: they still need a decision. */
  const present = claims.filter((claim) => lower.includes(claim.toLowerCase()));
  /* Claims whose words the edit removed: nothing of them is sent any more. */
  const superseded = claims.filter((claim) => !lower.includes(claim.toLowerCase()));
  /* Carve the survivors out of an 'edited' base, so they render and gate as fabricated. */
  const { runs, matched } = splitIntoRuns(text, present, tracesTo, 'edited');
  /* matched feeds the fail-loud bookkeeping; superseded goes to the line. */
  return { runs, matched, superseded };
}

/* --- Building the lines ----------------------------------------------- */

/* The fields every line carries when editing is NOT in play: the original could not be
 * rebuilt (D4). (Skills were also here until T3 made them selection-editable.) Spelled once so the "nothing is edited"
 * shape cannot differ between the three line builders. */
const NOT_EDITABLE = {
  /* No target: the UI offers no edit control. */
  editTarget: null,
  /* Without an original, nothing can be shown to differ from it. */
  editState: 'original',
  /* Unknown, and said so, rather than guessed from the current text. */
  originalText: null,
  /* Nothing was replaced, so nothing was superseded. */
  supersededClaims: [],
} as const;

/* The bullet node, derived from ResolvedResume because the contract seam does not
 * re-export it, and widening that seam is not this change's call. */
type ResolvedBullet = ResolvedResume['experience'][number]['bullets'][number];

/* All five bullet-holding sections, in print-default order. Experience, projects and education
 * have shown here since task 8; achievements and certifications joined on 2026-11-01, when the
 * review page started editing them (docs/ui/2026-11-01-review-structure-edits-contract.md): text
 * changed in a section this walk skips would be saved with editCount 0 and batch-approved unseen
 * (D5a). tailoredEdits.test.ts parses this body and requires it to equal DIFF_BULLET_SECTIONS, so
 * keep each entry in the `{ section: '<name>', entries: resume.<name> }` shape. A function so the
 * current and the original resume are walked by the same definition. */
function bulletGroups(resume: ResolvedResume) {
  /* `as const` keeps each section name a literal for the line id. */
  return [
    { section: 'experience', entries: resume.experience },
    { section: 'projects', entries: resume.projects },
    { section: 'education', entries: resume.education },
    { section: 'achievements', entries: resume.achievements },
    { section: 'certifications', entries: resume.certifications },
  ] as const;
}

/* The one thing all five entry shapes share, and all the walk reads besides the label. */
type WalkEntry = { readonly ref: string; readonly bullets: readonly ResolvedBullet[] };

/* A section's entries, or none. isResumeShape requires only experience, projects, education and
   skills to be arrays, so an older stored resume may carry no achievements at all; that must read
   as "no entries", never throw inside buildResumeDiff and blank the review screen. */
function entriesOf(entries: unknown): readonly WalkEntry[] {
  /* The array as typed; anything else is an absent section. */
  return Array.isArray(entries) ? (entries as readonly WalkEntry[]) : [];
}

/* Display order for one list of refs: the STORED order (what prints), with every ref only the
 * tailor had re-inserted right after its nearest preceding tailor sibling, so a removed bullet or
 * entry shows where it used to be. Pure, and O(n^2) on lists of a handful of refs. */
function mergeOrder(now: readonly string[], was: readonly string[]): string[] {
  /* Starts as exactly what prints. */
  const out = [...now];
  /* Refs already placed, so a kept ref is never inserted twice. */
  const placed = new Set(now);
  /* The tailor's refs in the tailor's order, so each removed one finds its predecessor. */
  was.forEach((ref, index) => {
    /* Kept refs are already in place. */
    if (placed.has(ref)) return;
    /* After the closest earlier tailor ref that is on screen; the top when there is none. */
    let at = 0;
    /* Walk backwards through the tailor's earlier refs. */
    for (let back = index - 1; back >= 0; back -= 1) {
      /* Where that earlier ref sits in the output, if it does. */
      const found = out.indexOf(was[back] as string);
      /* The first one found is the nearest. */
      if (found !== -1) {
        /* Right after it. */
        at = found + 1;
        /* Nearest found; stop looking. */
        break;
      }
    }
    /* Inserted, and remembered so a later removed sibling can anchor on it. */
    out.splice(at, 0, ref);
    /* Placed now. */
    placed.add(ref);
  });
  /* Stored order with the removed refs threaded back in. */
  return out;
}

/* The refs whose place among the KEPT refs (on both sides) differs from the tailor's: the moved
 * ones. Added and removed refs are not moves; they are counted as additions and removals. */
function movedRefs(now: readonly string[], was: readonly string[]): ReadonlySet<string> {
  /* Membership on each side. */
  const onWas = new Set(was);
  /* Same, for the stored side. */
  const onNow = new Set(now);
  /* The refs both sides kept, in stored order. */
  const keptNow = now.filter((ref) => onWas.has(ref));
  /* The same refs, in the tailor's order. */
  const keptWas = was.filter((ref) => onNow.has(ref));
  /* A ref whose position differs between the two orders has moved. */
  return new Set(keptNow.filter((ref, index) => keptWas[index] !== ref));
}

/* What the bullet walk hands back: the lines, the entries that group them, and the structural
 * changes it found. One walk produces all three so they cannot describe different resumes. */
interface BulletWalk {
  /* Every bullet line, in display order, section by section. */
  readonly lines: DiffLine[];
  /* Each bullet section's entries, in display order. */
  readonly entries: ReadonlyMap<DiffBulletSection, readonly DiffEntry[]>;
  /* One sentence per entry added, removed or reordered, and per entry whose bullets were reordered. */
  readonly changes: string[];
}

/* Every bullet, grouped by section and entry, with the master text beside it.
 *
 * `ResolvedBullet` carries `master_text` specifically so this screen needs no
 * second lookup - the contract's author put it there for the diff view.
 *
 * With an original (task 8) each entry's bullets are compared ref by ref with the tailor's
 * version of the SAME entry. Until 2026-11-01 the original was walked as the skeleton, which was
 * right while no edit could move anything; now bullets and entries can be moved, added and
 * removed, so the display follows the STORED order (what prints) and threads each removed item
 * back in where the tailor had it. An untouched resume walks exactly as before. */
function bulletLines(
  resolved: ResolvedResume,
  original: ResolvedResume | null,
  findingsByPath: ReadonlyMap<string, readonly AuditFinding[]>,
  matchedClaims: Set<string>,
  /* Out-parameter, like matchedClaims: findings accounted for as superseded, so the
     caller's fail-loud step does not ALSO report them as unlocated. */
  supersededKeys: Set<string>,
  /* Master bullets the resume lacks, keyed `section.parentRef`; empty when no add could be saved. */
  addableByParent: ReadonlyMap<string, readonly { readonly ref: string; readonly text: string }[]>,
): BulletWalk {
  /* Accumulated in display order, so the screen reads in print order. */
  const lines: DiffLine[] = [];
  /* Each section's entries, filled as the walk goes. */
  const entries = new Map<DiffBulletSection, DiffEntry[]>();
  /* Structural changes, in display order. */
  const changes: string[] = [];
  /* The tailor's sections, looked up by name below; null means D4 (nothing compared). */
  const tailorGroups = original === null ? null : bulletGroups(original);

  /* Section by section, in the one list the parity test pins. */
  for (const group of bulletGroups(resolved)) {
    /* What prints now. */
    const nowEntries = entriesOf(group.entries);
    /* What the tailor wrote; without an original (D4) the stored resume stands in, so nothing differs. */
    const wasEntries = tailorGroups === null ? nowEntries : entriesOf(tailorGroups.find((g) => g.section === group.section)?.entries);
    /* Both sides by ref, for one lookup per entry. */
    const nowByRef = new Map(nowEntries.map((entry) => [entry.ref, entry]));
    /* Same, for the tailor's side. */
    const wasByRef = new Map(wasEntries.map((entry) => [entry.ref, entry]));
    /* The section's heading, for its change sentences. */
    const title = SECTION_TITLE[group.section];
    /* Entries reordered among themselves: one change for the section. */
    if (movedRefs(nowEntries.map((e) => e.ref), wasEntries.map((e) => e.ref)).size > 0) changes.push(`Reordered ${title}`);
    /* This section's grouped entries. */
    const sectionEntries: DiffEntry[] = [];

    /* Every entry on either side, stored order first, removed ones where they were. */
    for (const entryRef of mergeOrder(nowEntries.map((e) => e.ref), wasEntries.map((e) => e.ref))) {
      /* The stored entry, if it is still on the resume. */
      const now = nowByRef.get(entryRef);
      /* The tailor's entry, if the tailor chose it. */
      const was = wasByRef.get(entryRef);
      /* Both sides, or one: added (stored only) or removed (tailor only). */
      const state: DiffEntry['state'] = now !== undefined && was !== undefined ? 'kept' : now !== undefined ? 'added' : 'removed';
      /* The shared labeller reads whichever side exists; one of the two always does here. */
      const label = entryLabel(group.section, now ?? was);
      /* A whole entry added or dropped is a structural change in its own right (D5a): a certification
         carries no bullets, so no line would ever count it otherwise. */
      if (state === 'added') changes.push(`Added ${label} (${title})`);
      /* Same, for a dropped entry. */
      if (state === 'removed') changes.push(`Removed ${label} (${title})`);
      /* The stored bullets in print order. */
      const nowBullets = now?.bullets ?? [];
      /* The tailor's bullets for the same entry; D4 compares the stored resume with itself. */
      const wasBullets = original === null ? nowBullets : (was?.bullets ?? []);
      /* Bullets the operator moved among the ones both sides kept. */
      const moved = movedRefs(nowBullets.map((b) => b.ref), wasBullets.map((b) => b.ref));
      /* One change per entry, however many bullets moved: the operator reordered one list. */
      if (moved.size > 0) changes.push(`Reordered bullets under ${label}`);
      /* The line ids this entry groups. */
      const lineIds: string[] = [];

      /* Every bullet on either side, in display order. */
      for (const bulletRef of mergeOrder(nowBullets.map((b) => b.ref), wasBullets.map((b) => b.ref))) {
        /* The path the Auditor would have used to name this bullet. Findings
         * are looked up by it, and anything that does not match falls through
         * to the unlocated list rather than being quietly ignored. */
        const path = group.section + '.' + entryRef + '.' + bulletRef;
        /* Grouped under its entry. */
        lineIds.push(path);
        /* The stored bullet, if it prints. */
        const stored = nowBullets.find((b) => b.ref === bulletRef);
        /* The tailor's bullet, if the tailor wrote it. */
        const tailor = wasBullets.find((b) => b.ref === bulletRef);
        /* Where every line in this entry belongs, for grouping and for Move. */
        const place = { section: group.section, entryRef, moved: moved.has(bulletRef) };
        /* This bullet's findings, by path. */
        const findings = findingsByPath.get(path) ?? [];
        /* Just the quoted claims. */
        const claims = findings.map((finding) => finding.claim);

        /* D4: without an original no edit can be recognised, so the line is built as it
           always was and offers no control. Here `stored` exists: both lists are the stored one. */
        if (original === null) {
          const { runs, matched } = splitIntoRuns((stored as ResolvedBullet).text, claims, bulletRef);
          /* Record what landed so the caller can compute the difference. */
          for (const claim of matched) matchedClaims.add(path + '::' + claim);
          lines.push({
            id: path,
            kind: 'bullet',
            masterText: (stored as ResolvedBullet).master_text,
            masterNodeId: bulletRef,
            tailoredRuns: runs,
            /* Nothing editable, nothing edited. */
            ...NOT_EDITABLE,
            /* Grouped like any other bullet; a D4 line never reads as moved. */
            ...place,
          });
          /* Done with this bullet. */
          continue;
        }

        /* Edit controls address the bullet by ref, whatever its state. */
        const editTarget = { kind: 'bullet', ref: bulletRef } as const;

        /* Stored but never the tailor's: added by the operator from the master (add_master_bullet,
           add_master_entry, attest_bullet), or divergence no page edit produces. Shown as EDITED -
           unaudited, forcing Bucket B - never traced: the Auditor never read a resume carrying it. */
        if (tailor === undefined) {
          /* `stored` exists: mergeOrder only yields refs from one side or the other. */
          const added = stored as ResolvedBullet;
          lines.push({
            /* Its path in the stored resume. */
            id: path,
            /* Still a bullet, so it renders and edits like one. */
            kind: 'bullet',
            /* Only the stored copy exists here; it is shown, never written (R0). */
            masterText: added.master_text,
            /* The ref the operator can look up on the Master Profile page. */
            masterNodeId: bulletRef,
            /* The operator-side verdict: unaudited text. */
            tailoredRuns: [{ text: added.text, verdict: 'edited', tracesTo: null }],
            /* Editable and removable, so the operator can act on it. */
            editTarget,
            /* Counted in editCount, which is what keeps the row out of Bucket A. */
            editState: 'edited',
            /* No tailor version exists to show or reset to; the view reads this null as "added". */
            originalText: null,
            /* The Auditor never read it, so it has no findings to supersede. */
            supersededClaims: [],
            /* Grouped under its entry. */
            ...place,
          });
          /* Done with this bullet. */
          continue;
        }

        /* Unchanged: the Auditor read exactly this text, so its findings still apply. */
        if (stored !== undefined && stored.text === tailor.text) {
          const { runs, matched } = splitIntoRuns(stored.text, claims, bulletRef);
          /* Same bookkeeping as the D4 path. */
          for (const claim of matched) matchedClaims.add(path + '::' + claim);
          lines.push({
            id: path,
            kind: 'bullet',
            /* The ORIGINAL's master_text - the validator's - never the stored copy: the
               ground-truth pane must come from the source R0 protects. */
            masterText: tailor.master_text,
            /* Same ref either side; the original's is the one the Auditor named. */
            masterNodeId: bulletRef,
            /* The Auditor's findings, carved out exactly as before task 8. */
            tailoredRuns: runs,
            /* Editable: an original exists to compare a future edit against. */
            editTarget,
            /* Unchanged from what the tailor wrote and the Auditor read. */
            editState: 'original',
            /* The tailor's text, for the edit box and Reset. */
            originalText: tailor.text,
            /* Nothing replaced, so nothing superseded; its findings are live runs above. */
            supersededClaims: [],
            /* Grouped, and flagged if the operator moved it. */
            ...place,
          });
          /* Done with this bullet. */
          continue;
        }

        /* Removed: every claim's words are gone, so all are superseded. Edited: only the
           claims the new text no longer contains; kept claims stay flagged runs. */
        const edited =
          stored === undefined
            ? { runs: [], matched: [], superseded: claims }
            : splitEdited(stored.text, claims, bulletRef);
        /* Kept claims that landed: located, so not unlocated, and they gate as fabricated. */
        for (const claim of edited.matched) matchedClaims.add(path + '::' + claim);
        /* Gone claims: shown on the line, never blocking, never unlocated. */
        for (const claim of edited.superseded) supersededKeys.add(path + '::' + claim);

        lines.push({
          id: path,
          kind: 'bullet',
          /* From the original, as above. */
          masterText: tailor.master_text,
          /* The ref the edit and Reset address. */
          masterNodeId: bulletRef,
          /* Edited: the operator's words as 'edited' runs, never traced (R1), with any
             kept claim carved out as fabricated. Removed: no runs - nothing is sent. */
          tailoredRuns: edited.runs,
          /* Kept on a removed line too: Reset needs somewhere to point. */
          editTarget,
          /* Absent from the stored resume means removed; present with other text means edited. */
          editState: stored === undefined ? 'removed' : 'edited',
          /* The tailor's text, for comparison and Reset. */
          originalText: tailor.text,
          /* Only the findings whose words the edit or removal actually took off the resume. */
          supersededClaims: edited.superseded,
          /* Grouped, and flagged if moved. */
          ...place,
        });
      }

      /* The entry itself, with the master bullets that could go back under it. A removed entry
         offers none: addMasterBullet needs the parent on the resume, so that offer could only fail;
         the whole entry is offered at section level instead. */
      sectionEntries.push({
        section: group.section,
        ref: entryRef,
        label,
        state,
        lineIds,
        addableBullets: state === 'removed' ? [] : (addableByParent.get(group.section + '.' + entryRef) ?? []),
      });
    }
    /* Published for the section layout. */
    entries.set(group.section, sectionEntries);
  }

  /* All three products of the one walk. */
  return { lines, entries, changes };
}

/* The skills line.
 *
 * Rendered as one line rather than a chip per skill because the operator reads
 * it as a list and needs to see the ORDER - leading with the JD's language is
 * most of what tailoring a skills section means. The master side shows every
 * master skill, so what was dropped is visible alongside what was kept. */
function skillsLine(resolved: ResolvedResume, master: MasterProfile, original: ResolvedResume | null): DiffLine {
  /* Every skill the master holds, so omissions are visible. */
  const all = master.skills.map((skill) => skill.name).join(', ');

  /* D4: no original means no way to tell an added skill from a chosen one, so the line is built
     exactly as before T3 - one traced run, no edit control. */
  if (original === null) {
    return {
      id: 'skills',
      kind: 'skills',
      masterText: all,
      masterNodeId: 'skills',
      /* ALWAYS one traced run, never split. A skill is chosen by id and carries
       * no text, so a fabricated skill is not expressible - there is nothing here
       * for a finding to attach to. Marking this line would imply a risk that
       * the contract has already made impossible. */
      tailoredRuns: [{ text: resolved.skills.map((skill) => skill.name).join(', '), verdict: 'traced', tracesTo: 'skills' }],
      /* Nothing editable, nothing edited. */
      ...NOT_EDITABLE,
      /* Nothing can be told apart as added. */
      addedSkills: [],
    };
  }

  /* The refs the TAILOR chose: the only skills that may read as traced. */
  const tailorRefs = new Set(original.skills.map((skill) => skill.ref));
  /* Everything on the resume the tailor did not choose: added by the operator (T3). Never
     traced, because the auditor never read a resume carrying them (R1). */
  const added = resolved.skills.filter((skill) => !tailorRefs.has(skill.ref));

  /* The runs, in TRUE print order: consecutive tailor skills merge into one traced run (so an
     untouched line is the same single run as before T3), and each added skill is its own
     EDITED run. Per-skill edited runs so coverage credits each added skill to "from your edits"
     on its own, and per-run matching means a keyword can never span a traced and an edited name.
     Walked in print order rather than "tailor's, then added" so the line never shows an order
     the PDF does not print, even for a stored list no page edit produced. */
  const runs: TailoredRun[] = [];
  /* Tailor skill names waiting to be flushed as one traced run. */
  let tracedNames: string[] = [];
  /* Close the pending traced group, if any, as one run. */
  const flushTraced = (): void => {
    /* Nothing pending: no zero-width run. */
    if (tracedNames.length === 0) return;
    /* Separated from whatever precedes it, with unmarked text. */
    if (runs.length > 0) runs.push({ text: ', ', verdict: null, tracesTo: null });
    /* The tailor's names, exactly as the pre-T3 line joined them. */
    runs.push({ text: tracedNames.join(', '), verdict: 'traced', tracesTo: 'skills' });
    /* Start a fresh group. */
    tracedNames = [];
  };
  /* Every printed skill, in print order. */
  for (const skill of resolved.skills) {
    /* A tailor skill joins the pending traced group. */
    if (tailorRefs.has(skill.ref)) {
      /* Merged with its traced neighbours. */
      tracedNames.push(skill.name);
      /* Next skill. */
      continue;
    }
    /* An added skill ends any traced group before it. */
    flushTraced();
    /* The separator is unmarked text: highlighting a comma as "edited by you" would be noise. */
    if (runs.length > 0) runs.push({ text: ', ', verdict: null, tracesTo: null });
    /* The operator's choice: 'edited', tracing to nothing the auditor checked. */
    runs.push({ text: skill.name, verdict: 'edited', tracesTo: null });
  }
  /* Whatever traced group is left at the end. */
  flushTraced();
  /* An empty skills list keeps the pre-T3 single empty traced run, so an untouched empty line is
     byte-for-byte the line it always was. */
  if (runs.length === 0) runs.push({ text: '', verdict: 'traced', tracesTo: 'skills' });

  /* Edited whenever the printed list is not exactly the tailor's: an addition, or any divergence
     no page edit produces (a dropped or reordered tailor skill). Fail closed into Bucket B. */
  const changed = !deepEqual(resolved.skills, original.skills);
  return {
    id: 'skills',
    kind: 'skills',
    masterText: all,
    masterNodeId: 'skills',
    tailoredRuns: runs,
    /* T3: editable by selection only - Add, Remove (added skills) and Reset. */
    editTarget: { kind: 'skills' },
    /* Counted in editCount when changed, which is what moves the row out of Bucket A (R2). */
    editState: changed ? 'edited' : 'original',
    /* The tailor's list as it printed, for comparison and what Reset restores. */
    originalText: original.skills.map((skill) => skill.name).join(', '),
    /* Skills carry no findings (see the D4 branch), so nothing can be superseded. */
    supersededClaims: [],
    /* What the UI renders as "added by you", each with its own Remove. */
    addedSkills: added.map((skill) => ({ ref: skill.ref, name: skill.name })),
    /* Every printed skill with its group, for the AI chat (2026-11-04): only on this editable
       branch, because the chat mounts only where a save can land. */
    printedSkills: resolved.skills.map((skill) => ({ ref: skill.ref, name: skill.name, category: skill.category })),
  };
}

/* The summary line, when there is one.
 *
 * `masterText` is null on purpose: a summary is drawn from several master nodes,
 * so it has no single counterpart to sit beside. The renderer says so rather
 * than showing an empty pane, because an empty master pane next to generated
 * prose reads as "wholly invented" when the truth is "assembled from several
 * real things, and therefore harder to check". */
function summaryLine(
  resolved: ResolvedResume,
  original: ResolvedResume | null,
  findingsByPath: ReadonlyMap<string, readonly AuditFinding[]>,
  matchedClaims: Set<string>,
  /* Out-parameter shared with bulletLines, for the same reason as there. */
  supersededKeys: Set<string>,
): DiffLine | null {
  /* Null and '' both mean "no summary"; normalised once so the comparisons below agree. */
  const now = resolved.summary === null || resolved.summary === '' ? null : resolved.summary;
  /* Superseded-ness is decided against `was`, so its null-handling must match `now`'s exactly. */
  /* The tailor's summary, by the same rule; null when there is no original at all. */
  const was = original === null || original.summary === null || original.summary === '' ? null : original.summary;
  /* No summary on either side means no line, rather than an empty one. */
  if (now === null && was === null) return null;

  const findings = findingsByPath.get('summary') ?? [];
  const claims = findings.map((finding) => finding.claim);

  /* Unchanged (or no original to compare with, D4): the Auditor read this text, so split
     its findings out of it exactly as before task 8. `now` is non-null here because a null
     `now` with an equal `was` returned above. */
  if (original === null || now === was) {
    const { runs, matched } = splitIntoRuns(now as string, claims, 'summary');
    /* Recorded so the fail-loud step knows which summary findings landed. */
    for (const claim of matched) matchedClaims.add('summary::' + claim);
    return {
      id: 'summary',
      kind: 'summary',
      masterText: null,
      masterNodeId: 'summary',
      tailoredRuns: runs,
      /* D4 leaves the line exactly as it was; otherwise it is editable and untouched. */
      ...(original === null
        ? NOT_EDITABLE
        : { editTarget: { kind: 'summary' }, editState: 'original', originalText: was, supersededClaims: [] }),
    };
  }

  /* Changed. Gone summary: every claim superseded. Edited summary: only claims the new
     text dropped; kept claims stay flagged (same rule and helper as bullets). */
  const edited = now === null ? { runs: [], matched: [], superseded: claims } : splitEdited(now, claims, 'summary');
  /* Kept claims that landed are located, so the fail-loud step does not repeat them. */
  for (const claim of edited.matched) matchedClaims.add('summary::' + claim);
  /* Gone claims are listed on the line instead of blocking. */
  for (const claim of edited.superseded) supersededKeys.add('summary::' + claim);
  return {
    /* Same id as the unchanged case, so the line keeps its React key across a save. */
    id: 'summary',
    /* Rendered as prose. */
    kind: 'summary',
    /* No single master counterpart, edited or not - see the note above this function. */
    masterText: null,
    /* The fixed pseudo-id the findings path uses for the summary. */
    masterNodeId: 'summary',
    /* Edited runs in the operator's words with kept claims carved out (R1). Gone: none. */
    tailoredRuns: edited.runs,
    editTarget: { kind: 'summary' },
    /* No summary now where the tailor wrote one reads as removed; anything else as edited. */
    editState: now === null ? 'removed' : 'edited',
    /* The tailor's summary, or null when the tailor wrote none. */
    originalText: was,
    /* Only the claims whose words are no longer sent. */
    supersededClaims: edited.superseded,
  };
}

/* --- The adapter ------------------------------------------------------- */

export function buildResumeDiff(input: DiffAdapterInput): ResumeDiff {
  const { application, job, resolved, master } = input;
  /* `?? null` because node-run tests and older callers may omit the field entirely; an
     absent original must mean D4 (nothing editable), never a crash or a guess. */
  const original = input.original ?? null;
  /* Same tolerance for FULL; an add is offered only with an original to measure it against too. */
  const full = original === null ? null : (input.full ?? null);
  /* What the master holds that the resume lacks; nothing when an add could not be saved. */
  const addable = full === null ? { bullets: [], entries: [] } : addableFromMaster(resolved, full);
  /* Bullet offers keyed by their true parent, so each entry finds its own in one lookup. */
  const addableByParent = new Map<string, { readonly ref: string; readonly text: string }[]>();
  /* Grouped once; order kept, so offers list in master order. */
  for (const bullet of addable.bullets) {
    /* Section plus parent ref: an entry ref is unique only within its section. */
    const key = bullet.section + '.' + bullet.parentRef;
    /* Only ref and text cross to the UI; the page re-reads FULL on Add, never trusting these. */
    addableByParent.set(key, [...(addableByParent.get(key) ?? []), { ref: bullet.ref, text: bullet.text }]);
  }

  /* Group findings by path once, so each line does a map lookup instead of a
   * scan of every finding. At 35 rows a day this is not a performance
   * decision - it is so the lookup key is written in exactly one place. */
  const findingsByPath = new Map<string, AuditFinding[]>();
  for (const finding of application.audit_findings) {
    const existing = findingsByPath.get(finding.path);
    if (existing === undefined) {
      findingsByPath.set(finding.path, [finding]);
    } else {
      existing.push(finding);
    }
  }

  /* Every `path::claim` the run-splitter managed to locate. The difference
   * against the full finding list is what could not be placed. */
  const matchedClaims = new Set<string>();
  /* Every `path::claim` whose line the operator edited or removed. These are accounted
   * for on their line as superseded, so they must not ALSO surface as unlocated - that
   * would block approval on text that is no longer on the resume. */
  const supersededKeys = new Set<string>();

  /* Summary first, then bullets, then skills - the order a resume is read in,
   * and the order the sections print. */
  const lines: DiffLine[] = [];
  const summary = summaryLine(resolved, original, findingsByPath, matchedClaims, supersededKeys);
  if (summary !== null) lines.push(summary);
  /* One walk yields the bullet lines, their entries and the structural changes, so the three agree. */
  const walk = bulletLines(resolved, original, findingsByPath, matchedClaims, supersededKeys, addableByParent);
  lines.push(...walk.lines);
  /* The original is passed so added skills (T3) can be told apart from the tailor's. */
  lines.push(skillsLine(resolved, master, original));

  /* What prints, in order: section_order exactly as the renderer reads it, known kinds only, once
     each. Not an array (a legacy row) means the renderer would refuse it, so nothing is printed. */
  const printedOrder = Array.isArray(resolved.section_order)
    ? /* Own keys only: `in` would also accept an inherited name like "constructor" from stored junk. */
      [...new Set(resolved.section_order)].filter((kind): kind is DiffSectionKind => Object.hasOwn(SECTION_TITLE, kind))
    : [];
  /* For the "is it printed" test below. */
  const printed = new Set<DiffSectionKind>(printedOrder);
  /* The section order the operator changed is one structural change (D5a), however far it moved. */
  const changes = original !== null && !deepEqual(resolved.section_order, original.section_order) ? ['Changed the section order'] : [];
  /* Whole-entry offers by section. */
  const entryOffers = (kind: DiffSectionKind) => addable.entries.filter((entry) => entry.section === kind).map((entry) => ({ ref: entry.ref, label: entry.label }));
  /* Every section with something to show: the printed ones in print order, then the unprinted ones
     that hold a line, an entry or an offer, so nothing selected is ever hidden from review. */
  const sections: DiffSection[] = [...printedOrder, ...(Object.keys(SECTION_TITLE) as DiffSectionKind[]).filter((kind) => !printed.has(kind))]
    .map((kind) => ({
      kind,
      printed: printed.has(kind),
      /* Summary and skills have no entries. */
      entries: kind === 'summary' || kind === 'skills' ? [] : (walk.entries.get(kind) ?? []),
      /* Same: offers exist only for bullet sections. */
      addableEntries: kind === 'summary' || kind === 'skills' ? [] : entryOffers(kind),
    }))
    .filter(
      (section) =>
        /* Printed sections always show, even empty, so the section-order list matches the PDF's. */
        section.printed ||
        /* An unprinted summary or skills line still exists and must be seen. */
        lines.some((line) => line.kind === section.kind) ||
        /* An unprinted bullet section with entries, or with something to add back. */
        section.entries.length > 0 ||
        section.addableEntries.length > 0,
    );
  /* Section order first, then the walk's per-section changes, in display order. */
  const structureChanges = [...changes, ...walk.changes];
  /* Coverage reads only lines that PRINT: a bullet in a section section_order does not name is not
     on the PDF, so crediting it would inflate the figure the operator trusts (same rule as the
     credentials check below). A legacy non-array order keeps the pre-2026-11-01 reading. */
  const counted = Array.isArray(resolved.section_order) ? lines.filter((line) => line.section === undefined || printed.has(line.section)) : lines;

  /* THE FAIL-LOUD STEP. Any finding whose claim text was not located inside a
   * rendered line becomes an unlocated claim rather than disappearing.
   *
   * Dropping one would mean the screen showed a clean, batch-approvable row
   * while the Auditor had flagged a claim - the gate failing open, silently,
   * which is worse than having no gate because the operator would trust it. */
  const unlocatedClaims: FlaggedClaim[] = application.audit_findings
    .filter(
      (finding) =>
        /* Located inside a line: it is a fabricated run there. */
        !matchedClaims.has(finding.path + '::' + finding.claim) &&
        /* Superseded by an edit or removal: it is listed on its line instead. */
        !supersededKeys.has(finding.path + '::' + finding.claim),
    )
    .map((finding) => ({
      key: 'unlocated::' + finding.path + '::' + finding.claim,
      text: finding.claim,
      /* No line to point at, which is the whole problem with these. */
      lineId: finding.path,
      /* Treated as prose for display purposes: an unlocated claim is most
       * likely a summary or bullet rewording the Auditor quoted differently
       * from how it was written. */
      lineKind: 'summary',
    }));

  return {
    applicationId: application.id,
    jobTitle: job.title,
    companyName: job.company_name,
    /* The snapshot's own pin, and only that. The `?? application.master_version` fallback was
     * removed in 7b (2026-10-08): that column is never written (null on every row), and the
     * page refuses an unpinned resume before it reaches here, so the fallback could only ever
     * substitute null for a missing pin - a silent answer where a refusal belongs. */
    masterVersion: resolved.master_version,
    coverage: {
      /* Half of the `tailored_hash` input, and what the Tailor chose to
       * emphasise. UNTRUSTED - these came out of a job description. */
      jdKeywords: application.selected_jd_keywords,
      /* Keywords the resolved resume genuinely contains: every one of these was
       * copied out of the pinned master by typed code, so any keyword present
       * in a traced run is honestly matched. */
      honestlyMatched: application.selected_jd_keywords.filter((keyword) =>
        /* QA item 3 (2026-10-08): a printed certification/achievement title is honest too. */
        keywordAppearsInTracedText(keyword, counted) || keywordAppearsInPrintedCredentials(keyword, resolved, master),
      ),
      /* Keywords that appear ONLY inside a flagged claim. This is the number
       * that stops the coverage figure rewarding fabrication. */
      matchedByFabrication: application.selected_jd_keywords.filter(
        (keyword) =>
          !keywordAppearsInTracedText(keyword, counted) &&
          /* Already honest via a credential: never double-counted as purchased. */
          !keywordAppearsInPrintedCredentials(keyword, resolved, master) &&
          keywordAppearsInFlaggedText(keyword, counted),
      ),
      /* Keywords that appear ONLY in the operator's edited text: not master-backed, not
         flagged, and kept apart from both so neither figure is credited with them. */
      matchedByEdit: application.selected_jd_keywords.filter(
        (keyword) =>
          !keywordAppearsInTracedText(keyword, counted) &&
          /* Honest via a credential wins over "from your edits", same as traced text does. */
          !keywordAppearsInPrintedCredentials(keyword, resolved, master) &&
          !keywordAppearsInFlaggedText(keyword, counted) &&
          keywordAppearsInEditedText(keyword, counted),
      ),
      /* T3: what the operator could add for each keyword missing from the resume entirely. */
      addable: addableByKeyword(application.selected_jd_keywords, counted, resolved, master, original),
    },
    lines,
    unlocatedClaims,
    /* Derived from the lines AND the structural changes, never passed in, so it cannot disagree with
       them (R2). The structural half is D5a: a moved or added-back item changes no line's words, and
       without it a reordered resume would count 0 and ride the batch button into Bucket A. */
    editCount: lines.filter((line) => line.editState !== 'original').length + structureChanges.length,
    /* The grouped layout the view draws. */
    sections,
    /* The sentences behind the structural half of editCount, so the count is never unexplained. */
    structureChanges,
    discoveredVia: job.discovered_via,
    sourceRefs: job.source_refs,
    employmentType: job.employment_type,
    workArrangement: job.work_arrangement,
    locations: job.locations,
    salaryMin: job.salary_min,
    salaryMax: job.salary_max,
    salaryCurrency: job.salary_currency,
    /* Passed through untouched. The screen needs the posting itself to be worth
       anything: see the note on ResumeDiff.applyUrl. */
    applyUrl: job.apply_url,
    jobDescription: job.description_raw,
  };
}

/* T3: for each JD keyword found in NO run of any verdict, the unselected master skill that would
 * supply it (or null: "Not in your master profile"). A keyword already present - traced, flagged
 * or edited - is left out, so the UI never offers to add what the resume already says.
 * Empty when there is no original (D4): an add could not be told apart or saved then, so
 * offering one would be a button that can only fail.
 * A Map because the keys are UNTRUSTED JD strings ("__proto__" on a plain object reads the
 * prototype). Exported so a test can drive it without building a whole diff. */
export function addableByKeyword(
  /* The JD keywords, in the row's order; duplicates collapse onto one Map key. */
  keywords: readonly string[],
  /* The finished lines, so "present" is judged by exactly the coverage figures' rule. */
  lines: readonly DiffLine[],
  /* The stored resume, whose skills an offer must not repeat. */
  resolved: ResolvedResume,
  /* The PINNED master, the only source an offer may come from. */
  master: MasterProfile,
  /* The tailor's version; null switches offers off (D4). */
  original: ResolvedResume | null,
): ReadonlyMap<string, AddedSkill | null> {
  /* Insertion-ordered, so the UI can list offers in the row's keyword order. */
  const offers = new Map<string, AddedSkill | null>();
  /* D4: nothing is addable without an original to measure the add against. */
  if (original === null) return offers;
  /* Each keyword once, in order. */
  for (const keyword of keywords) {
    /* Present in any run already: nothing to add for it. */
    if (keywordAppearsInTracedText(keyword, lines) || keywordAppearsInFlaggedText(keyword, lines) || keywordAppearsInEditedText(keyword, lines)) continue;
    /* Present in a printed certification/achievement title: honest already, nothing to offer. */
    if (keywordAppearsInPrintedCredentials(keyword, resolved, master)) continue;
    /* The single shared rule picks the skill; null is a real answer ("not in your master"). */
    const skill = addableSkillFor(keyword, resolved, master);
    /* Only ref and name cross to the UI: the page re-reads the master on Add, never trusting these. */
    offers.set(keyword, skill === null ? null : { ref: skill.ref, name: skill.name });
  }
  /* Read-only to callers. */
  return offers;
}

/* Does this JD keyword appear in text the master supports?
 *
 * WORD-BOUNDED, by the PRODUCER'S rule (changed 2026-10-06). This used to be a
 * case-insensitive substring, defended as "the same test an ATS scanner applies". On the
 * live GitLab row that credited "Go" via "Google Cloud Platform" and "Rails" via
 * "Tool Calling & Guardrails": 8/23 shown where 6/23 was honest. The keywords in
 * selected_jd_keywords were chosen by jd-keywords.ts with word-bounded, per-term
 * case rules; scoring them with a looser rule than the one that selected them inflates
 * the number the operator trusts. keywordAppearsIn is that same rule, imported rather
 * than copied, so the two sides cannot drift. Exported for test/keywordWordBounded.test.ts. */
export function keywordAppearsInTracedText(
  keyword: string,
  lines: readonly DiffLine[],
): boolean {
  /* Any one supported run is enough: the keyword is in the resume the master backs. */
  return lines.some((line) =>
    line.tailoredRuns.some(
      (run) =>
        /* Traced runs ONLY. This was `!== 'fabricated'` until task 8, which would now
           count the operator's edited runs as master-backed (R1). Text the Auditor
           doubts, and text it never read, cannot earn verified coverage. */
        run.verdict === 'traced' &&
        /* Per RUN, never over joined runs: joining could invent a word boundary that exists
           in neither run, and would mix traced with flagged text. The producer decides case
           and bounds, so no toLowerCase here. */
        keywordAppearsIn(keyword, run.text),
    ),
  );
}

/* Does this JD keyword appear in a PRINTED certification or achievement title? (QA item 3,
 * 2026-10-08: "SQL and Relational Databases" printed under Certifications, yet SQL read missing.)
 *
 * Counted as honest (master-traced) because nothing in it can be the operator's or the tailor's
 * words: only `label` and `description` are read, which the validator copies verbatim from the
 * master, which the edit boundary keeps equal to the master (tracesToMaster: an entry must
 * deep-equal FULL's except its bullets), and which are compared here against the PINNED master
 * node by ref - a stored string that differs from the master earns nothing. Bullets are left out:
 * they are bullet text the Auditor can flag, and since 2026-11-01 they are diff LINES (bulletGroups
 * walks all five sections), so they earn coverage there by their own verdict, traced or not.
 * "Printed" means the section is named in section_order,
 * exactly as render-resume-html.ts decides; a selected-but-unprinted section (the live row's
 * achievements) is not on the resume and earns nothing. Exported for test/printedCredentialsCoverage.test.ts. */
export function keywordAppearsInPrintedCredentials(
  /* One JD keyword, matched by the producer's rule like every other coverage figure. */
  keyword: string,
  /* The stored resume: which credentials it selected and which sections it prints. */
  resolved: ResolvedResume,
  /* The pinned master, the only source a credential string may be trusted from. */
  master: MasterProfile,
): boolean {
  /* Both credential kinds share the {id,label,description} shape on each side. */
  return (['certifications', 'achievements'] as const).some((section) => {
    /* Not printed: the renderer skips any section section_order does not name. Array guard
       because a legacy row may carry no section_order; then nothing is provably printed. */
    if (!Array.isArray(resolved.section_order) || !resolved.section_order.includes(section)) return false;
    /* Tolerates an absent array on an old row, read as "no credentials". */
    const entries = Array.isArray(resolved[section]) ? resolved[section] : [];
    /* Any one printed entry is enough. */
    return entries.some((entry) => {
      /* The master node by ref; the stored entry alone is not trusted. */
      /* Array guard: a minimal master without this section must read as "no credit", not throw
         inside buildResumeDiff, which now calls this for every keyword. */
      const node = (Array.isArray(master[section]) ? master[section] : []).find((m) => m.id === entry.ref);
      /* A ref the master lacks is not master-traced. */
      if (node === undefined) return false;
      /* Only strings that equal the master's AND are what got printed. */
      return [entry.label === node.label ? node.label : null, entry.description !== null && entry.description === (node.description ?? null) ? node.description : null]
        /* Drop the halves that did not match, and absent descriptions. */
        .filter((text): text is string => typeof text === 'string')
        /* Same word-bounded producer rule as the traced side. */
        .some((text) => keywordAppearsIn(keyword, text));
    });
  });
}

/* Does this JD keyword appear only inside something the Auditor flagged?
 * Same producer rule as above, so "purchased" coverage is counted as strictly as honest. */
export function keywordAppearsInFlaggedText(
  keyword: string,
  lines: readonly DiffLine[],
): boolean {
  /* Any flagged run containing it, by the same word-bounded rule. */
  return lines.some((line) =>
    line.tailoredRuns.some(
      (run) =>
        /* Only flagged runs: this is the fabrication-purchased side of the bar. */
        run.verdict === 'fabricated' &&
        /* Identical matcher to the traced side, so the two figures stay comparable. */
        keywordAppearsIn(keyword, run.text),
    ),
  );
}

/* Does this JD keyword appear in the operator's own edited text?
 * Same producer rule again, so "from your edits" is measured exactly like the other two. */
export function keywordAppearsInEditedText(
  keyword: string,
  lines: readonly DiffLine[],
): boolean {
  /* Any edited run containing it. */
  return lines.some((line) =>
    line.tailoredRuns.some(
      (run) =>
        /* Only the operator's runs: the third, unaudited segment of the bar. */
        run.verdict === 'edited' &&
        /* Per run, same matcher, same reasons as the traced side. */
        keywordAppearsIn(keyword, run.text),
    ),
  );
}
