/* The tailored resume and the master it came from, side by side, each exactly as the
 * shared renderer draws it, each downloadable. Shared by the approval queue and the
 * pipeline history page, so both screens show the same artefact the same way.
 *
 * WHY IFRAMES. The template ships its own complete stylesheet and a white paper
 * background; injected into the page it would collide with the app's CSS in both
 * directions. srcdoc gives each resume a document of its own, so what the operator sees
 * is the document the worker prints, not that document restyled by the dashboard.
 *
 * THE SANDBOX: "allow-same-origin allow-modals", and deliberately NOT "allow-scripts".
 * - No allow-scripts: resume text is downstream of a scraped job description
 *   (constraint 17). The template escapes it; this is the second wall, so even an
 *   escaping bug cannot execute anything here.
 * - allow-same-origin: without it the frame is cross-origin to this page and
 *   contentWindow.print() is not among the calls allowed across origins, so "Download
 *   PDF" would throw. The known escape is allow-same-origin COMBINED with allow-scripts
 *   (the frame's script removes its own sandbox); with no scripts there is nothing
 *   inside to do that.
 * - allow-modals: a sandboxed document may not open the print dialog without it.
 *
 * WHY "DOWNLOAD PDF" IS THE PRINT DIALOG. No PDF is stored anywhere (the worker renders
 * at submit time and keeps the bytes), and apps/web has no PDF library; adding one is a
 * lockfile write. The browser's Save-as-PDF produces the file from the same HTML, and the
 * button's tooltip says that is what it opens, so the label does not overclaim.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactElement } from 'react';
// The approval page's master SHAPE check, so both screens refuse the same malformed masters.
import { masterFromRow } from '../approval/tailoredEdits';

// The snapshot type; the master arrives already shape-checked by masterFromRow.
import type { ResolvedResume } from '../../data/contract';
// The browser client; RLS scopes every read to the signed-in user.
import { supabase } from '../../data/supabase';
// Pure helpers: the shared render, the master mapping, the filename title.
import { buildResumePreview, clampZoom, DEFAULT_PREVIEW_ZOOM, masterAsResume, PAGE_WIDTH_PX, previewDocumentTitle, zoomedPreviewHtml } from './renderPreview';
import type { ResumePreview as RenderedPreview } from './renderPreview';

import './ResumePreview.css';

// The public contract, shared with the pipeline history page; changing it breaks that page.
export interface ResumePreviewProps {
  // Used for element ids, so two previews on one page never share an id.
  readonly applicationId: string;
  // The frozen `applications.tailored_profile` snapshot, already shape-checked by the caller.
  readonly tailoredProfile: ResolvedResume;
  // The PINNED master version the tailoring used (tailored_profile.master_version), so the
  // master pane shows what the tailoring started from, not whatever the latest master is.
  readonly masterVersion: number;
  // For the frame titles and the download filename.
  readonly jobTitle: string;
  // For the frame titles and the download filename.
  readonly companyName: string;
}

// What the master pane can be showing: still asking, a refusal to say, or a render.
type MasterState =
  // The read has not come back yet.
  | { readonly kind: 'loading' }
  // The read failed or found nothing; the message says which.
  | { readonly kind: 'unavailable'; readonly message: string }
  // Rendered (or refused by the renderer) like the tailored pane.
  | { readonly kind: 'ready'; readonly preview: RenderedPreview };

export function ResumePreview({ applicationId, tailoredProfile, masterVersion, jobTitle, companyName }: ResumePreviewProps): ReactElement {
  // Same name in both panes: identity is never tailored.
  const fullName = tailoredProfile.identity?.full_name ?? 'Resume';
  // The tailored pane is a pure function of the snapshot, so it renders immediately.
  const tailored = useMemo(
    () => buildResumePreview(tailoredProfile, previewDocumentTitle(fullName, companyName, 'tailored')),
    [tailoredProfile, fullName, companyName],
  );
  // The master pane needs one read.
  const [master, setMaster] = useState<MasterState>({ kind: 'loading' });

  // Load the master at the pinned version. RLS limits master_profiles to the signed-in
  // user, so filtering by version alone is the user's own row (same rule the Tailor follows:
  // a second user filter would be a second place for the tenant rule to drift).
  useEffect(() => {
    // No client configured: say so instead of spinning forever.
    if (supabase === null) {
      // A plain statement the operator can act on.
      setMaster({ kind: 'unavailable', message: 'Not connected to the database, so the master resume cannot be shown.' });
      // Nothing to cancel.
      return;
    }
    // Cancellation flag, so a closed preview never writes state.
    let live = true;
    // The one read: exactly this version.
    void supabase
      .from('master_profiles')
      .select('profile, version')
      .eq('version', masterVersion)
      .maybeSingle()
      .then(({ data, error }) => {
        // Unmounted mid-read: nothing to report.
        if (!live) return;
        // A failed read and a missing row are different facts and get different words.
        if (error) {
          // "Could not ask".
          setMaster({ kind: 'unavailable', message: `Could not load master resume v${masterVersion}.` });
          return;
        }
        // "Asked, nothing there": the version this tailoring cites is not stored.
        /* A SHAPE check (2026-10-08), not "is it an object": '{}' used to pass and render as an
           empty master beside the tailored resume. Same check as the approval page. */
        const profile = masterFromRow(data?.profile);
        // Missing or malformed are both "no usable master"; never rendered as one.
        if (profile === null) {
          // Named, so the gap is visible next to the tailored resume.
          setMaster({ kind: 'unavailable', message: `Master resume v${masterVersion} is not stored, or is not a valid profile.` });
          return;
        }
        // Map and render through the same renderer as the tailored pane.
        const resume = masterAsResume(profile, masterVersion);
        // Ready, or refused by the renderer; the pane handles both.
        setMaster({ kind: 'ready', preview: buildResumePreview(resume, previewDocumentTitle(fullName, companyName, 'master')) });
      });
    // Cleanup: mark this read stale.
    return () => {
      // Any late result is now ignored.
      live = false;
    };
  }, [masterVersion, fullName, companyName]);

  return (
    <div className="resume-preview" id={`resume-preview-${applicationId}`}>
      {/* Tailored first: it is the thing being approved; the master is the reference. */}
      <ResumePane
        heading={`Tailored for ${companyName}`}
        frameTitle={`Tailored resume for ${jobTitle} at ${companyName}`}
        fileStem={previewDocumentTitle(fullName, companyName, 'tailored')}
        preview={tailored}
      />
      {/* The master pane waits for its read; its states are spelled out, never blank. */}
      {master.kind === 'ready' ? (
        <ResumePane
          heading={`Master v${masterVersion}`}
          frameTitle={`Master resume version ${masterVersion}`}
          fileStem={previewDocumentTitle(fullName, companyName, 'master')}
          preview={master.preview}
        />
      ) : (
        <section className="resume-preview__pane">
          <h3 className="resume-preview__heading">Master v{masterVersion}</h3>
          {/* Loading is said as loading; unavailable as an alert with the reason. */}
          <p className="resume-preview__status" role={master.kind === 'unavailable' ? 'alert' : undefined}>
            {master.kind === 'loading' ? 'Loading the master resume…' : master.message}
          </p>
        </section>
      )}
    </div>
  );
}

// One resume: heading, two downloads, and the sandboxed frame.
interface ResumePaneProps {
  // Visible heading above the frame.
  readonly heading: string;
  // Accessible name of the iframe.
  readonly frameTitle: string;
  // Filename stem for the HTML download.
  readonly fileStem: string;
  // The render, or the renderer's refusal.
  readonly preview: RenderedPreview;
}

function ResumePane({ heading, frameTitle, fileStem, preview }: ResumePaneProps): ReactElement {
  // The frame, so "Download PDF" can print its window rather than the dashboard.
  const frameRef = useRef<HTMLIFrameElement>(null);
  // The operator's chosen zoom, or 'fit' to follow the frame's width (the default view).
  const [chosenZoom, setChosenZoom] = useState<number | 'fit'>('fit');
  // The zoom that makes one A4 width fill the frame; the default stands in until measured.
  const [fitZoom, setFitZoom] = useState(DEFAULT_PREVIEW_ZOOM);
  // What is actually applied: the operator's choice wins over fit once they press -/+.
  const zoom = chosenZoom === 'fit' ? fitZoom : chosenZoom;

  // Measure the frame so "Fit" means "the page width fills this box", whatever the layout
  // (two columns on the queue, one in the pipeline drawer). Declared before the refusal
  // return below, because hooks must run in the same order on every render.
  useEffect(() => {
    // A refused render has no frame to measure.
    const frame = frameRef.current;
    // Nothing mounted, or a browser without ResizeObserver: the default zoom stays.
    if (frame === null || typeof ResizeObserver === 'undefined') return;
    // Recomputed whenever the box changes width (window resize, drawer open).
    const observer = new ResizeObserver(() => {
      // Minus 20px for the frame's own vertical scrollbar, so the page never scrolls sideways.
      // Rounded to 2 places: each new value rebuilds srcdoc (a reload), so sub-pixel jitter must not.
      // Clamped with the buttons' own bounds, so -/+ always move away from the fitted value.
      setFitZoom(clampZoom(Math.round(((frame.clientWidth - 20) / PAGE_WIDTH_PX) * 100) / 100));
    });
    // Watch this pane's frame only.
    observer.observe(frame);
    // Stop watching when the pane goes away.
    return () => observer.disconnect();
  }, [preview.kind]);
  // One zoom step, clamped so neither button can make the page vanish or explode. Each change
  // rebuilds srcdoc, so the frame reloads and its scroll returns to the top (accepted, see report).
  const stepZoom = (delta: number) => setChosenZoom(clampZoom(Math.round((zoom + delta) * 10) / 10));

  // A refused render is SAID, never shown as an empty frame: an empty frame next to an
  // approve button reads as "nothing to check", which is the fail-clean this page avoids.
  if (preview.kind === 'refused') {
    return (
      <section className="resume-preview__pane">
        <h3 className="resume-preview__heading">{heading}</h3>
        <p className="resume-preview__status" role="alert">
          {/* The renderer's reason; the worker would refuse to submit it the same way. */}
          This resume could not be rendered: {preview.message}
        </p>
      </section>
    );
  }

  // The exact rendered document as a file: a Blob of the same srcdoc string.
  function downloadHtml(html: string): void {
    // UTF-8 explicitly, so names with non-ASCII characters survive the round trip.
    const url = URL.createObjectURL(new Blob([html], { type: 'text/html;charset=utf-8' }));
    // A transient anchor is the standard way to name a download.
    const anchor = document.createElement('a');
    // The object URL holding the document.
    anchor.href = url;
    // The suggested filename.
    anchor.download = `${fileStem}.html`;
    // Triggers the download.
    anchor.click();
    // Freed on the next tick, after the browser has taken the reference.
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  return (
    <section className="resume-preview__pane">
      <div className="resume-preview__bar">
        <h3 className="resume-preview__heading">{heading}</h3>
        <span className="resume-preview__actions">
          {/* Zoom affects the frame only; both downloads stay at the template's own size. */}
          <span className="resume-preview__zoom" role="group" aria-label="Preview zoom">
            {/* Smaller page: more of the resume in view. */}
            <button type="button" className="button button--secondary button--small" aria-label="Zoom out" onClick={() => stepZoom(-0.1)}>−</button>
            {/* Back to "page width fills the box", and shows the current percentage. */}
            <button type="button" className="button button--secondary button--small" aria-label={`Fit page width, now ${Math.round(zoom * 100)}%`} onClick={() => setChosenZoom('fit')}>
              {/* The applied zoom, so the operator knows what they are looking at. */}
              {Math.round(zoom * 100)}%
            </button>
            {/* Larger page: easier to read a line closely. */}
            <button type="button" className="button button--secondary button--small" aria-label="Zoom in" onClick={() => stepZoom(0.1)}>+</button>
          </span>
          <button
            type="button"
            className="button button--secondary button--small"
            /* Honest about the mechanism: this opens the browser's dialog. */
            title="Opens your browser's print dialog - choose “Save as PDF”"
            /* Prints the FRAME's document, whose <title> is the default filename. */
            onClick={() => frameRef.current?.contentWindow?.print()}
          >
            {/* What the operator wants, with the mechanism in the tooltip. */}
            Download PDF
          </button>
          <button
            type="button"
            className="button button--secondary button--small"
            /* The exact artefact, for when a print driver alters the layout. */
            title="Saves the exact rendered resume as an HTML file"
            onClick={() => downloadHtml(preview.html)}
          >
            {/* Plain label: it is the HTML file. */}
            Download HTML
          </button>
        </span>
      </div>
      <iframe
        ref={frameRef}
        className="resume-preview__frame"
        title={frameTitle}
        /* See the header: same-origin for print(), modals for the dialog, never scripts. */
        sandbox="allow-same-origin allow-modals"
        /* The shared renderer's document plus a screen-only zoom style; the downloads use
           preview.html untouched, and print media ignores the style (see zoomedPreviewHtml). */
        srcDoc={zoomedPreviewHtml(preview.html, zoom)}
      />
    </section>
  );
}
