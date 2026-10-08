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
  DiffLine,
  FlaggedClaim,
  ResumeDiff,
  TailoredRun,
} from './diffModel';

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

/* Experience, projects and education all hold bullets with identical shape, so one
 * list of the three collections avoids three near-copies that would drift the moment
 * one of them needed a fix. Achievements and certifications are NOT here: the diff has
 * never shown them, and adding them would change every row's lines and coverage, which
 * is a separate decision from editing. A function so the current and the original
 * resume are walked by the same definition. */
function bulletGroups(resume: ResolvedResume) {
  /* `as const` keeps each section name a literal for the line id. */
  return [
    { section: 'experience', entries: resume.experience },
    { section: 'projects', entries: resume.projects },
    { section: 'education', entries: resume.education },
  ] as const;
}

/* Every bullet, in document order, with the master text beside it.
 *
 * `ResolvedBullet` carries `master_text` specifically so this screen needs no
 * second lookup - the contract's author put it there for the diff view.
 *
 * With an original (task 8) the ORIGINAL is walked as the skeleton. An edit changes
 * text and a removal deletes a bullet, but neither moves anything, so walking the
 * tailor's version keeps a removed bullet in its own place and turns every comparison
 * into "same ref - what does it say now". */
function bulletLines(
  resolved: ResolvedResume,
  original: ResolvedResume | null,
  findingsByPath: ReadonlyMap<string, readonly AuditFinding[]>,
  matchedClaims: Set<string>,
  /* Out-parameter, like matchedClaims: findings accounted for as superseded, so the
     caller's fail-loud step does not ALSO report them as unlocated. */
  supersededKeys: Set<string>,
): DiffLine[] {
  /* Accumulated in skeleton order, so the screen reads in the tailor's document order. */
  const lines: DiffLine[] = [];

  /* Current bullets by ref, so each original bullet finds its stored text in one lookup.
     Refs are unique across the resume (the validator refuses duplicates). */
  const currentByRef = new Map<string, ResolvedBullet>();
  /* The same three sections the skeleton walk covers, so the lookup and the walk agree. */
  for (const group of bulletGroups(resolved)) {
    /* Every entry in that section. */
    for (const entry of group.entries) {
      /* Index every stored bullet; the walk below consumes them by ref. */
      for (const bullet of entry.bullets) currentByRef.set(bullet.ref, bullet);
    }
  }

  /* No original: walk the stored resume, exactly as before task 8. */
  const skeleton = original ?? resolved;

  for (const group of bulletGroups(skeleton)) {
    for (const entry of group.entries) {
      for (const bullet of entry.bullets) {
        /* The path the Auditor would have used to name this bullet. Findings
         * are looked up by it, and anything that does not match falls through
         * to the unlocated list rather than being quietly ignored. */
        const path = group.section + '.' + entry.ref + '.' + bullet.ref;
        const findings = findingsByPath.get(path) ?? [];
        const claims = findings.map((finding) => finding.claim);

        /* D4: without an original no edit can be recognised, so the line is built as it
           always was and offers no control. */
        if (original === null) {
          const { runs, matched } = splitIntoRuns(bullet.text, claims, bullet.ref);
          /* Record what landed so the caller can compute the difference. */
          for (const claim of matched) matchedClaims.add(path + '::' + claim);
          lines.push({
            id: path,
            kind: 'bullet',
            masterText: bullet.master_text,
            masterNodeId: bullet.ref,
            tailoredRuns: runs,
            /* Nothing editable, nothing edited. */
            ...NOT_EDITABLE,
          });
          /* Done with this bullet. */
          continue;
        }

        /* Here `bullet` is the TAILOR's version; `now` is what is stored for that ref. */
        const now = currentByRef.get(bullet.ref);
        /* Consumed, so anything left afterwards is a bullet the original never had. */
        currentByRef.delete(bullet.ref);
        /* Edit controls address the bullet by ref, whatever its state. */
        const editTarget = { kind: 'bullet', ref: bullet.ref } as const;

        /* Unchanged: the Auditor read exactly this text, so its findings still apply. */
        if (now !== undefined && now.text === bullet.text) {
          const { runs, matched } = splitIntoRuns(now.text, claims, bullet.ref);
          /* Same bookkeeping as the no-original path. */
          for (const claim of matched) matchedClaims.add(path + '::' + claim);
          lines.push({
            id: path,
            kind: 'bullet',
            /* The ORIGINAL's master_text - the validator's - never the stored copy: the
               ground-truth pane must come from the source R0 protects. */
            masterText: bullet.master_text,
            /* Same ref either side; the original's is the one the Auditor named. */
            masterNodeId: bullet.ref,
            /* The Auditor's findings, carved out exactly as before task 8. */
            tailoredRuns: runs,
            /* Editable: an original exists to compare a future edit against. */
            editTarget,
            /* Unchanged from what the tailor wrote and the Auditor read. */
            editState: 'original',
            /* The tailor's text, for the edit box and Reset. */
            originalText: bullet.text,
            /* Nothing replaced, so nothing superseded; its findings are live runs above. */
            supersededClaims: [],
          });
          /* Done with this bullet. */
          continue;
        }

        /* Removed: every claim's words are gone, so all are superseded. Edited: only the
           claims the new text no longer contains; kept claims stay flagged runs. */
        const edited =
          now === undefined
            ? { runs: [], matched: [], superseded: claims }
            : splitEdited(now.text, claims, bullet.ref);
        /* Kept claims that landed: located, so not unlocated, and they gate as fabricated. */
        for (const claim of edited.matched) matchedClaims.add(path + '::' + claim);
        /* Gone claims: shown on the line, never blocking, never unlocated. */
        for (const claim of edited.superseded) supersededKeys.add(path + '::' + claim);

        lines.push({
          id: path,
          kind: 'bullet',
          /* From the original, as above. */
          masterText: bullet.master_text,
          /* The ref the edit and Reset address. */
          masterNodeId: bullet.ref,
          /* Edited: the operator's words as 'edited' runs, never traced (R1), with any
             kept claim carved out as fabricated. Removed: no runs - nothing is sent. */
          tailoredRuns: edited.runs,
          /* Kept on a removed line too: Reset needs somewhere to point. */
          editTarget,
          /* Absent from the stored resume means removed; present with other text means edited. */
          editState: now === undefined ? 'removed' : 'edited',
          /* The tailor's text, for comparison and Reset. */
          originalText: bullet.text,
          /* Only the findings whose words the edit or removal actually took off the resume. */
          supersededClaims: edited.superseded,
        });
      }
    }
  }

  /* Bullets stored now that the original never had. No edit on this page produces one, so
     this is divergence; it is shown as EDITED (unaudited, forces Bucket B) rather than as
     traced, because nothing proves the tailor wrote it. Fail closed, never clean. */
  if (original !== null) {
    /* Walk the STORED resume this time: the leftovers exist only there. */
    for (const group of bulletGroups(resolved)) {
      /* Entry by entry, so the leftovers keep their stored order. */
      for (const entry of group.entries) {
        /* Each stored bullet; the consumed ones are skipped just below. */
        for (const bullet of entry.bullets) {
          /* Only the leftovers the walk above did not consume. */
          if (!currentByRef.has(bullet.ref)) continue;
          lines.push({
            /* Its own path in the stored resume: the original has none to lend it. */
            id: group.section + '.' + entry.ref + '.' + bullet.ref,
            /* Still a bullet, so it renders and edits like one. */
            kind: 'bullet',
            /* Only the stored copy exists here; it is shown, never written (R0). */
            masterText: bullet.master_text,
            /* The ref the operator can look up on the Master Profile page. */
            masterNodeId: bullet.ref,
            /* The operator-side verdict: unaudited text. */
            tailoredRuns: [{ text: bullet.text, verdict: 'edited', tracesTo: null }],
            /* Editable and removable, so the operator can act on the divergence. */
            editTarget: { kind: 'bullet', ref: bullet.ref },
            /* Counted in editCount, which is what keeps the row out of Bucket A. */
            editState: 'edited',
            /* No tailor version exists to show or reset to. */
            originalText: null,
            supersededClaims: [],
          });
        }
      }
    }
  }

  return lines;
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
  lines.push(...bulletLines(resolved, original, findingsByPath, matchedClaims, supersededKeys));
  /* The original is passed so added skills (T3) can be told apart from the tailor's. */
  lines.push(skillsLine(resolved, master, original));

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
        keywordAppearsInTracedText(keyword, lines),
      ),
      /* Keywords that appear ONLY inside a flagged claim. This is the number
       * that stops the coverage figure rewarding fabrication. */
      matchedByFabrication: application.selected_jd_keywords.filter(
        (keyword) =>
          !keywordAppearsInTracedText(keyword, lines) &&
          keywordAppearsInFlaggedText(keyword, lines),
      ),
      /* Keywords that appear ONLY in the operator's edited text: not master-backed, not
         flagged, and kept apart from both so neither figure is credited with them. */
      matchedByEdit: application.selected_jd_keywords.filter(
        (keyword) =>
          !keywordAppearsInTracedText(keyword, lines) &&
          !keywordAppearsInFlaggedText(keyword, lines) &&
          keywordAppearsInEditedText(keyword, lines),
      ),
      /* T3: what the operator could add for each keyword missing from the resume entirely. */
      addable: addableByKeyword(application.selected_jd_keywords, lines, resolved, master, original),
    },
    lines,
    unlocatedClaims,
    /* Derived from the lines, never passed in, so it cannot disagree with them (R2). */
    editCount: lines.filter((line) => line.editState !== 'original').length,
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
