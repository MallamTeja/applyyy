/* Master profile - the resume as structured fields (section 15).
 *
 * The master is JSON, not a document. Every tailored resume is a SELECTION AND
 * REWORDING of the nodes on this page and can be nothing else: the Tailor
 * returns references into this structure plus a reworded string per reference,
 * and an id that is not here fails the whole tailoring.
 *
 * That is why this page, not the diff view, is where a missing skill gets
 * fixed. If the Auditor flags "PostgreSQL" and the truth is that Teja has used
 * it, the answer is to add it here and re-tailor - not to wave the claim
 * through at the gate.
 *
 * Editing creates version N+1; old versions never change. Applications store
 * the version they derived from, which is what makes resume pinning true six
 * months later and what keeps an Auditor verdict meaningful: it audited a
 * specific version, and that version still exists.
 *
 * WHY THIS PAGE IS AN INGEST SCREEN BEFORE IT IS AN EDITOR. There is no real
 * master resume in this repo - only a synthetic `ResolvedResume` fixture - so a
 * rich editor would be an editor over nothing. The first useful thing is to
 * take a pasted profile and say exactly what is wrong with it, because the
 * master is hand-maintained JSON and hand-maintained JSON has integrity bugs
 * that no type can catch. The checker behind this page lives in
 * `masterIngest.ts` and is pure, so it is tested directly rather than through
 * the UI.
 */

import { useState } from 'react';
import type { ReactElement } from 'react';

import { PageHeader } from '../../app/PageHeader';
import { ingestMasterProfileText } from './masterIngest';
import type { IngestResult } from './masterIngest';

import './settings.css';

/* The sections of the master, in the order a resume is read. Listed so the
 * shape of the page is visible before the editor behind it exists, and so each
 * one carries the reason its structure is shaped the way it is. */
const SECTIONS: readonly { readonly name: string; readonly note: string }[] = [
  {
    name: 'Identity',
    note: 'Name, email, phone, links. Copied verbatim into every resume and never tailored - there is no shape in the contract that lets an employer or a name be reworded.',
  },
  {
    name: 'Skills',
    note: 'Each skill is a node with an id. A tailored resume can only choose from these and reorder them. A skill carries no free text anywhere in the pipeline, so there is nowhere to type one that is not here - which is why an invented skill is impossible rather than merely detected.',
  },
  {
    name: 'Experience',
    note: 'Companies and roles, each with bullets. A tailored bullet must reference one of these and may only reword it, so the facts survive but the language can match the job.',
  },
  {
    name: 'Projects',
    note: 'Same structure as experience. The two most relevant to each job get featured.',
  },
  {
    name: 'Education',
    note: 'Institution, degree, dates, grade.',
  },
];

/* --- The paste-and-check surface ------------------------------------- */

/* Findings, grouped by severity.
 *
 * Blocking and advisory are rendered as two separate lists rather than one
 * list with badges, because they call for different actions: blocking means
 * fix it before this can be stored, advisory means this will work and
 * disappoint. A single mixed list invites skimming, and the whole point of the
 * distinction is that it should not be skimmed past. */
function Findings({ result }: { readonly result: IngestResult }): ReactElement {
  /* Both severities come from the same array, split here rather than in the
     checker - the checker's job is to report, not to lay out. */
  const blocking = result.findings.filter((f) => f.severity === 'blocking');
  const advisory = result.findings.filter((f) => f.severity === 'advisory');

  return (
    <>
      {/* The verdict, stated before the detail. An operator who pasted 3,000
          characters wants to know accepted-or-not in one glance. */}
      {result.ok ? (
        <p className="ingest__verdict ingest__verdict--ok">
          This profile can be stored.
          {/* Counts next to the verdict, because they are how someone notices a
              section silently failed to paste - "0 experience" is far more
              informative than a generic success message. */}{' '}
          {result.summary.experience} experience, {result.summary.projects}{' '}
          projects, {result.summary.education} education,{' '}
          {result.summary.skills} skills, {result.summary.bullets} bullets in
          total.
        </p>
      ) : (
        <p className="ingest__verdict ingest__verdict--blocked">
          This profile cannot be stored yet. {blocking.length} blocking{' '}
          {blocking.length === 1 ? 'problem' : 'problems'} below.
        </p>
      )}

      {blocking.length > 0 && (
        <>
          <h3 className="ingest__group-title">Must be fixed</h3>
          <ul className="ingest__list">
            {blocking.map((finding) => (
              /* path+problem is unique per finding and stable across renders,
                 so it serves as a key without inventing an index-based one -
                 and an index key would reorder wrongly as findings change. */
              <li
                key={finding.path + finding.problem}
                className="ingest__item ingest__item--blocking"
              >
                {/* The path first and in mono: it is what the operator copies
                    into their editor's search box, and it is the difference
                    between an actionable finding and a shrug. */}
                <span className="identifier">{finding.path}</span>
                {/* Rendered as a React text child. Findings quote values out of
                    the pasted document - which is operator-supplied and, if it
                    ever came from an ATS export, untrusted - so it goes through
                    the same text-only path as everything else. There is no
                    raw-HTML escape hatch in this file. */}
                <span className="ingest__problem">{finding.problem}</span>
              </li>
            ))}
          </ul>
        </>
      )}

      {advisory.length > 0 && (
        <>
          <h3 className="ingest__group-title">Worth knowing</h3>
          <ul className="ingest__list">
            {advisory.map((finding) => (
              <li
                key={finding.path + finding.problem}
                className="ingest__item ingest__item--advisory"
              >
                <span className="identifier">{finding.path}</span>
                <span className="ingest__problem">{finding.problem}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </>
  );
}

function IngestSection(): ReactElement {
  /* The pasted text. Held in state rather than read off the DOM on submit so
     the textarea is a controlled input - which is what lets the checked result
     be cleared the moment the text changes, below. */
  const [text, setText] = useState('');
  /* null means "not checked yet", which is distinct from "checked and found
     nothing wrong". Conflating the two would show an all-clear before the
     operator had pressed anything. */
  const [result, setResult] = useState<IngestResult | null>(null);

  return (
    <section className="settings-group">
      <h2 className="settings-group__title">Paste a master profile to check it</h2>
      <p className="settings-group__note">
        Nothing is stored by this button. It reads the JSON, reports every
        problem it can find in one pass, and tells you whether the profile is
        safe to become the next version.
      </p>
      <p className="settings-group__note">
        The check worth knowing about: every node id has to be unique across the
        whole profile, not just within its own section. Bullets from experience,
        projects and education are indexed together in one flat map downstream,
        so two bullets sharing an id means the second silently replaces the
        first - and the audit check that asks &quot;did I do this at that
        job?&quot; then compares against the wrong one. A duplicate id is also
        the easiest mistake to make in hand-written JSON, because the way anyone
        adds a bullet is to copy the one above it.
      </p>

      <textarea
        className="ingest__input"
        /* Controlled: React owns the value, so clearing the stale result on
           change below is reliable. */
        value={text}
        onChange={(event) => {
          setText(event.target.value);
          /* Clear the previous verdict as soon as the text changes. Leaving it
             on screen would show an all-clear next to text it was never run
             against, which is the most misleading thing this page could do. */
          setResult(null);
        }}
        rows={10}
        spellCheck={false}
        placeholder='{ "schema_version": 1, "identity": { ... }, "skills": [ ... ], ... }'
        aria-label="Master profile JSON"
      />

      <div className="ingest__actions">
        <button
          type="button"
          className="ingest__button"
          /* Nothing to check until something is pasted. Disabled rather than
             hidden so the button's existence tells the operator what the
             textarea is for. */
          disabled={text.trim().length === 0}
          onClick={() => setResult(ingestMasterProfileText(text))}
        >
          Check this profile
        </button>
        {/* Said next to the button rather than in a paragraph above it, because
            this is the reassurance that makes someone willing to paste their
            actual resume into a text box. */}
        <span className="ingest__reassurance">
          Runs entirely in this page. Nothing is uploaded and nothing is saved.
        </span>
      </div>

      {result !== null && <Findings result={result} />}
    </section>
  );
}

export function MasterProfilePage(): ReactElement {
  return (
    <div className="page">
      <PageHeader path="master-profile" />

      <p className="not-wired">
        The editor is not built yet, and storing a checked profile is not wired
        up either - the checker below reports, it does not save. Versioning has
        to be wired first: a half-working editor here would create master
        versions nobody meant to create, and an old version can never be
        changed once an application has pinned it.
      </p>

      <IngestSection />

      {SECTIONS.map((section) => (
        <section key={section.name} className="settings-group">
          <h2 className="settings-group__title">{section.name}</h2>
          <p className="settings-group__note">{section.note}</p>
        </section>
      ))}
    </div>
  );
}
