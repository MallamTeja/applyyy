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

import type { DiffLine, EditTarget, FlaggedClaim, ResumeDiff, TailoredRun } from './diffModel';
import {
  collectFlaggedClaims,
  coveragePercent,
  deriveBucket,
} from './diffModel';
import { StatusBadge } from '../../app/StatusBadge';
import { SourceBadge } from '../../app/SourceBadge';
import type { DiscoverySource } from '../../data/contract';

import './DiffView.css';

/* The one decision left on a flagged claim: "keep it, I can defend it".
   Until 2026-10-06 there was also 'remove', which reached p_detail and never changed the PDF -
   the button said "cut" and the submitted resume kept the words. Cutting is now a real edit
   (the bullet is removed and saved), so the only thing left to RECORD is the acknowledgement. */
export type ClaimDecision = 'keep';

/* What the operator asked to change. DiffView only names the intent; the page turns it into a
   new resume and saves it, so this component stays free of data access. */
export type EditAction =
  // Replace one bullet's (or the summary's) text.
  | { readonly kind: 'edit'; readonly target: EditTarget; readonly text: string }
  // Delete a whole bullet (D2); summaries are edited, never removed.
  | { readonly kind: 'remove'; readonly target: { readonly kind: 'bullet'; readonly ref: string } }
  // Put the tailor's original text (or the removed bullet) back.
  | { readonly kind: 'reset'; readonly target: EditTarget };

/* A save either landed or it did not; the reason is shown to the operator verbatim. */
export type EditResult = { readonly ok: true } | { readonly ok: false; readonly reason: string };

/* Pure presentation component - no data access, no Supabase. */
export interface DiffViewProps {
  readonly diff: ResumeDiff;
  readonly onApprove: (decisions: ReadonlyMap<string, ClaimDecision>) => void;
  readonly onReject: (reason: string) => void;
  /* Async because it is a real write. Absent means "this screen offers no editing", which keeps
     any render-only caller (and the tests) working without stubbing a save path. */
  readonly onEdit?: ((action: EditAction) => Promise<EditResult>) | undefined;
  /* D4: why editing is off for this row, shown instead of controls that could not be honest. */
  readonly editDisabledReason?: string | null | undefined;
  /* Whether the row carries a generated cover letter, which an edit does not regenerate. */
  readonly hasCoverLetter?: boolean | undefined;
  /* The page is approving or rejecting this row right now: no edit may land mid-approval and
     Approve must not fire twice, so every control waits. */
  readonly locked?: boolean | undefined;
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

/* Three-segment bar: honest coverage, coverage from the operator's own edits, and coverage
   purchased by fabrication. Exported for the test that pins the unmeasured branch
   (test/coverageUnmeasured.test.ts). */
export function CoverageBar({ diff }: { readonly diff: ResumeDiff }): ReactElement {
  /* Coverage the master genuinely supports. */
  const honestMeasure = coveragePercent(diff.coverage, 'honest');
  /* Honest plus what the operator's own wording added. Never counted as "verified": the
     master did not supply it, and nobody re-audited it (R1). */
  const editsMeasure = coveragePercent(diff.coverage, 'withEdits');
  /* Coverage including the flagged claims, which is what would actually be
   * submitted if the operator approved blindly. */
  const totalMeasure = coveragePercent(diff.coverage, 'withFabrication');

  /* NOT MEASURED IS A STATE, NOT A NUMBER. Same denominator for every figure, so they are
     unmeasured together; checking each lets the compiler narrow each to its percent below.
     No bar, no badge and no "verified claims" line: each of those would state a result
     about keywords that were never recorded. */
  if (
    honestMeasure.kind === 'unmeasured' ||
    editsMeasure.kind === 'unmeasured' ||
    totalMeasure.kind === 'unmeasured'
  ) {
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
  /* The edit segment is the gap between honest and honest-plus-edits. */
  const edited = editsMeasure.percent - honest;
  /* withFabrication adds only the flagged matches to honest, so its gap is the purchased part. */
  const purchased = totalMeasure.percent - honest;

  /* Keywords matched by nothing at all: not the master, not an edit, not a flagged claim. */
  const matchedSet = new Set([
    ...diff.coverage.honestlyMatched,
    // `?? []`: same tolerance diffModel's coveragePercent has for a coverage built before edits existed.
    ...(diff.coverage.matchedByEdit ?? []),
    ...diff.coverage.matchedByFabrication,
  ]);
  // What is left over is genuinely missing from the resume.
  const missingKeywords = diff.coverage.jdKeywords.filter((k) => !matchedSet.has(k));

  return (
    <div className="coverage">
      <div className="coverage__header-row">
        <h3 className="coverage__title">ATS Match Score</h3>
        {/* The badge stays the honest figure: it is the one the operator can defend. */}
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
          (edited > 0 ? '; ' + edited + '% more come from your own edits' : '') +
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
        {/* The operator's own wording: its own colour, so it can never read as master-verified. */}
        {edited > 0 ? (
          <span
            className="coverage__fill coverage__fill--edited"
            style={{ width: edited + '%' }}
          />
        ) : null}
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
        {/* Stated as an addition beside the verified figure, never inside it. */}
        {edited > 0 ? (
          <span className="coverage__stat coverage__stat--edited">
            plus {edited}% from your edits
          </span>
        ) : null}
        {/* The purchased figure is stated as an addition, not a total, so it
            never reads as an achievement. */}
        {purchased > 0 ? (
          <span className="coverage__stat coverage__stat--purchased">
            plus {purchased}% unverified / flagged
          </span>
        ) : edited > 0 ? null : (
          <span className="coverage__stat">100% verified claims</span>
        )}
      </p>

      {/* JD Keyword chips: matched, from your edits, flagged, and missing */}
      <div className="coverage__keywords">
        {diff.coverage.honestlyMatched.map((kw) => (
          <span key={kw} className="kw-chip kw-chip--matched" title="Verified in master resume">
            ✓ {kw}
          </span>
        ))}
        {(diff.coverage.matchedByEdit ?? []).map((kw) => (
          <span key={kw} className="kw-chip kw-chip--edited" title="Only in text you edited">
            ✎ {kw}
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
  lines,
  masterVersion,
  decisions,
  onDecide,
  onRemove,
  busy,
  removeError,
}: {
  readonly claims: readonly FlaggedClaim[];
  // Needed to find whether a claim sits in a bullet that can be removed.
  readonly lines: readonly DiffLine[];
  readonly masterVersion: number;
  readonly decisions: ReadonlyMap<string, ClaimDecision>;
  readonly onDecide: (key: string, decision: ClaimDecision) => void;
  // Null when this screen offers no editing; then only "keep" is possible.
  readonly onRemove: ((target: { readonly kind: 'bullet'; readonly ref: string }) => void) | null;
  // A save is in flight; every control waits for it.
  readonly busy: boolean;
  // The last failed removal's reason, shown in the band where the click happened.
  readonly removeError: string | null;
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
        Cut each claim from the resume, or keep it. Every claim needs one to unlock approval.
      </p>

      {/* A failed cut leaves the bullet in the resume; saying so here, where the click was. */}
      {removeError !== null ? (
        <p className="alarm__error" role="alert">
          Not cut: {removeError}
        </p>
      ) : null}

      <ul className="alarm__claims">
        {claims.map((claim) => {
          /* Undefined until the operator decides, which is what keeps Approve
             disabled. Absence of a decision is the gate. */
          const decision = decisions.get(claim.key);
          /* The line the claim sits on; unlocated claims have none. */
          const line = lines.find((candidate) => candidate.id === claim.lineId);
          /* Only a BULLET can be cut: removing a summary would delete the whole paragraph,
             so a summary claim is fixed by editing the text instead. */
          const target = line?.editTarget?.kind === 'bullet' ? line.editTarget : null;

          return (
            <li key={claim.key} className="alarm__claim">
              {/* The claim text, set in the same serif as the resume so the
                  operator recognises it as the words that would be submitted
                  rather than as a UI label about them. */}
              <span className="alarm__claim-text">{claim.text}</span>

              <span className="alarm__choices" role="group" aria-label={'Decide on ' + claim.text}>
                {/* A REAL cut: the whole bullet leaves the saved resume, and the claim with it. */}
                {onRemove !== null && target !== null ? (
                  <button
                    type="button"
                    className="button button--secondary button--small"
                    disabled={busy}
                    onClick={() => onRemove(target)}
                  >
                    Cut this bullet
                  </button>
                ) : null}

                {/* Keeping requires affirming defensibility. The label is the
                    commitment, so the operator cannot later say they were not
                    asked. */}
                <label className="alarm__choice">
                  <input
                    type="radio"
                    /* Grouped per claim so each is an independent decision. */
                    name={'decision-' + claim.key}
                    value="keep"
                    checked={decision === 'keep'}
                    disabled={busy}
                    onChange={() => onDecide(claim.key, 'keep')}
                  />
                  Keep it, I can defend it
                </label>

                {/* Tells the operator the other route when there is no cut button. */}
                {onRemove !== null && line?.editTarget?.kind === 'summary' ? (
                  <span className="alarm__hint">or edit the summary below</span>
                ) : null}
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
 * Four treatments, and the differences between them are the whole point:
 *   null       - carried over untouched. No marking at all.
 *   traced     - reworded from a real master node. A quiet sage wash.
 *   edited     - the operator's own wording. Its own mark, NEVER the traced one (R1):
 *                nothing checked it against the master.
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

  if (run.verdict === 'edited') {
    return (
      <span className="run run--edited">
        {/* The operator's text, escaped like every other run. */}
        {run.text}
        {/* Spoken, so the provenance is not carried by colour alone. */}
        <span className="visually-hidden"> — edited by you, not checked against the master</span>
      </span>
    );
  }

  return (
    <span className="run run--traced">
      {run.text}
      <span className="visually-hidden"> — traced to {run.tracesTo}</span>
    </span>
  );
}

/* The footer under a tailored line: where it came from, and what the Auditor said about the
   version it replaced. Shared by both view modes so they cannot describe a line differently. */
function Provenance({ line }: { readonly line: DiffLine }): ReactElement {
  /* The untraceable runs on this line, so the footer can name them. */
  const fabricated = line.tailoredRuns.filter((run) => run.verdict === 'fabricated');

  return (
    <>
      {/* Who wrote the line: removed, edited, or the tailor (traced). */}
      {line.editState === 'removed' ? (
        <p className="line__provenance line__provenance--removed">removed by you</p>
      ) : line.editState === 'edited' ? (
        <p className="line__provenance line__provenance--edited">edited by you</p>
      ) : fabricated.length === 0 ? (
        <p className="line__provenance line__provenance--traced">
          traced to <span className="identifier">{line.masterNodeId}</span>
        </p>
      ) : null}

      {/* INDEPENDENT of the above: an edited line can still carry flagged runs, and "edited by
          you" must never hide that some of its words trace to nothing. */}
      {fabricated.length > 0 ? (
        <p className="line__provenance line__provenance--fabricated">
          {fabricated.map((run) => run.text).join(' and ')} trace
          {fabricated.length === 1 ? 's' : ''} to nothing
        </p>
      ) : null}

      {/* Claims the edit or removal replaced. Shown, not hidden, so the operator sees what they
          answered - but no longer flagged, because those words are no longer in the resume. */}
      {line.supersededClaims.map((claim) => (
        <p key={claim} className="line__superseded">
          Auditor flagged “{claim}” in the tailor&apos;s version
        </p>
      ))}
    </>
  );
}

/* One aligned row: master text on the left, tailored text on the right, a provenance footer,
 * and the edit controls that SAVE (there is no local-only edit any more). */
function Line({
  line,
  onEdit,
  busy,
}: {
  readonly line: DiffLine;
  // Null when this screen offers no editing.
  readonly onEdit: ((action: EditAction) => Promise<EditResult>) | null;
  // Any save in this diff is in flight; one write at a time per resume.
  readonly busy: boolean;
}): ReactElement {
  // Whether the textarea is open.
  const [isEditing, setIsEditing] = useState<boolean>(false);
  // The unsaved text; never displayed outside the textarea.
  const [draftText, setDraftText] = useState<string>('');
  // Whether THIS line started the in-flight save, so only it says "Saving…".
  const [savingHere, setSavingHere] = useState<boolean>(false);
  // The last failed save's reason, shown under the line.
  const [error, setError] = useState<string | null>(null);

  /* The STORED text: what the saved resume holds, which is what the PDF will print. */
  const storedText = line.tailoredRuns.map((run) => run.text).join('');
  /* Editing needs both a save path and a line that can be edited (not skills, not D4). */
  const target = onEdit === null ? null : line.editTarget;
  /* A human name for this line in aria-labels: its kind plus the start of its words (the stored
     text, or the tailor's for a removed bullet), never a machine id a screen reader spells out. */
  const lineWords = storedText !== '' ? storedText : (line.originalText ?? '');
  // Trimmed to 40 characters so a label stays a label.
  const lineName = (line.kind === 'summary' ? 'summary' : 'bullet') + ': ' + (lineWords.length > 40 ? lineWords.slice(0, 40) + '…' : lineWords);

  /* A skills list is scanned token by token; resume prose is read as a
     sentence. Different reading modes want different measure and leading. */
  const kindClass = 'line__text line__text--' + line.kind;

  /* One path for every action on this line, so disabling and error handling cannot diverge. */
  async function submit(action: EditAction): Promise<void> {
    // No save path, nothing to do (the buttons are not rendered then anyway).
    if (onEdit === null) return;
    // A new attempt clears the old failure.
    setError(null);
    // Marks this line as the one saving.
    setSavingHere(true);
    // The page builds the new resume and writes it.
    const result = await onEdit(action);
    // Done either way.
    setSavingHere(false);
    // Success or failure, the editor closes so the STORED text is what shows, never the draft.
    setIsEditing(false);
    // A refused save is named, so the operator knows the PDF did not change.
    if (!result.ok) setError(result.reason);
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
        <div className="line__tailored-head">
          <p className="line__side-label">Tailored</p>
          {/* Controls only for an editable line and only while the editor is closed. */}
          {target !== null && !isEditing ? (
            <span className="line__controls">
              {/* A removed bullet has no text to edit; Reset is how it comes back. */}
              {line.editState !== 'removed' ? (
                <button
                  type="button"
                  className="line__edit-trigger"
                  disabled={busy}
                  // Names WHICH line, since every row has an identical button.
                  aria-label={'Edit text of ' + lineName}
                  onClick={() => {
                    // Start from what is saved, never from an old draft.
                    setDraftText(storedText);
                    // Open the editor.
                    setIsEditing(true);
                  }}
                >
                  Edit text
                </button>
              ) : null}
              {/* Reset exists only where there is something of the operator's to undo. */}
              {line.editState !== 'original' ? (
                <button
                  type="button"
                  className="line__edit-trigger"
                  disabled={busy}
                  // Same reason as Edit: one label per line, not one per screen.
                  aria-label={'Reset ' + lineName + ' to the tailor’s version'}
                  onClick={() => void submit({ kind: 'reset', target })}
                >
                  {savingHere ? 'Saving…' : 'Reset to tailor’s version'}
                </button>
              ) : null}
            </span>
          ) : null}
          {/* D3: said plainly rather than leaving the operator to wonder where the button went. */}
          {onEdit !== null && line.kind === 'skills' ? (
            <span className="line__edit-unavailable">skills can&apos;t be edited yet</span>
          ) : null}
        </div>

        {isEditing && target !== null ? (
          <div className="line__edit-box">
            <textarea
              className="line__edit-textarea"
              value={draftText}
              // Locked while saving, so what is sent is what the operator sees.
              disabled={busy}
              onChange={(e) => setDraftText(e.target.value)}
              // Human words, not the machine ref (contract v2 nit).
              aria-label={'Edit ' + lineName}
              autoFocus
            />
            <div className="line__edit-actions">
              <button
                type="button"
                className="line__edit-cancel"
                disabled={busy}
                // Nothing was saved, so closing is the whole cancel.
                onClick={() => setIsEditing(false)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="line__edit-save"
                disabled={busy}
                onClick={() => void submit({ kind: 'edit', target, text: draftText })}
              >
                {savingHere ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>
        ) : line.editState === 'removed' ? (
          /* The tailor's words, struck: the operator can see what Reset would bring back. */
          <p className={kindClass + ' line__text--removed'}>
            <s>{line.originalText}</s>
          </p>
        ) : (
          <p className={kindClass}>
            {line.tailoredRuns.map((run, index) => (
              <Run key={line.id + '-run-' + index} run={run} />
            ))}
          </p>
        )}

        {/* A failed save keeps the stored text above and says why it did not change. */}
        {error !== null ? (
          <p className="line__edit-error" role="alert">
            {/* Rendered as given: the page says "Not saved" only when that is known to be true. */}
            {error}
          </p>
        ) : null}

        <Provenance line={line} />
      </div>
    </>
  );
}

/* --- The screen -------------------------------------------------------- */

export function DiffView({
  diff,
  onApprove,
  onReject,
  onEdit,
  editDisabledReason,
  hasCoverLetter,
  locked,
}: DiffViewProps): ReactElement {
  // Every claim still in the resume; claims on edited or removed lines are already gone.
  const claims = useMemo(() => collectFlaggedClaims(diff), [diff]);
  // A or B, derived; an edited row is always B (R2).
  const bucket = useMemo(() => deriveBucket(diff), [diff]);
  // Side-by-side or unified; local because no other part of the app cares.
  const [viewMode, setViewMode] = useState<'split' | 'unified'>('split');

  const [decisions, setDecisions] = useState<ReadonlyMap<string, ClaimDecision>>(
    () => new Map(),
  );
  // One save at a time per resume: each save writes the WHOLE profile, so two in flight would race.
  const [saving, setSaving] = useState<boolean>(false);
  // The last failed cut from the alarm band.
  const [removeError, setRemoveError] = useState<string | null>(null);
  // One flag for "controls wait": our own save, or the page's approve/reject on this row.
  const busy = saving || locked === true;

  /* Every save from this view goes through here, so `saving` cannot be left stuck and a
     thrown error becomes a shown reason instead of an unhandled rejection. */
  const runEdit =
    onEdit === undefined
      ? null
      : async (action: EditAction): Promise<EditResult> => {
          // Locks every control in this view.
          setSaving(true);
          try {
            // The page does the real work.
            return await onEdit(action);
          } catch (cause) {
            /* A throw here escaped the page, so whether the write landed is unknown; said as unknown
               (the prefix is no longer added at render), never as "not saved". */
            return { ok: false, reason: `Save status unknown: ${cause instanceof Error ? cause.message : 'the save threw'}. Reload to see what is stored.` };
          } finally {
            // Unlocks whatever happened.
            setSaving(false);
          }
        };

  function decide(key: string, decision: ClaimDecision): void {
    setDecisions((previous) => {
      const next = new Map(previous);
      next.set(key, decision);
      return next;
    });
  }

  /* Cutting from the alarm band: a real removal of the whole bullet, saved immediately. */
  async function cut(target: { readonly kind: 'bullet'; readonly ref: string }): Promise<void> {
    // Unreachable without a save path; the button is not rendered then.
    if (runEdit === null) return;
    // A new attempt clears the old failure.
    setRemoveError(null);
    // Same save path as every other edit.
    const result = await runEdit({ kind: 'remove', target });
    // The bullet is still there; say so in the band.
    if (!result.ok) setRemoveError(result.reason);
  }

  /* THE GATE: every claim STILL IN THE RESUME needs a decision. A cut claim vanished from
     `claims` with its bullet, so it needs none; a stale 'keep' for a claim that no longer
     exists is dropped before approval so the record lists only what was actually submitted. */
  const undecided = claims.filter((claim) => !decisions.has(claim.key));
  // Never approve mid-save (the stored resume is about to change) or mid-approval (no double send).
  const canApprove = undecided.length === 0 && !busy;
  // The keys that still exist, for filtering the decisions handed to the page.
  const liveKeys = new Set(claims.map((claim) => claim.key));

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
              {/* Three honest states: clean, flagged by the Auditor, or edited by the operator
                  (which nothing re-audited, so it must not borrow either audit label). */}
              <StatusBadge
                status={bucket === 'A' ? 'audit_clean' : claims.length > 0 ? 'audit_flagged' : 'edited'}
                label={bucket === 'A' ? 'audit_clean' : claims.length > 0 ? 'audit_flagged' : 'edited by you'}
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

      {/* The alarm only when a claim remains; an edits-only row is B for a different reason. */}
      {claims.length > 0 ? (
        <FabricationAlert
          claims={claims}
          lines={diff.lines}
          masterVersion={diff.masterVersion}
          decisions={decisions}
          onDecide={decide}
          onRemove={runEdit === null ? null : (target) => void cut(target)}
          busy={busy}
          removeError={removeError}
        />
      ) : bucket === 'A' ? (
        <p className="clear-notice">
          Every line traces to master version {diff.masterVersion}. Safe to
          batch-approve with the other clean applications.
        </p>
      ) : (
        <p className="diff__edit-note">
          {/* R2: an edited row never rides the batch button, and this says why it left. */}
          You changed {diff.editCount} {diff.editCount === 1 ? 'line' : 'lines'}, so this
          application needs your individual approval rather than the batch.
        </p>
      )}

      {/* D4: the reason editing is off, once, above the lines it applies to. */}
      {onEdit !== undefined && editDisabledReason ? (
        <p className="diff__edit-note">{editDisabledReason}</p>
      ) : null}

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
            <Line key={line.id} line={line} onEdit={runEdit} busy={busy} />
          ))}
        </div>
      ) : (
        <div className="diff__panes--unified">
          {/* Read-only view, but it shows edits and removals exactly as the split view does. */}
          {diff.lines.map((line) => (
            <div key={line.id} className="unified-line">
              <div className="unified-line__meta">
                <span className="identifier">{line.masterNodeId}</span>
                <span className="tag-pill">{line.kind}</span>
              </div>
              {line.editState === 'removed' ? (
                <p className={`line__text line__text--${line.kind} line__text--removed`}>
                  <s>{line.originalText}</s>
                </p>
              ) : (
                <p className={`line__text line__text--${line.kind}`}>
                  {line.tailoredRuns.map((run, idx) => (
                    <Run key={`${line.id}-unified-${idx}`} run={run} />
                  ))}
                </p>
              )}
              <Provenance line={line} />
            </div>
          ))}
        </div>
      )}

      <footer className="diff__actions">
        {/* R6: said where the approval happens, because the Auditor never saw these words. */}
        {diff.editCount > 0 ? (
          <p className="diff__own-wording">
            Edits are not re-audited. You are approving your own wording.
          </p>
        ) : null}
        {/* The letter was written from the tailor's version and is not regenerated. */}
        {hasCoverLetter === true && diff.editCount > 0 ? (
          <p className="diff__edit-note">Cover letter was generated before your edits.</p>
        ) : null}

        <div className="diff__actions-group">
          <button
            type="button"
            className="button button--approve"
            disabled={!canApprove}
            // Only decisions about claims that are still in the resume.
            onClick={() => onApprove(new Map([...decisions].filter(([key]) => liveKeys.has(key))))}
          >
            Approve and queue for submission
          </button>

          <button
            type="button"
            className="button button--reject"
            onClick={() => onReject('rejected at approval gate')}
          >
            Reject application
          </button>
        </div>

        {undecided.length === 0 ? null : (
          <p className="diff__gate-note">
            {undecided.length} {undecided.length === 1 ? 'claim needs' : 'claims need'}{' '}
            a decision above.
          </p>
        )}
      </footer>
    </article>
  );
}
