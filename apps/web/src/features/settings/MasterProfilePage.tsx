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

import { useCallback, useEffect, useId, useState } from 'react';
import type { FormEvent, ReactElement } from 'react';

import { PageHeader } from '../../app/PageHeader';
// Profile links are parsed out of an uploaded resume, so they get the same http(s) gate.
import { safeHref } from '../../app/safeHref.ts';
// The per-section add forms: which fields each kind asks for, and the save as a new version.
import { ADD_FIELDS, saveMasterAddition } from './masterAdd';
// The kind union and the typed values, so the form and the save agree on keys.
import type { AddKind, AddValues } from './masterAdd';
import { ingestMasterProfileText } from './masterIngest';
import type { IngestResult } from './masterIngest';
import { MasterUploadReview } from './MasterUploadReview';
import { loadCurrentMasterProfile } from './masterStore';
import { extractPdf } from './pdfExtractor';
import { supabase } from '../../data/supabase';
import type { MasterProfile } from '../../data/contract';

import './settings.css';



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

/* What a save tells the add form: the new version, or why nothing was written.
   A union, so the form cannot show "saved" over a refusal. */
type AddSave = (kind: AddKind, values: AddValues) => Promise<{ ok: true; version: number } | { ok: false; message: string }>;

/* One "+ Add" button that opens an inline form for one node kind.
 * Inline rather than a modal: the new node appears in the list right above the form, so the
 * operator sees it land where it will print. Fields come from ADD_FIELDS, so the form and
 * addToMaster read the same keys and cannot drift. */
// Destructured so the body reads each prop by name.
function AddEntry({ kind, onSave, suggestions }: {
  // Which node kind this form adds.
  readonly kind: AddKind;
  // Writes the new version; the page owns the client and the stored profile.
  readonly onSave: AddSave;
  // Optional dropdown hints per field key, e.g. existing skill groups.
  readonly suggestions?: Readonly<Record<string, readonly string[]>>;
}): ReactElement {
  // Closed by default so seven sections do not show seven empty forms.
  const [open, setOpen] = useState(false);
  // What has been typed, by field key.
  const [values, setValues] = useState<Record<string, string>>({});
  // True while the insert is in flight, so a double click cannot store two versions.
  const [saving, setSaving] = useState(false);
  // The refusal, shown verbatim under the fields.
  const [error, setError] = useState<string | null>(null);
  // The last success, shown beside the button after the form closes.
  const [saved, setSaved] = useState<number | null>(null);
  // A unique prefix for datalist ids, since several forms share the page.
  const listId = useId();

  /* Submit: save, then close on success or keep the typed values on refusal. */
  const submit = async (event: FormEvent): Promise<void> => {
    // A form submit would otherwise reload the page.
    event.preventDefault();
    // Lock the form and clear the last refusal.
    setSaving(true);
    // A new attempt starts with no error on screen.
    setError(null);
    // The page reads the newest master, appends and inserts.
    const outcome = await onSave(kind, values);
    // Unlock either way.
    setSaving(false);
    // Refused: keep what was typed so nothing has to be retyped.
    if (!outcome.ok) {
      // Shown under the fields.
      setError(outcome.message);
      // Nothing else changes.
      return;
    }
    // Landed: clear the form for the next add.
    setValues({});
    // Close it; the new node is now in the list above.
    setOpen(false);
    // Say which version it became.
    setSaved(outcome.version);
  };

  // Closed: just the button, plus the last save's confirmation.
  if (!open) {
    // The closed state is small enough to return early.
    return (
      // The ingest row style: button and note side by side, wrapping on narrow screens.
      <div className="ingest__actions">
        {/* Opens the form; clears an old confirmation so it never reads as this add's result. */}
        <button type="button" className="button" onClick={() => { setOpen(true); setSaved(null); }}>
          {/* The plus sign marks it as an add, not an edit; every kind name reads as plain English. */}
          ＋ Add {kind}
        </button>
        {/* Confirms the write with the database-assigned version. */}
        {saved !== null && <span className="ingest__reassurance">Saved as master version {saved}.</span>}
      </div>
    );
  }

  // Open: the fields for this kind, then Save and Cancel.
  return (
    // The same panel style the watchlist and blocklist add forms use.
    <form className="watchlist-add-form" onSubmit={(event) => void submit(event)}>
      {/* One input per field, in the order ADD_FIELDS lists them. */}
      {ADD_FIELDS[kind].map((field) => {
        // Datalist hints for this field, if the page passed any.
        const hints = suggestions?.[field.key];
        // Shared props for input and textarea.
        const common = {
          // The base input style from base.css.
          className: 'field__control',
          // Controlled, so a refusal keeps the text.
          value: values[field.key] ?? '',
          // Native required: the browser blocks a blank submit before any network call.
          required: field.required,
          // Locked while saving.
          disabled: saving,
          // Example text.
          placeholder: field.placeholder,
        };
        // One labelled field.
        return (
          // A wrapping <label>, so clicking the text focuses the input and getByLabel finds it.
          <label key={field.key} className="field">
            {/* The label, with a star on required fields. */}
            <span className="field__label">{field.label}{field.required ? ' *' : ''}</span>
            {/* Textarea or input, by the field's own flag. */}
            {field.multiline ? (
              // Bullets and summary need several lines.
              <textarea {...common} rows={4} onChange={(e) => setValues({ ...values, [field.key]: e.target.value })} />
            ) : (
              // One line; linked to the datalist when hints exist.
              <input {...common} type="text" list={hints ? `${listId}-${field.key}` : undefined} onChange={(e) => setValues({ ...values, [field.key]: e.target.value })} />
            )}
            {/* Native dropdown of existing values; free text still allowed. */}
            {hints && (
              // The id the input's `list` attribute points at.
              <datalist id={`${listId}-${field.key}`}>
                {/* One option per existing value. */}
                {hints.map((hint) => <option key={hint} value={hint} />)}
              </datalist>
            )}
            {/* Help line, e.g. the #tag syntax. */}
            {field.help && <span className="field__help">{field.help}</span>}
          </label>
        );
      })}
      {/* The refusal, announced to screen readers. */}
      {error !== null && <p className="watchlist-feedback watchlist-feedback--error" role="alert">{error}</p>}
      {/* Same row style as the page's other primary actions. */}
      <div className="ingest__actions">
        {/* The primary action; disabled while the insert is in flight. */}
        <button type="submit" className="ingest__button" disabled={saving}>
          {/* Says it makes a new version, because master versions are never edited in place. */}
          {saving ? 'Saving…' : 'Save as new version'}
        </button>
        {/* Close without writing; typed values are dropped. */}
        <button type="button" className="button" disabled={saving} onClick={() => { setOpen(false); setValues({}); setError(null); }}>
          {/* Plain word; nothing is written. */}
          Cancel
        </button>
      </div>
    </form>
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

  /* Whether the stored-profile read has finished, and how. `stored === null` alone
     cannot tell "no profile yet" from "the read failed" — and the reconciler treats
     null as a FIRST upload, minting fresh ids for every node and orphaning every
     application pinned to the old ones. So uploads are gated on 'ready', never on null. */
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'failed'>(
    // No client means no read to wait for; the store step reports "not connected" itself.
    supabase === null ? 'ready' : 'loading',
  );
  /* The database's own words for a failed read, shown so the block is explainable. */
  const [loadError, setLoadError] = useState<string | null>(null);
  /* Every intake path needs the same gate, so compute it once. */
  const canReconcile = loadState === 'ready';

  /* Read the stored profile once on mount */
  useEffect(() => {
    if (supabase === null) return;
    let live = true;
    void loadCurrentMasterProfile(supabase).then((outcome) => {
      if (!live) return;
      // A failed read used to be dropped here, leaving `stored` null so the next upload
      // reconciled as a first upload. Record it and keep uploads blocked instead.
      if (outcome.kind === 'failed') {
        // Keep the message for the banner below.
        setLoadError(outcome.message);
        // 'failed' keeps every reconcile path locked.
        setLoadState('failed');
        return;
      }
      // 'none' is a genuine first upload, so `stored` correctly stays null.
      if (outcome.kind === 'loaded') setStored(outcome.profile);
      // Either answer is trustworthy, so reconciling may proceed.
      setLoadState('ready');
    });
    return () => {
      live = false;
    };
  }, []);

  /* Handler: every section's "+ Add" saves through here, then the page shows the new version. */
  // useCallback so the seven AddEntry forms get a stable prop across re-renders.
  const handleAdd = useCallback<AddSave>(async (kind, values) => {
    // No client means nowhere to write.
    if (supabase === null) return { ok: false, message: 'Not connected to the database.' };
    // Reads the NEWEST master, appends, inserts version N+1.
    const outcome = await saveMasterAddition(supabase, kind, values);
    // The page now shows the version that was just stored, including the new node.
    if (outcome.ok) setStored(outcome.profile);
    // The form reads only ok, version and message; the extra profile field is harmless.
    return outcome;
  }, []);

  /* Existing skill groups, offered as hints so a new skill joins a group instead of minting a near-duplicate. */
  const skillGroups = [...new Set(stored?.skills.map((skill) => skill.category) ?? [])];

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

      {/* Loud, and above both intake paths, because it is the reason both are locked. */}
      {loadState === 'failed' && (
        <p className="store-notice store-notice--bad" role="alert">
          {/* Says what failed and why uploading is blocked, so a disabled input is not read as a bug. */}
          Could not load your stored master profile, so uploads are blocked: reconciling
          without it would treat this as a first upload and re-identify every node your
          applications point at. Reload to retry.{' '}
          {/* The database's own message, for diagnosis. */}
          <span className="identifier">{loadError}</span>
        </p>
      )}
      {/* Tells the user why the input is briefly disabled on mount. */}
      {loadState === 'loading' && (
        <p className="store-notice store-notice--ok">Loading your stored master profile...</p>
      )}

      {/* Prominent Master Resume PDF Upload Section */}
      <section className="settings-group">
        <h2 className="settings-group__title">Upload Master Resume (.pdf)</h2>
        <p className="settings-group__note">
          Select or drag your master-resume.pdf file. Text, sections, and links are extracted
          strictly browser-side on your device before reconciliation.
        </p>

        <div className="pdf-upload-card">
          <label className="pdf-upload-card__button">
            <span>Choose Master Resume PDF (.pdf)</span>
            <input
              type="file"
              accept=".pdf"
              className="pdf-upload-card__input"
              aria-label="Upload master resume PDF"
              /* Locked until the stored profile is known, so nothing reconciles against a false "first upload". */
              disabled={!canReconcile}
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void handlePdfUpload(file);
              }}
            />
          </label>
          <span className="ingest__reassurance">
            Parsed locally in browser.
          </span>
          {pdfExtracting && (
            <p className="store-notice store-notice--ok">Extracting resume PDF browser-side...</p>
          )}
          {pdfError !== null && (
            <p className="store-notice store-notice--bad">{pdfError}</p>
          )}
        </div>

        {/* Once extracted from PDF, immediately display review and accept gate */}
        {pdfProfile !== null && canReconcile && (
          <div style={{ marginTop: 'var(--gap-4)' }}>
            <MasterUploadReview previous={stored} incoming={pdfProfile} />
          </div>
        )}
      </section>

      {/* Secondary / Advanced: Paste JSON */}
      <section className="settings-group">
        <h2 className="settings-group__title">Paste Master Profile JSON</h2>
        <p className="settings-group__note">
          Validate JSON structure and schema compliance before updating your master profile.
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
            /* Same gate as the PDF path: a checked paste goes straight into reconciliation. */
            disabled={text.trim().length === 0 || !canReconcile}
            onClick={() => setResult(ingestMasterProfileText(text))}
          >
            Check this profile
          </button>
        </div>

        {result !== null && <Findings result={result} />}

        {result !== null && result.ok && canReconcile && (
          <div style={{ marginTop: 'var(--gap-4)' }}>
            <MasterUploadReview previous={stored} incoming={result.profile} />
          </div>
        )}
      </section>

      {/* Stored Master Profile Sections */}
      {stored !== null && (
        <div className="store-notice store-notice--ok" style={{ marginBottom: 'var(--gap-4)' }}>
          <strong>Active Stored Master Profile Loaded:</strong> {stored.skills.length} skills,{' '}
          {stored.experience.length} experiences, {stored.projects.length} projects,{' '}
          {stored.education.length} qualifications.
        </div>
      )}

      {/* 1. Identity */}
      <section className="settings-group">
        <div className="section-head-with-meta">
          <h2 className="settings-group__title">Identity</h2>
          <span className="section-counter">Contact & Links</span>
        </div>
        <p className="settings-group__note">
          Name, email, phone, links. Copied verbatim into every resume and never tailored.
        </p>
        {stored ? (
          <div className="profile-card">
            <div className="profile-card__identity-header">
              <h3 className="profile-card__name">{stored.identity.full_name}</h3>
              {stored.identity.headline && (
                <span className="profile-card__headline">{stored.identity.headline}</span>
              )}
            </div>
            <div className="profile-card__contact-row">
              <span className="contact-item">{stored.identity.email}</span>
              {stored.identity.phone && (
                <span className="contact-item">{stored.identity.phone}</span>
              )}
              {stored.identity.location && (
                <span className="contact-item">{stored.identity.location}</span>
              )}
            </div>
            {stored.identity.links.length > 0 && (
              <div className="profile-card__links-row">
                {stored.identity.links.map((link) => (
                  <a
                    key={link.id}
                    href={safeHref(link.url)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="profile-link-badge"
                  >
                    {link.label}
                  </a>
                ))}
              </div>
            )}
          </div>
        ) : (
          <p className="profile-empty-note">
            No profile stored yet. Upload your master resume PDF above or paste JSON to populate.
          </p>
        )}
        {/* Name and email are singletons; what identity can gain is another link. */}
        {stored && <AddEntry kind="link" onSave={handleAdd} />}
      </section>

      {/* 2. Professional Summary: shown whenever a profile exists, so a missing one can be added. */}
      {stored && (
        // Same group shell as every other section.
        <section className="settings-group">
          {/* Title left, node id right. */}
          <div className="section-head-with-meta">
            {/* The section name. */}
            <h2 className="settings-group__title">Professional Summary</h2>
            {/* The node id, only when there is a node. */}
            {stored.summary && (
              // Shown so a tailored summary's ref can be traced back by eye.
              <span className="section-counter">
                Node: <code className="identifier">{stored.summary.id}</code>
              </span>
            )}
          </div>
          <p className="settings-group__note">
            Human-maintained ground-truth summary. Reworded into tailored resumes referencing this node.
          </p>
          {/* One summary per master: show it, or offer to add it. */}
          {stored.summary ? (
            // The stored paragraph, verbatim.
            <div className="profile-card">
              {/* Unchanged rendering from before the add forms. */}
              <p style={{ margin: 0, lineHeight: 1.5 }}>{stored.summary.text}</p>
            </div>
          ) : (
            // No summary yet: the only state where adding one makes sense.
            <AddEntry kind="summary" onSave={handleAdd} />
          )}
        </section>
      )}

      {/* 3. Skills */}
      <section className="settings-group">
        <div className="section-head-with-meta">
          <h2 className="settings-group__title">Skills</h2>
          <span className="section-counter">
            {stored ? `${stored.skills.length} skills stored` : '0 skills'}
          </span>
        </div>
        <p className="settings-group__note">
          Each skill is a node with an id. A tailored resume can only choose from these and reorder them.
        </p>
        {stored && stored.skills.length > 0 ? (
          <div className="skills-cloud">
            {stored.skills.map((skill) => (
              <div key={skill.id} className="skill-chip-full">
                <span className="skill-chip-full__name">{skill.name}</span>
                {skill.category && (
                  <span className="skill-chip-full__category">{skill.category}</span>
                )}
                <code className="skill-chip-full__id">{skill.id}</code>
              </div>
            ))}
          </div>
        ) : (
          <p className="profile-empty-note">No skills stored yet.</p>
        )}
        {/* Existing groups offered as hints, so a new skill joins one instead of minting a near-duplicate. */}
        {stored && <AddEntry kind="skill" onSave={handleAdd} suggestions={{ category: skillGroups }} />}
      </section>

      {/* 4. Experience */}
      <section className="settings-group">
        <div className="section-head-with-meta">
          <h2 className="settings-group__title">Experience</h2>
          <span className="section-counter">
            {stored ? `${stored.experience.length} roles` : '0 roles'}
          </span>
        </div>
        <p className="settings-group__note">
          Companies and roles, each with bullets. A tailored bullet must reference one of these and may only reword it.
        </p>
        {stored && stored.experience.length > 0 ? (
          <div className="profile-stack">
            {stored.experience.map((exp) => (
              <div key={exp.id} className="profile-entry-card">
                <div className="profile-entry-card__top">
                  <div>
                    <h3 className="profile-entry-card__role">{exp.role}</h3>
                    <span className="profile-entry-card__company">{exp.company}</span>
                  </div>
                  <div className="profile-entry-card__meta">
                    <span className="profile-entry-card__date">
                      {exp.start_display} - {exp.end_display}
                    </span>
                    {exp.location && (
                      <span className="profile-entry-card__loc">{exp.location}</span>
                    )}
                  </div>
                </div>
                {exp.bullets.length > 0 && (
                  <ul className="profile-bullet-list">
                    {exp.bullets.map((b) => (
                      <li key={b.id} className="profile-bullet-item">
                        <span className="profile-bullet-text">{b.text}</span>
                        <div className="profile-bullet-meta">
                          <code className="identifier">{b.id}</code>
                          {b.tags.map((t) => (
                            <span key={t} className="profile-tag">
                              #{t}
                            </span>
                          ))}
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            ))}
          </div>
        ) : (
          <p className="profile-empty-note">No experience stored yet.</p>
        )}
        {/* A new role, appended last; document order is resume order. */}
        {stored && <AddEntry kind="experience" onSave={handleAdd} />}
      </section>

      {/* 5. Projects */}
      <section className="settings-group">
        <div className="section-head-with-meta">
          <h2 className="settings-group__title">Projects</h2>
          <span className="section-counter">
            {stored ? `${stored.projects.length} projects` : '0 projects'}
          </span>
        </div>
        <p className="settings-group__note">
          Same structure as experience. The most relevant projects to each job get featured.
        </p>
        {stored && stored.projects.length > 0 ? (
          <div className="profile-stack">
            {stored.projects.map((proj) => (
              <div key={proj.id} className="profile-entry-card">
                <div className="profile-entry-card__top">
                  <div>
                    <h3 className="profile-entry-card__role">{proj.name}</h3>
                    {proj.links && proj.links.length > 0 && (
                      <div style={{ display: 'flex', gap: 'var(--gap-2)', marginTop: '4px' }}>
                        {proj.links.map((l) => (
                          <a
                            key={l.id}
                            href={safeHref(l.url)}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="profile-link-badge"
                          >
                            {l.label}
                          </a>
                        ))}
                      </div>
                    )}
                  </div>
                  <div className="profile-entry-card__meta">
                    <span className="profile-entry-card__date">
                      {proj.start_display} - {proj.end_display}
                    </span>
                  </div>
                </div>
                {proj.bullets.length > 0 && (
                  <ul className="profile-bullet-list">
                    {proj.bullets.map((b) => (
                      <li key={b.id} className="profile-bullet-item">
                        <span className="profile-bullet-text">{b.text}</span>
                        <div className="profile-bullet-meta">
                          <code className="identifier">{b.id}</code>
                          {b.tags.map((t) => (
                            <span key={t} className="profile-tag">
                              #{t}
                            </span>
                          ))}
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            ))}
          </div>
        ) : (
          <p className="profile-empty-note">No projects stored yet.</p>
        )}
        {/* A new project with optional live and GitHub links. */}
        {stored && <AddEntry kind="project" onSave={handleAdd} />}
      </section>

      {/* 6. Education */}
      <section className="settings-group">
        <div className="section-head-with-meta">
          <h2 className="settings-group__title">Education</h2>
          <span className="section-counter">
            {stored ? `${stored.education.length} qualifications` : '0 qualifications'}
          </span>
        </div>
        <p className="settings-group__note">
          Degrees and institutions. Copied verbatim or formatted per template.
        </p>
        {stored && stored.education.length > 0 ? (
          <div className="profile-stack">
            {stored.education.map((edu) => (
              <div key={edu.id} className="profile-entry-card">
                <div className="profile-entry-card__top">
                  <div>
                    <h3 className="profile-entry-card__role">{edu.degree}</h3>
                    <span className="profile-entry-card__company">
                      {edu.institution} {edu.field ? `• ${edu.field}` : ''}
                    </span>
                  </div>
                  <div className="profile-entry-card__meta">
                    <span className="profile-entry-card__date">
                      {edu.start_display} - {edu.end_display}
                    </span>
                    {edu.grade_display && (
                      <span className="profile-entry-card__loc">{edu.grade_display}</span>
                    )}
                  </div>
                </div>
                {edu.bullets && edu.bullets.length > 0 && (
                  <ul className="profile-bullet-list">
                    {edu.bullets.map((b) => (
                      <li key={b.id} className="profile-bullet-item">
                        <span className="profile-bullet-text">{b.text}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            ))}
          </div>
        ) : (
          <p className="profile-empty-note">No education stored yet.</p>
        )}
        {/* A new qualification. */}
        {stored && <AddEntry kind="education" onSave={handleAdd} />}
      </section>

      {/* 7. Certifications & Achievements: shown whenever a profile exists, so the first one can be added. */}
      {stored && (
        <section className="settings-group">
          <h2 className="settings-group__title">Certifications & Achievements</h2>
          <div className="profile-stack">
            {stored.certifications.map((cert) => (
              <div key={cert.id} className="profile-entry-card">
                <div className="profile-entry-card__top">
                  <div>
                    <h3 className="profile-entry-card__role">{cert.label}</h3>
                    {cert.description && (
                      <span className="profile-entry-card__company">{cert.description}</span>
                    )}
                  </div>
                  <code className="identifier">{cert.id}</code>
                </div>
                {cert.bullets.length > 0 && (
                  <ul className="profile-bullet-list">
                    {cert.bullets.map((b) => (
                      <li key={b.id} className="profile-bullet-item">
                        <span className="profile-bullet-text">{b.text}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            ))}
            {stored.achievements.map((ach) => (
              <div key={ach.id} className="profile-entry-card">
                <h3 className="profile-entry-card__role">{ach.label}</h3>
                <ul className="profile-bullet-list">
                  {ach.bullets.map((b) => (
                    <li key={b.id} className="profile-bullet-item">
                      <span className="profile-bullet-text">{b.text}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
          {/* Two separate resume sections, so two separate adds. */}
          <AddEntry kind="certification" onSave={handleAdd} />
          <AddEntry kind="achievement" onSave={handleAdd} />
        </section>
      )}
    </div>
  );
}
