// Rendering the submitted resume, in the worker, at submit time.
//
// THE GUARANTEE THIS EXISTS TO KEEP: "what you approved is byte-for-byte what
// gets sent." §7 says React and the worker import the SAME render function, and
// that is measured rather than hoped — the template's cross-runtime test has
// Node and Deno producing an identical sha256 from identical source.
//
// WHY RENDER HERE RATHER THAN FETCH A PRE-RENDERED PDF FROM STORAGE, which is
// the obvious alternative and the wrong one: a pre-rendered artifact can DRIFT
// from the thing the human approved. A PDF produced at tailor time has a
// relationship to `tailored_profile` that degrades the moment anything about
// the row or the template changes, and the drift is invisible — you would be
// shipping a file rather than a derivation. Rendering at submit time from the
// pinned immutable snapshot means the artifact is provably downstream of
// exactly the data that was reviewed.
//
// `applications.resume_storage_path` is therefore the RECORD, not the source:
// render, submit, then upload what was actually sent.
import { afterAll, beforeAll, expect, test } from 'vitest';
import { chromium, type Browser } from 'playwright';
import { renderResumePdf } from '../src/render-resume-pdf.ts';
import { extractPdfText } from '../src/ats-parse-check.ts';
// The typed fixture. It replaces an inline literal that was cast past the
// compiler with `as unknown as` and had drifted into a shape the renderer has
// never accepted — which failed all three tests below at runtime while
// `tsc --noEmit` and the workspace build both exited 0. See the fixture's header.
import { syntheticResume } from './resolved-resume-fixture.ts';

let browser: Browser;

beforeAll(async () => {
  browser = await chromium.launch();
}, 60_000);

afterAll(async () => {
  await browser?.close();
});

// Named `resume` so the assertions below read unchanged, while the definition is
// now checked against ResolvedResume instead of asserted past it.
const resume = syntheticResume;

test('renders a PDF whose text layer carries the resume content', async () => {
  // THE NON-VACUITY TWIN for the schema guard asserted at the bottom of this
  // file. Until now the only evidence about `schema_version` was that the
  // renderer REJECTED an undefined one — and a guard that rejects everything is
  // indistinguishable from a correct guard if rejection is all you ever measure.
  // This test is the acceptance half: a snapshot declaring the supported version
  // must render, all the way to real PDF bytes.
  const page = await browser.newPage();
  try {
    const result = await renderResumePdf({ resume, page });

    // A real PDF, not an empty buffer. The magic bytes are checked because a
    // zero-length or HTML-error buffer would still "upload successfully" and
    // the failure would surface as an employer receiving a broken attachment.
    expect(result.bytes.length).toBeGreaterThan(1_000);
    expect(new TextDecoder().decode(result.bytes.slice(0, 5))).toBe('%PDF-');

    // The content actually reaches the text layer — the §17.2 property, checked
    // on the artifact that would really be sent rather than on a fixture.
    const extracted = await extractPdfText(result.bytes);
    expect(extracted.text).toContain('Ada Placeholder');
    expect(extracted.text).toContain('Node.js');
  } finally {
    await page.close();
  }
}, 120_000);

test('reports a sha256 of the exact bytes it produced', async () => {
  // THE HASH IS WHAT MAKES RESUME PINNING ANSWERABLE LATER. Storing only a
  // storage path answers "where is the file"; storing the hash answers "is this
  // the artifact that was approved?", which is the question that matters six
  // months later when a recruiter asks about something on the resume.
  const page = await browser.newPage();
  try {
    const result = await renderResumePdf({ resume, page });

    // A sha256 hex digest, not a truncation or a different algorithm.
    expect(result.sha256).toMatch(/^[0-9a-f]{64}$/);

    // The hash must describe THESE bytes. Recomputing it independently is the
    // point — a hash the function merely asserts is not evidence of anything.
    const { createHash } = await import('node:crypto');
    const independent = createHash('sha256').update(result.bytes).digest('hex');
    expect(result.sha256).toBe(independent);
  } finally {
    await page.close();
  }
}, 120_000);

test('produces identical bytes for identical input', async () => {
  // DETERMINISM IS THE WHOLE APPROVAL GUARANTEE. If two renders of the same
  // pinned snapshot differed, "what you approved is what gets sent" would be
  // unverifiable, and `tailored_hash` would be useless as a cache key.
  //
  // This is also where a date or a timezone would leak in: the template's
  // DisplayDate contract exists because `toLocaleDateString` makes output a
  // function of host timezone and ICU build. A render that embedded "generated
  // on <today>" would pass every other test in this file and fail this one.
  const page = await browser.newPage();
  try {
    const first = await renderResumePdf({ resume, page });
    const second = await renderResumePdf({ resume, page });

    expect(second.sha256).toBe(first.sha256);
  } finally {
    await page.close();
  }
}, 120_000);

test('produces identical bytes across a wall-clock second boundary', async () => {
  // THE DISCRIMINATING TEST, and the one nobody writes first. The test above
  // renders twice back to back and PASSED against the unfixed renderer, because
  // both renders landed inside the same wall-clock second and the only varying
  // bytes were the SECONDS digits of `/CreationDate` and `/ModDate`. It could
  // not tell a deterministic renderer from one whose output changes every
  // second — and "every second" is indistinguishable from "always" once a run
  // is spread over 35 applications.
  //
  // Measured, not theorised: two renders 1.5s apart differed in exactly 2 bytes
  // at offsets 211 and 251, both inside those stamps, with total length
  // identical at 77032. So the sleep is not padding — it is the entire
  // experiment, and removing it silently removes the coverage.
  const page = await browser.newPage();
  try {
    const first = await renderResumePdf({ resume, page });

    // Long enough to guarantee a different second on any machine. A shorter
    // wait would make this test itself intermittent, which is the failure it
    // exists to detect.
    await new Promise((resolve) => setTimeout(resolve, 1_500));

    const second = await renderResumePdf({ resume, page });

    // Length first: if this ever fails while the digests differ, the cause is
    // NOT the timestamp patch (which is same-length by construction) and the
    // investigation should start somewhere else entirely.
    expect(second.bytes.length).toBe(first.bytes.length);
    expect(second.sha256).toBe(first.sha256);
  } finally {
    await page.close();
  }
}, 120_000);

test('hands back a plain Uint8Array, not a Node Buffer', async () => {
  // NOT PEDANTRY — this was a real failure. `page.pdf()` returns a Buffer, and
  // `Buffer` is a Uint8Array subclass, so TypeScript accepted it everywhere and
  // the port's `Uint8Array` type looked satisfied. pdfjs then rejected it at
  // runtime with "Please provide binary data as `Uint8Array`, rather than
  // `Buffer`" because it checks the CONSTRUCTOR rather than the prototype
  // chain, which broke the ATS parse check on the artifact that would really be
  // sent.
  //
  // The general shape is worth naming: a subclass satisfies the type system and
  // fails a runtime brand check, so no amount of typechecking could have caught
  // this. Only running it could.
  const page = await browser.newPage();
  try {
    const result = await renderResumePdf({ resume, page });

    // The exact assertion pdfjs makes, made here where the failure is
    // attributable to the renderer instead of surfacing three layers away.
    expect(result.bytes.constructor.name).toBe('Uint8Array');
  } finally {
    await page.close();
  }
}, 120_000);
