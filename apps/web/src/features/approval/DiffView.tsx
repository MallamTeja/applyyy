/* THE APPROVAL CARD BODY - the decision about one tailored resume.
 *
 * This is where a human decides whether something honest gets sent. PROJECT_PLAN.md section 11 is
 * the design brief. Since 2026-11-07 (Teja's slim-card rulings) the card holds only what that
 * decision needs: the job's facts, the ATS match figure, the audit verdict, the changes made to the
 * tailor's resume, and Approve / Reject. The resume itself is read in the page's ResumePreview, and
 * the AI chat is the ONLY edit path: every hand-edit control (click-to-edit, move, remove, add back,
 * keyword "+ Add" chips) was removed, and the one undo left here is each changed line's Reset.
 *
 * The one thing this screen exists to do: make TWO KINDS OF EDIT impossible to confuse.
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
 * The structural part matters more than the colour. Approve stays DISABLED until every flagged
 * claim has an explicit "keep it" recorded against it. That is section 10 defense 1 applied to the
 * interface: prefer designs where the wrong answer cannot be expressed over designs that ask nicely.
 * A tired operator at row 30 of 35 cannot skim past this gate, because there is no path through it
 * that does not involve reading each claim.
 */

// Fragment: a keyed wrapper-free row for each skill group (TailoredText). useRef: focus home after a Reset.
import { Fragment, useMemo, useRef, useState } from 'react';
// Types only: the component return shape.
import type { ReactElement } from 'react';
// Renders the AI chat into the page's right-hand dock while its state stays in this row's component.
import { createPortal } from 'react-dom';

import type {
  // One changed line, the unit Changes by AI lists.
  DiffLine,
  // Where Reset lands; also the 'edit' arm's target.
  EditTarget,
  // One flagged claim in the alarm band.
  FlaggedClaim,
  // One printed skill with its group, which the grouped skills line is built from (2026-11-05).
  PrintedSkill,
  // The whole view model.
  ResumeDiff,
  // The AI's add/remove skill arms, imported so the page and this view share one shape.
  SkillEditAction,
  // One marked run of tailored text.
  TailoredRun,
} from './diffModel';
import {
  // Every claim still in the resume, which the Approve gate counts.
  collectFlaggedClaims,
  // The honest ATS figure in the header.
  coveragePercent,
  // A or B, which picks the status badge and the clean notice.
  deriveBucket,
  // The ATS panel's suggestions: JD keywords in no run.
  missingKeywords,
  // The ATS panel's projection: the same scorer after the master-backed adds.
  projectedCoverage,
  // The one section-heading table, shared with the adapter's change sentences; names a change's place.
  SECTION_TITLE,
} from './diffModel';
// The audit-state pill in the header.
import { StatusBadge } from '../../app/StatusBadge';
/* The shared http(s)-only gate for every href built from stored data. */
import { safeHref } from '../../app/safeHref.ts';
/* Reject's in-place "are you sure?": a reject is one-way, and native dialogs are banned (CLAUDE.md section 8). */
import { InlineConfirm, armConfirm } from '../../app/InlineConfirm';
/* Types only: the structural-edit vocabulary the AI's arms carry (contract stubs live beside the pure edits). */
import type { BulletSection, MoveDirection, SectionKind } from './tailoredEdits';
/* Type only: who decided an edit, passed through to the page for the history note (2026-11-04). */
import type { EditSource } from './saveTailoredEdit';
/* The AI box: proposes edits that apply through this view's own save path. */
import { AiEditPanel } from './AiEditPanel';
/* Types only: the ask and answer of the AI box. */
import type { AssistBody, AssistResult } from './aiEdit';
/* The chat's structure, read from this same diff so the AI sees what the operator sees. */
import { structureFromDiff } from './aiEdit';
/* Type only: the AI chat's store, passed through to the panel. */
import type { ChatStore } from './resumeChat';
/* Type only: a held re-check of an edited row (2026-11-05), shown above Approve. */
import type { ApproveHold } from './approveCheck';
/* Type only: the screener's one pay-band warning literal, so the chip can only ever say that sentence (N2). */
import type { PAY_BAND_UK_US_ONLY } from '../../../../../supabase/functions/_shared/screen/work-auth-gate.ts';

import './DiffView.css';

/* The one decision left on a flagged claim: "keep it, I can defend it".
   Until 2026-10-06 there was also 'remove', which reached p_detail and never changed the PDF. Cutting
   then became a real edit (a "Cut this bullet" button); since 2026-11-07 the AI chat does it, so the
   only thing left to RECORD here is the acknowledgement. */
export type ClaimDecision = 'keep';

/* What an edit asks for. DiffView only names the intent; the page turns it into a new resume and
   saves it, so this component stays free of data access. Since 2026-11-07 the AI chat emits every
   arm except `reset`, which is the per-line undo in Changes by AI. */
export type EditAction =
  // Replace one bullet's (or the summary's) text.
  | { readonly kind: 'edit'; readonly target: EditTarget; readonly text: string }
  // Delete a whole bullet (D2); summaries are edited, never removed.
  | { readonly kind: 'remove'; readonly target: { readonly kind: 'bullet'; readonly ref: string } }
  // Put the tailor's original text (or the removed bullet) back.
  | { readonly kind: 'reset'; readonly target: EditTarget }
  // T3: add an unselected master skill / take back an added one. Imported, not
  // redeclared, so the page and this view can never disagree on the arm's shape.
  | SkillEditAction
  // A skill the master LACKS: it goes into a new master version first, then onto this resume
  // (attestSkill.ts). Carries a name, unlike the T3 arms, because there is no master node to
  // point at yet; `category` is one of the master's own groups.
  | { readonly kind: 'attest_skill'; readonly keyword: string; readonly category: string }
  // STRUCTURAL EDITS (2026-11-01, docs/ui/2026-11-01-review-structure-edits-contract.md). Every one keeps
  // each node traced to the master; tracesToMaster checks that at the save boundary.
  // One bullet one place up or down among its siblings.
  | { readonly kind: 'move_bullet'; readonly ref: string; readonly direction: MoveDirection }
  // One section one place up or down in the printed order.
  | { readonly kind: 'move_section'; readonly section: SectionKind; readonly direction: MoveDirection }
  // A master bullet the tailor left out, back under its own entry.
  | { readonly kind: 'add_master_bullet'; readonly ref: string }
  // A whole master entry (an achievement, a certification, ...) back onto the resume.
  | { readonly kind: 'add_master_entry'; readonly section: BulletSection; readonly ref: string }
  // A whole entry off the resume.
  | { readonly kind: 'remove_entry'; readonly section: BulletSection; readonly ref: string }
  // Brand-new bullet text: written into the master first (attestBullet), then added by ref.
  | { readonly kind: 'attest_bullet'; readonly section: BulletSection; readonly parentRef: string; readonly text: string };

/* A save either landed or it did not; the reason is shown to the operator verbatim. An attest
   also hands back the master skill it put on the resume. */
export type EditResult = { readonly ok: true; readonly skillRef?: string | undefined } | { readonly ok: false; readonly reason: string };

/* Pure presentation component - no data access, no Supabase. */
export interface DiffViewProps {
  // The view model of this row's resume.
  readonly diff: ResumeDiff;
  /* `acknowledged` (2026-11-05) is true only on the held card's second click, which approves past a
     re-check the operator has just read; every first click passes false. */
  readonly onApprove: (decisions: ReadonlyMap<string, ClaimDecision>, acknowledged: boolean) => void;
  // Called only from Reject's inline Confirm, never from the first click.
  readonly onReject: (reason: string) => void;
  /* Async because it is a real write. Absent means "this screen offers no editing", which keeps
     any render-only caller (and the tests) working without stubbing a save path. */
  /* The page's save; editSource (2026-11-04) says who decided the edit, for the history note. A
     line's Reset passes 'operator'; the AI chat passes its own. */
  readonly onEdit?: ((action: EditAction, editSource: EditSource) => Promise<EditResult>) | undefined;
  /* D4: why editing is off for this row, shown instead of controls that could not be honest. */
  readonly editDisabledReason?: string | null | undefined;
  /* Whether the row carries a generated cover letter, which an edit does not regenerate. */
  readonly hasCoverLetter?: boolean | undefined;
  /* The page is approving or rejecting this row right now: no edit may land mid-approval and
     Approve must not fire twice, so every control waits. */
  readonly locked?: boolean | undefined;
  /* The pinned master's skill groups, handed to the AI chat so a skill it adds prints under a real group. */
  readonly attestCategories?: readonly string[] | undefined;
  /* The AI box's ask (2026-10-31). Absent means no AI box; its proposals apply through onEdit,
     so a screen without a save path never shows it. */
  readonly onAssist?: ((body: AssistBody) => Promise<AssistResult>) | undefined;
  /* Where the AI chat keeps its chats (2026-11-01). Absent means a session-only chat. */
  readonly chat?: ChatStore | undefined;
  /* The page's docked chat (2026-11-06). Present: the AI chat renders into `node` (the page's right-hand
     dock) and only while `active`, so one chat shows at a time and it is always this row's own.
     Absent: the chat stays inline in the card, as before. */
  readonly chatDock?: { readonly node: HTMLElement | null; readonly active: boolean } | undefined;
  /* The page's held re-check of this edited row (2026-11-05): its findings, or why it could not
     run. Present turns Approve into the second click; absent is every row nothing holds. */
  readonly approveHold?: ApproveHold | undefined;
  /* N2 (2026-11-07): the screener's pay-band warning for this job, computed by the page. Non-null
     draws a signal chip in the facts line; absent or null draws nothing. */
  readonly payBandWarning?: typeof PAY_BAND_UK_US_ONLY | null | undefined;
}

/* --- Coverage ---------------------------------------------------------- */

/* The ATS panel: the honest figure "N% Match", the gain from the operator's edits, a projection if the
   master-backed suggestions were added, and the keyword chips; or the sentence saying it was never
   measured. Slimmed to the badge alone 2026-11-07 (morning), then brought back the same night at Teja's
   ask ("old style" ATS display). Read-only by design: the AI chat is the only edit path, so a missing
   master-backed keyword is a button that only PRE-FILLS the chat prompt (onSuggest); it never edits.
   Every figure comes from one scorer (coveragePercent). Exported for test/coverageUnmeasured.test.ts and
   test/addSkill.test.ts. */
export function CoverageBar({
  diff,
  onSuggest,
}: {
  // The row's view model; only diff.coverage is read.
  readonly diff: ResumeDiff;
  // Pre-fills the AI chat with a prompt for one keyword; absent where no chat can take it (editing off).
  readonly onSuggest?: ((keyword: string) => void) | undefined;
}): ReactElement {
  /* Coverage the master genuinely supports: the figure the operator can defend. */
  const honestMeasure = coveragePercent(diff.coverage, 'honest');
  /* The same scorer counting the operator's edits: the figure that moves after an AI-chat edit. */
  const editsMeasure = coveragePercent(diff.coverage, 'withEdits');
  /* The same scorer counting flagged claims: shown only so the operator sees what lying would buy. */
  const flaggedMeasure = coveragePercent(diff.coverage, 'withFabrication');
  /* The same scorer if every master-backed suggestion were added. */
  const projectedMeasure = projectedCoverage(diff.coverage);

  /* NOT MEASURED IS A STATE, NOT A NUMBER. No badge: it would state a result about keywords that
     were never recorded. */
  if (honestMeasure.kind === 'unmeasured') {
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

  /* The honest base. Every other figure shares its denominator, so each is measured when it is. */
  const honest = honestMeasure.percent;
  /* The rise from the operator's edits; 0 (and so hidden) if the arm were ever unmeasured. */
  const edited = editsMeasure.kind === 'measured' ? editsMeasure.percent - honest : 0;
  /* The rise only flagged claims supply. */
  const flagged = flaggedMeasure.kind === 'measured' ? flaggedMeasure.percent - honest : 0;
  /* The projection, kept only when it beats today's with-edits figure: an equal one adds nothing to do. */
  const projected =
    projectedMeasure.kind === 'measured' && projectedMeasure.percent > honest + edited ? projectedMeasure.percent : null;
  /* Distinct, non-blank keywords per bucket, so a repeated JD keyword is one chip. */
  const distinct = (list: readonly string[]): string[] => [...new Set(list)].filter((keyword) => keyword.trim() !== '');
  /* The suggestions, in JD order. */
  const missing = missingKeywords(diff.coverage);
  /* The suggestions the master can back: the projection's assumption (its count is stated in the sentence)
     and the only chips offered as buttons. One Set, so the two can never disagree. */
  const backed = new Set(missing.filter((keyword) => (diff.coverage.addable?.get(keyword) ?? null) !== null));

  return (
    <div className="coverage">
      <div className="coverage__header-row">
        <h3 className="coverage__title">ATS Match Score</h3>
        {/* The badge is the honest figure: it is the one the operator can defend. */}
        <span className="coverage__ats-badge">{honest}% Match</span>
      </div>
      {/* The track: honest solid, edits striped accent, flagged hatched. role=img with the whole sentence, so a
          screen reader hears the split the colours show. Widths are integers from the scorer, never raw input. */}
      <div
        className="coverage__track"
        role="img"
        aria-label={
          honest + '% of job-description keywords are supported by your master profile' +
          (edited > 0 ? '; ' + edited + '% more come from your edits' : '') +
          (flagged > 0 ? '; a further ' + flagged + '% comes only from flagged claims' : '')
        }
      >
        {/* Master-verified share. */}
        <span className="coverage__fill coverage__fill--honest" style={{ width: honest + '%' }} />
        {/* The edits' share, only when there is one. */}
        {edited > 0 ? <span className="coverage__fill coverage__fill--edited" style={{ width: edited + '%' }} /> : null}
        {/* The flagged share, only when there is one. */}
        {flagged > 0 ? <span className="coverage__fill coverage__fill--purchased" style={{ width: flagged + '%' }} /> : null}
      </div>
      {/* The legend, in the old panel's words. Zero shares are omitted, never printed as "plus 0%". */}
      <p className="coverage__legend">
        {/* The base. */}
        <span className="coverage__stat coverage__stat--honest">{honest}% verified from master</span>
        {/* What the AI-chat edits added. */}
        {edited > 0 ? <span className="coverage__stat coverage__stat--edited">plus {edited}% from your edits</span> : null}
        {/* What only flagged claims add. */}
        {flagged > 0 ? <span className="coverage__stat coverage__stat--purchased">plus {flagged}% unverified / flagged</span> : null}
      </p>
      {/* The projection: the scorer's own figure after the master-backed adds, with how many it assumes. */}
      {projected !== null ? (
        <p className="coverage__projection">
          {projected}% if you add {backed.size === 1 ? 'the 1 suggestion' : `the ${backed.size} suggestions`} your master profile backs
        </p>
      ) : null}
      {/* The keyword chips. Keywords are UNTRUSTED JD text: React text children only (constraint #17). */}
      <div className="coverage__keywords">
        {distinct(diff.coverage.honestlyMatched).map((keyword) => (
          // Verified: in a traced run or a printed master credential.
          <span key={'m:' + keyword} className="kw-chip kw-chip--matched" title="Verified in master resume">✓ {keyword}</span>
        ))}
        {distinct(diff.coverage.matchedByEdit ?? []).map((keyword) => (
          // Present only in text the operator (via the AI chat) changed.
          <span key={'e:' + keyword} className="kw-chip kw-chip--edited" title="Only in text you edited">✎ {keyword}</span>
        ))}
        {distinct(diff.coverage.matchedByFabrication).map((keyword) => (
          // Present only through a flagged claim.
          <span key={'f:' + keyword} className="kw-chip kw-chip--flagged" title="Flagged untraced claim">! {keyword}</span>
        ))}
        {missing.map((keyword) =>
          // A master-backed suggestion with a chat to take it: a button that only fills the prompt.
          onSuggest !== undefined && backed.has(keyword) ? (
            <button
              key={'s:' + keyword}
              type="button"
              className="kw-chip kw-chip--missing kw-chip--suggest"
              // Says what the click does, since it does not edit the resume itself.
              title="Your master profile has this. Click to ask the AI chat to add it."
              // Fills the chat prompt; the operator still reads it and presses Send.
              onClick={() => onSuggest(keyword)}
            >
              + {keyword}
            </button>
          ) : (
            // Not in the master (or no chat): shown, never offered, so the panel cannot invite a fabrication.
            <span key={'x:' + keyword} className="kw-chip kw-chip--missing" title="Not in your master profile">✕ {keyword}</span>
          ),
        )}
      </div>
    </div>
  );
}

/* --- Fabrication alert ------------------------------------------------- */

/* Dark-surface alert for untraceable claims. Single-use alarm surface. */
function FabricationAlert({
  claims,
  decisions,
  onDecide,
  busy,
}: {
  // The claims still in the resume.
  readonly claims: readonly FlaggedClaim[];
  // What the operator has kept so far; a missing key is the gate.
  readonly decisions: ReadonlyMap<string, ClaimDecision>;
  // Records one "keep".
  readonly onDecide: (key: string, decision: ClaimDecision) => void;
  // A save or the page's approve is in flight; every control waits for it.
  readonly busy: boolean;
}): ReactElement {
  /* Name the first claim in the consequence sentence. A specific sentence -
   * "the first question is about your Docker setup" - lands where a generic
   * warning about fabrication does not. `noUncheckedIndexedAccess` makes the
   * guard mandatory, and the fallback keeps the sentence grammatical if the
   * list is ever empty. */
  const firstClaim = claims[0];
  // The example the consequence sentence names.
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
        Your master profile does not support{' '}
        {claims.length === 1 ? 'this' : 'these'}. If it wins the interview, the
        first technical question is about your {exampleClaim} work.
      </p>

      <p className="alarm__instruction">
        {/* Says exactly what unblocks the screen, and where the other route is now that cutting
            happens in the AI chat. */}
        Keep each claim you can defend to unlock approval. To change or drop one, ask the AI chat.
      </p>

      <ul className="alarm__claims">
        {claims.map((claim) => {
          /* Undefined until the operator decides, which is what keeps Approve
             disabled. Absence of a decision is the gate. */
          const kept = decisions.get(claim.key) === 'keep';

          return (
            <li key={claim.key} className="alarm__claim">
              {/* The claim text, set in the same serif as the resume so the
                  operator recognises it as the words that would be submitted
                  rather than as a UI label about them. */}
              <span className="alarm__claim-text">{claim.text}</span>

              {/* ONE compact control per claim (2026-11-07, D1). A real button with aria-pressed, so
                  the kept state is spoken, not only coloured. The label is the commitment, so the
                  operator cannot later say they were not asked. */}
              <button
                // Never a form submit.
                type="button"
                // The small control style, tinted for the dark band.
                className="button button--small alarm__keep"
                // Spoken as a toggle that is on once kept.
                aria-pressed={kept}
                // Waits for any save, and has nothing more to do once kept.
                disabled={busy || kept}
                // Records the acknowledgement; the gate re-counts on the next render.
                onClick={() => onDecide(claim.key, 'keep')}
              >
                {/* The commitment, verbatim from the earlier radio label. */}
                Keep it, I can defend it
              </button>
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
 *   edited     - an edit's own wording. Its own mark, NEVER the traced one (R1):
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
        {/* The edit's text, escaped like every other run. */}
        {run.text}
        {/* Spoken, so the provenance is not carried by colour alone. */}
        <span className="visually-hidden"> — edited by you, not checked against the master</span>
      </span>
    );
  }

  return (
    <span className="run run--traced">
      {/* The tailor's traced words. */}
      {run.text}
      {/* Spoken provenance, so the sage wash is not the only signal. */}
      <span className="visually-hidden"> — traced to {run.tracesTo}</span>
    </span>
  );
}

/* A tailored line's text: its runs, or (R4, 2026-11-05) the skills line GROUPED as the PDF prints it.
 *
 * The PDF prints one "Category: a, b" row per group, groups in first-appearance order
 * (renderSkills in packages/resume-template/src/render-resume-html.ts). A flat list in resume order
 * showed the operator a layout the PDF never prints. That grouping is MIRRORED here, not imported:
 * renderSkills is private to its module and returns an HTML string, and this file renders React
 * nodes with no raw-HTML hatch. skillsGroupedDiff.test.ts compares the two outputs, so they cannot
 * drift silently. Only a line carrying printedSkills can be grouped; since 2026-11-05 diffAdapter emits
 * it on the D4 branch too, so only a non-skills line stays flat. */
function TailoredText({ line }: { readonly line: DiffLine }): ReactElement {
  // No groups to show: the runs exactly as before, marking (R1) untouched.
  if (line.kind !== 'skills' || line.printedSkills === undefined) {
    // Fragment, so the caller's <p> stays the only wrapper.
    return <>{line.tailoredRuns.map((run, index) => <Run key={line.id + '-run-' + index} run={run} />)}</>;
  }
  // The additions, by ref: the only skills that are not traced (same split as the adapter).
  const added = new Set((line.addedSkills ?? []).map((skill) => skill.ref));
  // The master's own skill names, lower-cased: an added skill that is one of them is the owner's real
  // skill, so it traces to the master (2026-11-06: "Master skills the AI adds show 'not checked against
  // the master'"). Display only: the coverage figure still counts it as "from your edits" (diffAdapter).
  const inMaster = new Set((line.masterSkills ?? []).map((skill) => skill.name.toLowerCase()));
  // A Map keeps insertion order, so groups appear where their first skill does, like renderSkills.
  const groups = new Map<string, PrintedSkill[]>();
  // One pass in print order; members keep their relative order within a group.
  for (const skill of line.printedSkills) groups.set(skill.category, [...(groups.get(skill.category) ?? []), skill]);
  // One row per group.
  return (
    <>
      {[...groups].map(([category, skills], groupIndex) => (
        // Category names are unique keys: the Map merged repeats.
        <Fragment key={category}>
          {/* A line break between rows, not before the first: plain HTML inside the caller's <p>, no new CSS. */}
          {groupIndex > 0 ? <br /> : null}
          {/* One row: the label, then the group's skills. */}
          <span className="line__skill-group">
            {/* The group's label, printed with the same colon the PDF prints. */}
            <strong>{category}:</strong>{' '}
            {skills.map((skill, index) => (
              // Keyed by master ref, unique on a resume.
              <Fragment key={skill.ref}>
                {/* The comma is unmarked text, as in the flat line: highlighting it would be noise. */}
                {index > 0 ? ', ' : null}
                {/* Each skill its own run, so traced vs "edited by you" stays per skill (R1). */}
                <Run run={added.has(skill.ref) && !inMaster.has(skill.name.toLowerCase()) ? { text: skill.name, verdict: 'edited', tracesTo: null } : { text: skill.name, verdict: 'traced', tracesTo: added.has(skill.ref) ? 'your master skills' : 'skills' }} />
              </Fragment>
            ))}
          </span>
        </Fragment>
      ))}
    </>
  );
}

/* The footer under a changed line: who changed it, and what the Auditor said about the version it
   replaced. Only changed lines are drawn (Changes by AI), so there is no "traced to <id>" branch any
   more: an unchanged line is read in the page's ResumePreview, and a node id told the operator nothing. */
function Provenance({ line }: { readonly line: DiffLine }): ReactElement {
  /* The untraceable runs on this line, so the footer can name them. */
  const fabricated = line.tailoredRuns.filter((run) => run.verdict === 'fabricated');

  return (
    <>
      {/* Who wrote the line: removed, added, or edited. A moved-only line says so on its own line below. */}
      {line.editState === 'removed' ? (
        <p className="line__provenance line__provenance--removed">removed by you</p>
      ) : line.editState === 'edited' && line.kind === 'bullet' && line.originalText === null ? (
        /* A bullet the tailor never wrote: put back from the master, or new and attested.
           Not "edited": there is no tailor version it was edited from. */
        <p className="line__provenance line__provenance--edited">added by you</p>
      ) : line.editState === 'edited' ? (
        <p className="line__provenance line__provenance--edited">edited by you</p>
      ) : null}

      {/* INDEPENDENT of who wrote it: a moved bullet keeps the tailor's words, so the move is said
          on its own line (D5a: every structural change is visible where it happened). */}
      {line.moved === true ? <p className="line__provenance line__provenance--edited">moved by you</p> : null}

      {/* INDEPENDENT of the above: an edited line can still carry flagged runs, and "edited by
          you" must never hide that some of its words trace to nothing. */}
      {fabricated.length > 0 ? (
        <p className="line__provenance line__provenance--fabricated">
          {fabricated.map((run) => run.text).join(' and ')} trace
          {fabricated.length === 1 ? 's' : ''} to nothing
        </p>
      ) : null}

      {/* Claims the edit or removal replaced. Shown, not hidden, so the operator sees what was
          answered - but no longer flagged, because those words are no longer in the resume. */}
      {line.supersededClaims.map((claim) => (
        <p key={claim} className="line__superseded">
          Auditor flagged “{claim}” in the tailor&apos;s version
        </p>
      ))}
    </>
  );
}

/* --- Changes by AI (2026-11-07, D2) -------------------------------------
 * Replaced the side-by-side master/tailored comparison and its Unified twin. One row per CHANGED
 * line (edited, removed, moved, added); unchanged lines are not listed, since the resume is read in
 * the page's ResumePreview. Each row shows the new text, the tailor's old text where it differs, and
 * the line's Reset: the AI chat's only undo, which AiEditPanel's empty state points the operator to. */

/* A changed line: its place, its new words, the old words, who changed it, and Reset. */
function ChangeRow({
  line,
  where,
  onReset,
  busy,
  onResetLanded,
}: {
  // The changed line.
  readonly line: DiffLine;
  // "Experience · Acme" or "Summary": which part of the resume the change sits in.
  readonly where: string;
  // The save path for Reset; null when editing is off (no save path, or D4), so no Reset renders.
  readonly onReset: ((target: EditTarget) => Promise<EditResult>) | null;
  // Any save in this diff is in flight; one write at a time per resume.
  readonly busy: boolean;
  // A landed Reset usually unmounts this row, so the parent moves focus somewhere that still exists.
  readonly onResetLanded: () => void;
}): ReactElement {
  // The last refused Reset's reason, shown under the row.
  const [error, setError] = useState<string | null>(null);
  // Whether THIS row started the in-flight save, so only its button says "Saving…".
  const [savingHere, setSavingHere] = useState<boolean>(false);
  /* The STORED text: what the saved resume holds, which is what the PDF will print. */
  const storedText = line.tailoredRuns.map((run) => run.text).join('');
  /* Words for the spoken name of this row's Reset: the stored text, or the tailor's for a removed bullet. */
  const lineWords = storedText !== '' ? storedText : (line.originalText ?? '');
  // Trimmed to 40 characters so a label stays a label; skills are named as the list they are.
  const lineName = line.kind === 'skills' ? 'skills' : (line.kind === 'summary' ? 'summary' : 'bullet') + ': ' + (lineWords.length > 40 ? lineWords.slice(0, 40) + '…' : lineWords);
  /* A skills list is scanned token by token; resume prose is read as a sentence. */
  const kindClass = 'line__text line__text--' + line.kind;
  /* Reset needs a save path and a target, and only exists where resetTarget can honour it: words or
     a removal to undo, with a tailor version to go back to. A moved-only line has no words to restore
     (resetTarget answers "Nothing to reset"), and an added bullet has no tailor version; the AI chat
     undoes those. */
  const target = onReset === null ? null : line.editTarget;
  // The narrowed target, or null when this row offers no Reset.
  const resetTarget = target !== null && line.editState !== 'original' && !(line.kind === 'bullet' && line.originalText === null) ? target : null;
  /* The tailor's words, shown muted only where they differ from what is stored now. */
  const oldText = line.editState === 'edited' && line.originalText !== null && line.originalText !== storedText ? line.originalText : null;

  /* One Reset: clears the old failure, saves, then names a refusal or hands focus to the parent. */
  async function reset(to: EditTarget): Promise<void> {
    // Unreachable without a save path (no button is rendered then); narrows the type.
    if (onReset === null) return;
    // A new attempt answers the old failure.
    setError(null);
    // Marks this row as the one saving.
    setSavingHere(true);
    // The page builds the tailor's version of this line and saves the whole resume.
    const result = await onReset(to);
    // Done either way.
    setSavingHere(false);
    // A refused save is named, so the operator knows the PDF did not change.
    if (!result.ok) setError(result.reason);
    // A landed one removes this row on the redraw; focus goes to the list's summary instead of <body>.
    else onResetLanded();
  }

  return (
    <li className="line diff__change">
      {/* Which part of the resume, so a change reads in context without the full resume beside it. */}
      <p className="diff__change-where">{where}</p>
      {/* The new words; a removed bullet shows the tailor's words struck, which Reset brings back. */}
      {line.editState === 'removed' ? (
        <p className={kindClass + ' line__text--removed'}>
          <s>{line.originalText}</s>
        </p>
      ) : (
        <p className={kindClass}>
          {/* The runs, or the skills grouped as the PDF prints them (R4). */}
          <TailoredText line={line} />
        </p>
      )}
      {/* The tailor's version, muted, so the operator sees what the change replaced. */}
      {oldText !== null ? (
        <p className="line__text diff__change-old">
          {/* A visible lead-in, so the muted line is not mistaken for a second bullet. */}
          <span className="diff__change-old-label">Was: </span>
          {/* <del>: the old words are semantically removed text, spoken as such. */}
          <del>{oldText}</del>
        </p>
      ) : null}
      {/* T3: each added skill keeps its provenance label; removal is the AI chat's job now. */}
      {line.addedSkills !== undefined && line.addedSkills.length > 0 ? (
        <ul
          className="line__added-skills"
          // `list-style: none` makes Safari/VoiceOver drop list semantics; the role keeps the count spoken.
          role="list"
        >
          {line.addedSkills.map((skill) => (
            <li key={skill.ref} className="line__added-skill">
              {/* The name plus who put it there; nothing checked it against the master's evidence. */}
              {skill.name} <span className="line__added-skill-tag">added by you</span>
            </li>
          ))}
        </ul>
      ) : null}
      {/* Who changed it, and any flagged words it still carries. */}
      <Provenance line={line} />
      {/* The undo, where resetTarget can honour it. */}
      {resetTarget !== null ? (
        <button
          // Never a form submit.
          type="button"
          // A quiet small control: an undo, not the screen's primary action.
          className="button button--ghost button--small diff__change-reset"
          // One write at a time per resume.
          disabled={busy}
          // No aria-label: the name comes from the content, so it contains the visible words (WCAG 2.5.3).
          onClick={() => void reset(resetTarget)}
        >
          {/* Mid-save the button says so; otherwise the verb plus a spoken suffix naming WHICH line. */}
          {savingHere ? (
            'Saving…'
          ) : (
            <>
              Reset to tailor’s version
              {/* Spoken only: every changed line has a Reset with the same visible words. */}
              <span className="visually-hidden"> ({lineName})</span>
            </>
          )}
        </button>
      ) : null}
      {/* A refused Reset keeps the row and says why it did not change. */}
      {error !== null ? (
        <p className="line__edit-error" role="alert">
          {/* Rendered as given: the page says "Not saved" only when that is known to be true. */}
          {error}
        </p>
      ) : null}
    </li>
  );
}

/* The collapsed list of changed lines. Nothing at all when no line changed: an empty disclosure would
   promise content that is not there. */
function ChangesByAi({
  diff,
  onReset,
  busy,
}: {
  // The whole diff, for its lines and its section layout.
  readonly diff: ResumeDiff;
  // The Reset save path, or null when editing is off.
  readonly onReset: ((target: EditTarget) => Promise<EditResult>) | null;
  // Any save in this diff is in flight.
  readonly busy: boolean;
}): ReactElement | null {
  // The disclosure's summary: where focus goes when a landed Reset unmounts the clicked row.
  const summaryRef = useRef<HTMLElement | null>(null);
  // Changed = words changed or removed, or the bullet moved; that is everything Provenance can name.
  const changed = diff.lines.filter((line) => line.editState !== 'original' || line.moved === true);
  // No changes, no disclosure.
  if (changed.length === 0) return null;

  /* "Experience · Acme" for a bullet with a known entry, else the section's own title. */
  function whereOf(line: DiffLine): string {
    // Summary and skills are a section each.
    if (line.kind !== 'bullet') return SECTION_TITLE[line.kind];
    // A hand-built fixture without a layout: the kind is all there is to say.
    if (line.section === undefined) return 'Bullet';
    // The entry's human label from the adapter's layout, the same labeller the AI chat uses.
    const label = diff.sections?.find((section) => section.kind === line.section)?.entries.find((entry) => entry.ref === line.entryRef)?.label;
    // Section, then entry when known.
    return label === undefined ? SECTION_TITLE[line.section] : `${SECTION_TITLE[line.section]} · ${label}`;
  }

  return (
    // Native disclosure, collapsed: keyboard, state and semantics come from the platform.
    <details className="diff__changes">
      {/* The count, so the operator knows how much changed before opening it. */}
      <summary ref={summaryRef} className="diff__changes-summary">
        Changes by AI ({changed.length})
      </summary>
      {/* `list-style: none` makes Safari drop list semantics; the role keeps the count spoken. */}
      <ul className="diff__changes-list" role="list">
        {changed.map((line) => (
          <ChangeRow
            // Keyed by line id, so a save elsewhere keeps each row's error state.
            key={line.id}
            // The changed line.
            line={line}
            // Its place in the resume.
            where={whereOf(line)}
            // The Reset save path, or none.
            onReset={onReset}
            // One write at a time.
            busy={busy}
            // Focus to the summary, which survives the row's unmount.
            onResetLanded={() => summaryRef.current?.focus()}
          />
        ))}
      </ul>
    </details>
  );
}

/* --- The action bar (2026-11-07, D4) ------------------------------------ */

/* Approve (primary) then Reject (secondary), one bar, same button height. Reject is one-way, so its
   click only ARMS an inline confirm (app/InlineConfirm.tsx); onReject runs from that Confirm alone.
   Approve stays one click: its gate is the per-claim decisions, not a question. Hook-free and
   exported, so test/diffViewSlim.test.ts calls the real click handlers by value. */
export function ApprovalActions({
  confirmId,
  subject,
  canApprove,
  approveLabel,
  onApproveClick,
  onReject,
  busy,
}: {
  // The InlineConfirm instance id, unique per row.
  readonly confirmId: string;
  // "Engineer at Acme": the confirm names the row it would reject.
  readonly subject: string;
  // The gate: every flagged claim kept and nothing in flight.
  readonly canApprove: boolean;
  // The ordinary label, or the held card's second-click label.
  readonly approveLabel: string;
  // Approve's whole effect, built by DiffView with the live decisions.
  readonly onApproveClick: () => void;
  // The page's reject; reached only through Confirm.
  readonly onReject: (reason: string) => void;
  // A save or the page's approve/reject is in flight.
  readonly busy: boolean;
}): ReactElement {
  return (
    /* The question opens in place of both buttons, so nothing below moves and Approve cannot be
       clicked under an open reject question. */
    <InlineConfirm id={confirmId}>
      <div className="diff__actions-group">
        <button
          // Never a form submit.
          type="button"
          // The affirmative, filled action: the one this card exists for.
          className="button button--approve"
          // Locked until every flagged claim is kept and nothing is in flight.
          disabled={!canApprove}
          // One click; the page re-checks an edited row itself.
          onClick={onApproveClick}
        >
          {/* The second click names what it approves past; a hold that could not check says that. */}
          {approveLabel}
        </button>
        <button
          // Never a form submit.
          type="button"
          // Secondary emphasis, reject's danger outline: it must not compete with Approve.
          className="button button--secondary button--reject"
          // No reject mid-save or mid-approval.
          disabled={busy}
          // Arms the confirm only; nothing is written until its Confirm.
          onClick={(e) => armConfirm(confirmId, {
            // Plain words: what happens, and that there is no way back from it here.
            message: `Reject ${subject}? It leaves the approval queue and is never submitted. This cannot be undone.`,
            // The confirm's own button names, with the row in them.
            action: `Reject: ${subject}`,
            // The one write, called at most once by Confirm.
            onConfirm: () => onReject('rejected at approval gate'),
            // For focus return on Cancel.
            trigger: e.currentTarget,
          })}
        >
          {/* The visible verb. */}
          Reject application
        </button>
      </div>
    </InlineConfirm>
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
  // Passed straight to the AI chat, so a skill it adds prints under a real group.
  attestCategories,
  // The AI box's ask; absent hides the box.
  onAssist,
  // The AI chat's store; passed straight through.
  chat,
  // Where the chat renders: the page's dock, or inline when absent.
  chatDock,
  // The held re-check, shown above Approve; undefined when nothing is held.
  approveHold,
  // N2: the pay-band chip's text, or nothing.
  payBandWarning,
}: DiffViewProps): ReactElement {
  /* Whether this row's chat has ever been docked: from then on its panel stays mounted (hidden) while another
     row holds the dock. State set during render, the supported pattern for state derived from a prop. */
  const [everDocked, setEverDocked] = useState(false);
  // First time docked: remember it.
  if (chatDock?.active === true && !everDocked) setEverDocked(true);
  // Every claim still in the resume; claims on edited or removed lines are already gone.
  const claims = useMemo(() => collectFlaggedClaims(diff), [diff]);
  // A or B, derived; an edited row is always B (R2).
  const bucket = useMemo(() => deriveBucket(diff), [diff]);
  // The AI chat's structure (2026-11-01): derived from the diff, recomputed only when it changes.
  const assistStructure = useMemo(() => structureFromDiff(diff), [diff]);

  // The operator's per-claim "keep" choices; a missing key is an undecided claim.
  const [decisions, setDecisions] = useState<ReadonlyMap<string, ClaimDecision>>(
    () => new Map(),
  );
  // One save at a time per resume: each save writes the WHOLE profile, so two in flight would race.
  const [saving, setSaving] = useState<boolean>(false);
  // One flag for "controls wait": our own save, or the page's approve/reject on this row.
  const busy = saving || locked === true;
  /* The ATS panel's last chip click, handed to this row's AI chat as a pre-filled prompt. A new object per
     click, so the panel's effect fires again for the same keyword. */
  const [chatSeed, setChatSeed] = useState<{ readonly text: string } | null>(null);

  /* Every save from this view goes through here, so `saving` cannot be left stuck and a
     thrown error becomes a shown reason instead of an unhandled rejection. */
  const runEdit =
    onEdit === undefined
      ? null
      : async (action: EditAction, editSource: EditSource): Promise<EditResult> => {
          // Locks every control in this view.
          setSaving(true);
          try {
            // The page does the real work, told who decided it.
            return await onEdit(action, editSource);
          } catch (cause) {
            /* A throw here escaped the page, so whether the write landed is unknown; said as unknown
               (the prefix is no longer added at render), never as "not saved". */
            return { ok: false, reason: `Save status unknown: ${cause instanceof Error ? cause.message : 'the save threw'}. Reload to see what is stored.` };
          } finally {
            // Unlocks whatever happened.
            setSaving(false);
          }
        };

  /* Reset is the operator's own click, so it says 'operator'; and it exists only where editing is
     honestly on (a save path, and no editDisabledReason), the same rule the AI chat mounts under. */
  const resetEdit = runEdit !== null && !editDisabledReason ? (target: EditTarget): Promise<EditResult> => runEdit({ kind: 'reset', target }, 'operator') : null;

  /* Records one claim's decision in a fresh Map, so React sees a new value. */
  function decide(key: string, decision: ClaimDecision): void {
    setDecisions((previous) => {
      // Copied, never mutated: the old Map may still be in a pending render.
      const next = new Map(previous);
      // The decision for this claim.
      next.set(key, decision);
      // The new state.
      return next;
    });
  }

  /* THE GATE: every claim STILL IN THE RESUME needs a decision. A claim the AI chat cut vanished from
     `claims` with its bullet, so it needs none; a stale 'keep' for a claim that no longer
     exists is dropped before approval so the record lists only what was actually submitted. */
  const undecided = claims.filter((claim) => !decisions.has(claim.key));
  // Never approve mid-save (the stored resume is about to change) or mid-approval (no double send).
  const canApprove = undecided.length === 0 && !busy;
  // The keys that still exist, for filtering the decisions handed to the page.
  const liveKeys = new Set(claims.map((claim) => claim.key));
  // The structural sentences behind part of editCount; absent on fixtures that predate them.
  const structureChanges = diff.structureChanges ?? [];
  /* Validated once per render; undefined means no safe link (apply_url is board-supplied, see app/safeHref.ts). */
  const postingHref = safeHref(diff.applyUrl);
  // Whether either salary bound is known, so the pill renders only with a figure in it.
  const hasSalary = (diff.salaryMin !== null && diff.salaryMin !== undefined) || (diff.salaryMax !== null && diff.salaryMax !== undefined);

  return (
    <article className="diff">
      <header className="diff__header">
        {/* No title <h2> since 2026-11-07: the page's row head already shows the job title,
            "Company · location" and the toolbar, so a heading here repeated it when the card opened. */}
        <div className="diff__identity">
          {/* ONE facts line (2026-11-07, D3), the first thing in the card: the audit verdict, work type,
              salary, the posting, and the N2 pay-band chip. Employment type, locations and the discovery
              source left the card. */}
          <div className="diff__tags">
            {/* Three honest states: clean, flagged by the Auditor, or edited (which nothing re-audited, so
                it must not borrow either audit label). Kept here because only Bucket A's row head carries
                a badge, and it can only ever say audit_clean. The always-true awaiting_approval pill was
                dropped 2026-11-07: every card on this page is. */}
            <StatusBadge
              status={bucket === 'A' ? 'audit_clean' : claims.length > 0 ? 'audit_flagged' : 'edited'}
              // Plain words, not the enum (2026-11-07 audit: raw "audit_flagged" read as a code); the status
              // prop keeps the colour class.
              label={bucket === 'A' ? 'Verified' : claims.length > 0 ? 'Needs review' : 'edited by you'}
            />
            {diff.workArrangement && diff.workArrangement !== 'unknown' && (
              <span className="tag-pill tag-pill--arrangement">
                {/* Remote, hybrid or onsite, as the screener read it. */}
                {diff.workArrangement}
              </span>
            )}
            {hasSalary && (
              <span className="tag-pill tag-pill--salary">
                {/* INR when the board named no currency: the market this pipeline searches. */}
                {diff.salaryCurrency ?? 'INR'}{' '}
                {/* A missing minimum reads as 0, the existing pill's rule. */}
                {diff.salaryMin ? Number(diff.salaryMin).toLocaleString() : '0'}
                {/* A range, or "and up" when only the minimum is known. */}
                {diff.salaryMax ? ` – ${Number(diff.salaryMax).toLocaleString()}` : '+'}
              </span>
            )}
            {postingHref !== undefined && (
              <a
                className="diff__posting-link"
                // Only an http(s) URL reaches here (safeHref).
                href={postingHref}
                // The board, in its own tab: the review stays where it was.
                target="_blank"
                // No window.opener for a third-party page.
                rel="noopener noreferrer"
              >
                Open the original posting
              </a>
            )}
            {/* N2: a signal chip, never the fabrication colour: it is a fact about the job, not the resume. */}
            {payBandWarning ? <span className="tag-pill tag-pill--signal">{payBandWarning}</span> : null}
          </div>
        </div>

      </header>

      {/* The ATS panel (back 2026-11-07 night, Teja's ask): below the facts line, full width, so it no longer
          floats off the column as the morning audit found. Its chips only pre-fill this row's AI chat, and only
          where that chat is shown (the same condition the panel below uses). */}
      <CoverageBar
        diff={diff}
        onSuggest={
          runEdit !== null && onAssist !== undefined && !editDisabledReason
            ? (keyword) => setChatSeed({ text: `Add ${keyword} where I can defend it` })
            : undefined
        }
      />

      {/* The alarm only when a claim remains; an edits-only row is B for a different reason. */}
      {claims.length > 0 ? (
        <FabricationAlert
          claims={claims}
          decisions={decisions}
          onDecide={decide}
          busy={busy}
        />
      ) : bucket === 'A' ? (
        <p className="clear-notice">
          Every line traces to your master profile. Safe to
          batch-approve with the other clean applications.
        </p>
      ) : diff.editCount === 0 ? null : (
        /* Only when there are edits: a row that is B for a dropped keyword alone says so below,
           and "You made 0 changes" would be false. */
        <p className="diff__edit-note">
          {/* R2: an edited row never rides the batch button, and this says why it left. "Changes",
              not "lines", since 2026-11-01: a moved section or an added certification is counted too. */}
          You made {diff.editCount} {diff.editCount === 1 ? 'change' : 'changes'}, so this
          application needs your individual approval rather than the batch.
        </p>
      )}

      {/* P2 #17: a posting keyword the master bullet had and the tailored one lost. Its own block, never
          the fabrication alarm, because the words that remain are true. Still visible, because the
          auditor flagged it and it is why the row left the batch. The reason is the auditor's own
          text, as a React child (escaped), already length-capped by the adapter. */}
      {(diff.keywordDrops?.length ?? 0) > 0 ? (
        <div className="diff__keyword-drops">
          {/* The plain-words heading. */}
          <p className="diff__keyword-drops-head">Dropped a JD keyword your master had</p>
          {/* One item per flagged bullet, in the auditor's words. */}
          <ul>
            {diff.keywordDrops?.map((note) => (
              // Path plus reason, unique per finding.
              <li key={note.key}>{note.reason}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {/* D5a: the structural half of that count, named, so a reordered resume never looks untouched
          (a moved section has no line of its own in Changes by AI). */}
      {structureChanges.length > 0 ? (
        // One block: the lead-in and its list read together.
        <div className="diff__structure-changes">
          {/* The lead-in, in the "by you" words every other change on this screen uses. */}
          <p className="diff__structure-changes-head">Structure changed by you</p>
          {/* `list-style` is kept here, so the list keeps its semantics without a role. */}
          <ul>
            {structureChanges.map((change, index) => (
              // Index in the key: two entries can share a label, and so a sentence.
              <li key={index + ':' + change}>{change}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {/* D4: the reason editing is off, once, above the changes it applies to. */}
      {onEdit !== undefined && editDisabledReason ? (
        <p className="diff__edit-note">{editDisabledReason}</p>
      ) : null}

      {/* The AI box, only where an edit could honestly land: a save path, an ask, and editing on.
          Keyed by row so a new row never shows the previous row's proposals. */}
      {(() => {
        // The panel itself: bound to THIS row's onEdit and id, so whatever it applies lands on this row only.
        const panel =
          runEdit !== null && onAssist !== undefined && !editDisabledReason ? (
            <AiEditPanel key={diff.applicationId} diff={diff} onEdit={runEdit} onAssist={onAssist} busy={busy} categories={attestCategories ?? []} chat={chat} structure={assistStructure ?? undefined} seed={chatSeed} />
          ) : /* Docked and read-only: say why, instead of a dock that is silently empty. */ chatDock?.active === true && editDisabledReason ? (
            <p className="diff__edit-note">AI chat is off for this resume: {editDisabledReason}</p>
          ) : null;
        // Not docked: inline in the card, exactly as before.
        if (chatDock === undefined) return panel;
        /* Docked: a row's panel is created the first time it is docked, then only HIDDEN when another row takes the
           dock, never unmounted. Unmounting would drop a half-typed prompt and pending op cards, and a request
           still in flight would finish against a chat nobody can see. */
        if (!chatDock.active && !everDocked) return null;
        // The dock element must exist to render into.
        return chatDock.node !== null ? createPortal(<div hidden={!chatDock.active}>{panel}</div>, chatDock.node) : null;
      })()}

      {/* D2: the changed lines, each with its Reset; nothing when the resume is the tailor's own. */}
      <ChangesByAi diff={diff} onReset={resetEdit} busy={busy} />

      <footer className="diff__actions">
        {/* R6: said where the approval happens, because the Auditor saw only the tailor's words. Since
            2026-11-05 Approve re-checks an edited resume first, so the line says that instead of
            "not re-audited", which stopped being true. */}
        {diff.editCount > 0 ? (
          <p className="diff__own-wording">
            Approve re-checks your edits against your master profile first.
          </p>
        ) : null}
        {/* The held re-check (2026-11-05): what the audit found, or why it could not check, right
            above the button that now approves past it. Inline only; never a browser dialog. */}
        {approveHold === undefined ? null : (
          <div className="diff__approve-hold">
            {approveHold.kind === 'flagged' ? (
              <>
                {/* The count first, so the size of the problem is read before the list. */}
                <p>
                  The re-check found {approveHold.findings.length}{' '}
                  {approveHold.findings.length === 1 ? 'claim' : 'claims'} your master profile does not support:
                </p>
                {/* Each finding: the quoted words, then the auditor's reason in its own words. */}
                <ul>
                  {approveHold.findings.map((finding, index) => (
                    <li key={`${finding.path}-${index}`}>
                      <q>{finding.claim}</q> ({finding.reason})
                    </li>
                  ))}
                </ul>
              </>
            ) : (
              /* Could not run: said as such, so a hold here never reads as "found nothing". */
              <p>Your edits could not be re-checked: {approveHold.why}</p>
            )}
          </div>
        )}
        {/* The letter was written from the tailor's version and is not regenerated. */}
        {hasCoverLetter === true && diff.editCount > 0 ? (
          <p className="diff__edit-note">Cover letter was generated before your edits.</p>
        ) : null}

        {/* Explains a disabled Approve before the operator reaches for it. */}
        {undecided.length === 0 ? null : (
          <p className="diff__gate-note">
            {undecided.length} {undecided.length === 1 ? 'claim needs' : 'claims need'}{' '}
            a decision above.
          </p>
        )}

        {/* The one action bar: Approve, then Reject behind its inline confirm. */}
        <ApprovalActions
          // One confirm per row, so arming this row's question closes any other.
          confirmId={'reject:' + diff.applicationId}
          // The row, as the confirm names it.
          subject={`${diff.jobTitle} at ${diff.companyName}`}
          // The per-claim gate.
          canApprove={canApprove}
          // The ordinary label, or the held card's second-click label.
          approveLabel={approveHold === undefined ? 'Approve and queue for submission' : approveHold.kind === 'flagged' ? 'Approve with these' : 'Approve unchecked'}
          /* Only decisions about claims that are still in the resume. A held card's click is the
             acknowledgement, so it says so; the page sends only if the stored version is unchanged. */
          onApproveClick={() => onApprove(new Map([...decisions].filter(([key]) => liveKeys.has(key))), approveHold !== undefined)}
          // Reached only from the confirm's Confirm.
          onReject={onReject}
          // Reject waits for any save, like every other control.
          busy={busy}
        />
      </footer>
    </article>
  );
}
