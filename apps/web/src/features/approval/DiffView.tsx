/* THE DIFF VIEW - master versus tailored, side by side.
 *
 * This is the most important screen in the product. Everything upstream of it
 * is machinery; this is where a human decides whether something honest gets
 * sent. PROJECT_PLAN.md section 11 is the design brief.
 *
 * The one thing this screen exists to do: make TWO KINDS OF EDIT impossible to
 * confuse.
 *
 *   A bullet reworded into the JD's language - same project, same 500 users,
 *   same tech - is SAFE. It gets a QUIET treatment on purpose. Safe content
 *   must not compete for attention with dangerous content, and a diff where
 *   every change is highlighted the same way is a diff nobody reads.
 *
 *   A skills line that gained "PostgreSQL" and "Docker" because the JD asked
 *   for them is FABRICATION. It gets oxblood, a heavy underline, its own dark
 *   alert band, and a forced per-claim decision. If it wins the interview, the
 *   first technical question ends it - worse than never applying.
 *
 * Two visual LANGUAGES, not two shades of one. Different colour, different
 * weight, different structure, different required action.
 *
 * The structural part matters more than the colour. Approve stays DISABLED
 * until every flagged claim has an explicit decision recorded against it. That
 * is section 10 defense 1 applied to the interface: prefer designs where the
 * wrong answer cannot be expressed over designs that ask nicely. A tired
 * operator at row 30 of 35 cannot skim past this gate, because there is no
 * path through it that does not involve reading each claim.
 */

import { useMemo, useState } from 'react';
import type { ReactElement } from 'react';

import type { DiffLine, FlaggedClaim, ResumeDiff, TailoredRun } from './diffModel';
import {
  collectFlaggedClaims,
  coveragePercent,
  deriveBucket,
} from './diffModel';
import { StatusBadge } from '../../app/StatusBadge';
import { SourceBadge } from '../../app/SourceBadge';
import type { DiscoverySource } from '../../data/contract';

import './DiffView.css';

/* Two named outcomes per claim, not a single acknowledgement checkbox. */
export type ClaimDecision = 'remove' | 'keep';

/* Pure presentation component - no data access, no Supabase. */
export interface DiffViewProps {
  readonly diff: ResumeDiff;
  readonly onApprove: (decisions: ReadonlyMap<string, ClaimDecision>) => void;
  readonly onReject: (reason: string) => void;
}

/* --- The job being approved against ------------------------------------- */

/* Only ever produce an href for a URL we have proved is http(s).
 *
 * WHY A HELPER AND NOT A REGEX AT THE CALL SITE: `apply_url` is attacker-
 * influenced. It reaches us from a job board, and commit 2921bca already had to
 * validate apply URLs coming out of untrusted LinkedIn post text. A string
 * beginning `javascript:` in an href executes on click, and `data:` can carry a
 * whole document; both defeat rel="noopener" entirely, because the navigation
 * never leaves the page. Parsing with the URL constructor and allowlisting the
 * two schemes we want is the check that cannot be fooled by casing, whitespace
 * or percent-encoding the way a substring test can.
 * Returns null rather than a sanitised string, so the caller has to handle
 * "no safe link" explicitly instead of rendering a dead anchor. */
function safeHttpUrl(raw: string | null | undefined): string | null {
  /* Nothing to validate. Not an error - most rows have a URL, some do not. */
  if (typeof raw !== 'string' || raw.trim().length === 0) return null;
  try {
    const parsed = new URL(raw.trim());
    /* The allowlist. Anything else - javascript:, data:, file:, blob: - is
       refused rather than escaped, because there is no safe rendering of a
       scheme this screen has no reason to open. */
    return parsed.protocol === 'https:' || parsed.protocol === 'http:'
      ? parsed.href
      : null;
  } catch {
    /* Unparseable. Treated exactly like an unsafe scheme: no link. */
    return null;
  }
}

/* The posting itself, beside the resume that claims to answer it.
 *
 * WHY THIS EXISTS AT ALL: this screen asks the operator to confirm a resume was
 * tailored honestly FOR A PARTICULAR JOB, and until 2026-09-17 it showed them
 * the resume and withheld the job. "Is this bullet really about what they asked
 * for?" could not be answered without leaving the page to find the posting by
 * hand - so in practice it was answered by assuming yes, which is the habit the
 * whole gate exists to prevent.
 *
 * The description is COLLAPSED by default. Expanded, it would push the
 * fabrication alert below the fold, and nothing may outrank that band. */
function JobPosting({ diff }: { readonly diff: ResumeDiff }): ReactElement | null {
  /* Local, because whether one operator expanded one posting is not state any
     other part of the app has a reason to know about. */
  const [expanded, setExpanded] = useState(false);

  /* Validated once per render rather than at each use site. */
  const href = safeHttpUrl(diff.applyUrl);

  /* Tags stripped rather than rendered: this text came from a job board and is
     UNTRUSTED. Stripping here and passing a plain string to a React text child
     means there is no path by which markup in a posting reaches the DOM. */
  const description =
    typeof diff.jobDescription === 'string'
      ? diff.jobDescription.replace(/<[^>]*>?/gm, ' ').replace(/\s+/g, ' ').trim()
      : '';

  /* Render nothing at all rather than an empty panel: a box saying "no job
     details" is noise on a screen where everything visible must be worth
     reading. */
  if (href === null && description.length === 0) return null;

  return (
    <section className="job-posting" aria-labelledby={`posting-${diff.applicationId}`}>
      <div className="job-posting__head">
        <h3 id={`posting-${diff.applicationId}`} className="job-posting__title">
          The posting this was written for
        </h3>
        {/* The link is the more valuable of the two, so it sits in the header
            where it is reachable without expanding anything. */}
        {href !== null && (
          <a
            className="button button--secondary button--small"
            href={href}
            target="_blank"
            rel="noopener noreferrer"
          >
            Open the original posting
          </a>
        )}
      </div>

      {description.length > 0 && (
        <>
          {/* A real button, not a div with onClick: this has to be reachable by
              keyboard, and aria-expanded is what tells a screen reader whether
              the text below is currently showing. */}
          <button
            type="button"
            className="button button--ghost button--small job-posting__toggle"
            aria-expanded={expanded}
            aria-controls={`posting-body-${diff.applicationId}`}
            onClick={() => setExpanded((open) => !open)}
          >
            {expanded ? 'Hide the job description' : 'Read the job description'}
          </button>

          {/* `hidden` rather than unmounting, so an operator who expands, reads,
              collapses and expands again does not lose their scroll position. */}
          <p
            id={`posting-body-${diff.applicationId}`}
            className="job-posting__body"
            hidden={!expanded}
          >
            {description}
          </p>
        </>
      )}
    </section>
  );
}

/* --- Coverage ---------------------------------------------------------- */

/* Two-segment bar: honest coverage vs coverage purchased by fabrication.
   Exported for the test that pins the unmeasured branch (test/coverageUnmeasured.test.ts). */
export function CoverageBar({ diff }: { readonly diff: ResumeDiff }): ReactElement {
  /* Coverage the master genuinely supports. */
  const honestMeasure = coveragePercent(diff.coverage, 'honest');
  /* Coverage including the flagged claims, which is what would actually be
   * submitted if the operator approved blindly. */
  const totalMeasure = coveragePercent(diff.coverage, 'withFabrication');

  /* NOT MEASURED IS A STATE, NOT A NUMBER. Same denominator for both figures, so they are
     unmeasured together; checking both lets the compiler narrow each to its percent below.
     No bar, no badge and no "verified claims" line: each of those would state a result
     about keywords that were never recorded. */
  if (honestMeasure.kind === 'unmeasured' || totalMeasure.kind === 'unmeasured') {
    return (
      <div className="coverage coverage--unmeasured">
        <div className="coverage__header-row">
          <h3 className="coverage__title">ATS Match Score</h3>
        </div>
        {/* Says what is missing and why, so it reads as a gap in the data, not a verdict. */}
        <p className="coverage__unmeasured">
          ATS keyword score: not measured for this application. No job-description keywords were recorded, so there is nothing to score.
        </p>
      </div>
    );
  }

  /* Narrowed to measured above, so these are real ratios. */
  const honest = honestMeasure.percent;
  /* Includes flagged matches; never below honest, since it adds to the same numerator. */
  const total = totalMeasure.percent;
  /* The purchased portion is the gap between them. */
  const purchased = total - honest;

  /* Keywords missing from both master and tailored */
  const matchedSet = new Set([
    ...diff.coverage.honestlyMatched,
    ...diff.coverage.matchedByFabrication,
  ]);
  const missingKeywords = diff.coverage.jdKeywords.filter((k) => !matchedSet.has(k));

  return (
    <div className="coverage">
      <div className="coverage__header-row">
        <h3 className="coverage__title">ATS Match Score</h3>
        <span className="coverage__ats-badge">{honest}% Match</span>
      </div>

      {/* The track. aria attributes carry the honest number, because that is
          the one that describes the resume the operator can defend. */}
      <div
        className="coverage__track"
        role="img"
        aria-label={
          honest +
          '% of job-description keywords are supported by your master profile' +
          (purchased > 0
            ? '; a further ' + purchased + '% comes only from flagged claims'
            : '')
        }
      >
        {/* Forest segment: earned. */}
        <span
          className="coverage__fill coverage__fill--honest"
          style={{ width: honest + '%' }}
        />
        {/* Oxblood segment: purchased with fabrication. Rendered only when it
            exists, so a clean row shows a single uninterrupted bar. */}
        {purchased > 0 ? (
          <span
            className="coverage__fill coverage__fill--purchased"
            style={{ width: purchased + '%' }}
          />
        ) : null}
      </div>

      <p className="coverage__legend">
        {/* The honest figure leads, because it is the real one. */}
        <span className="coverage__stat coverage__stat--honest">
          {honest}% verified from master
        </span>
        {/* The purchased figure is stated as an addition, not a total, so it
            never reads as an achievement. */}
        {purchased > 0 ? (
          <span className="coverage__stat coverage__stat--purchased">
            plus {purchased}% unverified / flagged
          </span>
        ) : (
          <span className="coverage__stat">100% verified claims</span>
        )}
      </p>

      {/* JD Keyword chips: Matched, Flagged, and Missing */}
      <div className="coverage__keywords">
        {diff.coverage.honestlyMatched.map((kw) => (
          <span key={kw} className="kw-chip kw-chip--matched" title="Verified in master resume">
            ✓ {kw}
          </span>
        ))}
        {diff.coverage.matchedByFabrication.map((kw) => (
          <span key={kw} className="kw-chip kw-chip--flagged" title="Flagged untraced claim">
            ⚠ {kw}
          </span>
        ))}
        {missingKeywords.map((kw) => (
          <span key={kw} className="kw-chip kw-chip--missing" title="Missing from resume">
            ✕ {kw}
          </span>
        ))}
      </div>
    </div>
  );
}

/* --- Fabrication alert ------------------------------------------------- */

/* Dark-surface alert for untraceable claims. Single-use alarm surface. */
function FabricationAlert({
  claims,
  masterVersion,
  decisions,
  onDecide,
}: {
  readonly claims: readonly FlaggedClaim[];
  readonly masterVersion: number;
  readonly decisions: ReadonlyMap<string, ClaimDecision>;
  readonly onDecide: (key: string, decision: ClaimDecision) => void;
}): ReactElement {
  /* Name the first claim in the consequence sentence. A specific sentence -
   * "the first question is about your Docker setup" - lands where a generic
   * warning about fabrication does not. `noUncheckedIndexedAccess` makes the
   * guard mandatory, and the fallback keeps the sentence grammatical if the
   * list is ever empty. */
  const firstClaim = claims[0];
  const exampleClaim = firstClaim === undefined ? 'one of these' : firstClaim.text;

  return (
    <section className="alarm" aria-labelledby="alarm-heading">
      <h3 id="alarm-heading" className="alarm__heading">
        {/* A numeral, not a word: this line is scanned, not read. */}
        {claims.length} {claims.length === 1 ? 'claim' : 'claims'} trace to
        nothing in your profile
      </h3>

      <p className="alarm__consequence">
        {/* The consequence, in concrete terms. This is the sentence that makes
            the operator stop, so it is written as a scene rather than a rule. */}
        Master version {masterVersion} does not support{' '}
        {claims.length === 1 ? 'this' : 'these'}. If it wins the interview, the
        first technical question is about your {exampleClaim} work.
      </p>

      <p className="alarm__instruction">
        {/* Says exactly what unblocks the screen. An empty or blocked state is
            an instruction, not a mood. */}
        Decide on each claim to unlock approval.
      </p>

      <ul className="alarm__claims">
        {claims.map((claim) => {
          /* Undefined until the operator decides, which is what keeps Approve
             disabled. Absence of a decision is the gate. */
          const decision = decisions.get(claim.key);

          return (
            <li key={claim.key} className="alarm__claim">
              {/* The claim text, set in the same serif as the resume so the
                  operator recognises it as the words that would be submitted
                  rather than as a UI label about them. */}
              <span className="alarm__claim-text">{claim.text}</span>

              {/* A radio group, not a checkbox: two named outcomes cannot be
                  satisfied by reflex-clicking, and both are legitimate. */}
              <span className="alarm__choices" role="group" aria-label={'Decide on ' + claim.text}>
                <label className="alarm__choice">
                  <input
                    type="radio"
                    /* Grouped per claim so each is an independent decision. */
                    name={'decision-' + claim.key}
                    value="remove"
                    checked={decision === 'remove'}
                    onChange={() => onDecide(claim.key, 'remove')}
                  />
                  {/* Active voice, says what happens. */}
                  Cut it
                </label>

                <label className="alarm__choice">
                  <input
                    type="radio"
                    name={'decision-' + claim.key}
                    value="keep"
                    checked={decision === 'keep'}
                    onChange={() => onDecide(claim.key, 'keep')}
                  />
                  {/* Keeping requires affirming defensibility. The label is the
                      commitment, so the operator cannot later say they were not
                      asked. */}
                  Keep it, I can defend it
                </label>
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/* --- Run and line rendering ------------------------------------------- */

/* One run of tailored text, marked according to its provenance.
 *
 * Three treatments, and the differences between them are the whole point:
 *   null       - carried over untouched. No marking at all.
 *   traced     - reworded from a real master node. A quiet sage wash.
 *   fabricated - traces to nothing. Oxblood, heavy underline, and announced to
 *                assistive technology, because a colour-only signal would hide
 *                the single most consequential fact on the screen. */
function Run({ run }: { readonly run: TailoredRun }): ReactElement {
  /* Unchanged text is plain. Marking it would flatten the distinction the
     screen exists to draw. */
  if (run.verdict === null) {
    return <span>{run.text}</span>;
  }

  if (run.verdict === 'fabricated') {
    return (
      /* A real <mark> element: this is semantically highlighted-for-reference
         text, so assistive tech gets the emphasis for free. */
      <mark className="run run--fabricated">
        {/* Untrusted-derived content rendered as a React text child, which
            React escapes. No raw-HTML escape hatch anywhere in this file. */}
        {run.text}
        {/* Read aloud after the claim, so a screen-reader user hears the
            verdict rather than inferring it from styling they cannot see. */}
        <span className="visually-hidden"> — traces to nothing in the master profile</span>
      </mark>
    );
  }

  return (
    <span className="run run--traced">
      {run.text}
      <span className="visually-hidden"> — traced to {run.tracesTo}</span>
    </span>
  );
}

/* One aligned row: master text on the left, tailored runs on the right, plus a
 * provenance footer under the tailored side and optional operator inline editing. */
function Line({
  line,
  customText,
  onSaveCustomText,
}: {
  readonly line: DiffLine;
  readonly customText?: string | undefined;
  readonly onSaveCustomText?: ((lineId: string, text: string) => void) | undefined;
}): ReactElement {
  const [isEditing, setIsEditing] = useState<boolean>(false);
  const currentTailoredText = customText ?? line.tailoredRuns.map((r) => r.text).join('');
  const [draftText, setDraftText] = useState<string>(currentTailoredText);

  /* The untraceable runs on this line, so the footer can name them. */
  const fabricated = line.tailoredRuns.filter(
    (run) => run.verdict === 'fabricated',
  );

  /* A skills list is scanned token by token; resume prose is read as a
     sentence. Different reading modes want different measure and leading. */
  const kindClass = 'line__text line__text--' + line.kind;

  function handleSave() {
    if (onSaveCustomText) {
      onSaveCustomText(line.id, draftText);
    }
    setIsEditing(false);
  }

  function handleCancel() {
    setDraftText(currentTailoredText);
    setIsEditing(false);
  }

  return (
    <>
      <div className="line line--master">
        <p className="line__side-label">Master</p>

        {line.masterText === null ? (
          <p className="line__no-master">
            No single master line to compare. This paragraph draws on several
            parts of your profile at once, which is why prose gets a closer
            look than a reworded bullet.
          </p>
        ) : (
          <p className={kindClass}>{line.masterText}</p>
        )}

        <p className="identifier">{line.masterNodeId}</p>
      </div>

      <div className="line line--tailored">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <p className="line__side-label">Tailored</p>
          {!isEditing && (
            <button
              type="button"
              className="line__edit-trigger"
              onClick={() => {
                setDraftText(currentTailoredText);
                setIsEditing(true);
              }}
              title="Edit this tailored bullet directly"
            >
              ✏️ Edit text
            </button>
          )}
        </div>

        {isEditing ? (
          <div className="line__edit-box">
            <textarea
              className="line__edit-textarea"
              value={draftText}
              onChange={(e) => setDraftText(e.target.value)}
              placeholder="Edit tailored text..."
              autoFocus
            />
            <div className="line__edit-actions">
              <button
                type="button"
                className="line__edit-cancel"
                onClick={handleCancel}
              >
                Cancel
              </button>
              <button
                type="button"
                className="line__edit-save"
                onClick={handleSave}
              >
                Save
              </button>
            </div>
          </div>
        ) : (
          <p className={kindClass}>
            {customText ? (
              <span className="run run--traced">{customText}</span>
            ) : (
              line.tailoredRuns.map((run, index) => (
                <Run key={line.id + '-run-' + index} run={run} />
              ))
            )}
          </p>
        )}

        {customText ? (
          <p className="line__provenance line__provenance--edited">
            ✏️ customized by operator
          </p>
        ) : fabricated.length > 0 ? (
          <p className="line__provenance line__provenance--fabricated">
            {fabricated.map((run) => run.text).join(' and ')} trace
            {fabricated.length === 1 ? 's' : ''} to nothing
          </p>
        ) : (
          <p className="line__provenance line__provenance--traced">
            traced to <span className="identifier">{line.masterNodeId}</span>
          </p>
        )}
      </div>
    </>
  );
}

/* --- The screen -------------------------------------------------------- */

export function DiffView({ diff, onApprove, onReject }: DiffViewProps): ReactElement {
  const claims = useMemo(() => collectFlaggedClaims(diff), [diff]);
  const bucket = useMemo(() => deriveBucket(diff), [diff]);
  const [viewMode, setViewMode] = useState<'split' | 'unified'>('split');

  const [decisions, setDecisions] = useState<ReadonlyMap<string, ClaimDecision>>(
    () => new Map(),
  );
  const [customLines, setCustomLines] = useState<Record<string, string>>({});

  function handleSaveCustomLine(lineId: string, text: string) {
    setCustomLines((prev) => ({ ...prev, [lineId]: text }));
  }

  function decide(key: string, decision: ClaimDecision): void {
    setDecisions((previous) => {
      const next = new Map(previous);
      next.set(key, decision);
      return next;
    });
  }

  const undecided = claims.filter((claim) => !decisions.has(claim.key));
  const canApprove = undecided.length === 0;

  const cutCount = claims.filter(
    (claim) => decisions.get(claim.key) === 'remove',
  ).length;

  const approveLabel =
    cutCount > 0
      ? 'Approve without ' + cutCount + (cutCount === 1 ? ' claim' : ' claims')
      : 'Approve and queue for submission';

  return (
    <article className="diff">
      <header className="diff__header">
        <div className="diff__identity">
          <div className="diff__title-row">
            <h2 className="diff__title">
              {diff.jobTitle} at {diff.companyName}
            </h2>
            <div className="diff__badges">
              {diff.discoveredVia && diff.discoveredVia.length > 0 && (
                <SourceBadge
                  discoveredVia={diff.discoveredVia as readonly DiscoverySource[]}
                  sourceRefs={diff.sourceRefs}
                />
              )}
              <StatusBadge
                status={bucket === 'A' ? 'audit_clean' : 'audit_flagged'}
                label={bucket === 'A' ? 'audit_clean' : 'audit_flagged'}
              />
              <StatusBadge status="awaiting_approval" label="awaiting_approval" />
            </div>
          </div>
          <div className="diff__tags">
            {diff.employmentType && diff.employmentType !== 'unknown' && (
              <span className="tag-pill tag-pill--type">
                {diff.employmentType.replace('_', ' ')}
              </span>
            )}
            {diff.workArrangement && diff.workArrangement !== 'unknown' && (
              <span className="tag-pill tag-pill--arrangement">
                {diff.workArrangement}
              </span>
            )}
            {((diff.salaryMin !== null && diff.salaryMin !== undefined) ||
              (diff.salaryMax !== null && diff.salaryMax !== undefined)) && (
              <span className="tag-pill tag-pill--salary">
                {diff.salaryCurrency ?? 'INR'}{' '}
                {diff.salaryMin ? Number(diff.salaryMin).toLocaleString() : '0'}
                {diff.salaryMax ? ` – ${Number(diff.salaryMax).toLocaleString()}` : '+'}
              </span>
            )}
            {diff.locations && diff.locations.length > 0 && (
              <span className="tag-pill tag-pill--location">
                {diff.locations.slice(0, 2).join(', ')}
                {diff.locations.length > 2 ? ` +${diff.locations.length - 2}` : ''}
              </span>
            )}
          </div>
          <p className="diff__meta">
            Tailored from master version {diff.masterVersion}
          </p>
        </div>

        <CoverageBar diff={diff} />
      </header>

      {/* The job, before the verdict on the resume. Reading order is the
          argument: you cannot judge whether a claim is honest about a posting
          you have not been shown. */}
      <JobPosting diff={diff} />

      {bucket === 'B' ? (
        <FabricationAlert
          claims={claims}
          masterVersion={diff.masterVersion}
          decisions={decisions}
          onDecide={decide}
        />
      ) : (
        <p className="clear-notice">
          Every line traces to master version {diff.masterVersion}. Safe to
          batch-approve with the other clean applications.
        </p>
      )}

      {/* View Mode Toolbar */}
      <div className="diff__toolbar">
        <span className="coverage__title">Comparison View</span>
        <div className="diff__view-toggle" role="radiogroup" aria-label="Diff view mode">
          <button
            type="button"
            className={`diff__view-btn ${viewMode === 'split' ? 'diff__view-btn--active' : ''}`}
            onClick={() => setViewMode('split')}
          >
            Side-by-side
          </button>
          <button
            type="button"
            className={`diff__view-btn ${viewMode === 'unified' ? 'diff__view-btn--active' : ''}`}
            onClick={() => setViewMode('unified')}
          >
            Inline Unified
          </button>
        </div>
      </div>

      {viewMode === 'split' ? (
        <div className="diff__panes">
          <h3 className="diff__pane-head">Your master profile</h3>
          <h3 className="diff__pane-head">Tailored for this job</h3>

          {diff.lines.map((line) => (
            <Line
              key={line.id}
              line={line}
              customText={customLines[line.id]}
              onSaveCustomText={handleSaveCustomLine}
            />
          ))}
        </div>
      ) : (
        <div className="diff__panes--unified">
          {diff.lines.map((line) => {
            const fabricated = line.tailoredRuns.filter((r) => r.verdict === 'fabricated');
            return (
              <div key={line.id} className="unified-line">
                <div className="unified-line__meta">
                  <span className="identifier">{line.masterNodeId}</span>
                  <span className="tag-pill">{line.kind}</span>
                </div>
                <p className={`line__text line__text--${line.kind}`}>
                  {line.tailoredRuns.map((run, idx) => (
                    <Run key={`${line.id}-unified-${idx}`} run={run} />
                  ))}
                </p>
                {fabricated.length > 0 ? (
                  <p className="line__provenance line__provenance--fabricated">
                    {fabricated.map((r) => r.text).join(' and ')} trace to nothing
                  </p>
                ) : (
                  <p className="line__provenance line__provenance--traced">
                    traced to <span className="identifier">{line.masterNodeId}</span>
                  </p>
                )}
              </div>
            );
          })}
        </div>
      )}

      <footer className="diff__actions">
        <div className="diff__actions-group">
          <button
            type="button"
            className="button button--approve"
            disabled={!canApprove}
            onClick={() => onApprove(decisions)}
          >
            {approveLabel}
          </button>

          <button
            type="button"
            className="button button--reject"
            onClick={() => onReject('rejected at approval gate')}
          >
            Reject application
          </button>
        </div>

        {canApprove ? null : (
          <p className="diff__gate-note">
            {undecided.length} {undecided.length === 1 ? 'claim needs' : 'claims need'}{' '}
            a decision above.
          </p>
        )}
      </footer>
    </article>
  );
}
