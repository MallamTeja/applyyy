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
  DiffLine,
  FlaggedClaim,
  ResumeDiff,
  TailoredRun,
} from './diffModel';

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
): { runs: TailoredRun[]; matched: string[] } {
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
  let runs: TailoredRun[] = [{ text, verdict: 'traced', tracesTo }];

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
        pieces.push({ text: before, verdict: 'traced', tracesTo });
      }
      /* The finding. `tracesTo: null` is not missing data - it IS the verdict. */
      pieces.push({ text: hit, verdict: 'fabricated', tracesTo: null });
      if (after !== '') {
        pieces.push({ text: after, verdict: 'traced', tracesTo });
      }
      return pieces;
    });

    if (located) matched.push(claim);
  }

  return { runs, matched };
}

/* --- Building the lines ----------------------------------------------- */

/* Every bullet in the resolved resume, in document order, with the master text
 * beside it.
 *
 * `ResolvedBullet` carries `master_text` specifically so this screen needs no
 * second lookup - the contract's author put it there for the diff view. */
function bulletLines(
  resolved: ResolvedResume,
  findingsByPath: ReadonlyMap<string, readonly AuditFinding[]>,
  matchedClaims: Set<string>,
): DiffLine[] {
  const lines: DiffLine[] = [];

  /* Experience, projects and education all hold bullets with identical shape,
   * so one loop over the three collections avoids three near-copies that would
   * drift the moment one of them needed a fix. */
  const bulletGroups = [
    { section: 'experience', entries: resolved.experience },
    { section: 'projects', entries: resolved.projects },
    { section: 'education', entries: resolved.education },
  ] as const;

  for (const group of bulletGroups) {
    for (const entry of group.entries) {
      for (const bullet of entry.bullets) {
        /* The path the Auditor would have used to name this bullet. Findings
         * are looked up by it, and anything that does not match falls through
         * to the unlocated list rather than being quietly ignored. */
        const path = group.section + '.' + entry.ref + '.' + bullet.ref;
        const findings = findingsByPath.get(path) ?? [];
        const claims = findings.map((finding) => finding.claim);

        const { runs, matched } = splitIntoRuns(bullet.text, claims, bullet.ref);
        /* Record what landed so the caller can compute the difference. */
        for (const claim of matched) matchedClaims.add(path + '::' + claim);

        lines.push({
          id: path,
          kind: 'bullet',
          masterText: bullet.master_text,
          masterNodeId: bullet.ref,
          tailoredRuns: runs,
        });
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
function skillsLine(resolved: ResolvedResume, master: MasterProfile): DiffLine {
  /* Selected skills, in the order they will print. */
  const selected = resolved.skills.map((skill) => skill.name).join(', ');
  /* Every skill the master holds, so omissions are visible. */
  const all = master.skills.map((skill) => skill.name).join(', ');

  return {
    id: 'skills',
    kind: 'skills',
    masterText: all,
    masterNodeId: 'skills',
    /* ALWAYS one traced run, never split. A skill is chosen by id and carries
     * no text, so a fabricated skill is not expressible - there is nothing here
     * for a finding to attach to. Marking this line would imply a risk that
     * the contract has already made impossible. */
    tailoredRuns: [{ text: selected, verdict: 'traced', tracesTo: 'skills' }],
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
  findingsByPath: ReadonlyMap<string, readonly AuditFinding[]>,
  matchedClaims: Set<string>,
): DiffLine | null {
  /* No summary section means no line, rather than an empty one. */
  if (resolved.summary === null || resolved.summary === '') return null;

  const findings = findingsByPath.get('summary') ?? [];
  const claims = findings.map((finding) => finding.claim);

  const { runs, matched } = splitIntoRuns(resolved.summary, claims, 'summary');
  for (const claim of matched) matchedClaims.add('summary::' + claim);

  return {
    id: 'summary',
    kind: 'summary',
    masterText: null,
    masterNodeId: 'summary',
    tailoredRuns: runs,
  };
}

/* --- The adapter ------------------------------------------------------- */

export function buildResumeDiff(input: DiffAdapterInput): ResumeDiff {
  const { application, job, resolved, master } = input;

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

  /* Summary first, then bullets, then skills - the order a resume is read in,
   * and the order the sections print. */
  const lines: DiffLine[] = [];
  const summary = summaryLine(resolved, findingsByPath, matchedClaims);
  if (summary !== null) lines.push(summary);
  lines.push(...bulletLines(resolved, findingsByPath, matchedClaims));
  lines.push(skillsLine(resolved, master));

  /* THE FAIL-LOUD STEP. Any finding whose claim text was not located inside a
   * rendered line becomes an unlocated claim rather than disappearing.
   *
   * Dropping one would mean the screen showed a clean, batch-approvable row
   * while the Auditor had flagged a claim - the gate failing open, silently,
   * which is worse than having no gate because the operator would trust it. */
  const unlocatedClaims: FlaggedClaim[] = application.audit_findings
    .filter(
      (finding) => !matchedClaims.has(finding.path + '::' + finding.claim),
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
    /* The row's pinned version, falling back to the snapshot's own. They should
     * agree; if they do not, the snapshot is what the worker will actually
     * render, so it is the honest number to show. */
    masterVersion: application.master_version ?? resolved.master_version,
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
    },
    lines,
    unlocatedClaims,
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

/* Does this JD keyword appear in text the master supports?
 *
 * Case-insensitive substring, which is the same test an ATS keyword scanner
 * applies - so the number on screen reflects what the machine reading the PDF
 * will actually see rather than a stricter definition of our own. */
function keywordAppearsInTracedText(
  keyword: string,
  lines: readonly DiffLine[],
): boolean {
  const needle = keyword.toLowerCase();
  return lines.some((line) =>
    line.tailoredRuns.some(
      (run) =>
        run.verdict !== 'fabricated' &&
        run.text.toLowerCase().includes(needle),
    ),
  );
}

/* Does this JD keyword appear only inside something the Auditor flagged? */
function keywordAppearsInFlaggedText(
  keyword: string,
  lines: readonly DiffLine[],
): boolean {
  const needle = keyword.toLowerCase();
  return lines.some((line) =>
    line.tailoredRuns.some(
      (run) =>
        run.verdict === 'fabricated' &&
        run.text.toLowerCase().includes(needle),
    ),
  );
}
