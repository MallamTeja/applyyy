/* Master profile - the resume as structured fields (section 15).
 *
 * The master is JSON, not a document. Every tailored resume is a SELECTION AND
 * REWORDING of the nodes on this page and can be nothing else: the Tailor
 * returns references into this structure plus a reworded string per reference,
 * and an id that is not here fails the whole tailoring.
 *
 * Editing creates version N+1; old versions never change. Applications store
 * the version they derived from, which is what makes resume pinning true six
 * months later.
 *
 * DUAL INTAKE PIPELINE:
 * 1. PDF Upload (Primary): Select master-resume.pdf directly. Parsed browser-side
 *    via extractPdf before reconciliation against the stored profile.
 * 2. JSON Paste (Advanced): Paste handwritten JSON to run static integrity checks.
 */

import { useCallback, useEffect, useState } from 'react';
import type { ReactElement } from 'react';

import { PageHeader } from '../../app/PageHeader';
import { ingestMasterProfileText } from './masterIngest';
import type { IngestResult } from './masterIngest';
import { MasterUploadReview } from './MasterUploadReview';
import { loadCurrentMasterProfile } from './masterStore';
import { extractPdf } from './pdfExtractor';
import { supabase } from '../../data/supabase';
import type { MasterProfile } from '../../data/contract';

import './settings.css';

/* The sections of the master, in the order a resume is read. */
const SECTIONS: readonly { readonly name: string; readonly note: string }[] = [
  {
    name: 'Identity',
    note: 'Name, email, phone, links. Copied verbatim into every resume and never tailored - there is no shape in the contract that lets an employer or a name be reworded.',
  },
  {
    name: 'Skills',
    note: 'Each skill is a node with an id. A tailored resume can only choose from these and reorder them. A skill carries no free text anywhere in the pipeline, so there is nowhere to type one that is not here.',
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

/* Findings, grouped by severity. */
function Findings({ result }: { readonly result: IngestResult }): ReactElement {
  const blocking = result.findings.filter((f) => f.severity === 'blocking');
  const advisory = result.findings.filter((f) => f.severity === 'advisory');

  return (
    <>
      {result.ok ? (
        <p className="ingest__verdict ingest__verdict--ok">
          This profile can be stored.{' '}
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
              <li
                key={finding.path + finding.problem}
                className="ingest__item ingest__item--blocking"
              >
                <span className="identifier">{finding.path}</span>
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

export function MasterProfilePage(): ReactElement {
  /* Currently stored profile in Supabase, loaded on mount */
  const [stored, setStored] = useState<MasterProfile | null>(null);

  /* State for browser-side PDF intake */
  const [pdfProfile, setPdfProfile] = useState<MasterProfile | null>(null);
  const [pdfExtracting, setPdfExtracting] = useState<boolean>(false);
  const [pdfError, setPdfError] = useState<string | null>(null);

  /* State for JSON paste check */
  const [text, setText] = useState('');
  const [result, setResult] = useState<IngestResult | null>(null);

  /* Read the stored profile once on mount */
  useEffect(() => {
    if (supabase === null) return;
    let live = true;
    void loadCurrentMasterProfile(supabase).then((outcome) => {
      if (!live) return;
      if (outcome.kind === 'loaded') setStored(outcome.profile);
    });
    return () => {
      live = false;
    };
  }, []);

  /* Handler: process resume PDF file directly in the browser */
  const handlePdfUpload = useCallback(async (file: File) => {
    setPdfExtracting(true);
    setPdfError(null);
    try {
      const buffer = await file.arrayBuffer();
      const bytes = new Uint8Array(buffer);
      /* Parse PDF strictly browser-side; bytes never touch network unapproved */
      const extracted = await extractPdf(bytes);
      setPdfProfile(extracted);
    } catch (err) {
      setPdfError(err instanceof Error ? err.message : 'Failed to extract resume PDF.');
    } finally {
      setPdfExtracting(false);
    }
  }, []);

  return (
    <div className="page">
      <PageHeader path="master-profile" />

      {/* Prominent Master Resume PDF Upload Section */}
      <section className="settings-group">
        <h2 className="settings-group__title">Upload Master Resume (.pdf)</h2>
        <p className="settings-group__note">
          Select or drag your master-resume.pdf file. Text, sections, and links are extracted
          strictly browser-side on your device before reconciliation.
        </p>

        <div className="pdf-upload-card">
          <label className="pdf-upload-card__button">
            <span>📄 Choose Master Resume PDF</span>
            <input
              type="file"
              accept=".pdf"
              className="pdf-upload-card__input"
              aria-label="Upload master resume PDF"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void handlePdfUpload(file);
              }}
            />
          </label>
          <span className="ingest__reassurance">
            Runs 100% browser-side on your device. Zero unapproved server uploads.
          </span>
          {pdfExtracting && (
            <p className="store-notice store-notice--ok">Extracting resume PDF browser-side...</p>
          )}
          {pdfError !== null && (
            <p className="store-notice store-notice--bad">{pdfError}</p>
          )}
        </div>

        {/* Once extracted from PDF, immediately display review and accept gate */}
        {pdfProfile !== null && (
          <div style={{ marginTop: 'var(--gap-4)' }}>
            <MasterUploadReview previous={stored} incoming={pdfProfile} />
          </div>
        )}
      </section>

      {/* Secondary / Advanced: Paste JSON */}
      <section className="settings-group">
        <h2 className="settings-group__title">Or paste master profile JSON to check it</h2>
        <p className="settings-group__note">
          Nothing is stored by this button. It reads the JSON, reports every problem in one pass,
          and lets you check whether the profile is safe to become the next version.
        </p>

        <textarea
          className="ingest__input"
          value={text}
          onChange={(event) => {
            setText(event.target.value);
            setResult(null);
          }}
          rows={8}
          spellCheck={false}
          placeholder='{ "schema_version": 1, "identity": { ... }, "skills": [ ... ], ... }'
          aria-label="Master profile JSON"
        />

        <div className="ingest__actions">
          <button
            type="button"
            className="ingest__button"
            disabled={text.trim().length === 0}
            onClick={() => setResult(ingestMasterProfileText(text))}
          >
            Check this profile
          </button>
          <span className="ingest__reassurance">
            Checking runs entirely in this page - nothing leaves your machine. Storing is a
            separate step below, and only happens after you accept.
          </span>
        </div>

        {result !== null && <Findings result={result} />}

        {result !== null && result.ok && (
          <div style={{ marginTop: 'var(--gap-4)' }}>
            <MasterUploadReview previous={stored} incoming={result.profile} />
          </div>
        )}
      </section>

      {SECTIONS.map((section) => (
        <section key={section.name} className="settings-group">
          <h2 className="settings-group__title">{section.name}</h2>
          <p className="settings-group__note">{section.note}</p>
        </section>
      ))}
    </div>
  );
}
