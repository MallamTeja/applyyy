/* The view model the diff renderer consumes, plus the pure functions that
 * derive every verdict shown on screen.
 *
 * These are PRESENTATION types - the shape this component needs in order to
 * draw - not domain types. Domain names (TraceVerdict, ReviewBucket) are
 * imported from the schema seam and never redeclared here. When
 * `@applyy/shared-types` lands, the Auditor's real output gets mapped into
 * these shapes in one adapter; the renderer does not change.
 *
 * Everything on this screen that could disagree with itself is DERIVED here
 * rather than passed in. A row that carried both a stored `bucket: 'A'` and a
 * fabricated line would eventually render a green "safe to batch-approve"
 * badge above an oxblood stamp, and the operator would trust the badge.
 */

import type { ReviewBucket, TraceVerdict } from '../../data/contract';

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
   * here would silently create version N+1 mid-review. */
  readonly masterText: string;
  readonly masterNodeId: string;
  readonly tailoredRuns: readonly TailoredRun[];
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
}

export interface ResumeDiff {
  readonly applicationId: string;
  readonly jobTitle: string;
  readonly company: string;
  /* Which immutable master version this was derived from. Shown because it is
   * what makes resume pinning meaningful six months later (section 9). */
  readonly masterVersion: number;
  readonly coverage: KeywordCoverage;
  readonly lines: readonly DiffLine[];
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

/* Every run that traces to nothing, in document order. */
export function collectFlaggedClaims(diff: ResumeDiff): FlaggedClaim[] {
  /* flatMap rather than a nested loop with a push, because the result is a
   * projection of the input and reads as one. */
  return diff.lines.flatMap((line) =>
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
}

/* Bucket B if ANY line carries an untraceable claim, Bucket A otherwise
 * (section 11). One function, called everywhere the bucket is displayed or
 * acted on, so the badge and the approve button can never disagree. */
export function deriveBucket(diff: ResumeDiff): ReviewBucket {
  return collectFlaggedClaims(diff).length > 0 ? 'B' : 'A';
}

/* Coverage as a whole percentage, rounded. Two numbers, computed the same way,
 * so the pair is directly comparable on screen. */
export function coveragePercent(
  coverage: KeywordCoverage,
  include: 'honest' | 'withFabrication',
): number {
  const total = coverage.jdKeywords.length;
  /* No keywords extracted means coverage is undefined, not zero - returning 0
   * would render a red empty bar and read as a tailoring failure. */
  if (total === 0) return 0;

  const matched =
    include === 'honest'
      ? coverage.honestlyMatched.length
      : coverage.honestlyMatched.length + coverage.matchedByFabrication.length;

  return Math.round((matched / total) * 100);
}
