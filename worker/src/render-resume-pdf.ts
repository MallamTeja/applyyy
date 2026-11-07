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

  // ---- Two corrections applied to Chromium's raw output --------------------
  //
  // MEASURED, NOT SUSPECTED. Two renders of an identical snapshot 1.5s apart
  // produced files of identical length (77032 bytes) differing in exactly TWO
  // bytes — the seconds digits of `/CreationDate` and `/ModDate`:
  //
  //   /Producer (Skia/PDF m131)
  //   /CreationDate (D:20260910161513+00'00')   <- and ...15 in the second run
  //   /ModDate     (D:20260910161513+00'00')
  //
  // So `page.pdf()` is deterministic in its CONTENT and non-deterministic in its
  // METADATA, which made this file's own determinism test intermittent: two
  // renders inside one wall-clock second matched, and two that straddled a
  // second boundary did not. An intermittent guarantee is not a guarantee, and
  // the failure mode is the worst kind — the test passes on a fast machine and
  // fails in CI, which reads as flake rather than as the real defect it is.
  //
  // Normalising the stamp is not a workaround bolted on; it FINISHES the
  // decision `displayHeaderFooter: false` above already states, whose comment
  // says the date must not reach the document because it would "make the bytes
  // differ every day, destroying the determinism the approval guarantee depends
  // on". That reasoning applies identically to the info dictionary; only the
  // footer had been dealt with.
  const normalised = withFixedPdfTimestamps(bytes);

  // THE ONE-PAGE GATE (Teja, 2026-11-07: "the tailored resume and the resumes after applying
  // edits need to be in 1 page only, this is rule"). The tailor and the web edit gate keep a
  // resume on one page by MODEL (@applyy/resume-template page-fit.ts); this is the real
  // renderer's answer, on the machine that is about to send it, with whatever font that
  // machine resolved. Here, in the one function all four render sites call (apply-one,
  // apply-kit, assisted-submit, rehearse), so no path can attach a two-page PDF. It throws
  // like a stale schema does: apply-one renders BEFORE approved -> applying, so the row stays
  // approved and nothing is sent.
  const pages = await countPdfPages(normalised);
  // Exactly one: zero is a broken render, more is the rule broken. Both refuse.
  if (pages !== 1) throw new ResumeNotOnePageError(pages);

  // Hashed here, over the exact buffer that will be uploaded and attached, so
  // the digest cannot describe a different serialisation than the one sent.
  const sha256 = createHash('sha256').update(normalised).digest('hex');

  return { bytes: normalised, sha256 };
}

// The fixed stamp, and it MUST be exactly as long as what it replaces
// (`D:YYYYMMDDHHMMSS+HH'MM'`, 23 characters). Same length means every byte
// offset in the file — including the xref table, which stores absolute offsets
// and would send readers to the wrong objects if anything shifted — stays valid,
// so this is a substitution rather than a rewrite of the PDF.
//
// The Unix epoch rather than a plausible-looking date, deliberately: a fixed
// timestamp that reads like a real render time invites someone to trust it.
// This one is obviously a sentinel, and it is the conventional zero point for
// reproducible builds.
const FIXED_PDF_TIMESTAMP = "D:19700101000000+00'00'";

// The two keys Skia writes. Only these: no `/ID` appears in the output at all,
// which was checked rather than assumed — an unpatched document ID would have
// left the file non-deterministic while every date matched.
const TIMESTAMP_KEYS = ['/CreationDate (', '/ModDate ('] as const;

/**
 * Replace the PDF's creation and modification stamps with a fixed value.
 *
 * Byte-level and same-length by construction. Operating on the bytes rather than
 * re-serialising the document is what keeps this safe: nothing is parsed, so
 * there is no PDF writer here that could disagree with Chromium's about anything
 * else in the file.
 */
function withFixedPdfTimestamps(source: Uint8Array): Uint8Array {
  // A COPY, for two reasons. Chromium hands back a Node Buffer, and a Buffer is
  // frequently a view into a shared pool — mutating it in place could reach
  // memory another caller owns. And pdfjs (used by the ATS parse check) rejects
  // a Buffer outright with "Please provide binary data as `Uint8Array`, rather
  // than `Buffer`", because it tests the constructor rather than the prototype
  // chain. Copying into a plain Uint8Array fixes both at one stroke.
  const bytes = new Uint8Array(source);

  // Encoded once. The stamp is pure ASCII, so one byte per character, which is
  // what makes the fixed-width assumption above hold.
  const replacement = new TextEncoder().encode(FIXED_PDF_TIMESTAMP);

  for (const key of TIMESTAMP_KEYS) {
    // FIRST occurrence only. Both keys live in the document info dictionary
    // within the first ~250 bytes, ahead of every content stream, so stopping at
    // the first match means resume text that happened to contain this literal
    // could not be touched. (It could not corrupt the file either — the
    // substitution is same-length — but it could silently alter a bullet, which
    // is worse.)
    const at = indexOfAscii(bytes, key);
    // Absent is not an error: a future Chromium that stops writing a stamp needs
    // no patch, and throwing here would fail every application over metadata.
    if (at < 0) continue;

    // Overwrite in place, immediately after the key, for exactly the stamp's
    // length. Anything longer would run into the closing paren and produce a
    // malformed date that some readers reject.
    bytes.set(replacement, at + key.length);
  }

  return bytes;
}

/** Byte offset of an ASCII needle, or -1. */
function indexOfAscii(haystack: Uint8Array, needle: string): number {
  // Hand-rolled because `Uint8Array` has no indexOf-for-sequences, and decoding
  // 77KB to a string to use String.indexOf would allocate the whole document
  // again for every key on every application.
  const target = new TextEncoder().encode(needle);

  // Stop where a full match can still fit, so the inner loop never reads past
  // the end of the buffer.
  outer: for (let i = 0; i <= haystack.length - target.length; i += 1) {
    for (let j = 0; j < target.length; j += 1) {
      // Labelled continue rather than a found-flag: this runs once per key per
      // application and the intent reads directly.
      if (haystack[i + j] !== target[j]) continue outer;
    }
    return i;
  }

  return -1;
}

/** The rendered resume is not exactly one page, so it must not be sent (the one-page rule). */
export class ResumeNotOnePageError extends Error {
  // The real page count, carried so the log line and a test can say how far over it is.
  readonly pages: number;
  // Built from the count alone; the message is what an operator reads in the run log.
  constructor(pages: number) {
    // Plain words, and where to fix it: the approval card is where content is removed.
    super(`resume renders to ${pages} pages; the one-page rule refuses to send it. Remove content in the approval card, or re-tailor.`);
    // Named, so a catch can tell it from a render crash.
    this.name = 'ResumeNotOnePageError';
    // Kept for the caller.
    this.pages = pages;
  }
}

/**
 * Pages in a PDF, by pdf.js: a real parser, not a byte-pattern count.
 * Fails CLOSED: a count that is not a positive integer throws, because "unknown" must never
 * read as "one page" (CLAUDE.md section 6).
 */
export async function countPdfPages(pdfBytes: Uint8Array): Promise<number> {
  // Through a variable specifier and lazily, the same pattern ats-parse-check.ts uses: pdf.js
  // loads once per process, on the first render, not at import time.
  const specifier = 'pdfjs-dist/legacy/build/pdf.mjs';
  // Only the slice of the API this needs.
  const pdfjs = (await import(specifier)) as { getDocument(src: unknown): { promise: Promise<{ numPages: number; destroy(): Promise<void> }> } };
  // A copy: pdf.js transfers (detaches) the buffer it is given, and these bytes are still to be hashed and sent.
  const document = await pdfjs.getDocument({ data: new Uint8Array(pdfBytes), useSystemFonts: true }).promise;
  // Read, then release the parser's worker-side state.
  const pages = document.numPages;
  // Freed whether or not the count is usable.
  await document.destroy();
  // The shape check: a positive integer, or this is not a count.
  if (!Number.isInteger(pages) || pages < 1) throw new Error(`countPdfPages: pdf.js returned an unusable page count: ${String(pages)}`);
  // The count.
  return pages;
}
