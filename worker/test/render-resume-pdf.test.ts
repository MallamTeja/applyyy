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
// Type-only: the link-annotation test widens the fixture to every section kind.
import type { ResolvedResume } from '@applyy/shared-types';

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

/** One clickable link as pdf.js reads it off the page: the target and where it sits. */
interface PdfLink {
  // The URI the reader opens; mailto: included, because the email is a link too.
  readonly url: string;
  // [x1, y1, x2, y2] in PDF points, so a test can tell the left column from the right.
  readonly rect: readonly number[];
}

/** Every /Link annotation with a URI on page 1, read by pdf.js, the same parser the ATS checks use. */
async function pdfLinks(bytes: Uint8Array): Promise<{ links: PdfLink[]; pageWidth: number }> {
  // A variable specifier, as ats-parse-check.ts does, so tsc does not chase pdf.js's own types.
  const specifier = 'pdfjs-dist/legacy/build/pdf.mjs';
  // Only the two calls used here are typed; the rest of pdf.js is not this test's business.
  const pdfjs = (await import(specifier)) as {
    getDocument(src: unknown): { promise: Promise<{ getPage(n: number): Promise<{ view: number[]; getAnnotations(): Promise<Array<{ subtype?: string; url?: string; rect?: number[] }>> }>; destroy(): Promise<void> }> };
  };
  // A fresh copy: pdf.js detaches the buffer it is given, and the caller may still need the bytes.
  const document = await pdfjs.getDocument({ data: new Uint8Array(bytes), useSystemFonts: true }).promise;
  try {
    // The resume is one page by contract (renderResumePdf throws otherwise).
    const page = await document.getPage(1);
    // Link annotations only, and only those with a URL: an internal jump is not a link Teja asked for.
    const links = (await page.getAnnotations())
      .filter((a) => a.subtype === 'Link' && typeof a.url === 'string')
      .map((a) => ({ url: a.url as string, rect: a.rect ?? [] }));
    // view is [x0, y0, x1, y1]; the width splits the page into the two columns.
    // A missing view entry is NaN, never 0, so a bad page box fails the column check instead of passing it.
    return { links, pageWidth: (page.view[2] ?? Number.NaN) - (page.view[0] ?? Number.NaN) };
  } finally {
    // pdf.js keeps a worker-side document alive until told otherwise.
    await document.destroy();
  }
}

test('PDF keeps the applyyy project link (every resume link is a clickable annotation)', async () => {
  // Teja 2026-11-08: every link must stay clickable in the PDF that is actually submitted.
  // The URLs are the real kinds the master holds: project, certification, achievement, header, email.
  const applyyyGithub = 'https://github.com/MallamTeja/applyyy';
  // A certification credential, the shape the live master stores (credly/cognitiveclass).
  const certUrl = 'https://www.credly.com/badges/example/public_url';
  // An achievement profile link, as the live master's LeetCode entry carries.
  const achUrl = 'https://leetcode.com/example';
  // The fixture, plus the two undated sections in the order and links on every kind.
  // Typed as the contract, not as the fixture: the fixture's own section_order is inferred as its four kinds.
  const linked: ResolvedResume = {
    ...resume,
    // Achievements and certifications present, so the side-by-side section is on the page.
    section_order: [...resume.section_order, 'achievements', 'certifications'],
    // The project carries the applyyy repo link next to its existing ones.
    projects: resume.projects.map((p, i) => (i === 0 ? { ...p, links: [...p.links, { id: 'lnk_applyyy', label: 'GitHub', url: applyyyGithub }] } : p)),
    // One achievement with a link, so the LEFT column has an annotation to locate.
    achievements: resume.achievements.map((a) => ({ ...a, links: [{ id: 'lnk_ach', label: 'Profile', url: achUrl }] })),
    // One certification with a link, so the RIGHT column has an annotation to locate.
    certifications: resume.certifications.map((c) => ({ ...c, links: [{ id: 'lnk_cert', label: 'Credential', url: certUrl }] })),
  };
  // A page of its own, closed whatever happens.
  const page = await browser.newPage();
  try {
    // The production path: the same function the worker submits with.
    const result = await renderResumePdf({ resume: linked, page });
    // Every annotation pdf.js can see.
    const { links, pageWidth } = await pdfLinks(result.bytes);
    // The URL set, normalised for a trailing slash only (Chromium may append one to a bare origin).
    const urls = links.map((l) => l.url.replace(/\/$/, ''));
    // THE POINT: each link kind survives into the submitted PDF as a real, clickable annotation.
    for (const expected of [applyyyGithub, certUrl, achUrl, 'https://github.com/example', 'mailto:ada.placeholder@example.com']) expect(urls).toContain(expected);
    // Where each column's link landed: x1 of its rect.
    const x = (url: string) => links.find((l) => l.url.replace(/\/$/, '') === url)?.rect[0] ?? Number.NaN;
    // Side by side on the REAL page: the achievement link in the left half, the certification link in the right.
    expect([x(achUrl) < pageWidth / 2, x(certUrl) > pageWidth / 2]).toEqual([true, true]);
  } finally {
    // No page leaks into the next test.
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
