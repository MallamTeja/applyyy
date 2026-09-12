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
type ClaimDecision = 'remove' | 'keep';

/* Pure presentation component - no data access, no Supabase. */
export interface DiffViewProps {
  readonly diff: ResumeDiff;
  readonly onApprove: (decisions: ReadonlyMap<string, ClaimDecision>) => void;
  readonly onReject: (reason: string) => void;
}

/* --- Coverage ---------------------------------------------------------- */

/* Two-segment bar: honest coverage vs coverage purchased by fabrication. */
function CoverageBar({ diff }: { readonly diff: ResumeDiff }): ReactElement {
  /* Coverage the master genuinely supports. */
  const honest = coveragePercent(diff.coverage, 'honest');
  /* Coverage including the flagged claims, which is what would actually be
   * submitted if the operator approved blindly. */
  const total = coveragePercent(diff.coverage, 'withFabrication');
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
 * provenance footer under the tailored side. */
function Line({ line }: { readonly line: DiffLine }): ReactElement {
  /* The untraceable runs on this line, so the footer can name them. */
  const fabricated = line.tailoredRuns.filter(
    (run) => run.verdict === 'fabricated',
  );

  /* A skills list is scanned token by token; resume prose is read as a
     sentence. Different reading modes want different measure and leading. */
  const kindClass = 'line__text line__text--' + line.kind;

  return (
    /* React.Fragment with a key: the two cells are siblings in the parent grid,
       so wrapping them in a div would break the column alignment that makes the
       comparison possible. */
    <>
      <div className="line line--master">
        {/* Per-cell side label. Invisible on wide screens where the column
            headings do this job, and revealed when the grid collapses to one
            column - at which point a single pair of headings at the top would
            label only the first two cells and mislabel every cell after. */}
        <p className="line__side-label">Master</p>

        {/* A null master text is meaningful rather than missing. A bullet
            rewords exactly one master bullet, so it has a counterpart to sit
            beside; a summary is prose drawn from several nodes, so there is
            none. Saying that is important: an empty pane beside generated
            prose reads as "wholly invented", when the truth is "assembled from
            several real things, and therefore harder to check" - which is why
            prose is the weakest point in the honesty design. */}
        {line.masterText === null ? (
          <p className="line__no-master">
            No single master line to compare. This paragraph draws on several
            parts of your profile at once, which is why prose gets a closer
            look than a reworded bullet.
          </p>
        ) : (
          <p className={kindClass}>{line.masterText}</p>
        )}

        {/* The master node id, in mono because it is a literal string the
            operator can look up on the Master Profile page. */}
        <p className="identifier">{line.masterNodeId}</p>
      </div>

      <div className="line line--tailored">
        {/* Matching side label, same reasoning as the master cell above. */}
        <p className="line__side-label">Tailored</p>
        <p className={kindClass}>
          {line.tailoredRuns.map((run, index) => (
            /* Index keys are correct here: runs are a positional decomposition
               of one immutable line, never reordered or inserted into. */
            <Run key={line.id + '-run-' + index} run={run} />
          ))}
        </p>

        {fabricated.length > 0 ? (
          /* The loud footer. Names the claims in plain words so the finding
             survives a screenshot, a printout, and colour-blind vision. */
          <p className="line__provenance line__provenance--fabricated">
            {fabricated.map((run) => run.text).join(' and ')} trace
            {fabricated.length === 1 ? 's' : ''} to nothing
          </p>
        ) : (
          /* The quiet footer. Present so the operator can confirm provenance
             exists, small and forest so it never competes with the loud one. */
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
  /* Derived, never stored: a row is Bucket B if any line is fabricated. */
  const claims = useMemo(() => collectFlaggedClaims(diff), [diff]);
  const bucket = useMemo(() => deriveBucket(diff), [diff]);

  /* The operator's decisions, keyed by claim. A Map rather than an object so
     claim keys containing dots and colons cannot collide with prototype keys. */
  const [decisions, setDecisions] = useState<ReadonlyMap<string, ClaimDecision>>(
    () => new Map(),
  );

  /* Record one decision. Replaces the Map rather than mutating it, so React
     sees a new reference and the gate below re-evaluates. */
  function decide(key: string, decision: ClaimDecision): void {
    setDecisions((previous) => {
      const next = new Map(previous);
      next.set(key, decision);
      return next;
    });
  }

  /* THE GATE. Bucket A is approvable immediately; Bucket B is approvable only
     once every single claim carries a decision. This is the structural half of
     the two-bucket design - the colour is the half that gets noticed, this is
     the half that actually holds. */
  const undecided = claims.filter((claim) => !decisions.has(claim.key));
  const canApprove = undecided.length === 0;

  /* How many claims the operator chose to cut, so the button can say what it
     will actually do rather than a generic "Approve". */
  const cutCount = claims.filter(
    (claim) => decisions.get(claim.key) === 'remove',
  ).length;

  /* The button keeps the same verb throughout the flow - approve produces
     "approved" - and states the consequence when there is one. */
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
                📍 {diff.locations.slice(0, 2).join(', ')}
                {diff.locations.length > 2 ? ` +${diff.locations.length - 2}` : ''}
              </span>
            )}
          </div>
          <p className="diff__meta">
            Tailored from master version {diff.masterVersion}
          </p>
        </div>

        {/* Coverage sits in the header because it answers "did the tailoring do
            anything", which is a question about the whole row. */}
        <CoverageBar diff={diff} />
      </header>

      {/* The fork. Bucket B gets the dark band; Bucket A gets one quiet line.
          Nothing else on the screen differs, so the band is the difference. */}
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

      {/* The comparison grid. Two columns, one row per line, so master and
          tailored text sit at the same vertical position and can be read
          across. A pair of independently-scrolling panes would break that. */}
      <div className="diff__panes">
        <h3 className="diff__pane-head">Your master profile</h3>
        <h3 className="diff__pane-head">Tailored for this job</h3>

        {diff.lines.map((line) => (
          <Line key={line.id} line={line} />
        ))}
      </div>

      <footer className="diff__actions">
        <button
          type="button"
          className="button button--approve"
          /* Disabled is a first-class state here, not an edge case. */
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
          Reject this application
        </button>

        {/* Explains the disabled button rather than leaving the operator to
            work out why nothing happens when they click it. */}
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
