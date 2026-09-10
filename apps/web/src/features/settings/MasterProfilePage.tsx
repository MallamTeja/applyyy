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
 */

import type { ReactElement } from 'react';

import { PageHeader } from '../../app/PageHeader';

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

export function MasterProfilePage(): ReactElement {
  return (
    <div className="page">
      <PageHeader path="master-profile" />

      <p className="not-wired">
        The editor is not built yet. It is the one screen that has to be right
        before any tailoring is worth doing, and it needs the versioning
        behaviour wired first - a half-working editor here would create master
        versions nobody meant to create, and old versions can never be changed.
      </p>

      {SECTIONS.map((section) => (
        <section key={section.name} className="settings-group">
          <h2 className="settings-group__title">{section.name}</h2>
          <p className="settings-group__note">{section.note}</p>
        </section>
      ))}
    </div>
  );
}
