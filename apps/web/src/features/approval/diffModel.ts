/* The view model the diff renderer consumes, plus the pure functions that
 * derive every verdict shown on screen.
 *
 * These are PRESENTATION types - the shape this component needs in order to
 * draw - not domain types. The Auditor's real output (`AuditFinding[]` on the
 * application row) and the resolved resume are mapped into these shapes by
 * `diffAdapter.ts`, and the renderer never sees either. That separation is what
 * lets the flagship screen be a pure component: it renders a fixture and a live
 * row through exactly the same code path.
 *
 * Everything on this screen that could disagree with itself is DERIVED here
 * rather than passed in. A row that carried both a stored `bucket: 'A'` and a
 * fabricated line would eventually render a green "safe to batch-approve"
 * badge above an oxblood stamp, and the operator would trust the badge.
 */

/* PRESENTATION-ONLY types, owned here rather than in the schema seam.
 *
 * The schema stream models the Auditor's output as `AuditFinding[]` on the
 * application row - a list of claims that traced to nothing. It does not model
 * "this run of text is traced" or "this row is Bucket A", because neither is
 * stored: both are things the renderer works out in order to draw. Declaring
 * them upstream would put display concerns in the schema contract, and
 * declaring them as domain types here would violate the seam's one rule. */

/* Per-run provenance, as the renderer needs it. `traced` resolves to a real
 * master node, `fabricated` resolves to nothing, `edited` is the operator's own
 * wording (task 8, R1). `edited` is its own arm rather than a flavour of `traced`
 * because nothing checked it against the master: the Auditor read the tailor's
 * version, never this one, so counting it as traced would launder an unaudited
 * sentence into "verified from master". */
export type TraceVerdict = 'traced' | 'fabricated' | 'edited';

/* What an edit on a line would write to. A closed union rather than a bare ref
 * string, because the summary has no ref (ResolvedResume.summary is a bare
 * string) and a magic 'summary' ref could collide with a real NodeId. Bullet text
 * and the summary take typed text; the skills arm (T3) takes only selection edits
 * of master skills. There is no arm that could name master_text, identity or a
 * version (R0). */
export type EditTarget =
  /* One bullet, named by its ref - refs are unique across the resume, so the ref alone locates it. */
  | { readonly kind: 'bullet'; readonly ref: string }
  /* The top-level summary paragraph. */
  | { readonly kind: 'summary' }
  /* The skills list as a whole (T3, 2026-10-08). Its only edits are SELECTION edits - add an
     unselected master skill, remove one the operator added, reset to the tailor's list - never
     typed text: a skill is a ref into the master, so there is no free text to write (R0).
     One target for the whole line because Reset restores the whole list. */
  | { readonly kind: 'skills' };

/* A skill as the UI needs it to render "added by you" with a Remove button: the master ref the
 * Remove action names, and the name it shows. No category: the UI never decides by it, and
 * every extra field is one more thing that could drift from the master. */
export interface AddedSkill {
  /* The MASTER skill's id, exactly as stored on the resume skill's `ref`. */
  readonly ref: string;
  /* The master's canonical name, as printed on the resume. */
  readonly name: string;
}

/* The two skill-selection actions the page performs, beyond DiffView's text EditAction
 * (T3). Declared HERE, not in DiffView.tsx, because the page must handle them before the
 * UI agent widens DiffView's EditAction union; once it does, both unions name the same
 * literals and the page's `EditAction | SkillEditAction` parameter accepts either source.
 * Each arm carries only a master ref: the page looks the skill up in the pinned master, so
 * the UI can never hand it a name or category to store. */
export type SkillEditAction =
  /* Put one unselected master skill onto the resume, appended after the tailor's own. */
  | { readonly kind: 'add_skill'; readonly ref: string }
  /* Take back one skill the operator added; the tailor's own skills are not removable here. */
  | { readonly kind: 'remove_skill'; readonly ref: string };

/* Which review path this row takes (section 11). DERIVED from whether any
 * finding exists - the schema stream's own comment on `audit_findings` says
 * "empty array means Bucket A", so storing it would be storing a duplicate that
 * can disagree with the findings sitting next to it. */
export type ReviewBucket = 'A' | 'B';

/* One run of text inside a tailored line.
 *
 * The tailored resume is split into runs rather than diffed character by
 * character on purpose. Section 10 defense 1 says the Tailor returns
 * REFERENCES into the master plus a reworded string per reference, so
 * provenance is already per-item; a character diff would throw that structure
 * away and force us to re-infer it, which is exactly the guesswork the design
 * eliminated. */
export interface TailoredRun {
  /* The text as it will appear in the submitted PDF. */
  readonly text: string;
  /* `traced` resolves to a real master node, `fabricated` resolves to nothing.
   * `null` means the run is carried over from the master untouched, which needs
   * no marking at all - marking unchanged text is how a diff view becomes
   * uniformly highlighted and therefore unreadable. */
  readonly verdict: TraceVerdict | null;
  /* The master node this run traces to, shown to the operator as a literal id
   * they can look up in the Master Profile page. Null when fabricated - and
   * that null IS the finding. */
  readonly tracesTo: string | null;
}

/* One aligned row of the comparison: what the master says, and what the Tailor
 * produced from it. */
export interface DiffLine {
  readonly id: string;
  /* Resume prose and a skills list are read differently - prose is read as a
   * sentence, a skills list is scanned token by token - so they are rendered
   * differently. This is the only reason the kind exists. */
  readonly kind: 'bullet' | 'skills' | 'summary';
  /* The master text, verbatim. This pane is never edited from this screen:
   * master_profiles is versioned and immutable (section 9), and editing it
   * here would silently create version N+1 mid-review.
   *
   * NULL for a tailored summary, and that null is meaningful rather than
   * missing data. A bullet rewords exactly one master bullet, so it has a
   * counterpart to sit beside. A summary is prose drawn from SEVERAL master
   * nodes, so there is no single line to compare it against - which is
   * precisely why prose is the weakest point in the honesty design and why the
   * Auditor gates summaries even where it lets other prose through. The
   * renderer says so rather than showing an empty pane. */
  readonly masterText: string | null;
  readonly masterNodeId: string;
  readonly tailoredRuns: readonly TailoredRun[];
  /* Where an edit on this line would land. `{kind:'skills'}` on the skills line when an
   * original exists (T3: add/remove master skills, never typed text). NULL for EVERY
   * line when the original could not be rebuilt (D4): without the
   * original there is no way to tell an edit from the tailor's text, so offering
   * the control would create edits nobody could later recognise as edits. */
  readonly editTarget: EditTarget | null;
  /* DERIVED by comparing the stored resume with the rebuilt original, never stored:
   * a stored flag could disagree with the text sitting next to it. */
  readonly editState: 'original' | 'edited' | 'removed';
  /* The tailor's text for this line, from the rebuilt original - what Reset
   * restores and what the operator compares their edit against. NULL for skills,
   * and when there is no original to read it from. */
  readonly originalText: string | null;
  /* Auditor claims made against the TAILOR's version of this line, which the
   * operator has since replaced or removed. Kept separate from the fabricated runs
   * on purpose: the text they quote is no longer on the resume, so blocking on them
   * would block on nothing, but dropping them would hide that the operator edited
   * precisely where the Auditor objected. Never flagged, never unlocated, never in
   * collectFlaggedClaims. */
  readonly supersededClaims: readonly string[];
  /* Skills line only (T3): the master skills the OPERATOR added, in resume order, so the UI
   * can render each as "added by you" with its own Remove. Empty on an untouched skills line.
   * Optional because only the skills line has such a list; absent on every other line, and on
   * hand-built fixtures that predate T3 (absent reads as "none added", the truthful reading). */
  readonly addedSkills?: readonly AddedSkill[];
}

/* Keyword coverage, section 18.7 - "so you can see whether the tailoring
 * actually did anything".
 *
 * Deliberately reported TWICE. A single coverage number rewards fabrication:
 * inventing PostgreSQL and Docker raises coverage from 50% to 100%, and a lone
 * "100%" on screen reads as a job well done. Splitting it into what the master
 * honestly supports versus what only the flagged claims supply makes the
 * incentive visible - the operator sees that the gain came from lying. */
export interface KeywordCoverage {
  /* Keywords lifted from the job description. UNTRUSTED input, constraint #17:
   * these strings are rendered as React text children only. They are never
   * handed to a raw-HTML escape hatch, never interpolated into a URL, href or
   * selector, and never evaluated. React escapes text children by default, so
   * plain `{keyword}` is the safe form and the only form used. */
  readonly jdKeywords: readonly string[];
  /* Keywords the master profile genuinely supports. */
  readonly honestlyMatched: readonly string[];
  /* Keywords present only because a flagged claim supplied them. */
  readonly matchedByFabrication: readonly string[];
  /* Keywords present only in the operator's own edited text - neither master-backed
   * nor flagged. A third figure rather than folded into either: adding them to
   * "honest" would credit unaudited wording as verified, and adding them to
   * "fabrication" would accuse the operator of the tailor's offence. */
  readonly matchedByEdit: readonly string[];
  /* T3: for each JD keyword the resume does NOT contain at all (in no traced, flagged or
   * edited run), the unselected master skill that would supply it, or null when the master
   * has none - the UI shows "Add" for the first and "Not in your master profile" for null.
   * A Map, not a Record: the keys are UNTRUSTED JD strings, and a plain object keyed by
   * "__proto__" or "constructor" would read the prototype instead of an entry.
   * Empty when editing is off (no original, D4), because an add could not be saved then.
   * Optional so coverage objects built before T3 (fixtures, older callers) stay valid. */
  readonly addable?: ReadonlyMap<string, AddedSkill | null>;
}

export interface ResumeDiff {
  readonly applicationId: string;
  readonly jobTitle: string;
  readonly companyName: string;
  /* Which immutable master version this was derived from. Shown because it is
   * what makes resume pinning meaningful six months later (section 9). */
  readonly masterVersion: number;
  readonly coverage: KeywordCoverage;
  readonly lines: readonly DiffLine[];
  /* Auditor findings the adapter could not locate inside any rendered line.
   *
   * This exists because the alternative is unacceptable. If a finding cannot be
   * matched to a line, the choice is to drop it or to surface it, and dropping
   * it would mean the screen showed a clean row while the Auditor had flagged a
   * claim - the exact failure the approval gate exists to prevent, delivered by
   * the gate itself. So an unmatched finding is listed separately, counted in
   * the bucket calculation, and still blocks approval until decided. Fail loud,
   * never fail clean. */
  readonly unlocatedClaims: readonly FlaggedClaim[];
  /* How many lines differ from the rebuilt original (edited or removed). Counted
   * once here so the bucket, the Review notice and the approval detail all read
   * the same number rather than each re-deriving it. */
  readonly editCount: number;
  readonly discoveredVia?: readonly string[] | null | undefined;
  readonly sourceRefs?: readonly import('../../data/contract').JobSourceRef[] | null | undefined;
  readonly employmentType?: string | null | undefined;
  readonly workArrangement?: string | null | undefined;
  readonly locations?: readonly string[] | null | undefined;
  readonly salaryMin?: number | null | undefined;
  readonly salaryMax?: number | null | undefined;
  readonly salaryCurrency?: string | null | undefined;
  /* WHERE THE POSTING LIVES. Added 2026-09-17.
   * This screen asks the operator to confirm a resume was tailored honestly
   * FOR A PARTICULAR JOB, and until now it showed them the resume and withheld
   * the job: no link, no description, nothing to check the claim against. The
   * question "is this bullet really about what they asked for" was unanswerable
   * without leaving the page and searching for the posting by hand.
   * UNTRUSTED - this URL came from an ATS board. It is rendered as an href with
   * rel="noopener noreferrer" and validated for scheme before use; never
   * interpolated anywhere a javascript: or data: URL could execute. */
  readonly applyUrl?: string | null | undefined;
  /* The posting's own text, as discovered. UNTRUSTED and HTML-bearing, so it is
   * stripped of tags and rendered as a React text child - never
   * dangerouslySetInnerHTML. This is the ground truth the tailored copy is
   * supposed to be answering. */
  readonly jobDescription?: string | null | undefined;
}

/* A single flagged claim, flattened out of the line structure so the alert band
 * can list claims rather than lines. The operator acknowledges CLAIMS - one
 * skills line carrying two inventions is two decisions, not one. */
export interface FlaggedClaim {
  /* Stable across renders so the acknowledgement set keys off it. */
  readonly key: string;
  readonly text: string;
  readonly lineId: string;
  readonly lineKind: DiffLine['kind'];
}

/* Every claim that traces to nothing: the runs found inside lines, plus any
 * finding the adapter could not place. Both must be here - a gate that only
 * counts the located ones can be opened while an unlocated finding stands. */
export function collectFlaggedClaims(diff: ResumeDiff): FlaggedClaim[] {
  /* flatMap rather than a nested loop with a push, because the result is a
   * projection of the input and reads as one. */
  const inLines = diff.lines.flatMap((line) =>
    line.tailoredRuns
      .filter((run) => run.verdict === 'fabricated')
      .map((run) => ({
        /* Line id plus text: unique because the same invented token appearing
         * on two lines is genuinely two claims to review. */
        key: line.id + '::' + run.text,
        text: run.text,
        lineId: line.id,
        lineKind: line.kind,
      })),
  );

  /* Unlocated findings last, so document order still holds for everything that
   * has a position, and the positionless ones are not interleaved arbitrarily. */
  return [...inLines, ...diff.unlocatedClaims];
}

/* Bucket B if ANY line carries an untraceable claim, Bucket A otherwise
 * (section 11). One function, called everywhere the bucket is displayed or
 * acted on, so the badge and the approve button can never disagree.
 *
 * An edited or removed line also forces B (R2). Bucket A means "the Auditor read
 * exactly what will be sent and found nothing"; after an edit the Auditor read a
 * DIFFERENT text, so its silence no longer covers this resume and the row must
 * not ride the batch button. */
export function deriveBucket(diff: ResumeDiff): ReviewBucket {
  /* Either reason alone is enough; neither may be traded against the other. */
  return collectFlaggedClaims(diff).length > 0 || diff.editCount > 0 ? 'B' : 'A';
}

/* Keyword coverage as a CLOSED UNION, so "nothing was measured" cannot be a number.
 * Until 2026-10-06 this returned `number` and the empty case returned 0, directly under a
 * comment saying 0 would be wrong: a row with no recorded JD keywords (selected_jd_keywords
 * '{}', because nothing wrote it) rendered "0% Match" and read as a failed tailoring. A
 * percent now exists only on the `measured` arm, so every caller must say what it shows
 * when there is none, and the compiler refuses one that forgets. */
export type CoverageMeasure =
  /* At least one JD keyword was recorded; percent is a real ratio, 0-100. */
  | { readonly kind: 'measured'; readonly percent: number }
  /* No JD keywords were recorded: coverage is undefined, neither 0% nor 100%. */
  | { readonly kind: 'unmeasured' };

/* Coverage as a whole percentage, rounded. Two figures, computed the same way,
 * so the pair is directly comparable on screen. */
export function coveragePercent(
  coverage: KeywordCoverage,
  include: 'honest' | 'withFabrication' | 'withEdits',
): CoverageMeasure {
  /* The denominator: how many JD keywords there were to match. */
  const total = coverage.jdKeywords.length;
  /* Nothing to divide by means nothing was measured; never a number, so never "0% Match". */
  if (total === 0) return { kind: 'unmeasured' };

  /* Honest counts only what the master supports; each other figure adds exactly one
     extra source on top of honest, so no figure ever mixes edits with fabrication. */
  const extra =
    include === 'withFabrication'
      ? coverage.matchedByFabrication.length
      : include === 'withEdits'
        ? /* `?? []` because coverage objects built before task 8 (test fixtures, older
             callers) carry no such field; absent means no edits were measured, which is
             the truthful zero, and a TypeError would blank the whole bar. */
          (coverage.matchedByEdit ?? []).length
        : 0;
  /* Honest is the base of every figure. */
  const matched = coverage.honestlyMatched.length + extra;

  /* Rounded so the badge, bar and legend all show one integer. */
  return { kind: 'measured', percent: Math.round((matched / total) * 100) };
}
