// Render the submitted resume, in the worker, at submit time.
//
// THE GUARANTEE: "what you approved is byte-for-byte what gets sent." §7 has
// React and the worker importing the SAME `renderResumeHtml`, and that identity
// is measured rather than assumed — the template's cross-runtime test has Node
// and Deno producing the same sha256 from the same source. Importing the shared
// function is what cashes that measurement in; a worker with its own copy of
// the markup would make the guarantee decorative.
//
// WHY NOT FETCH A PRE-RENDERED PDF FROM STORAGE — the obvious alternative, and
// the wrong one. A pre-rendered artifact can DRIFT from the thing the human
// approved: a PDF produced at tailor time has a relationship to
// `tailored_profile` that degrades the moment anything about the row or the
// template changes, and the drift is invisible, because you would be shipping a
// file rather than a derivation. Rendering at submit time from the pinned,
// immutable snapshot makes the artifact provably downstream of exactly the data
// that was reviewed — the same principle that makes `master_profiles`
// versioned and immutable.
//
// `applications.resume_storage_path` is therefore the RECORD, not the source.
import { createHash } from 'node:crypto';
import type { Page } from 'playwright';
import type { ResolvedResume } from '@applyy/shared-types';
import { renderResumeHtml } from '@applyy/resume-template';

/** What to render, and the page to render it on. */
export interface RenderResumePdfInput {
  // The frozen `ResolvedResume` from `applications.tailored_profile`. Fully
  // denormalised by the validator, so the renderer resolves nothing and cannot
  // reach a master profile even by accident.
  readonly resume: ResolvedResume;
  // Reused from the batch rather than opening its own, because a browser launch
  // is ~475ms and this runs once per application.
  readonly page: Page;
}

/** The produced artifact and its identity. */
export interface RenderedResume {
  readonly bytes: Uint8Array;
  // sha256 of exactly these bytes. Stored alongside the storage path so that
  // "is this the artifact that was approved?" stays answerable months later —
  // a path alone only answers "where is the file". That is the question resume
  // pinning exists for, and it is asked when a recruiter mentions something on
  // the resume and Teja needs to know precisely what was sent.
  readonly sha256: string;
}

export async function renderResumePdf(input: RenderResumePdfInput): Promise<RenderedResume> {
  // The SAME function the approval preview calls. Not a copy, not a variant.
  const html = renderResumeHtml(input.resume);

  // `setContent` rather than navigating to a file: there is no file, and this
  // keeps the rendered document a pure function of the HTML string, with no
  // chance of the browser resolving something else off disk beside it.
  await input.page.setContent(html, { waitUntil: 'domcontentloaded' });

  const bytes = await input.page.pdf({
    // A4 because the target market is India; US Letter would clip the right
    // edge on any printer Teja or a recruiter actually uses.
    format: 'A4',
    // The template's own print stylesheet decides the margins, so Playwright
    // must not add a second set on top of them.
    margin: { top: '0', right: '0', bottom: '0', left: '0' },
    // Background colours and rules are part of the approved design; without
    // this the PDF silently differs from the preview the human signed off.
    printBackground: true,
    // NO header or footer template. Chromium's default footer stamps the DATE
    // and the page URL into every page, which would (a) put "localhost" on a
    // document sent to an employer and (b) make the bytes differ every day,
    // destroying the determinism the approval guarantee depends on.
    displayHeaderFooter: false,
  });

  // Hashed here, over the exact buffer that will be uploaded and attached, so
  // the digest cannot describe a different serialisation than the one sent.
  const sha256 = createHash('sha256').update(bytes).digest('hex');

  return { bytes, sha256 };
}
