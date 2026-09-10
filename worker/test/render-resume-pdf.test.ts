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
import { readFile } from 'node:fs/promises';
import { renderResumePdf } from '../src/render-resume-pdf.ts';
import { extractPdfText } from '../src/ats-parse-check.ts';

let browser: Browser;

beforeAll(async () => {
  browser = await chromium.launch();
}, 60_000);

afterAll(async () => {
  await browser?.close();
});

/**
 * The template package's own fixture, loaded through its public entry point
 * rather than deep-imported — the schema contract forbids reaching past a
 * package's single export, and a fixture is not part of that export. So the
 * resume is rebuilt here from the minimum the renderer requires.
 */
const resume = {
  fullName: 'Teja Mallam',
  headline: 'Backend Engineer',
  contact: {
    email: 'tejamallam00@gmail.com',
    phone: '+91 90000 00000',
    location: 'Hyderabad, India',
    links: [],
  },
  summary: null,
  skillGroups: [
    { label: 'Languages & Runtimes', skills: [{ ref: 's1', text: 'Node.js' }] },
  ],
  experience: [
    {
      ref: 'e1',
      role: 'Backend Developer, College Event Portal',
      organisation: 'MLR Institute of Technology',
      location: 'Hyderabad, India',
      startDate: 'Jan 2025',
      endDate: 'Apr 2025',
      bullets: [{ ref: 'b1', text: 'Designed and shipped a production REST API in Node.js/Express' }],
    },
  ],
  projects: [],
  education: [],
} as unknown as Parameters<typeof renderResumePdf>[0]['resume'];

test('renders a PDF whose text layer carries the resume content', async () => {
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
    expect(extracted.text).toContain('Teja Mallam');
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
